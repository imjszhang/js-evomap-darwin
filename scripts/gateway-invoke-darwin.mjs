/**
 * 通过正在运行的 OpenClaw Gateway 调用 Darwin 插件工具（与独立 node 脚本不同进程，此处走 HTTP）。
 *
 * 文档: OpenClaw POST /tools/invoke（与 Gateway 同端口，需 Bearer token）
 *
 * 环境变量（可写入项目 .env）:
 *   OPENCLAW_GATEWAY_URL   默认 http://127.0.0.1:18789
 *   OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD（视 gateway.auth 配置）
 *
 * 用法:
 *   node scripts/gateway-invoke-darwin.mjs
 *     默认: darwin_heartbeat + trigger（完整 darwin.heartbeat，含任务工人）
 *   node scripts/gateway-invoke-darwin.mjs --tool darwin_status
 *   node scripts/gateway-invoke-darwin.mjs --hub-only
 *     仅 Hub ping，不跑 TaskMatcher
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../.env");
try {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* optional */ }

function parseArgs(argv) {
  const o = { tool: null, hubOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tool" && argv[i + 1]) {
      o.tool = argv[++i];
    } else if (argv[i] === "--hub-only") {
      o.hubOnly = true;
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

const tool = args.tool || "darwin_heartbeat";
const body =
  tool === "darwin_heartbeat"
    ? {
        tool: "darwin_heartbeat",
        args: {
          trigger: true,
          ...(args.hubOnly ? { fullCycle: false } : {}),
        },
      }
    : { tool, args: {} };

async function main() {
  if (!token) {
    console.error(
      "请设置 OPENCLAW_GATEWAY_TOKEN（或 PASSWORD），与 openclaw gateway 配置一致。",
    );
    process.exit(1);
  }

  console.log(`POST ${url}`);
  console.log(`tool: ${tool}`, JSON.stringify(body.args || {}));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(res.status, text);
    process.exit(res.ok ? 0 : 1);
  }

  console.log(res.status, JSON.stringify(json, null, 2));
  process.exit(res.ok && json.ok !== false ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
