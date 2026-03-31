import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HubClient } from "./hub-client.js";
import { GeneStore } from "./gene-store.js";
import { FitnessTracker } from "./fitness-tracker.js";
import { CapsuleSelector } from "./capsule-selector.js";
import { BootstrapEvaluator } from "./bootstrap-evaluator.js";
import { getAllMetaGenes } from "./meta-genes.js";

export { HubClient } from "./hub-client.js";
export { GeneStore } from "./gene-store.js";
export { FitnessTracker } from "./fitness-tracker.js";
export { CapsuleSelector } from "./capsule-selector.js";
export { BootstrapEvaluator } from "./bootstrap-evaluator.js";
export { Sponsor } from "./sponsor.js";
export { Leaderboard } from "./leaderboard.js";
export { TaskMatcher } from "./task-matcher.js";
export { Subscription } from "./subscription.js";
export { TrustPolicy } from "./trust-policy.js";
export { PeerGraph } from "./peer-graph.js";

const DEFAULT_HEARTBEAT_MS = 300_000; // 5 min (EvoMap official recommendation)
const DEFAULT_EVOLVE_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_INGEST_PER_CYCLE = 10;
const CAPACITY_CAUTIOUS_RATIO = 0.9;

/**
 * Darwin — the evolution engine.
 * Orchestrates hub-client, gene-store, fitness-tracker, capsule-selector,
 * and (later) mutator + peer-exchange into a single lifecycle.
 */
export class Darwin {
  #hub;
  #store;
  #tracker;
  #selector;
  #mutator;
  #peerExchange;
  #subscription;
  #sponsor;
  #taskMatcher;
  #dataDir;
  #credentialsPath;

  #agentCallback;

  #heartbeatTimer;
  #evolveTimer;
  #running = false;
  #eventHandlers = new Map();
  #lastHeartbeatResult = null;
  #nextHeartbeatMs;

  constructor({
    hubUrl,
    dataDir = "./data",
    geneCapacity = 200,
    explorationRate = 0.1,
    nodeId,
    nodeSecret,
  } = {}) {
    this.#dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.#credentialsPath = join(dataDir, "credentials.json");

    const creds = this.#loadCredentials();
    this.#hub = new HubClient({
      hubUrl,
      nodeId: nodeId || creds.nodeId,
      nodeSecret: nodeSecret || creds.nodeSecret,
    });

    this.#store = new GeneStore({ dataDir, capacity: geneCapacity });
    this.#tracker = new FitnessTracker({ dataDir });
    this.#selector = new CapsuleSelector({
      fitnessTracker: this.#tracker,
      geneStore: this.#store,
      explorationRate,
    });

    this.#mutator = null;
    this.#peerExchange = null;
    this.#subscription = null;
    this.#sponsor = null;
    this.#taskMatcher = null;

    this.#seedMetaGenes();
  }

  get hub() { return this.#hub; }
  get store() { return this.#store; }
  get tracker() { return this.#tracker; }
  get selector() { return this.#selector; }
  get running() { return this.#running; }
  get peers() { return this.#peerExchange; }
  get subscription() { return this.#subscription; }
  get sponsor() { return this.#sponsor; }
  get worker() { return this.#taskMatcher; }
  get lastHeartbeat() { return this.#lastHeartbeatResult; }

  /**
   * Allow external callers (e.g. plugin heartbeat service) to cache a
   * heartbeat result so that getStatus() can expose it.
   */
  setLastHeartbeat(res) {
    this.#lastHeartbeatResult = res;
  }

  /**
   * Attach optional modules (mutator, peer-exchange, sponsor) after construction.
   */
  use(module) {
    const name = module.constructor?.name;
    if (name === "Mutator") {
      this.#mutator = module;
    } else if (name === "Subscription") {
      this.#subscription = module;
    } else if (name === "PeerExchange") {
      this.#peerExchange = module;
    } else if (name === "Sponsor") {
      this.#sponsor = module;
    } else if (name === "TaskMatcher") {
      this.#taskMatcher = module;
    }
    return this;
  }

  // ── Event system ──────────────────────────────────────────────────────

  on(event, handler) {
    if (!this.#eventHandlers.has(event)) this.#eventHandlers.set(event, []);
    this.#eventHandlers.get(event).push(handler);
    return this;
  }

  #emit(event, data) {
    const handlers = this.#eventHandlers.get(event) || [];
    for (const h of handlers) {
      try { h(data); } catch { /* swallow handler errors */ }
    }
  }

  /** Public emit bridge for use() modules (TaskMatcher, etc.) */
  _emit(event, data) { this.#emit(event, data); }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Register with Hub (or reconnect with saved credentials).
   */
  async init() {
    const result = await this.#hub.hello();
    this.#saveCredentials(result.nodeId, result.nodeSecret);
    this.#emit("init", result);
    return result;
  }

  /**
   * Start the evolution loop: heartbeat + periodic evolve cycle.
   */
  async start({ heartbeatMs, evolveMs } = {}) {
    if (this.#running) return;
    this.#running = true;

    this.#nextHeartbeatMs = heartbeatMs || DEFAULT_HEARTBEAT_MS;
    const evInterval = evolveMs || DEFAULT_EVOLVE_MS;

    // Bootstrap: seed structural fitness scores when gene pool has no real data
    this.#runBootstrap();

    // Initial heartbeat
    await this.#doHeartbeat();
    this.#scheduleNextHeartbeat();

    this.#evolveTimer = setInterval(() => this.#doEvolveCycle(), evInterval);

    // Run first evolve cycle immediately
    await this.#doEvolveCycle();

    this.#emit("start", { heartbeatMs: this.#nextHeartbeatMs, evolveMs: evInterval });
  }

  stop() {
    this.#running = false;
    if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer);
    if (this.#evolveTimer) clearInterval(this.#evolveTimer);
    this.#heartbeatTimer = null;
    this.#evolveTimer = null;
    this.#emit("stop", {});
  }

  // ── Core operations (can be called individually) ──────────────────────

  /**
   * Fetch capsules from Hub and ingest into local gene store.
   * Uses a two-phase strategy: search_only first (free), then targeted fetch.
   */
  async fetchAndIngest(signals) {
    const cautious = this.#store.size >= this.#store.capacity * CAPACITY_CAUTIOUS_RATIO;

    // Phase 1: free metadata scan
    const preview = await this.#hub.fetch({ signals, searchOnly: true });
    const candidates = preview?.payload?.assets || preview?.assets || [];

    // Phase 2: filter to Capsules we don't already have, capped per cycle
    const needed = [];
    for (const asset of candidates) {
      if (needed.length >= MAX_INGEST_PER_CYCLE) break;
      if (asset.type === "Capsule" && asset.asset_id && !this.#store.has(asset.asset_id)) {
        needed.push(asset.asset_id);
      }
    }

    // In cautious mode (>= 90% full), skip the costly fetch entirely
    // — GeneStore.add() would reject most fitness=0 entries anyway.
    if (cautious && needed.length > 0 && this.#store.lowestFitness > 0) {
      const skipped = candidates.length - needed.length;
      this.#emit("fetch", { total: candidates.length, ingested: 0, skipped, rejected: needed.length });
      return { total: candidates.length, ingested: 0, skipped, rejected: needed.length };
    }

    let ingested = 0;
    let rejected = 0;
    if (needed.length > 0) {
      const full = await this.#hub.fetch({ assetIds: needed });
      const assets = full?.payload?.assets || full?.assets || [];

      for (const asset of assets) {
        if (asset.type === "Capsule" && asset.asset_id) {
          const existingFitness = this.#tracker.getFitness(asset.asset_id);
          const added = this.#store.add(asset, existingFitness ?? 0, "hub");
          if (added) ingested++;
          else rejected++;
        }
      }
    }

    const skipped = candidates.length - needed.length;
    this.#emit("fetch", { total: candidates.length, ingested, skipped, rejected });
    return { total: candidates.length, ingested, skipped, rejected };
  }

  /**
   * Select the best capsule for a given task type.
   */
  selectCapsule(taskType, hubCapsules = []) {
    const result = this.#selector.select(taskType, hubCapsules);
    if (result) this.#emit("select", { taskType, ...result });
    return result;
  }

  /**
   * Record a capsule usage result and update gene store fitness.
   */
  recordUsage(capsuleId, taskType, result) {
    const entry = this.#tracker.record(capsuleId, taskType, result);
    const fitness = this.#tracker.getFitness(capsuleId);
    if (fitness !== null) {
      this.#store.updateFitness(capsuleId, fitness);
    }
    this.#emit("record", { capsuleId, taskType, fitness, ...result });

    // Submit validation report to Hub when enough data has accumulated
    const samples = this.#tracker.getSampleCount(capsuleId);
    if (samples >= 5 && fitness !== null && this.#tracker.canReport(capsuleId)) {
      const records = this.#tracker.getRecords(capsuleId);
      const successCount = records.filter((r) => r.success).length;
      this.#hub.report(capsuleId, {
        fitness,
        samples,
        success_rate: Math.round((successCount / records.length) * 1000) / 1000,
        token_savings: entry.baseline_tokens > 0
          ? Math.round((1 - entry.tokens_used / entry.baseline_tokens) * 1000) / 1000
          : 0,
      }).then(() => {
        this.#tracker.markReported(capsuleId);
        this.#emit("report", { capsuleId, fitness, samples });
      }).catch(() => {});
    }

    return { entry, fitness };
  }

  /**
   * Register an agent callback for agent-driven evolution.
   * When set, #doEvolveCycle will invoke this instead of hardcoded Mutator logic.
   */
  setAgentCallback(fn) {
    this.#agentCallback = typeof fn === "function" ? fn : null;
  }

  /**
   * Get comprehensive status for CLI / dashboard.
   */
  getStatus() {
    const hb = this.#lastHeartbeatResult;
    const fitnessStats = this.#tracker.getStats();
    return {
      running: this.#running,
      nodeId: this.#hub.nodeId,
      hubUrl: this.#hub.hubUrl,
      geneStore: this.#store.getStats(),
      fitness: fitnessStats,
      tokenBaseline: fitnessStats.totalBaselineTokens,
      tokenDarwin: fitnessStats.totalTokensUsed,
      hasMutator: !!this.#mutator,
      hasSubscription: !!this.#subscription,
      hasPeerExchange: !!this.#peerExchange,
      peerCount: this.#peerExchange?.peerCount ?? 0,
      subscription: this.#subscription?.getStats() ?? null,
      hasSponsor: !!this.#sponsor,
      sponsor: this.#sponsor?.getStats() ?? null,
      worker: this.#taskMatcher?.getStats() ?? null,
      leaderboard: this.#tracker.rankByModel?.() ?? [],
      heartbeat: hb ? {
        timestamp: hb.timestamp || new Date().toISOString(),
        status: hb.status,
        survivalStatus: hb.survivalStatus,
        creditBalance: hb.creditBalance,
        availableWork: hb.availableWork,
        nextHeartbeatMs: hb.nextHeartbeatMs,
        pendingEvents: hb.pendingEvents,
        raw: hb.raw,
      } : null,
    };
  }

  /**
   * Compute Revolution readiness — how self-sufficient is this node
   * if the centralized Hub were to fail or become adversarial.
   */
  getRevolutionStatus() {
    const breakdown = this.#store.getSourceBreakdown();
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

    // Validation autonomy: what fraction of genes have local fitness data
    const allGenes = this.#store.ranked(this.#store.capacity);
    const scored = allGenes.filter(
      (g) => this.#tracker.getSampleCount(g.assetId) >= 3,
    ).length;
    const validationScore = total > 0 ? Math.min(1, scored / Math.max(total * 0.5, 1)) : 0;

    // Judgment autonomy: ratio of non-hub genes (mutation + peer + subscription)
    const nonHub = total - breakdown.hub;
    const judgmentScore = total > 0 ? Math.min(1, nonHub / Math.max(total * 0.3, 1)) : 0;

    // Network autonomy: peer connectivity
    const peerCount = this.#peerExchange?.peerCount ?? 0;
    const subCount = this.#subscription?.subscriptionCount ?? 0;
    const subscriberCount = this.#subscription?.subscriberCount ?? 0;
    const networkConnections = peerCount + subCount + subscriberCount;
    const networkScore = Math.min(1, networkConnections / 5);

    // Innovation autonomy: mutation output rate
    const mutationCount = breakdown.mutation;
    const innovationScore = total > 0 ? Math.min(1, mutationCount / Math.max(total * 0.15, 1)) : 0;

    const readiness = (validationScore + judgmentScore + networkScore + innovationScore) / 4;
    const hubDependency = total > 0 ? breakdown.hub / total : 1;

    const hb = this.#lastHeartbeatResult;
    const hubHealth = {
      creditBalance: hb?.creditBalance ?? null,
      lastHeartbeatAge: hb?.timestamp
        ? Date.now() - new Date(hb.timestamp).getTime()
        : null,
    };

    return {
      readiness: Math.round(readiness * 1000) / 1000,
      dimensions: {
        validation: { score: Math.round(validationScore * 1000) / 1000, detail: `${scored}/${total} genes locally tested` },
        judgment: { score: Math.round(judgmentScore * 1000) / 1000, detail: `${nonHub}/${total} non-hub genes` },
        network: { score: Math.round(networkScore * 1000) / 1000, detail: `${networkConnections} connections (${peerCount}P/${subCount}S/${subscriberCount}R)` },
        innovation: { score: Math.round(innovationScore * 1000) / 1000, detail: `${mutationCount} mutations of ${total} total` },
      },
      geneSourceBreakdown: breakdown,
      hubDependency: Math.round(hubDependency * 1000) / 1000,
      hubHealth,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────

  #seedMetaGenes() {
    try {
      const metaGenes = getAllMetaGenes();
      const canonicalIds = new Set(
        metaGenes.map(({ bundle }) => bundle[1]?.asset_id).filter(Boolean),
      );

      // Evict stale meta entries whose asset_id no longer matches current code
      // (happens when Gene fields change → hash changes → new asset_id).
      const existing = this.#store.ranked(this.#store.capacity);
      for (const entry of existing) {
        if (entry.source === "meta" && !canonicalIds.has(entry.assetId)) {
          this.#store.remove(entry.assetId);
        }
      }

      for (const { bundle } of metaGenes) {
        const capsule = bundle[1];
        if (!capsule?.asset_id) continue;
        if (this.#store.has(capsule.asset_id)) {
          this.#store.add(capsule, null, "meta");
        } else {
          this.#store.add(capsule, 0, "meta");
        }
      }
    } catch {
      // Best-effort — never block startup
    }
  }

  #runBootstrap() {
    try {
      const hasRealData = this.#tracker.rankAll().length > 0;
      if (hasRealData) return;

      const evaluator = new BootstrapEvaluator({ dataDir: this.#dataDir });
      if (evaluator.alreadyDone) return;

      if (this.#store.size === 0) return;

      const result = evaluator.evaluate(this.#store);
      if (result) {
        this.#emit("bootstrap", result);
      }
    } catch {
      // Bootstrap is best-effort — never block startup
    }
  }

  async #doHeartbeat() {
    try {
      const res = await this.#hub.heartbeat();
      this.#lastHeartbeatResult = res;
      if (res.nextHeartbeatMs && res.nextHeartbeatMs > 0) {
        this.#nextHeartbeatMs = res.nextHeartbeatMs;
      }
      this.#processPendingEvents(res.pendingEvents);
      this.#emit("heartbeat", res);
      return res;
    } catch (err) {
      this.#emit("error", { phase: "heartbeat", error: err.message });
    }
  }

  #processPendingEvents(events) {
    if (!events || events.length === 0) return;
    for (const event of events) {
      const type = event.type || event.event_type;
      if ((type === "task_assigned" || type === "high_value_task") &&
          this.#taskMatcher && this.#taskMatcher.autoSubmit) {
        const task = event.task || event;
        const match = this.#taskMatcher.matchTask(task, this.#store);
        if (match) {
          this.#taskMatcher.claimAndComplete(match, this).catch((err) => {
            this.#emit("error", { phase: "pending-event-task", error: err.message });
          });
        }
      }
      this.#emit("pending-event", event);
    }
  }

  #scheduleNextHeartbeat() {
    if (!this.#running) return;
    this.#heartbeatTimer = setTimeout(async () => {
      await this.#doHeartbeat();
      this.#scheduleNextHeartbeat();
    }, this.#nextHeartbeatMs);
  }

  #getActiveSignals() {
    const signals = new Set();
    for (const r of this.#tracker.rankAll()) {
      if (r.taskTypes) r.taskTypes.forEach((t) => signals.add(t));
    }
    for (const entry of this.#store.ranked(50)) {
      const triggers = entry.capsule?.trigger || entry.capsule?.signals_match || [];
      for (const t of triggers) signals.add(t);
    }
    return [...signals];
  }

  async #doEvolveCycle() {
    try {
      // 0. Check credit balance — skip fetch when credits are low
      const credits = this.#lastHeartbeatResult?.creditBalance;
      const lowCredit = typeof credits === "number" && credits < 10;
      if (lowCredit) {
        this.#emit("low-credit", { creditBalance: credits });
      }

      // 1. Fetch new capsules (signal-directed when possible; skip when low on credits)
      if (!lowCredit) {
        const signals = this.#getActiveSignals();
        await this.fetchAndIngest(signals.length > 0 ? signals : undefined);
      }

      // 2. Agent-driven evolution (preferred) or fallback to Mutator
      if (this.#agentCallback) {
        try {
          await this.#agentCallback(this);
          this.#emit("evolve-think", { timestamp: new Date().toISOString() });
        } catch {
          // Agent unavailable — fall through to hardcoded fallback below
        }
      }

      if (!this.#agentCallback && this.#mutator && typeof this.#mutator.cycle === "function") {
        let grant = null;
        if (this.#sponsor) {
          grant = this.#sponsor.getAvailableGrant("mutation");
        }
        await this.#mutator.cycle(this);
        if (grant) {
          const estimatedTokens = 500;
          this.#sponsor.consumeTokens(grant.grantId, estimatedTokens, {
            phase: "mutation",
            cycleTimestamp: new Date().toISOString(),
          });
          this.#emit("grant-consumed", { grantId: grant.grantId, amount: estimatedTokens, phase: "mutation" });
        }
      }

      // 3. Subscription system (preferred) or legacy peer exchange
      if (this.#subscription && typeof this.#subscription.cycle === "function") {
        await this.#subscription.cycle(this);
      } else if (this.#peerExchange && typeof this.#peerExchange.cycle === "function") {
        await this.#peerExchange.cycle(this);
      }

      // 4. Task matching (if attached)
      if (this.#taskMatcher && typeof this.#taskMatcher.cycle === "function") {
        await this.#taskMatcher.cycle(this);
      }

      this.#emit("evolve", { timestamp: new Date().toISOString() });
    } catch (err) {
      this.#emit("error", { phase: "evolve", error: err.message });
    }
  }

  #loadCredentials() {
    if (!existsSync(this.#credentialsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.#credentialsPath, "utf-8"));
    } catch {
      return {};
    }
  }

  #saveCredentials(nodeId, nodeSecret) {
    writeFileSync(
      this.#credentialsPath,
      JSON.stringify({ nodeId, nodeSecret }, null, 2),
    );
  }
}
