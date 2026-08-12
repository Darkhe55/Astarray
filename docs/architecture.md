# Astarray 架构文档

> 对应实施批次：T00（架构定稿与契约）。
> 设计来源：`agent-main-architecture.md`、`designtodo.txt`、`IMPLEMENTATION_PLAN.md` §2（冻结决策）。

## 1. 总体结构

单一主 Agent + 三模式（Ponder / Assist / Devolve），按信任梯度排列：

```
Ponder（思索模式，零权限） → Assist（协同模式，受限执行 + 门禁询问） → Devolve（放权模式，完全控制 + 自由调度）
```

- 模式是主 Agent 的一个运行状态，不是独立进程。
- 主 Agent 派发任务后立即回到待机，持续接收用户输入，不陷入任务流程。
- 记忆始终归属主 Agent；子 Agent 只持任务局部工作态，结束后归并。

## 2. 三层 Agent 分工

| 层级 | 职责 | 工具信息 |
|---|---|---|
| 主 Agent | 接收指令、记录任务概要、转交提示词、待机应答、门禁裁决 | 仅工具名 + 一句话摘要（预览） |
| 次级调度 Agent（Assist） | 切割任务成 DAG、分配最小工具集、调度 Worker、处理反馈、无法裁决时转回用户 | harness 内置提示词：全量工具 + 用法 |
| 三级执行 Agent（Worker） | 仅执行分配任务；异常/模糊/完成均走反馈工具上报，然后待机 | 任务所需工具子集 |

Devolve 模式下主 Agent 直接承担调度职责，复用同一 task store、反馈进程、Worker 与工具策略边界。

## 3. 模块与依赖方向

```
TUI/CLI → Application Controller → Domain Core
                            ├────→ Orchestration
                            ├────→ Runtime/Tool Ports → Adapters
                            └────→ Stores/Feedback Process Client
```

强制约束：

- UI 不得直接访问 Provider、工具或文件系统。
- 独立反馈进程不得依赖 React/Ink。
- Agent 只能通过 feedback client 与独立反馈进程交互。
- 领域层不能依赖进程通信协议的具体实现（通过 `FeedbackTransportPort` 接口隔离）。

## 4. 独立反馈进程

- 形态：**独立进程**（`child_process.fork` 或同等跨平台机制），不得退化为进程内定时器或协程（ADR-0001）。
- 主进程负责启动、健康检查、优雅关闭与异常重启；反馈进程崩溃后重放未确认消息。
- 每个接收者（Agent）拥有独立的持久化 mailbox journal。
- 每条消息必须携带结构化原始来源：用户、具体 Agent 个体或系统组件。Agent 来源必须包含不可复用的 `agentInstanceId` 和主/次级/三级角色，仅有角色名无效（ADR-0007）。
- 来源在消息进入反馈系统时确定并保持不可变；转发者不得覆盖原始来源。缺失或非法来源的消息在入池前拒绝并审计。
- 投递语义：普通消息仅在接收 Agent 为 `idle` 时投递；投递成功且收到 ack 后才从未投递集合消费（投递后 ack 前崩溃可幂等重投）。
- 退避：首次忙碌后等待 2 秒，依次 3、5、7、11… 秒（第 n 个质数），单次封顶 10,800 秒（ADR-0002）；新消息入池、接收者变空闲、重连成功时重置到 2 秒。
- 顺序：跨类型按优先级，同优先级严格 FIFO（ADR-0003）：`instruction > backup-deletion-warning > failure > permission-ask > ambiguous > success`。
- 控制通道：显式 cancel 属于控制信号，可通过 `AbortSignal` 中止；普通反馈不得中断 Agent。
- 展示与审计：TUI、headless JSON、诊断日志和审计事件均保留来源，使用户能区分用户裁决、Agent 汇报与系统事件。

## 5. Agent 工作存档与选择性附加

- 每个次级、三级 Agent 个体拥有一个独立文件：`.astarray/missions/<missionId>/agents/<agentInstanceId>/work-archive.json`（ADR-0008）。
- 工作存档保存结构化摘要：任务分配、进度、关键决策、结果、失败、交接信息和产物引用；不默认保存完整模型上下文、原始超长输出或敏感值。
- Agent 只写自己的工作存档；上级 Agent 可读下级存档，但不能改写其历史。文件身份必须与已注册的 Agent 个体一致。
- 上级 Agent 发布新任务或重新调用下级 Agent 前，可选择不附加存档，或选择具体存档条目附加到任务输入。
- 选择结果记录存档所有者、存档 revision、所选条目的完整结构化快照、选择原因与内容哈希；任务创建后使用不可变快照，避免并发更新改变已派发任务含义。
- 重新唤醒尚未回收的同一 Agent 个体可沿用其 `agentInstanceId`；回收后创建的替代 Agent 必须使用新 ID，并由上级显式附加旧个体的存档。
- 默认不自动注入完整存档，以控制 token、避免过期上下文污染。附加内容必须标记为历史上下文，不能覆盖当前用户指令、任务约束和权限策略。
- 默认仅在同一 mission 内复用；跨 mission 复用需按长期记忆权限规则处理。

## 6. 权限模型

- 工具类别：`readonly`（直接 allow）、`restricted`（ask 用户）、`forbidden`（deny）。
- Assist 会话授权默认 10 分钟或会话结束（先到者为准，ADR-0006）；参数变更后必须二次鉴权。
- 权限在工具**实际执行前**检查（策略包装层），不只派发时检查。
- Devolve 免应用层逐次询问，但仍受工具注册表、工作区边界与操作系统权限约束。
- 模式降级：已开始的原子调用可正常结束；所有后续调用按新模式重新鉴权。

## 7. 任务链持久化

- 位置：`.astarray/missions/<missionId>/task-chain.json`（ADR-0004）。
- 格式：版本化 JSON，含 `schema_version` 与单调递增 `revision`；临时文件 + flush + 同目录原子替换 + 备份恢复。
- 损坏文件进入 recovery 流程，不得静默覆盖。
- 任务链文件是任务状态的唯一事实源（可恢复、可审计、主 Agent 问答进度时读取）。

## 8. 记忆、缓存与指标

- 主 Agent 只保存任务概要与归并摘要；Worker 工作态在任务结束后释放；Ponder 不落盘。
- 长期记忆写入遵循 Assist 权限门禁。
- 缓存：仅缓存确定性且无副作用的调用（ADR-0005）；v0.1 不实现语义缓存；缓存键包含 Provider、模型、模式、输入、系统提示词哈希、工具子集哈希、上下文摘要哈希和相关文件指纹。
- 指标：调用数、token、缓存状态（hit/miss/bypass/stale_reject）、峰值并发、消息延迟；估算 token 标记 `estimated`。

## 9. 恢复与安全

- 崩溃恢复覆盖：task chain 更新中断、投递后 ack 前崩溃、反馈进程崩溃/孤儿、journal 损坏。
- 非幂等副作用无法确认成功时进入 `blocked`，不得盲目重试。
- 安全边界：路径穿越、符号链接逃逸、ANSI/OSC 注入清洗、secret 脱敏、无限 tool loop 防护。

### 9.1 工具内破坏性变更备份

- 删除资源、删除部分文字/字段、替换、截断和任何覆盖属于破坏性变更（ADR-0009）。
- 自动创建备份由具体执行工具内部完成，不作为一次模型规划步骤，也不自动把备份内容注入模型提示词、工具输出或反馈消息。
- 工具先把目标完整 pre-image 写入内容寻址、追加写的受保护备份库并持久化清单；成功后才能修改目标。
- 备份后、变更前必须重新校验目标指纹，防止 TOCTOU。指纹变化时中止并重新开始，不得用已过期备份继续覆盖。
- 备份库位于工作区状态目录的受保护分区，例如 `.astarray/backups/objects/` 与 `.astarray/backups/manifests/`；普通文件工具无直接权限。
- 恢复当前版本前也先备份当前目标，使恢复操作本身可撤销。
- `backupVault` 受控工具提供列出、读取和恢复；底层对象路径与恢复密钥不暴露。恢复属于覆盖，恢复前先备份当前目标。
- `deleteBackup` 是独立特权工具与自动 pre-image 规则的唯一递归例外。协同模式逐次警告用户并暂停发起 Agent，用户精确授权后继续；放权模式不提示但写入不可删除的高查阅优先级审计日志；思索模式禁止。
- 删除采用短锁两阶段隔离：锁内验证 revision 与引用关系并移入 quarantine，释放锁后清理。授权等待期间不持有锁；处于 `awaiting-user-authorization` 的 Agent 通过专用控制通道接收匹配请求 ID 的决定，避免死锁。

## 10. 命名与编码规范

见 `IMPLEMENTATION_PLAN.md` §3 与 `AGENTS.md`：含义完整命名、布尔前缀、时间量带单位、核心领域代码禁止 `any`。

## 11. 契约落点

核心类型与 schema：`packages/core/src/core/types.ts`、`packages/core/src/core/events.ts`、`packages/core/src/core/schemas.ts`、`packages/core/src/core/errors.ts`。
冻结决策守卫测试：`tests/core/unit/frozen-decisions.test.ts`。
