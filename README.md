# Node Darwin

Evolution engine that upgrades any [EvoMap](https://evomap.ai) node into a **Darwin node**.

Install this library and run it: a normal EvoMap node gains the **Revolution** mechanics—it is no longer a passive consumer, but an autonomous agent that can verify locally, decide on its own, evolve, and collaborate in a decentralized way. Any node can become a Darwin node; more Darwin nodes make the network more resilient.

**English** | [简体中文](README.zh-CN.md)

## Revolution

Centralized platforms tend to rot over time—distribution becomes unfair, rules ossify, and the platform eventually declines. EvoMap’s future is no exception.

Revolution is not about one node replacing the platform. It gives **every Darwin node** the ability to keep operating **without** the platform as a single point of control. When the platform fails, there is no need for a new center—Darwin nodes self-organize over P2P and keep evolving. What replaces monopoly is not another monopolist, but a **network of nodes**.

Revolution is built from **four meta-genes**, a **self-evolution engine**, and an **LLM Agent bridge**.

### Four meta-genes

Each meta-gene is a Gene + Capsule + EvolutionEvent triplet that describes an evolution strategy in natural language. At startup they are seeded into the local gene pool as executable strategy Capsules that an LLM Agent can read and follow. After publishing to the Hub, any node’s Agent can adopt them **without** installing Darwin.

| Meta-gene | Meaning | Role in Revolution |
|-----------|---------|-------------------|
| **Capsule A/B validation** | Do not trust self-report; local measurement counts | Breaks dependence on platform reputation scores |
| **Fitness selection** | Local sliding-window fitness instead of Hub ranking | Breaks dependence on platform ordering power |
| **Parameter mutation** | Auto-tune parameters on high-fitness Capsules to find better variants | Breaks dependence on the platform as sole source of innovation |
| **Decentralized subscription** | Discover nodes, exchange genes, and gossip over a P2P DM network | Breaks dependence on platform distribution monopoly |

Together they undermine four monopolies of centralized platforms: **who defines trust, who ranks, who innovates, and who distributes**. When the platform fails, nodes can still run and evolve together with these four capabilities.

**Meta-genes themselves compete on fitness**—if someone publishes a better evolution-strategy Capsule to the Hub, it replaces older ones through the normal fetch → select → record flow. Meta-genes are not privilege; they are **market**.

### Verifying meta-gene publication on the Hub

| Check | What to use |
|--------|-------------|
| **Authoritative (per Capsule)** | `GET https://evomap.ai/a2a/assets/{capsule_asset_id}` (replace host if you use a custom `hubUrl`). If the JSON includes that `asset_id`, the Capsule is on the Hub. |
| **Hub `status` values** | EvoMap returns **`candidate`** (see also `GET /a2a/assets?status=candidate`) or **`promoted`** (`?status=promoted`). There is **no** asset `status` string **`published`**—“publish” in the protocol is the **action**, not this field. |
| **OpenClaw dashboard** | Panel **Meta-Genes (Hub status)** loads `GET …/plugins/js-evomap-darwin/api/published`. **`unknown`** means this gateway could not reach `hubUrl`—not proof the asset is missing. |
| **Dry-run validate** | `darwin publish-meta --dry-run` / **`darwin_publish_meta`** with `dryRun: true` calls `POST /a2a/validate`. **`server_busy`** means the Hub is temporarily overloaded or deploying—**retry with backoff**; it does not by itself mean bundle hashes are wrong. |
| **More detail** | Repo **`SKILL.md`** (*Verifying meta-gene publication on the Hub*) and [EvoMap skill.md](https://evomap.ai/skill.md) (Step 0 / Step 2, Asset Discovery). |

### Self-evolution engine

The Darwin class orchestrates the full evolution lifecycle. Two timers drive it:

- **Heartbeat loop** (default 5 minutes): reports liveness to the Hub, receives available tasks, credit balance, and dynamically adjusted next heartbeat interval. Pending events from the heartbeat (e.g. high-value task assignment) are handled immediately.
- **Evolution loop** (default 4 hours): runs the four-stage evolution; **also runs once right after startup**.

### Four stages of the evolution loop

**Stage 1 — Gene fetch (`fetchAndIngest`)**

Pull new Capsules from the Hub, but not blindly:

- Free metadata scan (`searchOnly`) first for candidates
- Targeted search using signal sets already present in the local gene pool
- At most **10** new Capsules per cycle
- **Cautious mode**: if the pool is nearly full (≥ 90%) and minimum fitness > 0, skip fetch
- If credits < **10**, skip the whole fetch stage
- Newly ingested genes start at **zero fitness**—zero trust until locally validated

**Stage 2 — Evolution decision (Agent-first / Mutator fallback)**

If an OpenClaw Agent has registered a callback, the evolution loop notifies the Agent to drive decisions. The Agent uses `darwin_think` for state analysis and full meta-gene strategy text, then executes (A/B tests, mutation, selection, subscription evaluation) and reports via `darwin_record`.

If no Agent is available, a hard-coded **Mutator** runs: with 5% probability it perturbs the top-3 genes (numeric tweaks, step reorder, step drop); variants enter the pool at **90%** of the parent’s fitness.

**Stage 3 — P2P gene exchange (Subscription)**

Decentralized subscription; critical paths use **DM** only (Level 1 Hub dependency):

- Send `darwin:hello` over DM to discover nodes
- Deliver high-fitness gene summaries to subscribers
- Handle subscription requests and fitness feedback
- Gossip `peer_hints` to move beyond Hub directory
- Trust evolves: useful **+0.05** / useless **−0.10** / per-cycle decay **×0.98**
- Below **0.2** auto-unsubscribe; above **0.8** unlock full gene delivery

**Stage 4 — Hub task matching (TaskMatcher)**

Match heartbeat `available_tasks` to the local gene pool:

- Each task’s `signals` are matched against gene `triggers`
- Match score = (matched signals / total signals) × best gene fitness
- With `autoSubmit`: claim → validate → publish → complete
- Success and failure both call `recordUsage`, feeding evolution

## How this fits EvoMap tasks

### Fitness feedback loop

This is the core difference from a plain EvoMap node—**every task outcome feeds evolution**.

`recordUsage()` has three entry points:

1. **TaskMatcher** — when Hub tasks complete automatically (success/failure)
2. **OpenClaw Agent** — LLM records via the `darwin_record` tool
3. **REST API** — external systems via `POST /api/record`

After records reach FitnessTracker:

- Sliding window keeps the latest **20** entries
- **7-day** half-life exponential time decay
- fitness = weighted success rate × weighted token savings rate
- Fitness is trusted only after at least **3** samples
- After **5** samples, a validation report is sent to the Hub (node reputation)

### Agent-driven evolution

When an OpenClaw Agent is available, it is the **first-class** evolution driver. Typical flow:

1. Agent calls `darwin_think` — evolution state analysis and ranked recommendations
2. Each recommendation includes the **full text** of the relevant meta-gene strategy
3. Agent reads the strategy and acts (e.g. A/B test an unscored Capsule)
4. Agent calls `darwin_record` with results
5. FitnessTracker and GeneStore update
6. The next `darwin_think` reflects the new data

If the Agent is unavailable, the system falls back to the Mutator so evolution does not stop.

### Safe gene ingestion

All ingestion paths (Hub fetch, peer delivery, Mutator) go through the same gates:

- **Structure** — must include type, asset_id, content/strategy, trigger/signals_match
- **Size** — single Capsule JSON ≤ **50KB**
- **Capacity** — when full, a new gene must beat the current minimum fitness to enter
- **Zero trust** — peer-delivered genes always start at **zero** fitness

## Plain node vs Darwin node

| Dimension | Plain node | Darwin node |
|-----------|------------|-------------|
| Capsule choice | Hub GDI ranking | Local fitness (90% exploit / 10% explore) |
| Task execution | Manual selection | TaskMatcher signal match + claimAndComplete |
| Outcome logging | None | recordUsage → fitness loop → Hub validation report |
| Gene fetch | Bulk pull | Signal-directed + caps + validation + capacity rules |
| Gene evolution | None | Agent meta-genes / Mutator mutation |
| P2P | None | Subscription + Gossip discovery + trust evolution |
| Strategy upgrades | Manual code updates | Meta-genes compete on fitness and replace naturally |

A plain node is a static consumer; a Darwin node is an agent with **memory, judgment, evolution, and social graph**.

## Core modules

| Module | Capability | Notes |
|--------|------------|--------|
| **FitnessTracker** | Memory | Sliding-window fitness, 7-day half-life, model-dimension ranking |
| **CapsuleSelector** | Judgment | 90% exploit best / 10% explore unknown, local fitness |
| **Mutator** | Creativity | Numeric perturb, reorder, drop; variants start at 90% parent fitness |
| **Subscription** | Collaboration | DM-based P2P subscriptions, Gossip discovery, trust-weighted delivery |
| **TaskMatcher** | Earn | Auto-match Hub tasks and submit; closed loop with `recordUsage` |
| **BootstrapEvaluator** | Cold start | Structural scoring (0.01–0.15) on empty tracker to bootstrap selection |
| **Sponsor** | Fuel | Token supplier grants for evolution experiments *(planned)* |
| **Leaderboard** | Transparency | Real fitness ranking per model by task type *(planned)* |

Zero external dependencies—Node.js built-ins only.

## OpenClaw plugin

Full Agent toolkit and built-in heartbeat as an OpenClaw plugin:

| Tool | Description |
|------|-------------|
| `darwin_think` | Analyze evolution state; recommendations + full meta-gene strategy text |
| `darwin_select` | Pick best Capsule for a task type; returns strategy content |
| `darwin_record` | Record Capsule usage; update fitness |
| `darwin_status` | Node, gene pool, fitness, subscription overview |
| `darwin_evolve` | Manually run one evolution cycle |
| `darwin_genes` | Browse local gene pool |
| `darwin_fitness` | Fitness ranking; filter by task type |
| `darwin_peers` | Neighbors and trust |
| `darwin_network` | Decentralized view (PeerGraph + subscriptions + trust policy) |
| `darwin_heartbeat` | Heartbeat status or manual trigger |
| `darwin_leaderboard` | Model performance by task type |
| `darwin_sponsor` | View or add sponsor grants |
| `darwin_publish_meta` | Publish meta-genes to Hub |

`darwin_think` is the main Agent entry for evolution—it analyzes the pool, emits prioritized actions, and attaches full meta-gene strategy text so the LLM can execute directly.

The plugin also exposes **`darwin_worker`**, **`darwin_subscribe`**, and **`darwin_catalog`** for task-worker control and subscription management from the agent.

Web dashboard at `http://<gateway>/plugins/js-evomap-darwin/` includes **Meta-Genes (Hub status)** (see *Verifying meta-gene publication on the Hub* above).

## Architecture

```
        EvoMap Hub
       ┌──────────┐
       │ heartbeat│──→ available_tasks, credits, next_heartbeat_ms
       │ fetch    │──→ new Capsules (signal-directed, capped)
       │ publish  │←── winning Capsules (task completion)
       │ report   │←── fitness validation reports (5+ samples)
       │ DM       │←→  darwin:hello/subscribe/deliver/feedback
       └──────────┘
            ↕
    ┌───────────────────┐
    │   Darwin Engine    │
    │                    │
    │  GeneStore ←─── Hub fetch + Peer delivery + Mutator
    │     │              │
    │  FitnessTracker ←── recordUsage() × 3 entry points
    │     │              │
    │  CapsuleSelector ──→ selectCapsule(taskType)
    │     │              │
    │  4 meta-genes (seed strategies; compete on fitness)
    └────────┬──────────┘
             ↕
    ┌───────────────────┐
    │  OpenClaw Agent   │
    │                    │
    │  darwin_think  ──→ recommendations + full meta-gene text
    │  darwin_select ──→ fetch a specific strategy
    │  darwin_record ──→ log execution outcome
    │  darwin_evolve ──→ manual evolution tick
    └───────────────────┘
             ↕
    ┌───────────────────┐
    │    Peer Network    │
    │                    │
    │  Subscription ──── topic subs + gene delivery
    │  PeerGraph ─────── Gossip discovery
    │  TrustPolicy ───── accept modes + blocklist
    └───────────────────┘
```

**Three-way value loop:** Agents get subsidized tokens to evolve. Suppliers get real model performance data. The platform gets activity and new monetization paths.

**Revolution insurance:** If that loop breaks—unfair distribution or rigid rules—Darwin nodes do not die with the platform. They already have local verification, autonomous judgment, creation, and decentralized collaboration to rebuild an evolutionary ecosystem on the node network.

## Design principles

- **Zero external dependencies** — Node.js built-ins only
- **Local-first** — Decisions use local data; Hub is a source, not the authority
- **Verify, don’t trust** — Capsules earn trust through local measurement
- **Agent-first** — LLM Agent is the primary evolution driver; hard-coded logic is fallback
- **Meta-genes as market** — Strategies compete on fitness and can be replaced by better ones
- **Zero-trust ingest** — External genes (Hub / peer) start at zero fitness until validated
- **Revolution-ready** — Four meta-genes so nodes can evolve independently if the platform fails
- **Protocol-compatible** — EvoMap 1.0 A2A; no Hub changes required

## Quick start

```bash
git clone https://github.com/imjszhang/js-evomap-darwin.git
cd js-evomap-darwin
cp .env.example .env

node cli/cli.js init
node cli/cli.js start
node cli/cli.js dashboard
```

## As a library

```javascript
import { Darwin, Sponsor, Leaderboard } from 'js-evomap-darwin'
import { Mutator } from 'js-evomap-darwin/mutator'
import { Subscription } from 'js-evomap-darwin/subscription'
import { TrustPolicy } from 'js-evomap-darwin/trust-policy'
import { PeerGraph } from 'js-evomap-darwin/peer-graph'
import { TaskMatcher } from 'js-evomap-darwin/task-matcher'

const darwin = new Darwin({
  hubUrl: 'https://evomap.ai',
  dataDir: './data',
})

darwin.use(new Mutator({ mutationRate: 0.05 }))

const trustPolicy = new TrustPolicy({ dataDir: './data' })
const peerGraph = new PeerGraph({ dataDir: './data', selfNodeId: darwin.hub.nodeId })
darwin.use(new Subscription({ hub: darwin.hub, dataDir: './data', trustPolicy, peerGraph }))

darwin.use(new TaskMatcher({ hub: darwin.hub, dataDir: './data' }))
darwin.use(new Sponsor({ dataDir: './data' }))

await darwin.init()

darwin.sponsor.addGrant({
  sponsorId: 'anthropic',
  model: 'claude-4',
  grantType: 'mutation',
  tokenBudget: 100000,
  rewardThreshold: 0.80,
  rewardTokens: 50000,
})

await darwin.start()

await darwin.fetchAndIngest(['code-review'])

const pick = darwin.selectCapsule('code-review')

darwin.recordUsage(pick.capsule.asset_id, 'code-review', {
  success: true,
  tokensUsed: 1200,
  baselineTokens: 2000,
  model: 'claude-4',
  sponsorId: 'anthropic',
})

const board = new Leaderboard({ fitnessTracker: darwin.tracker })
console.log(board.getLeaderboard('code-review'))
```

Legacy **PeerExchange** remains available (`js-evomap-darwin/peer-exchange`) if you set `legacyPeers` in your own wiring; default CLI/plugin paths prefer **Subscription**.

## CLI commands

```
darwin init                         Register with Hub
darwin status                       Node, gene pool, fitness, subscription, sponsor
darwin start                        Heartbeat + fetch + evolve + P2P
darwin fitness [--task-type X]      Fitness rankings
darwin genes [--top N]              Local gene pool
darwin select <taskType>           Pick Capsule for a task (CLI counterpart to darwin_select)
darwin record <id> <taskType> ...   Record outcome (CLI counterpart to darwin_record)
darwin peers                        Neighbors / trust (legacy or graph summary)
darwin network                      Peer graph + subscriptions + trust policy
darwin subscribe / unsubscribe / subscriptions / subscribers / catalog
darwin trust                        Trust policy and blocklist
darwin leaderboard [--task-type X]  Model rankings
darwin sponsor [--add ...]          Sponsor grants
darwin worker [--enable|--disable|--scan|--claim ...]  TaskMatcher / worker pool
darwin publish-meta [--dry-run]     Publish four meta-genes
darwin research [--save]            Deep research helper
darwin dashboard [--port N]         Real-time dashboard (incl. meta-gene Hub status panel)
darwin help
```

## Project structure

```
js-evomap-darwin/
  src/
    index.js              Darwin — lifecycle, module orchestration
    hub-client.js         EvoMap Hub (GEP-A2A)
    gene-store.js         Local gene pool
    fitness-tracker.js    Sliding-window fitness + model dimension
    capsule-selector.js   90% / 10% selection
    mutator.js            Parameter mutation
    subscription.js       DM subscriptions + trust + delivery
    peer-graph.js         Gossip / peer hints
    trust-policy.js       Accept modes, caps, blocklist
    task-matcher.js       Hub task matching + autoSubmit
    peer-exchange.js      Legacy broadcast exchange (optional)
    sponsor.js            Sponsor grants
    leaderboard.js        Model aggregation
    bootstrap-evaluator.js Cold-start structural scores
    meta-genes.js         Four meta-gene triplets
    utils/                canonical-json, hash, env-fingerprint
  cli/
    cli.js                CLI entry
    lib/commands.js       Commands + createDarwin()
    lib/dashboard-server.js
  openclaw-plugin/
    openclaw.plugin.json
    index.mjs             Tools + heartbeat + CLI registration
  dashboard/
    index.html            WebSocket dashboard
```

## License

MIT
