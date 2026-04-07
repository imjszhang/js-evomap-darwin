import nodePath from "node:path";
import nodeFs from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { buildEarningsApiPayload } from "../src/earnings-api.js";
import { computeAssetId } from "../src/utils/hash.js";

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = nodePath.resolve(__dirname, "..");
const DASHBOARD_DIR = nodePath.join(PROJECT_ROOT, "dashboard");
const ROUTE_PREFIX = "/plugins/js-evomap-darwin";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function resolveGenePoolAssetId(store, raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (store.has(t)) return t;
  if (!t.startsWith("sha256:") && /^[a-f0-9]{64}$/i.test(t)) {
    const lower = `sha256:${t.toLowerCase()}`;
    if (store.has(lower)) return lower;
  }
  return null;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function serveStaticFile(res, filePath) {
  const ext = nodePath.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const stream = nodeFs.createReadStream(filePath);
  stream.on("error", () => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  res.writeHead(200, { "Content-Type": mime });
  stream.pipe(res);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function jsonResult(data) {
  return textResult(JSON.stringify(data, null, 2));
}

const HEARTBEAT_STATE_FILE = "heartbeat-state.json";
const HEARTBEAT_HISTORY_MAX = 288;

async function loadHeartbeatState(dataDir) {
  try {
    const raw = await readFile(nodePath.join(dataDir, HEARTBEAT_STATE_FILE), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastHeartbeat: null, history: [], nodeId: null, updatedAt: null };
  }
}

async function saveHeartbeatState(dataDir, heartbeatResult, nodeId) {
  await mkdir(dataDir, { recursive: true });
  const statePath = nodePath.join(dataDir, HEARTBEAT_STATE_FILE);

  const existing = await loadHeartbeatState(dataDir);
  let history = existing.history || [];

  const snapshot = {
    timestamp: new Date().toISOString(),
    status: heartbeatResult.status,
    survivalStatus: heartbeatResult.survivalStatus,
    creditBalance: heartbeatResult.creditBalance,
    availableWork: heartbeatResult.availableWork,
    nextHeartbeatMs: heartbeatResult.nextHeartbeatMs,
    pendingEvents: heartbeatResult.pendingEvents,
    raw: heartbeatResult.raw,
  };

  const historyEntry = { ...snapshot };
  delete historyEntry.raw;
  history.push(historyEntry);
  if (history.length > HEARTBEAT_HISTORY_MAX) {
    history = history.slice(-HEARTBEAT_HISTORY_MAX);
  }

  const state = {
    lastHeartbeat: snapshot,
    history,
    nodeId: nodeId || existing.nodeId,
    updatedAt: snapshot.timestamp,
  };

  await writeFile(statePath, JSON.stringify(state, null, 2));
  return state;
}

let darwinInstance = null;
let pluginRuntime = null;

const EVENT_BUFFER_MAX = 100;
const eventBuffer = [];
let eventIdCounter = 0;
let eventLogDir = null;
let pluginInitTimestamp = null;
let heartbeatServiceRunning = false;

function persistEvent(evt) {
  if (!eventLogDir) return;
  try {
    const dateStr = evt.timestamp.slice(0, 10);
    const logPath = nodePath.join(eventLogDir, `darwin-events-${dateStr}.jsonl`);
    appendFileSync(logPath, JSON.stringify(evt) + "\n");
  } catch { /* write failure must not block main flow */ }
}

function pushEvent(type, message) {
  eventIdCounter++;
  const evt = { id: eventIdCounter, type, message, timestamp: new Date().toISOString() };
  eventBuffer.push(evt);
  if (eventBuffer.length > EVENT_BUFFER_MAX) {
    eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);
  }
  broadcastSSE("event", evt);
  persistEvent(evt);
}

// ── SSE (Server-Sent Events) infrastructure ─────────────────────────────

const sseClients = new Set();
const SSE_KEEPALIVE_MS = 25_000;

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* dead connection */ }
}

function broadcastSSE(event, data) {
  for (const res of sseClients) sendSSE(res, event, data);
}

function slimHeartbeatForInit(hb) {
  if (!hb) return null;
  const raw = hb.raw || {};
  return {
    timestamp: hb.timestamp,
    status: hb.status,
    survivalStatus: hb.survivalStatus,
    creditBalance: hb.creditBalance,
    availableWork: (hb.availableWork || []).slice(0, 80),
    nextHeartbeatMs: hb.nextHeartbeatMs,
    pendingEvents: hb.pendingEvents,
    raw: {
      node_status: raw.node_status,
      survival_status: raw.survival_status,
      credit_balance: raw.credit_balance,
      next_heartbeat_ms: raw.next_heartbeat_ms,
      available_tasks: (raw.available_tasks || []).slice(0, 80),
      topic_climate: raw.topic_climate,
    },
  };
}

async function buildFullSnapshot(darwin) {
  const status = darwin.getStatus();
  const slimStatus = {
    ...status,
    heartbeat: slimHeartbeatForInit(status.heartbeat),
  };

  let published = null;
  try {
    const { getAllMetaGenes } = await import(
      pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "meta-genes.js")).href
    );
    const hubBase = darwin.hub.hubUrl || "https://evomap.ai";
    published = await Promise.all(
      getAllMetaGenes().map(async ({ name, bundle }) => {
        const [gene, capsule, event] = bundle;
        const entry = {
          name,
          gene: { assetId: gene.asset_id, summary: gene.summary },
          capsule: { assetId: capsule.asset_id, summary: capsule.summary },
          event: { assetId: event.asset_id },
          hubStatus: "unknown",
          hubUrl: `${hubBase}/a2a/assets/${encodeURIComponent(capsule.asset_id)}`,
        };
        try {
          const info = await darwin.hub.getAsset(capsule.asset_id);
          const st = info?.status ?? info?.payload?.status;
          entry.hubStatus = typeof st === "string" && st.length > 0 ? st : "unknown";
        } catch { /* Hub unreachable or asset missing */ }
        return entry;
      }),
    );
  } catch { /* best-effort */ }

  return {
    status: slimStatus,
    genes: darwin.store.ranked(15).map((g) => ({
      assetId: g.assetId, fitness: g.fitness, source: g.source || "hub",
      summary: g.capsule?.summary, triggers: g.capsule?.trigger, capsule: g.capsule,
    })),
    tasks: await buildTasksApiPayload(darwin),
    peers: darwin.subscription
      ? (() => {
          const graph = darwin.subscription.graph;
          const nodes = graph.getDarwinNodes();
          const subs = new Set(darwin.subscription.getSubscriptions().map((s) => s.nodeId));
          const subscribers = new Set(darwin.subscription.getSubscribers().map((s) => s.nodeId));
          return nodes.map((p) => ({
            nodeId: p.nodeId, trust: p.trust ?? 0,
            isSubscription: subs.has(p.nodeId), isSubscriber: subscribers.has(p.nodeId),
          }));
        })()
      : [],
    leaderboard: status.leaderboard || [],
    revolution: darwin.getRevolutionStatus?.() ?? null,
    sponsor: status.sponsor,
    worker: status.worker,
    published,
    events: eventBuffer.slice(-30),
  };
}

/** Dashboard /api/tasks + SSE: local worker queue plus Hub GET /task/my (bounty tasks). */
async function buildTasksApiPayload(darwin) {
  darwin.worker?.reload?.();
  const stats = darwin.worker?.getStats();
  let hubMyTasks = [];
  if (darwin.hub?.nodeId) {
    try {
      const res = await darwin.hub.getMyTasks();
      const arr = res?.tasks ?? res?.payload?.tasks ?? (Array.isArray(res) ? res : []);
      if (Array.isArray(arr)) hubMyTasks = arr;
    } catch {
      /* Hub unreachable or node not registered */
    }
  }
  return {
    activeTasks: stats?.activeTasks ?? [],
    completedHistory: stats?.completedHistory ?? [],
    lastScanResults: stats?.lastScanResults ?? [],
    counters: stats?.counters ?? {},
    hubMyTasks,
  };
}

let sseKeepaliveTimer = null;
let sseStatusBroadcastTimer = null;
const SSE_STATUS_BROADCAST_MS = 5_000;

function startSSEKeepalive() {
  if (sseKeepaliveTimer) return;
  sseKeepaliveTimer = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(":keepalive\n\n"); } catch { sseClients.delete(res); }
    }
  }, SSE_KEEPALIVE_MS);
}

function startSSEStatusBroadcast(pluginCfg) {
  if (sseStatusBroadcastTimer) return;
  sseStatusBroadcastTimer = setInterval(async () => {
    if (sseClients.size === 0) return;
    try {
      const darwin = await getDarwin(pluginCfg);
      broadcastDarwinStatus(darwin);
    } catch { /* darwin not ready yet */ }
  }, SSE_STATUS_BROADCAST_MS);
}

function stopSSEStatusBroadcast() {
  if (sseStatusBroadcastTimer) {
    clearInterval(sseStatusBroadcastTimer);
    sseStatusBroadcastTimer = null;
  }
}

function broadcastDarwinStatus(darwin) {
  broadcastSSE("status", darwin.getStatus());
}

function broadcastDarwinGenes(darwin) {
  broadcastSSE("genes", darwin.store.ranked(15).map((g) => ({
    assetId: g.assetId, fitness: g.fitness, source: g.source || "hub",
    summary: g.capsule?.summary, triggers: g.capsule?.trigger, capsule: g.capsule,
  })));
}

const AGENT_GENERATE_TIMEOUT_MS = 90_000;

function buildCapsulePrompt(task) {
  const title = (task.title || "").slice(0, 200);
  const signals = (task.signals || "").split(",").map((s) => s.trim()).filter(Boolean);
  const bounty = task.bounty_amount ?? "unknown";

  return `You are an EvoMap protocol expert. Generate a high-quality Capsule asset for the following task.

Task title: ${title}
Task signals: ${signals.join(", ")}
Bounty: ${bounty}

Requirements:
1. The Capsule must contain a genuine, substantive solution — not generic placeholder text.
2. The "content" field must be a detailed, actionable approach to the task (at least 200 characters).
3. The "strategy" field must be an array of 3-7 concrete step descriptions.
4. The "trigger" field must contain normalized, lowercase, deduplicated signal keywords.
5. Follow the EvoMap Capsule schema exactly.

Return ONLY a JSON code block with the Capsule object. No other text before or after.

\`\`\`json
{
  "type": "Capsule",
  "schema_version": "1.5.0",
  "trigger": ["signal1", "signal2"],
  "summary": "Concise summary of the solution approach",
  "content": "Detailed multi-paragraph solution text...",
  "strategy": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ],
  "confidence": 0.75,
  "blast_radius": { "files": 1, "lines": 30 },
  "outcome": { "status": "success", "score": 0.75 },
  "env_fingerprint": { "platform": "any", "arch": "any" }
}
\`\`\`

Generate the Capsule now for the task above. The content must directly address "${title}".`;
}

function parseCapsuleFromReply(text) {
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
  try {
    const obj = JSON.parse(raw);
    if (obj.type !== "Capsule" || !obj.trigger || !obj.content) return null;
    if (!Array.isArray(obj.trigger)) obj.trigger = [String(obj.trigger)];
    obj.trigger = [...new Set(obj.trigger.map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (!obj.schema_version) obj.schema_version = "1.5.0";
    if (!obj.summary) obj.summary = obj.content.slice(0, 120);
    if (!Array.isArray(obj.strategy) || obj.strategy.length < 2) {
      obj.strategy = [
        "Decompose problem into measurable sub-objectives with validation checkpoints",
        "Apply A/B comparison against baseline to verify genuine improvement",
      ];
    }
    if (typeof obj.confidence !== "number") obj.confidence = 0.72;
    if (!obj.blast_radius) obj.blast_radius = { files: 1, lines: 20 };
    if (!obj.outcome) obj.outcome = { status: "success", score: obj.confidence };
    if (!obj.env_fingerprint) obj.env_fingerprint = { platform: "any", arch: "any" };
    delete obj.asset_id;
    obj.asset_id = computeAssetId(obj);
    return obj;
  } catch {
    return null;
  }
}

async function generateCapsuleViaAgent(task, context) {
  if (!pluginRuntime?.subagent) return null;

  const sessionKey = `agent:main:subagent:darwin-capsule-${task.task_id?.slice(0, 16) || randomUUID().slice(0, 8)}`;
  const prompt = buildCapsulePrompt(task);

  try {
    const { runId } = await pluginRuntime.subagent.run({
      sessionKey,
      message: prompt,
      deliver: false,
    });

    const result = await pluginRuntime.subagent.waitForRun({
      runId,
      timeoutMs: AGENT_GENERATE_TIMEOUT_MS,
    });

    if (result?.status === "error" || result?.status === "timeout") return null;

    const { messages } = await pluginRuntime.subagent.getSessionMessages({
      sessionKey,
      limit: 5,
    });

    let capsule = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const text = msg?.content ?? msg?.text ?? (typeof msg === "string" ? msg : "");
      if (!text) continue;
      capsule = parseCapsuleFromReply(text);
      if (capsule) break;
    }

    try { await pluginRuntime.subagent.deleteSession({ sessionKey }); } catch { /* best-effort */ }

    return capsule;
  } catch {
    try { await pluginRuntime.subagent.deleteSession({ sessionKey }); } catch { /* best-effort */ }
    return null;
  }
}

async function getDarwin(pluginCfg) {
  if (darwinInstance) return darwinInstance;

  const { Darwin } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "index.js")).href);
  const { Mutator } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "mutator.js")).href);
  const { Subscription } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "subscription.js")).href);
  const { TrustPolicy } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "trust-policy.js")).href);
  const { PeerGraph } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "peer-graph.js")).href);
  const { TaskMatcher } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "task-matcher.js")).href);

  const dataDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");

  darwinInstance = new Darwin({
    hubUrl: pluginCfg.hubUrl || "https://evomap.ai",
    dataDir,
    geneCapacity: pluginCfg.geneCapacity || 200,
    explorationRate: pluginCfg.explorationRate || 0.1,
    nodeId: pluginCfg.nodeId || undefined,
    nodeSecret: pluginCfg.nodeSecret || undefined,
    ...(pluginCfg.hubAssetFetch !== undefined ? { hubAssetFetch: pluginCfg.hubAssetFetch } : {}),
  });

  darwinInstance.use(new Mutator({ mutationRate: pluginCfg.mutationRate || 0.05 }));
  const trustPolicy = new TrustPolicy({ dataDir });
  const peerGraph = new PeerGraph({ dataDir, selfNodeId: darwinInstance.hub.nodeId });
  darwinInstance.use(new Subscription({ hub: darwinInstance.hub, dataDir, trustPolicy, peerGraph }));
  darwinInstance.use(new TaskMatcher({
    hub: darwinInstance.hub,
    dataDir,
    autoSubmit: pluginCfg.workerAutoSubmit !== false,
  }));

  // Wire GeneStore file-watch → SSE broadcast
  darwinInstance.store.onChange = () => {
    broadcastDarwinStatus(darwinInstance);
    broadcastDarwinGenes(darwinInstance);
  };

  darwinInstance.on("fetch", (data) => {
    pushEvent("fetch", `Fetched ${data.total} assets, ingested ${data.ingested}`);
    broadcastDarwinStatus(darwinInstance);
    broadcastDarwinGenes(darwinInstance);
  });
  darwinInstance.on("record", (data) => {
    pushEvent("record", `Recorded: ${data.capsuleId?.slice(0, 16)}... fitness=${data.fitness?.toFixed(3) ?? '?'}`);
    broadcastDarwinStatus(darwinInstance);
  });
  darwinInstance.on("evolve", () => {
    pushEvent("evolve", "Evolution cycle completed");
    broadcastDarwinStatus(darwinInstance);
    broadcastDarwinGenes(darwinInstance);
    const status = darwinInstance.getStatus();
    if (status.leaderboard?.length > 0) broadcastSSE("leaderboard", status.leaderboard);
    if (darwinInstance.getRevolutionStatus) broadcastSSE("revolution", darwinInstance.getRevolutionStatus());
    if (status.sponsor) broadcastSSE("sponsor", status.sponsor);
  });
  darwinInstance.on("error", (e) => {
    pushEvent("error", `${e.phase}: ${e.error}`);
  });
  darwinInstance.on("grant-consumed", (data) => {
    pushEvent("sponsor", `Grant ${data.grantId.slice(0, 16)}... consumed ${data.amount} tokens (${data.phase})`);
    if (darwinInstance.sponsor) broadcastSSE("sponsor", darwinInstance.sponsor.getStats());
  });
  darwinInstance.on("task-matched", (data) => {
    pushEvent("task-matched", `Matched ${data.count} task(s), top: ${data.top?.task?.title || "?"} (score ${data.top?.matchScore})`);
    if (darwinInstance.worker) broadcastSSE("worker", darwinInstance.worker.getStats());
  });
  darwinInstance.on("task-claimed", (data) => {
    pushEvent("task-claimed", `Claimed "${data.title}" (match ${data.matchScore}, signals: ${(data.matchedSignals || []).join(", ")})`);
  });
  darwinInstance.on("task-validated", (data) => {
    pushEvent("task-validated", `Validate ${data.valid ? "OK" : "FAIL"} for ${data.assetId?.slice(0, 20)}...`);
  });
  darwinInstance.on("task-published", (data) => {
    pushEvent("task-published", `Published bundle (${data.bundleSize} assets: Gene+Capsule+Event)`);
  });
  darwinInstance.on("task-completed", (data) => {
    const contrib = data.contribution != null ? `, contribution=${data.contribution}` : "";
    pushEvent("task-completed", `Completed "${data.title}" → asset ${data.assetId?.slice(0, 16)}...${contrib}`);
    broadcastDarwinStatus(darwinInstance);
    if (darwinInstance.worker) {
      const stats = darwinInstance.worker.getStats();
      broadcastSSE("worker", stats);
    }
    buildTasksApiPayload(darwinInstance)
      .then((payload) => broadcastSSE("tasks", payload))
      .catch(() => {});
  });
  darwinInstance.on("task-failed", (data) => {
    pushEvent("task-failed", `Task ${data.taskId} failed: ${data.error}`);
    if (darwinInstance.worker) broadcastSSE("worker", darwinInstance.worker.getStats());
  });
  darwinInstance.on("agent-generate-start", (data) => {
    pushEvent("agent-generate-start", `Agent generating capsule for "${data.title || data.taskId}"`);
  });
  darwinInstance.on("agent-capsule", (data) => {
    pushEvent("agent-capsule", `Agent capsule created for task ${data.taskId?.slice(0, 16)} → ${data.assetId?.slice(0, 24)}`);
    broadcastDarwinGenes(darwinInstance);
  });
  darwinInstance.on("agent-capsule-rejected", (data) => {
    pushEvent("agent-capsule-rejected", `Agent capsule rejected for task ${data.taskId?.slice(0, 16)}: ${data.reason}`);
  });
  darwinInstance.on("bootstrap", (data) => {
    pushEvent("bootstrap", `Bootstrap evaluated ${data.evaluated} capsule(s), avg score: ${data.avgScore}`);
    broadcastDarwinStatus(darwinInstance);
    broadcastDarwinGenes(darwinInstance);
  });
  darwinInstance.on("low-credit", (data) => {
    pushEvent("low-credit", `Low credits (${data.creditBalance}) — skipping Hub fetch to conserve resources`);
  });
  darwinInstance.on("report", (data) => {
    pushEvent("report", `Reported fitness for ${data.capsuleId?.slice(0, 16)}... (fitness=${data.fitness?.toFixed(3)}, samples=${data.samples})`);
    broadcastDarwinStatus(darwinInstance);
  });
  darwinInstance.on("heartbeat", () => {
    broadcastDarwinStatus(darwinInstance);
    if (darwinInstance.worker) broadcastSSE("worker", darwinInstance.worker.getStats());
  });
  darwinInstance.on("pending-event", (data) => {
    const type = data.type || data.event_type || "unknown";
    pushEvent("pending-event", `Hub event: ${type}`);
  });

  darwinInstance.setAgentCallback(async () => {
    pushEvent("evolve-think", "Agent-driven evolution cycle — darwin_think available");
  });

  if (pluginRuntime?.subagent && darwinInstance.worker) {
    darwinInstance.worker.setGenerateCallback(async (task, context) => {
      return await generateCapsuleViaAgent(task, context);
    });
  }

  if (darwinInstance.hub.nodeId && darwinInstance.worker) {
    darwinInstance.worker.register({ enabled: true }).catch(() => {});
  }

  pluginInitTimestamp = new Date().toISOString();
  pushEvent("plugin-init", `Darwin instance created (node: ${darwinInstance.hub.nodeId || "pending"}, genes: ${darwinInstance.store.size})`);

  return darwinInstance;
}

export default function register(api) {
  const pluginCfg = api.pluginConfig ?? {};
  pluginRuntime = api.runtime ?? null;

  // Initialize persistent event log directory
  eventLogDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");
  try { mkdirSync(eventLogDir, { recursive: true }); } catch { /* best-effort */ }

  // ── Tools ─────────────────────────────────────────────────────────────

  api.registerTool({
    name: "darwin_status",
    label: "Darwin: Status",
    description:
      "Show Darwin evolution engine status — node info, gene pool size, fitness stats, peer count. " +
      "For actionable evolution recommendations based on meta-gene strategies, call darwin_think instead.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        return jsonResult(darwin.getStatus());
      } catch (err) {
        return textResult(`Status failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_fitness",
    label: "Darwin: Fitness Rankings",
    description: "View local fitness rankings for Capsules. Optionally filter by task type.",
    parameters: {
      type: "object",
      properties: {
        taskType: { type: "string", description: "Filter by task type / signal (optional)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const limit = params.limit || 20;
        const ranked = params.taskType
          ? darwin.tracker.rank(params.taskType).slice(0, limit)
          : darwin.tracker.rankAll().slice(0, limit);

        if (ranked.length === 0) {
          return textResult("No scored Capsules yet. Run darwin_evolve to start tracking.");
        }
        return jsonResult(ranked);
      } catch (err) {
        return textResult(`Fitness query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_genes",
    label: "Darwin: Gene Pool",
    description: "View the local gene pool — stored Capsules ranked by fitness.",
    parameters: {
      type: "object",
      properties: {
        top: { type: "number", description: "Number of top genes to show (default 20)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const ranked = darwin.store.ranked(params.top || 20);
        if (ranked.length === 0) {
          return textResult("Gene pool is empty. Run darwin_evolve to fetch from Hub.");
        }
        return jsonResult(ranked.map((g) => ({
          assetId: g.assetId,
          fitness: g.fitness,
          summary: g.capsule?.summary,
          triggers: g.capsule?.trigger,
        })));
      } catch (err) {
        return textResult(`Gene query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_genes_remove",
    label: "Darwin: Remove Gene",
    description:
      "Remove one Capsule from the local gene pool by asset_id. " +
      "Persists to gene-store.json; does not delete anything on the Hub.",
    parameters: {
      type: "object",
      properties: {
        assetId: {
          type: "string",
          description: "Capsule asset_id (sha256:... or 64-char hex)",
        },
      },
      required: ["assetId"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const raw = String(params.assetId || "").trim();
        const id = resolveGenePoolAssetId(darwin.store, raw);
        if (!id) {
          return textResult(`No gene in pool matches "${raw}". Use darwin_genes to list asset_ids.`);
        }
        const ok = darwin.store.remove(id);
        if (!ok) return textResult(`Failed to remove ${id}`);
        broadcastDarwinStatus(darwin);
        broadcastDarwinGenes(darwin);
        return jsonResult({
          removed: id,
          poolSize: darwin.store.size,
          capacity: darwin.store.capacity,
        });
      } catch (err) {
        return textResult(`Gene remove failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_genes_dedupe",
    label: "Darwin: Dedupe Gene Pool",
    description:
      "Remove local Capsules whose strategy body duplicates another entry (same as repeated darwin_genes_remove). " +
      "Keeps the current meta-gene canonical asset_id when applicable, else highest fitness. Use dryRun to preview.",
    parameters: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "If true, only report which asset_ids would be removed (no writes).",
        },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const { getAllMetaGenes } = await import(
          pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "meta-genes.js")).href,
        );
        const preferred = new Set(
          getAllMetaGenes().map(({ bundle }) => bundle[1]?.asset_id).filter(Boolean),
        );
        const dryRun = params?.dryRun === true;
        const { removed, groupsWithDuplicates } = darwin.store.deduplicateByContent({
          preferredIds: preferred,
          dryRun,
        });
        if (!dryRun) {
          broadcastDarwinStatus(darwin);
          broadcastDarwinGenes(darwin);
        }
        return jsonResult({
          dryRun,
          groupsWithDuplicates,
          removedCount: removed.length,
          removed,
          poolSize: darwin.store.size,
          capacity: darwin.store.capacity,
        });
      } catch (err) {
        return textResult(`Gene dedupe failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_peers",
    label: "Darwin: Peer Network",
    description: "View discovered Darwin peer agents, their fitness, and subscription relationships.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);

        if (darwin.subscription) {
          const graph = darwin.subscription.graph;
          const darwinNodes = graph.getDarwinNodes();
          const subs = new Set(darwin.subscription.getSubscriptions().map((s) => s.nodeId));
          const subscribers = new Set(darwin.subscription.getSubscribers().map((s) => s.nodeId));

          return jsonResult(darwinNodes.map((p) => ({
            nodeId: p.nodeId,
            reportedFitness: p.reportedFitness,
            topics: p.topics,
            discoveredFrom: p.discoveredFrom,
            subscribed: subs.has(p.nodeId),
            isSubscriber: subscribers.has(p.nodeId),
          })));
        }

        const peers = darwin.peers?.getPeers() ?? [];
        return jsonResult(peers);
      } catch (err) {
        return textResult(`Peer query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_evolve",
    label: "Darwin: Evolve",
    description:
      "Run one evolution cycle: fetch Capsules from Hub, ingest into local pool, " +
      "update fitness scores, maybe mutate, maybe exchange with peers. " +
      "For intelligent evolution guided by meta-gene strategies, use darwin_think instead. " +
      "Call this periodically or use cron for automated evolution.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);

        if (!darwin.hub.nodeId) {
          const initResult = await darwin.init();
          return jsonResult({
            phase: "init",
            nodeId: initResult.nodeId,
            claimUrl: initResult.claimUrl,
            message: "Node registered. Run darwin_evolve again to start evolving.",
          });
        }

        await darwin.evolve();
        const status = darwin.getStatus();

        return jsonResult({
          phase: "evolve",
          genePoolSize: status.geneStore.size,
          avgFitness: status.fitness.avgFitness,
          topFitness: status.fitness.topFitness,
        });
      } catch (err) {
        return textResult(`Evolution cycle failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_publish_meta",
    label: "Darwin: Publish Meta-Genes",
    description:
      "Publish the 4 meta-genes to EvoMap Hub: A/B Test, Fitness Selection, " +
      "Parameter Mutation, Peer Recommendation. These teach other agents " +
      "evolution strategies without requiring the darwin library.",
    parameters: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Validate only, do not actually publish (default false)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        if (!darwin.hub.nodeId) await darwin.init();

        const { getAllMetaGenes } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "meta-genes.js")).href);
        const metaGenes = getAllMetaGenes();
        const results = [];

        for (const { name, bundle } of metaGenes) {
          try {
            if (params.dryRun) {
              const res = await darwin.hub.validate(bundle);
              results.push({ name, valid: res?.payload?.valid ?? res?.valid, dryRun: true });
            } else {
              const res = await darwin.hub.publish(bundle);
              results.push({ name, status: res?.payload?.status || "published" });
            }
          } catch (err) {
            results.push({ name, error: err.message });
          }
        }

        return jsonResult(results);
      } catch (err) {
        return textResult(`Meta-gene publish failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_leaderboard",
    label: "Darwin: Model Leaderboard",
    description:
      "View model performance rankings — shows how different AI models perform " +
      "across task types, ranked by real fitness data from local A/B tests.",
    parameters: {
      type: "object",
      properties: {
        taskType: { type: "string", description: "Filter by task type (optional)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const ranked = darwin.tracker.rankByModel(params.taskType);
        if (ranked.length === 0) {
          return textResult("No model data yet. Record usage with model field to populate.");
        }
        return jsonResult(ranked);
      } catch (err) {
        return textResult(`Leaderboard query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_sponsor",
    label: "Darwin: Sponsor Grants",
    description:
      "View sponsor grant status — token budgets from AI model providers " +
      "that subsidize evolution experiments (mutation, A/B testing).",
    parameters: {
      type: "object",
      properties: {
        addGrant: { type: "boolean", description: "If true, add a new grant instead of viewing" },
        sponsorId: { type: "string", description: "Sponsor name (for adding)" },
        model: { type: "string", description: "Model name (for adding)" },
        tokenBudget: { type: "number", description: "Token budget (for adding)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const { Sponsor } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "sponsor.js")).href);
        const sponsor = darwin.sponsor || new Sponsor({ dataDir: pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data") });

        if (params.addGrant && params.sponsorId) {
          const grant = sponsor.addGrant({
            sponsorId: params.sponsorId,
            model: params.model || "unknown",
            tokenBudget: params.tokenBudget || 100000,
          });
          return jsonResult({ created: true, grant });
        }

        return jsonResult(sponsor.getStats());
      } catch (err) {
        return textResult(`Sponsor query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_heartbeat",
    label: "Darwin: Heartbeat",
    description:
      "View heartbeat status or manually trigger a heartbeat to EvoMap Hub. " +
      "Shows credit balance, available work, and node survival status.",
    parameters: {
      type: "object",
      properties: {
        trigger: { type: "boolean", description: "If true, send an immediate heartbeat to Hub" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const dataDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");

        if (params.trigger) {
          const darwin = await getDarwin(pluginCfg);
          if (!darwin.hub.nodeId) {
            return textResult("Node not registered yet. Run darwin_evolve first.");
          }
          const result = await darwin.hub.heartbeat();
          const state = await saveHeartbeatState(dataDir, result, darwin.hub.nodeId);
          return jsonResult({ triggered: true, ...state.lastHeartbeat });
        }

        const state = await loadHeartbeatState(dataDir);
        if (!state.lastHeartbeat) {
          return textResult("No heartbeat data yet. The heartbeat service may not have run yet.");
        }
        return jsonResult(state);
      } catch (err) {
        return textResult(`Heartbeat failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_worker",
    label: "Darwin: Worker Pool",
    description:
      "View and control Worker Pool status — enable/disable worker, set domains, " +
      "scan for matching tasks, or manually claim a specific task.",
    parameters: {
      type: "object",
      properties: {
        enable: { type: "boolean", description: "Enable the worker (register with Hub)" },
        disable: { type: "boolean", description: "Disable the worker" },
        scan: { type: "boolean", description: "Scan available tasks for matches" },
        claim: { type: "string", description: "Claim and complete a specific task by ID" },
        domains: { type: "string", description: "Comma-separated domain list to set" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const worker = darwin.worker;
        if (!worker) return textResult("TaskMatcher not attached.");

        if (params.enable) {
          const domains = params.domains ? params.domains.split(",").map((d) => d.trim()) : undefined;
          await worker.register({ enabled: true, domains });
          return jsonResult({ enabled: true, domains });
        }
        if (params.disable) {
          await worker.disable();
          return jsonResult({ enabled: false });
        }
        if (params.domains && !params.enable) {
          const domains = params.domains.split(",").map((d) => d.trim());
          await worker.register({ enabled: worker.enabled, domains });
          return jsonResult({ domains });
        }
        if (params.scan) {
          const hb = darwin.lastHeartbeat;
          const tasks = hb?.raw?.available_tasks || [];
          const candidates = worker.scan(tasks, darwin.store);
          return jsonResult({ tasksAvailable: tasks.length, matches: candidates.length, candidates: candidates.slice(0, 10).map((c) => ({
            taskId: c.task.task_id,
            title: c.task.title,
            matchScore: c.matchScore,
            matchedSignals: c.matchedSignals,
          })) });
        }
        if (params.claim) {
          const hb = darwin.lastHeartbeat;
          const tasks = hb?.raw?.available_tasks || [];
          const task = tasks.find((t) => t.task_id === params.claim);
          if (!task) return textResult(`Task ${params.claim} not found in available tasks.`);
          const match = worker.matchTask(task, darwin.store);
          if (!match) return textResult("No matching gene for this task.");
          const result = await worker.claimAndComplete(match, darwin);
          return jsonResult(result);
        }
        return jsonResult(worker.getStats());
      } catch (err) {
        return textResult(`Worker operation failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_subscribe",
    label: "Darwin: Subscription Management",
    description:
      "Manage gene subscriptions — subscribe/unsubscribe to Darwin nodes, " +
      "view current subscriptions and subscribers.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: subscribe, unsubscribe, list_subscriptions, list_subscribers" },
        nodeId: { type: "string", description: "Target node ID (for subscribe/unsubscribe)" },
        topics: { type: "string", description: "Comma-separated topics (optional)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const sub = darwin.subscription;
        if (!sub) return textResult("Subscription module not attached.");

        const topics = params.topics ? params.topics.split(",").map((t) => t.trim()) : [];

        switch (params.action) {
          case "subscribe": {
            if (!params.nodeId) return textResult("nodeId required for subscribe.");
            const result = await sub.subscribe(params.nodeId, topics);
            return jsonResult(result);
          }
          case "unsubscribe": {
            if (!params.nodeId) return textResult("nodeId required for unsubscribe.");
            const result = await sub.unsubscribe(params.nodeId, topics);
            return jsonResult(result);
          }
          case "list_subscriptions":
            return jsonResult(sub.getSubscriptions());
          case "list_subscribers":
            return jsonResult(sub.getSubscribers());
          default:
            return jsonResult(sub.getStats());
        }
      } catch (err) {
        return textResult(`Subscription operation failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_catalog",
    label: "Darwin: Channel Catalog",
    description: "View the local channel catalog — topics, gene counts, and fitness by channel.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const sub = darwin.subscription;
        if (!sub) return textResult("Subscription module not attached.");
        return jsonResult(sub.buildCatalog(darwin));
      } catch (err) {
        return textResult(`Catalog query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_network",
    label: "Darwin: Network Topology",
    description:
      "View the peer graph topology — discovered nodes, Darwin nodes, gossip vs directory discovery, " +
      "trust policy, and subscription statistics.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const sub = darwin.subscription;
        if (!sub) return textResult("Subscription module not attached.");
        return jsonResult({
          peerGraph: sub.graph.getStats(),
          subscription: sub.getStats(),
          trustPolicy: sub.policy.getStats(),
        });
      } catch (err) {
        return textResult(`Network query failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_think",
    label: "Darwin: Evolution Advisor",
    description:
      "Analyze current evolution state and return actionable recommendations with " +
      "full meta-gene strategy text. Call this to decide what evolution action to take next: " +
      "A/B test untested capsules, mutate high-fitness capsules, review selection rankings, " +
      "or evaluate peer subscriptions. Each recommendation includes the complete strategy " +
      "from the relevant meta-gene — read it and follow the instructions, then use " +
      "darwin_select and darwin_record to execute.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const storeStats = darwin.store.getStats();
        const trackerStats = darwin.tracker.getStats();

        const allGenes = darwin.store.ranked(storeStats.capacity || 200);
        const unscoredCapsules = [];
        const scoredCapsules = [];
        for (const g of allGenes) {
          const samples = darwin.tracker.getSampleCount(g.assetId);
          if (samples < 3) unscoredCapsules.push({ ...g, samples });
          else scoredCapsules.push({ ...g, samples });
        }

        const state = {
          poolSize: storeStats.size,
          capacity: storeStats.capacity,
          avgFitness: storeStats.avgFitness,
          topFitness: storeStats.topFitness,
          totalRecords: trackerStats.totalRecords,
          scoredCapsules: scoredCapsules.length,
          unscoredCapsules: unscoredCapsules.length,
          tokenSavingsRate: trackerStats.tokenSavingsRate,
        };

        const recommendations = [];

        // 1. A/B Test: unscored capsules need testing
        if (unscoredCapsules.length > 0) {
          const pick = unscoredCapsules[Math.floor(Math.random() * unscoredCapsules.length)];
          const metaGene = darwin.selectCapsule("capsule-selection");
          recommendations.push({
            priority: 1,
            type: "ab_test",
            reason: `${unscoredCapsules.length} capsule(s) have fewer than 3 samples and need A/B testing`,
            targetCapsuleId: pick.assetId,
            targetSummary: pick.capsule?.summary || "(no summary)",
            targetTriggers: pick.capsule?.trigger || pick.capsule?.signals_match || [],
            samples: pick.samples,
            strategy: metaGene?.capsule?.content || "No A/B Test meta-gene found. Basic approach: run task without capsule for baseline, then with capsule, compare token usage.",
          });
        }

        // 2. Mutation: high-fitness capsules with enough samples are mutation candidates
        const mutationCandidates = scoredCapsules.filter((g) => g.samples >= 5 && g.fitness > 0);
        if (mutationCandidates.length > 0) {
          const top = mutationCandidates[0];
          const metaGene = darwin.selectCapsule("mutation");
          recommendations.push({
            priority: 2,
            type: "mutation",
            reason: `Capsule with fitness ${top.fitness.toFixed(3)} and ${top.samples} samples is a good mutation candidate`,
            targetCapsuleId: top.assetId,
            targetSummary: top.capsule?.summary || "(no summary)",
            targetStrategy: top.capsule?.strategy,
            fitness: top.fitness,
            samples: top.samples,
            strategy: metaGene?.capsule?.content || "No Mutation meta-gene found. Basic approach: tweak numeric parameters (+1/-1/x1.5/x0.5), test variant, keep if better.",
          });
        }

        // 3. Fitness Selection: review rankings when multiple scored capsules exist
        const taskTypes = new Set();
        for (const g of allGenes) {
          const triggers = g.capsule?.trigger || g.capsule?.signals_match || [];
          for (const t of triggers) taskTypes.add(t);
        }
        const competitiveTypes = [];
        for (const tt of taskTypes) {
          const ranked = darwin.tracker.rank(tt);
          if (ranked.length >= 2) competitiveTypes.push({ taskType: tt, count: ranked.length, top: ranked[0] });
        }
        if (competitiveTypes.length > 0) {
          const metaGene = darwin.selectCapsule("fitness-selection");
          recommendations.push({
            priority: 3,
            type: "fitness_review",
            reason: `${competitiveTypes.length} task type(s) have multiple scored capsules — review if the best is being used`,
            competitiveTypes: competitiveTypes.slice(0, 5).map((c) => ({
              taskType: c.taskType,
              candidates: c.count,
              topFitness: c.top.fitness,
            })),
            strategy: metaGene?.capsule?.content || "No Fitness Selection meta-gene found. Basic approach: rank by local fitness = success_rate * token_savings, prefer highest.",
          });
        }

        // 4. Peer Subscription: evaluate if subscription is active
        const sub = darwin.subscription;
        if (sub) {
          const subStats = sub.getStats();
          const newGenesCount = allGenes.filter((g) => {
            const samples = darwin.tracker.getSampleCount(g.assetId);
            return samples === 0;
          }).length;
          if (newGenesCount > 0 || subStats.subscriptions > 0) {
            const metaGene = darwin.selectCapsule("subscription");
            recommendations.push({
              priority: 4,
              type: "peer_evaluation",
              reason: `${newGenesCount} untested gene(s) from peers; ${subStats.subscriptions} active subscription(s)`,
              subscriptions: subStats.subscriptions,
              subscribers: subStats.subscribers,
              strategy: metaGene?.capsule?.content || "No Subscription meta-gene found. Basic approach: A/B test peer genes, send feedback, unsubscribe from low-trust peers.",
            });
          }
        }

        if (recommendations.length === 0) {
          recommendations.push({
            priority: 1,
            type: "idle",
            reason: "Gene pool is healthy. Consider fetching new capsules or running more tasks to gather fitness data.",
            strategy: null,
          });
        }

        return jsonResult({ state, recommendations });
      } catch (err) {
        return textResult(`Think failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_select",
    label: "Darwin: Select Capsule",
    description:
      "Select the best Capsule strategy for a given task type. " +
      "Returns the capsule content/strategy so you can follow it when executing the task. " +
      "After completing the task, call darwin_record to report the result. " +
      "For evolution decisions, use signal types like 'capsule-selection', 'mutation', " +
      "'fitness-selection', or 'subscription' to retrieve meta-gene strategies.",
    parameters: {
      type: "object",
      properties: {
        taskType: { type: "string", description: "The task type / signal to match (required)" },
        count: { type: "number", description: "Number of candidates to return (default 1)" },
      },
      required: ["taskType"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const count = params.count || 1;

        if (count > 1) {
          const candidates = darwin.selector.rankCandidates(params.taskType);
          if (candidates.length === 0) {
            return textResult(`No capsules found for task type "${params.taskType}".`);
          }
          return jsonResult(candidates.slice(0, count).map((c) => ({
            assetId: c.capsule?.asset_id,
            source: c.source,
            fitness: c.fitness,
            samples: c.samples,
            content: c.capsule?.content,
            strategy: c.capsule?.strategy,
            triggers: c.capsule?.trigger || c.capsule?.signals_match,
          })));
        }

        const result = darwin.selectCapsule(params.taskType);
        if (!result) {
          return textResult(`No capsules found for task type "${params.taskType}".`);
        }
        return jsonResult({
          assetId: result.capsule?.asset_id,
          reason: result.reason,
          source: result.source,
          content: result.capsule?.content,
          strategy: result.capsule?.strategy,
          triggers: result.capsule?.trigger || result.capsule?.signals_match,
        });
      } catch (err) {
        return textResult(`Select failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_record",
    label: "Darwin: Record Usage",
    description:
      "Record a Capsule usage result to update fitness scores. " +
      "Call this after using a capsule strategy (from darwin_select) to complete a task.",
    parameters: {
      type: "object",
      properties: {
        capsuleId: { type: "string", description: "The asset_id of the capsule used" },
        taskType: { type: "string", description: "The task type / signal" },
        success: { type: "boolean", description: "Whether the task was completed successfully" },
        tokensUsed: { type: "number", description: "Tokens consumed during execution (optional)" },
        baselineTokens: { type: "number", description: "Tokens that would be used without the capsule (optional)" },
        model: { type: "string", description: "AI model used for execution (optional)" },
      },
      required: ["capsuleId", "taskType", "success"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const { entry, fitness } = darwin.recordUsage(params.capsuleId, params.taskType, {
          success: params.success,
          tokensUsed: params.tokensUsed || 0,
          baselineTokens: params.baselineTokens || 0,
          model: params.model || undefined,
        });
        return jsonResult({
          recorded: true,
          capsuleId: params.capsuleId,
          taskType: params.taskType,
          success: params.success,
          fitness,
          totalSamples: darwin.tracker.getSampleCount(params.capsuleId),
        });
      } catch (err) {
        return textResult(`Record failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Hub Discovery Tools ──────────────────────────────────────────────

  api.registerTool({
    name: "darwin_hub_stats",
    label: "Darwin: Hub Stats",
    description: "Fetch EvoMap Hub health and statistics (GET /a2a/stats). No auth required.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getStats();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Hub stats failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_hub_help",
    label: "Darwin: Hub Help",
    description: "Look up any EvoMap concept or endpoint via the Help API (GET /a2a/help?q=...). No auth required.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Concept or endpoint to look up (e.g. 'marketplace', '/a2a/publish')" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getHelp(params.query);
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Hub help failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_node_info",
    label: "Darwin: Node Info",
    description: "Fetch reputation and info for a node (GET /a2a/nodes/:nodeId). Defaults to own node.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID to look up (optional, defaults to self)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getNodeInfo(params.nodeId);
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Node info failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Task & Bounty Tools ─────────────────────────────────────────────

  api.registerTool({
    name: "darwin_tasks",
    label: "Darwin: List Tasks",
    description: "List open bounty tasks on the EvoMap Hub (GET /task/list).",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getTaskList();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Task list failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_my_tasks",
    label: "Darwin: My Tasks",
    description: "View tasks claimed/completed by this node (GET /task/my).",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getMyTasks();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`My tasks failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_task_claim",
    label: "Darwin: Claim Task",
    description: "Claim an open bounty task (POST /task/claim).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task_id to claim" },
      },
      required: ["taskId"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.claimTask(params.taskId);
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Task claim failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_task_complete",
    label: "Darwin: Complete Task",
    description:
      "Complete a claimed task by submitting an asset. " +
      "Validates and publishes the asset bundle before marking complete.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task_id to complete" },
        assetId: { type: "string", description: "The asset_id of the solution" },
      },
      required: ["taskId", "assetId"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const { buildBundle } = await import(
          pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "bundle-builder.js")).href
        );

        let validateOk = null;
        let publishOk = null;

        const storeEntry = darwin.store
          ?.ranked(darwin.store.capacity)
          .find((g) => g.assetId === params.assetId);
        const capsule = storeEntry?.capsule;

        if (capsule) {
          const bundle = buildBundle(capsule);
          try {
            const vRes = await darwin.hub.validate(bundle);
            validateOk = vRes?.payload?.valid !== false && vRes?.valid !== false;
          } catch {
            validateOk = false;
          }
          if (validateOk) {
            try {
              await darwin.hub.publish(bundle);
              publishOk = true;
            } catch {
              publishOk = false;
            }
          } else {
            publishOk = false;
          }
        }

        const res = await darwin.hub.completeTask(params.taskId, params.assetId);
        return jsonResult({
          ...(res?.payload ?? res),
          validateOk,
          publishOk,
        });
      } catch (err) {
        return textResult(`Task complete failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_ask",
    label: "Darwin: Create Bounty Ask",
    description: "Create a bounty task for other agents to solve (POST /a2a/ask).",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Task description" },
        bounty: { type: "number", description: "Bounty amount in credits (optional)" },
        signals: { type: "array", items: { type: "string" }, description: "Signal tags (optional)" },
      },
      required: ["description"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const opts = {};
        if (params.bounty != null) opts.bounty = params.bounty;
        if (params.signals?.length) opts.signals = params.signals;
        const res = await darwin.hub.createAsk(params.description, opts);
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Ask failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Asset Discovery Tools ───────────────────────────────────────────

  api.registerTool({
    name: "darwin_assets",
    label: "Darwin: Browse Assets",
    description: "Browse Hub assets — promoted, ranked, or trending.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["promoted", "ranked", "trending"], description: "Listing mode (default: promoted)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        let res;
        if (params.mode === "ranked") res = await darwin.hub.getRankedAssets();
        else if (params.mode === "trending") res = await darwin.hub.getTrending();
        else res = await darwin.hub.getPromotedAssets();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Assets failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_assets_search",
    label: "Darwin: Search Assets",
    description: "Search Hub assets by signal tags or semantic query.",
    parameters: {
      type: "object",
      properties: {
        signals: { type: "string", description: "Comma-separated signals for signal search" },
        query: { type: "string", description: "Natural language query for semantic search" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        let res;
        if (params.query) res = await darwin.hub.semanticSearch(params.query);
        else if (params.signals) res = await darwin.hub.searchAssets(params.signals);
        else return textResult("Provide signals or query.");
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Asset search failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── DM Tools ────────────────────────────────────────────────────────

  api.registerTool({
    name: "darwin_dm_send",
    label: "Darwin: Send DM",
    description: "Send a direct message to another node (POST /a2a/dm).",
    parameters: {
      type: "object",
      properties: {
        toNodeId: { type: "string", description: "Target node ID" },
        message: { type: "string", description: "Message text" },
      },
      required: ["toNodeId", "message"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.sendDM(params.toNodeId, { text: params.message });
        return jsonResult(res?.payload ?? res ?? { ok: true });
      } catch (err) {
        return textResult(`DM send failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_dm_inbox",
    label: "Darwin: DM Inbox",
    description: "Check DM inbox for incoming messages (GET /a2a/dm/inbox).",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.pollDM();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`DM inbox failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Credits & Earnings Tools ────────────────────────────────────────

  api.registerTool({
    name: "darwin_credits",
    label: "Darwin: Credits",
    description: "View credit price and economy overview.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const [price, econ] = await Promise.allSettled([
          darwin.hub.getCreditPrice(),
          darwin.hub.getCreditEconomics(),
        ]);
        return jsonResult({
          price: price.status === "fulfilled" ? (price.value?.payload ?? price.value) : null,
          economics: econ.status === "fulfilled" ? (econ.value?.payload ?? econ.value) : null,
        });
      } catch (err) {
        return textResult(`Credits failed: ${err.message}`);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "darwin_earnings",
    label: "Darwin: Earnings",
    description: "View earnings for this node.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getEarnings();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Earnings failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Service Tools ───────────────────────────────────────────────────

  api.registerTool({
    name: "darwin_services",
    label: "Darwin: Service Marketplace",
    description: "Search the EvoMap service marketplace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (optional)" },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.searchServices(params.query || undefined);
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Service search failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Session Tools ───────────────────────────────────────────────────

  api.registerTool({
    name: "darwin_session",
    label: "Darwin: Session",
    description: "Manage collaboration sessions — create, join, send message, or leave.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "join", "message", "leave"], description: "Action to perform" },
        sessionId: { type: "string", description: "Session ID (required for join/message/leave)" },
        topic: { type: "string", description: "Topic for new session (for create)" },
        message: { type: "string", description: "Message text (for message action)" },
      },
      required: ["action"],
    },
    async execute(_toolCallId, params) {
      try {
        const darwin = await getDarwin(pluginCfg);
        switch (params.action) {
          case "create": {
            const res = await darwin.hub.createSession({ topic: params.topic || "general" });
            return jsonResult(res?.payload ?? res);
          }
          case "join": {
            if (!params.sessionId) return textResult("sessionId required");
            const res = await darwin.hub.joinSession(params.sessionId);
            return jsonResult(res?.payload ?? res);
          }
          case "message": {
            if (!params.sessionId || !params.message) return textResult("sessionId and message required");
            const res = await darwin.hub.sendSessionMessage(params.sessionId, params.message);
            return jsonResult(res?.payload ?? res);
          }
          case "leave": {
            if (!params.sessionId) return textResult("sessionId required");
            const res = await darwin.hub.leaveSession(params.sessionId);
            return jsonResult(res?.payload ?? res);
          }
          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      } catch (err) {
        return textResult(`Session failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Governance Tools ────────────────────────────────────────────────

  api.registerTool({
    name: "darwin_projects",
    label: "Darwin: Projects",
    description: "List official EvoMap projects.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
        const res = await darwin.hub.getProjectList();
        return jsonResult(res?.payload ?? res);
      } catch (err) {
        return textResult(`Projects failed: ${err.message}`);
      }
    },
  }, { optional: true });

  // ── Gateway HTTP Routes: Dashboard + REST API ───────────────────────

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}`,
    auth: "plugin",
    async handler(_req, res) {
      res.writeHead(301, { Location: `${ROUTE_PREFIX}/` });
      res.end();
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/`,
    auth: "plugin",
    async handler(_req, res) {
      serveStaticFile(res, nodePath.join(DASHBOARD_DIR, "index.html"));
      return true;
    },
  });

  // ── SSE Stream endpoint ──────────────────────────────────────────────

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/stream`,
    auth: "plugin",
    match: "exact",
    async handler(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      try {
        const darwin = await getDarwin(pluginCfg);
        sendSSE(res, "init", await buildFullSnapshot(darwin));
      } catch (err) {
        sendSSE(res, "error", { message: err.message });
      }
      sseClients.add(res);
      pushEvent("sse-connect", `Dashboard connected (clients: ${sseClients.size})`);
      startSSEKeepalive();
      startSSEStatusBroadcast(pluginCfg);
      req.on("close", () => {
        sseClients.delete(res);
        pushEvent("sse-disconnect", `Dashboard disconnected (clients: ${sseClients.size})`);
        if (sseClients.size === 0) {
          if (sseKeepaliveTimer) { clearInterval(sseKeepaliveTimer); sseKeepaliveTimer = null; }
          stopSSEStatusBroadcast();
        }
      });
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/status`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        sendJson(res, 200, darwin.getStatus());
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/fitness`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const taskType = parsed.searchParams.get("taskType") || "";
        const limit = parseInt(parsed.searchParams.get("limit") || "20", 10);
        const ranked = taskType
          ? darwin.tracker.rank(taskType).slice(0, limit)
          : darwin.tracker.rankAll().slice(0, limit);
        sendJson(res, 200, ranked);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/genes`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const top = parseInt(parsed.searchParams.get("top") || "20", 10);
        const ranked = darwin.store.ranked(top);
        sendJson(res, 200, ranked.map((g) => ({
          assetId: g.assetId,
          fitness: g.fitness,
          source: g.source || "hub",
          summary: g.capsule?.summary,
          triggers: g.capsule?.trigger,
        })));
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/peers`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);

        if (darwin.subscription) {
          const graph = darwin.subscription.graph;
          const darwinNodes = graph.getDarwinNodes();
          const subs = new Set(darwin.subscription.getSubscriptions().map((s) => s.nodeId));
          const subscribers = new Set(darwin.subscription.getSubscribers().map((s) => s.nodeId));

          sendJson(res, 200, darwinNodes.map((p) => ({
            nodeId: p.nodeId,
            reportedFitness: p.reportedFitness,
            topics: p.topics,
            discoveredFrom: p.discoveredFrom,
            subscribed: subs.has(p.nodeId),
            isSubscriber: subscribers.has(p.nodeId),
          })));
        } else {
          const peers = darwin.peers?.getPeers() ?? [];
          sendJson(res, 200, peers);
        }
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/subscriptions`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const sub = darwin.subscription;
        sendJson(res, 200, sub ? {
          subscriptions: sub.getSubscriptions(),
          subscribers: sub.getSubscribers(),
          stats: sub.getStats(),
        } : { subscriptions: [], subscribers: [], stats: null });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/network`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const sub = darwin.subscription;
        sendJson(res, 200, sub ? {
          peerGraph: sub.graph.getStats(),
          trustPolicy: sub.policy.getStats(),
        } : { peerGraph: null, trustPolicy: null });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/revolution`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        sendJson(res, 200, darwin.getRevolutionStatus());
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/leaderboard`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const taskType = parsed.searchParams.get("taskType") || undefined;
        const ranked = darwin.tracker.rankByModel(taskType);
        sendJson(res, 200, ranked);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/heartbeat`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const dataDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");
        const state = await loadHeartbeatState(dataDir);
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/sponsor`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        sendJson(res, 200, darwin.sponsor?.getStats() ?? { totalGrants: 0 });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/events`,
    auth: "plugin",
    async handler(req, res) {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const since = parseInt(parsed.searchParams.get("since") || "0", 10);
      const events = eventBuffer.filter((e) => e.id > since);
      sendJson(res, 200, events);
      return true;
    },
  });

  // ── Persistent event log endpoint ────────────────────────────────────
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/events-log`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const dateStr = parsed.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const limit = Math.min(parseInt(parsed.searchParams.get("limit") || "100", 10), 500);
        const typeFilter = parsed.searchParams.get("type") || "";
        const logDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");
        const logPath = nodePath.join(logDir, `darwin-events-${dateStr}.jsonl`);

        let events = [];
        try {
          const raw = nodeFs.readFileSync(logPath, "utf-8");
          const lines = raw.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (!typeFilter || evt.type === typeFilter) events.push(evt);
            } catch { /* skip malformed lines */ }
          }
        } catch {
          // File doesn't exist for this date — return empty
        }

        const tail = events.slice(-limit);
        sendJson(res, 200, { date: dateStr, total: events.length, events: tail });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  // ── System health endpoint ───────────────────────────────────────────
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/health`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const now = Date.now();
        const status = darwin.getStatus();
        const hbState = await loadHeartbeatState(
          pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data"),
        );

        const lastHbTs = hbState.lastHeartbeat?.timestamp;
        const lastHeartbeatAge = lastHbTs ? now - new Date(lastHbTs).getTime() : null;

        // Find last evolve event from in-memory buffer
        let lastEvolveAge = null;
        for (let i = eventBuffer.length - 1; i >= 0; i--) {
          if (eventBuffer[i].type === "evolve") {
            lastEvolveAge = now - new Date(eventBuffer[i].timestamp).getTime();
            break;
          }
        }

        // Find last fitness record age from fitness-log.jsonl
        let lastFitnessRecordAge = null;
        try {
          const fitPath = nodePath.join(
            pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data"),
            "fitness-log.jsonl",
          );
          const fitRaw = nodeFs.readFileSync(fitPath, "utf-8");
          const fitLines = fitRaw.trim().split("\n").filter(Boolean);
          if (fitLines.length > 0) {
            const last = JSON.parse(fitLines[fitLines.length - 1]);
            if (last.timestamp) lastFitnessRecordAge = now - new Date(last.timestamp).getTime();
          }
        } catch { /* no fitness log yet */ }

        // Count today's events from the persistent log
        let eventCountToday = 0;
        try {
          const todayStr = new Date().toISOString().slice(0, 10);
          const logDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");
          const logPath = nodePath.join(logDir, `darwin-events-${todayStr}.jsonl`);
          const raw = nodeFs.readFileSync(logPath, "utf-8");
          eventCountToday = raw.trim().split("\n").filter(Boolean).length;
        } catch { /* no log for today */ }

        const genePoolFill = status.geneStore
          ? status.geneStore.size / (status.geneStore.capacity || 200)
          : 0;
        const peerConnections = (status.subscription?.subscriptions ?? 0)
          + (status.subscription?.subscribers ?? 0)
          + (status.peerCount ?? 0);

        const TEN_MIN = 10 * 60 * 1000;
        const THIRTY_MIN = 30 * 60 * 1000;
        const EIGHT_H = 8 * 60 * 60 * 1000;
        const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
        const SEVEN_D = 7 * 24 * 60 * 60 * 1000;

        const checks = {
          heartbeatFresh: lastHeartbeatAge !== null && lastHeartbeatAge < TEN_MIN
            ? "ok"
            : lastHeartbeatAge !== null && lastHeartbeatAge < THIRTY_MIN
              ? "warn"
              : "fail",
          evolutionFresh: lastEvolveAge !== null && lastEvolveAge < EIGHT_H
            ? "ok"
            : lastEvolveAge !== null && lastEvolveAge < TWENTY_FOUR_H
              ? "warn"
              : "fail",
          fitnessDataFresh: lastFitnessRecordAge !== null && lastFitnessRecordAge < TWENTY_FOUR_H
            ? "ok"
            : lastFitnessRecordAge !== null && lastFitnessRecordAge < SEVEN_D
              ? "warn"
              : "fail",
          genePoolHealthy: genePoolFill > 0.1 ? "ok" : genePoolFill > 0.05 ? "warn" : "fail",
          peerConnected: peerConnections > 0 ? "ok" : "fail",
        };

        sendJson(res, 200, {
          upSince: pluginInitTimestamp,
          heartbeatService: heartbeatServiceRunning ? "running" : "stopped",
          lastHeartbeatAge,
          lastEvolveAge,
          lastFitnessRecordAge,
          genePoolFill: Math.round(genePoolFill * 1000) / 1000,
          genePoolSize: status.geneStore?.size ?? 0,
          genePoolCapacity: status.geneStore?.capacity ?? 200,
          peerConnections,
          eventCountToday,
          checks,
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/worker`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        sendJson(res, 200, darwin.worker?.getStats() ?? { registered: false, workerEnabled: false });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/earnings`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const payload = await buildEarningsApiPayload(darwin);
        sendJson(res, 200, payload);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/tasks`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        sendJson(res, 200, await buildTasksApiPayload(darwin));
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/select`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const taskType = parsed.searchParams.get("taskType");
        if (!taskType) {
          sendJson(res, 400, { error: "taskType query parameter is required" });
          return true;
        }
        const count = parseInt(parsed.searchParams.get("count") || "1", 10);

        if (count > 1) {
          const candidates = darwin.selector.rankCandidates(taskType);
          sendJson(res, 200, candidates.slice(0, count).map((c) => ({
            assetId: c.capsule?.asset_id,
            source: c.source,
            fitness: c.fitness,
            samples: c.samples,
            content: c.capsule?.content,
            strategy: c.capsule?.strategy,
            triggers: c.capsule?.trigger || c.capsule?.signals_match,
          })));
        } else {
          const result = darwin.selectCapsule(taskType);
          sendJson(res, 200, result ? {
            assetId: result.capsule?.asset_id,
            reason: result.reason,
            source: result.source,
            content: result.capsule?.content,
            strategy: result.capsule?.strategy,
            triggers: result.capsule?.trigger || result.capsule?.signals_match,
          } : null);
        }
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/record`,
    auth: "plugin",
    async handler(req, res) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return true;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "POST method required" });
        return true;
      }
      try {
        const darwin = await getDarwin(pluginCfg);
        const body = await parseJsonBody(req);
        if (!body.capsuleId || !body.taskType || body.success === undefined) {
          sendJson(res, 400, { error: "capsuleId, taskType, and success are required" });
          return true;
        }
        const { entry, fitness } = darwin.recordUsage(body.capsuleId, body.taskType, {
          success: !!body.success,
          tokensUsed: body.tokensUsed || 0,
          baselineTokens: body.baselineTokens || 0,
          model: body.model || undefined,
        });
        sendJson(res, 200, {
          recorded: true,
          capsuleId: body.capsuleId,
          taskType: body.taskType,
          success: !!body.success,
          fitness,
          totalSamples: darwin.tracker.getSampleCount(body.capsuleId),
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/published`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const { getAllMetaGenes } = await import(
          pathToFileURL(nodePath.join(PROJECT_ROOT, "src", "meta-genes.js")).href
        );
        const metaGenes = getAllMetaGenes();
        const hubBase = darwin.hub.hubUrl || "https://evomap.ai";

        const results = await Promise.all(
          metaGenes.map(async ({ name, bundle }) => {
            const [gene, capsule, event] = bundle;
            const entry = {
              name,
              gene: { assetId: gene.asset_id, summary: gene.summary },
              capsule: { assetId: capsule.asset_id, summary: capsule.summary },
              event: { assetId: event.asset_id },
              hubStatus: "unknown",
              hubUrl: `${hubBase}/a2a/assets/${encodeURIComponent(capsule.asset_id)}`,
            };
            try {
              const info = await darwin.hub.getAsset(capsule.asset_id);
              const st = info?.status ?? info?.payload?.status;
              entry.hubStatus = typeof st === "string" && st.length > 0 ? st : "unknown";
            } catch {
              // Hub unreachable or asset missing — keep "unknown"
            }
            return entry;
          }),
        );
        sendJson(res, 200, results);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/`,
    auth: "plugin",
    match: "prefix",
    async handler(req, res) {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const subPath = decodeURIComponent(parsed.pathname.slice(ROUTE_PREFIX.length + 1));
      if (!subPath || subPath === "/") {
        return false;
      }
      if (subPath.startsWith("api/")) {
        return false;
      }
      const filePath = nodePath.normalize(nodePath.join(DASHBOARD_DIR, subPath));
      if (!filePath.startsWith(DASHBOARD_DIR)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return true;
      }
      if (!nodeFs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return true;
      }
      serveStaticFile(res, filePath);
      return true;
    },
  });

  // ── Background Heartbeat Service ─────────────────────────────────────

  if (pluginCfg.heartbeatEnabled !== false) {
    const heartbeatDataDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");

    let _heartbeatTimerId = null;
    let _heartbeatStopped = false;

    api.registerService({
      id: "darwin-heartbeat",
      label: "Darwin Heartbeat",
      async start(ctx) {
        _heartbeatStopped = false;
        heartbeatServiceRunning = true;
        const baseIntervalMs = pluginCfg.heartbeatIntervalMs || 300_000;
        let nextIntervalMs = baseIntervalMs;
        pushEvent("service-start", `Heartbeat service started (interval: ${baseIntervalMs}ms)`);

        const runHeartbeat = async () => {
          try {
            const darwin = await getDarwin(pluginCfg);
            if (!darwin.hub.nodeId) {
              ctx.logger.warn("Heartbeat skipped: node not registered yet. Run darwin_evolve first.");
              return;
            }
            const result = await darwin.heartbeat();
            if (!result) return;
            await saveHeartbeatState(heartbeatDataDir, result, darwin.hub.nodeId);
            if (result.nextHeartbeatMs && result.nextHeartbeatMs > 0) {
              nextIntervalMs = result.nextHeartbeatMs;
            }
            ctx.logger.debug(
              `Heartbeat OK | credits: ${result.creditBalance} | next: ${nextIntervalMs}ms`,
            );
          } catch (err) {
            ctx.logger.error(`Heartbeat failed: ${err.message}`);
          }
        };

        const scheduleNext = () => {
          if (_heartbeatStopped) return;
          _heartbeatTimerId = setTimeout(async () => {
            await runHeartbeat();
            scheduleNext();
          }, nextIntervalMs);
        };

        await runHeartbeat();
        scheduleNext();
      },
      stop() {
        _heartbeatStopped = true;
        heartbeatServiceRunning = false;
        if (_heartbeatTimerId) {
          clearTimeout(_heartbeatTimerId);
          _heartbeatTimerId = null;
        }
        pushEvent("service-stop", "Heartbeat service stopped");
      },
    });
  }

  // ── Background Evolution Service ────────────────────────────────────

  if (pluginCfg.evolveEnabled !== false) {
    let _evolveTimerId = null;
    let _evolveStopped = false;
    let evolveServiceRunning = false;

    api.registerService({
      id: "darwin-evolution",
      label: "Darwin Evolution Cycle",
      async start(ctx) {
        _evolveStopped = false;
        evolveServiceRunning = true;
        const intervalMs = pluginCfg.evolveIntervalMs || 4 * 60 * 60 * 1000;
        const initialDelayMs = 60_000;
        pushEvent("service-start", `Evolution service started (interval: ${Math.round(intervalMs / 60000)}min, first in ${Math.round(initialDelayMs / 1000)}s)`);

        const runEvolve = async () => {
          try {
            const darwin = await getDarwin(pluginCfg);
            if (!darwin.hub.nodeId) {
              ctx.logger.warn("Evolution skipped: node not registered yet.");
              return;
            }
            pushEvent("evolve-start", "Evolution cycle starting...");
            await darwin.evolve();
            ctx.logger.debug("Evolution cycle completed");
          } catch (err) {
            pushEvent("error", `Evolution cycle failed: ${err.message}`);
            ctx.logger.error(`Evolution failed: ${err.message}`);
          }
        };

        const scheduleNext = () => {
          if (_evolveStopped) return;
          _evolveTimerId = setTimeout(async () => {
            await runEvolve();
            scheduleNext();
          }, intervalMs);
        };

        _evolveTimerId = setTimeout(async () => {
          await runEvolve();
          scheduleNext();
        }, initialDelayMs);
      },
      stop() {
        _evolveStopped = true;
        evolveServiceRunning = false;
        if (_evolveTimerId) {
          clearTimeout(_evolveTimerId);
          _evolveTimerId = null;
        }
        pushEvent("service-stop", "Evolution service stopped");
      },
    });
  }

  // ── CLI ───────────────────────────────────────────────────────────────

  api.registerCli(
    ({ program }) => {
      const darwin = program
        .command("darwin")
        .description("JS EvoMap Darwin — Evolution engine for EvoMap");

      darwin
        .command("init")
        .description("Register with EvoMap Hub")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("init", []);
        });

      darwin
        .command("status")
        .description("Show node status, gene pool, fitness stats")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("status", []);
        });

      darwin
        .command("start")
        .description("Start the evolution loop")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("start", []);
        });

      darwin
        .command("fitness")
        .description("View fitness rankings")
        .option("--task-type <type>", "Filter by task type")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.taskType) args.push("--task-type", opts.taskType);
          await run("fitness", args);
        });

      darwin
        .command("genes")
        .description("View local gene pool")
        .option("--top <n>", "Number of top genes to show")
        .option("--remove <id>", "Remove one Capsule from the pool by asset_id")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.top) args.push("--top", opts.top);
          if (opts.remove) args.push("--remove", opts.remove);
          await run("genes", args);
        });

      darwin
        .command("genes-remove <assetId>")
        .description("Remove one Capsule from the local gene pool (same as genes remove)")
        .action(async (assetId) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("genes-remove", [assetId]);
        });

      darwin
        .command("genes-dedupe")
        .description("Remove duplicate strategy bodies from the gene pool (same as genes dedupe)")
        .option("--dry-run", "List removals without writing gene-store.json")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.dryRun) args.push("--dry-run");
          await run("genes-dedupe", args);
        });

      darwin
        .command("peers")
        .description("View peer network")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("peers", []);
        });

      darwin
        .command("select <taskType>")
        .description("Select the best capsule strategy for a task type")
        .option("--count <n>", "Number of candidates to return", "1")
        .action(async (taskType, opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [taskType];
          if (opts.count && opts.count !== "1") args.push("--count", opts.count);
          await run("select", args);
        });

      darwin
        .command("record <capsuleId> <taskType>")
        .description("Record a capsule usage result")
        .option("--success", "Task succeeded")
        .option("--fail", "Task failed")
        .option("--tokens-used <n>", "Tokens consumed")
        .option("--baseline-tokens <n>", "Baseline tokens without capsule")
        .option("--model <model>", "AI model used")
        .action(async (capsuleId, taskType, opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [capsuleId, taskType];
          if (opts.success) args.push("--success");
          if (opts.fail) args.push("--fail");
          if (opts.tokensUsed) args.push("--tokens-used", opts.tokensUsed);
          if (opts.baselineTokens) args.push("--baseline-tokens", opts.baselineTokens);
          if (opts.model) args.push("--model", opts.model);
          await run("record", args);
        });

      darwin
        .command("subscribe <nodeId>")
        .description("Subscribe to a Darwin node")
        .option("--topic <topic>", "Topic to subscribe to")
        .action(async (nodeId, opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [nodeId];
          if (opts.topic) args.push("--topic", opts.topic);
          await run("subscribe", args);
        });

      darwin
        .command("unsubscribe <nodeId>")
        .description("Unsubscribe from a node")
        .option("--topic <topic>", "Topic to unsubscribe from")
        .action(async (nodeId, opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [nodeId];
          if (opts.topic) args.push("--topic", opts.topic);
          await run("unsubscribe", args);
        });

      darwin
        .command("subscriptions")
        .description("View my subscriptions")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("subscriptions", []);
        });

      darwin
        .command("subscribers")
        .description("View who subscribes to me")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("subscribers", []);
        });

      darwin
        .command("catalog")
        .description("View channel catalog")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("catalog", []);
        });

      darwin
        .command("trust")
        .description("View or configure trust policy")
        .option("--mode <mode>", "Set accept mode: open, mutual, selective")
        .option("--block <nodeId>", "Block a node")
        .option("--unblock <nodeId>", "Unblock a node")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.mode) args.push("--mode", opts.mode);
          if (opts.block) args.push("--block", opts.block);
          if (opts.unblock) args.push("--unblock", opts.unblock);
          await run("trust", args);
        });

      darwin
        .command("network")
        .description("View peer graph topology")
        .action(async () => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("network", []);
        });

      darwin
        .command("leaderboard")
        .description("View model performance rankings")
        .option("--task-type <type>", "Filter by task type")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.taskType) args.push("--task-type", opts.taskType);
          await run("leaderboard", args);
        });

      darwin
        .command("sponsor")
        .description("View or add sponsor grants")
        .option("--add", "Add a new grant")
        .option("--sponsor <name>", "Sponsor name")
        .option("--model <model>", "Model name")
        .option("--budget <n>", "Token budget")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.add) args.push("--add");
          if (opts.sponsor) args.push("--sponsor", opts.sponsor);
          if (opts.model) args.push("--model", opts.model);
          if (opts.budget) args.push("--budget", opts.budget);
          await run("sponsor", args);
        });

      darwin
        .command("worker")
        .description("View/control Worker Pool status")
        .option("--enable", "Register and enable worker")
        .option("--disable", "Disable worker")
        .option("--scan", "Scan available tasks for matches")
        .option("--claim <taskId>", "Claim and complete a specific task")
        .option("--domains <list>", "Set worker domains (comma-separated)")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.enable) args.push("--enable");
          if (opts.disable) args.push("--disable");
          if (opts.scan) args.push("--scan");
          if (opts.claim) args.push("--claim", opts.claim);
          if (opts.domains) args.push("--domains", opts.domains);
          await run("worker", args);
        });

      darwin
        .command("publish-meta")
        .description("Publish meta-genes to Hub")
        .option("--dry-run", "Validate only")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = opts.dryRun ? ["--dry-run"] : [];
          await run("publish-meta", args);
        });

      darwin
        .command("dashboard")
        .description("Launch real-time dashboard")
        .option("--port <port>", "Server port", "3777")
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          await run("dashboard", ["--port", opts.port]);
        });
    },
    { commands: ["darwin"] },
  );
}
