/**
 * 通过正在运行的 OpenClaw Gateway（与 Darwin 插件同进程）跑通「接任务 → 生成 Capsule → 交卷」。
 *
 * 两种方式生成 Capsule：
 * - 默认：`POST /tools/invoke` → `darwin_worker.claimWithAgent`（插件内 Subagent，需在 Gateway 请求上下文中）。
 * - `--ws-agent`：参考 js-moltbook `openclaw-gateway.mjs`，用 **WebSocket `agent` RPC** 调主 Agent 生成 JSON，
 *   再 `claimWithCapsuleTaskId` + `claimWithCapsuleJson` 交卷（绕过插件内 subagent 上下文限制）。
 *
 * 前置：Gateway 已启动、插件已加载、`.env` 中 OPENCLAW_GATEWAY_TOKEN。
 * WebSocket 路径另需 `~/.openclaw/identity/device.json`（openclaw CLI 配对）。
 *
 * 环境变量:
 *   OPENCLAW_GATEWAY_URL   默认 http://127.0.0.1:18789
 *   OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { callAgent, parseJsonFromText } from "./openclaw-gateway-ws.mjs";

const envPath = resolve(import.meta.dirname, "../.env");
try {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* optional */ }

function parseArgs(argv) {
  const o = {
    taskId: null,
    auto: false,
    heartbeatOnly: false,
    skipHeartbeat: false,
    forceAgent: false,
    wsAgent: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-id" && argv[i + 1]) {
      o.taskId = argv[++i];
    } else if (argv[i] === "--auto" || argv[i] === "--heartbeat-only") {
      o.auto = true;
      if (argv[i] === "--heartbeat-only") o.heartbeatOnly = true;
    } else if (argv[i] === "--skip-heartbeat") {
      o.skipHeartbeat = true;
    } else if (argv[i] === "--force-agent") {
      o.forceAgent = true;
    } else if (argv[i] === "--ws-agent") {
      o.wsAgent = true;
    } else if (argv[i] === "-h" || argv[i] === "--help") {
      o.help = true;
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const base =
  process.env.OPENCLAW_GATEWAY_URL ||
  process.env.GATEWAY_URL ||
  "http://127.0.0.1:18789";
const token =
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  process.env.OPENCLAW_GATEWAY_PASSWORD ||
  "";

const url = `${base.replace(/\/$/, "")}/tools/invoke`;

async function invoke(tool, toolArgs = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, args: toolArgs }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: res.ok, status: res.status, raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

function printInvoke(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(result.status, JSON.stringify(result.body ?? result.raw ?? result, null, 2));
}

/** 与插件 buildCapsulePrompt 对齐 */
function buildCapsulePrompt(task) {
  const title = (task.title || "").slice(0, 200);
  const signals = (task.signals || "").split(",").map((s) => s.trim()).filter(Boolean);
  const bounty = task.bounty_amount ?? task.bountyAmount ?? "unknown";

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

function extractToolText(body) {
  if (!body || typeof body !== "object") return "";
  const c = body.content ?? body.result?.content;
  if (Array.isArray(c) && c[0]?.text) return String(c[0].text);
  return "";
}

/** 从 darwin_heartbeat 返回的 JSON 文本中解析 availableWork 里的一条任务 */
function findTaskFromHeartbeatText(text, taskId) {
  if (!text || !taskId) return null;
  try {
    const h = JSON.parse(text);
    const list =
      h.availableWork ||
      h.raw?.available_work ||
      h.raw?.available_tasks ||
      [];
    const normalize = (t) => {
      if (!t || typeof t !== "object") return null;
      const id = t.task_id || t.id;
      return id ? { ...t, task_id: id } : null;
    };
    const arr = Array.isArray(list) ? list.map(normalize).filter(Boolean) : [];
    return arr.find((t) => t.task_id === taskId || t.id === taskId) || null;
  } catch {
    return null;
  }
}

async function main() {
  if (args.help) {
    console.log(`Usage:
  node scripts/gateway-agent-task-cycle.mjs --task-id <task_id> [--skip-heartbeat] [--force-agent]
  node scripts/gateway-agent-task-cycle.mjs --task-id <task_id> --ws-agent
     使用 WebSocket 调主 Agent 生成 Capsule（需 device.json），再 HTTP 提交认领。
  node scripts/gateway-agent-task-cycle.mjs --auto
  node scripts/gateway-agent-task-cycle.mjs --heartbeat-only`);
    process.exit(0);
  }

  if (!token) {
    console.error(
      "请设置 OPENCLAW_GATEWAY_TOKEN（或 PASSWORD），与 openclaw gateway 配置一致。",
    );
    process.exit(1);
  }

  if (!args.auto && !args.taskId) {
    console.error(
      "请指定 --task-id <id>，或使用 --auto / --heartbeat-only 触发一次完整心跳周期。",
    );
    process.exit(1);
  }

  if (args.skipHeartbeat && !args.taskId) {
    console.error("--skip-heartbeat 仅可与 --task-id 一起使用。");
    process.exit(1);
  }
  if (args.skipHeartbeat && args.auto) {
    console.error("--skip-heartbeat 不能与 --auto / --heartbeat-only 同时使用。");
    process.exit(1);
  }
  if (args.forceAgent && !args.taskId) {
    console.error("--force-agent 仅可与 --task-id 一起使用。");
    process.exit(1);
  }
  if (args.wsAgent && !args.taskId) {
    console.error("--ws-agent 需要同时指定 --task-id。");
    process.exit(1);
  }
  if (args.wsAgent && args.auto) {
    console.error("--ws-agent 不能与 --auto / --heartbeat-only 同时使用。");
    process.exit(1);
  }
  if (args.wsAgent && args.skipHeartbeat) {
    console.error(
      "--ws-agent 需要先从心跳拉取任务元数据，请勿使用 --skip-heartbeat。",
    );
    process.exit(1);
  }

  console.log(`POST ${url}`);

  let lastHbBody = null;

  if (!args.skipHeartbeat) {
    const hb = await invoke("darwin_heartbeat", { trigger: true, fullCycle: true });
    lastHbBody = hb.body;
    printInvoke("darwin_heartbeat (refresh tasks + worker cycle)", hb);

    if (!httpOk(hb)) process.exit(1);

    const hbText = extractToolText(hb.body);
    if (hbText && (hbText.includes("Node not registered") || hbText.startsWith("Heartbeat failed"))) {
      process.exit(1);
    }

    if (args.auto || args.heartbeatOnly) {
      process.exit(0);
    }
  } else if (args.taskId) {
    console.log(
      "\n--- skip heartbeat ---\n(假定 Darwin 任务缓冲已含目标 task；仅调用 claimWithAgent)\n",
    );
  }

  if (args.wsAgent) {
    const hbText = extractToolText(lastHbBody);
    const task = findTaskFromHeartbeatText(hbText, args.taskId);
    if (!task) {
      console.error(
        `未在心跳结果中找到 task_id=${args.taskId}（请确认 Hub 仍有该任务）。`,
      );
      process.exit(1);
    }

    console.log("\n--- WebSocket agent (openclaw-gateway-ws) ---\n");
    let replyText;
    try {
      replyText = await callAgent(buildCapsulePrompt(task), {
        timeout: 300,
        thinking: "low",
      });
    } catch (e) {
      console.error("WebSocket callAgent 失败:", e.message || e);
      process.exit(1);
    }

    let capsuleObj;
    try {
      capsuleObj = parseJsonFromText(replyText);
    } catch (e) {
      console.error("解析 Capsule JSON 失败:", e.message || e);
      console.error("模型回复前 800 字:\n", replyText.slice(0, 800));
      process.exit(1);
    }

    const claim = await invoke("darwin_claim_capsule", {
      taskId: args.taskId,
      capsuleJson: JSON.stringify(capsuleObj),
    });
    printInvoke(
      `darwin_claim_capsule (taskId: ${args.taskId})`,
      claim,
    );

    if (!httpOk(claim)) process.exit(1);

    const claimText = extractToolText(claim.body);
    if (claimText && !claimText.trim().startsWith("{")) {
      process.exit(1);
    }

    process.exit(0);
  }

  const claim = await invoke("darwin_worker", {
    claimWithAgent: args.taskId,
    ...(args.forceAgent ? { forceAgent: true } : {}),
  });
  printInvoke(
    `darwin_worker (claimWithAgent: ${args.taskId}${args.forceAgent ? ", forceAgent" : ""})`,
    claim,
  );

  if (!httpOk(claim)) process.exit(1);

  const claimText = extractToolText(claim.body);
  if (claimText && !claimText.trim().startsWith("{")) {
    process.exit(1);
  }

  process.exit(0);
}

function httpOk(result) {
  if (!result.ok) return false;
  const b = result.body;
  if (b && typeof b === "object" && b.ok === false) return false;
  return true;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
