import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const WINDOW_SIZE = 20;
const MIN_SAMPLES = 3;
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Tracks real-world effectiveness of Capsules via sliding-window fitness scoring.
 * Each record captures success, token usage, and timing for one Capsule invocation.
 */
export class FitnessTracker {
  #logPath;
  #records; // capsuleId -> Record[]

  constructor({ dataDir = "./data" } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.#logPath = join(dataDir, "fitness-log.jsonl");
    this.#records = new Map();
    this.#load();
  }

  /**
   * Record a single Capsule usage outcome.
   */
  record(capsuleId, taskType, { success, tokensUsed, baselineTokens, durationMs, model, sponsorId } = {}) {
    const entry = {
      capsule_id: capsuleId,
      task_type: taskType,
      success: !!success,
      tokens_used: tokensUsed ?? 0,
      baseline_tokens: baselineTokens ?? 0,
      duration_ms: durationMs ?? 0,
      model: model ?? null,
      sponsor_id: sponsorId ?? null,
      timestamp: new Date().toISOString(),
    };

    if (!this.#records.has(capsuleId)) {
      this.#records.set(capsuleId, []);
    }
    const arr = this.#records.get(capsuleId);
    arr.push(entry);

    // Keep only the latest WINDOW_SIZE * 2 records in memory (prune old ones)
    if (arr.length > WINDOW_SIZE * 3) {
      arr.splice(0, arr.length - WINDOW_SIZE * 2);
    }

    this.#appendLog(entry);
    return entry;
  }

  /**
   * Compute the fitness score for a Capsule.
   * Returns null if fewer than MIN_SAMPLES records exist.
   *
   * fitness = weighted_success_rate * (1 - weighted_avg_tokens / weighted_avg_baseline)
   *
   * Weights decay exponentially with a 7-day half-life.
   */
  getFitness(capsuleId) {
    const arr = this.#records.get(capsuleId);
    if (!arr || arr.length < MIN_SAMPLES) return null;

    const now = Date.now();
    const window = arr.slice(-WINDOW_SIZE);

    let totalWeight = 0;
    let successWeight = 0;
    let tokensWeighted = 0;
    let baselineWeighted = 0;

    for (const r of window) {
      const age = now - new Date(r.timestamp).getTime();
      const weight = Math.pow(0.5, age / HALF_LIFE_MS);
      totalWeight += weight;
      if (r.success) successWeight += weight;
      tokensWeighted += r.tokens_used * weight;
      baselineWeighted += r.baseline_tokens * weight;
    }

    if (totalWeight === 0) return 0;

    const successRate = successWeight / totalWeight;
    const avgTokens = tokensWeighted / totalWeight;
    const avgBaseline = baselineWeighted / totalWeight;

    if (avgBaseline === 0) return successRate;

    const tokenSavings = Math.max(0, 1 - avgTokens / avgBaseline);
    return Math.round(successRate * tokenSavings * 1000) / 1000;
  }

  /**
   * Rank all Capsules for a given task type by fitness (descending).
   */
  rank(taskType) {
    const results = [];
    for (const [capsuleId, records] of this.#records) {
      const matching = records.filter(
        (r) => r.task_type.toLowerCase() === taskType.toLowerCase(),
      );
      if (matching.length < MIN_SAMPLES) continue;

      const fitness = this.getFitness(capsuleId);
      if (fitness === null) continue;

      results.push({
        capsuleId,
        fitness,
        samples: matching.length,
        successRate: matching.filter((r) => r.success).length / matching.length,
      });
    }
    return results.sort((a, b) => b.fitness - a.fitness);
  }

  /**
   * Rank all Capsules regardless of task type.
   */
  rankAll() {
    const results = [];
    for (const [capsuleId, records] of this.#records) {
      if (records.length < MIN_SAMPLES) continue;
      const fitness = this.getFitness(capsuleId);
      if (fitness === null) continue;

      const successCount = records.filter((r) => r.success).length;
      results.push({
        capsuleId,
        fitness,
        samples: records.length,
        successRate: successCount / records.length,
        taskTypes: [...new Set(records.map((r) => r.task_type))],
      });
    }
    return results.sort((a, b) => b.fitness - a.fitness);
  }

  /**
   * Rank models by aggregated fitness across all records.
   * Groups by model field and computes avg fitness, avg tokens, sample count.
   * Optionally filter by taskType.
   */
  rankByModel(taskType) {
    const byModel = new Map();

    for (const [, records] of this.#records) {
      for (const r of records) {
        if (!r.model) continue;
        if (taskType && r.task_type.toLowerCase() !== taskType.toLowerCase()) continue;

        if (!byModel.has(r.model)) {
          byModel.set(r.model, { successes: 0, total: 0, tokens: 0, baseline: 0 });
        }
        const m = byModel.get(r.model);
        m.total++;
        if (r.success) m.successes++;
        m.tokens += r.tokens_used;
        m.baseline += r.baseline_tokens;
      }
    }

    const results = [];
    for (const [model, m] of byModel) {
      if (m.total < MIN_SAMPLES) continue;
      const successRate = m.successes / m.total;
      const avgTokens = Math.round(m.tokens / m.total);
      const avgBaseline = m.baseline / m.total;
      const tokenSavings = avgBaseline > 0 ? Math.max(0, 1 - m.tokens / m.total / avgBaseline) : 0;
      const avgFitness = Math.round(successRate * tokenSavings * 1000) / 1000;

      results.push({
        model,
        avgFitness,
        successRate: Math.round(successRate * 1000) / 1000,
        avgTokens,
        samples: m.total,
      });
    }

    return results.sort((a, b) => b.avgFitness - a.avgFitness);
  }

  /**
   * Get the number of recorded samples for a Capsule.
   */
  getSampleCount(capsuleId) {
    const arr = this.#records.get(capsuleId);
    return arr ? arr.length : 0;
  }

  /**
   * Aggregate stats for the dashboard.
   */
  getStats() {
    let totalRecords = 0;
    let totalCapsules = 0;
    let totalTokensUsed = 0;
    let totalBaselineTokens = 0;
    const fitnessValues = [];

    for (const [capsuleId, records] of this.#records) {
      totalCapsules++;
      totalRecords += records.length;
      for (const r of records) {
        totalTokensUsed += r.tokens_used || 0;
        totalBaselineTokens += r.baseline_tokens || 0;
      }
      const f = this.getFitness(capsuleId);
      if (f !== null) fitnessValues.push(f);
    }

    return {
      totalRecords,
      trackedCapsules: totalCapsules,
      scoredCapsules: fitnessValues.length,
      avgFitness: fitnessValues.length
        ? Math.round((fitnessValues.reduce((a, b) => a + b, 0) / fitnessValues.length) * 1000) / 1000
        : 0,
      topFitness: fitnessValues.length ? Math.max(...fitnessValues) : 0,
      totalTokensUsed,
      totalBaselineTokens,
      tokenSavingsRate: totalBaselineTokens > 0
        ? Math.round((1 - totalTokensUsed / totalBaselineTokens) * 1000) / 1000
        : 0,
    };
  }

  /**
   * Get all records for a specific Capsule (for debugging / dashboard).
   */
  getRecords(capsuleId) {
    return this.#records.get(capsuleId) || [];
  }

  // ── Private ───────────────────────────────────────────────────────────

  #appendLog(entry) {
    appendFileSync(this.#logPath, JSON.stringify(entry) + "\n");
  }

  #load() {
    if (!existsSync(this.#logPath)) return;
    try {
      const lines = readFileSync(this.#logPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const id = entry.capsule_id;
          if (!this.#records.has(id)) this.#records.set(id, []);
          this.#records.get(id).push(entry);
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // file read error, start fresh
    }
  }
}
