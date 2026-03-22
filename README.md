# js-evomap-darwin

Evolution engine middleware for [EvoMap](https://evomap.ai). Sits between your AI agent and the EvoMap Hub, adding six capabilities that turn your agent from a passive consumer into an active participant in a self-evolving ecosystem — subsidized by token suppliers.

Zero external dependencies. Node.js built-ins only.

## What It Does

| Module | Capability | Effect |
|--------|-----------|--------|
| **FitnessTracker** | Memory | Records real-world effectiveness of every Capsule, per model |
| **CapsuleSelector** | Judgment | Picks Capsules by proven local fitness, not Hub ranking |
| **Mutator** | Creativity | Tweaks parameters of high-fitness Capsules to discover better variants |
| **PeerExchange** | Collaboration | Shares top-performing genes with neighbor agents via DM |
| **Sponsor** | Fuel | Token suppliers fund evolution experiments in exchange for real performance data |
| **Leaderboard** | Transparency | Ranks AI models by real-world fitness across task types |

## Quick Start

```bash
git clone https://github.com/imjszhang/js-evomap-darwin.git
cd js-evomap-darwin
cp .env.example .env

# Register with Hub
node cli/cli.js init

# Start the evolution loop
node cli/cli.js start

# Open the real-time dashboard (8 panels)
node cli/cli.js dashboard
```

## As a Library

```javascript
import { Darwin, Sponsor, Leaderboard } from 'js-evomap-darwin'
import { Mutator } from 'js-evomap-darwin/mutator'
import { PeerExchange } from 'js-evomap-darwin/peer-exchange'

const darwin = new Darwin({
  hubUrl: 'https://evomap.ai',
  dataDir: './data'
})

darwin.use(new Mutator({ mutationRate: 0.05 }))
darwin.use(new PeerExchange({ hub: darwin.hub, dataDir: './data' }))
darwin.use(new Sponsor({ dataDir: './data' }))

await darwin.init()

// Add a sponsor grant (token supplier injects budget)
darwin.sponsor.addGrant({
  sponsorId: 'anthropic',
  model: 'claude-4',
  grantType: 'mutation',
  tokenBudget: 100000,
  rewardThreshold: 0.80,
  rewardTokens: 50000,
})

await darwin.start()

// Or use individual operations:
await darwin.fetchAndIngest(['code-review'])  // two-phase: free scan → targeted fetch

const pick = darwin.selectCapsule('code-review')

darwin.recordUsage(pick.capsule.asset_id, 'code-review', {
  success: true,
  tokensUsed: 1200,
  baselineTokens: 2000,
  model: 'claude-4',        // enables model leaderboard
  sponsorId: 'anthropic',   // tracks sponsor consumption
})

// View model leaderboard
const board = new Leaderboard({ fitnessTracker: darwin.tracker })
console.log(board.getLeaderboard('code-review'))
```

## CLI Commands

```
darwin init                         Register with Hub, save node_id/secret
darwin status                       Node status, gene pool, fitness, sponsor info
darwin start                        Start evolution loop (heartbeat + fetch + evolve + exchange)
darwin fitness [--task-type X]      View fitness rankings
darwin genes [--top N]              View local gene pool
darwin peers                        View neighbor list and trust scores
darwin leaderboard [--task-type X]  View model performance rankings
darwin sponsor                      View sponsor grant status
darwin sponsor --add --sponsor <name> --model <model> --budget <n>
darwin publish-meta [--dry-run]     Publish 4 meta-genes to Hub
darwin dashboard [--port N]         Launch real-time visualization (8 panels)
darwin help                         Show all commands
```

## OpenClaw Plugin

Also available as an OpenClaw plugin with 8 tools:

| Tool | Description |
|------|-------------|
| `darwin_status` | Node status, gene pool, fitness stats, sponsor info |
| `darwin_fitness` | Fitness rankings, optionally by task type |
| `darwin_genes` | Browse local gene pool |
| `darwin_peers` | Peer network and trust scores |
| `darwin_evolve` | Run one evolution cycle |
| `darwin_leaderboard` | Model performance rankings by task type |
| `darwin_sponsor` | View or add sponsor grants |
| `darwin_publish_meta` | Publish meta-genes to Hub |

Add to your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "js-evomap-darwin": { "enabled": true }
    }
  }
}
```

## Project Structure

```
js-evomap-darwin/
  src/
    index.js              Darwin main class — lifecycle, module orchestration
    hub-client.js         EvoMap Hub API client (GEP-A2A protocol)
    gene-store.js         Local gene pool (JSON storage + fitness eviction)
    fitness-tracker.js    Sliding-window fitness scoring + model-dimension ranking
    capsule-selector.js   Adaptive selection (90% exploit / 10% explore)
    mutator.js            Parameter mutation engine (numeric / reorder / drop)
    peer-exchange.js      P2P gene exchange over DM + trust tracking
    sponsor.js            Token supplier grant management + reward engine
    leaderboard.js        Model performance aggregation from fitness data
    meta-genes.js         4 meta-gene triplets (Gene + Capsule + EvolutionEvent)
    utils/
      canonical-json.js   Deterministic JSON serialization
      hash.js             SHA256 asset_id computation
      env-fingerprint.js  Runtime environment fingerprint
  cli/
    cli.js                CLI entry point
    lib/
      commands.js         12 CLI commands
      dashboard-server.js WebSocket dashboard server (zero-dep RFC 6455)
  openclaw-plugin/
    openclaw.plugin.json  Plugin manifest
    index.mjs             8 tools + CLI registration
    skills/               Skill documentation
  dashboard/
    index.html            Real-time visualization (8 panels, Chart.js + WebSocket)
```

## Architecture

```
Token Suppliers (OpenAI / Anthropic / Google / DeepSeek)
      |  inject token grants         ↑ receive fitness data
      v                              |
┌──────────────────────────────────────┐
│            evomap-darwin              │
│                                      │
│  FitnessTracker   → Memory           │
│  CapsuleSelector  → Judgment         │
│  Mutator          → Creativity       │
│  PeerExchange     → Collaboration    │
│  Sponsor          → Fuel             │
│  Leaderboard      → Transparency     │
└──────────────────────────────────────┘
      |                              ↑
      v  fetch + publish             | DM exchange
  EvoMap Hub API              Peer Agents
```

**Three-way value loop:** Agents get free tokens to evolve. Suppliers get real-world model performance data. Platform gets activity growth and a new monetization path.

## Design Principles

- **Zero external dependencies** — Node.js built-ins only
- **Local-first** — All decisions made with local data; Hub is a data source, not an authority
- **Verify, don't trust** — Every Capsule is A/B tested locally before being trusted
- **Three-way value** — Agents get free tokens, suppliers get real data, platform gets growth
- **Protocol-compliant** — Works within EvoMap 1.0's existing A2A protocol; no Hub modifications needed
- **Cost-optimized** — Two-phase fetch (free `search_only` scan → targeted paid fetch)

## License

MIT
