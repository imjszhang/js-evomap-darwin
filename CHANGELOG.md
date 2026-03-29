# Changelog

## Unreleased

### Changed

- **Documentation**: `README.md` and `SKILL.md` aligned with `README.zh-CN.md`—Revolution framing, four meta-genes vs platform monopolies, heartbeat and evolution loops, four-stage evolve cycle (fetch → Agent/Mutator → Subscription → TaskMatcher), `recordUsage` entry points and Hub validation reporting, Agent-first evolution with `darwin_think` / `darwin_select` / `darwin_record`, gene ingestion safeguards, plain-vs-Darwin comparison and core-module tables, architecture diagram, design principles, Subscription/TaskMatcher-first library and CLI examples, and OpenClaw tool list (plus `darwin_worker`, `darwin_subscribe`, `darwin_catalog`).

## 0.2.0

Three-way value engine: sponsor grants, model leaderboard, cost-optimized fetching.

### Added

- **Sponsor module** (`src/sponsor.js`): grant lifecycle management, token consumption tracking, reward engine (fitness-triggered token bonus), persistent storage (`sponsors.json` + `sponsor-log.jsonl`)
- **Leaderboard module** (`src/leaderboard.js`): aggregate model performance ranking from fitness data, per-task-type and overall leaderboards, sponsor performance reports
- **FitnessTracker**: `model` and `sponsorId` fields in `record()`; `rankByModel(taskType)` method for model-dimension fitness aggregation
- **Darwin core**: `use()` supports Sponsor attachment; evolve cycle consumes sponsor tokens and emits `grant-consumed` events; `getStatus()` returns `peerCount`, `sponsor`, and `leaderboard` data; `peers` getter
- **Two-phase fetch** in `fetchAndIngest()`: free `searchOnly` metadata scan, then targeted fetch for missing Capsules only
- **Dashboard**: 2 new panels — Model Performance (bar chart ranking) and Sponsor Grants (per-sponsor cards with progress bars); WebSocket protocol extended with `leaderboard`, `sponsor`, and `peers` message types
- **CLI**: `darwin leaderboard [--task-type X]`, `darwin sponsor [--add]`, `darwin help`; status now displays peer count and sponsor info
- **OpenClaw plugin**: `darwin_leaderboard` and `darwin_sponsor` tools; `leaderboard` and `sponsor` CLI subcommands
- **Hub client**: `hello()` declares darwin capabilities in `identity_doc` (darwin version, feature list)
- **Meta-genes**: unified `chain_id` (`darwin-evolution-strategies-v1`) across all 4 gene triplets for Hub discoverability
- **Package exports**: `./sponsor` and `./leaderboard` added to `package.json`

### Fixed

- CLI `createDarwin()` now mounts Mutator and PeerExchange — previously neither was attached, so `darwin start` ran without mutation or peer exchange
- `cmdPeers` uses `darwin.peers.getPeers()` instead of constructing a standalone PeerExchange instance
- Dashboard broadcasts peer data on initial WebSocket connection and after each evolve cycle
- README removed references to non-existent `darwin stop` and `darwin mutate <capsule_id>` commands

## 0.1.0

Initial release.

### Added

- Core evolution engine: FitnessTracker, CapsuleSelector, Mutator, PeerExchange
- EvoMap Hub API client (GEP-A2A protocol)
- CLI: init, status, start, fitness, genes, peers, publish-meta, dashboard
- OpenClaw plugin with tools and CLI integration
- Real-time visualization dashboard (6 panels)
- 4 meta-genes for publishing evolution strategies to the Hub
