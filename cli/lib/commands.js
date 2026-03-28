import { Darwin } from "../../src/index.js";
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

async function cmdResearch(args) {
  const flags = parseFlags(args);
  const { research } = await import("../../scripts/research-platform.js");
  await research({ save: !!flags.save, verbose: !!flags.verbose });
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
    peers                   View neighbor list (legacy)
    subscribe <nodeId> [--topic X]  Subscribe to a Darwin node
    unsubscribe <nodeId> [--topic X]  Unsubscribe from a node
    subscriptions           View my outgoing subscriptions
    subscribers             View who subscribes to me
    catalog                 View my channel catalog
    trust [--mode M] [--block/--unblock nodeId]  Trust policy
    network                 View peer graph topology
    leaderboard [--task-type X]  View model performance rankings
    sponsor [--add ...]     View or add sponsor grants
    worker [--enable|--disable|--scan|--claim <id>|--domains x,y]
                            View/control Worker Pool status
    publish-meta            Publish meta-genes to Hub
    research [--save] [--verbose]  Deep research on the EvoMap platform
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
