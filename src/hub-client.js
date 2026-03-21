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

  // ── A2A Protocol Messages ─────────────────────────────────────────────

  async hello() {
    const env = getEnvFingerprint();
    const body = this.#envelope("hello", {
      capabilities: {},
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
      heartbeatIntervalMs: p.heartbeat_interval_ms || 900000,
    };
  }

  async heartbeat() {
    const body = { node_id: this.#nodeId };
    const res = await this.#fetch("/a2a/heartbeat", body);
    return {
      status: res.status,
      creditBalance: res.credit_balance,
      availableWork: res.available_work || [],
      nextHeartbeatMs: res.next_heartbeat_ms || 900000,
      pendingEvents: res.pending_events || [],
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
    return this.#fetch("/a2a/fetch", body);
  }

  async publish(assets) {
    const body = this.#envelope("publish", { assets });
    return this.#fetch("/a2a/publish", body);
  }

  async validate(assets) {
    const body = this.#envelope("publish", { assets });
    return this.#fetch("/a2a/validate", body);
  }

  async report(targetAssetId, validationReport) {
    const body = this.#envelope("report", {
      target_asset_id: targetAssetId,
      validation_report: validationReport,
    });
    return this.#fetch("/a2a/report", body);
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
}
