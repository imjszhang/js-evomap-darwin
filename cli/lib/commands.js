import { Darwin } from "../../src/index.js";

const DATA_DIR = process.env.DARWIN_DATA_DIR || "./data";

function createDarwin() {
  return new Darwin({
    hubUrl: process.env.HUB_URL,
    dataDir: DATA_DIR,
    nodeId: process.env.NODE_ID,
    nodeSecret: process.env.NODE_SECRET,
  });
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      if (!flags._positional) flags._positional = [];
      flags._positional.push(args[i]);
    }
  }
  return flags;
}

// ── Commands ──────────────────────────────────────────────────────────────

async function cmdInit() {
  const darwin = createDarwin();
  console.log("Registering with EvoMap Hub...\n");

  try {
    const result = await darwin.init();
    console.log(`  Node ID:    ${result.nodeId}`);
    console.log(`  Claim URL:  ${result.claimUrl || "(none)"}`);
    console.log(`  Credits:    ${result.creditBalance ?? 0}`);
    console.log(`\n  Credentials saved to ${DATA_DIR}/credentials.json`);
    console.log(`\n  Visit the claim URL to bind this agent to your EvoMap account.`);
  } catch (err) {
    console.error(`  Registration failed: ${err.message}`);
    if (err.response?.correction) {
      console.error(`  Fix: ${err.response.correction.fix}`);
    }
    process.exit(1);
  }
}

async function cmdStatus() {
  const darwin = createDarwin();
  const s = darwin.getStatus();

  console.log("\n  ── Darwin Status ──\n");
  console.log(`  Node ID:         ${s.nodeId || "(not registered)"}`);
  console.log(`  Hub:             ${s.hubUrl}`);
  console.log(`  Running:         ${s.running}`);
  console.log(`  Mutator:         ${s.hasMutator ? "attached" : "not attached"}`);
  console.log(`  Peer Exchange:   ${s.hasPeerExchange ? "attached" : "not attached"}`);
  console.log("");
  console.log("  ── Gene Store ──");
  console.log(`  Genes:           ${s.geneStore.size} / ${s.geneStore.capacity}`);
  console.log(`  Avg Fitness:     ${s.geneStore.avgFitness.toFixed(3)}`);
  console.log(`  Top Fitness:     ${s.geneStore.topFitness.toFixed(3)}`);
  console.log("");
  console.log("  ── Fitness Tracker ──");
  console.log(`  Total Records:   ${s.fitness.totalRecords}`);
  console.log(`  Tracked:         ${s.fitness.trackedCapsules}`);
  console.log(`  Scored:          ${s.fitness.scoredCapsules}`);
  console.log(`  Avg Fitness:     ${s.fitness.avgFitness.toFixed(3)}`);
  console.log("");
}

async function cmdStart() {
  const darwin = createDarwin();

  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Running init first...\n");
    await darwin.init();
  }

  darwin.on("heartbeat", (res) => {
    const time = new Date().toISOString().slice(11, 19);
    console.log(`  [${time}] heartbeat ok — credits: ${res.creditBalance ?? "?"}`);
  });
  darwin.on("fetch", (res) => {
    console.log(`  [fetch] ${res.total} assets from Hub, ${res.ingested} ingested`);
  });
  darwin.on("evolve", () => {
    const s = darwin.getStatus();
    console.log(`  [evolve] genes: ${s.geneStore.size}, avg fitness: ${s.fitness.avgFitness.toFixed(3)}`);
  });
  darwin.on("error", (e) => {
    console.error(`  [error] ${e.phase}: ${e.error}`);
  });

  console.log("\n  ── Starting Darwin Evolution Loop ──\n");
  console.log(`  Node: ${darwin.hub.nodeId}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  await darwin.start();

  process.on("SIGINT", () => {
    console.log("\n  Stopping...");
    darwin.stop();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

async function cmdFitness(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin();

  if (flags["task-type"]) {
    const ranked = darwin.tracker.rank(flags["task-type"]);
    console.log(`\n  ── Fitness Ranking: ${flags["task-type"]} ──\n`);
    if (ranked.length === 0) {
      console.log("  No scored capsules for this task type.\n");
      return;
    }
    for (const r of ranked.slice(0, 20)) {
      const id = r.capsuleId.length > 20 ? r.capsuleId.slice(0, 20) + "..." : r.capsuleId;
      console.log(`  ${r.fitness.toFixed(3).padStart(6)}  ${(r.successRate * 100).toFixed(0).padStart(3)}%  (${r.samples} samples)  ${id}`);
    }
  } else {
    const ranked = darwin.tracker.rankAll();
    console.log("\n  ── Fitness Ranking (all) ──\n");
    if (ranked.length === 0) {
      console.log("  No scored capsules yet. Use 'darwin start' to begin tracking.\n");
      return;
    }
    for (const r of ranked.slice(0, 20)) {
      const id = r.capsuleId.length > 20 ? r.capsuleId.slice(0, 20) + "..." : r.capsuleId;
      const types = r.taskTypes.join(", ");
      console.log(`  ${r.fitness.toFixed(3).padStart(6)}  ${(r.successRate * 100).toFixed(0).padStart(3)}%  (${r.samples})  ${id}  [${types}]`);
    }
  }
  console.log("");
}

async function cmdGenes(args) {
  const flags = parseFlags(args);
  const top = parseInt(flags.top || "20", 10);
  const darwin = createDarwin();
  const ranked = darwin.store.ranked(top);

  console.log(`\n  ── Local Gene Pool (top ${top}) ──\n`);
  if (ranked.length === 0) {
    console.log("  Gene pool is empty. Use 'darwin start' to fetch from Hub.\n");
    return;
  }
  for (const g of ranked) {
    const id = g.assetId.length > 24 ? g.assetId.slice(0, 24) + "..." : g.assetId;
    const summary = g.capsule.summary?.slice(0, 50) || "(no summary)";
    console.log(`  ${(g.fitness ?? 0).toFixed(3).padStart(6)}  ${id}  ${summary}`);
  }
  console.log(`\n  Total: ${darwin.store.size} / ${darwin.store.capacity}\n`);
}

async function cmdPeers() {
  const { PeerExchange } = await import("../../src/peer-exchange.js");
  const darwin = createDarwin();
  const pe = new PeerExchange({ hub: darwin.hub, dataDir: DATA_DIR });
  const peers = pe.getPeers();

  console.log(`\n  ── Peers (${peers.length}) ──\n`);
  if (peers.length === 0) {
    console.log("  No peers discovered yet. Run 'darwin start' to discover neighbors.\n");
    return;
  }
  for (const p of peers) {
    console.log(`  ${p.nodeId.slice(0, 24)}...  trust: ${p.trust.toFixed(2)}  sent: ${p.sentGenes}  recv: ${p.receivedGenes}  seen: ${p.lastSeen}`);
  }
  console.log("");
}

async function cmdPublishMeta(args) {
  const flags = parseFlags(args);
  const dryRun = !!flags["dry-run"];
  const darwin = createDarwin();

  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Running init first...\n");
    await darwin.init();
  }

  const { getAllMetaGenes } = await import("../../src/meta-genes.js");
  const metaGenes = getAllMetaGenes();

  console.log(`\n  ── Publishing ${metaGenes.length} Meta-Genes ──\n`);

  for (const { name, bundle } of metaGenes) {
    const [gene, capsule, event] = bundle;
    console.log(`  ${name}`);
    console.log(`    Gene:    ${gene.asset_id.slice(0, 24)}...`);
    console.log(`    Capsule: ${capsule.asset_id.slice(0, 24)}...`);
    console.log(`    Event:   ${event.asset_id.slice(0, 24)}...`);

    if (dryRun) {
      console.log(`    [dry-run] Validating...`);
      try {
        const res = await darwin.hub.validate(bundle);
        const valid = res?.payload?.valid ?? res?.valid;
        console.log(`    Validation: ${valid ? "PASS" : "FAIL"}`);
        if (!valid && res?.payload?.computed_assets) {
          for (const a of res.payload.computed_assets) {
            if (!a.match) console.log(`      Mismatch: ${a.type} claimed=${a.claimed_asset_id?.slice(0, 20)} computed=${a.computed_asset_id?.slice(0, 20)}`);
          }
        }
      } catch (err) {
        console.log(`    Validation error: ${err.message}`);
      }
    } else {
      try {
        const res = await darwin.hub.publish(bundle);
        console.log(`    Published: ${res?.payload?.status || res?.status || "ok"}`);
      } catch (err) {
        console.log(`    Publish failed: ${err.message}`);
        if (err.response?.correction) {
          console.log(`    Fix: ${err.response.correction.fix}`);
        }
      }
    }
    console.log("");
  }
}

async function cmdDashboard(args) {
  const flags = parseFlags(args);
  const port = parseInt(flags.port || "3777", 10);
  const darwin = createDarwin();

  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Running init first...\n");
    await darwin.init();
  }

  const { startDashboardServer } = await import("./dashboard-server.js");
  console.log("\n  ── Darwin Dashboard ──\n");
  startDashboardServer(darwin, { port });

  // Also start the evolution loop so dashboard has live data
  darwin.on("heartbeat", () => {});
  await darwin.start();

  console.log(`  Evolution loop running. Press Ctrl+C to stop.\n`);

  process.on("SIGINT", () => {
    darwin.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

function cmdHelp() {
  console.log(`
  js-evomap-darwin — Evolution engine for EvoMap

  Usage: darwin <command> [options]

  Commands:
    init                    Register with EvoMap Hub
    status                  Show node status, gene pool, fitness stats
    start                   Start the evolution loop
    fitness [--task-type X] View fitness rankings
    genes [--top N]         View local gene pool
    peers                   View neighbor list
    publish-meta            Publish meta-genes to Hub
    dashboard               Launch real-time visualization
    help                    Show this help

  Environment:
    HUB_URL         EvoMap Hub URL (default: https://evomap.ai)
    NODE_ID         Node identity (auto-saved after init)
    NODE_SECRET     Node secret (auto-saved after init)
    DARWIN_DATA_DIR Data directory (default: ./data)
`);
}

// ── Router ──────────────────────────────────────────────────────────────

const COMMANDS = {
  init: cmdInit,
  status: cmdStatus,
  start: cmdStart,
  fitness: cmdFitness,
  genes: cmdGenes,
  peers: cmdPeers,
  "publish-meta": cmdPublishMeta,
  dashboard: cmdDashboard,
  help: cmdHelp,
};

export async function run(command, args = []) {
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`  Unknown command: ${command}\n`);
    cmdHelp();
    process.exit(1);
  }
  await handler(args);
}
