import { computeAssetId } from "./utils/hash.js";

const DEFAULT_MUTATION_RATE = 0.05;
const NUMERIC_PATTERN = /\b(\d+(?:\.\d+)?)\b/g;

/**
 * Parameter mutation engine.
 * Produces local variants of high-fitness Capsules by tweaking numeric parameters
 * and reordering strategy steps. No LLM calls — pure algorithmic mutation.
 */
export class Mutator {
  #mutationRate;
  #counter = 0;

  constructor({ mutationRate = DEFAULT_MUTATION_RATE } = {}) {
    this.#mutationRate = mutationRate;
  }

  /**
   * Whether a mutation attempt should be triggered this tick.
   */
  shouldMutate() {
    this.#counter++;
    return Math.random() < this.#mutationRate;
  }

  /**
   * Produce N variants of a Capsule by applying random mutations.
   * Returns new Capsule objects with recomputed asset_id.
   */
  mutate(capsule, count = 3) {
    const variants = [];
    for (let i = 0; i < count; i++) {
      const variant = this.#applyRandomMutation(capsule);
      if (variant) variants.push(variant);
    }
    return variants;
  }

  /**
   * Compare a variant against the original using test results.
   * Returns true if the variant is strictly better.
   */
  evaluateVariant(originalFitness, variantResults) {
    if (!variantResults || variantResults.length < 3) return false;
    const successRate = variantResults.filter((r) => r.success).length / variantResults.length;
    const avgTokens = variantResults.reduce((s, r) => s + (r.tokensUsed || 0), 0) / variantResults.length;
    const avgBaseline = variantResults.reduce((s, r) => s + (r.baselineTokens || 0), 0) / variantResults.length;

    const tokenSavings = avgBaseline > 0 ? Math.max(0, 1 - avgTokens / avgBaseline) : 0;
    const variantFitness = successRate * tokenSavings;

    return variantFitness > (originalFitness ?? 0);
  }

  /**
   * Run one mutation cycle on the darwin instance.
   * Called by Darwin's evolve loop when mutator is attached.
   */
  async cycle(darwin) {
    if (!this.shouldMutate()) return;

    const topGenes = darwin.store.ranked(10);
    if (topGenes.length === 0) return;

    // Pick a random high-fitness gene to mutate
    const target = topGenes[Math.floor(Math.random() * Math.min(3, topGenes.length))];
    const variants = this.mutate(target.capsule);

    for (const variant of variants) {
      darwin.store.add(variant, target.fitness * 0.9, "mutation");
    }
  }

  // ── Mutation strategies ───────────────────────────────────────────────

  #applyRandomMutation(capsule) {
    const strategies = [
      this.#mutateNumbers,
      this.#mutateStepOrder,
      this.#mutateDropStep,
    ];

    const strategy = strategies[Math.floor(Math.random() * strategies.length)];
    return strategy.call(this, capsule);
  }

  /**
   * Perturb numeric parameters in strategy steps.
   * E.g. "retry 3 times" → "retry 5 times" or "retry 2 times"
   */
  #mutateNumbers(capsule) {
    const strat = capsule.strategy;
    if (!strat || !Array.isArray(strat) || strat.length === 0) return null;

    const newStrat = strat.map((step) => {
      return step.replace(NUMERIC_PATTERN, (match) => {
        const num = parseFloat(match);
        if (num === 0) return match;
        const ops = [
          () => num + 1,
          () => num - 1,
          () => Math.round(num * 1.5),
          () => Math.round(num * 0.5),
          () => num * 2,
        ];
        const result = ops[Math.floor(Math.random() * ops.length)]();
        return String(Math.max(1, result));
      });
    });

    if (JSON.stringify(newStrat) === JSON.stringify(strat)) return null;

    const variant = { ...capsule, strategy: newStrat };
    delete variant.asset_id;
    variant.asset_id = computeAssetId(variant);
    variant._mutation = "numeric_perturbation";
    variant._parent = capsule.asset_id;
    return variant;
  }

  /**
   * Randomly swap two adjacent strategy steps.
   */
  #mutateStepOrder(capsule) {
    const strat = capsule.strategy;
    if (!strat || !Array.isArray(strat) || strat.length < 3) return null;

    const newStrat = [...strat];
    const i = 1 + Math.floor(Math.random() * (newStrat.length - 2));
    [newStrat[i], newStrat[i + 1]] = [newStrat[i + 1], newStrat[i]];

    const variant = { ...capsule, strategy: newStrat };
    delete variant.asset_id;
    variant.asset_id = computeAssetId(variant);
    variant._mutation = "step_reorder";
    variant._parent = capsule.asset_id;
    return variant;
  }

  /**
   * Drop a random non-first, non-last strategy step.
   */
  #mutateDropStep(capsule) {
    const strat = capsule.strategy;
    if (!strat || !Array.isArray(strat) || strat.length < 4) return null;

    const newStrat = [...strat];
    const i = 1 + Math.floor(Math.random() * (newStrat.length - 2));
    newStrat.splice(i, 1);

    const variant = { ...capsule, strategy: newStrat };
    delete variant.asset_id;
    variant.asset_id = computeAssetId(variant);
    variant._mutation = "step_drop";
    variant._parent = capsule.asset_id;
    return variant;
  }
}
