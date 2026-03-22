import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Manages token supplier sponsorship grants (Evolution Grants).
 *
 * Token suppliers inject real token budgets to subsidize darwin agents'
 * mutation and A/B testing. In return they receive per-model fitness data.
 *
 * Persistence: data/sponsors.json (grants) + data/sponsor-log.jsonl (consumption).
 */
export class Sponsor {
  #dataDir;
  #grantsPath;
  #logPath;
  #grants; // Map<grantId, Grant>
  #rewards; // { grantId, fitness, rewardTokens, timestamp }[]

  constructor({ dataDir = "./data" } = {}) {
    this.#dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.#grantsPath = join(dataDir, "sponsors.json");
    this.#logPath = join(dataDir, "sponsor-log.jsonl");
    this.#grants = new Map();
    this.#rewards = [];
    this.#load();
  }

  /**
   * Register a new sponsorship grant.
   */
  addGrant({
    sponsorId,
    model,
    grantType = "mutation",
    tokenBudget,
    rewardThreshold = 0.8,
    rewardTokens = 0,
    expiresAt,
  }) {
    const grant = {
      grantId: `grant_${Date.now()}_${randomBytes(4).toString("hex")}`,
      sponsorId,
      model,
      grantType,
      tokenBudget,
      tokenUsed: 0,
      rewardThreshold,
      rewardTokens,
      expiresAt: expiresAt || null,
      createdAt: new Date().toISOString(),
    };
    this.#grants.set(grant.grantId, grant);
    this.#save();
    return grant;
  }

  /**
   * Find an available grant matching the requested type and optional model.
   * Returns the grant with the most remaining budget, or null.
   */
  getAvailableGrant(grantType, model) {
    const now = Date.now();
    let best = null;
    let bestRemaining = 0;

    for (const g of this.#grants.values()) {
      if (g.grantType !== grantType) continue;
      if (model && g.model !== model) continue;
      if (g.expiresAt && new Date(g.expiresAt).getTime() < now) continue;

      const remaining = g.tokenBudget - g.tokenUsed;
      if (remaining <= 0) continue;
      if (remaining > bestRemaining) {
        best = g;
        bestRemaining = remaining;
      }
    }
    return best;
  }

  /**
   * Consume tokens from a grant and log the consumption.
   * Returns false if insufficient budget.
   */
  consumeTokens(grantId, amount, meta = {}) {
    const grant = this.#grants.get(grantId);
    if (!grant) return false;

    const remaining = grant.tokenBudget - grant.tokenUsed;
    if (amount > remaining) return false;

    grant.tokenUsed += amount;
    this.#save();

    const entry = {
      grantId,
      sponsorId: grant.sponsorId,
      model: grant.model,
      amount,
      timestamp: new Date().toISOString(),
      ...meta,
    };
    this.#appendLog(entry);
    return true;
  }

  /**
   * Check whether a fitness result triggers a sponsor reward.
   * Returns the reward amount (0 if no reward triggered).
   */
  checkReward(grantId, fitness) {
    const grant = this.#grants.get(grantId);
    if (!grant || !grant.rewardTokens) return 0;
    if (fitness < grant.rewardThreshold) return 0;

    const reward = {
      grantId,
      sponsorId: grant.sponsorId,
      fitness,
      rewardTokens: grant.rewardTokens,
      timestamp: new Date().toISOString(),
    };
    this.#rewards.push(reward);

    grant.tokenBudget += grant.rewardTokens;
    this.#save();

    return grant.rewardTokens;
  }

  /**
   * Get a specific grant by ID.
   */
  getGrant(grantId) {
    return this.#grants.get(grantId) ?? null;
  }

  /**
   * List all grants, optionally filtered by sponsorId.
   */
  listGrants(sponsorId) {
    const all = [...this.#grants.values()];
    if (sponsorId) return all.filter((g) => g.sponsorId === sponsorId);
    return all;
  }

  /**
   * Get aggregate statistics for dashboard / status.
   */
  getStats() {
    let totalBudget = 0;
    let totalUsed = 0;
    const bySponsor = {};

    for (const g of this.#grants.values()) {
      totalBudget += g.tokenBudget;
      totalUsed += g.tokenUsed;

      if (!bySponsor[g.sponsorId]) {
        bySponsor[g.sponsorId] = { budget: 0, used: 0, grants: 0, model: g.model };
      }
      bySponsor[g.sponsorId].budget += g.tokenBudget;
      bySponsor[g.sponsorId].used += g.tokenUsed;
      bySponsor[g.sponsorId].grants++;
    }

    return {
      totalGrants: this.#grants.size,
      totalBudget,
      totalUsed,
      totalRemaining: totalBudget - totalUsed,
      utilizationRate: totalBudget > 0 ? Math.round((totalUsed / totalBudget) * 1000) / 1000 : 0,
      bySponsor,
      rewardsTriggered: this.#rewards.length,
      rewardTokensAwarded: this.#rewards.reduce((s, r) => s + r.rewardTokens, 0),
    };
  }

  /**
   * Return recent rewards for display.
   */
  getRewards(limit = 20) {
    return this.#rewards.slice(-limit);
  }

  // ── Persistence ──────────────────────────────────────────────────────

  #appendLog(entry) {
    appendFileSync(this.#logPath, JSON.stringify(entry) + "\n");
  }

  #save() {
    const obj = {};
    for (const [id, grant] of this.#grants) {
      obj[id] = grant;
    }
    writeFileSync(this.#grantsPath, JSON.stringify({ grants: obj, rewards: this.#rewards }, null, 2));
  }

  #load() {
    if (!existsSync(this.#grantsPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#grantsPath, "utf-8"));
      if (raw.grants) {
        for (const [id, grant] of Object.entries(raw.grants)) {
          this.#grants.set(id, grant);
        }
      }
      if (raw.rewards) {
        this.#rewards = raw.rewards;
      }
    } catch { /* start fresh */ }
  }
}
