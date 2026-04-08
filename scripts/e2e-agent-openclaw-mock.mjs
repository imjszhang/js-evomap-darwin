/**
 * E2E: EvoMap heartbeat → TaskMatcher（无本地匹配时）→ 模拟 OpenClaw 的 setGenerateCallback
 * 生成 Capsule → claim → validate → publish → completeWork
 *
 * 与 openclaw-plugin/index.mjs 中 pluginRuntime.subagent + setGenerateCallback 的路径一致，
 * 此处用确定性回调代替真实 Subagent LLM 调用。
 *
 * 需要 .env：HUB_URL、NODE_ID、NODE_SECRET
 * 若 Hub 返回 available_tasks 为空，脚本会退出并说明无法测 claim。
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const envPath = resolve(import.meta.dirname, "../.env");
try {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch {
  console.error("Missing .env — copy from .env.example and set NODE_ID / NODE_SECRET.");
  process.exit(1);
}

import { Darwin } from "../src/index.js";
import { Mutator } from "../src/mutator.js";
import { TaskMatcher } from "../src/task-matcher.js";
import { computeAssetId } from "../src/utils/hash.js";

function buildCapsuleForTask(task) {
  const taskSignals = (task.signals || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const content = [
    `Intent: Systematic solution for "${task.title}".`,
    "",
    `Domain: ${task.signals}`,
    "",
    "Approach:",
    "1. Analyze the core challenge by breaking it into concrete sub-problems.",
    "2. For each sub-problem, define acceptance criteria and measurable metrics.",
    "3. Design a solution that addresses root causes rather than symptoms.",
    "4. Implement defensive checks and validation at each critical step.",
    "5. Test against adversarial / edge-case inputs to verify robustness.",
    "6. Compare results against a no-intervention baseline via A/B measurement.",
    "7. Document findings: what worked, what failed, and quantified improvement.",
    "",
    "Expected outcome: A reproducible, validated strategy with measured effectiveness.",
  ].join("\n");
  const strategy = [
    "Break the challenge into well-defined, independently testable sub-problems",
    "Define measurable acceptance criteria for each sub-problem",
    "Design solution addressing root causes with defensive validation",
    "Test against adversarial and edge-case inputs for robustness",
    "A/B compare against baseline; document quantified improvements",
  ];
  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: taskSignals,
    summary: `E2E mock agent: ${String(task.title || "").slice(0, 120)}`,
    content,
    strategy,
    confidence: 0.78,
    blast_radius: { files: 1, lines: 25 },
    outcome: { status: "success", score: 0.78 },
    env_fingerprint: { platform: "any", arch: "any" },
  };
  capsule.asset_id = computeAssetId(capsule);
  return capsule;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "darwin-e2e-agent-"));
  console.log("=== E2E: EvoMap + mock OpenClaw generateCallback ===\n");
  console.log(`  Isolated data dir: ${tmp}\n`);

  const darwin = new Darwin({
    hubUrl: process.env.HUB_URL,
    dataDir: tmp,
    nodeId: process.env.NODE_ID,
    nodeSecret: process.env.NODE_SECRET,
    hubAssetFetch: false,
  });

  darwin.use(new Mutator({ mutationRate: 0.05 }));
  const worker = new TaskMatcher({
    hub: darwin.hub,
    dataDir: tmp,
    autoSubmit: true,
  });
  darwin.use(worker);

  try {
    await worker.register({ enabled: true });
  } catch (e) {
    console.error("  registerWorker failed:", e.message);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  /** 清空基因池（含 meta seed），强制走「无匹配 → generateCallback」分支 */
  const ranked = darwin.store.ranked(darwin.store.capacity);
  for (const g of ranked) {
    darwin.store.remove(g.assetId);
  }

  worker.setGenerateCallback(async (task) => buildCapsuleForTask(task));

  const events = [];
  const log = (e, d) => {
    events.push(e);
    console.log(`  [${e}]`, typeof d === "object" ? JSON.stringify(d).slice(0, 160) : d);
  };

  darwin.on("agent-generate-start", (d) => log("agent-generate-start", d));
  darwin.on("agent-capsule", (d) => log("agent-capsule", d));
  darwin.on("agent-capsule-rejected", (d) => log("agent-capsule-rejected", d));
  darwin.on("agent-generate-failed", (d) => log("agent-generate-failed", d));
  darwin.on("task-matched", (d) => log("task-matched", d));
  darwin.on("task-claimed", (d) => log("task-claimed", d));
  darwin.on("task-validated", (d) => log("task-validated", d));
  darwin.on("task-published", (d) => log("task-published", d));
  darwin.on("task-completed", (d) => log("task-completed", d));
  darwin.on("task-failed", (d) => log("task-failed", d));
  darwin.on("error", (d) => log("error", d));

  console.log("--- Single darwin.heartbeat() (Hub + task buffer + TaskMatcher.cycle) ---\n");
  const hb = await darwin.heartbeat();
  const taskCount =
    hb?.availableWork?.length ??
    hb?.raw?.available_work?.length ??
    hb?.raw?.available_tasks?.length ??
    0;
  console.log(`\n  Heartbeat status: ${hb?.status}, credits: ${hb?.creditBalance}`);
  console.log(`  available work (this response): ${taskCount}`);

  if (taskCount === 0) {
    console.log("\n  Hub 当前未返回可领取任务，无法执行 claim → complete。流程已执行到 heartbeat + cycle。");
    console.log("  在 OpenClaw 中加载插件且 Hub 有任务时，真实 Subagent 会替代本脚本的 mock 回调。\n");
    rmSync(tmp, { recursive: true, force: true });
    return;
  }

  if (events.includes("agent-capsule-rejected")) {
    console.log(
      "\n  若出现 agent-capsule-rejected (pre-validate failed)：当前 Hub 对 /a2a/validate 可能返回 invalid_protocol_message（可用 `node cli/cli.js publish-meta --dry-run` 复现）。此时 claim 链路的 validate 也会失败，与本地 Capsule 内容无关。",
    );
  }

  if (!events.includes("task-completed") && !events.includes("task-failed")) {
    console.log("\n  提示: 有任务但未完成 — 可能 cooling / 无 slots / 匹配分不足 / 或 Hub validate 不可用。查看上方事件。");
  } else {
    console.log("\n  ✓ 端到端事件链已触发（含 Hub 提交）。");
  }

  rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
