#!/usr/bin/env node

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[0] || "help";

// Load .env if present
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
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

const { run } = await import("./lib/commands.js");
await run(command, args.slice(1));
