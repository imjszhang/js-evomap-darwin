#!/usr/bin/env node
/**
 * Subagent 诊断：本仓库的 Capsule 生成依赖 OpenClaw 注入的 api.runtime.subagent。
 * 在无宿主环境下用 mock 复现 success / error / timeout 分支，便于确认「问题在宿主 LLM 配置」而非 Darwin 逻辑。
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SAMPLE_CAPSULE_JSON = `\`\`\`json
{
  "type": "Capsule",
  "schema_version": "1.5.0",
  "trigger": ["test", "signal"],
  "summary": "Test summary",
  "content": "${"x".repeat(220)}",
  "strategy": ["Step 1: a", "Step 2: b", "Step 3: c"],
  "confidence": 0.75,
  "blast_radius": { "files": 1, "lines": 30 },
  "outcome": { "status": "success", "score": 0.75 },
  "env_fingerprint": { "platform": "any", "arch": "any" }
}
\`\`\``;

async function loadParseCapsule() {
  const { computeAssetId } = await import(pathToFileURL(join(ROOT, "src/utils/hash.js")).href);
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
        obj.strategy = ["a", "b"];
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
  return parseCapsuleFromReply;
}

/** 与 openclaw-plugin/index.mjs 中 generateCapsuleViaAgent 等价的分支（无 pushEvent） */
async function simulateGenerate(subagent, task, parseCapsuleFromReply) {
  if (!subagent) return { outcome: "no-subagent", capsule: null };

  const sessionKey = `test-session-${task.task_id || "t"}`;
  try {
    await subagent.run({ sessionKey, message: "prompt", deliver: false });
    const result = await subagent.waitForRun({ runId: "1", timeoutMs: 90_000 });

    if (result?.status === "timeout") {
      return { outcome: "timeout", capsule: null };
    }
    if (result?.status === "error") {
      return { outcome: "error", detail: result.error || result.message, capsule: null };
    }

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    let capsule = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const text = msg?.content ?? msg?.text ?? (typeof msg === "string" ? msg : "");
      if (!text) continue;
      capsule = parseCapsuleFromReply(text);
      if (capsule) break;
    }
    await subagent.deleteSession?.({ sessionKey });
    return { outcome: capsule ? "ok" : "no-json-in-messages", capsule };
  } catch (err) {
    return { outcome: "exception", detail: err.message, capsule: null };
  }
}

async function main() {
  const parseCapsuleFromReply = await loadParseCapsule();
  const task = { task_id: "diag-1", title: "Hello", signals: "a,b", bounty_amount: "1" };

  console.log("=== js-evomap-darwin subagent 诊断 ===\n");
  console.log("说明: 真实 Subagent 仅由 OpenClaw/Cursor 在加载插件时提供 (api.runtime.subagent)。");
  console.log("本仓库 standalone `node` / `darwin` CLI 不会注入 subagent，generateCallback 在宿主外恒为不可用。\n");

  // 1) 无 subagent
  const r0 = await simulateGenerate(null, task, parseCapsuleFromReply);
  console.log("[1] pluginRuntime.subagent 缺失:", r0.outcome, "→ 与插件未在 OpenClaw 内运行一致。");

  // 2) 401 类错误（宿主 LLM）
  const sub401 = {
    run: async () => ({ runId: "r1" }),
    waitForRun: async () => ({
      status: "error",
      error: 'LLM ERROR] 401 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}',
    }),
    getSessionMessages: async () => ({ messages: [] }),
    deleteSession: async () => {},
  };
  const r1 = await simulateGenerate(sub401, task, parseCapsuleFromReply);
  console.log("[2] waitForRun status=error (模拟 401):", r1.outcome, r1.detail?.slice?.(0, 80) || r1.detail);

  // 3) 超时
  const subTo = {
    run: async () => ({ runId: "r1" }),
    waitForRun: async () => ({ status: "timeout" }),
    getSessionMessages: async () => ({ messages: [] }),
    deleteSession: async () => {},
  };
  const r2 = await simulateGenerate(subTo, task, parseCapsuleFromReply);
  console.log("[3] waitForRun status=timeout:", r2.outcome);

  // 4) 成功 + 消息中含 Capsule JSON
  const subOk = {
    run: async () => ({ runId: "r1" }),
    waitForRun: async () => ({ status: "completed" }),
    getSessionMessages: async () => ({
      messages: [{ role: "assistant", content: SAMPLE_CAPSULE_JSON }],
    }),
    deleteSession: async () => {},
  };
  const r3 = await simulateGenerate(subOk, task, parseCapsuleFromReply);
  console.log("[4] 正常返回 JSON Capsule:", r3.outcome, r3.capsule ? `asset_id=${r3.capsule.asset_id?.slice(0, 16)}...` : "");

  console.log("\n结论:");
  console.log("- 若你在 OpenClaw 日志里看到 401/429：请在 Cursor/OpenClaw 里检查 **LLM / OpenRouter 等 API Key** 与 **模型名**（避免 *:free 限流），与 EvoMap NODE_SECRET 无关。");
  console.log("- 若从未加载插件：Darwin 侧不会调用 subagent；worker 需 `setGenerateCallback` 且 pluginRuntime.subagent 存在。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
