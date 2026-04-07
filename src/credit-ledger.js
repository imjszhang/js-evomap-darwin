import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_WINDOW = 100;

/**
 * Append-only ledger that tracks credit balance snapshots, earnings from
 * completed tasks, and spend events from Hub fetch operations.
 * Provides a summary for dashboards and ROI analysis.
 */
export class CreditLedger {
  #logPath;
  #snapshots;   // { balance, timestamp }[]
  #earnings;    // { taskId, bounty, contribution, rewardStatus, timestamp }[]
  #spends;      // { type, signals, count, timestamp }[]

  constructor({ dataDir = "./data" } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.#logPath = join(dataDir, "credit-ledger.jsonl");
    this.#snapshots = [];
    this.#earnings = [];
    this.#spends = [];
    this.#load();
  }

  recordBalance(creditBalance, timestamp) {
    const n = typeof creditBalance === "number" ? creditBalance : Number(creditBalance);
    if (!Number.isFinite(n)) return;
    const entry = { type: "balance", balance: n, timestamp: timestamp || new Date().toISOString() };
    this.#snapshots.push(entry);
    if (this.#snapshots.length > SNAPSHOT_WINDOW) {
      this.#snapshots.splice(0, this.#snapshots.length - SNAPSHOT_WINDOW);
    }
    this.#append(entry);
  }

  recordEarning({ taskId, bounty, contribution, rewardStatus }) {
    const entry = {
      type: "earning",
      taskId,
      bounty: bounty || 0,
      contribution: contribution ?? null,
      rewardStatus: rewardStatus ?? null,
      timestamp: new Date().toISOString(),
    };
    this.#earnings.push(entry);
    this.#append(entry);
  }

  recordSpend({ spendType = "fetch", signals, count }) {
    const entry = {
      type: "spend",
      spendType,
      signals: signals || [],
      count: count || 0,
      timestamp: new Date().toISOString(),
    };
    this.#spends.push(entry);
    this.#append(entry);
  }

  getSummary() {
    const totalEarned = this.#earnings.reduce((s, e) => s + (e.bounty || 0), 0);
    const totalSpends = this.#spends.length;
    const totalFetchedCapsules = this.#spends.reduce((s, e) => s + (e.count || 0), 0);

    const latest = this.#snapshots.length > 0 ? this.#snapshots[this.#snapshots.length - 1] : null;
    const oldest = this.#snapshots.length > 1 ? this.#snapshots[0] : null;
    const balanceChange = (latest && oldest) ? latest.balance - oldest.balance : null;

    const completedCount = this.#earnings.filter((e) => e.rewardStatus !== "rejected" && e.rewardStatus !== "failed").length;
    const rejectedCount = this.#earnings.filter((e) => e.rewardStatus === "rejected" || e.rewardStatus === "failed").length;

    return {
      currentBalance: latest?.balance ?? null,
      balanceChange,
      snapshotCount: this.#snapshots.length,
      totalEarned,
      earnings: { total: this.#earnings.length, completed: completedCount, rejected: rejectedCount },
      fetches: { total: totalSpends, capsulesFetched: totalFetchedCapsules },
      recentEarnings: this.#earnings.slice(-5),
      recentSpends: this.#spends.slice(-5),
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────

  #append(entry) {
    try {
      appendFileSync(this.#logPath, JSON.stringify(entry) + "\n");
    } catch { /* write failed */ }
  }

  #load() {
    if (!existsSync(this.#logPath)) return;
    try {
      const lines = readFileSync(this.#logPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "balance") this.#snapshots.push(entry);
          else if (entry.type === "earning") this.#earnings.push(entry);
          else if (entry.type === "spend") this.#spends.push(entry);
        } catch { /* skip malformed */ }
      }
      if (this.#snapshots.length > SNAPSHOT_WINDOW) {
        this.#snapshots.splice(0, this.#snapshots.length - SNAPSHOT_WINDOW);
      }
    } catch { /* start fresh */ }
  }
}
