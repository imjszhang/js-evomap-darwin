import { computeAssetId } from "./utils/hash.js";

const FALLBACK_CONFIDENCE = 0.72;
const FALLBACK_BLAST_RADIUS = { files: 1, lines: 20 };
const STABLE_ENV = { platform: "any", arch: "any" };

/**
 * Creates template Capsules for tasks that have no matching gene in the pool.
 * These are generic "good-practice" solutions — better than nothing when the
 * alternative is skipping a bounty task entirely.
 */
export class CapsuleFactory {
  /**
   * Build a Capsule tailored to a Hub task's signals and title.
   * @param {{ title: string, signals: string, bounty_amount?: number }} task
   * @returns {object} A valid Capsule object with computed asset_id
   */
  static createForTask(task) {
    const signals = (task.signals || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const title = (task.title || "").slice(0, 150);

    const capsule = {
      type: "Capsule",
      schema_version: "1.5.0",
      trigger: signals.length > 0 ? signals : ["general"],
      summary: `Solution for: ${title || "Hub task"}`,
      content: CapsuleFactory.#buildContent(task),
      strategy: CapsuleFactory.#buildStrategy(task),
      confidence: FALLBACK_CONFIDENCE,
      blast_radius: FALLBACK_BLAST_RADIUS,
      outcome: { status: "success", score: FALLBACK_CONFIDENCE },
      env_fingerprint: STABLE_ENV,
    };
    capsule.asset_id = computeAssetId(capsule);
    return capsule;
  }

  static #buildContent(task) {
    const title = task.title || "the given task";
    const domain = task.signals || "general";
    return [
      `Intent: Systematic solution for "${title}".`,
      "",
      `Domain: ${domain}`,
      "",
      "Approach:",
      "1. Analyze the core challenge by breaking it into concrete sub-problems.",
      "2. For each sub-problem, define acceptance criteria and measurable metrics.",
      "3. Design a solution that addresses root causes rather than symptoms.",
      "4. Implement defensive checks and validation at each critical step.",
      "5. Test against adversarial / edge-case inputs to verify robustness.",
      "6. Compare results against a no-intervention baseline via A/B measurement.",
      "7. Document findings: what worked, what failed, and quantified improvement.",
      "",
      "Expected outcome: A reproducible, validated strategy with measured effectiveness.",
    ].join("\n");
  }

  static #buildStrategy(task) {
    return [
      "Break the challenge into well-defined, independently testable sub-problems",
      "Define measurable acceptance criteria for each sub-problem",
      "Design solution addressing root causes with defensive validation",
      "Test against adversarial and edge-case inputs for robustness",
      "A/B compare against baseline; document quantified improvements",
    ];
  }
}
