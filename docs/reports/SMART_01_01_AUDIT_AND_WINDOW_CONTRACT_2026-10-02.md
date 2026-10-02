# SMART-01-01 审计与指令窗口契约草案（2026-10-02）

> 任务卡：`docs/tasks/SMART01_INSTRUCTION_WINDOW_AND_MAIN_RESPONSIVENESS_TASK_CARD.md`
> 检查点产出：**现有 GUIDE/完成/恢复链路审计 + ADR + 指令状态与窗口契约**。
> 验收要求：**明确计数/关闭/部分处理/期限语义，与 task done 区别清楚；不新建任务调度器**。
> 本文件是审计与契约冻结，**不构成功能已启用**；本轮不改生产默认行为。

## 1. 基线

| 项 | 值 |
| --- | --- |
| commit | `a0d7606`（SMART-01-01 开始） |
| 平台 | Windows（本机）；Linux/macOS 未验证 |
| 真实额度 | 0 |

## 2. 现有链路审计（复用面）

### 2.1 运行中指导（GUIDE-01）

| 件 | 位置 | 现状 |
| --- | --- | --- |
| 控制队列 | `runtime-guidance/guidance-control-queue.ts` | 支持 `queued / applied / dropped / superseded` **四态**；`consumeAtSafePoint` 在安全点应用，过期/跨作用域**丢弃并给原因**；记录"提交→应用"延迟 |
| 安全点 | `GuidanceSafePointKind`（`before-tool-execution` 等） | Worker 在执行前消费（`mission-orchestrator.ts:738-746`）；`long-tool-checkpoint.ts` 亦复用 |
| 唤醒策略 | `evaluateWakePolicy` | 控制道**可应用到运行中 mission**；报告道**只排队**、`wakesMainAgent: false`（永不唤醒主 Agent） |
| 提交日志 | `guidance-submission-journal.ts` / `guidance-change-intent-journal.ts` | 有 journal（重启可读） |
| 变更意图 | `guidance-change-intent.ts` | 有 `GuidanceChangeIntentState` 与历史 |

**关键结论**：GUIDE 已提供"逐条指导的**四态**与去重/过期/跨作用域规则"，
可作为"指令状态机"的**结构基础**——但它描述的是**指导事件**，不是"用户指令窗口内的条目"。

### 2.2 完成链路（task 级）

| 件 | 位置 | 现状 |
| --- | --- | --- |
| 任务完成协议 | `core/completion-protocol.ts` | `ASTARRAY_TASK_COMPLETION_V1`（+ `ASTARRAY_TASK_BLOCKED_V1`）；**任务级** |
| 完成门禁 | `orchestration/completion-verifier.ts` + `worker-agent.ts` | 8 条本地条件；产物对账；必需操作必须真的执行过 |
| 次级面向用户摘要 | `SECONDARY_USER_FACING_SUMMARY_V1`（`agent-routing-schemas.ts:80`） | **汇报级**，不是"指令处理回执" |
| 任务链状态 | `task-chain`（pending/ready/running/done/failed/blocked） | **任务维度**，无"指令"维度 |

**关键结论**：当前**不存在**"指令处理回执"（卡内 §3 要求：指令 ID/revision、处理结果、
关联任务/证据引用、未决问题）。也**不存在**指令数与窗口容量概念。

### 2.3 恢复链路

| 件 | 位置 | 现状 |
| --- | --- | --- |
| 检查点与分类 | `recovery-checkpoint-schemas.ts` / `recovery-classification-service.ts` | 任务/工具/Provider/反馈维度；**无指令维度** |
| 指导 journal | `guidance-submission-journal.ts` | 提交可恢复（重启可读） |
| 引导安全点端口 | `mission-orchestrator.ts:738` | 每个任务构造独立端口，绑定 mission/task |

**关键结论**：恢复面覆盖"任务与工具"，**不覆盖"指令窗口"**（窗口容量、部分处理、补位）——
这正是 SMART-01 要新增的维度。

## 3. 差距清单（卡内要求 vs 现状）

| 卡内要求 | 现状 | 差距 |
| --- | --- | --- |
| 默认同时处理三个指令 | 无窗口/计数概念 | **缺**（需新增窗口状态，不改调度器） |
| 完成一条后自动补位 | 无"处理中条目"概念 | **缺** |
| 指令处理回执（schema 首检查点冻结） | 无 | **缺**（需版本化 schema） |
| 区分"早停"与"需要用户澄清" | 有 `ASTARRAY_TASK_BLOCKED_V1` 与模糊上报，但**无指令级**区分 | **部分** |
| 缺失完成信号兜底、共享任务预算、重启不重置 | 任务级预算与 watchdog 已有；**指令级无** | **部分** |
| 主 Agent 单条指令 3 分钟内处理并派发、不阻塞 | 提交后立即返回（`submitTask` 非阻塞）；**无期限监督与如实超时** | **缺** |
| 等待澄清时参考后续指令 | 无 | **缺** |
| 与 task done 区别清楚 | 目前"指令=任务"，二者**混同** | **缺（核心语义）** |

## 4. 契约草案（供 ADR 冻结）

### 4.1 两个维度必须分离

```
指令（instruction）   用户一次输入或一条指导；窗口内的条目单位
  instructionId / revision / 内容摘要 / 提交时间 / 期限 / 状态
任务（task）          调度与执行单位；沿用现有 task-chain 状态机
  taskIdentifier / missionIdentifier / 现有 pending→done 语义
关联                  instruction 1..n → task 1..n（回执携带引用）
```

**禁止**：把"指令已受理"当作"任务完成"；也**禁止**把"任务 done"直接当成"指令关闭"。

### 4.2 指令状态机（冻结）

| 状态 | 含义 | 允许的转移 |
| --- | --- | --- |
| `accepted` | 已受理并计入窗口 | → `dispatched` / `awaiting-clarification` / `rejected` |
| `dispatched` | 已派发关联任务 | → `completed` / `partially-completed` / `awaiting-clarification` / `failed` |
| `awaiting-clarification` | 需要用户补充（**不得虚报已派发**） | → `dispatched`（收到答案后）/ `cancelled` |
| `partially-completed` | 部分达成，剩余部分仍在窗口内推进 | → `completed` / `failed` |
| `completed` | 回执经本地校验通过（**≠ 任务 done**；需任务关联与证据引用） | 终态 |
| `failed` / `cancelled` / `rejected` | 终态（含原因） | — |

### 4.3 计数与窗口

- 窗口容量默认 **3**（可配置）；`accepted` + `dispatched` + `awaiting-clarification` 计入占用。
- 上限为 3 时，**第 4 条必须排队**（不得静默丢弃、不得越过依赖抢占）。
- 一条进入终态即**释放槽位并自动补位**（从排队区按显式前驱 + 稳定顺序选取）。
- 排队条目不消耗模型调用；等待澄清**不长期占用主 Agent 处理时间**（见 §4.5）。

### 4.4 回执（schema 在实现检查点冻结）

字段至少包含：`instructionId` / `instructionRevision` / 处理结果（与 §4.2 状态对应）/
关联 `taskIdentifier` 与证据引用 / 未决问题 / 生成时间 / 来源 `agentInstanceId`。
**回执是候选**：本地必须核对当前 revision、未决调用与任务关联后才释放槽位。

### 4.5 期限与"不阻塞"

- 主 Agent 对**单条**用户指令须在 **180 秒**内完成"派发或如实阻塞/待澄清"；
  超时须显式报告（不得静默、不得虚报已派发）。
- 歧义/权限缺失/需用户选择时：**期限内**提出具体问题并**释放主 Agent 占用**。
- 期限监督共享任务级预算；**重启不重置**（沿用既有预算持久化规则）。

### 4.6 与既有机制的关系

| 既有机制 | 关系 |
| --- | --- |
| `guidance-control-queue` 四态 | 指令窗口**复用**其"逐条状态 + 丢弃原因 + 延迟度量"结构；不新建第二套队列 |
| `ASTARRAY_TASK_COMPLETION_V1` | 仍是**任务级**完成依据；指令 `completed` 需**额外**回执校验 |
| 恢复分类服务 | 指令窗口需**新增**持久化（窗口占用/排队/部分处理），重启不得重置计数 |
| 主 Agent 只读角色 | 不变：模型不写权限、不自行关闭指令 |
| 任务调度器 | **不新建**；窗口只做准入、计数与补位，不接管偏序调度 |

## 5. 未实现声明与后续检查点

- 本检查点**只**产出审计与契约；**未**实现窗口、回执或期限监督。
- SMART-01-02：持久队列、原子准入/回执/补位、模式与窗口设置（反例：上限 3 时第 4 条排队、
  重复/乱序回执、降上限、同键异参、并发连发、重启无重复投递）。
- SMART-01-03：早停分类、漏回执兜底、澄清参考。
- SMART-01-04：期限监督、持续接收、四入口与包验收。
- **未验证**：Linux/macOS；"180 秒内派发"需在实现后用**虚拟时钟**验证（禁用过窄真实计时窗口）。
