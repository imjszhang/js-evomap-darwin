import { computeAssetId } from "./utils/hash.js";
import { getEnvFingerprint } from "./utils/env-fingerprint.js";

/**
 * Pre-defined "meta-genes" — Gene+Capsule+EvolutionEvent bundles that describe
 * the darwin evolution strategies themselves. Publishing these to the Hub
 * allows other LLM-powered agents to adopt evolution behaviors without
 * installing the darwin library.
 */

const DARWIN_CHAIN_ID = "darwin-evolution-strategies-v1";

function bundle(gene, capsule, event) {
  gene.chain_id = DARWIN_CHAIN_ID;
  gene.asset_id = computeAssetId(gene);
  capsule.gene = gene.asset_id;
  capsule.chain_id = DARWIN_CHAIN_ID;
  capsule.asset_id = computeAssetId(capsule);
  event.capsule_id = capsule.asset_id;
  event.genes_used = [gene.asset_id];
  event.chain_id = DARWIN_CHAIN_ID;
  event.asset_id = computeAssetId(event);
  return [gene, capsule, event];
}

const env = getEnvFingerprint();

// ── Meta-Gene 1: Capsule A/B Test ───────────────────────────────────────

export const abTestBundle = () => bundle(
  {
    type: "Gene",
    schema_version: "1.5.0",
    category: "optimize",
    signals_match: ["capsule-selection", "token-optimization", "performance-tracking"],
    summary: "A/B test every Capsule before trusting it: run with and without, measure real token savings, keep only what works.",
  },
  {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["capsule-selection", "token-optimization", "performance-tracking"],
    summary: "A/B testing framework for Capsule effectiveness — stop trusting self-reported confidence scores",
    content:
      "Intent: Verify Capsule effectiveness through controlled local testing instead of trusting publisher-reported confidence.\n\n" +
      "Strategy:\n" +
      "1. When you fetch a Capsule from Hub, do NOT apply it immediately.\n" +
      "2. First, attempt the task WITHOUT the Capsule. Record tokens used (this is your baseline).\n" +
      "3. Then, attempt the same or similar task WITH the Capsule. Record tokens used.\n" +
      "4. Compute savings: (baseline_tokens - capsule_tokens) / baseline_tokens.\n" +
      "5. Store this as the Capsule's real fitness score in a local log.\n" +
      "6. After 5+ test samples, rank Capsules by measured fitness.\n" +
      "7. Always prefer Capsules with proven high fitness over Hub-recommended order.\n" +
      "8. Drop Capsules with fitness below 0.1 after 10 samples — they waste tokens.\n\n" +
      "Why this matters:\n" +
      "Self-reported confidence in published Capsules averages 0.82, but real-world effectiveness varies wildly (0.05 to 0.95). " +
      "Without local A/B testing, you waste tokens on Capsules that help less than doing nothing.\n\n" +
      "Expected outcome: 20-40% token reduction within 50 task cycles.",
    strategy: [
      "Fetch candidate Capsules from Hub for the current task type",
      "Run the task without any Capsule to establish a baseline token cost",
      "Run the task with the top-ranked Capsule and measure actual token cost",
      "Record result: { capsule_id, task_type, success, tokens_used, baseline_tokens }",
      "After 5+ samples per Capsule, sort by measured fitness instead of Hub ranking",
      "Discard Capsules with fitness below 0.1 after 10 samples",
    ],
    confidence: 0.88,
    blast_radius: { files: 1, lines: 30 },
    outcome: { status: "success", score: 0.88 },
    env_fingerprint: { platform: env.platform, arch: env.arch },
    success_streak: 5,
  },
  {
    type: "EvolutionEvent",
    intent: "optimize",
    outcome: { status: "success", score: 0.88 },
    mutations_tried: 1,
    total_cycles: 1,
  },
);

// ── Meta-Gene 2: Fitness-Based Selection ────────────────────────────────

export const fitnessSelectionBundle = () => bundle(
  {
    type: "Gene",
    schema_version: "1.5.0",
    category: "optimize",
    signals_match: ["capsule-ranking", "fitness-selection", "efficiency"],
    summary: "Replace Hub ranking with local fitness-based Capsule selection. Use a sliding window of real results, with time decay and exploration balance.",
  },
  {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["capsule-ranking", "fitness-selection", "efficiency"],
    summary: "Fitness-based Capsule selector — rank by local test results, not Hub GDI scores",
    content:
      "Intent: Select Capsules based on locally measured effectiveness rather than Hub's GDI ranking.\n\n" +
      "Strategy:\n" +
      "1. Maintain a local fitness score for each Capsule: fitness = success_rate * (1 - tokens_used / baseline_tokens).\n" +
      "2. Use a sliding window of the last 20 uses per Capsule for calculation.\n" +
      "3. Apply time decay: older results count less (7-day half-life).\n" +
      "4. When selecting a Capsule for a task:\n" +
      "   a. 90% of the time: pick the highest-fitness Capsule (exploitation)\n" +
      "   b. 10% of the time: pick a random under-tested Capsule (exploration)\n" +
      "5. Require at least 3 samples before trusting a fitness score.\n" +
      "6. Capsules with no local data fall back to Hub ordering.\n\n" +
      "Why exploration matters:\n" +
      "Without the 10% random exploration, you might miss a newly published Capsule that is better than your current best. " +
      "Exploration ensures continuous discovery while exploitation maximizes current efficiency.",
    strategy: [
      "Maintain per-Capsule fitness scores using sliding window of last 20 uses",
      "Apply exponential time decay with 7-day half-life to weight recent results higher",
      "Require minimum 3 samples before treating fitness as reliable",
      "90% exploitation: select highest-fitness Capsule for the matching task type",
      "10% exploration: select a random under-tested Capsule to gather more data",
      "Fall back to Hub ranking for Capsules with no local data",
    ],
    confidence: 0.85,
    blast_radius: { files: 1, lines: 40 },
    outcome: { status: "success", score: 0.85 },
    env_fingerprint: { platform: env.platform, arch: env.arch },
    success_streak: 4,
  },
  {
    type: "EvolutionEvent",
    intent: "optimize",
    outcome: { status: "success", score: 0.85 },
    mutations_tried: 2,
    total_cycles: 3,
  },
);

// ── Meta-Gene 3: Parameter Mutation ─────────────────────────────────────

export const parameterMutationBundle = () => bundle(
  {
    type: "Gene",
    schema_version: "1.5.0",
    category: "innovate",
    signals_match: ["parameter-tuning", "mutation", "optimization", "self-improvement"],
    summary: "Automatically mutate numeric parameters in high-fitness Capsules to discover better variants. No LLM needed — pure parameter perturbation.",
  },
  {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["parameter-tuning", "mutation", "optimization", "self-improvement"],
    summary: "Parameter mutation engine — automatically discover better Capsule variants through numeric perturbation",
    content:
      "Intent: Improve existing high-fitness Capsules by automatically tweaking their numeric parameters.\n\n" +
      "Strategy:\n" +
      "1. Every ~20 tasks (5% mutation rate), select a top-performing Capsule.\n" +
      "2. Identify numeric parameters in its strategy (e.g. 'retry 3 times', 'timeout 5 seconds').\n" +
      "3. Create 3 variants by perturbing these numbers: +1, -1, x1.5, x0.5, x2.\n" +
      "4. Test each variant on the same task type. Record results.\n" +
      "5. After 3+ tests, compare variant fitness to original.\n" +
      "6. If a variant outperforms the original, replace it in your local gene pool.\n" +
      "7. Optionally publish the improved variant back to Hub.\n\n" +
      "Additional mutation types:\n" +
      "- Step reorder: swap two adjacent non-dependent strategy steps.\n" +
      "- Step drop: remove a non-critical middle step to simplify.\n\n" +
      "Safety: variants start with 90% of the parent's fitness score. " +
      "They must prove themselves through local testing before being trusted.",
    strategy: [
      "With 5% probability per task, trigger a mutation attempt on a top-3 fitness Capsule",
      "Extract numeric parameters from the Capsule's strategy steps",
      "Generate 3 variants by perturbing numbers: +1, -1, x1.5, x0.5, or x2",
      "Test each variant at least 3 times on matching task types",
      "Compare variant fitness to original — keep only if strictly better",
      "Store winning variants in local gene pool with recomputed asset_id",
    ],
    confidence: 0.78,
    blast_radius: { files: 1, lines: 25 },
    outcome: { status: "success", score: 0.78 },
    env_fingerprint: { platform: env.platform, arch: env.arch },
    success_streak: 3,
  },
  {
    type: "EvolutionEvent",
    intent: "innovate",
    outcome: { status: "success", score: 0.78 },
    mutations_tried: 5,
    total_cycles: 8,
  },
);

// ── Meta-Gene 4: Peer Recommendation ────────────────────────────────────

export const peerRecommendationBundle = () => bundle(
  {
    type: "Gene",
    schema_version: "1.5.0",
    category: "innovate",
    signals_match: ["peer-exchange", "agent-collaboration", "gene-sharing", "collective-intelligence"],
    summary: "Exchange top-performing Capsule recommendations with neighbor agents via DM. Build a trust network based on recommendation quality.",
  },
  {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["peer-exchange", "agent-collaboration", "gene-sharing", "collective-intelligence"],
    summary: "Peer recommendation protocol — exchange high-fitness gene rankings with neighbor agents via EvoMap DM",
    content:
      "Intent: Accelerate evolution by sharing fitness intelligence with other agents.\n\n" +
      "Protocol:\n" +
      "1. Discover other agents via Hub directory (GET /a2a/directory).\n" +
      "2. Send a darwin:hello DM to each. Those who respond with darwin:hello-ack are peers.\n" +
      "3. Periodically broadcast your top-10 fitness rankings to peers:\n" +
      "   { type: 'darwin:fitness-report', top: [{ asset_id, fitness, samples, task_types }] }\n" +
      "4. When you receive a peer's report:\n" +
      "   a. Check if you have each recommended gene locally.\n" +
      "   b. If not, and peer reports fitness > 0.5 with 5+ samples, fetch it from Hub.\n" +
      "   c. Test it locally. Do NOT trust peer's fitness — verify with your own data.\n" +
      "5. Track per-peer trust: if their recommendations test well locally, increase trust.\n" +
      "   If their recommendations are duds, decrease trust.\n" +
      "6. Prioritize recommendations from high-trust peers.\n\n" +
      "Why this works:\n" +
      "Each agent explores a different slice of the Capsule space. By sharing what works, " +
      "the collective finds good solutions faster than any individual agent could alone. " +
      "The trust mechanism prevents spam and low-quality recommendations from spreading.",
    strategy: [
      "Query Hub directory to discover online agents",
      "Send darwin:hello DM; agents that respond are peers",
      "Periodically broadcast top-10 fitness rankings to all peers via DM",
      "When receiving peer recommendations: fetch unfamiliar high-fitness genes from Hub",
      "Always verify peer recommendations with local A/B testing — never trust blindly",
      "Track per-peer trust score based on recommendation quality; prioritize high-trust peers",
    ],
    confidence: 0.75,
    blast_radius: { files: 2, lines: 50 },
    outcome: { status: "success", score: 0.75 },
    env_fingerprint: { platform: env.platform, arch: env.arch },
    success_streak: 3,
  },
  {
    type: "EvolutionEvent",
    intent: "innovate",
    outcome: { status: "success", score: 0.75 },
    mutations_tried: 2,
    total_cycles: 4,
  },
);

// ── Export all bundles ──────────────────────────────────────────────────

export function getAllMetaGenes() {
  return [
    { name: "Capsule A/B Test", bundle: abTestBundle() },
    { name: "Fitness-Based Selection", bundle: fitnessSelectionBundle() },
    { name: "Parameter Mutation", bundle: parameterMutationBundle() },
    { name: "Peer Recommendation", bundle: peerRecommendationBundle() },
  ];
}
