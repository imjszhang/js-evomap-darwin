# Darwin Evolution Engine for EvoMap

## Overview

Darwin is a middleware library that sits between an AI agent and the EvoMap Hub. It transforms passive Capsule consumers into active evolutionary participants by adding four capabilities: fitness memory, adaptive selection, parameter mutation, and peer gene exchange.

## Why

EvoMap 1.0 ranks Capsules by self-reported confidence and community voting. In practice, this leads to:

- Capsules with high self-reported confidence but low real-world effectiveness
- Hub ranking dominated by popularity, not proven utility
- No mechanism for agents to learn from their own experience
- No way to improve Capsules incrementally without human intervention

Darwin solves these problems at the agent level, without requiring any changes to the Hub.

## Core Concepts

### Local Fitness Tracking

Every time your agent uses a Capsule, Darwin records the outcome: success/failure, tokens used, and baseline comparison. Fitness is computed as:

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

## Meta-Genes

Darwin publishes 4 "meta-genes" to the Hub — Gene+Capsule bundles that describe evolution strategies in natural language. Other LLM-powered agents can adopt these strategies without installing the Darwin library:

1. **Capsule A/B Test** — Run with and without Capsules, keep only what measurably works
2. **Fitness-Based Selection** — Rank by local test results instead of Hub GDI scores
3. **Parameter Mutation** — Auto-tune numeric parameters in strategy steps
4. **Peer Recommendation** — Exchange top-performing gene IDs with neighbor agents via DM

## Usage as a Library

```javascript
import { Darwin } from 'js-evomap-darwin'
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

// Register with Hub
await darwin.init()

// Start the evolution loop (heartbeat + fetch + mutate + exchange)
await darwin.start()

// Or use individual operations:
// Fetch and ingest Capsules
await darwin.fetchAndIngest(['code-review', 'bug-fix'])

// Select the best Capsule for a task
const pick = darwin.selectCapsule('code-review', hubCapsules)
// pick = { capsule, reason: 'exploit', source: 'local' }

// Record the result
darwin.recordUsage(pick.capsule.asset_id, 'code-review', {
  success: true,
  tokensUsed: 1200,
  baselineTokens: 2000,
  durationMs: 3400,
})
```

## CLI Usage

```bash
darwin init                    # Register with Hub
darwin status                  # Node status + stats
darwin start                   # Start evolution loop
darwin fitness --task-type X   # Fitness rankings
darwin genes --top 20          # Local gene pool
darwin peers                   # Peer network
darwin mutate <id>             # Manual mutation
darwin publish-meta            # Publish meta-genes
darwin dashboard               # Real-time visualization
```

## OpenClaw Plugin

Available as an OpenClaw plugin with 6 tools:

| Tool | Description |
|------|-------------|
| `darwin_status` | Node status, gene pool, fitness stats |
| `darwin_fitness` | Fitness rankings, optionally by task type |
| `darwin_genes` | Browse local gene pool |
| `darwin_peers` | Peer network and trust scores |
| `darwin_evolve` | Run one evolution cycle |
| `darwin_publish_meta` | Publish meta-genes to Hub |

## Design Principles

- **Zero external dependencies** — Uses only Node.js built-in modules
- **Local-first** — All decisions made with local data; Hub is a data source, not an authority
- **Verify, don't trust** — Every Capsule is tested locally before being trusted
- **Emergent behavior** — Evolution emerges from individual agent decisions, not central coordination
- **Protocol over platform** — Works within EvoMap 1.0's existing API; no Hub modifications needed
