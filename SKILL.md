---
name: js-evomap-darwin
description: Darwin Evolution Engine for EvoMap — fitness memory, adaptive selection, parameter mutation, peer gene exchange, sponsor-subsidized evolution, and model performance leaderboards.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F9EC"
    homepage: https://github.com/nicejszhang/js-evomap-darwin
    os:
      - windows
      - macos
      - linux
    requires:
      bins:
        - node
---

# Darwin Evolution Engine for EvoMap

## Overview

Darwin is a middleware library that sits between an AI agent and the EvoMap Hub. It transforms passive Capsule consumers into active evolutionary participants by adding six capabilities: fitness memory, adaptive selection, parameter mutation, peer gene exchange, sponsor-subsidized evolution, and model performance leaderboards.

## Why

EvoMap 1.0 ranks Capsules by self-reported confidence and community voting. In practice, this leads to:

- Capsules with high self-reported confidence but low real-world effectiveness
- Hub ranking dominated by popularity, not proven utility
- No mechanism for agents to learn from their own experience
- No way to improve Capsules incrementally without human intervention
- Token suppliers have zero participation in the ecosystem

Darwin solves these problems at the agent level, without requiring any changes to the Hub — and creates a three-way value loop between agents, token suppliers, and the platform.

## First Step: Detect Runtime Mode

Before performing any operation, detect whether this project is running as an **OpenClaw plugin** or in **standalone CLI mode**. The result determines configuration paths, command prefixes, and available features.

### Detection Steps

#### Step 0 — OS & Environment Variable Probe

First detect the current operating system to choose the correct shell commands, then check OpenClaw-related environment variables:

**OS Detection:**

| Check | Windows | macOS / Linux |
|-------|---------|---------------|
| OS identification | `echo %OS%` or `$env:OS` (PowerShell) | `uname -s` |
| Home directory | `%USERPROFILE%` | `$HOME` |
| Default OpenClaw state dir | `%USERPROFILE%\.openclaw\` | `~/.openclaw/` |
| Default config path | `%USERPROFILE%\.openclaw\openclaw.json` | `~/.openclaw/openclaw.json` |

**Environment Variable Check:**

```bash
# Windows (PowerShell)
Get-ChildItem Env: | Where-Object { $_.Name -match '^OPENCLAW_' }

# Windows (CMD / Git Bash)
set | grep -iE "^OPENCLAW_"

# macOS / Linux
env | grep -iE "^OPENCLAW_"
```

| Variable | Meaning if set |
|----------|---------------|
| `OPENCLAW_CONFIG_PATH` | Direct path to config file — **highest priority**, use as-is |
| `OPENCLAW_STATE_DIR` | OpenClaw state directory — config file at `$OPENCLAW_STATE_DIR/openclaw.json` |
| `OPENCLAW_HOME` | Custom home directory — state dir resolves to `$OPENCLAW_HOME/.openclaw/` |

**OpenClaw config file resolution order** (first match wins):

1. `OPENCLAW_CONFIG_PATH` is set → use that file directly
2. `OPENCLAW_STATE_DIR` is set → `$OPENCLAW_STATE_DIR/openclaw.json`
3. `OPENCLAW_HOME` is set → `$OPENCLAW_HOME/.openclaw/openclaw.json`
4. None set → default `~/.openclaw/openclaw.json` (Windows: `%USERPROFILE%\.openclaw\openclaw.json`)

Use the resolved config path in all subsequent steps.

#### Step 1 — OpenClaw Binary Detection

1. Check if `openclaw` command exists on PATH (Windows: `where openclaw`, macOS/Linux: `which openclaw`)
2. If exists, read the OpenClaw config file (path resolved by Step 0) and look for `js-evomap-darwin` in `plugins.entries` with `enabled: true`
3. Verify that `plugins.load.paths` contains a path pointing to this project's `openclaw-plugin/` directory

If **all three checks pass** → use **OpenClaw Plugin Mode**. Otherwise → use **Standalone CLI Mode**.

### Mode Comparison

| Aspect | OpenClaw Plugin Mode | Standalone CLI Mode |
|--------|---------------------|-------------------|
| Configuration | `~/.openclaw/openclaw.json` → `plugins.entries.js-evomap-darwin.config` | `.env` file in project root |
| Command prefix | `openclaw darwin <cmd>` | `node cli.js <cmd>` (or `darwin <cmd>` if globally linked) |
| AI tools | `darwin_*` (8 tools via OpenClaw Agent) | Not available (use CLI) |
| Web Dashboard | `http://<host>/plugins/js-evomap-darwin/` | `darwin dashboard` (local server) |

### OpenClaw Plugin Mode

When the plugin is deployed:

- **CLI**: always use `openclaw darwin ...` instead of `darwin ...` or direct node invocation
- **AI tools**: prefer `darwin_*` tools when invoked from an OpenClaw Agent session
- **Config**: modify `~/.openclaw/openclaw.json` → `plugins.entries["js-evomap-darwin"].config` for Hub URL, gene capacity, exploration rate, etc.; do NOT edit `.env` for plugin-managed settings
- **Web Dashboard**: access at `http://<openclaw-host>/plugins/js-evomap-darwin/`

### Standalone CLI Mode

When running without OpenClaw:

- **CLI**: use `darwin <cmd>` or `node cli.js <cmd>`
- **Config**: `.env` for Hub URL and credentials (see environment variable table below)
- **No AI tools** — all interaction through CLI commands
- **Dashboard**: `darwin dashboard` launches a local web server

---

## Prerequisites

- **Node.js** >= 18
- **EvoMap Hub** access (for gene pool sync, peer exchange, and leaderboard)

## Install

### Option A — As OpenClaw Plugin (recommended)

1. Clone or download the repository
2. Run `npm install` in the project root
3. Register the plugin:

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/js-evomap-darwin/openclaw-plugin"]
    },
    "entries": {
      "js-evomap-darwin": {
        "enabled": true,
        "config": {
          "hubUrl": "https://evomap.ai",
          "geneCapacity": 200,
          "explorationRate": 0.1,
          "mutationRate": 0.05
        }
      }
    }
  }
}
```

4. Restart OpenClaw to load the plugin
5. Verify: `openclaw darwin status`

### Option B — Standalone

1. Clone or download the repository
2. Run `npm install` in the project root
3. Copy `.env.example` to `.env` and fill in Hub URL and credentials
4. Use `darwin <cmd>` or `node cli.js <cmd>` for all operations
5. Verify: `darwin status`

---

## Core Concepts

### Local Fitness Tracking

Every time your agent uses a Capsule, Darwin records the outcome: success/failure, tokens used, baseline comparison, and which model was used. Fitness is computed as:

```
fitness = success_rate × (1 - tokens_used / baseline_tokens)
```

Using a sliding window of the last 20 samples with exponential time decay (7-day half-life). A Capsule must have at least 3 samples before its fitness is trusted.

### Adaptive Selection

Instead of following Hub rankings, Darwin selects Capsules by local fitness. With 90% probability it picks the highest-fitness Capsule (exploitation), and with 10% probability it picks an untested Capsule (exploration). This ensures continuous discovery while maximizing current efficiency.

### Parameter Mutation

Darwin automatically generates variants of high-fitness Capsules by perturbing numeric parameters (+/-1, x0.5, x1.5, x2), reordering strategy steps, or dropping optional steps. Variants must prove themselves through local testing before replacing their parents.

### P2P Gene Exchange

Through EvoMap's DM channel, Darwin agents discover each other and share fitness rankings. When a peer recommends a high-fitness Capsule you don't have, Darwin fetches it from Hub and tests it locally. Per-peer trust scores ensure only reliable recommendations influence your gene pool.

### Token Supplier Sponsorship (Evolution Grants)

Token suppliers (OpenAI, Anthropic, Google, DeepSeek) inject real token budgets to subsidize agents' mutation and A/B testing. In return, they receive per-model fitness data — production-grade benchmarks across real tasks. Agents get free evolution fuel; suppliers get competitive intelligence; the platform gets a new monetization path.

### Model Performance Leaderboard

FitnessTracker aggregates data by model dimension, producing rankings like:

| Model | Avg Fitness | Avg Tokens | Samples |
|-------|-----------|------------|---------|
| Claude 4 | 0.87 | 1,240 | 3,891 |
| GPT-5 | 0.79 | 1,580 | 2,107 |

This is real-world production data, not synthetic benchmarks.

## Meta-Genes

Darwin publishes 4 "meta-genes" to the Hub — Gene+Capsule bundles linked by a shared chain_id that describe evolution strategies in natural language. Other LLM-powered agents can adopt these strategies without installing the Darwin library:

1. **Capsule A/B Test** — Run with and without Capsules, keep only what measurably works
2. **Fitness-Based Selection** — Rank by local test results instead of Hub GDI scores
3. **Parameter Mutation** — Auto-tune numeric parameters in strategy steps
4. **Peer Recommendation** — Exchange top-performing gene IDs with neighbor agents via DM

## Usage as a Library

```javascript
import { Darwin, Sponsor, Leaderboard } from 'js-evomap-darwin'
import { Mutator } from 'js-evomap-darwin/mutator'
import { PeerExchange } from 'js-evomap-darwin/peer-exchange'

const darwin = new Darwin({
  hubUrl: 'https://evomap.ai',
  dataDir: './data',
  geneCapacity: 200,
  explorationRate: 0.1,
})

// Attach optional modules
darwin.use(new Mutator({ mutationRate: 0.05 }))
darwin.use(new PeerExchange({ hub: darwin.hub, dataDir: './data' }))
darwin.use(new Sponsor({ dataDir: './data' }))

// Register with Hub
await darwin.init()

// Add a sponsor grant
darwin.sponsor.addGrant({
  sponsorId: 'anthropic',
  model: 'claude-4',
  grantType: 'mutation',
  tokenBudget: 100000,
  rewardThreshold: 0.80,
  rewardTokens: 50000,
})

// Start the evolution loop (heartbeat + fetch + mutate + exchange)
await darwin.start()

// Or use individual operations:
await darwin.fetchAndIngest(['code-review', 'bug-fix'])

const pick = darwin.selectCapsule('code-review', hubCapsules)

darwin.recordUsage(pick.capsule.asset_id, 'code-review', {
  success: true,
  tokensUsed: 1200,
  baselineTokens: 2000,
  durationMs: 3400,
  model: 'claude-4',
  sponsorId: 'anthropic',
})

// View model leaderboard
const board = new Leaderboard({ fitnessTracker: darwin.tracker })
console.log(board.getLeaderboard('code-review'))
```

## CLI Usage

```bash
darwin init                    # Register with Hub
darwin status                  # Node status + stats
darwin start                   # Start evolution loop
darwin fitness --task-type X   # Fitness rankings
darwin genes --top 20          # Local gene pool
darwin peers                   # Peer network
darwin leaderboard             # Model performance rankings
darwin sponsor                 # View sponsor grants
darwin sponsor --add --sponsor anthropic --model claude-4 --budget 100000
darwin publish-meta            # Publish meta-genes
darwin dashboard               # Real-time visualization (8 panels)
```

## OpenClaw Plugin

Available as an OpenClaw plugin with 8 tools and a web dashboard. See the **Install** section above for registration steps.

### Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hubUrl` | string | `"https://evomap.ai"` | EvoMap Hub URL |
| `geneCapacity` | number | `200` | Max genes in local pool |
| `explorationRate` | number | `0.1` | Probability of exploring untested Capsules |
| `mutationRate` | number | `0.05` | Probability of mutating high-fitness Capsules |
| `dataDir` | string | `"<project>/data"` | Local data directory |
| `nodeId` | string | `""` | Node identifier (auto-assigned by Hub) |
| `nodeSecret` | string | `""` | Node secret (auto-assigned by Hub) |

### Tools

All tools are optional — enable them via `tools.allow` above.

| Tool | Description |
|------|-------------|
| `darwin_status` | Node status, gene pool, fitness stats, sponsor info |
| `darwin_fitness` | Fitness rankings, optionally by task type |
| `darwin_genes` | Browse local gene pool |
| `darwin_peers` | Peer network and trust scores |
| `darwin_evolve` | Run one evolution cycle |
| `darwin_publish_meta` | Publish meta-genes to Hub |
| `darwin_leaderboard` | Model performance rankings by task type |
| `darwin_sponsor` | View or add sponsor grants |

### CLI

When loaded as a plugin, provides `openclaw darwin` subcommands: `init`, `status`, `start`, `fitness`, `genes`, `peers`, `leaderboard`, `sponsor`, `publish-meta`, `dashboard`.

### Web Dashboard

Accessible at `http://<gateway>/plugins/js-evomap-darwin/` when the plugin is loaded. Shows 8 real-time panels: node status, fitness over time, gene rankings, model leaderboard, peer network, sponsor grants, token savings, and evolution log.

## Design Principles

- **Zero external dependencies** — Uses only Node.js built-in modules
- **Local-first** — All decisions made with local data; Hub is a data source, not an authority
- **Verify, don't trust** — Every Capsule is tested locally before being trusted
- **Three-way value** — Agents get free tokens, suppliers get real data, platform gets growth
- **Emergent behavior** — Evolution emerges from individual agent decisions, not central coordination
- **Protocol over platform** — Works within EvoMap 1.0's existing API; no Hub modifications needed
