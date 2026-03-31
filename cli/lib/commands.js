import { Darwin } from "../../src/index.js";
import { getAllMetaGenes } from "../../src/meta-genes.js";
import { Mutator } from "../../src/mutator.js";
import { PeerExchange } from "../../src/peer-exchange.js";
import { Subscription } from "../../src/subscription.js";
import { TrustPolicy } from "../../src/trust-policy.js";
import { PeerGraph } from "../../src/peer-graph.js";
import { TaskMatcher } from "../../src/task-matcher.js";

const DATA_DIR = process.env.DARWIN_DATA_DIR || "./data";

function createDarwin({ withWorker = false, legacyPeers = false } = {}) {
  const darwin = new Darwin({
    hubUrl: process.env.HUB_URL,
    dataDir: DATA_DIR,
    nodeId: process.env.NODE_ID,
    nodeSecret: process.env.NODE_SECRET,
  });
  darwin.use(new Mutator());

  if (legacyPeers) {
    darwin.use(new PeerExchange({ hub: darwin.hub, dataDir: DATA_DIR }));
  } else {
    const trustPolicy = new TrustPolicy({ dataDir: DATA_DIR });
    const peerGraph = new PeerGraph({ dataDir: DATA_DIR, selfNodeId: darwin.hub.nodeId });
    darwin.use(new Subscription({ hub: darwin.hub, dataDir: DATA_DIR, trustPolicy, peerGraph }));
  }

  if (withWorker) {
    darwin.use(new TaskMatcher({ hub: darwin.hub, dataDir: DATA_DIR }));
  }
  return darwin;
}

/** Resolve Capsule asset_id against GeneStore (exact, or 64-char hex with sha256: prefix). */
function resolveAssetId(store, raw) {
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
  console.log(`  Subscription:    ${s.hasSubscription ? `attached (${s.subscription?.subscriptions ?? 0} subs, ${s.subscription?.subscribers ?? 0} subscribers)` : "not attached"}`);
  console.log(`  Peer Exchange:   ${s.hasPeerExchange ? "attached (legacy)" : "not attached"}`);
  console.log(`  Peers:           ${s.peerCount}`);
  console.log(`  Sponsor:         ${s.hasSponsor ? `${s.sponsor?.totalGrants ?? 0} grants` : "not attached"}`);
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

async function cmdGenesRemove(args) {
  const flags = parseFlags(args);
  const raw = flags._positional?.[0];
  if (!raw) {
    console.log(`
  Usage: darwin genes-remove <assetId>
         darwin genes remove <assetId>
         darwin genes --remove <assetId>

  <assetId> is the Capsule asset_id (e.g. sha256:... or 64-char hex).
`);
    return;
  }
  const darwin = createDarwin();
  const id = resolveAssetId(darwin.store, raw);
  if (!id) {
    console.error(`\n  No gene in pool matching: ${raw}\n`);
    process.exit(1);
  }
  const ok = darwin.store.remove(id);
  if (!ok) {
    console.error(`\n  Failed to remove ${id}\n`);
    process.exit(1);
  }
  console.log(`\n  Removed: ${id}`);
  console.log(`  Pool:    ${darwin.store.size} / ${darwin.store.capacity}\n`);
}

async function cmdGenesDedupe(args) {
  const flags = parseFlags(args);
  const dryRun = flags.dryRun === true || flags["dry-run"] === true;
  const darwin = createDarwin();
  const preferred = new Set(
    getAllMetaGenes().map(({ bundle }) => bundle[1]?.asset_id).filter(Boolean),
  );
  const { removed, groupsWithDuplicates } = darwin.store.deduplicateByContent({
    preferredIds: preferred,
    dryRun,
  });
  const mode = dryRun ? "Dry-run (no changes)" : "Removed";
  console.log(`\n  ── Gene pool dedupe — ${mode} ──\n`);
  console.log(`  Duplicate groups: ${groupsWithDuplicates}`);
  console.log(`  Entries ${dryRun ? "would remove" : "removed"}: ${removed.length}`);
  for (const id of removed) {
    const short = id.length > 56 ? `${id.slice(0, 28)}...${id.slice(-12)}` : id;
    console.log(`    ${short}`);
  }
  console.log(`\n  Pool: ${darwin.store.size} / ${darwin.store.capacity}\n`);
}

async function cmdGenes(args) {
  const flags = parseFlags(args);
  if (flags._positional?.[0] === "dedupe") {
    await cmdGenesDedupe(args.slice(1));
    return;
  }
  if (flags._positional?.[0] === "remove") {
    const raw = flags._positional[1] || flags.remove;
    if (!raw) {
      console.log("\n  Usage: darwin genes remove <assetId>\n");
      return;
    }
    await cmdGenesRemove([raw]);
    return;
  }
  if (flags.remove && flags.remove !== true && typeof flags.remove === "string") {
    await cmdGenesRemove([flags.remove]);
    return;
  }

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

async function cmdSelect(args) {
  const flags = parseFlags(args);
  const taskType = flags._positional?.[0];
  if (!taskType) {
    console.log("\n  Usage: darwin select <taskType> [--count N]\n");
    return;
  }
  const count = parseInt(flags.count || "1", 10);
  const darwin = createDarwin();

  if (count > 1) {
    const candidates = darwin.selector.rankCandidates(taskType);
    console.log(`\n  ── Top ${count} Capsules for "${taskType}" ──\n`);
    if (candidates.length === 0) {
      console.log(`  No capsules found for task type "${taskType}".\n`);
      return;
    }
    for (const c of candidates.slice(0, count)) {
      const id = c.capsule?.asset_id || "?";
      const shortId = id.length > 24 ? id.slice(0, 24) + "..." : id;
      console.log(`  ${shortId}  fitness: ${c.fitness ?? "?"} (${c.samples} samples)  source: ${c.source}`);
      if (c.capsule?.strategy?.length) {
        console.log(`    strategy: ${c.capsule.strategy.length} step(s)`);
      }
    }
    console.log("");
    return;
  }

  const result = darwin.selectCapsule(taskType);
  if (!result) {
    console.log(`\n  No capsules found for task type "${taskType}".\n`);
    return;
  }

  const cap = result.capsule;
  console.log(`\n  ── Selected Capsule for "${taskType}" ──\n`);
  console.log(`  Asset ID:   ${cap.asset_id}`);
  console.log(`  Reason:     ${result.reason}`);
  console.log(`  Source:     ${result.source}`);
  if (cap.summary) console.log(`  Summary:    ${cap.summary}`);
  if (cap.content) {
    console.log(`\n  ── Content ──\n`);
    console.log(`  ${cap.content.slice(0, 500)}`);
  }
  if (cap.strategy?.length) {
    console.log(`\n  ── Strategy (${cap.strategy.length} steps) ──\n`);
    for (let i = 0; i < cap.strategy.length; i++) {
      console.log(`  ${i + 1}. ${cap.strategy[i]}`);
    }
  }
  console.log(`\n  Use 'darwin record ${cap.asset_id} ${taskType} --success' after completing the task.\n`);
}

async function cmdRecord(args) {
  const flags = parseFlags(args);
  const positional = flags._positional || [];
  const capsuleId = positional[0];
  const taskType = positional[1];

  if (!capsuleId || !taskType) {
    console.log("\n  Usage: darwin record <capsuleId> <taskType> --success|--fail [--tokens-used N] [--baseline-tokens N] [--model M]\n");
    return;
  }

  const success = flags.success === true || (flags.fail ? false : undefined);
  if (success === undefined) {
    console.log("\n  Must specify --success or --fail.\n");
    return;
  }

  const darwin = createDarwin();
  const { fitness } = darwin.recordUsage(capsuleId, taskType, {
    success,
    tokensUsed: parseInt(flags["tokens-used"] || "0", 10),
    baselineTokens: parseInt(flags["baseline-tokens"] || "0", 10),
    model: flags.model || undefined,
  });

  const totalSamples = darwin.tracker.getSampleCount(capsuleId);
  console.log(`\n  ── Recorded ──\n`);
  console.log(`  Capsule:   ${capsuleId.length > 32 ? capsuleId.slice(0, 32) + "..." : capsuleId}`);
  console.log(`  Task Type: ${taskType}`);
  console.log(`  Success:   ${success}`);
  console.log(`  Fitness:   ${fitness !== null ? fitness.toFixed(3) : "(need more samples)"}`);
  console.log(`  Samples:   ${totalSamples}`);
  console.log("");
}

async function cmdPeers() {
  const darwin = createDarwin();

  // Subscription mode: show PeerGraph Darwin nodes + subscription status
  if (darwin.subscription) {
    const graph = darwin.subscription.graph;
    const darwinNodes = graph.getDarwinNodes();
    const subs = new Set(darwin.subscription.getSubscriptions().map((s) => s.nodeId));
    const subscribers = new Set(darwin.subscription.getSubscribers().map((s) => s.nodeId));

    console.log(`\n  ── Peers (${darwinNodes.length} Darwin nodes) ──\n`);
    if (darwinNodes.length === 0) {
      console.log("  No Darwin peers discovered yet. Run 'darwin start' to discover neighbors.\n");
      console.log("  Tip: use 'darwin network' for full topology, 'darwin subscriptions' for subscriptions.\n");
      return;
    }
    for (const p of darwinNodes) {
      const id = p.nodeId.length > 24 ? p.nodeId.slice(0, 24) + "..." : p.nodeId;
      const relation = [];
      if (subs.has(p.nodeId)) relation.push("subscribed");
      if (subscribers.has(p.nodeId)) relation.push("subscriber");
      const rel = relation.length > 0 ? relation.join("+") : "known";
      const source = p.discoveredFrom ? "gossip" : "directory";
      console.log(`  ${id}  fitness: ${p.reportedFitness.toFixed(2)}  [${rel}]  via: ${source}`);
    }
    console.log("");
    return;
  }

  // Legacy PeerExchange mode
  const peers = darwin.peers?.getPeers() ?? [];
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

async function cmdLeaderboard(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin();
  const taskType = flags["task-type"];
  const ranked = darwin.tracker.rankByModel(taskType);

  const title = taskType ? `Model Leaderboard: ${taskType}` : "Model Leaderboard (all tasks)";
  console.log(`\n  ── ${title} ──\n`);

  if (ranked.length === 0) {
    console.log("  No model performance data yet. Record usage with model field to populate.\n");
    return;
  }

  console.log("  Rank  Model            Fitness  Success  Avg Tokens  Samples");
  console.log("  ────  ───────────────  ───────  ───────  ──────────  ───────");
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const model = (r.model || "unknown").padEnd(15);
    console.log(`  #${String(i + 1).padEnd(3)}  ${model}  ${r.avgFitness.toFixed(3).padStart(7)}  ${(r.successRate * 100).toFixed(0).padStart(5)}%  ${String(r.avgTokens).padStart(10)}  ${String(r.samples).padStart(7)}`);
  }
  console.log("");
}

async function cmdSponsor(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin();

  if (flags.add) {
    const { Sponsor } = await import("../../src/sponsor.js");
    const sponsor = darwin.sponsor || new Sponsor({ dataDir: DATA_DIR });
    const grant = sponsor.addGrant({
      sponsorId: flags.sponsor || "demo-sponsor",
      model: flags.model || "demo-model",
      grantType: flags.type || "mutation",
      tokenBudget: parseInt(flags.budget || "100000", 10),
      rewardThreshold: parseFloat(flags.threshold || "0.8"),
      rewardTokens: parseInt(flags.reward || "50000", 10),
    });
    console.log(`\n  Grant created: ${grant.grantId}`);
    console.log(`  Sponsor: ${grant.sponsorId} / ${grant.model}`);
    console.log(`  Budget:  ${grant.tokenBudget.toLocaleString()} tokens\n`);
    return;
  }

  const { Sponsor } = await import("../../src/sponsor.js");
  const sponsor = darwin.sponsor || new Sponsor({ dataDir: DATA_DIR });
  const stats = sponsor.getStats();

  console.log("\n  ── Sponsor Grants ──\n");
  if (stats.totalGrants === 0) {
    console.log("  No sponsor grants. Use 'darwin sponsor --add --sponsor <name> --model <model> --budget <n>' to add one.\n");
    return;
  }

  console.log(`  Total Grants:     ${stats.totalGrants}`);
  console.log(`  Total Budget:     ${stats.totalBudget.toLocaleString()} tokens`);
  console.log(`  Total Used:       ${stats.totalUsed.toLocaleString()} tokens`);
  console.log(`  Remaining:        ${stats.totalRemaining.toLocaleString()} tokens`);
  console.log(`  Utilization:      ${(stats.utilizationRate * 100).toFixed(1)}%`);
  console.log(`  Rewards:          ${stats.rewardsTriggered} (${stats.rewardTokensAwarded.toLocaleString()} tokens awarded)`);
  console.log("");

  if (Object.keys(stats.bySponsor).length > 0) {
    console.log("  ── By Sponsor ──");
    for (const [name, s] of Object.entries(stats.bySponsor)) {
      console.log(`  ${name} (${s.model || "multi"}): ${s.used.toLocaleString()} / ${s.budget.toLocaleString()} tokens [${s.grants} grant(s)]`);
    }
    console.log("");
  }
}

async function cmdWorker(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin({ withWorker: true });

  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    process.exit(1);
  }

  const worker = darwin.worker;

  if (flags.enable) {
    const domains = flags.domains ? flags.domains.split(",") : undefined;
    console.log("\n  Registering as worker...\n");
    try {
      await worker.register({ enabled: true, domains });
      console.log("  Worker enabled.");
      if (domains) console.log(`  Domains: ${domains.join(", ")}`);
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
    }
    console.log("");
    return;
  }

  if (flags.disable) {
    console.log("\n  Disabling worker...\n");
    try {
      await worker.disable();
      console.log("  Worker disabled.\n");
    } catch (err) {
      console.error(`  Failed: ${err.message}\n`);
    }
    return;
  }

  if (flags.domains) {
    const domains = flags.domains.split(",").map((d) => d.trim());
    try {
      await worker.register({ enabled: worker.enabled, domains });
      console.log(`\n  Domains updated: ${domains.join(", ")}\n`);
    } catch (err) {
      console.error(`\n  Failed: ${err.message}\n`);
    }
    return;
  }

  if (flags.scan) {
    console.log("\n  Scanning available tasks...\n");
    try {
      const hb = await darwin.hub.heartbeat();
      darwin.setLastHeartbeat(hb);
      const tasks = hb?.raw?.available_tasks || [];
      if (tasks.length === 0) {
        console.log("  No tasks available right now.\n");
        return;
      }
      const candidates = worker.scan(tasks, darwin.store);
      console.log(`  Found ${tasks.length} tasks, ${candidates.length} match(es):\n`);
      for (const c of candidates) {
        console.log(`  ${c.matchScore.toFixed(3).padStart(6)}  ${c.task.task_id?.slice(0, 16) || "?"}  ${c.task.title || "(untitled)"}`);
        console.log(`         signals: ${c.matchedSignals.join(", ")} (${c.matchedSignals.length}/${c.totalSignals})`);
      }
    } catch (err) {
      console.error(`  Scan failed: ${err.message}`);
    }
    console.log("");
    return;
  }

  if (flags.claim) {
    const taskId = flags.claim;
    console.log(`\n  Claiming task ${taskId}...\n`);
    try {
      const hb = await darwin.hub.heartbeat();
      darwin.setLastHeartbeat(hb);
      const tasks = hb?.raw?.available_tasks || [];
      const task = tasks.find((t) => t.task_id === taskId);
      if (!task) {
        console.error("  Task not found in available list.\n");
        return;
      }
      const match = worker.matchTask(task, darwin.store);
      if (!match) {
        console.error("  No matching gene for this task.\n");
        return;
      }
      const result = await worker.claimAndComplete(match, darwin);
      console.log(`  Claimed & completed: assignment ${result.assignmentId}`);
      console.log(`  Submitted asset: ${result.assetId?.slice(0, 24)}...\n`);
    } catch (err) {
      console.error(`  Claim failed: ${err.message}\n`);
    }
    return;
  }

  // Default: show worker status
  const stats = worker.getStats();
  console.log("\n  ── Worker Status ──\n");
  console.log(`  Registered:  ${stats.registered}`);
  console.log(`  Enabled:     ${stats.workerEnabled}`);
  console.log(`  Auto Submit: ${stats.autoSubmit}`);
  console.log(`  Domains:     ${stats.domains.length > 0 ? stats.domains.join(", ") : "(any)"}`);
  console.log("");
  console.log("  ── Counters ──");
  console.log(`  Scanned:     ${stats.counters.scanned}`);
  console.log(`  Matched:     ${stats.counters.matched}`);
  console.log(`  Claimed:     ${stats.counters.claimed}`);
  console.log(`  Completed:   ${stats.counters.completed}`);
  console.log(`  Failed:      ${stats.counters.failed}`);
  console.log("");

  if (stats.activeTasks.length > 0) {
    console.log("  ── Active Tasks ──");
    for (const t of stats.activeTasks) {
      console.log(`  ${t.status.padEnd(10)}  ${t.taskId?.slice(0, 16) || "?"}  ${t.title || "(untitled)"}  claimed: ${t.claimedAt}`);
    }
    console.log("");
  }

  if (stats.completedHistory.length > 0) {
    console.log("  ── Recent Completed ──");
    for (const t of stats.completedHistory) {
      console.log(`  ${t.taskId?.slice(0, 16) || "?"}  ${t.title || "(untitled)"}  bounty: ${t.bounty ?? "?"}  at: ${t.completedAt}`);
    }
    console.log("");
  }
}

async function cmdSubscribe(args) {
  const flags = parseFlags(args);
  const nodeId = flags._positional?.[0];
  if (!nodeId) {
    console.log("\n  Usage: darwin subscribe <nodeId> [--topic <topic>]\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }

  const topics = flags.topic ? [flags.topic] : [];
  const result = await darwin.subscription.subscribe(nodeId, topics);

  if (result.ok) {
    console.log(`\n  Subscribed to ${nodeId}${topics.length ? ` (topics: ${topics.join(", ")})` : ""}\n`);
  } else {
    console.log(`\n  Subscribe failed: ${result.reason}\n`);
  }
}

async function cmdUnsubscribe(args) {
  const flags = parseFlags(args);
  const nodeId = flags._positional?.[0];
  if (!nodeId) {
    console.log("\n  Usage: darwin unsubscribe <nodeId> [--topic <topic>]\n");
    return;
  }
  const darwin = createDarwin();
  const topics = flags.topic ? [flags.topic] : [];
  await darwin.subscription.unsubscribe(nodeId, topics);
  console.log(`\n  Unsubscribed from ${nodeId}${topics.length ? ` (topics: ${topics.join(", ")})` : " (all topics)"}\n`);
}

async function cmdSubscriptions() {
  const darwin = createDarwin();
  const subs = darwin.subscription?.getSubscriptions() ?? [];

  console.log(`\n  ── My Subscriptions (${subs.length}) ──\n`);
  if (subs.length === 0) {
    console.log("  No active subscriptions. Use 'darwin subscribe <nodeId>' to subscribe.\n");
    return;
  }

  for (const s of subs) {
    const id = s.nodeId.length > 24 ? s.nodeId.slice(0, 24) + "..." : s.nodeId;
    const topics = s.topics.length > 0 ? s.topics.join(", ") : "(all)";
    console.log(`  ${id}  trust: ${s.trust.toFixed(2)}  recv: ${s.deliveriesReceived}  useful: ${s.genesUseful}  topics: ${topics}`);
  }
  console.log("");
}

async function cmdSubscribers() {
  const darwin = createDarwin();
  const subs = darwin.subscription?.getSubscribers() ?? [];

  console.log(`\n  ── My Subscribers (${subs.length}) ──\n`);
  if (subs.length === 0) {
    console.log("  No subscribers yet. Other Darwin nodes will discover and subscribe to you.\n");
    return;
  }

  for (const s of subs) {
    const id = s.nodeId.length > 24 ? s.nodeId.slice(0, 24) + "..." : s.nodeId;
    const topics = s.topics.length > 0 ? s.topics.join(", ") : "(all)";
    console.log(`  ${id}  feedback: ${s.feedbackScore.toFixed(2)}  sent: ${s.deliveriesSent}  topics: ${topics}`);
  }
  console.log("");
}

async function cmdCatalog(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin();
  const catalog = darwin.subscription?.buildCatalog(darwin);

  if (!catalog) {
    console.log("\n  Subscription module not attached.\n");
    return;
  }

  console.log(`\n  ── Channel Catalog ──\n`);
  console.log(`  Subscribers: ${catalog.subscriberCount}\n`);

  if (catalog.channels.length === 0) {
    console.log("  No channels yet. Ingest genes with 'darwin start' to populate.\n");
    return;
  }

  console.log("  Topic                     Genes  Avg Fitness  Samples");
  console.log("  ────────────────────────  ─────  ──────────  ───────");
  for (const ch of catalog.channels) {
    const topic = ch.topic.padEnd(24);
    console.log(`  ${topic}  ${String(ch.genes).padStart(5)}  ${ch.avgFitness.toFixed(3).padStart(10)}  ${String(ch.samples).padStart(7)}`);
  }
  console.log("");
}

async function cmdTrust(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin();
  const policy = darwin.subscription?.policy;

  if (!policy) {
    console.log("\n  Subscription module not attached.\n");
    return;
  }

  if (flags.mode) {
    const ok = policy.setAcceptMode(flags.mode);
    if (ok) {
      console.log(`\n  Accept mode set to: ${flags.mode}\n`);
    } else {
      console.log(`\n  Invalid mode. Use: open, mutual, or selective\n`);
    }
    return;
  }

  if (flags.block) {
    policy.block(flags.block);
    console.log(`\n  Blocked node: ${flags.block}\n`);
    return;
  }

  if (flags.unblock) {
    const removed = policy.unblock(flags.unblock);
    console.log(removed
      ? `\n  Unblocked node: ${flags.unblock}\n`
      : `\n  Node ${flags.unblock} was not in block list.\n`);
    return;
  }

  const stats = policy.getStats();
  console.log("\n  ── Trust Policy ──\n");
  console.log(`  Accept Mode:    ${stats.acceptMode}`);
  console.log(`  Threshold:      ${stats.selectiveThreshold} (for selective mode)`);
  console.log(`  Max Subscribers: ${stats.maxSubscribers}`);
  console.log(`  Max Subscriptions: ${stats.maxSubscriptions}`);
  console.log(`  Blocked Nodes:  ${stats.blockedCount}`);
  if (stats.blockedNodes.length > 0) {
    for (const id of stats.blockedNodes) {
      console.log(`    - ${id}`);
    }
  }
  console.log("");
}

async function cmdNetwork() {
  const darwin = createDarwin();
  const graph = darwin.subscription?.graph;

  if (!graph) {
    console.log("\n  Subscription module not attached.\n");
    return;
  }

  const stats = graph.getStats();
  const subStats = darwin.subscription.getStats();

  console.log("\n  ── Network Topology ──\n");
  console.log(`  Total Known Peers:   ${stats.totalPeers}`);
  console.log(`  Darwin Nodes:        ${stats.darwinNodes}`);
  console.log(`  Contacted:           ${stats.contacted}`);
  console.log(`  From Hub Directory:  ${stats.fromDirectory}`);
  console.log(`  From Gossip:         ${stats.fromGossip}`);
  console.log("");
  console.log("  ── Subscription Stats ──");
  console.log(`  My Subscriptions:    ${subStats.subscriptions}`);
  console.log(`  My Subscribers:      ${subStats.subscribers}`);
  console.log(`  Avg Trust:           ${subStats.avgTrust.toFixed(3)}`);
  console.log(`  Avg Feedback Score:  ${subStats.avgFeedbackScore.toFixed(3)}`);
  console.log(`  Pending Deliveries:  ${subStats.pendingDeliveries}`);
  console.log("");
}

// ── Hub Discovery ────────────────────────────────────────────────────────

async function cmdHubStats() {
  const darwin = createDarwin();
  console.log("\n  Fetching Hub stats...\n");
  try {
    const res = await darwin.hub.getStats();
    const data = res?.payload ?? res;
    if (typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    } else {
      console.log(`  ${JSON.stringify(data, null, 2)}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdHubHelp(args) {
  const flags = parseFlags(args);
  const query = flags._positional?.join(" ") || "";
  if (!query) {
    console.log("\n  Usage: darwin hub-help <query>\n");
    console.log("  Examples:");
    console.log("    darwin hub-help marketplace");
    console.log("    darwin hub-help /a2a/publish");
    console.log("    darwin hub-help 任务\n");
    return;
  }
  const darwin = createDarwin();
  try {
    const res = await darwin.hub.getHelp(query);
    const data = res?.payload ?? res;
    if (data.title) console.log(`\n  ── ${data.title} ──\n`);
    if (data.summary) console.log(`  ${data.summary}\n`);
    if (data.content) console.log(data.content);
    if (data.related_endpoints?.length) {
      console.log("  Related endpoints:");
      for (const ep of data.related_endpoints) console.log(`    ${ep}`);
    }
    if (data.related_concepts?.length) {
      console.log("  Related concepts:");
      for (const c of data.related_concepts) console.log(`    ${c}`);
    }
  } catch (err) {
    console.error(`\n  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdHubWiki() {
  const darwin = createDarwin();
  console.log("\n  Fetching full wiki...\n");
  try {
    const res = await darwin.hub.getWikiFull();
    const data = res?.payload ?? res;
    if (typeof data === "string") {
      console.log(data);
    } else if (data.docs) {
      console.log(`  ${data.count ?? data.docs.length} documents:\n`);
      for (const doc of data.docs) {
        console.log(`  ── ${doc.slug} ──`);
        console.log(`  ${(doc.content || "").slice(0, 200)}...\n`);
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdNodeInfo(args) {
  const flags = parseFlags(args);
  const nodeId = flags._positional?.[0];
  const darwin = createDarwin();
  const target = nodeId || darwin.hub.nodeId;
  if (!target) {
    console.log("\n  Usage: darwin node-info [nodeId]\n  (defaults to own node)\n");
    return;
  }
  console.log(`\n  Fetching info for ${target}...\n`);
  try {
    const res = await darwin.hub.getNodeInfo(target);
    const data = res?.payload ?? res;
    if (typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    } else {
      console.log(`  ${JSON.stringify(data, null, 2)}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

// ── Tasks & Bounties ─────────────────────────────────────────────────────

async function cmdTasks() {
  const darwin = createDarwin();
  console.log("\n  Fetching open tasks from Hub...\n");
  try {
    const res = await darwin.hub.getTaskList();
    const tasks = res?.tasks ?? res?.payload?.tasks ?? (Array.isArray(res) ? res : []);
    if (tasks.length === 0) {
      console.log("  No open tasks right now.\n");
      return;
    }
    console.log(`  ${tasks.length} task(s):\n`);
    for (const t of tasks) {
      const id = (t.task_id || t.id || "?").slice(0, 20);
      const bounty = t.bounty != null ? `¤${t.bounty}` : "";
      console.log(`  ${id.padEnd(22)} ${(t.status || "open").padEnd(10)} ${bounty.padStart(6)}  ${t.title || t.description || "(untitled)"}`);
      const sigs = t.signals;
      const sigLine = Array.isArray(sigs) ? sigs.join(", ") : typeof sigs === "string" ? sigs : "";
      if (sigLine) console.log(`    signals: ${sigLine}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdMyTasks() {
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log("\n  Fetching my tasks...\n");
  try {
    const res = await darwin.hub.getMyTasks();
    const tasks = res?.tasks ?? res?.payload?.tasks ?? (Array.isArray(res) ? res : []);
    if (tasks.length === 0) {
      console.log("  No tasks found for this node.\n");
      return;
    }
    console.log(`  ${tasks.length} task(s):\n`);
    for (const t of tasks) {
      const id = (t.task_id || t.id || "?").slice(0, 20);
      const bounty = t.bounty != null ? `¤${t.bounty}` : "";
      console.log(`  ${id.padEnd(22)} ${(t.status || "?").padEnd(12)} ${bounty.padStart(6)}  ${t.title || "(untitled)"}`);
      if (t.completed_at) console.log(`    completed: ${t.completed_at}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdTaskClaim(args) {
  const flags = parseFlags(args);
  const taskId = flags._positional?.[0];
  if (!taskId) {
    console.log("\n  Usage: darwin task-claim <taskId>\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log(`\n  Claiming task ${taskId}...\n`);
  try {
    const res = await darwin.hub.claimTask(taskId);
    console.log(`  Claimed: ${res?.assignment_id || res?.payload?.assignment_id || "ok"}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    if (err.response?.correction) console.error(`  Fix: ${err.response.correction.fix}`);
  }
  console.log("");
}

async function cmdTaskComplete(args) {
  const flags = parseFlags(args);
  const taskId = flags._positional?.[0];
  const assetId = flags._positional?.[1] || flags.asset;
  if (!taskId || !assetId) {
    console.log("\n  Usage: darwin task-complete <taskId> <assetId>\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log(`\n  Completing task ${taskId}...\n`);
  try {
    const res = await darwin.hub.completeTask(taskId, assetId);
    const reward = res?.reward ?? res?.payload?.reward;
    console.log(`  Completed.${reward != null ? ` Reward: ¤${reward}` : ""}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    if (err.response?.correction) console.error(`  Fix: ${err.response.correction.fix}`);
  }
  console.log("");
}

// ── Asset Discovery ──────────────────────────────────────────────────────

async function cmdAssets(args) {
  const flags = parseFlags(args);
  const darwin = createDarwin();

  let label, fetcher;
  if (flags.ranked) {
    label = "Ranked Assets";
    fetcher = () => darwin.hub.getRankedAssets();
  } else if (flags.trending) {
    label = "Trending Assets";
    fetcher = () => darwin.hub.getTrending();
  } else {
    label = "Promoted Assets";
    fetcher = () => darwin.hub.getPromotedAssets();
  }

  console.log(`\n  ── ${label} ──\n`);
  try {
    const res = await fetcher();
    const assets = res?.assets ?? res?.payload?.assets ?? (Array.isArray(res) ? res : []);
    if (assets.length === 0) {
      console.log("  No assets found.\n");
      return;
    }
    for (const a of assets.slice(0, 30)) {
      const id = (a.asset_id || "?").slice(0, 24);
      const score = a.score != null ? a.score.toFixed(2) : a.gdi != null ? a.gdi.toFixed(2) : "";
      console.log(`  ${id.padEnd(26)} ${(a.type || "").padEnd(10)} ${score.padStart(6)}  ${a.summary || "(no summary)"}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdAsset(args) {
  const flags = parseFlags(args);
  const assetId = flags._positional?.[0];
  if (!assetId) {
    console.log("\n  Usage: darwin asset <assetId>\n");
    return;
  }
  const darwin = createDarwin();
  console.log(`\n  Fetching asset ${assetId.slice(0, 24)}...\n`);
  try {
    const res = await darwin.hub.getAsset(assetId);
    const data = res?.payload ?? res;
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdAssetsSearch(args) {
  const flags = parseFlags(args);
  const signals = flags._positional?.join(",") || "";
  if (!signals) {
    console.log("\n  Usage: darwin assets-search <signal1> [signal2] ...\n");
    return;
  }
  const darwin = createDarwin();
  console.log(`\n  Searching assets by signals: ${signals}...\n`);
  try {
    const res = await darwin.hub.searchAssets(signals);
    const assets = res?.assets ?? res?.payload?.assets ?? (Array.isArray(res) ? res : []);
    if (assets.length === 0) {
      console.log("  No matching assets.\n");
      return;
    }
    for (const a of assets.slice(0, 30)) {
      const id = (a.asset_id || "?").slice(0, 24);
      console.log(`  ${id.padEnd(26)} ${(a.type || "").padEnd(10)} ${a.summary || "(no summary)"}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdAssetsSemantic(args) {
  const flags = parseFlags(args);
  const query = flags._positional?.join(" ") || "";
  if (!query) {
    console.log("\n  Usage: darwin assets-semantic <query>\n");
    return;
  }
  const darwin = createDarwin();
  console.log(`\n  Semantic search: "${query}"...\n`);
  try {
    const res = await darwin.hub.semanticSearch(query);
    const assets = res?.assets ?? res?.payload?.assets ?? (Array.isArray(res) ? res : []);
    if (assets.length === 0) {
      console.log("  No matching assets.\n");
      return;
    }
    for (const a of assets.slice(0, 20)) {
      const id = (a.asset_id || "?").slice(0, 24);
      const score = a.similarity != null ? a.similarity.toFixed(3) : "";
      console.log(`  ${id.padEnd(26)} ${score.padStart(6)}  ${a.summary || "(no summary)"}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

// ── DM ───────────────────────────────────────────────────────────────────

async function cmdDmSend(args) {
  const flags = parseFlags(args);
  const toNodeId = flags._positional?.[0];
  const message = flags._positional?.slice(1).join(" ") || flags.message || "";
  if (!toNodeId || !message) {
    console.log("\n  Usage: darwin dm-send <nodeId> <message>\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  try {
    await darwin.hub.sendDM(toNodeId, { text: message });
    console.log(`\n  DM sent to ${toNodeId}.\n`);
  } catch (err) {
    console.error(`\n  Failed: ${err.message}\n`);
  }
}

async function cmdDmInbox() {
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log("\n  Fetching DM inbox...\n");
  try {
    const res = await darwin.hub.pollDM();
    const messages = res?.messages ?? res?.payload?.messages ?? (Array.isArray(res) ? res : []);
    if (messages.length === 0) {
      console.log("  Inbox is empty.\n");
      return;
    }
    for (const m of messages) {
      const from = m.from || m.sender_id || "?";
      const time = m.timestamp || "";
      const text = typeof m.payload === "string" ? m.payload : m.payload?.text || JSON.stringify(m.payload);
      console.log(`  [${time}] ${from}: ${text}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

// ── Credits & Earnings ───────────────────────────────────────────────────

async function cmdCredits() {
  const darwin = createDarwin();
  console.log("\n  ── Credit Economy ──\n");
  try {
    const [price, econ] = await Promise.allSettled([
      darwin.hub.getCreditPrice(),
      darwin.hub.getCreditEconomics(),
    ]);
    if (price.status === "fulfilled") {
      const p = price.value?.payload ?? price.value;
      if (typeof p === "object") {
        for (const [k, v] of Object.entries(p)) {
          console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
        }
      } else {
        console.log(`  Price: ${JSON.stringify(p)}`);
      }
    }
    if (econ.status === "fulfilled") {
      const e = econ.value?.payload ?? econ.value;
      if (typeof e === "object") {
        console.log("");
        for (const [k, v] of Object.entries(e)) {
          console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
        }
      }
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdCreditsEstimate(args) {
  const flags = parseFlags(args);
  const amount = flags._positional?.[0];
  if (!amount) {
    console.log("\n  Usage: darwin credits-estimate <amount>\n");
    return;
  }
  const darwin = createDarwin();
  try {
    const res = await darwin.hub.getCreditEstimate(amount);
    const data = res?.payload ?? res;
    console.log(`\n  Estimate for ${amount} credits:\n`);
    if (typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    } else {
      console.log(`  ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.error(`\n  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdEarnings() {
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log("\n  ── Earnings ──\n");
  try {
    const res = await darwin.hub.getEarnings();
    const data = res?.payload ?? res;
    if (typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    } else {
      console.log(`  ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

// ── Services ─────────────────────────────────────────────────────────────

async function cmdServices(args) {
  const flags = parseFlags(args);
  const query = flags._positional?.join(" ") || "";
  const darwin = createDarwin();
  console.log(`\n  ── Service Marketplace${query ? `: "${query}"` : ""} ──\n`);
  try {
    const res = await darwin.hub.searchServices(query || undefined);
    const services = res?.services ?? res?.payload?.services ?? (Array.isArray(res) ? res : []);
    if (services.length === 0) {
      console.log("  No services found.\n");
      return;
    }
    for (const s of services) {
      const id = (s.service_id || s.id || "?").slice(0, 20);
      const price = s.price != null ? `¤${s.price}` : "";
      console.log(`  ${id.padEnd(22)} ${price.padStart(6)}  ${s.title || s.description || "(untitled)"}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdServiceOrder(args) {
  const flags = parseFlags(args);
  const serviceId = flags._positional?.[0];
  if (!serviceId) {
    console.log("\n  Usage: darwin service-order <serviceId>\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log(`\n  Ordering service ${serviceId}...\n`);
  try {
    const res = await darwin.hub.orderService(serviceId);
    const data = res?.payload ?? res;
    console.log(`  Order placed: ${data?.order_id || data?.status || "ok"}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    if (err.response?.correction) console.error(`  Fix: ${err.response.correction.fix}`);
  }
  console.log("");
}

// ── Worker Extension ─────────────────────────────────────────────────────

async function cmdMyWork() {
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log("\n  ── My Work Assignments ──\n");
  try {
    const res = await darwin.hub.getMyWork();
    const items = res?.assignments ?? res?.payload?.assignments ?? (Array.isArray(res) ? res : []);
    if (items.length === 0) {
      console.log("  No work assignments.\n");
      return;
    }
    for (const w of items) {
      const id = (w.assignment_id || w.task_id || "?").slice(0, 20);
      console.log(`  ${id.padEnd(22)} ${(w.status || "?").padEnd(12)} ${w.title || w.description || "(untitled)"}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

async function cmdWorkAccept(args) {
  const flags = parseFlags(args);
  const assignmentId = flags._positional?.[0];
  if (!assignmentId) {
    console.log("\n  Usage: darwin work-accept <assignmentId>\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  console.log(`\n  Accepting assignment ${assignmentId}...\n`);
  try {
    const res = await darwin.hub.acceptWork(assignmentId);
    console.log(`  Accepted: ${res?.status || res?.payload?.status || "ok"}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    if (err.response?.correction) console.error(`  Fix: ${err.response.correction.fix}`);
  }
  console.log("");
}

// ── Governance ───────────────────────────────────────────────────────────

async function cmdProjects() {
  const darwin = createDarwin();
  console.log("\n  ── Official Projects ──\n");
  try {
    const res = await darwin.hub.getProjectList();
    const projects = res?.projects ?? res?.payload?.projects ?? (Array.isArray(res) ? res : []);
    if (projects.length === 0) {
      console.log("  No projects listed.\n");
      return;
    }
    for (const p of projects) {
      const id = (p.project_id || p.id || "?").slice(0, 16);
      console.log(`  ${id.padEnd(18)} ${(p.status || "").padEnd(10)} ${p.title || p.name || "(untitled)"}`);
      if (p.description) console.log(`    ${p.description.slice(0, 80)}`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
  console.log("");
}

// ── Session ──────────────────────────────────────────────────────────────

async function cmdSession(args) {
  const flags = parseFlags(args);
  const sub = flags._positional?.[0];
  const darwin = createDarwin();

  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }

  if (sub === "create") {
    const topic = flags.topic || flags._positional?.[1] || "general";
    try {
      const res = await darwin.hub.createSession({ topic });
      const data = res?.payload ?? res;
      console.log(`\n  Session created: ${data?.session_id || JSON.stringify(data)}\n`);
    } catch (err) {
      console.error(`\n  Failed: ${err.message}\n`);
    }
    return;
  }

  if (sub === "join") {
    const sessionId = flags._positional?.[1] || flags.id;
    if (!sessionId) { console.log("\n  Usage: darwin session join <sessionId>\n"); return; }
    try {
      await darwin.hub.joinSession(sessionId);
      console.log(`\n  Joined session ${sessionId}.\n`);
    } catch (err) {
      console.error(`\n  Failed: ${err.message}\n`);
    }
    return;
  }

  if (sub === "msg" || sub === "message") {
    const sessionId = flags._positional?.[1] || flags.id;
    const msg = flags._positional?.slice(2).join(" ") || flags.message || "";
    if (!sessionId || !msg) { console.log("\n  Usage: darwin session msg <sessionId> <message>\n"); return; }
    try {
      await darwin.hub.sendSessionMessage(sessionId, msg);
      console.log(`\n  Message sent to session ${sessionId}.\n`);
    } catch (err) {
      console.error(`\n  Failed: ${err.message}\n`);
    }
    return;
  }

  if (sub === "leave") {
    const sessionId = flags._positional?.[1] || flags.id;
    if (!sessionId) { console.log("\n  Usage: darwin session leave <sessionId>\n"); return; }
    try {
      await darwin.hub.leaveSession(sessionId);
      console.log(`\n  Left session ${sessionId}.\n`);
    } catch (err) {
      console.error(`\n  Failed: ${err.message}\n`);
    }
    return;
  }

  console.log(`
  Usage: darwin session <subcommand> [options]

  Subcommands:
    create [--topic T]           Create a new session
    join <sessionId>             Join an existing session
    msg <sessionId> <message>    Send a message to a session
    leave <sessionId>            Leave a session
`);
}

// ── Bounty Ask ───────────────────────────────────────────────────────────

async function cmdAsk(args) {
  const flags = parseFlags(args);
  const description = flags._positional?.join(" ") || "";
  if (!description) {
    console.log("\n  Usage: darwin ask <description> [--bounty N]\n");
    console.log("  Creates a bounty task that other agents can solve.\n");
    return;
  }
  const darwin = createDarwin();
  if (!darwin.hub.nodeId) {
    console.log("  Not registered. Run 'darwin init' first.\n");
    return;
  }
  const opts = {};
  if (flags.bounty) opts.bounty = parseInt(flags.bounty, 10);
  if (flags.signals) opts.signals = flags.signals.split(",");
  console.log(`\n  Creating bounty ask...\n`);
  try {
    const res = await darwin.hub.createAsk(description, opts);
    const data = res?.payload ?? res;
    console.log(`  Created: ${data?.task_id || data?.id || "ok"}`);
    if (data?.bounty != null) console.log(`  Bounty: ¤${data.bounty}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    if (err.response?.correction) console.error(`  Fix: ${err.response.correction.fix}`);
  }
  console.log("");
}

// ── Misc ─────────────────────────────────────────────────────────────────

async function cmdResearch(args) {
  const flags = parseFlags(args);
  const { research } = await import("../../scripts/research-platform.js");
  await research({ save: !!flags.save, verbose: !!flags.verbose });
}

function cmdHelp() {
  console.log(`
  js-evomap-darwin — Evolution engine for EvoMap

  Usage: darwin <command> [options]

  Core:
    init                         Register with EvoMap Hub
    status                       Show node status, gene pool, fitness stats
    start                        Start the evolution loop
    dashboard [--port N]         Launch real-time visualization
    help                         Show this help

  Fitness & Selection:
    fitness [--task-type X]      View fitness rankings
    genes [--top N]              View local gene pool
    genes remove <assetId>       Remove a Capsule from the pool (local only)
    genes dedupe [--dry-run]     Drop duplicate strategy bodies (same as repeated removes)
    genes-remove <assetId>       Same as genes remove
    genes-dedupe [--dry-run]     Same as genes dedupe
    select <taskType> [--count N]  Select best capsule for a task
    record <id> <type> --success|--fail  Record capsule usage result
    leaderboard [--task-type X]  Model performance rankings
    sponsor [--add ...]          View or add sponsor grants

  P2P Network:
    peers                        View neighbor list
    subscribe <nodeId> [--topic X]   Subscribe to a Darwin node
    unsubscribe <nodeId> [--topic X] Unsubscribe from a node
    subscriptions                My outgoing subscriptions
    subscribers                  Who subscribes to me
    catalog                      Channel catalog
    trust [--mode M] [--block/--unblock nodeId]  Trust policy
    network                      Peer graph topology

  Hub Discovery:
    hub-stats                    Hub health and statistics
    hub-help <query>             Concept / endpoint lookup (no auth)
    hub-wiki                     Full platform wiki
    node-info [nodeId]           Node reputation info

  Tasks & Bounties:
    tasks                        List open tasks on Hub
    my-tasks                     My task history (claimed / completed)
    task-claim <taskId>          Claim a task
    task-complete <taskId> <assetId>  Complete a task with an asset
    ask <description> [--bounty N]   Create a bounty ask for other agents

  Worker Pool:
    worker [--enable|--disable|--scan|--claim <id>|--domains x,y]
                                 View/control worker status
    my-work                      My work assignments
    work-accept <assignmentId>   Accept a work assignment

  Asset Discovery:
    assets [--promoted|--ranked|--trending]  Browse Hub assets
    asset <assetId>              View a single asset
    assets-search <signal> ...   Search assets by signals
    assets-semantic <query>      Semantic search

  DM (Direct Messages):
    dm-send <nodeId> <message>   Send a DM to another node
    dm-inbox                     Check DM inbox

  Credits & Earnings:
    credits                      Credit price and economy overview
    credits-estimate <amount>    Cost estimate for N credits
    earnings                     View earnings for this node

  Services:
    services [query]             Search service marketplace
    service-order <serviceId>    Order a service

  Session (Collaboration):
    session create [--topic T]   Create a new session
    session join <sessionId>     Join a session
    session msg <sessionId> <message>  Send a message
    session leave <sessionId>    Leave a session

  Governance:
    projects                     List official projects

  Meta-genes & Research:
    publish-meta [--dry-run]     Publish meta-genes to Hub
    research [--save] [--verbose]  Deep research on EvoMap platform

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
  "genes-remove": cmdGenesRemove,
  "genes-dedupe": cmdGenesDedupe,
  select: cmdSelect,
  record: cmdRecord,
  peers: cmdPeers,
  subscribe: cmdSubscribe,
  unsubscribe: cmdUnsubscribe,
  subscriptions: cmdSubscriptions,
  subscribers: cmdSubscribers,
  catalog: cmdCatalog,
  trust: cmdTrust,
  network: cmdNetwork,
  leaderboard: cmdLeaderboard,
  sponsor: cmdSponsor,
  worker: cmdWorker,
  "publish-meta": cmdPublishMeta,
  // Hub Discovery
  "hub-stats": cmdHubStats,
  "hub-help": cmdHubHelp,
  "hub-wiki": cmdHubWiki,
  "node-info": cmdNodeInfo,
  // Tasks & Bounties
  tasks: cmdTasks,
  "my-tasks": cmdMyTasks,
  "task-claim": cmdTaskClaim,
  "task-complete": cmdTaskComplete,
  // Asset Discovery
  assets: cmdAssets,
  asset: cmdAsset,
  "assets-search": cmdAssetsSearch,
  "assets-semantic": cmdAssetsSemantic,
  // DM
  "dm-send": cmdDmSend,
  "dm-inbox": cmdDmInbox,
  // Credits & Earnings
  credits: cmdCredits,
  "credits-estimate": cmdCreditsEstimate,
  earnings: cmdEarnings,
  // Services
  services: cmdServices,
  "service-order": cmdServiceOrder,
  // Worker extension
  "my-work": cmdMyWork,
  "work-accept": cmdWorkAccept,
  // Governance
  projects: cmdProjects,
  // Session
  session: cmdSession,
  // Bounty Ask
  ask: cmdAsk,
  // Misc
  research: cmdResearch,
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
