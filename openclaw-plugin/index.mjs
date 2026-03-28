import nodePath from "node:path";
import nodeFs from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

async function getDarwin(pluginCfg) {
  if (darwinInstance) return darwinInstance;

  const { Darwin } = await import(nodePath.join(PROJECT_ROOT, "src", "index.js"));
  const { Mutator } = await import(nodePath.join(PROJECT_ROOT, "src", "mutator.js"));
  const { PeerExchange } = await import(nodePath.join(PROJECT_ROOT, "src", "peer-exchange.js"));

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
  darwinInstance.use(new PeerExchange({ hub: darwinInstance.hub, dataDir }));

  return darwinInstance;
}

export default function register(api) {
  const pluginCfg = api.pluginConfig ?? {};

  // ── Tools ─────────────────────────────────────────────────────────────

  api.registerTool({
    name: "darwin_status",
    label: "Darwin: Status",
    description: "Show Darwin evolution engine status — node info, gene pool size, fitness stats, peer count.",
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
    description: "View discovered peer agents and their trust scores.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const darwin = await getDarwin(pluginCfg);
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

        const { getAllMetaGenes } = await import(nodePath.join(PROJECT_ROOT, "src", "meta-genes.js"));
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
        const { Sponsor } = await import(nodePath.join(PROJECT_ROOT, "src", "sponsor.js"));
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

  // ── Gateway HTTP Routes: Dashboard + REST API ───────────────────────

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}`,
    auth: "plugin",
    async handler(_req, res) {
      res.writeHead(301, { Location: `${ROUTE_PREFIX}/` });
      res.end();
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/`,
    auth: "plugin",
    async handler(_req, res) {
      serveStaticFile(res, nodePath.join(DASHBOARD_DIR, "index.html"));
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
          summary: g.capsule?.summary,
          triggers: g.capsule?.trigger,
        })));
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/peers`,
    auth: "plugin",
    async handler(_req, res) {
      try {
        const darwin = await getDarwin(pluginCfg);
        const peers = darwin.peers?.getPeers() ?? [];
        sendJson(res, 200, peers);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
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
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/{filePath}`,
    auth: "plugin",
    async handler(req, res) {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const subPath = decodeURIComponent(parsed.pathname.slice(ROUTE_PREFIX.length + 1));
      if (subPath.startsWith("api/")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const filePath = nodePath.normalize(nodePath.join(DASHBOARD_DIR, subPath));
      if (!filePath.startsWith(DASHBOARD_DIR)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (!nodeFs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      serveStaticFile(res, filePath);
    },
  });

  // ── Background Heartbeat Service ─────────────────────────────────────

  if (pluginCfg.heartbeatEnabled !== false) {
    const heartbeatDataDir = pluginCfg.dataDir || nodePath.join(PROJECT_ROOT, "data");

    api.registerService({
      id: "darwin-heartbeat",
      label: "Darwin Heartbeat",
      async start({ signal }) {
        const baseIntervalMs = pluginCfg.heartbeatIntervalMs || 300_000;
        let nextIntervalMs = baseIntervalMs;
        let timerId = null;

        const runHeartbeat = async () => {
          try {
            const darwin = await getDarwin(pluginCfg);
            if (!darwin.hub.nodeId) {
              api.logger.warn("Heartbeat skipped: node not registered yet. Run darwin_evolve first.");
              return;
            }
            const result = await darwin.hub.heartbeat();
            await saveHeartbeatState(heartbeatDataDir, result, darwin.hub.nodeId);
            if (result.nextHeartbeatMs && result.nextHeartbeatMs > 0) {
              nextIntervalMs = result.nextHeartbeatMs;
            }
            api.logger.debug(
              `Heartbeat OK | credits: ${result.creditBalance} | next: ${nextIntervalMs}ms`,
            );
          } catch (err) {
            api.logger.error(`Heartbeat failed: ${err.message}`);
          }
        };

        const scheduleNext = () => {
          if (signal.aborted) return;
          timerId = setTimeout(async () => {
            await runHeartbeat();
            scheduleNext();
          }, nextIntervalMs);
        };

        signal.addEventListener("abort", () => {
          if (timerId) clearTimeout(timerId);
        });

        await runHeartbeat();
        scheduleNext();
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
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          await run("init", []);
        });

      darwin
        .command("status")
        .description("Show node status, gene pool, fitness stats")
        .action(async () => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          await run("status", []);
        });

      darwin
        .command("start")
        .description("Start the evolution loop")
        .action(async () => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          await run("start", []);
        });

      darwin
        .command("fitness")
        .description("View fitness rankings")
        .option("--task-type <type>", "Filter by task type")
        .action(async (opts) => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          const args = [];
          if (opts.taskType) args.push("--task-type", opts.taskType);
          await run("fitness", args);
        });

      darwin
        .command("genes")
        .description("View local gene pool")
        .option("--top <n>", "Number of top genes to show")
        .action(async (opts) => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          const args = [];
          if (opts.top) args.push("--top", opts.top);
          await run("genes", args);
        });

      darwin
        .command("peers")
        .description("View peer network")
        .action(async () => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          await run("peers", []);
        });

      darwin
        .command("leaderboard")
        .description("View model performance rankings")
        .option("--task-type <type>", "Filter by task type")
        .action(async (opts) => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
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
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          const args = [];
          if (opts.add) args.push("--add");
          if (opts.sponsor) args.push("--sponsor", opts.sponsor);
          if (opts.model) args.push("--model", opts.model);
          if (opts.budget) args.push("--budget", opts.budget);
          await run("sponsor", args);
        });

      darwin
        .command("publish-meta")
        .description("Publish meta-genes to Hub")
        .option("--dry-run", "Validate only")
        .action(async (opts) => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          const args = opts.dryRun ? ["--dry-run"] : [];
          await run("publish-meta", args);
        });

      darwin
        .command("dashboard")
        .description("Launch real-time dashboard")
        .option("--port <port>", "Server port", "3777")
        .action(async (opts) => {
          const { run } = await import(nodePath.join(PROJECT_ROOT, "cli", "lib", "commands.js"));
          await run("dashboard", ["--port", opts.port]);
        });
    },
    { commands: ["darwin"] },
  );
}
