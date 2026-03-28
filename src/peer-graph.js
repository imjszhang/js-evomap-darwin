import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_PEERS = 500;

/**
 * Stores and queries the gossip-discovered peer network topology.
 * Provides a view of the Darwin network that goes beyond Hub's directory,
 * growing organically via peer_hints in deliver messages.
 */
export class PeerGraph {
  #filePath;
  #selfNodeId;
  #peers; // Map<nodeId, PeerInfo>

  constructor({ dataDir = "./data", selfNodeId = null } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.#filePath = join(dataDir, "peer-graph.json");
    this.#selfNodeId = selfNodeId;
    this.#peers = new Map();
    this.#load();
  }

  get size() { return this.#peers.size; }

  setSelfNodeId(id) { this.#selfNodeId = id; }

  has(nodeId) { return this.#peers.has(nodeId); }

  get(nodeId) { return this.#peers.get(nodeId) ?? null; }

  /**
   * Add nodes discovered from Hub directory (GET /a2a/directory).
   * These are Level 2 (cold-start) discoveries.
   */
  addFromDirectory(agents) {
    let added = 0;
    for (const agent of agents) {
      const nodeId = agent.node_id || agent.nodeId;
      if (!nodeId || nodeId === this.#selfNodeId) continue;
      if (this.#peers.has(nodeId)) continue;
      if (this.#peers.size >= MAX_PEERS) break;

      this.#peers.set(nodeId, {
        discoveredFrom: null,
        discoveredAt: new Date().toISOString(),
        topics: [],
        reportedFitness: 0,
        contacted: false,
        isDarwin: false,
        catalog: null,
      });
      added++;
    }
    if (added > 0) this.#save();
    return added;
  }

  /**
   * Add nodes discovered via peer_hints in darwin:deliver messages.
   * These are Level 1 (gossip) discoveries — no Hub dependency.
   */
  addFromHints(hints, recommenderNodeId) {
    let added = 0;
    for (const hint of hints) {
      const nodeId = hint.nodeId;
      if (!nodeId || nodeId === this.#selfNodeId) continue;
      if (this.#peers.size >= MAX_PEERS && !this.#peers.has(nodeId)) continue;

      if (this.#peers.has(nodeId)) {
        const existing = this.#peers.get(nodeId);
        if (hint.fitness > existing.reportedFitness) {
          existing.reportedFitness = hint.fitness;
        }
        if (hint.topics) {
          const merged = new Set([...existing.topics, ...hint.topics]);
          existing.topics = [...merged];
        }
      } else {
        this.#peers.set(nodeId, {
          discoveredFrom: recommenderNodeId,
          discoveredAt: new Date().toISOString(),
          topics: hint.topics || [],
          reportedFitness: hint.fitness || 0,
          contacted: false,
          isDarwin: true,
          catalog: null,
        });
        added++;
      }
    }
    if (added > 0) this.#save();
    return added;
  }

  markContacted(nodeId) {
    const peer = this.#peers.get(nodeId);
    if (peer) {
      peer.contacted = true;
      this.#save();
    }
  }

  markDarwin(nodeId, isDarwin = true) {
    const peer = this.#peers.get(nodeId);
    if (peer) {
      peer.isDarwin = isDarwin;
      this.#save();
    }
  }

  updateCatalog(nodeId, catalog) {
    const peer = this.#peers.get(nodeId);
    if (peer) {
      peer.catalog = catalog;
      if (catalog?.channels) {
        const topics = catalog.channels.map((c) => c.topic);
        peer.topics = [...new Set([...peer.topics, ...topics])];
      }
      this.#save();
    }
  }

  /**
   * Find candidate nodes for a given topic that haven't been subscribed to yet.
   * Sorted by reportedFitness descending.
   *
   * @param {string} topic
   * @param {number} limit
   * @param {Set<string>} subscribedNodeIds - Already-subscribed nodes to exclude
   */
  findCandidates(topic, limit = 5, subscribedNodeIds = new Set()) {
    const candidates = [];
    for (const [nodeId, info] of this.#peers) {
      if (subscribedNodeIds.has(nodeId)) continue;
      if (!info.isDarwin) continue;
      if (!info.contacted) continue;

      const topicMatch = info.topics.length === 0 ||
        info.topics.some((t) => t.toLowerCase() === topic.toLowerCase());
      if (!topicMatch) continue;

      candidates.push({ nodeId, ...info });
    }

    return candidates
      .sort((a, b) => b.reportedFitness - a.reportedFitness)
      .slice(0, limit);
  }

  /**
   * Get uncontacted Darwin nodes for outreach.
   */
  getUncontacted(limit = 10) {
    const result = [];
    for (const [nodeId, info] of this.#peers) {
      if (info.contacted) continue;
      result.push({ nodeId, ...info });
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Get all Darwin-confirmed nodes.
   */
  getDarwinNodes() {
    const result = [];
    for (const [nodeId, info] of this.#peers) {
      if (info.isDarwin) result.push({ nodeId, ...info });
    }
    return result;
  }

  getStats() {
    let darwinCount = 0;
    let contactedCount = 0;
    let fromGossip = 0;
    let fromDirectory = 0;

    for (const [, info] of this.#peers) {
      if (info.isDarwin) darwinCount++;
      if (info.contacted) contactedCount++;
      if (info.discoveredFrom) fromGossip++;
      else fromDirectory++;
    }

    return {
      totalPeers: this.#peers.size,
      darwinNodes: darwinCount,
      contacted: contactedCount,
      fromGossip,
      fromDirectory,
    };
  }

  remove(nodeId) {
    const deleted = this.#peers.delete(nodeId);
    if (deleted) this.#save();
    return deleted;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  #load() {
    if (!existsSync(this.#filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, "utf-8"));
      for (const [id, data] of Object.entries(raw)) {
        this.#peers.set(id, data);
      }
    } catch { /* start fresh */ }
  }

  #save() {
    const obj = {};
    for (const [id, data] of this.#peers) {
      obj[id] = data;
    }
    writeFileSync(this.#filePath, JSON.stringify(obj, null, 2));
  }
}
