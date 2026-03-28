import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ACCEPT_MODES = ["open", "mutual", "selective"];

/**
 * Manages trust policy for the subscription system: accept modes,
 * blocked nodes, and capacity limits. All decisions are local-only.
 */
export class TrustPolicy {
  #filePath;
  #acceptMode;
  #selectiveThreshold;
  #maxSubscribers;
  #maxSubscriptions;
  #blocked; // Set<nodeId>

  constructor({
    dataDir = "./data",
    acceptMode = "open",
    selectiveThreshold = 0.5,
    maxSubscribers = 50,
    maxSubscriptions = 20,
  } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.#filePath = join(dataDir, "trust-policy.json");
    this.#acceptMode = ACCEPT_MODES.includes(acceptMode) ? acceptMode : "open";
    this.#selectiveThreshold = selectiveThreshold;
    this.#maxSubscribers = maxSubscribers;
    this.#maxSubscriptions = maxSubscriptions;
    this.#blocked = new Set();
    this.#load();
  }

  get acceptMode() { return this.#acceptMode; }
  get selectiveThreshold() { return this.#selectiveThreshold; }
  get maxSubscribers() { return this.#maxSubscribers; }
  get maxSubscriptions() { return this.#maxSubscriptions; }
  get blockedCount() { return this.#blocked.size; }

  setAcceptMode(mode) {
    if (!ACCEPT_MODES.includes(mode)) return false;
    this.#acceptMode = mode;
    this.#save();
    return true;
  }

  setSelectiveThreshold(threshold) {
    this.#selectiveThreshold = Math.max(0, Math.min(1, threshold));
    this.#save();
  }

  isBlocked(nodeId) {
    return this.#blocked.has(nodeId);
  }

  block(nodeId) {
    if (!nodeId) return;
    this.#blocked.add(nodeId);
    this.#save();
  }

  unblock(nodeId) {
    const removed = this.#blocked.delete(nodeId);
    if (removed) this.#save();
    return removed;
  }

  getBlockedList() {
    return [...this.#blocked];
  }

  /**
   * Decide whether to accept an incoming subscription request.
   *
   * @param {string} nodeId - The requesting node
   * @param {object} context
   * @param {number} context.currentSubscribers - Current subscriber count
   * @param {boolean} context.isMutual - Whether we also subscribe to this node
   * @param {number} context.reputation - Node's Hub reputation (0~100), or null
   * @returns {boolean}
   */
  shouldAccept(nodeId, { currentSubscribers = 0, isMutual = false, reputation = null } = {}) {
    if (this.#blocked.has(nodeId)) return false;
    if (currentSubscribers >= this.#maxSubscribers) return false;

    switch (this.#acceptMode) {
      case "open":
        return true;
      case "mutual":
        return isMutual;
      case "selective":
        if (reputation === null) return false;
        return (reputation / 100) >= this.#selectiveThreshold;
      default:
        return true;
    }
  }

  /**
   * Check if we can add another outgoing subscription.
   */
  canSubscribe(currentSubscriptions) {
    return currentSubscriptions < this.#maxSubscriptions;
  }

  getStats() {
    return {
      acceptMode: this.#acceptMode,
      selectiveThreshold: this.#selectiveThreshold,
      maxSubscribers: this.#maxSubscribers,
      maxSubscriptions: this.#maxSubscriptions,
      blockedCount: this.#blocked.size,
      blockedNodes: [...this.#blocked],
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────

  #load() {
    if (!existsSync(this.#filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, "utf-8"));
      if (raw.acceptMode && ACCEPT_MODES.includes(raw.acceptMode)) {
        this.#acceptMode = raw.acceptMode;
      }
      if (typeof raw.selectiveThreshold === "number") {
        this.#selectiveThreshold = raw.selectiveThreshold;
      }
      if (typeof raw.maxSubscribers === "number") {
        this.#maxSubscribers = raw.maxSubscribers;
      }
      if (typeof raw.maxSubscriptions === "number") {
        this.#maxSubscriptions = raw.maxSubscriptions;
      }
      if (Array.isArray(raw.blocked)) {
        this.#blocked = new Set(raw.blocked);
      }
    } catch { /* start fresh */ }
  }

  #save() {
    writeFileSync(this.#filePath, JSON.stringify({
      acceptMode: this.#acceptMode,
      selectiveThreshold: this.#selectiveThreshold,
      maxSubscribers: this.#maxSubscribers,
      maxSubscriptions: this.#maxSubscriptions,
      blocked: [...this.#blocked],
    }, null, 2));
  }
}
