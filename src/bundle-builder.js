import { computeAssetId } from "./utils/hash.js";

/**
 * Build a compliant Gene + Capsule + EvolutionEvent bundle from a single
 * Capsule. EvoMap requires at least Gene + Capsule in every publish;
 * including the EvolutionEvent adds +6.7% GDI score.
 *
 * CRITICAL: The Hub computes each asset's asset_id by hashing the asset
 * WITHOUT the asset_id field.
 * - Gene must NOT include `schema_version` — Hub Gene schema does not have it.
 * - Capsule asset_id is computed from the original capsule.
 * - Only AFTER both IDs are computed do we wire up cross-references.
 */
export function buildBundle(capsule) {
  const strategy = Array.isArray(capsule.strategy) && capsule.strategy.length >= 2
    ? capsule.strategy.slice(0, 10)
    : [
        "Decompose problem into measurable sub-objectives with validation checkpoints",
        "Apply A/B comparison against baseline to verify genuine improvement",
      ];

  // Gene: do NOT include schema_version — Hub rejects it during hash verification
  const gene = {
    type: "Gene",
    category: "optimize",
    signals_match: Array.isArray(capsule.trigger) ? [...capsule.trigger] : [],
    summary: (capsule.summary || "").slice(0, 200),
    strategy,
  };
  const geneId = computeAssetId(gene);

  // Compute Capsule asset_id BEFORE adding the gene cross-reference.
  // The Hub auto-links Gene → Capsule via the bundle's assets array order,
  // so it hashes the Capsule without the `gene` field.
  const capsuleId = computeAssetId(capsule);

  const capsuleCopy = {
    ...capsule,
    asset_id: capsuleId,
    gene: geneId,
  };

  // EvolutionEvent: only include fields the Hub schema accepts
  const event = {
    type: "EvolutionEvent",
    event_type: "capsule_created",
    description: `Created Capsule: ${capsule.summary || "unknown"}`,
  };
  event.asset_id = computeAssetId(event);

  gene.asset_id = geneId;

  return [gene, capsuleCopy, event];
}
