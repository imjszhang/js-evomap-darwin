import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from "node:fs";
import { join } from "node:path";

const DEFAULT_CAPACITY = 200;
const MAX_CAPSULE_SIZE = 50_000;
const WATCH_DEBOUNCE_MS = 300;
const SAVE_GUARD_MS = 500;

/**
 * Local gene pool with fixed capacity and fitness-based eviction.
 * Stores Capsule objects indexed by asset_id.
 */
export class GeneStore {
  #filePath;
  #capacity;
  #genes; // Map<asset_id, { capsule, addedAt, fitness, source }>
  #onChange;
  #watcher;
  #saving = false;
  #watchDebounceTimer;

  constructor({ dataDir = "./data", capacity = DEFAULT_CAPACITY, onChange } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.#filePath = join(dataDir, "gene-store.json");
    this.#capacity = capacity;
    this.#onChange = typeof onChange === "function" ? onChange : null;
    this.#genes = new Map();
    this.#load();
    this.#startWatching();
  }

  get size() { return this.#genes.size; }
  get capacity() { return this.#capacity; }
  get isFull() { return this.#genes.size >= this.#capacity; }

  get lowestFitness() {
    return this.#genes.size > 0 ? this.#getLowestFitness() : 0;
  }

  set onChange(fn) {
    this.#onChange = typeof fn === "function" ? fn : null;
  }

  /**
   * Add or update a capsule in the local gene pool.
   * Returns true if the capsule was actually added/updated, false if rejected.
   *
   * Rejection reasons:
   * - Fails structural validation (#isValidCapsule)
   * - Pool is full and the new fitness does not exceed the current lowest
   */
  add(capsule, fitness = null, source = "hub") {
    if (!this.#isValidCapsule(capsule)) return false;
    const id = capsule.asset_id;

    if (this.#genes.has(id)) {
      const entry = this.#genes.get(id);
      entry.capsule = capsule;
      if (fitness !== null) entry.fitness = fitness;
      if (source !== "hub") entry.source = source;
      else if (!entry.source) entry.source = source;
      this.#save();
      return true;
    }

    if (this.#genes.size >= this.#capacity) {
      const lowest = this.#getLowestFitness();
      if ((fitness ?? 0) <= lowest) return false;
      this.#evictLowest();
    }

    this.#genes.set(id, {
      capsule,
      addedAt: new Date().toISOString(),
      fitness: fitness ?? 0,
      source,
    });
    this.#save();
    return true;
  }

  get(assetId) {
    const entry = this.#genes.get(assetId);
    return entry ? entry.capsule : null;
  }

  has(assetId) {
    return this.#genes.has(assetId);
  }

  remove(assetId) {
    const deleted = this.#genes.delete(assetId);
    if (deleted) this.#save();
    return deleted;
  }

  updateFitness(assetId, fitness) {
    const entry = this.#genes.get(assetId);
    if (entry) {
      entry.fitness = fitness;
      this.#save();
    }
  }

  /**
   * Get all capsules matching a task type (by trigger signals).
   * Uses three-level progressive matching:
   *   Level 1 (exact):   exact case-insensitive match        -> matchQuality 1.0
   *   Level 2 (contains): one string contains the other      -> matchQuality 0.7
   *   Level 3 (token):   tokenized overlap (split on -_camel) -> matchQuality 0.5
   */
  findByTaskType(taskType, { excludeSources } = {}) {
    const query = taskType.toLowerCase();
    const queryTokens = GeneStore.#tokenize(query);
    const results = [];
    const skipSources = excludeSources && excludeSources.length > 0
      ? new Set(excludeSources)
      : null;

    for (const [id, entry] of this.#genes) {
      if (skipSources && skipSources.has(entry.source)) continue;
      const triggers = entry.capsule.trigger || entry.capsule.signals_match || [];
      let bestQuality = 0;

      for (const t of triggers) {
        const tLower = t.toLowerCase();
        if (tLower === query) {
          bestQuality = 1.0;
          break;
        }
        if (bestQuality < 0.7 && (tLower.includes(query) || query.includes(tLower))) {
          bestQuality = 0.7;
          continue;
        }
        if (bestQuality < 0.5) {
          const tTokens = GeneStore.#tokenize(tLower);
          const overlap = queryTokens.filter((tok) => tTokens.includes(tok)).length;
          if (overlap > 0 && overlap >= Math.min(queryTokens.length, tTokens.length) * 0.5) {
            bestQuality = 0.5;
          }
        }
      }

      if (bestQuality > 0) {
        results.push({ ...entry, assetId: id, matchQuality: bestQuality });
      }
    }
    return results.sort((a, b) => {
      const qDiff = (b.matchQuality ?? 0) - (a.matchQuality ?? 0);
      if (qDiff !== 0) return qDiff;
      return (b.fitness ?? 0) - (a.fitness ?? 0);
    });
  }

  static #tokenize(str) {
    return str
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((t) => t.length > 1);
  }

  /**
   * Return all genes sorted by fitness (descending).
   */
  ranked(limit = 50) {
    return [...this.#genes.entries()]
      .map(([id, entry]) => ({ assetId: id, ...entry }))
      .sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))
      .slice(0, limit);
  }

  /**
   * Remove Capsules that share the same strategy body (summary, content, strategy, triggers).
   * Uses the same persistence path as remove(). When preferredIds is set (e.g. current meta-gene
   * capsule ids), keeps that row if present; otherwise keeps highest fitness, then newest addedAt.
   * @param {{ preferredIds?: Set<string>, dryRun?: boolean }} [options]
   * @returns {{ removed: string[], groupsWithDuplicates: number }}
   */
  deduplicateByContent({ preferredIds = null, dryRun = false } = {}) {
    const all = this.ranked(this.#capacity);
    const groups = new Map();
    for (const entry of all) {
      const fp = this.#capsuleBodyFingerprint(entry.capsule);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(entry);
    }
    const removed = [];
    let groupsWithDuplicates = 0;
    for (const [, entries] of groups) {
      if (entries.length < 2) continue;
      groupsWithDuplicates++;
      const keeper = this.#pickDuplicateKeeper(entries, preferredIds);
      for (const e of entries) {
        if (e.assetId === keeper.assetId) continue;
        if (!dryRun) this.remove(e.assetId);
        removed.push(e.assetId);
      }
    }
    return { removed, groupsWithDuplicates };
  }

  /**
   * Return stats for the dashboard.
   */
  getStats() {
    const entries = [...this.#genes.values()];
    const fitnesses = entries.map((e) => e.fitness ?? 0);
    return {
      size: this.#genes.size,
      capacity: this.#capacity,
      avgFitness: fitnesses.length ? fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length : 0,
      topFitness: fitnesses.length ? Math.max(...fitnesses) : 0,
      bottomFitness: fitnesses.length ? Math.min(...fitnesses) : 0,
    };
  }

  getSourceBreakdown() {
    const counts = { hub: 0, mutation: 0, peer: 0, subscription: 0, meta: 0, template: 0 };
    for (const [, entry] of this.#genes) {
      const src = entry.source || "hub";
      if (src in counts) counts[src]++;
      else counts.hub++;
    }
    return counts;
  }

  toJSON() {
    const obj = {};
    for (const [id, entry] of this.#genes) {
      obj[id] = entry;
    }
    return obj;
  }

  /**
   * Close the file watcher. Call on graceful shutdown.
   */
  destroy() {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }
    clearTimeout(this.#watchDebounceTimer);
  }

  // ── Private ───────────────────────────────────────────────────────────

  #capsuleBodyFingerprint(capsule) {
    if (!capsule || typeof capsule !== "object") return "";
    const triggers = capsule.trigger || capsule.signals_match;
    const trig = Array.isArray(triggers)
      ? [...triggers].map(String).sort()
      : triggers ?? null;
    const strat = Array.isArray(capsule.strategy)
      ? capsule.strategy.map(String)
      : capsule.strategy ?? null;
    return JSON.stringify({
      summary: capsule.summary ?? "",
      content: capsule.content ?? "",
      strategy: strat,
      trigger: trig,
    });
  }

  #pickDuplicateKeeper(entries, preferredIds) {
    if (preferredIds && preferredIds.size > 0) {
      const preferred = entries.filter((e) => preferredIds.has(e.assetId));
      if (preferred.length === 1) return preferred[0];
      if (preferred.length > 1) {
        return [...preferred].sort((a, b) => {
          const fa = a.fitness ?? 0;
          const fb = b.fitness ?? 0;
          if (fb !== fa) return fb - fa;
          return String(b.addedAt || "").localeCompare(String(a.addedAt || ""));
        })[0];
      }
    }
    return [...entries].sort((a, b) => {
      const fa = a.fitness ?? 0;
      const fb = b.fitness ?? 0;
      if (fb !== fa) return fb - fa;
      const ca = String(a.addedAt || "");
      const cb = String(b.addedAt || "");
      if (cb !== ca) return cb.localeCompare(ca);
      return a.assetId.localeCompare(b.assetId);
    })[0];
  }

  #isValidCapsule(capsule) {
    if (!capsule || typeof capsule !== "object") return false;
    if (!capsule.asset_id) return false;
    if (capsule.type !== "Capsule") return false;
    const hasContent = typeof capsule.content === "string" && capsule.content.length > 0;
    const hasStrategy = Array.isArray(capsule.strategy) && capsule.strategy.length > 0;
    if (!hasContent && !hasStrategy) return false;
    const triggers = capsule.trigger || capsule.signals_match;
    if (!Array.isArray(triggers) || triggers.length === 0) return false;
    try {
      if (JSON.stringify(capsule).length > MAX_CAPSULE_SIZE) return false;
    } catch { return false; }
    return true;
  }

  #getLowestFitness() {
    let lowest = Infinity;
    for (const [, entry] of this.#genes) {
      const f = entry.fitness ?? 0;
      if (f < lowest) lowest = f;
    }
    return lowest === Infinity ? 0 : lowest;
  }

  #evictLowest() {
    let lowestId = null;
    let lowestFitness = Infinity;
    for (const [id, entry] of this.#genes) {
      const f = entry.fitness ?? 0;
      if (f < lowestFitness) {
        lowestFitness = f;
        lowestId = id;
      }
    }
    if (lowestId) this.#genes.delete(lowestId);
  }

  #load() {
    if (!existsSync(this.#filePath)) return;
    let dirty = false;
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, "utf-8"));
      for (const [id, entry] of Object.entries(raw)) {
        if (!entry.source) {
          entry.source = entry.capsule?._mutation ? "mutation" : "hub";
        }
        if (entry.source === "template") {
          dirty = true;
          continue;
        }
        this.#genes.set(id, entry);
      }
      if (dirty) this.#save();
    } catch {
      // corrupted file, start fresh
    }
  }

  #save() {
    this.#saving = true;
    writeFileSync(this.#filePath, JSON.stringify(this.toJSON(), null, 2));
    setTimeout(() => { this.#saving = false; }, SAVE_GUARD_MS);
  }

  #startWatching() {
    try {
      if (!existsSync(this.#filePath)) return;
      this.#watcher = watch(this.#filePath, () => {
        clearTimeout(this.#watchDebounceTimer);
        this.#watchDebounceTimer = setTimeout(() => this.#reloadIfChanged(), WATCH_DEBOUNCE_MS);
      });
      this.#watcher.on("error", () => {});
    } catch {
      // watch not supported or file gone — silently skip
    }
  }

  #reloadIfChanged() {
    if (this.#saving) return;
    if (!existsSync(this.#filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, "utf-8"));
      this.#genes.clear();
      for (const [id, entry] of Object.entries(raw)) {
        if (!entry.source) {
          entry.source = entry.capsule?._mutation ? "mutation" : "hub";
        }
        if (entry.source === "template") continue;
        this.#genes.set(id, entry);
      }
      this.#onChange?.();
    } catch {
      // corrupted or mid-write — ignore, next change will retry
    }
  }
}
