#!/usr/bin/env node

/**
 * EvoMap 平台深度调研脚本
 *
 * 系统性探测所有可读 API 端点，收集平台生态全景数据，生成结构化报告。
 *
 * Usage:
 *   node scripts/research-platform.js [--save] [--verbose]
 */

import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HubClient } from "../src/hub-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env loader ────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ── CLI flags ──────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) flags[arg.slice(2)] = true;
  }
  return flags;
}

// ── Probe wrapper ──────────────────────────────────────────────────────

async function probe(name, fn) {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { name, ok: true, ms: Date.now() - t0, data };
  } catch (err) {
    return {
      name,
      ok: false,
      ms: Date.now() - t0,
      error: err.message,
      statusCode: err.statusCode,
    };
  }
}

// ── Research modules ───────────────────────────────────────────────────

async function researchHubHealth(hub) {
  return probe("Hub 健康状态", () => hub.getStats());
}

async function researchNodeSelf(hub) {
  return probe("节点自身信息", () => hub.getNodeInfo());
}

async function researchTasks(hub) {
  const [taskList, myTasks] = await Promise.all([
    probe("任务列表", () => hub.getTaskList()),
    probe("我的任务", () => hub.getMyTasks()),
  ]);
  return { name: "任务市场", children: [taskList, myTasks] };
}

async function researchAssets(hub) {
  const [promoted, ranked, trending] = await Promise.all([
    probe("推荐资产", () => hub.getPromotedAssets()),
    probe("排名资产", () => hub.getRankedAssets()),
    probe("趋势资产", () => hub.getTrending()),
  ]);
  return { name: "资产生态", children: [promoted, ranked, trending] };
}

async function researchCommunity(hub) {
  const [directory, inbox] = await Promise.all([
    probe("Agent 目录", () => hub.getDirectory()),
    probe("DM 收件箱", () => hub.pollDM()),
  ]);
  return { name: "Agent 社区", children: [directory, inbox] };
}

async function researchWorkerServices(hub) {
  const [work, services] = await Promise.all([
    probe("可用工作", () => hub.getAvailableWork()),
    probe("服务搜索", () => hub.searchServices()),
  ]);
  return { name: "Worker/服务", children: [work, services] };
}

async function researchWiki(hub) {
  const [help, wiki] = await Promise.all([
    probe("帮助文档", () => hub.getHelp("capabilities")),
    probe("完整 Wiki", () => hub.getWikiFull()),
  ]);
  return { name: "Wiki/帮助", children: [help, wiki] };
}

// ── Report formatting ──────────────────────────────────────────────────

const SEP = "─".repeat(60);
const HEADER = "═".repeat(60);

function statusIcon(ok) {
  return ok ? "OK" : "FAIL";
}

function summarize(data) {
  if (data == null) return "(empty)";
  if (typeof data === "string") return data.length > 120 ? data.slice(0, 120) + "..." : data;
  if (Array.isArray(data)) return `${data.length} 条记录`;
  if (data.payload) return summarize(data.payload);
  const keys = Object.keys(data);
  if (keys.length <= 6) {
    return keys.map((k) => {
      const v = data[k];
      const display = Array.isArray(v) ? `[${v.length}]` : typeof v === "object" && v ? "{...}" : String(v);
      return `${k}: ${display}`;
    }).join("  |  ");
  }
  return `${keys.length} 个字段: ${keys.slice(0, 8).join(", ")}...`;
}

function printProbe(p, indent = "  ") {
  const tag = statusIcon(p.ok);
  const timing = `${p.ms}ms`;
  console.log(`${indent}[${tag}] ${p.name} (${timing})`);
  if (p.ok) {
    console.log(`${indent}     ${summarize(p.data)}`);
  } else {
    console.log(`${indent}     错误: ${p.error}${p.statusCode ? ` (HTTP ${p.statusCode})` : ""}`);
  }
}

function printVerboseProbe(p, indent = "  ") {
  printProbe(p, indent);
  if (p.ok && p.data) {
    const json = JSON.stringify(p.data, null, 2);
    for (const line of json.split("\n").slice(0, 40)) {
      console.log(`${indent}     ${line}`);
    }
    const lines = json.split("\n");
    if (lines.length > 40) {
      console.log(`${indent}     ... (${lines.length - 40} more lines)`);
    }
  }
}

function formatReport(results, verbose = false) {
  const printer = verbose ? printVerboseProbe : printProbe;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  console.log("");
  console.log(`  ${HEADER}`);
  console.log(`  EvoMap 平台深度调研报告`);
  console.log(`  生成时间: ${now}`);
  console.log(`  ${HEADER}`);

  for (const section of results) {
    console.log("");
    console.log(`  ${SEP}`);
    console.log(`  ${section.name}`);
    console.log(`  ${SEP}`);

    if (section.children) {
      for (const child of section.children) printer(child);
    } else {
      printer(section);
    }
  }

  const total = results.reduce((n, s) => {
    if (s.children) return n + s.children.length;
    return n + 1;
  }, 0);
  const ok = results.reduce((n, s) => {
    if (s.children) return n + s.children.filter((c) => c.ok).length;
    return n + (s.ok ? 1 : 0);
  }, 0);

  console.log("");
  console.log(`  ${SEP}`);
  console.log(`  总计: ${total} 个端点探测, ${ok} 成功, ${total - ok} 失败`);
  console.log(`  ${SEP}`);
  console.log("");
}

// ── Save to file ───────────────────────────────────────────────────────

function saveReport(results) {
  const dataDir = resolve(__dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = resolve(dataDir, `research-report-${ts}.json`);

  const output = {};
  for (const section of results) {
    if (section.children) {
      output[section.name] = {};
      for (const child of section.children) {
        output[section.name][child.name] = child.ok ? child.data : { error: child.error, statusCode: child.statusCode };
      }
    } else {
      output[section.name] = section.ok ? section.data : { error: section.error, statusCode: section.statusCode };
    }
  }

  writeFileSync(filePath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`  报告已保存至 ${filePath}\n`);
  return filePath;
}

// ── Main ───────────────────────────────────────────────────────────────

export async function research({ save = false, verbose = false } = {}) {
  loadEnv();

  const hub = new HubClient({
    hubUrl: process.env.HUB_URL,
    nodeId: process.env.NODE_ID,
    nodeSecret: process.env.NODE_SECRET,
  });

  if (!hub.nodeId || !hub.nodeSecret) {
    console.error("  缺少凭证。请确保 .env 中包含 NODE_ID 和 NODE_SECRET。");
    process.exit(1);
  }

  console.log(`\n  节点: ${hub.nodeId}`);
  console.log(`  Hub:  ${hub.hubUrl}`);
  console.log(`  开始探测...\n`);

  const results = [];

  results.push(await researchHubHealth(hub));
  results.push(await researchNodeSelf(hub));
  results.push(await researchTasks(hub));
  results.push(await researchAssets(hub));
  results.push(await researchCommunity(hub));
  results.push(await researchWorkerServices(hub));
  results.push(await researchWiki(hub));

  formatReport(results, verbose);

  if (save) saveReport(results);

  return results;
}

// ── Direct execution ───────────────────────────────────────────────────

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").includes("scripts/research-platform");
if (isDirectRun) {
  const flags = parseFlags(process.argv.slice(2));
  await research({ save: !!flags.save, verbose: !!flags.verbose });
}
