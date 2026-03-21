import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

/**
 * Compute the content-addressable asset_id for an EvoMap asset.
 * Follows the spec: sha256(canonical_json(asset_without_asset_id_field))
 */
export function computeAssetId(asset) {
  const { asset_id, ...rest } = asset;
  const canonical = canonicalJson(rest);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hex}`;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
