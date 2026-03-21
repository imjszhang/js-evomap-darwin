const DEFAULT_EXPLORATION_RATE = 0.1;

/**
 * Selects Capsules based on local fitness data instead of Hub ranking.
 * Balances exploitation (use best known) with exploration (try unknowns).
 */
export class CapsuleSelector {
  #fitnessTracker;
  #geneStore;
  #explorationRate;

  constructor({ fitnessTracker, geneStore, explorationRate = DEFAULT_EXPLORATION_RATE } = {}) {
    this.#fitnessTracker = fitnessTracker;
    this.#geneStore = geneStore;
    this.#explorationRate = explorationRate;
  }

  /**
   * Select the best Capsule for a task.
   *
   * @param {string} taskType - The signal/trigger to match
   * @param {Array} hubCapsules - Capsules returned by Hub fetch (may be empty)
   * @returns {{ capsule, reason: 'exploit'|'explore'|'hub_default', source: 'local'|'hub' }}
   */
  select(taskType, hubCapsules = []) {
    const merged = this.#mergeCandidates(taskType, hubCapsules);

    if (merged.length === 0) return null;

    // Exploration: with probability explorationRate, pick an under-tested capsule
    if (Math.random() < this.#explorationRate) {
      const unexplored = merged.filter((c) => c.samples < 3);
      if (unexplored.length > 0) {
        const pick = unexplored[Math.floor(Math.random() * unexplored.length)];
        return { capsule: pick.capsule, reason: "explore", source: pick.source };
      }
    }

    // Exploitation: pick by fitness if we have scored capsules
    const scored = merged.filter((c) => c.fitness !== null);
    if (scored.length > 0) {
      scored.sort((a, b) => b.fitness - a.fitness);
      return { capsule: scored[0].capsule, reason: "exploit", source: scored[0].source };
    }

    // Fallback: return the first Hub capsule (Hub's own ranking)
    if (hubCapsules.length > 0) {
      return { capsule: hubCapsules[0], reason: "hub_default", source: "hub" };
    }

    return { capsule: merged[0].capsule, reason: "hub_default", source: merged[0].source };
  }

  /**
   * Rank all candidates for a task type with full metadata.
   */
  rankCandidates(taskType, hubCapsules = []) {
    return this.#mergeCandidates(taskType, hubCapsules)
      .sort((a, b) => (b.fitness ?? -1) - (a.fitness ?? -1));
  }

  // ── Private ───────────────────────────────────────────────────────────

  #mergeCandidates(taskType, hubCapsules) {
    const seen = new Set();
    const results = [];

    // Local gene store first
    if (this.#geneStore) {
      for (const entry of this.#geneStore.findByTaskType(taskType)) {
        const id = entry.assetId;
        if (seen.has(id)) continue;
        seen.add(id);

        const fitness = this.#fitnessTracker?.getFitness(id) ?? null;
        const samples = this.#fitnessTracker?.getSampleCount(id) ?? 0;
        results.push({
          capsule: entry.capsule,
          fitness,
          samples,
          source: "local",
        });
      }
    }

    // Then Hub capsules
    for (const cap of hubCapsules) {
      const id = cap.asset_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const fitness = this.#fitnessTracker?.getFitness(id) ?? null;
      const samples = this.#fitnessTracker?.getSampleCount(id) ?? 0;
      results.push({
        capsule: cap,
        fitness,
        samples,
        source: "hub",
      });
    }

    return results;
  }
}
