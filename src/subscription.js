import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TrustPolicy } from "./trust-policy.js";
import { PeerGraph } from "./peer-graph.js";

const DARWIN_PREFIX = "darwin:";
const VERSION = "1.0.0";
const MAX_PEER_HINTS = 3;
const TRUST_DECAY = 0.98;
const TRUST_BOOST = 0.05;
const TRUST_PENALTY = 0.10;
const AUTO_UNSUB_THRESHOLD = 0.2;
const FULL_DELIVERY_TRUST = 0.8;
const FULL_DELIVERY_FEEDBACK = 0.8;
const STALE_SUBSCRIPTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_TOP_GENES = 10;
const DELIVER_DELAY_MID_MS = 60_000;   // 1 min
const DELIVER_DELAY_LOW_MS = 300_000;  // 5 min

/**
 * Decentralized subscription engine for Darwin.
 *
 * Replaces the broadcast-based PeerExchange with a topic-based, trust-driven
 * subscription model. All critical paths use only DM (Level 1 Hub dependency).
 * Gossip-based discovery reduces reliance on Hub directory over time.
 */
export class Subscription {
  #hub;
  #dataDir;
  #trustPolicy;
  #peerGraph;
  #subscriptions;  // Map<nodeId, SubscriptionEntry> — who I subscribe to
  #subscribers;    // Map<nodeId, SubscriberEntry>   — who subscribes to me
  #subscriptionsPath;
  #subscribersPath;
  #pendingDeliveries; // delayed deliveries: [{nodeId, payload, deliverAt}]

  constructor({ hub, dataDir = "./data", trustPolicy, peerGraph } = {}) {
    this.#hub = hub;
    this.#dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });

    this.#trustPolicy = trustPolicy || new TrustPolicy({ dataDir });
    this.#peerGraph = peerGraph || new PeerGraph({ dataDir, selfNodeId: hub?.nodeId });

    this.#subscriptionsPath = join(dataDir, "subscriptions.json");
    this.#subscribersPath = join(dataDir, "subscribers.json");
    this.#subscriptions = new Map();
    this.#subscribers = new Map();
    this.#pendingDeliveries = [];

    this.#loadSubscriptions();
    this.#loadSubscribers();
  }

  get policy() { return this.#trustPolicy; }
  get graph() { return this.#peerGraph; }
  get subscriptionCount() { return this.#subscriptions.size; }
  get subscriberCount() { return this.#subscribers.size; }

  getSubscriptions() {
    return [...this.#subscriptions.entries()].map(([id, s]) => ({ nodeId: id, ...s }));
  }

  getSubscribers() {
    return [...this.#subscribers.entries()].map(([id, s]) => ({ nodeId: id, ...s }));
  }

  // ── Public API: Manual subscription management ──────────────────────

  async subscribe(nodeId, topics = []) {
    if (this.#trustPolicy.isBlocked(nodeId)) return { ok: false, reason: "blocked" };
    if (!this.#trustPolicy.canSubscribe(this.#subscriptions.size)) {
      return { ok: false, reason: "max_subscriptions_reached" };
    }

    try {
      await this.#hub.sendDM(nodeId, {
        type: `${DARWIN_PREFIX}subscribe`,
        topics,
        from: this.#hub.nodeId,
        version: VERSION,
      });
    } catch (err) {
      return { ok: false, reason: err.message };
    }

    if (!this.#subscriptions.has(nodeId)) {
      this.#subscriptions.set(nodeId, {
        topics,
        subscribedAt: new Date().toISOString(),
        trust: 0.5,
        deliveriesReceived: 0,
        genesUseful: 0,
        lastDelivery: null,
      });
    } else {
      const existing = this.#subscriptions.get(nodeId);
      existing.topics = [...new Set([...existing.topics, ...topics])];
    }
    this.#saveSubscriptions();
    return { ok: true };
  }

  async unsubscribe(nodeId, topics = []) {
    try {
      await this.#hub.sendDM(nodeId, {
        type: `${DARWIN_PREFIX}unsubscribe`,
        topics,
        from: this.#hub.nodeId,
      });
    } catch { /* best effort */ }

    if (topics.length === 0) {
      this.#subscriptions.delete(nodeId);
    } else {
      const sub = this.#subscriptions.get(nodeId);
      if (sub) {
        sub.topics = sub.topics.filter((t) => !topics.includes(t));
        if (sub.topics.length === 0) this.#subscriptions.delete(nodeId);
      }
    }
    this.#saveSubscriptions();
    return { ok: true };
  }

  // ── Catalog: advertise what topics I'm good at ──────────────────────

  buildCatalog(darwin) {
    const store = darwin.store;
    const tracker = darwin.tracker;
    const channelMap = new Map();

    for (const entry of store.ranked(200)) {
      const triggers = entry.capsule?.trigger || entry.capsule?.signals_match || [];
      for (const topic of triggers) {
        if (!channelMap.has(topic)) {
          channelMap.set(topic, { topic, genes: 0, totalFitness: 0, samples: 0 });
        }
        const ch = channelMap.get(topic);
        ch.genes++;
        ch.totalFitness += entry.fitness ?? 0;
        ch.samples += tracker.getSampleCount(entry.assetId);
      }
    }

    const channels = [...channelMap.values()].map((ch) => ({
      topic: ch.topic,
      genes: ch.genes,
      avgFitness: ch.genes > 0 ? Math.round((ch.totalFitness / ch.genes) * 1000) / 1000 : 0,
      samples: ch.samples,
    }));

    channels.sort((a, b) => b.avgFitness - a.avgFitness);
    return { channels, subscriberCount: this.#subscribers.size };
  }

  // ── Incoming DM message handler ─────────────────────────────────────

  async handleIncoming(messages, darwin) {
    const actions = [];

    for (const msg of messages) {
      const payload = msg.payload || msg;
      if (!payload.type || !payload.type.startsWith(DARWIN_PREFIX)) continue;

      const type = payload.type.slice(DARWIN_PREFIX.length);
      const fromId = payload.from || msg.sender_id;

      if (this.#trustPolicy.isBlocked(fromId)) continue;

      switch (type) {
        case "hello":
          await this.#handleHello(fromId, payload, darwin);
          actions.push({ type: "hello_received", peerId: fromId });
          break;

        case "hello-ack":
          this.#handleHelloAck(fromId, payload);
          actions.push({ type: "hello_ack_received", peerId: fromId });
          break;

        case "catalog":
          this.#peerGraph.updateCatalog(fromId, payload);
          actions.push({ type: "catalog_received", peerId: fromId });
          break;

        case "subscribe":
          await this.#handleSubscribe(fromId, payload);
          actions.push({ type: "subscriber_added", peerId: fromId, topics: payload.topics });
          break;

        case "unsubscribe":
          this.#handleUnsubscribe(fromId, payload);
          actions.push({ type: "subscriber_removed", peerId: fromId });
          break;

        case "deliver":
        case "deliver-full":
          await this.#handleDelivery(fromId, payload, darwin);
          actions.push({ type: "delivery_received", peerId: fromId, topic: payload.topic });
          break;

        case "feedback":
          this.#handleFeedback(fromId, payload);
          actions.push({ type: "feedback_received", peerId: fromId, score: payload.score });
          break;

        case "gene-request":
          await this.#handleGeneRequest(fromId, payload, darwin);
          actions.push({ type: "gene_sent", peerId: fromId });
          break;

        case "gene-response":
          this.#handleGeneResponse(fromId, payload, darwin);
          actions.push({ type: "gene_received", peerId: fromId });
          break;
      }
    }

    return actions;
  }

  // ── Discovery (Level 2: Hub directory for cold start) ───────────────

  async discover() {
    let discovered = 0;
    try {
      const directory = await this.#hub.getDirectory();
      const agents = directory?.agents || directory || [];
      this.#peerGraph.addFromDirectory(agents);

      const uncontacted = this.#peerGraph.getUncontacted(5);
      for (const peer of uncontacted) {
        try {
          await this.#hub.sendDM(peer.nodeId, {
            type: `${DARWIN_PREFIX}hello`,
            version: VERSION,
            isDarwin: true,
            nodeId: this.#hub.nodeId,
          });
          this.#peerGraph.markContacted(peer.nodeId);
          discovered++;
        } catch { /* node may be offline */ }
      }
    } catch { /* directory unavailable */ }

    return discovered;
  }

  // ── Delivery to subscribers ─────────────────────────────────────────

  async deliverToSubscribers(darwin) {
    if (this.#subscribers.size === 0) return;

    const ranked = darwin.tracker.rankAll().slice(0, MAX_TOP_GENES);
    if (ranked.length === 0) return;

    const peerHints = this.#buildPeerHints();
    const now = Date.now();

    for (const [nodeId, sub] of this.#subscribers) {
      if (this.#trustPolicy.isBlocked(nodeId)) continue;

      const matchingGenes = this.#filterByTopics(ranked, sub.topics);
      if (matchingGenes.length === 0) continue;

      const isFullDelivery = sub.feedbackScore >= FULL_DELIVERY_FEEDBACK &&
        this.#getSubscriptionTrust(nodeId) >= FULL_DELIVERY_TRUST;

      const msgType = isFullDelivery ? "deliver-full" : "deliver";
      const payload = {
        type: `${DARWIN_PREFIX}${msgType}`,
        from: this.#hub.nodeId,
        peer_hints: peerHints,
      };

      if (isFullDelivery) {
        payload.genes = matchingGenes.map((g) => {
          const capsule = darwin.store.get(g.capsuleId);
          return capsule ? { asset_id: g.capsuleId, capsule, fitness: g.fitness } : null;
        }).filter(Boolean);
      } else {
        payload.digest = matchingGenes.map((g) => ({
          id: g.capsuleId,
          fitness: g.fitness,
          summary: darwin.store.get(g.capsuleId)?.summary?.slice(0, 120) || "",
        }));
      }

      const trust = this.#getSubscriptionTrust(nodeId);
      if (trust > 0.7) {
        this.#sendDelivery(nodeId, payload);
      } else if (trust > 0.4) {
        this.#pendingDeliveries.push({ nodeId, payload, deliverAt: now + DELIVER_DELAY_MID_MS });
      } else {
        this.#pendingDeliveries.push({ nodeId, payload, deliverAt: now + DELIVER_DELAY_LOW_MS });
      }

      sub.deliveriesSent = (sub.deliveriesSent || 0) + 1;
    }

    this.#saveSubscribers();
  }

  /**
   * Flush delayed deliveries whose time has come.
   */
  async flushPendingDeliveries() {
    const now = Date.now();
    const ready = this.#pendingDeliveries.filter((d) => d.deliverAt <= now);
    this.#pendingDeliveries = this.#pendingDeliveries.filter((d) => d.deliverAt > now);

    for (const { nodeId, payload } of ready) {
      await this.#sendDelivery(nodeId, payload);
    }
  }

  // ── Feedback: send quality report to publisher ──────────────────────

  async sendFeedback(nodeId, { useful, score, assetIds = [] }) {
    try {
      await this.#hub.sendDM(nodeId, {
        type: `${DARWIN_PREFIX}feedback`,
        from: this.#hub.nodeId,
        useful: !!useful,
        score: Math.max(0, Math.min(1, score)),
        assetIds,
      });
    } catch { /* best effort */ }
  }

  // ── Trust update (called after local A/B testing of a received gene)

  updateSubscriptionTrust(nodeId, fitness) {
    const sub = this.#subscriptions.get(nodeId);
    if (!sub) return;

    if (fitness > 0.5) {
      sub.trust = Math.min(1, sub.trust + TRUST_BOOST);
      sub.genesUseful++;
    } else if (fitness < 0.2) {
      sub.trust = Math.max(0, sub.trust - TRUST_PENALTY);
    }

    this.#saveSubscriptions();
  }

  // ── Auto-subscribe based on PeerGraph candidates ────────────────────

  async autoSubscribe(darwin) {
    if (!this.#trustPolicy.canSubscribe(this.#subscriptions.size)) return 0;

    const subscribedIds = new Set(this.#subscriptions.keys());
    const activeTopics = this.#getActiveTopics(darwin);
    let subscribed = 0;

    for (const topic of activeTopics) {
      if (!this.#trustPolicy.canSubscribe(this.#subscriptions.size)) break;

      const localBest = darwin.tracker.rank(topic)[0]?.fitness ?? 0;
      const candidates = this.#peerGraph.findCandidates(topic, 3, subscribedIds);

      for (const candidate of candidates) {
        if (!this.#trustPolicy.canSubscribe(this.#subscriptions.size)) break;
        if (candidate.reportedFitness <= localBest) continue;

        const catalog = candidate.catalog;
        const channelInfo = catalog?.channels?.find(
          (c) => c.topic.toLowerCase() === topic.toLowerCase(),
        );
        if (channelInfo && channelInfo.samples < 10) continue;

        const result = await this.subscribe(candidate.nodeId, [topic]);
        if (result.ok) {
          subscribedIds.add(candidate.nodeId);
          subscribed++;
        }
      }
    }

    return subscribed;
  }

  // ── Auto-unsubscribe stale or low-trust subscriptions ───────────────

  async autoUnsubscribe() {
    const now = Date.now();
    const toRemove = [];

    for (const [nodeId, sub] of this.#subscriptions) {
      if (sub.trust < AUTO_UNSUB_THRESHOLD) {
        toRemove.push({ nodeId, reason: "low_trust" });
        continue;
      }

      if (sub.lastDelivery) {
        const elapsed = now - new Date(sub.lastDelivery).getTime();
        if (elapsed > STALE_SUBSCRIPTION_MS) {
          toRemove.push({ nodeId, reason: "stale" });
          continue;
        }
      }

      if (sub.deliveriesReceived >= 5 && sub.genesUseful === 0) {
        toRemove.push({ nodeId, reason: "no_useful_genes" });
      }
    }

    for (const { nodeId } of toRemove) {
      await this.unsubscribe(nodeId, []);
    }

    return toRemove;
  }

  // ── Main cycle: called by Darwin.#doEvolveCycle() ───────────────────

  async cycle(darwin) {
    this.#peerGraph.setSelfNodeId(this.#hub.nodeId);

    // 1. Poll DM inbox for incoming messages
    try {
      const inbox = await this.#hub.pollDM();
      const messages = inbox?.messages || inbox || [];
      if (messages.length > 0) {
        await this.handleIncoming(messages, darwin);
      }
    } catch { /* DM poll failed */ }

    // 2. Flush pending delayed deliveries
    await this.flushPendingDeliveries();

    // 3. Discover new peers (10% probability)
    if (Math.random() < 0.1) {
      try { await this.discover(); } catch { /* discovery failed */ }
    }

    // 4. Deliver to subscribers
    try { await this.deliverToSubscribers(darwin); } catch { /* delivery failed */ }

    // 5. Auto-subscribe / auto-unsubscribe
    try { await this.autoSubscribe(darwin); } catch { /* auto-sub failed */ }
    try { await this.autoUnsubscribe(); } catch { /* auto-unsub failed */ }

    // 6. Trust decay on all subscriptions
    for (const [, sub] of this.#subscriptions) {
      sub.trust = Math.max(0, sub.trust * TRUST_DECAY);
    }
    this.#saveSubscriptions();
  }

  // ── Stats for dashboard / CLI ───────────────────────────────────────

  getStats() {
    const subs = this.getSubscriptions();
    const subscribers = this.getSubscribers();

    return {
      subscriptions: subs.length,
      subscribers: subscribers.length,
      avgTrust: subs.length > 0
        ? Math.round((subs.reduce((s, x) => s + x.trust, 0) / subs.length) * 1000) / 1000
        : 0,
      avgFeedbackScore: subscribers.length > 0
        ? Math.round((subscribers.reduce((s, x) => s + x.feedbackScore, 0) / subscribers.length) * 1000) / 1000
        : 0,
      peerGraph: this.#peerGraph.getStats(),
      policy: this.#trustPolicy.getStats(),
      pendingDeliveries: this.#pendingDeliveries.length,
    };
  }

  // ── Private: message handlers ───────────────────────────────────────

  async #handleHello(fromId, payload, darwin) {
    this.#peerGraph.markContacted(fromId);
    if (payload.isDarwin) {
      this.#peerGraph.markDarwin(fromId, true);
    }

    const catalog = this.buildCatalog(darwin);
    try {
      await this.#hub.sendDM(fromId, {
        type: `${DARWIN_PREFIX}hello-ack`,
        version: VERSION,
        isDarwin: true,
        nodeId: this.#hub.nodeId,
        catalog,
      });
    } catch { /* ignore */ }
  }

  #handleHelloAck(fromId, payload) {
    this.#peerGraph.markContacted(fromId);
    if (payload.isDarwin) {
      this.#peerGraph.markDarwin(fromId, true);
    }
    if (payload.catalog) {
      this.#peerGraph.updateCatalog(fromId, payload.catalog);
    }
  }

  async #handleSubscribe(fromId, payload) {
    const isMutual = this.#subscriptions.has(fromId);
    const shouldAccept = this.#trustPolicy.shouldAccept(fromId, {
      currentSubscribers: this.#subscribers.size,
      isMutual,
      reputation: null,
    });

    if (!shouldAccept) return;

    const topics = payload.topics || [];
    if (this.#subscribers.has(fromId)) {
      const existing = this.#subscribers.get(fromId);
      existing.topics = [...new Set([...existing.topics, ...topics])];
    } else {
      this.#subscribers.set(fromId, {
        topics,
        subscribedAt: new Date().toISOString(),
        feedbackScore: 0.5,
        deliveriesSent: 0,
      });
    }
    this.#saveSubscribers();
  }

  #handleUnsubscribe(fromId, payload) {
    const topics = payload.topics || [];
    if (topics.length === 0) {
      this.#subscribers.delete(fromId);
    } else {
      const sub = this.#subscribers.get(fromId);
      if (sub) {
        sub.topics = sub.topics.filter((t) => !topics.includes(t));
        if (sub.topics.length === 0) this.#subscribers.delete(fromId);
      }
    }
    this.#saveSubscribers();
  }

  async #handleDelivery(fromId, payload, darwin) {
    const sub = this.#subscriptions.get(fromId);
    if (!sub) return;

    sub.deliveriesReceived++;
    sub.lastDelivery = new Date().toISOString();

    // Process peer_hints for gossip discovery
    if (payload.peer_hints && Array.isArray(payload.peer_hints)) {
      this.#peerGraph.addFromHints(payload.peer_hints, fromId);
    }

    // Process full gene delivery
    if (payload.genes && Array.isArray(payload.genes)) {
      for (const gene of payload.genes) {
        if (gene.capsule && gene.asset_id && !darwin.store.has(gene.asset_id)) {
          darwin.store.add(gene.capsule, 0);
        }
      }
    }

    // Process digest — mark interesting genes for later fetching via gene-request
    if (payload.digest && Array.isArray(payload.digest)) {
      for (const item of payload.digest) {
        if (item.id && !darwin.store.has(item.id) && item.fitness > 0.5) {
          try {
            await this.#hub.sendDM(fromId, {
              type: `${DARWIN_PREFIX}gene-request`,
              asset_id: item.id,
              from: this.#hub.nodeId,
            });
          } catch { /* request failed */ }
        }
      }
    }

    this.#saveSubscriptions();
  }

  #handleFeedback(fromId, payload) {
    const sub = this.#subscribers.get(fromId);
    if (!sub) return;

    const score = typeof payload.score === "number" ? Math.max(0, Math.min(1, payload.score)) : 0.5;
    const alpha = 0.3;
    sub.feedbackScore = sub.feedbackScore * (1 - alpha) + score * alpha;
    this.#saveSubscribers();
  }

  async #handleGeneRequest(fromId, payload, darwin) {
    if (!payload.asset_id) return;
    const capsule = darwin.store.get(payload.asset_id);
    if (!capsule) return;

    try {
      await this.#hub.sendDM(fromId, {
        type: `${DARWIN_PREFIX}gene-response`,
        capsule,
        from: this.#hub.nodeId,
      });
    } catch { /* ignore */ }
  }

  #handleGeneResponse(fromId, payload, darwin) {
    if (payload.capsule && payload.capsule.asset_id) {
      darwin.store.add(payload.capsule, 0);
    }
  }

  // ── Private: helpers ────────────────────────────────────────────────

  async #sendDelivery(nodeId, payload) {
    try {
      await this.#hub.sendDM(nodeId, payload);
    } catch { /* delivery failed */ }
  }

  #buildPeerHints() {
    const darwinNodes = this.#peerGraph.getDarwinNodes();
    const trusted = darwinNodes
      .filter((n) => {
        const sub = this.#subscriptions.get(n.nodeId);
        return sub && sub.trust > 0.6;
      })
      .sort((a, b) => b.reportedFitness - a.reportedFitness)
      .slice(0, MAX_PEER_HINTS);

    return trusted.map((n) => ({
      nodeId: n.nodeId,
      topics: n.topics.slice(0, 5),
      fitness: n.reportedFitness,
    }));
  }

  #filterByTopics(rankedGenes, topics) {
    if (!topics || topics.length === 0) return rankedGenes;
    const topicSet = new Set(topics.map((t) => t.toLowerCase()));
    return rankedGenes.filter((g) => {
      return g.taskTypes?.some((t) => topicSet.has(t.toLowerCase()));
    });
  }

  #getSubscriptionTrust(nodeId) {
    const sub = this.#subscriptions.get(nodeId);
    return sub?.trust ?? 0.5;
  }

  #getActiveTopics(darwin) {
    const ranked = darwin.tracker.rankAll();
    const topics = new Set();
    for (const r of ranked) {
      if (r.taskTypes) r.taskTypes.forEach((t) => topics.add(t));
    }
    return [...topics];
  }

  // ── Persistence ─────────────────────────────────────────────────────

  #loadSubscriptions() {
    if (!existsSync(this.#subscriptionsPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#subscriptionsPath, "utf-8"));
      for (const [id, data] of Object.entries(raw)) {
        this.#subscriptions.set(id, data);
      }
    } catch { /* start fresh */ }
  }

  #saveSubscriptions() {
    const obj = {};
    for (const [id, data] of this.#subscriptions) obj[id] = data;
    writeFileSync(this.#subscriptionsPath, JSON.stringify(obj, null, 2));
  }

  #loadSubscribers() {
    if (!existsSync(this.#subscribersPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#subscribersPath, "utf-8"));
      for (const [id, data] of Object.entries(raw)) {
        this.#subscribers.set(id, data);
      }
    } catch { /* start fresh */ }
  }

  #saveSubscribers() {
    const obj = {};
    for (const [id, data] of this.#subscribers) obj[id] = data;
    writeFileSync(this.#subscribersPath, JSON.stringify(obj, null, 2));
  }
}
