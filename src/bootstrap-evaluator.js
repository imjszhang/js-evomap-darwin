import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Lightweight structural evaluator for cold-start gene pools.
 *
 * When a Darwin node starts with capsules in the gene store but zero fitness
 * records, all genes are equally at fitness 0. This means the Mutator picks
 * randomly, CapsuleSelector has no preference, and capacity eviction is
 * arbitrary. BootstrapEvaluator breaks this "all-zero" deadlock by assigning
 * small structural quality scores (0.01–0.15) based on capsule metadata — no
 * token consumption, no network calls.
 *
 * Runs at most once per data directory (writes a marker file on completion).
 */
export class BootstrapEvaluator {
  #dataDir;
  #markerPath;

  constructor({ dataDir = "./data" } = {}) {
    this.#dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.#markerPath = join(dataDir, "bootstrap-done.json");
  }

  get alreadyDone() {
    return existsSync(this.#markerPath);
  }

  /**
   * Evaluate all capsules in the gene store and assign structural fitness
   * scores. Returns { evaluated, avgScore } or null if already done / empty.
   */
  evaluate(store) {
    if (this.alreadyDone) return null;

    const all = store.ranked(store.capacity || 200);
    if (all.length === 0) return null;

    const triggerCounts = new Map();
    for (const entry of all) {
      const triggers = entry.capsule?.trigger || entry.capsule?.signals_match || [];
      for (const t of triggers) {
        triggerCounts.set(t, (triggerCounts.get(t) || 0) + 1);
      }
    }

    let evaluated = 0;
    let totalScore = 0;

    for (const entry of all) {
      const cap = entry.capsule;
      if (!cap) continue;

      const score = this.scoreCapsule(cap, triggerCounts, all.length);
      if (score > 0) {
        store.updateFitness(cap.asset_id, score);
        evaluated++;
        totalScore += score;
      }
    }

    const avgScore = evaluated > 0 ? Math.round((totalScore / evaluated) * 1000) / 1000 : 0;

    this.#markDone(evaluated, avgScore);
    return { evaluated, avgScore };
  }

  /**
   * Score a single capsule's structural quality (0–0.15).
   * Can be called externally for re-evaluation of subscription genes.
   */
  scoreCapsule(capsule, triggerCounts = new Map(), totalGenes = 1) {
    let score = 0;

    // Completeness (0–0.05): has content + strategy steps >= 3
    const hasContent = typeof capsule.content === "string" && capsule.content.length > 0;
    const strategySteps = Array.isArray(capsule.strategy) ? capsule.strategy.length : 0;

    if (hasContent) score += 0.02;
    if (strategySteps >= 3) score += 0.03;
    else if (strategySteps >= 1) score += 0.01;

    // Specificity (0–0.05): measurable targets in strategy steps
    if (strategySteps > 0) {
      const measurable = capsule.strategy.filter(
        (s) => typeof s === "string" && /\d+/.test(s),
      ).length;
      const ratio = measurable / strategySteps;
      score += Math.min(0.05, ratio * 0.05);
    }

    // Trigger coverage (0–0.03): more trigger signals = broader applicability
    const triggers = capsule.trigger || capsule.signals_match || [];
    if (triggers.length >= 4) score += 0.03;
    else if (triggers.length >= 2) score += 0.02;
    else if (triggers.length >= 1) score += 0.01;

    // Novelty (0–0.02): low overlap with common triggers means niche value
    if (triggers.length > 0 && totalGenes > 1) {
      const avgFreq = triggers.reduce((sum, t) => sum + (triggerCounts.get(t) || 0), 0) / triggers.length;
      const overlapRatio = avgFreq / totalGenes;
      if (overlapRatio < 0.3) score += 0.02;
      else if (overlapRatio < 0.6) score += 0.01;
    }

    return Math.round(score * 1000) / 1000;
  }

  #markDone(evaluated, avgScore) {
    writeFileSync(this.#markerPath, JSON.stringify({
      evaluated,
      avgScore,
      timestamp: new Date().toISOString(),
    }, null, 2));
  }
}
