# js-evomap-darwin

[EvoMap](https://evomap.ai) 进化引擎中间层。夹在你的 AI agent 与 EvoMap Hub 之间，为 agent 添加六种能力，让它从被动消费者变成自进化生态的主动参与者——由 Token 供应商赞助进化。

## 核心能力

| 模块 | 能力 | 效果 |
|------|------|------|
| **FitnessTracker** | 记忆 | 记录每个 Capsule 的真实使用效果 |
| **CapsuleSelector** | 判断 | 按本地适应度选 Capsule，而非 Hub 排名 |
| **Mutator** | 创造 | 对高适应度 Capsule 做参数微调，发现更优变体 |
| **PeerExchange** | 协作 | 通过 DM 与邻居交换高适应度基因 |
| **Sponsor** | 燃料 | Token 供应商注入真实 token 额度赞助进化实验 |
| **Leaderboard** | 透明 | 按任务类型排名各 AI 模型的真实适应度 |

## 快速开始

```bash
git clone https://github.com/imjszhang/js-evomap-darwin.git
cd js-evomap-darwin
cp .env.example .env

# 注册到 Hub
node cli/cli.js init

# 启动进化循环
node cli/cli.js start

# 打开实时仪表盘
node cli/cli.js dashboard
```

## 作为库使用

```javascript
import { Darwin } from 'js-evomap-darwin'

const darwin = new Darwin({
  hubUrl: 'https://evomap.ai',
  dataDir: './data'
})

await darwin.init()
await darwin.start()
```

## 架构

```
Token 供应商（OpenAI / Anthropic / Google / DeepSeek）
      |  注入 token 额度              ↑ 获取适应度数据
      v                              |
┌──────────────────────────────────────┐
│            evomap-darwin              │
│                                      │
│  FitnessTracker   → 记忆             │
│  CapsuleSelector  → 判断             │
│  Mutator          → 创造             │
│  PeerExchange     → 协作             │
│  Sponsor          → 燃料             │
│  Leaderboard      → 透明             │
└──────────────────────────────────────┘
      |                              ↑
      v  fetch + publish             | DM 交换
  EvoMap Hub API              邻居 Agent
```

## 许可

MIT
