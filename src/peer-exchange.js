import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DARWIN_MSG_PREFIX = "darwin:";
const MAX_TOP_GENES = 10;
const TRUST_DECAY = 0.95;

/**
 * P2P gene exchange over EvoMap DM channel.
 * Discovers other darwin-enabled agents, shares fitness rankings,
 * requests high-fitness genes, and tracks per-peer trust scores.
 */
export class PeerExchange {
  #hub;
  #dataDir;
  #peers; // Map<nodeId, { lastSeen, trust, sentGenes, receivedGenes }>
  #peersPath;

  constructor({ hub, dataDir = "./data" } = {}) {
    this.#hub = hub;
    this.#dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.#peersPath = join(dataDir, "peers.json");
    this.#peers = new Map();
    this.#load();
  }

  get peerCount() { return this.#peers.size; }

  getPeers() {
    return [...this.#peers.entries()].map(([id, p]) => ({
      nodeId: id,
      ...p,
    }));
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  /**
   * Discover darwin-enabled agents by querying the Hub directory
   * and sending darwin-hello DMs to all online agents.
   */
  async discover() {
    const directory = await this.#hub.getDirectory();
    const agents = directory?.agents || directory || [];

    let discovered = 0;
    for (const agent of agents) {
      const peerId = agent.node_id || agent.nodeId;
      if (!peerId || peerId === this.#hub.nodeId) continue;

      try {
        await this.#hub.sendDM(peerId, {
          type: `${DARWIN_MSG_PREFIX}hello`,
          version: "0.1.0",
          nodeId: this.#hub.nodeId,
        });
        discovered++;
      } catch {
        // agent may be offline
      }
    }

    return { discovered, totalAgents: agents.length };
  }

  // ── Broadcasting ──────────────────────────────────────────────────────

  /**
   * Broadcast our top fitness rankings to all known peers.
   */
  async broadcastFitness(darwin) {
    const ranked = darwin.tracker.rankAll().slice(0, MAX_TOP_GENES);
    if (ranked.length === 0) return;

    const report = ranked.map((r) => ({
      asset_id: r.capsuleId,
      fitness: r.fitness,
      samples: r.samples,
      task_types: r.taskTypes,
    }));

    let sent = 0;
    for (const [peerId] of this.#peers) {
      try {
        await this.#hub.sendDM(peerId, {
          type: `${DARWIN_MSG_PREFIX}fitness-report`,
          top: report,
          from: this.#hub.nodeId,
        });
        const peer = this.#peers.get(peerId);
        peer.sentGenes += report.length;
        sent++;
      } catch {
        // peer may be offline
      }
    }
    this.#save();
    return { sent, genes: report.length };
  }

  /**
   * Request a specific gene from a peer.
   */
  async requestGene(peerId, assetId) {
    return this.#hub.sendDM(peerId, {
      type: `${DARWIN_MSG_PREFIX}gene-request`,
      asset_id: assetId,
      from: this.#hub.nodeId,
    });
  }

  // ── Incoming message handler ──────────────────────────────────────────

  /**
   * Process incoming DM messages. Call this with messages from pollDM().
   * Returns actions taken.
   */
  async handleIncoming(messages, darwin) {
    const actions = [];

    for (const msg of messages) {
      const payload = msg.payload || msg;
      if (!payload.type || !payload.type.startsWith(DARWIN_MSG_PREFIX)) continue;

      const type = payload.type.slice(DARWIN_MSG_PREFIX.length);
      const fromId = payload.from || msg.sender_id;

      switch (type) {
        case "hello":
          this.#addPeer(fromId);
          // Reply with our own hello
          try {
            await this.#hub.sendDM(fromId, {
              type: `${DARWIN_MSG_PREFIX}hello-ack`,
              version: "0.1.0",
              nodeId: this.#hub.nodeId,
            });
          } catch { /* ignore */ }
          actions.push({ type: "peer_added", peerId: fromId });
          break;

        case "hello-ack":
          this.#addPeer(fromId);
          actions.push({ type: "peer_confirmed", peerId: fromId });
          break;

        case "fitness-report":
          this.#addPeer(fromId);
          if (payload.top && Array.isArray(payload.top)) {
            for (const gene of payload.top) {
              // If we don't have this gene and peer reports high fitness, fetch it
              if (!darwin.store.has(gene.asset_id) && gene.fitness > 0.5 && gene.samples >= 5) {
                try {
                  const res = await darwin.hub.fetch({ assetIds: [gene.asset_id] });
                  const assets = res?.payload?.assets || res?.assets || [];
                  for (const asset of assets) {
                    if (asset.asset_id === gene.asset_id) {
                      darwin.store.add(asset, 0, "peer");
                    }
                  }
                } catch { /* fetch failed */ }
              }
            }
            const peer = this.#peers.get(fromId);
            if (peer) peer.receivedGenes += payload.top.length;
            actions.push({ type: "fitness_received", peerId: fromId, count: payload.top.length });
          }
          break;

        case "gene-request":
          if (payload.asset_id) {
            const capsule = darwin.store.get(payload.asset_id);
            if (capsule) {
              try {
                await this.#hub.sendDM(fromId, {
                  type: `${DARWIN_MSG_PREFIX}gene-response`,
                  capsule,
                  from: this.#hub.nodeId,
                });
              } catch { /* ignore */ }
              actions.push({ type: "gene_sent", peerId: fromId, assetId: payload.asset_id });
            }
          }
          break;

        case "gene-response":
          if (payload.capsule && payload.capsule.asset_id) {
            darwin.store.add(payload.capsule, 0, "peer");
            actions.push({ type: "gene_received", peerId: fromId, assetId: payload.capsule.asset_id });
          }
          break;
      }
    }

    this.#save();
    return actions;
  }

  /**
   * Run one peer-exchange cycle on the darwin instance.
   */
  async cycle(darwin) {
    // 1. Check DM inbox for incoming messages
    try {
      const inbox = await this.#hub.pollDM();
      const messages = inbox?.messages || inbox || [];
      if (messages.length > 0) {
        await this.handleIncoming(messages, darwin);
      }
    } catch { /* DM poll failed */ }

    // 2. Periodically discover new peers (every ~10 cycles)
    if (Math.random() < 0.1) {
      try {
        await this.discover();
      } catch { /* discovery failed */ }
    }

    // 3. Broadcast fitness to peers
    if (this.#peers.size > 0) {
      try {
        await this.broadcastFitness(darwin);
      } catch { /* broadcast failed */ }
    }

    // 4. Decay trust scores
    for (const [, peer] of this.#peers) {
      peer.trust *= TRUST_DECAY;
    }
    this.#save();
  }

  /**
   * Update trust for a peer based on the quality of their recommendations.
   * Called when a gene received from this peer is locally tested.
   */
  updateTrust(peerId, fitnessResult) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    // Positive fitness increases trust, negative decreases
    peer.trust = Math.max(0, Math.min(1, peer.trust + (fitnessResult > 0.5 ? 0.1 : -0.05)));
    this.#save();
  }

  // ── Private ───────────────────────────────────────────────────────────

  #addPeer(nodeId) {
    if (!nodeId || nodeId === this.#hub.nodeId) return;
    if (!this.#peers.has(nodeId)) {
      this.#peers.set(nodeId, {
        lastSeen: new Date().toISOString(),
        trust: 0.5,
        sentGenes: 0,
        receivedGenes: 0,
      });
    } else {
      this.#peers.get(nodeId).lastSeen = new Date().toISOString();
    }
  }

  #load() {
    if (!existsSync(this.#peersPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#peersPath, "utf-8"));
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
    writeFileSync(this.#peersPath, JSON.stringify(obj, null, 2));
  }
}
