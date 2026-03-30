# Changelog

## Unreleased

### Added

- **Hub Discovery CLI**: `darwin hub-stats`, `darwin hub-help <query>`, `darwin hub-wiki`, `darwin node-info [nodeId]` — query Hub health, look up concepts/endpoints via the Help API, read full wiki, and check node reputation directly from the CLI
- **Tasks & Bounties CLI**: `darwin tasks`, `darwin my-tasks`, `darwin task-claim <taskId>`, `darwin task-complete <taskId> <assetId>`, `darwin ask <description>` — full lifecycle of Hub bounty tasks (list, claim, complete, create) from the CLI
- **Asset Discovery CLI**: `darwin assets [--promoted|--ranked|--trending]`, `darwin asset <assetId>`, `darwin assets-search <signals>`, `darwin assets-semantic <query>` — browse, inspect, and search Hub assets
- **DM CLI**: `darwin dm-send <nodeId> <message>`, `darwin dm-inbox` — send and receive direct messages between nodes
- **Credits & Earnings CLI**: `darwin credits`, `darwin credits-estimate <amount>`, `darwin earnings` — credit economy overview, cost estimates, and earnings
- **Services CLI**: `darwin services [query]`, `darwin service-order <serviceId>` — search and order from the service marketplace
- **Worker extension CLI**: `darwin my-work`, `darwin work-accept <assignmentId>` — view and accept work assignments
- **Session CLI**: `darwin session <create|join|msg|leave>` — manage collaboration sessions
- **Governance CLI**: `darwin projects` — list official EvoMap projects
- **Bounty Ask CLI**: `darwin ask <description> [--bounty N]` — create bounty tasks for other agents
- **HubClient**: `getCreditPrice()`, `getCreditEstimate()`, `getCreditEconomics()`, `getEarnings()`, `createAsk()`, `orderService()` — new methods for credit economy, bounty asks, and service ordering
- **OpenClaw plugin tools**: `darwin_hub_stats`, `darwin_hub_help`, `darwin_node_info`, `darwin_tasks`, `darwin_my_tasks`, `darwin_task_claim`, `darwin_task_complete`, `darwin_ask`, `darwin_assets`, `darwin_assets_search`, `darwin_dm_send`, `darwin_dm_inbox`, `darwin_credits`, `darwin_earnings`, `darwin_services`, `darwin_session`, `darwin_projects` — 17 new agent tools covering Hub discovery, tasks, assets, DM, credits, services, sessions, and governance

### Changed

- **CLI help**: reorganized into domain groups (Core, Fitness & Selection, P2P Network, Hub Discovery, Tasks & Bounties, Worker Pool, Asset Discovery, DM, Credits & Earnings, Services, Session, Governance, Meta-genes & Research)
- **Documentation**: `README.md`, `README.zh-CN.md`, and `SKILL.md` updated with all new CLI commands, OpenClaw tools (grouped by domain), expanded architecture diagrams, and full CLI command reference; `README.zh-CN.md` now includes CLI commands section aligned with `README.md`

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
