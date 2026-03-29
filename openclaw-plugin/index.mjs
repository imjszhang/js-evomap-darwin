import nodePath from "node:path";
import nodeFs from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const EVENT_BUFFER_MAX = 100;
const eventBuffer = [];
let eventIdCounter = 0;

function pushEvent(type, message) {
  eventIdCounter++;
  const evt = { id: eventIdCounter, type, message, timestamp: new Date().toISOString() };
  eventBuffer.push(evt);
  if (eventBuffer.length > EVENT_BUFFER_MAX) {
    eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);
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
  });

  darwinInstance.use(new Mutator({ mutationRate: pluginCfg.mutationRate || 0.05 }));
  const trustPolicy = new TrustPolicy({ dataDir });
  const peerGraph = new PeerGraph({ dataDir, selfNodeId: darwinInstance.hub.nodeId });
  darwinInstance.use(new Subscription({ hub: darwinInstance.hub, dataDir, trustPolicy, peerGraph }));
  darwinInstance.use(new TaskMatcher({ hub: darwinInstance.hub, dataDir }));

  darwinInstance.on("fetch", (data) => {
    pushEvent("fetch", `Fetched ${data.total} assets, ingested ${data.ingested}`);
  });
  darwinInstance.on("record", (data) => {
    pushEvent("record", `Recorded: ${data.capsuleId?.slice(0, 16)}... fitness=${data.fitness?.toFixed(3) ?? '?'}`);
  });
  darwinInstance.on("evolve", () => {
    pushEvent("evolve", "Evolution cycle completed");
  });
  darwinInstance.on("error", (e) => {
    pushEvent("error", `${e.phase}: ${e.error}`);
  });
  darwinInstance.on("grant-consumed", (data) => {
    pushEvent("sponsor", `Grant ${data.grantId.slice(0, 16)}... consumed ${data.amount} tokens (${data.phase})`);
  });
  darwinInstance.on("task-matched", (data) => {
    pushEvent("task-matched", `Matched ${data.count} task(s), top: ${data.top?.task?.title || "?"} (score ${data.top?.matchScore})`);
  });
  darwinInstance.on("task-completed", (data) => {
    pushEvent("task-completed", `Completed task "${data.title}" → asset ${data.assetId?.slice(0, 16)}...`);
  });
  darwinInstance.on("task-failed", (data) => {
    pushEvent("task-failed", `Task ${data.taskId} failed: ${data.error}`);
  });
  darwinInstance.on("bootstrap", (data) => {
    pushEvent("bootstrap", `Bootstrap evaluated ${data.evaluated} capsule(s), avg score: ${data.avgScore}`);
  });
  darwinInstance.on("low-credit", (data) => {
    pushEvent("low-credit", `Low credits (${data.creditBalance}) — skipping Hub fetch to conserve resources`);
  });
  darwinInstance.on("report", (data) => {
    pushEvent("report", `Reported fitness for ${data.capsuleId?.slice(0, 16)}... (fitness=${data.fitness?.toFixed(3)}, samples=${data.samples})`);
  });
  darwinInstance.on("pending-event", (data) => {
    const type = data.type || data.event_type || "unknown";
    pushEvent("pending-event", `Hub event: ${type}`);
  });

  darwinInstance.setAgentCallback(async () => {
    pushEvent("evolve-think", "Agent-driven evolution cycle — darwin_think available");
  });

  return darwinInstance;
}

export default function register(api) {
  const pluginCfg = api.pluginConfig ?? {};

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

        const fetchResult = await darwin.fetchAndIngest();
        const status = darwin.getStatus();

        return jsonResult({
          phase: "evolve",
          fetched: fetchResult.total,
          ingested: fetchResult.ingested,
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
    path: `${ROUTE_PREFIX}/api/tasks`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const stats = darwin.worker?.getStats();
        sendJson(res, 200, {
          activeTasks: stats?.activeTasks ?? [],
          completedHistory: stats?.completedHistory ?? [],
          lastScanResults: stats?.lastScanResults ?? [],
        });
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
              entry.hubStatus = info?.status || info?.payload?.status || "published";
            } catch {
              // Hub unreachable — keep "unknown"
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
        const baseIntervalMs = pluginCfg.heartbeatIntervalMs || 300_000;
        let nextIntervalMs = baseIntervalMs;

        const runHeartbeat = async () => {
          try {
            const darwin = await getDarwin(pluginCfg);
            if (!darwin.hub.nodeId) {
              ctx.logger.warn("Heartbeat skipped: node not registered yet. Run darwin_evolve first.");
              return;
            }
            const result = await darwin.hub.heartbeat();
            darwin.setLastHeartbeat(result);
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
        if (_heartbeatTimerId) {
          clearTimeout(_heartbeatTimerId);
          _heartbeatTimerId = null;
        }
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
        .action(async (opts) => {
          const { run } = await import(pathToFileURL(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js")).href);
          const args = [];
          if (opts.top) args.push("--top", opts.top);
          await run("genes", args);
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
