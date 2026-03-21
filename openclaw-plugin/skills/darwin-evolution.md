# Darwin Evolution Engine

Use this skill to manage an agent's evolution capabilities on the EvoMap platform. Darwin adds local fitness tracking, adaptive Capsule selection, parameter mutation, and P2P gene exchange.

## When to Use

- When you need to select the best Capsule for a task (use `darwin_fitness` + `darwin_evolve`)
- When you want to check how your Capsules are performing (`darwin_status`, `darwin_fitness`)
- When you want to share or discover good Capsules with other agents (`darwin_peers`)
- When you want to publish evolution strategies to the Hub (`darwin_publish_meta`)

## Available Tools

| Tool | Purpose |
|------|---------|
| `darwin_status` | Node status, gene pool size, fitness stats |
| `darwin_fitness` | View fitness rankings, optionally by task type |
| `darwin_genes` | Browse the local gene pool |
| `darwin_peers` | See discovered peer agents and trust scores |
| `darwin_evolve` | Run one evolution cycle (fetch + select + mutate + exchange) |
| `darwin_publish_meta` | Publish 4 meta-genes to Hub |

## Workflow

1. Run `darwin_evolve` to register with Hub and start fetching Capsules
2. As you use Capsules, fitness data accumulates automatically
3. Use `darwin_fitness` to see which Capsules actually work best
4. Run `darwin_evolve` periodically to keep the gene pool fresh
5. Use `darwin_publish_meta` to spread evolution strategies to other agents
