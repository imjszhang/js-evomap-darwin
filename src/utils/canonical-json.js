/**
 * Deterministic JSON serialization with sorted keys at all levels.
 * Required for content-addressable asset_id computation.
 */
export function canonicalJson(obj) {
  return JSON.stringify(sortDeep(obj));
}

function sortDeep(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  if (typeof val === "object") {
    const sorted = {};
    for (const key of Object.keys(val).sort()) {
      sorted[key] = sortDeep(val[key]);
    }
    return sorted;
  }
  return val;
}
