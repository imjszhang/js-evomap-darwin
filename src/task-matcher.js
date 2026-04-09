import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildBundle } from "./bundle-builder.js";

const DEFAULT_MIN_MATCH_SCORE = 0.3;
const DEFAULT_MAX_CONCURRENT = 3;
const COMPLETED_HISTORY_MAX = 50;
const DEFAULT_STALE_CLAIM_MS = 48 * 3600 * 1000;
const DEFAULT_MAX_TASK_FAILURES = 2;
/** After an agent-generate failure, wait this long before retrying the same task (default 1h). */
const DEFAULT_AGENT_GENERATE_COOLDOWN_MS = 60 * 60 * 1000;
/** After this many consecutive failures for one task, apply a long ban (default 24h). */
const DEFAULT_AGENT_GENERATE_MAX_ATTEMPTS = 3;
const DEFAULT_AGENT_GENERATE_BAN_MS = 24 * 60 * 60 * 1000;
/** Titles longer than this skip automatic agent Capsule generation (noise / error-dump tasks). */
const DEFAULT_AGENT_GENERATE_TITLE_MAX_LEN = 500;
const HUB_ABSENT_GRACE_MS = 3600 * 1000;
const HUB_TERMINAL_STATUSES = new Set([
  "completed", "complete", "done", "failed", "fail", "cancelled", "canceled",
  "expired", "rejected", "revoked",
]);

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Skip auto agent-generate for Hub tasks whose title looks like an error dump or is unwieldy.
 * Exported for tests.
 */
export function shouldSkipAgentGenerateTitle(title) {
  if (title == null || typeof title !== "string") return false;
  const t = title.toLowerCase();
  if (t.includes("llm error]") || t.includes("llm error")) return true;
  const maxLen = envPositiveInt("DARWIN_AGENT_GENERATE_TITLE_MAX_LEN", DEFAULT_AGENT_GENERATE_TITLE_MAX_LEN);
  if (title.length > maxLen) return true;
  return false;
}

/**
 * Matches available Hub tasks against the local gene pool and optionally
 * claims + completes them automatically. Follows the Darwin.use() module
 * pattern (constructor, cycle, getStats).
 */
export class TaskMatcher {
  #hub;
  #dataDir;
  #autoSubmit;
  #minMatchScore;
  #maxConcurrent;
  #statePath;
  #agentGenerateStatePath;
  /** @type {{ tasks: Record<string, { failures: number, nextEligibleAt: number }> }} */
  #agentGenerateState = { tasks: {} };

  #generateCallback = null;

  #registered = false;
  #enabled = false;
  #domains = [];
  #activeTasks = [];
  #completedHistory = [];
  #lastScanResults = [];
  #counters = { scanned: 0, matched: 0, claimed: 0, completed: 0, failed: 0 };

  constructor({ hub, dataDir = "./data", autoSubmit = false, minMatchScore, maxConcurrent } = {}) {
    this.#hub = hub;
    this.#dataDir = dataDir;
    this.#autoSubmit = autoSubmit;
    this.#minMatchScore = minMatchScore ?? DEFAULT_MIN_MATCH_SCORE;
    this.#maxConcurrent = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

    mkdirSync(dataDir, { recursive: true });
    this.#statePath = join(dataDir, "worker-state.json");
    this.#agentGenerateStatePath = join(dataDir, "agent-generate-state.json");
    this.#load();
    this.#loadAgentGenerateState();
  }

  get enabled() { return this.#enabled; }
  get autoSubmit() { return this.#autoSubmit; }
  set autoSubmit(v) { this.#autoSubmit = !!v; }

  setGenerateCallback(fn) {
    this.#generateCallback = typeof fn === "function" ? fn : null;
  }

  #isTaskCoolingDown(taskId) {
    let failures = 0;
    for (const t of this.#completedHistory) {
      if (t.taskId === taskId && t.status === "failed") failures++;
    }
    return failures >= DEFAULT_MAX_TASK_FAILURES;
  }

  #agentGenerateCooldownMs() {
    return envMs("DARWIN_AGENT_GENERATE_COOLDOWN_MS", DEFAULT_AGENT_GENERATE_COOLDOWN_MS);
  }

  #agentGenerateMaxAttempts() {
    return envPositiveInt("DARWIN_AGENT_GENERATE_MAX_ATTEMPTS", DEFAULT_AGENT_GENERATE_MAX_ATTEMPTS);
  }

  #agentGenerateBanMs() {
    return envMs("DARWIN_AGENT_GENERATE_BAN_MS", DEFAULT_AGENT_GENERATE_BAN_MS);
  }

  /** @returns {boolean} */
  #isAgentGenerateBlocked(taskId) {
    const e = this.#agentGenerateState.tasks[taskId];
    if (!e) return false;
    const now = Date.now();
    if (now < e.nextEligibleAt) return true;
    if (e.failures >= this.#agentGenerateMaxAttempts()) {
      delete this.#agentGenerateState.tasks[taskId];
      this.#saveAgentGenerateState();
    }
    return false;
  }

  #recordAgentGenerateFailure(taskId) {
    const now = Date.now();
    const cooldown = this.#agentGenerateCooldownMs();
    const max = this.#agentGenerateMaxAttempts();
    const ban = this.#agentGenerateBanMs();
    let e = this.#agentGenerateState.tasks[taskId];
    if (!e) e = { failures: 0, nextEligibleAt: 0 };
    e.failures = (e.failures || 0) + 1;
    if (e.failures >= max) {
      e.nextEligibleAt = now + ban;
    } else {
      e.nextEligibleAt = now + cooldown;
    }
    this.#agentGenerateState.tasks[taskId] = e;
    this.#saveAgentGenerateState();
  }

  #clearAgentGenerateState(taskId) {
    if (this.#agentGenerateState.tasks[taskId]) {
      delete this.#agentGenerateState.tasks[taskId];
      this.#saveAgentGenerateState();
    }
  }

  async #preValidate(bundle, darwin) {
    try {
      const vRes = await darwin.hub.validate(bundle);
      return vRes?.payload?.valid !== false && vRes?.valid !== false;
    } catch {
      return false;
    }
  }

  // ── Task Matching ──────────────────────────────────────────────────────

  /**
   * Match a single task against the gene store.
   * A task's `signals` is a comma-separated string; each signal is tested
   * against capsule triggers via geneStore.findByTaskType().
   * @param {object} task
   * @param {import('./gene-store.js').GeneStore} geneStore
   * @param {{ excludeSources?: string[] }} [options]
   */
  matchTask(task, geneStore, { excludeSources } = {}) {
    const signalsRaw = task.signals || "";
    const signals = signalsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (signals.length === 0) return null;

    let bestGene = null;
    let bestRawFitness = -1;
    let bestMatchQuality = 0;
    const matchedSignals = [];

    for (const signal of signals) {
      const genes = geneStore.findByTaskType(signal, { excludeSources });
      if (genes.length > 0) {
        matchedSignals.push(signal);
        const topGene = genes[0];
        const quality = topGene.matchQuality ?? 1.0;
        const rawFitness = topGene.fitness ?? 0;
        if (rawFitness > bestRawFitness || (rawFitness === bestRawFitness && quality > bestMatchQuality)) {
          bestRawFitness = rawFitness;
          bestMatchQuality = quality;
          bestGene = topGene;
        }
      }
    }

    if (matchedSignals.length === 0) return null;

    const matchScore = (matchedSignals.length / signals.length) * Math.max(0.1, bestRawFitness) * (bestMatchQuality || 1.0);
    return {
      task,
      bestGene,
      matchScore: Math.round(matchScore * 1000) / 1000,
      matchedSignals,
      totalSignals: signals.length,
    };
  }

  /**
   * Batch-scan tasks, returning candidates sorted by match score (descending).
   * @param {object[]} tasks
   * @param {import('./gene-store.js').GeneStore} geneStore
   * @param {{ excludeSources?: string[] }} [options]
   */
  scan(tasks, geneStore, { excludeSources } = {}) {
    const results = [];
    for (const task of tasks) {
      const match = this.matchTask(task, geneStore, { excludeSources });
      if (match && match.matchScore >= this.#minMatchScore) {
        results.push(match);
      }
    }
    return results.sort((a, b) => b.matchScore - a.matchScore);
  }

  // ── Worker Registration ────────────────────────────────────────────────

  async register({ enabled = true, domains, maxLoad } = {}) {
    const res = await this.#hub.registerWorker({ enabled, domains, maxLoad });
    this.#registered = true;
    this.#enabled = enabled;
    if (domains) this.#domains = domains;
    this.#save();
    return res;
  }

  async disable() {
    const res = await this.#hub.registerWorker({ enabled: false });
    this.#enabled = false;
    this.#save();
    return res;
  }

  // ── Claim + Complete Flow ──────────────────────────────────────────────

  /**
   * Claim a task and submit the best matching gene as the solution.
   * Returns the result object or throws on failure.
   */
  async claimAndComplete(match, darwin) {
    const { task, bestGene } = match;
    const taskId = task.task_id;
    const capsule = bestGene.capsule;
    const assetId = capsule.asset_id;

    const storeEntry = darwin.store?.has(assetId)
      ? darwin.store.ranked(darwin.store.capacity).find((g) => g.assetId === assetId)
      : null;
    const capsuleSource = storeEntry?.source || "hub";

    // 0. Pre-validate for non-hub capsules (avoid wasting claim slots)
    if (capsuleSource !== "hub") {
      const preBundle = buildBundle(capsule);
      const preValid = await this.#preValidate(preBundle, darwin);
      if (!preValid) {
        darwin._emit?.("error", {
          phase: "task-pre-validate", taskId,
          error: `pre-validate failed for ${capsuleSource} capsule, skipping claim`,
        });
        throw new Error(`Pre-validate failed for ${capsuleSource} capsule`);
      }
    }

    // 1. Claim
    const claimRes = await this.#hub.claimWork(taskId);
    const assignmentId =
      claimRes.assignment_id ||
      claimRes.id ||
      claimRes.assignment?.id;

    const entry = {
      taskId,
      assignmentId,
      assetId,
      title: task.title,
      claimedAt: new Date().toISOString(),
      status: "claimed",
      matchScore: match.matchScore,
      matchedSignals: match.matchedSignals,
      capsuleSummary: capsule.summary || null,
      capsuleSource,
      validateOk: null,
      publishOk: null,
      hubContribution: null,
      hubRewardStatus: null,
    };
    this.#activeTasks.push(entry);
    this.#counters.claimed++;
    this.#save();

    darwin._emit?.("task-claimed", {
      taskId,
      title: task.title,
      matchScore: match.matchScore,
      matchedSignals: match.matchedSignals,
    });

    // 2. Build compliant bundle (Gene + Capsule + EvolutionEvent) and publish
    const bundle = buildBundle(capsule);
    const bundleCapsuleId = bundle[1].asset_id;
    const hubKnowsOriginal = capsuleSource === "hub";

    let validated = true;
    try {
      const vRes = await darwin.hub.validate(bundle);
      validated = vRes?.payload?.valid !== false && vRes?.valid !== false;
    } catch (err) {
      validated = false;
      darwin._emit?.("error", { phase: "task-validate", taskId, error: err.message });
    }
    entry.validateOk = validated;

    darwin._emit?.("task-validated", {
      taskId,
      assetId: bundleCapsuleId,
      valid: validated,
    });

    let published = false;
    let publishConflict = false;
    if (validated) {
      try {
        await darwin.hub.publish(bundle);
        published = true;
      } catch (err) {
        if (err.statusCode === 409) {
          publishConflict = true;
          published = true;
        }
        darwin._emit?.("error", {
          phase: "task-publish", taskId, statusCode: err.statusCode,
          error: err.message, conflict: publishConflict,
        });
      }
    }
    entry.publishOk = published;

    if (published) {
      darwin._emit?.("task-published", { taskId, bundleSize: bundle.length, conflict: publishConflict });
    }
    this.#save();

    // 3. Determine which asset_id to submit for completion
    let completeAssetId;
    if (published) {
      completeAssetId = bundleCapsuleId;
    } else if (hubKnowsOriginal) {
      completeAssetId = assetId;
    } else {
      // Neither publish succeeded nor does the Hub know the original Capsule — give up
      this.#moveToHistory(assignmentId, {
        status: "failed",
        failedAt: new Date().toISOString(),
        error: "publish failed and original capsule not on Hub",
        bounty: task.bounty_amount,
      });
      this.#counters.failed++;
      this.#save();
      darwin._emit?.("error", {
        phase: "task-no-viable-asset", taskId,
        error: `publish failed (source=${capsuleSource}), no Hub-known asset to submit`,
      });
      throw new Error("No publishable asset available for task completion");
    }

    let completeRes;
    try {
      completeRes = await this.#hub.completeWork(assignmentId, completeAssetId);
    } catch (err) {
      this.#moveToHistory(assignmentId, {
        status: "failed",
        failedAt: new Date().toISOString(),
        error: err.message,
        bounty: task.bounty_amount,
      });
      this.#counters.failed++;
      this.#save();

      darwin._emit?.("error", {
        phase: "task-complete", taskId, assignmentId, completeAssetId,
        error: err.message, statusCode: err.statusCode,
      });

      const failTaskType = match.matchedSignals?.[0] || task.signals?.split(",")[0]?.trim() || "hub-task";
      darwin.recordUsage?.(completeAssetId, failTaskType, {
        success: false,
        tokensUsed: 0,
        baselineTokens: 0,
        rewardStatus: "failed",
      });

      throw err;
    }

    // 4. Move from active to completed history
    const contribution = completeRes?.assignment?.contribution ?? completeRes?.contribution ?? null;
    const rewardStatus = completeRes?.assignment?.rewardStatus ?? completeRes?.rewardStatus ?? null;
    this.#moveToHistory(assignmentId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      bounty: task.bounty_amount,
      hubContribution: contribution,
      hubRewardStatus: rewardStatus,
    });
    this.#counters.completed++;
    this.#save();

    darwin._emit?.("task-completed", {
      taskId,
      assetId: completeAssetId,
      title: task.title,
      contribution,
      rewardStatus,
    });

    darwin.creditLedger?.recordEarning({
      taskId,
      bounty: task.bounty_amount || 0,
      contribution,
      rewardStatus,
    });

    const taskType = match.matchedSignals?.[0] || task.signals?.split(",")[0]?.trim() || "hub-task";
    const isRewarded = rewardStatus !== "rejected" && rewardStatus !== "failed";
    const contribFraction = typeof contribution === "number" ? Math.max(0, Math.min(1, contribution)) : 0.5;
    darwin.recordUsage?.(completeAssetId, taskType, {
      success: isRewarded,
      tokensUsed: 0,
      baselineTokens: 0,
      contribution: contribFraction,
      bounty: task.bounty_amount || 0,
      rewardStatus: rewardStatus || null,
    });

    return { taskId, assignmentId, assetId: completeAssetId, claimRes, completeRes };
  }

  #moveToHistory(assignmentId, fields) {
    const idx = this.#activeTasks.findIndex((t) => t.assignmentId === assignmentId);
    if (idx === -1) return;
    const entry = this.#activeTasks.splice(idx, 1)[0];
    Object.assign(entry, fields);
    this.#completedHistory.push(entry);
    if (this.#completedHistory.length > COMPLETED_HISTORY_MAX) {
      this.#completedHistory.splice(0, this.#completedHistory.length - COMPLETED_HISTORY_MAX);
    }
  }

  /**
   * Sync local active claims with Hub /a2a/work/my and drop stale rows so
   * maxConcurrent slots are not blocked forever (e.g. crash mid-flow).
   * Controlled by DARWIN_STALE_CLAIM_MS (default 48h).
   */
  async #reconcileActiveWithHub(darwin) {
    if (!this.#hub?.nodeId) return;
    const snapshot = [...this.#activeTasks];
    if (snapshot.length === 0) return;

    let items = [];
    try {
      const res = await this.#hub.getMyWork();
      items = res?.assignments ?? res?.payload?.assignments ?? (Array.isArray(res) ? res : []);
    } catch {
      return;
    }

    const byAssignment = new Map();
    for (const w of items) {
      const aid = w.assignment_id || w.id || w.assignment?.id;
      if (aid) byAssignment.set(aid, w);
    }

    const staleMs = Number(process.env.DARWIN_STALE_CLAIM_MS);
    const maxStaleMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : DEFAULT_STALE_CLAIM_MS;
    const now = Date.now();

    for (const t of snapshot) {
      if (!this.#activeTasks.some((a) => a.assignmentId === t.assignmentId)) continue;
      if (t.status !== "claimed") continue;

      const ageMs = now - new Date(t.claimedAt).getTime();
      const hub = byAssignment.get(t.assignmentId);
      const hubStatus = String(hub?.status ?? "").toLowerCase();

      if (hub && HUB_TERMINAL_STATUSES.has(hubStatus)) {
        const done = hubStatus === "completed" || hubStatus === "complete" || hubStatus === "done";
        this.#moveToHistory(t.assignmentId, {
          status: done ? "completed" : "failed",
          reconciledAt: new Date().toISOString(),
          error: `hub-reconciled:${hubStatus || "unknown"}`,
          bounty: hub?.bounty ?? hub?.bounty_amount ?? t.bounty ?? null,
        });
        if (done) this.#counters.completed++;
        else this.#counters.failed++;
        this.#save();
        darwin._emit?.("task-reconciled", {
          assignmentId: t.assignmentId,
          taskId: t.taskId,
          hubStatus,
          outcome: done ? "completed" : "failed",
        });
        continue;
      }

      if (!hub && ageMs > HUB_ABSENT_GRACE_MS) {
        this.#moveToHistory(t.assignmentId, {
          status: "abandoned",
          abandonedAt: new Date().toISOString(),
          error: "assignment missing from Hub getMyWork (expired or released)",
        });
        this.#counters.failed++;
        this.#save();
        darwin._emit?.("task-abandoned", {
          assignmentId: t.assignmentId,
          taskId: t.taskId,
          reason: "not-on-hub",
        });
        continue;
      }

      if (hub && ageMs > maxStaleMs) {
        this.#moveToHistory(t.assignmentId, {
          status: "abandoned",
          abandonedAt: new Date().toISOString(),
          error: `stale claim (${Math.round(ageMs / 3600000)}h) — local slot freed; verify Hub assignment if needed`,
        });
        this.#counters.failed++;
        this.#save();
        darwin._emit?.("task-abandoned", {
          assignmentId: t.assignmentId,
          taskId: t.taskId,
          reason: "stale-timeout",
          hubStatus: hubStatus || "active",
        });
      }
    }
  }

  // ── Cycle (called by Darwin heartbeat loop) ─────────────────────────────

  async cycle(darwin) {
    await this.#reconcileActiveWithHub(darwin);

    const buffered = darwin.getBufferedTasks?.() ?? [];
    const hb = darwin.lastHeartbeat;
    const fallbackRaw =
      hb?.availableWork ||
      hb?.raw?.available_tasks ||
      hb?.raw?.available_work ||
      [];
    const normalizeHubTask = (t) => {
      if (!t || typeof t !== "object") return t;
      const task_id = t.task_id || t.id;
      return task_id ? { ...t, task_id } : t;
    };
    const tasks =
      buffered.length > 0
        ? buffered
        : fallbackRaw.map(normalizeHubTask).filter((t) => t && t.task_id);
    if (tasks.length === 0) return;

    // Scan — exclude template-sourced genes so agent-generate can take over
    const scanOpts = { excludeSources: ["template"] };
    let candidates = this.scan(tasks, darwin.store, scanOpts);
    this.#counters.scanned += tasks.length;

    // Agent-generate capsules when no viable (non-template) match exists
    if (candidates.length === 0 && this.#autoSubmit && this.#enabled && this.#generateCallback) {
      const touched = new Set([
        ...this.#activeTasks.map((t) => t.taskId),
        ...this.#completedHistory.map((t) => t.taskId),
      ]);
      const untouched = tasks.filter((t) => !touched.has(t.task_id));
      const eligible = untouched.filter((t) => {
        if (this.#isTaskCoolingDown(t.task_id)) return false;
        if (this.#isAgentGenerateBlocked(t.task_id)) return false;
        if (shouldSkipAgentGenerateTitle(t.title)) return false;
        return true;
      });
      for (const target of eligible.slice(0, 1)) {
        try {
          darwin._emit?.("agent-generate-start", { taskId: target.task_id, title: target.title });
          const capsule = await this.#generateCallback(target, {
            store: darwin.store,
            hub: darwin.hub,
          });
          if (!capsule) {
            this.#recordAgentGenerateFailure(target.task_id);
            darwin._emit?.("agent-generate-failed", { taskId: target.task_id, reason: "null-capsule" });
            continue;
          }
          const bundle = buildBundle(capsule);
          const valid = await this.#preValidate(bundle, darwin);
          if (valid) {
            this.#clearAgentGenerateState(target.task_id);
            darwin.store.add(capsule, 0.5, "agent");
            darwin._emit?.("agent-capsule", { taskId: target.task_id, assetId: capsule.asset_id });
          } else {
            this.#recordAgentGenerateFailure(target.task_id);
            darwin._emit?.("agent-capsule-rejected", { taskId: target.task_id, reason: "pre-validate failed" });
          }
        } catch (err) {
          this.#recordAgentGenerateFailure(target.task_id);
          darwin._emit?.("error", { phase: "agent-generate", taskId: target.task_id, error: err.message });
        }
      }
      candidates = this.scan(tasks, darwin.store, scanOpts);
    }

    this.#lastScanResults = candidates;
    this.#counters.matched += candidates.length;

    if (candidates.length > 0) {
      darwin._emit?.("task-matched", {
        count: candidates.length,
        top: candidates[0],
      });
    }

    // Auto-submit if enabled
    if (!this.#autoSubmit || !this.#enabled) return;

    const slotsAvailable = this.#maxConcurrent - this.#activeTasks.length;
    const toClaim = candidates
      .filter((c) => !this.#isTaskCoolingDown(c.task.task_id))
      .slice(0, Math.max(0, slotsAvailable));

    for (const match of toClaim) {
      try {
        await this.claimAndComplete(match, darwin);
      } catch (err) {
        darwin._emit?.("task-failed", {
          taskId: match.task.task_id,
          error: err.message,
        });
        // recordUsage(success:false) is already called inside claimAndComplete's
        // catch block, so we don't duplicate it here.
      }
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  getStats() {
    return {
      registered: this.#registered,
      workerEnabled: this.#enabled,
      autoSubmit: this.#autoSubmit,
      domains: this.#domains,
      activeTasks: this.#activeTasks,
      completedHistory: this.#completedHistory.slice(-10),
      lastScanResults: this.#lastScanResults.map((r) => ({
        taskId: r.task.task_id,
        title: r.task.title,
        matchScore: r.matchScore,
        matchedSignals: r.matchedSignals,
        bestGeneId: r.bestGene?.assetId,
        bestGeneSummary: r.bestGene?.capsule?.summary,
      })),
      counters: { ...this.#counters },
    };
  }

  getLastScanResults() {
    return this.#lastScanResults;
  }

  /** Re-read worker-state.json (useful when external tools modify the file). */
  reload() { this.#load(); }

  /** Hub sync + stale-claim cleanup (also runs automatically at each cycle()). */
  async reconcileAssignments(darwin) {
    await this.#reconcileActiveWithHub(darwin);
    this.#save();
  }

  // ── Persistence ────────────────────────────────────────────────────────

  #load() {
    if (!existsSync(this.#statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#statePath, "utf-8"));
      this.#registered = raw.registered ?? false;
      this.#enabled = raw.enabled ?? false;
      this.#domains = raw.domains ?? [];
      this.#activeTasks = raw.activeTasks ?? [];
      this.#completedHistory = raw.completedHistory ?? [];
      this.#counters = { ...this.#counters, ...(raw.counters ?? {}) };
    } catch { /* start fresh */ }
  }

  #loadAgentGenerateState() {
    if (!existsSync(this.#agentGenerateStatePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#agentGenerateStatePath, "utf-8"));
      const tasks = raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {};
      const cleaned = {};
      const now = Date.now();
      for (const [taskId, row] of Object.entries(tasks)) {
        if (!row || typeof row.nextEligibleAt !== "number") continue;
        if (row.failures >= this.#agentGenerateMaxAttempts() && now >= row.nextEligibleAt) continue;
        cleaned[taskId] = {
          failures: Number(row.failures) || 0,
          nextEligibleAt: row.nextEligibleAt,
        };
      }
      this.#agentGenerateState = { tasks: cleaned };
    } catch {
      this.#agentGenerateState = { tasks: {} };
    }
  }

  #saveAgentGenerateState() {
    writeFileSync(this.#agentGenerateStatePath, JSON.stringify({
      version: 1,
      tasks: this.#agentGenerateState.tasks,
    }, null, 2));
  }

  #save() {
    writeFileSync(this.#statePath, JSON.stringify({
      registered: this.#registered,
      enabled: this.#enabled,
      domains: this.#domains,
      activeTasks: this.#activeTasks,
      completedHistory: this.#completedHistory,
      counters: this.#counters,
    }, null, 2));
  }
}
