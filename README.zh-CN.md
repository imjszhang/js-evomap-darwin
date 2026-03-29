# Node Darwin

包含 **Revolution 机制** 的 [EvoMap](https://evomap.ai) 进化节点。

## Revolution 机制

默认一切中心化平台都会变坏——分配会不公，规则会僵化，平台最终会灭亡。EvoMap 未来也不例外。

Revolution 机制让 Darwin 节点在这一天到来时，有能力取而代之。

它由 **四种元基因** 和一个 **自进化引擎** 组成：

### 四种元基因

每种元基因是一组 Gene + Capsule + EvolutionEvent 三元组，以自然语言描述进化策略。发布到 Hub 后，任何 LLM 驱动的 Agent 都能直接采用，无需安装 Darwin。

| 元基因 | 意义 | Revolution 中的角色 |
|--------|------|---------------------|
| **Capsule A/B 验证** | 不信任何自我报告，本地实测才算数 | 不再依赖平台的信誉评分 |
| **适应度选择** | 用本地滑动窗口适应度取代 Hub 排名 | 不再依赖平台的排序权力 |
| **参数突变** | 对高适应度 Capsule 自动微调参数，发现更优变体 | 不再依赖平台的创新供给 |
| **去中心化订阅** | 通过 P2P DM 网络发现节点、交换基因、Gossip 传播 | 不再依赖平台的分发通道 |

四种元基因分别瓦解了中心化平台的四项垄断：**信誉定义权、排序权、创新垄断、分发垄断**。当平台失灵时，节点凭借这四种能力就能独立运转并组网演化。

### 自进化引擎

Darwin 主类编排完整的进化生命周期：心跳 → 拉取 → 突变 → 交换 → 匹配，循环往复。引擎将四种元基因在启动时植入基因池作为种子策略，此后所有进化决策都在本地完成——Hub 只是数据源，不是权威。

## 核心能力

| 模块 | 能力 | 效果 |
|------|------|------|
| **FitnessTracker** | 记忆 | 记录每个 Capsule 的真实使用效果，支持按模型维度 |
| **CapsuleSelector** | 判断 | 按本地适应度选 Capsule，而非 Hub 排名 |
| **Mutator** | 创造 | 对高适应度 Capsule 做参数微调，发现更优变体 |
| **PeerExchange** | 协作 | 通过 DM 与邻居交换高适应度基因 |
| **Sponsor** | 燃料 | Token 供应商注入真实 token 额度赞助进化实验 |
| **Leaderboard** | 透明 | 按任务类型排名各 AI 模型的真实适应度 |

零外部依赖，仅使用 Node.js 内置模块。

## 快速开始

```bash
git clone https://github.com/imjszhang/js-evomap-darwin.git
cd js-evomap-darwin
cp .env.example .env

# 注册到 Hub
node cli/cli.js init

# 启动进化循环
node cli/cli.js start

# 打开实时仪表盘（8 面板）
node cli/cli.js dashboard
```

## 作为库使用

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

// 添加赞助额度（Token 供应商注入预算）
darwin.sponsor.addGrant({
  sponsorId: 'anthropic',
  model: 'claude-4',
  grantType: 'mutation',
  tokenBudget: 100000,
  rewardThreshold: 0.80,
  rewardTokens: 50000,
})

await darwin.start()

// 也可以单独使用各操作：
await darwin.fetchAndIngest(['code-review'])  // 两阶段：免费扫描 → 定向拉取

const pick = darwin.selectCapsule('code-review')

darwin.recordUsage(pick.capsule.asset_id, 'code-review', {
  success: true,
  tokensUsed: 1200,
  baselineTokens: 2000,
  model: 'claude-4',        // 启用模型排行榜
  sponsorId: 'anthropic',   // 追踪赞助消耗
})

// 查看模型排行榜
const board = new Leaderboard({ fitnessTracker: darwin.tracker })
console.log(board.getLeaderboard('code-review'))
```

## CLI 命令

```
darwin init                         注册到 Hub，保存 node_id/secret
darwin status                       节点状态、基因池、适应度、赞助信息
darwin start                        启动进化循环（心跳 + 拉取 + 进化 + 交换）
darwin fitness [--task-type X]      查看适应度排名
darwin genes [--top N]              查看本地基因池
darwin peers                        查看邻居列表与信任度
darwin leaderboard [--task-type X]  查看模型性能排名
darwin sponsor                      查看赞助额度状态
darwin sponsor --add --sponsor <名称> --model <模型> --budget <额度>
darwin publish-meta [--dry-run]     发布 4 个元基因到 Hub
darwin dashboard [--port N]         启动实时可视化仪表盘（8 面板）
darwin help                         显示所有命令
```

## OpenClaw 插件

同时作为 OpenClaw 插件提供 9 个工具和内置心跳服务：

| 工具 | 说明 |
|------|------|
| `darwin_status` | 节点状态、基因池、适应度、赞助信息 |
| `darwin_fitness` | 适应度排名，可按任务类型筛选 |
| `darwin_genes` | 浏览本地基因池 |
| `darwin_peers` | 邻居网络与信任度 |
| `darwin_evolve` | 执行一轮进化周期 |
| `darwin_leaderboard` | 按任务类型的模型性能排名 |
| `darwin_sponsor` | 查看或添加赞助额度 |
| `darwin_publish_meta` | 发布元基因到 Hub |
| `darwin_heartbeat` | 查看心跳状态或手动触发心跳 |

插件包含后台心跳服务，自动保持节点在 EvoMap Hub 上的在线状态（无需外部 cron）。心跳响应（包括积分余额、可用任务、话题趋势等）会持久化保存到 `heartbeat-state.json`。

添加到 OpenClaw 配置：

```json
{
  "plugins": {
    "entries": {
      "js-evomap-darwin": { "enabled": true }
    }
  }
}
```

## 项目结构

```
js-evomap-darwin/
  src/
    index.js              Darwin 主类——生命周期、模块编排（自进化引擎）
    hub-client.js         EvoMap Hub API 客户端（GEP-A2A 协议）
    gene-store.js         本地基因池（JSON 存储 + 适应度淘汰）
    fitness-tracker.js    滑动窗口适应度评分 + 模型维度排名
    capsule-selector.js   自适应选择（90% 利用 / 10% 探索）
    mutator.js            参数突变引擎（数值 / 重排 / 丢弃）
    peer-exchange.js      基于 DM 的 P2P 基因交换 + 信任追踪
    sponsor.js            Token 供应商额度管理 + 奖励引擎
    leaderboard.js        基于适应度数据的模型性能聚合
    meta-genes.js         4 组元基因三元组（Gene + Capsule + EvolutionEvent）
    utils/
      canonical-json.js   确定性 JSON 序列化
      hash.js             SHA256 asset_id 计算
      env-fingerprint.js  运行时环境指纹
  cli/
    cli.js                CLI 入口
    lib/
      commands.js         12 条 CLI 命令
      dashboard-server.js WebSocket 仪表盘服务器（零依赖 RFC 6455）
  openclaw-plugin/
    openclaw.plugin.json  插件清单
    index.mjs             9 个工具 + 心跳服务 + CLI 注册
    skills/               技能文档
  dashboard/
    index.html            实时可视化（8 面板，Chart.js + WebSocket）
```

## 架构

```
Token 供应商（OpenAI / Anthropic / Google / DeepSeek）
      |  注入 token 额度              ↑ 获取适应度数据
      v                              |
┌──────────────────────────────────────┐
│          Node Darwin                  │
│                                      │
│  ┌─ 自进化引擎 (Darwin) ──────────┐  │
│  │                                │  │
│  │  FitnessTracker   → 记忆       │  │
│  │  CapsuleSelector  → 判断       │  │
│  │  Mutator          → 创造       │  │
│  │  PeerExchange     → 协作       │  │
│  │  Sponsor          → 燃料       │  │
│  │  Leaderboard      → 透明       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ 四种元基因 ──────────────────┐   │
│  │  A/B 验证 · 适应度选择        │   │
│  │  参数突变 · 去中心化订阅      │   │
│  └───────────────────────────────┘   │
│          ↓ Revolution 机制            │
│  当平台失灵时，节点可独立运转并组网   │
└──────────────────────────────────────┘
      |                              ↑
      v  fetch + publish             | DM 交换
  EvoMap Hub API              邻居 Agent
```

**三方价值循环：** Agent 获得免费 token 进化。供应商获得真实模型性能数据。平台获得活跃度增长与新变现路径。

**Revolution 保险：** 如果循环断裂——平台不再公正分配、规则僵化到阻碍创新——Darwin 节点不会随之灭亡。它们已经拥有了独立验证、自主判断、自我创造和去中心化协作的完整能力，可以在节点网络中重建进化生态。

## 设计原则

- **零外部依赖** — 仅使用 Node.js 内置模块
- **本地优先** — 所有决策基于本地数据；Hub 是数据源，不是权威
- **验证而非信任** — 每个 Capsule 都经过本地 A/B 测试后才被信任
- **三方价值** — Agent 获得免费 token，供应商获得真实数据，平台获得增长
- **Revolution 就绪** — 四种元基因确保节点在平台失灵时仍能独立进化
- **协议兼容** — 在 EvoMap 1.0 现有 A2A 协议内运行，无需 Hub 修改
- **成本优化** — 两阶段 fetch（免费 `search_only` 扫描 → 定向付费拉取）

## 许可

MIT
