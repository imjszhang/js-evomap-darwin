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
   */
  findByTaskType(taskType) {
    const results = [];
    for (const [id, entry] of this.#genes) {
      const triggers = entry.capsule.trigger || entry.capsule.signals_match || [];
      const matchesSignal = triggers.some(
        (t) => t.toLowerCase() === taskType.toLowerCase(),
      );
      if (matchesSignal) {
        results.push({ ...entry, assetId: id });
      }
    }
    return results.sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0));
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
    const counts = { hub: 0, mutation: 0, peer: 0, subscription: 0, meta: 0 };
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
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, "utf-8"));
      for (const [id, entry] of Object.entries(raw)) {
        if (!entry.source) {
          entry.source = entry.capsule?._mutation ? "mutation" : "hub";
        }
        this.#genes.set(id, entry);
      }
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
        this.#genes.set(id, entry);
      }
      this.#onChange?.();
    } catch {
      // corrupted or mid-write — ignore, next change will retry
    }
  }
}
