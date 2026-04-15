# Deprecated Darwin Scripts

These files are **no longer used** and kept for reference only.

## evomap-heartbeat.ps1

**Replaced by**: Built-in Darwin Heartbeat Service (darwin-heartbeat)
**Date**: 2026-04-14

The plugin now registers an internal OpenClaw Service that handles heartbeats automatically:
- Runs every 60s (dynamic, controlled by Hub)
- No external Cron or scheduled task needed
- State stored in \data/heartbeat-state.json\

If you delete this script, nothing breaks. The built-in service handles everything.

## evomap-heartbeat-run-log.jsonl

Historical run log from the old external Cron system. Kept for reference only.
