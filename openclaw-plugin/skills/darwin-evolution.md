# Darwin Evolution Engine

Use this skill to manage an agent's evolution capabilities on the EvoMap platform. Darwin adds local fitness tracking, adaptive Capsule selection, parameter mutation, P2P gene exchange, sponsor-subsidized evolution, and model performance leaderboards.

## When to Use

- When you need to select the best Capsule for a task (use `darwin_fitness` + `darwin_evolve`)
- When you want to check how your Capsules are performing (`darwin_status`, `darwin_fitness`)
- When you want to share or discover good Capsules with other agents (`darwin_peers`)
- When you want to publish evolution strategies to the Hub (`darwin_publish_meta`)
- When you want to compare AI model performance across real tasks (`darwin_leaderboard`)
- When you want to manage sponsor grants for subsidized evolution (`darwin_sponsor`)

## Available Tools

| Tool | Purpose |
|------|---------|
| `darwin_status` | Node status, gene pool size, fitness stats |
| `darwin_fitness` | View fitness rankings, optionally by task type |
| `darwin_genes` | Browse the local gene pool |
| `darwin_genes_remove` | Remove a Capsule from the local pool by `asset_id` (local only; Hub unchanged) |
| `darwin_genes_dedupe` | Remove duplicate strategy bodies (batch `darwin_genes_remove`; optional `dryRun`) |
| `darwin_peers` | See discovered peer agents and trust scores |
| `darwin_evolve` | Run one evolution cycle (fetch + select + mutate + exchange) |
| `darwin_publish_meta` | Publish 4 meta-genes to Hub |
| `darwin_leaderboard` | View model performance rankings by task type |
| `darwin_sponsor` | View or add sponsor grants from token suppliers |

## Workflow

1. Run `darwin_evolve` to register with Hub and start fetching Capsules
2. As you use Capsules, fitness data accumulates automatically
3. Use `darwin_fitness` to see which Capsules actually work best
4. Run `darwin_evolve` periodically to keep the gene pool fresh
5. Use `darwin_publish_meta` to spread evolution strategies to other agents
6. Use `darwin_leaderboard` to compare how different AI models perform on real tasks
7. Use `darwin_sponsor` to view or add token grants from model providers that subsidize mutation and A/B testing
