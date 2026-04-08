/**
 * 单独测试「任务工人」一轮：Hub 心跳 → TaskMatcher.cycle（对齐 → 扫描 → 可选认领交卷）
 *
 * 「模拟 agent」仅指本脚本里的 --mock-agent：用**固定模板**假扮 OpenClaw 插件里 **Subagent/LLM**
 * 生成 Capsule 的行为，方便在**没有** OpenClaw 宿主时调试「无匹配 → 生成再领任务」分支。
 * 真实 LLM、真实 Subagent **只在 OpenClaw Gateway 加载插件时**才有。
 *
 * **希望真实运作一轮（真 Hub、真认领、用你本机基因池匹配）**：不要加 --mock-agent，并加上
 * --claim --use-project-data（读写 ./data，与日常 Darwin 数据一致）。
 *
 * 需要项目根目录 .env：HUB_URL、NODE_ID、NODE_SECRET
 *
 * 用法：
 *   node scripts/test-task-worker.mjs
 *     临时目录，只扫描不认领（安全）
 *   node scripts/test-task-worker.mjs --claim --use-project-data
 *     推荐：真实基因池 + 认领并完成（真实打 Hub）
 *   node scripts/test-task-worker.mjs --claim
 *     临时空基因池上认领（一般匹配不到任务，除非 Hub 任务极宽）
 *   node scripts/test-task-worker.mjs --mock-agent --claim
 *     调试用：清空临时池 + 假 LLM 生成胶囊（非真实 OpenClaw Agent）
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
  console.error("缺少 .env，请复制 .env.example 并填写 NODE_ID / NODE_SECRET。");
  process.exit(1);
}

function parseArgs(argv) {
  const o = { claim: false, mockAgent: false, useProjectData: false };
  for (const a of argv) {
    if (a === "--claim") o.claim = true;
    else if (a === "--mock-agent") o.mockAgent = true;
    else if (a === "--use-project-data") o.useProjectData = true;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));

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
    summary: `[worker-test] ${String(task.title || "").slice(0, 100)}`,
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
  const dataDir = args.useProjectData
    ? resolve(import.meta.dirname, "../data")
    : mkdtempSync(join(tmpdir(), "darwin-worker-test-"));

  const modeLabel = args.claim
    ? "完整（含认领 → 校验 → 发布 → 完成）"
    : "仅扫描（autoSubmit 关闭，不会 claim）";

  console.log("=== 任务工人单轮测试 ===\n");
  console.log(`  模式: ${modeLabel}`);
  console.log(`  数据目录: ${dataDir}`);
  if (args.mockAgent) {
    console.log("  生成胶囊来源: 脚本内固定模板（假扮 LLM，仅调试用；不是 OpenClaw 真实 Subagent）");
  } else {
    console.log("  生成胶囊来源: 无（仅用本地已有基因；无匹配则不会现造胶囊，除非在 OpenClaw 里跑插件）");
  }
  if (args.claim && !args.useProjectData) {
    console.log("  （临时目录，对本地 worker-state 无持久影响）");
  }
  if (args.claim && args.useProjectData) {
    console.log("  警告: --claim 且 --use-project-data 会写入 ./data 并可能真实领任务。");
  }
  console.log("");

  const darwin = new Darwin({
    hubUrl: process.env.HUB_URL,
    dataDir,
    nodeId: process.env.NODE_ID,
    nodeSecret: process.env.NODE_SECRET,
    hubAssetFetch: false,
  });

  darwin.use(new Mutator({ mutationRate: 0.05 }));
  const worker = new TaskMatcher({
    hub: darwin.hub,
    dataDir,
    autoSubmit: args.claim,
  });
  darwin.use(worker);

  try {
    await worker.register({ enabled: true });
  } catch (e) {
    console.error("registerWorker 失败:", e?.message || String(e));
    if (!args.useProjectData) rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }

  if (args.mockAgent) {
    for (const g of darwin.store.ranked(darwin.store.capacity)) {
      darwin.store.remove(g.assetId);
    }
    worker.setGenerateCallback(async (task) => buildCapsuleForTask(task));
  }

  const events = [];
  const log = (name, payload) => {
    events.push(name);
    const s = typeof payload === "object" ? JSON.stringify(payload).slice(0, 200) : String(payload);
    console.log(`  [${name}] ${s}`);
  };

  darwin.on("agent-generate-start", (d) => log("agent-generate-start", d));
  darwin.on("agent-capsule", (d) => log("agent-capsule", d));
  darwin.on("agent-capsule-rejected", (d) => log("agent-capsule-rejected", d));
  darwin.on("task-matched", (d) => log("task-matched", d));
  darwin.on("task-claimed", (d) => log("task-claimed", d));
  darwin.on("task-validated", (d) => log("task-validated", d));
  darwin.on("task-published", (d) => log("task-published", d));
  darwin.on("task-completed", (d) => log("task-completed", d));
  darwin.on("task-failed", (d) => log("task-failed", d));
  darwin.on("error", (d) => log("error", d));

  console.log("--- 执行一次 darwin.heartbeat()（内含 TaskMatcher.cycle）---\n");
  const hb = await darwin.heartbeat();
  const n = hb?.availableWork?.length ?? hb?.raw?.available_work?.length ?? 0;
  console.log(`\n  心跳: status=${hb?.status}, credits=${hb?.creditBalance}, 本轮可用任务数≈${n}`);

  const st = worker.getStats();
  console.log("\n--- Worker 统计 ---");
  console.log(`  registered=${st.registered} enabled=${st.workerEnabled} autoSubmit=${st.autoSubmit}`);
  console.log(`  counters:`, st.counters);
  if (st.lastScanResults?.length) {
    console.log(`  扫描命中: ${st.lastScanResults.length} 条（见 lastScanResults）`);
    for (const r of st.lastScanResults.slice(0, 5)) {
      console.log(`    - ${r.title?.slice(0, 60)}… score=${r.matchScore}`);
    }
  } else {
    console.log("  本轮无匹配候选（或 Hub 无任务）。");
  }

  if (!args.claim) {
    console.log("\n  提示: 当前为「仅扫描」。若要真实走认领与交卷，请加参数: --claim");
  }
  if (events.includes("agent-capsule-rejected")) {
    console.log(
      "\n  若出现 pre-validate 失败: 多为 Hub /a2a/validate 与当前客户端协议不一致，与胶囊文案无关。",
    );
  }

  if (!args.useProjectData) rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
