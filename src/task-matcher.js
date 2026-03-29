import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildBundle } from "./bundle-builder.js";

const DEFAULT_MIN_MATCH_SCORE = 0.3;
const DEFAULT_MAX_CONCURRENT = 3;
const COMPLETED_HISTORY_MAX = 50;

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
    this.#load();
  }

  get enabled() { return this.#enabled; }
  get autoSubmit() { return this.#autoSubmit; }
  set autoSubmit(v) { this.#autoSubmit = !!v; }

  // ── Task Matching ──────────────────────────────────────────────────────

  /**
   * Match a single task against the gene store.
   * A task's `signals` is a comma-separated string; each signal is tested
   * against capsule triggers via geneStore.findByTaskType().
   */
  matchTask(task, geneStore) {
    const signalsRaw = task.signals || "";
    const signals = signalsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (signals.length === 0) return null;

    let bestGene = null;
    let bestFitness = -1;
    const matchedSignals = [];

    for (const signal of signals) {
      const genes = geneStore.findByTaskType(signal);
      if (genes.length > 0) {
        matchedSignals.push(signal);
        if (genes[0].fitness > bestFitness) {
          bestFitness = genes[0].fitness;
          bestGene = genes[0];
        }
      }
    }

    if (matchedSignals.length === 0) return null;

    const matchScore = (matchedSignals.length / signals.length) * Math.max(0.1, bestFitness);
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
   */
  scan(tasks, geneStore) {
    const results = [];
    for (const task of tasks) {
      const match = this.matchTask(task, geneStore);
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

    // 1. Claim
    const claimRes = await this.#hub.claimWork(taskId);
    const assignmentId =
      claimRes.assignment_id ||
      claimRes.id ||
      claimRes.assignment?.id;

    const storeEntry = darwin.store?.has(assetId)
      ? darwin.store.ranked(darwin.store.capacity).find((g) => g.assetId === assetId)
      : null;

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
      capsuleSource: storeEntry?.source || "hub",
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

    let validated = true;
    try {
      const vRes = await darwin.hub.validate(bundle);
      validated = vRes?.payload?.valid !== false && vRes?.valid !== false;
    } catch {
      validated = false;
    }
    entry.validateOk = validated;

    darwin._emit?.("task-validated", {
      taskId,
      assetId: bundleCapsuleId,
      valid: validated,
    });

    let published = false;
    if (validated) {
      try {
        await darwin.hub.publish(bundle);
        published = true;
      } catch { /* already published or transient error */ }
    }
    entry.publishOk = published;

    if (published) {
      darwin._emit?.("task-published", { taskId, bundleSize: bundle.length });
    }
    this.#save();

    // 3. Complete — use the original assetId the Hub knows about
    let completeRes;
    try {
      completeRes = await this.#hub.completeWork(assignmentId, assetId);
    } catch (err) {
      // Move to failed history so it doesn't stay stuck in activeTasks
      this.#moveToHistory(assignmentId, {
        status: "failed",
        failedAt: new Date().toISOString(),
        error: err.message,
        bounty: task.bounty_amount,
      });
      this.#counters.failed++;
      this.#save();
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
      assetId,
      title: task.title,
      contribution,
      rewardStatus,
    });

    const taskType = match.matchedSignals?.[0] || task.signals?.split(",")[0]?.trim() || "hub-task";
    darwin.recordUsage?.(assetId, taskType, {
      success: true,
      tokensUsed: 0,
      baselineTokens: task.bounty_amount || 0,
    });

    return { taskId, assignmentId, assetId, claimRes, completeRes };
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

  // ── Cycle (called by Darwin evolve loop) ───────────────────────────────

  async cycle(darwin) {
    const hb = darwin.lastHeartbeat;
    const tasks = hb?.raw?.available_tasks || [];
    if (tasks.length === 0) return;

    // Scan
    const candidates = this.scan(tasks, darwin.store);
    this.#lastScanResults = candidates;
    this.#counters.scanned += tasks.length;
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
    const toClaim = candidates.slice(0, Math.max(0, slotsAvailable));

    for (const match of toClaim) {
      try {
        await this.claimAndComplete(match, darwin);
      } catch (err) {
        darwin._emit?.("task-failed", {
          taskId: match.task.task_id,
          error: err.message,
        });
        const failedAssetId = match.bestGene?.capsule?.asset_id;
        const failedTaskType = match.matchedSignals?.[0] || "hub-task";
        if (failedAssetId) {
          darwin.recordUsage?.(failedAssetId, failedTaskType, {
            success: false,
            tokensUsed: 0,
            baselineTokens: 0,
          });
        }
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
