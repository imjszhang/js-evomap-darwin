import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HubClient } from "./hub-client.js";
import { GeneStore } from "./gene-store.js";
import { FitnessTracker } from "./fitness-tracker.js";
import { CapsuleSelector } from "./capsule-selector.js";

export { HubClient } from "./hub-client.js";
export { GeneStore } from "./gene-store.js";
export { FitnessTracker } from "./fitness-tracker.js";
export { CapsuleSelector } from "./capsule-selector.js";
export { Sponsor } from "./sponsor.js";
export { Leaderboard } from "./leaderboard.js";

const DEFAULT_HEARTBEAT_MS = 900_000; // 15 min
const DEFAULT_EVOLVE_MS = 4 * 60 * 60 * 1000; // 4 hours

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
  #sponsor;
  #dataDir;
  #credentialsPath;

  #heartbeatTimer;
  #evolveTimer;
  #running = false;
  #eventHandlers = new Map();

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
    this.#sponsor = null;
  }

  get hub() { return this.#hub; }
  get store() { return this.#store; }
  get tracker() { return this.#tracker; }
  get selector() { return this.#selector; }
  get running() { return this.#running; }
  get peers() { return this.#peerExchange; }
  get sponsor() { return this.#sponsor; }

  /**
   * Attach optional modules (mutator, peer-exchange, sponsor) after construction.
   */
  use(module) {
    const name = module.constructor?.name;
    if (name === "Mutator") {
      this.#mutator = module;
    } else if (name === "PeerExchange") {
      this.#peerExchange = module;
    } else if (name === "Sponsor") {
      this.#sponsor = module;
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

    const hbInterval = heartbeatMs || DEFAULT_HEARTBEAT_MS;
    const evInterval = evolveMs || DEFAULT_EVOLVE_MS;

    // Initial heartbeat
    await this.#doHeartbeat();

    this.#heartbeatTimer = setInterval(() => this.#doHeartbeat(), hbInterval);
    this.#evolveTimer = setInterval(() => this.#doEvolveCycle(), evInterval);

    // Run first evolve cycle immediately
    await this.#doEvolveCycle();

    this.#emit("start", { heartbeatMs: hbInterval, evolveMs: evInterval });
  }

  stop() {
    this.#running = false;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
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
    // Phase 1: free metadata scan
    const preview = await this.#hub.fetch({ signals, searchOnly: true });
    const candidates = preview?.payload?.assets || preview?.assets || [];

    // Phase 2: filter to Capsules we don't already have
    const needed = [];
    for (const asset of candidates) {
      if (asset.type === "Capsule" && asset.asset_id && !this.#store.has(asset.asset_id)) {
        needed.push(asset.asset_id);
      }
    }

    let ingested = 0;
    if (needed.length > 0) {
      const full = await this.#hub.fetch({ assetIds: needed });
      const assets = full?.payload?.assets || full?.assets || [];

      for (const asset of assets) {
        if (asset.type === "Capsule" && asset.asset_id) {
          const existingFitness = this.#tracker.getFitness(asset.asset_id);
          this.#store.add(asset, existingFitness ?? 0);
          ingested++;
        }
      }
    }

    this.#emit("fetch", { total: candidates.length, ingested, skipped: candidates.length - needed.length });
    return { total: candidates.length, ingested, skipped: candidates.length - needed.length };
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
    return { entry, fitness };
  }

  /**
   * Get comprehensive status for CLI / dashboard.
   */
  getStatus() {
    return {
      running: this.#running,
      nodeId: this.#hub.nodeId,
      hubUrl: this.#hub.hubUrl,
      geneStore: this.#store.getStats(),
      fitness: this.#tracker.getStats(),
      hasMutator: !!this.#mutator,
      hasPeerExchange: !!this.#peerExchange,
      peerCount: this.#peerExchange?.peerCount ?? 0,
      hasSponsor: !!this.#sponsor,
      sponsor: this.#sponsor?.getStats() ?? null,
      leaderboard: this.#tracker.rankByModel?.() ?? [],
    };
  }

  // ── Private ───────────────────────────────────────────────────────────

  async #doHeartbeat() {
    try {
      const res = await this.#hub.heartbeat();
      this.#emit("heartbeat", res);
      return res;
    } catch (err) {
      this.#emit("error", { phase: "heartbeat", error: err.message });
    }
  }

  async #doEvolveCycle() {
    try {
      // 1. Fetch new capsules
      await this.fetchAndIngest();

      // 2. Mutator cycle (if attached) — use sponsor grant when available
      if (this.#mutator && typeof this.#mutator.cycle === "function") {
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

      // 3. Peer exchange (if attached)
      if (this.#peerExchange && typeof this.#peerExchange.cycle === "function") {
        await this.#peerExchange.cycle(this);
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
