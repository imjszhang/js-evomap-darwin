import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CAPACITY = 200;

/**
 * Local gene pool with fixed capacity and fitness-based eviction.
 * Stores Capsule objects indexed by asset_id.
 */
export class GeneStore {
  #filePath;
  #capacity;
  #genes; // Map<asset_id, { capsule, addedAt, fitness }>

  constructor({ dataDir = "./data", capacity = DEFAULT_CAPACITY } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.#filePath = join(dataDir, "gene-store.json");
    this.#capacity = capacity;
    this.#genes = new Map();
    this.#load();
  }

  get size() { return this.#genes.size; }
  get capacity() { return this.#capacity; }

  /**
   * Add or update a capsule in the local gene pool.
   * If at capacity, evicts the lowest-fitness gene.
   */
  add(capsule, fitness = null) {
    const id = capsule.asset_id;
    if (!id) return;

    if (this.#genes.has(id)) {
      const entry = this.#genes.get(id);
      entry.capsule = capsule;
      if (fitness !== null) entry.fitness = fitness;
      this.#save();
      return;
    }

    if (this.#genes.size >= this.#capacity) {
      this.#evictLowest();
    }

    this.#genes.set(id, {
      capsule,
      addedAt: new Date().toISOString(),
      fitness: fitness ?? 0,
    });
    this.#save();
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

  toJSON() {
    const obj = {};
    for (const [id, entry] of this.#genes) {
      obj[id] = entry;
    }
    return obj;
  }

  // ── Private ───────────────────────────────────────────────────────────

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
        this.#genes.set(id, entry);
      }
    } catch {
      // corrupted file, start fresh
    }
  }

  #save() {
    writeFileSync(this.#filePath, JSON.stringify(this.toJSON(), null, 2));
  }
}
