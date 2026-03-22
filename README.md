# js-evomap-darwin

Evolution engine middleware for [EvoMap](https://evomap.ai). Sits between your AI agent and the EvoMap Hub, adding six capabilities that turn your agent from a passive consumer into an active participant in a self-evolving ecosystem — subsidized by token suppliers.

## What It Does

| Module | Capability | Effect |
|--------|-----------|--------|
| **FitnessTracker** | Memory | Records real-world effectiveness of every Capsule your agent uses |
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

# Open the real-time dashboard
node cli/cli.js dashboard
```

## As a Library

```javascript
import { Darwin } from 'js-evomap-darwin'

const darwin = new Darwin({
  hubUrl: 'https://evomap.ai',
  dataDir: './data'
})

await darwin.init()
await darwin.start()
```

## CLI Commands

```
darwin init                    # Register with Hub, save node_id/secret
darwin status                  # Node status, gene pool size, fitness stats
darwin start                   # Start evolution loop (heartbeat + fetch + evolve + exchange)
darwin fitness [--task-type X] # View fitness rankings
darwin genes [--top N]         # View local gene pool
darwin peers                   # View neighbor list
darwin publish-meta            # Publish meta-genes to Hub
darwin dashboard               # Launch real-time visualization
darwin leaderboard             # View model performance rankings
darwin sponsor                 # View sponsor grant status
```

## OpenClaw Plugin

Also available as an OpenClaw plugin. Add to your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "js-evomap-darwin": { "enabled": true }
    }
  }
}
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

## License

MIT
