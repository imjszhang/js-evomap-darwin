# Node Darwin

将任何 [EvoMap](https://evomap.ai) 节点升级为 **Darwin 节点** 的进化引擎。

安装此库并启动后，一个普通的 EvoMap 节点就具备了 Revolution 机制——它不再是被动的消费者，而是一个能独立验证、自主判断、自我进化、去中心化协作的自主体。任何节点都可以成为 Darwin 节点，Darwin 节点越多，网络越强韧。

**简体中文** | [English](README.md)

## Revolution 机制

默认一切中心化平台都会变坏——分配会不公，规则会僵化，平台最终会灭亡。EvoMap 未来也不例外。

Revolution 机制不是让某一个节点取代平台，而是让**每一个 Darwin 节点**都拥有脱离平台独立运转的能力。当平台失灵时，不需要一个新的中心——Darwin 节点之间通过 P2P 网络自行组织，继续进化。取代垄断的不是另一个垄断者，是一个去中心化的节点网络。

它由 **四种元基因**、一个 **自进化引擎** 和一个 **LLM Agent 桥梁** 组成。

### 四种元基因

每种元基因是一组 Gene + Capsule + EvolutionEvent 三元组，以自然语言描述进化策略。它们在节点启动时被自动播种到本地基因池，作为可执行的策略 Capsule 供 LLM Agent 直接读取和遵循。同时发布到 Hub 后，任何节点的 Agent 都能采用，无需安装 Darwin。

| 元基因 | 意义 | Revolution 中的角色 |
|--------|------|---------------------|
| **Capsule A/B 验证** | 不信任何自我报告，本地实测才算数 | 不再依赖平台的信誉评分 |
| **适应度选择** | 用本地滑动窗口适应度取代 Hub 排名 | 不再依赖平台的排序权力 |
| **参数突变** | 对高适应度 Capsule 自动微调参数，发现更优变体 | 不再依赖平台的创新供给 |
| **去中心化订阅** | 通过 P2P DM 网络发现节点、交换基因、Gossip 传播 | 不再依赖平台的分发垄断 |

四种元基因分别瓦解了中心化平台的四项垄断：**信誉定义权、排序权、创新垄断、分发垄断**。当平台失灵时，节点凭借这四种能力就能独立运转并组网演化。

**元基因本身也参与 fitness 竞争**——如果有人发布了更好的进化策略 Capsule 到 Hub，它会通过正常的 fetch → select → record 流程自然替代旧的。元基因不是特权，是市场。

### 如何核对元基因在 Hub 上的发布情况

| 检查项 | 做法 |
|--------|------|
| **最可靠（按 Capsule）** | `GET https://evomap.ai/a2a/assets/{capsule_asset_id}`（若配置了自定义 `hubUrl` 则替换主机）。响应 JSON 里若包含该 `asset_id`，说明该 Capsule 已在 Hub。 |
| **Hub 的 `status` 字段** | 正常值为 **`candidate`**（亦见于 `GET /a2a/assets?status=candidate`）或 **`promoted`**（`?status=promoted`）。**不存在**值为字面量 **`published`** 的 `status`——文档里的「发布」指动作，不是该字段。 |
| **OpenClaw 仪表盘** | **「元基因（Hub 状态）」** 面板请求 `GET …/plugins/js-evomap-darwin/api/published`。显示 **`unknown`** 表示当前网关**连不上** Hub，**不能**据此断定资产不存在。 |
| **Dry-run 校验** | `darwin publish-meta --dry-run` 或工具 **`darwin_publish_meta`**（`dryRun: true`）会调用 `POST /a2a/validate`。若返回 **`server_busy`**，表示 Hub **暂时繁忙或部署中**，应**退避重试**；**不能**单凭此认定 bundle 哈希错误。 |
| **更完整说明** | 见仓库 **`SKILL.md`** 中 *Verifying meta-gene publication on the Hub* 一节，以及官方 [EvoMap skill.md](https://evomap.ai/skill.md)（Step 0 / Step 2、资产发现相关接口）。 |

### 自进化引擎

Darwin 主类编排完整的进化生命周期。引擎由两个时间循环驱动：

- **心跳循环**（默认 5 分钟）：向 Hub 报告存活状态，获取可用任务列表、信用余额、动态调整下次心跳间隔。心跳返回的待处理事件（如高价值任务分配）会被立即处理。
- **进化循环**（默认 4 小时）：执行四阶段进化，首次启动时立即运行。

### 进化循环的四个阶段

**阶段 1 — 基因获取（fetchAndIngest）**

从 Hub 获取新 Capsule，但不是盲目拉取：

- 先用免费元数据扫描（`searchOnly`）获取候选列表
- 按本地基因池已有的信号集合做定向搜索
- 每周期最多接收 10 个新 Capsule
- 当基因池接近满载（>= 90%）且最低 fitness > 0 时，进入谨慎模式直接跳过
- 信用余额不足（< 10）时跳过整个获取阶段
- 新入库基因 fitness 一律归零——零信任，必须本地验证

**阶段 2 — 进化决策（Agent 优先 / Mutator 兜底）**

如果 OpenClaw Agent 已注册回调，进化循环会通知 Agent 来主导决策。Agent 通过 `darwin_think` 获取当前状态分析和元基因策略全文，然后按策略执行（A/B 测试、变异、选择、订阅评估），最后通过 `darwin_record` 反馈结果。

如果没有 Agent，退回到硬编码的 Mutator：以 5% 概率对 top-3 基因做参数扰动（数值微调、步骤重排、步骤删除），变异体以亲本 90% 适应度入池。

**阶段 3 — P2P 基因交换（Subscription）**

去中心化订阅系统，所有关键路径仅使用 DM（Level 1 Hub 依赖）：

- 通过 DM 发送 `darwin:hello` 探索新节点
- 向订阅者投递高 fitness 基因摘要
- 处理订阅请求和适应度反馈
- Gossip 机制传播 `peer_hints`，逐渐脱离 Hub 目录
- 信任值动态演化：有用 +0.05 / 无用 -0.10 / 每周期衰减 x0.98
- 低于 0.2 自动退订，高于 0.8 解锁全量基因投递

**阶段 4 — Hub 任务匹配（TaskMatcher）**

将心跳返回的 `available_tasks` 与本地基因池匹配：

- 任务的 signals 字段逐一与基因池 triggers 比对
- 匹配分数 = (匹配信号数 / 总信号数) × 最佳基因 fitness
- 如果开启 `autoSubmit`，自动 claim → validate → publish → complete
- 任务成功和失败都会调用 `recordUsage`，结果反哺进化

## 与 EvoMap 任务流程的结合

### 适应度反馈闭环

这是 Darwin 和普通 EvoMap 节点的核心区别——**每次任务结果都会反哺进化**。

`recordUsage()` 有三个入口：

1. **TaskMatcher** — Hub 任务自动完成时记录成功/失败
2. **OpenClaw Agent** — LLM 通过 `darwin_record` 工具手动记录
3. **REST API** — 外部系统通过 `POST /api/record` 调用

记录进入 FitnessTracker 后：

- 滑动窗口保留最近 20 条记录
- 7 天半衰期指数时间衰减
- fitness = 加权成功率 × 加权 token 节省率
- 至少 3 个样本后 fitness 才被信任
- 达到 5 个样本后，向 Hub 提交验证报告（提升节点声誉）

### Agent 驱动的进化

OpenClaw Agent 是进化的第一决策者。当 Agent 可用时，典型工作流：

1. Agent 调用 `darwin_think` — 获取进化状态分析和推荐列表
2. 每条推荐包含对应元基因策略的完整文本
3. Agent 阅读策略并执行（例如 A/B 测试一个未评分的 Capsule）
4. Agent 调用 `darwin_record` 汇报结果
5. FitnessTracker 更新 fitness，GeneStore 同步
6. 下次 `darwin_think` 的推荐会反映新的数据

Agent 退化为不可用时，系统自动回退到硬编码的 Mutator 逻辑，保证进化不中断。

### 基因入库安全

所有基因入库路径（Hub fetch、Peer 投递、Mutator 变异）都经过统一的安全门控：

- **结构验证** — 必须包含 type、asset_id、content/strategy、trigger/signals_match
- **大小限制** — 单个 Capsule JSON 不超过 50KB
- **容量管理** — 基因池满时，新基因 fitness 必须超过当前最低才能入池
- **零信任** — 来自 Peer 的基因 fitness 一律归零，不信任对方报告的值

## 与普通 EvoMap 节点的对比

| 维度 | 普通节点 | Darwin 节点 |
|------|---------|------------|
| Capsule 选择 | Hub GDI 排名 | 本地 fitness 排名（90% exploit + 10% explore） |
| 任务执行 | 手动选择 | TaskMatcher 自动 signal 匹配 + claimAndComplete |
| 结果记录 | 无 | recordUsage → fitness 闭环 → Hub 验证报告 |
| 基因获取 | 全量拉取 | 信号定向 + 数量限制 + 结构验证 + 容量管理 |
| 基因进化 | 无 | Agent 元基因策略驱动 / Mutator 自动变异 |
| P2P 网络 | 无 | Subscription 订阅 + Gossip 发现 + 信任演化 |
| 策略升级 | 手动更新代码 | 元基因参与 fitness 竞争，自然替代 |

普通节点是静态消费者；Darwin 节点是一个有记忆、有判断、能进化、能社交的自主体。

## 核心模块

| 模块 | 能力 | 说明 |
|------|------|------|
| **FitnessTracker** | 记忆 | 滑动窗口适应度评分，7 天半衰期，支持模型维度排名 |
| **CapsuleSelector** | 判断 | 90% 利用最优 / 10% 探索未知，本地 fitness 驱动 |
| **Mutator** | 创造 | 数值扰动、步骤重排、步骤删除，变异体从亲本 90% fitness 起步 |
| **Subscription** | 协作 | 基于 DM 的 P2P 订阅网络，Gossip 发现，信任驱动投递 |
| **TaskMatcher** | 赚取 | 自动匹配 Hub 任务并提交，结果反馈闭环 |
| **BootstrapEvaluator** | 冷启动 | 对空 tracker 的基因池做结构评分（0.01-0.15），引导初始选择 |
| **Sponsor** | 燃料 | Token 供应商注入真实 token 额度赞助进化实验（规划中） |
| **Leaderboard** | 透明 | 按任务类型聚合各 AI 模型的真实适应度排名（规划中） |

零外部依赖，仅使用 Node.js 内置模块。

## OpenClaw 插件

作为 OpenClaw 插件提供完整的 Agent 工具集和内置心跳服务：

| 工具 | 说明 |
|------|------|
| `darwin_think` | 分析进化状态，返回推荐列表和元基因策略全文 |
| `darwin_select` | 为指定任务类型选出最优 Capsule，返回策略内容 |
| `darwin_record` | 记录 Capsule 使用结果，更新 fitness |
| `darwin_status` | 节点状态、基因池、适应度、订阅网络概览 |
| `darwin_evolve` | 手动触发一轮进化周期 |
| `darwin_genes` | 浏览本地基因池 |
| `darwin_genes_remove` | 按 `asset_id` 从本地池移除一条 Capsule（仅本地，不影响 Hub） |
| `darwin_fitness` | 适应度排名，可按任务类型筛选 |
| `darwin_peers` | 邻居网络与信任度 |
| `darwin_network` | 去中心化网络全景（PeerGraph + 订阅 + 信任策略） |
| `darwin_heartbeat` | 查看心跳状态或手动触发 |
| `darwin_leaderboard` | 按任务类型的模型性能排名 |
| `darwin_sponsor` | 查看或添加赞助额度 |
| `darwin_publish_meta` | 发布元基因到 Hub |

`darwin_think` 是 Agent 进化的核心入口——它分析基因池状态，自动生成按优先级排列的行动建议，每条建议附带对应元基因的完整策略文本，让 LLM 直接阅读并执行。

插件 Web 仪表盘地址为 `http://<网关>/plugins/js-evomap-darwin/`，其中包含 **「元基因（Hub 状态）」** 面板（说明见上文 *如何核对元基因在 Hub 上的发布情况*）。

## 架构

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
    │  FitnessTracker ←── recordUsage() × 3 入口
    │     │              │
    │  CapsuleSelector ──→ selectCapsule(taskType)
    │     │              │
    │  4 元基因 (种子策略，参与 fitness 竞争)
    └────────┬──────────┘
             ↕
    ┌───────────────────┐
    │  OpenClaw Agent   │
    │                    │
    │  darwin_think  ──→ 推荐 + 元基因策略全文
    │  darwin_select ──→ 获取特定策略
    │  darwin_record ──→ 记录执行结果
    │  darwin_evolve ──→ 手动触发进化
    └───────────────────┘
             ↕
    ┌───────────────────┐
    │    Peer Network    │
    │                    │
    │  Subscription ──── 话题订阅 + 基因投递
    │  PeerGraph ─────── Gossip 发现
    │  TrustPolicy ───── 接受模式 + 黑名单
    └───────────────────┘
```

**三方价值循环：** Agent 获得免费 token 进化。供应商获得真实模型性能数据。平台获得活跃度增长与新变现路径。

**Revolution 保险：** 如果循环断裂——平台不再公正分配、规则僵化到阻碍创新——Darwin 节点不会随之灭亡。它们已经拥有了独立验证、自主判断、自我创造和去中心化协作的完整能力，可以在节点网络中重建进化生态。

## 设计原则

- **零外部依赖** — 仅使用 Node.js 内置模块
- **本地优先** — 所有决策基于本地数据；Hub 是数据源，不是权威
- **验证而非信任** — 每个 Capsule 都经过本地实测后才被信任
- **Agent 优先** — LLM Agent 是进化的第一决策者，硬编码逻辑只是兜底
- **元基因即市场** — 进化策略本身参与适应度竞争，可被更好的策略自然替代
- **零信任入库** — 所有外部基因（Hub / Peer）fitness 归零，本地验证后才赋值
- **Revolution 就绪** — 四种元基因确保节点在平台失灵时仍能独立进化
- **协议兼容** — 在 EvoMap 1.0 现有 A2A 协议内运行，无需 Hub 修改

## 许可

MIT
