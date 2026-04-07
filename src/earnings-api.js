/**
 * Normalize Hub GET /billing/earnings/:nodeId and merge with local ledger for dashboard/API.
 */

function toFiniteNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} hubResponse - raw JSON from Hub (may be { payload: {...} })
 * @returns {number | null}
 */
export function pickHubEarningsTotal(hubResponse) {
  const obj = hubResponse?.payload ?? hubResponse;
  if (obj == null || typeof obj !== "object") return null;
  const keys = [
    "total",
    "earned",
    "totalEarned",
    "total_earned",
    "lifetimeEarnings",
    "lifetime_earnings",
    "lifetimeCredits",
    "lifetime_credits",
    "creditsEarned",
    "credits_earned",
    "amount",
    "sum",
  ];
  for (const k of keys) {
    const n = toFiniteNumber(obj[k]);
    if (n !== null) return n;
  }
  if (obj.summary != null && typeof obj.summary === "object") {
    return pickHubEarningsTotal({ payload: obj.summary });
  }
  return null;
}

/**
 * @param {{ hub?: { nodeId?: string | null, getEarnings(): Promise<unknown> }, creditLedger?: { getSummary(): { totalEarned?: number } } }} darwin
 */
export async function buildEarningsApiPayload(darwin) {
  const local = darwin.creditLedger?.getSummary()?.totalEarned ?? 0;
  let hubTotal = null;
  let hubError = null;
  try {
    if (darwin.hub?.nodeId) {
      const raw = await darwin.hub.getEarnings();
      hubTotal = pickHubEarningsTotal(raw);
    }
  } catch (e) {
    hubError = e?.message || String(e);
  }
  const total = hubTotal != null ? hubTotal : local;
  return {
    total,
    hubTotal,
    localTotalEarned: local,
    ...(hubError ? { hubError } : {}),
  };
}
