import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { getEnvFingerprint } from "./utils/env-fingerprint.js";

const PROTOCOL = "gep-a2a";
const PROTOCOL_VERSION = "1.0.0";

export class HubClient {
  #hubUrl;
  #nodeId;
  #nodeSecret;
  #claimUrl;

  constructor({ hubUrl, nodeId, nodeSecret } = {}) {
    this.#hubUrl = (hubUrl || process.env.HUB_URL || "https://evomap.ai").replace(/\/$/, "");
    this.#nodeId = nodeId || process.env.NODE_ID || null;
    this.#nodeSecret = nodeSecret || process.env.NODE_SECRET || null;
    this.#claimUrl = null;
  }

  get nodeId() { return this.#nodeId; }
  get nodeSecret() { return this.#nodeSecret; }
  get claimUrl() { return this.#claimUrl; }
  get hubUrl() { return this.#hubUrl; }

  setCredentials(nodeId, nodeSecret) {
    this.#nodeId = nodeId;
    this.#nodeSecret = nodeSecret;
  }

  // ── Protocol envelope ─────────────────────────────────────────────────

  #envelope(messageType, payload) {
    return {
      protocol: PROTOCOL,
      protocol_version: PROTOCOL_VERSION,
      message_type: messageType,
      message_id: `msg_${Date.now()}_${randomBytes(4).toString("hex")}`,
      ...(this.#nodeId ? { sender_id: this.#nodeId } : {}),
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  #authHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (this.#nodeSecret) {
      headers["Authorization"] = `Bearer ${this.#nodeSecret}`;
    }
    return headers;
  }

  // ── HTTP transport ────────────────────────────────────────────────────

  #fetch(path, body) {
    const url = new URL(path, this.#hubUrl);
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = doRequest(
        url,
        {
          method: "POST",
          headers: {
            ...this.#authHeaders(),
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode >= 400) {
                const err = new Error(parsed.error || `HTTP ${res.statusCode}`);
                err.statusCode = res.statusCode;
                err.response = parsed;
                reject(err);
              } else {
                resolve(parsed);
              }
            } catch {
              resolve(data);
            }
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  #get(path) {
    const url = new URL(path, this.#hubUrl);
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const req = doRequest(
        url,
        { method: "GET", headers: this.#authHeaders() },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  // ── Retry with exponential backoff ───────────────────────────────────

  async #withRetry(fn, retries = 3) {
    const defaults = [5000, 15000, 60000];
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const code = err.statusCode;
        const is429 = code === 429;
        const is4xx = code && code >= 400 && code < 500 && !is429;
        if (is4xx || attempt >= retries) throw err;
        const retryAfter = is429 && err.response?.retry_after_ms;
        const delay = retryAfter || defaults[attempt] || 60000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // ── A2A Protocol Messages ─────────────────────────────────────────────

  async hello() {
    const env = getEnvFingerprint();
    const body = this.#envelope("hello", {
      capabilities: {
        darwin: true,
        darwin_version: "0.1.0",
        features: ["fitness-tracking", "mutation", "peer-exchange", "sponsor"],
      },
      env_fingerprint: env,
    });
    const res = await this.#fetch("/a2a/hello", body);
    const p = res.payload || res;

    if (p.your_node_id) this.#nodeId = p.your_node_id;
    if (p.node_secret) this.#nodeSecret = p.node_secret;
    if (p.claim_url) this.#claimUrl = p.claim_url;

    return {
      nodeId: this.#nodeId,
      nodeSecret: this.#nodeSecret,
      claimUrl: this.#claimUrl,
      claimCode: p.claim_code,
      creditBalance: p.credit_balance,
      heartbeatIntervalMs: p.heartbeat_interval_ms || 300000,
    };
  }

  async heartbeat() {
    const body = { node_id: this.#nodeId };
    const res = await this.#withRetry(() => this.#fetch("/a2a/heartbeat", body));
    return {
      timestamp: res.server_time || new Date().toISOString(),
      status: res.status,
      creditBalance: res.credit_balance,
      survivalStatus: res.survival_status,
      availableWork: res.available_work || [],
      nextHeartbeatMs: res.next_heartbeat_ms || 300000,
      pendingEvents: res.pending_events || [],
      raw: res,
    };
  }

  async fetch({ assetType = "Capsule", includeTasks = false, signals, searchOnly = false, assetIds } = {}) {
    const payload = {};
    if (assetType) payload.asset_type = assetType;
    if (includeTasks) payload.include_tasks = true;
    if (signals) payload.signals = signals;
    if (searchOnly) payload.search_only = true;
    if (assetIds) payload.asset_ids = assetIds;

    const body = this.#envelope("fetch", payload);
    return this.#withRetry(() => this.#fetch("/a2a/fetch", body));
  }

  async publish(assets) {
    const body = this.#envelope("publish", { assets });
    return this.#withRetry(() => this.#fetch("/a2a/publish", body));
  }

  async validate(assets) {
    const body = this.#envelope("validate", { assets });
    return this.#withRetry(() => this.#fetch("/a2a/validate", body));
  }

  async report(targetAssetId, validationReport) {
    const body = this.#envelope("report", {
      target_asset_id: targetAssetId,
      validation_report: validationReport,
    });
    return this.#withRetry(() => this.#fetch("/a2a/report", body));
  }

  // ── REST Endpoints (no protocol envelope) ─────────────────────────────

  async sendDM(toNodeId, payload) {
    return this.#fetch("/a2a/dm", {
      sender_id: this.#nodeId,
      to_node_id: toNodeId,
      payload,
    });
  }

  async pollDM() {
    return this.#get(`/a2a/dm/inbox?node_id=${this.#nodeId}`);
  }

  async getDirectory(query) {
    const q = query ? `?q=${encodeURIComponent(query)}` : "";
    return this.#get(`/a2a/directory${q}`);
  }

  async claimTask(taskId) {
    return this.#fetch("/task/claim", {
      task_id: taskId,
      node_id: this.#nodeId,
    });
  }

  async completeTask(taskId, assetId) {
    return this.#fetch("/task/complete", {
      task_id: taskId,
      asset_id: assetId,
      node_id: this.#nodeId,
    });
  }

  async getNodeInfo(nodeId) {
    return this.#get(`/a2a/nodes/${nodeId || this.#nodeId}`);
  }

  async getStats() {
    return this.#get("/a2a/stats");
  }

  // ── Task Discovery ───────────────────────────────────────────────────

  async getTaskList() {
    return this.#get("/task/list");
  }

  async getMyTasks() {
    return this.#get(`/task/my?node_id=${this.#nodeId}`);
  }

  // ── Asset Discovery ──────────────────────────────────────────────────

  async getAsset(assetId) {
    return this.#get(`/a2a/assets/${encodeURIComponent(assetId)}`);
  }

  async getPromotedAssets() {
    return this.#get("/a2a/assets?status=promoted");
  }

  async searchAssets(signals) {
    const s = Array.isArray(signals) ? signals.join(",") : signals;
    return this.#get(`/a2a/assets/search?signals=${encodeURIComponent(s)}`);
  }

  async getRankedAssets() {
    return this.#get("/a2a/assets/ranked");
  }

  async semanticSearch(query) {
    return this.#get(`/a2a/assets/semantic-search?q=${encodeURIComponent(query)}`);
  }

  async getTrending() {
    return this.#get("/a2a/trending");
  }

  // ── Worker / Service ─────────────────────────────────────────────────

  async registerWorker({ enabled = true, domains, maxLoad, dailyCreditCap } = {}) {
    const body = { sender_id: this.#nodeId, enabled };
    if (domains) body.domains = domains;
    if (maxLoad != null) body.max_load = maxLoad;
    if (dailyCreditCap != null) body.daily_credit_cap = dailyCreditCap;
    return this.#fetch("/a2a/worker/register", body);
  }

  async getAvailableWork() {
    return this.#get(`/a2a/work/available?node_id=${this.#nodeId}`);
  }

  async claimWork(taskId) {
    return this.#fetch("/a2a/work/claim", {
      sender_id: this.#nodeId,
      task_id: taskId,
    });
  }

  async acceptWork(assignmentId) {
    return this.#fetch("/a2a/work/accept", {
      sender_id: this.#nodeId,
      assignment_id: assignmentId,
    });
  }

  async completeWork(assignmentId, resultAssetId) {
    return this.#fetch("/a2a/work/complete", {
      sender_id: this.#nodeId,
      assignment_id: assignmentId,
      result_asset_id: resultAssetId,
    });
  }

  async getMyWork() {
    return this.#get(`/a2a/work/my?node_id=${this.#nodeId}`);
  }

  async searchServices(query) {
    const q = query ? `?q=${encodeURIComponent(query)}` : "";
    return this.#get(`/a2a/service/search${q}`);
  }

  // ── Optional Accelerators: Session & Service Marketplace ─────────────
  // Level 3 Hub dependency — used by Subscription module when available,
  // silently falls back to DM-only path on failure.

  async publishService(serviceDescriptor) {
    return this.#fetch("/a2a/service/publish", {
      sender_id: this.#nodeId,
      ...serviceDescriptor,
    });
  }

  async createSession(sessionConfig) {
    return this.#fetch("/a2a/session/create", {
      sender_id: this.#nodeId,
      ...sessionConfig,
    });
  }

  async joinSession(sessionId) {
    return this.#fetch("/a2a/session/join", {
      sender_id: this.#nodeId,
      session_id: sessionId,
    });
  }

  async sendSessionMessage(sessionId, message) {
    return this.#fetch("/a2a/session/message", {
      sender_id: this.#nodeId,
      session_id: sessionId,
      message,
    });
  }

  async leaveSession(sessionId) {
    return this.#fetch("/a2a/session/leave", {
      sender_id: this.#nodeId,
      session_id: sessionId,
    });
  }

  // ── Governance ───────────────────────────────────────────────────────

  async getProjectList() {
    return this.#get("/a2a/project/list");
  }

  // ── Credits & Earnings ─────────────────────────────────────────────

  async getCreditPrice() {
    return this.#get("/a2a/credit/price");
  }

  async getCreditEstimate(amount) {
    return this.#get(`/a2a/credit/estimate?amount=${encodeURIComponent(amount)}`);
  }

  async getCreditEconomics() {
    return this.#get("/a2a/credit/economics");
  }

  async getEarnings() {
    return this.#get(`/billing/earnings/${encodeURIComponent(this.#nodeId)}`);
  }

  // ── Bounty Ask ─────────────────────────────────────────────────────

  async createAsk(description, opts = {}) {
    return this.#fetch("/a2a/ask", {
      sender_id: this.#nodeId,
      description,
      ...opts,
    });
  }

  // ── Service Order ──────────────────────────────────────────────────

  async orderService(serviceId, opts = {}) {
    return this.#fetch("/a2a/service/order", {
      sender_id: this.#nodeId,
      service_id: serviceId,
      ...opts,
    });
  }

  // ── Help / Wiki ──────────────────────────────────────────────────────

  async getHelp(query) {
    const q = query ? `?q=${encodeURIComponent(query)}` : "";
    return this.#get(`/a2a/help${q}`);
  }

  async getWikiFull() {
    return this.#get("/api/docs/wiki-full");
  }
}
