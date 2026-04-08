/**
 * OpenClaw Gateway WebSocket client — 通过 Gateway RPC 调主 Agent（与插件内 subagent 不同，可在独立 node 进程使用）。
 * 来源参考: js-moltbook/src/openclaw-gateway.mjs
 *
 * 需要 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD；
 * 连接需 ~/.openclaw/identity/device.json（openclaw CLI 配对）。
 *
 * Node 18+：使用 `ws` 包；若全局已有 WebSocket（Node 22+）则优先。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createHash, randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 3;
const GATEWAY_CLIENT_ID = "cli";
const GATEWAY_CLIENT_MODE = "cli";
const GATEWAY_SCOPES = [
  "operator.admin", "operator.read", "operator.write",
  "operator.approvals", "operator.pairing",
];

export class OpenClawGatewayError extends Error {
  constructor(message, reasonKey = null) {
    super(message);
    this.name = "OpenClawGatewayError";
    this.message = message;
    this.reasonKey = reasonKey;
  }
}

export function resolveOpenclawStateDir() {
  const override = (process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || "").trim();
  if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return join(homedir(), ".openclaw");
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

async function loadWs() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  const { default: WS } = await import("ws");
  return WS;
}

function buildDeviceAuthPayload(deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce) {
  const scopeStr = scopes.join(",");
  return ["v2", deviceId, clientId, clientMode, role, scopeStr, String(signedAtMs), token || "", nonce].join("|");
}

async function signDevicePayload(privateKeyPem, payload) {
  const { createPrivateKey, sign } = await import("node:crypto");
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(payload, "utf-8"), key);
  return base64urlEncode(sig);
}

export function extractResponseFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const result = payload.result;
  if (!result || typeof result !== "object") return "";
  const payloads = result.payloads;
  if (!Array.isArray(payloads) || !payloads.length) return "";
  const first = payloads[0];
  if (!first || typeof first !== "object") return "";
  return (first.text || first.content || "").trim();
}

export function parseJsonFromText(text) {
  text = (text || "").trim();
  try { return JSON.parse(text); } catch { /* fall through */ }

  const jsonBlocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonBlocks[i][1].trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* continue */ }
  }

  const lastBrace = text.lastIndexOf("}");
  if (lastBrace !== -1) {
    let depth = 0;
    for (let i = lastBrace; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(i, lastBrace + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error(`无法从响应中提取 JSON。前 500 字符: ${text.slice(0, 500)}`);
}

export async function callAgent(message, {
  timeout = 240, agentId = "main", thinking = "low",
  sessionKey = null, model = null, extraSystemPrompt = null,
} = {}) {
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").trim();
  const wsUrl = gatewayUrl.replace("http://", "ws://").replace("https://", "wss://");
  const token = (process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  const password = (process.env.OPENCLAW_GATEWAY_PASSWORD || "").trim();

  if (!token && !password) {
    throw new OpenClawGatewayError(
      "未配置 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD",
      "exception",
    );
  }

  const WebSocketImpl = await loadWs();
  const useModelOverride = !!(model && model.trim());
  const _sessionKey = sessionKey || `gateway-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const idempotencyKey = randomUUID().replace(/-/g, "");
  const agentReqId = randomUUID().replace(/-/g, "");
  const patchReqId = useModelOverride ? randomUUID().replace(/-/g, "") : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectId = null;

    const ws = new WebSocketImpl(wsUrl);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new OpenClawGatewayError("Agent 调用超时", "timeout"));
      }
    }, (timeout + 60) * 1000);

    function finish(resultOrError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (resultOrError instanceof Error) reject(resultOrError);
      else resolve(resultOrError);
    }

    function sendAgentRequest() {
      const params = {
        message, agentId, sessionKey: _sessionKey,
        thinking, timeout, deliver: false, idempotencyKey,
      };
      if (extraSystemPrompt) params.extraSystemPrompt = extraSystemPrompt;
      ws.send(JSON.stringify({ type: "req", id: agentReqId, method: "agent", params }));
    }

    function runAgentAfterConnect() {
      if (useModelOverride && patchReqId) {
        ws.send(JSON.stringify({
          type: "req", id: patchReqId, method: "sessions.patch",
          params: { key: _sessionKey, model: model.trim() },
        }));
      } else {
        sendAgentRequest();
      }
    }

    const onErr = (evOrErr) => {
      const m = evOrErr?.message || (typeof evOrErr === "string" ? evOrErr : "") || "WebSocket error";
      finish(new OpenClawGatewayError(m, "exception"));
    };
    if (typeof ws.addEventListener === "function") ws.addEventListener("error", onErr);
    else ws.on("error", onErr);

    const onMsg = async (ev) => {
      const raw = ev?.data != null ? ev.data : ev;
      let msg;
      try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }

      if (msg.type === "event") {
        if (msg.event === "connect.challenge") {
          const nonce = (msg.payload || {}).nonce || "";
          if (!nonce) return finish(new OpenClawGatewayError("connect.challenge missing nonce"));

          let identity;
          try {
            const stateDir = resolveOpenclawStateDir();
            const path = join(stateDir, "identity", "device.json");
            if (!existsSync(path)) throw new Error(`未找到 device 身份文件: ${path}`);
            const data = JSON.parse(readFileSync(path, "utf-8"));
            if (!data || data.version !== 1) throw new Error("device.json 格式无效");
            const deviceId = data.deviceId || data.device_id;
            const publicKeyPem = data.publicKeyPem || data.public_key_pem;
            const privateKeyPem = data.privateKeyPem || data.private_key_pem;
            if (!deviceId || !publicKeyPem || !privateKeyPem) throw new Error("device.json 字段缺失");
            const { createPublicKey } = await import("node:crypto");
            const key = createPublicKey(publicKeyPem);
            const der = key.export({ type: "spki", format: "der" });
            const rawBytes = der.subarray(-32);
            const derivedId = createHash("sha256").update(rawBytes).digest("hex");
            if (derivedId !== deviceId) throw new Error("deviceId 与公钥不一致");
            identity = { deviceId, publicKeyRawBase64Url: base64urlEncode(rawBytes), privateKeyPem };
          } catch (e) {
            return finish(new OpenClawGatewayError(e.message, "exception"));
          }

          const signedAtMs = Date.now();
          const payloadStr = buildDeviceAuthPayload(
            identity.deviceId, GATEWAY_CLIENT_ID, GATEWAY_CLIENT_MODE,
            "operator", GATEWAY_SCOPES, signedAtMs, token || null, nonce,
          );

          let signature;
          try { signature = await signDevicePayload(identity.privateKeyPem, payloadStr); }
          catch (e) { return finish(new OpenClawGatewayError(`签名失败: ${e.message}`, "exception")); }

          connectId = randomUUID().replace(/-/g, "");
          const auth = {};
          if (token) auth.token = token;
          if (password) auth.password = password;

          ws.send(JSON.stringify({
            type: "req", id: connectId, method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
              client: { id: GATEWAY_CLIENT_ID, version: "dev", platform: platform(), mode: GATEWAY_CLIENT_MODE },
              auth, role: "operator", scopes: GATEWAY_SCOPES,
              device: {
                id: identity.deviceId, publicKey: identity.publicKeyRawBase64Url,
                signature, signedAt: signedAtMs, nonce,
              },
            },
          }));
        }
        return;
      }

      if (msg.type !== "res") return;
      const rid = msg.id;

      if (rid === connectId && msg.ok) {
        runAgentAfterConnect();
        return;
      }

      if (patchReqId && rid === patchReqId) {
        if (!msg.ok) {
          const err = msg.error || {};
          return finish(new OpenClawGatewayError(
            `sessions.patch failed: ${typeof err === "object" ? err.message || JSON.stringify(err) : err}`,
          ));
        }
        sendAgentRequest();
        return;
      }

      if (rid === agentReqId) {
        const payload = msg.payload || {};
        if (payload.status === "accepted") return;
        if (!msg.ok) {
          const err = msg.error || {};
          return finish(new OpenClawGatewayError(
            typeof err === "object" ? err.message || JSON.stringify(err) : String(err),
            "exception",
          ));
        }

        const responseText = extractResponseFromPayload(payload);
        if (!responseText) {
          const summary = payload.summary || "empty response";
          return finish(new OpenClawGatewayError(summary, "ai_error"));
        }
        finish(responseText);
      }
    };
    if (typeof ws.addEventListener === "function") ws.addEventListener("message", onMsg);
    else ws.on("message", onMsg);
  });
}

export async function callAgentJson(message, opts = {}) {
  const text = await callAgent(message, opts);
  return parseJsonFromText(text);
}
