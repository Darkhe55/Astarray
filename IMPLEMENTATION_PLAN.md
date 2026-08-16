# Astarray TUI 实施流程

> 状态：v0.1 实施基线  
> 架构来源：`agent-main-architecture.md`、`designtodo.txt`  
> 目标：由 OpenCode 从空工程持续实现为可通过 npm 安装的 TUI Agent 编排工具。

---

## 1. 最终交付目标

- npm 包名暂定为 `astarray`，可执行命令为 `astarray`。
- 使用 TypeScript、ESM、React 和 Ink 构建 TUI。
- 最低支持 Node.js 20。
- 支持 Windows、macOS、Linux。
- 支持 `Ponder（思索模式）`、`Assist（协同模式）`、`Devolve（放权模式）` 三种内置模式，以及不设产品数量上限的用户命名自定义权限模式。
- 支持主 Agent、次级调度 Agent、三级执行 Agent。
- 主 Agent 将任务转交本地会话控制器后立即恢复接收用户输入。
- 反馈工具作为独立进程运行，通过持久化信箱与 Agent 解耦通信。
- 支持任务 DAG、最小工具授权、权限门禁、崩溃恢复、指标与安全审计。
- 完成 `npm pack`、tarball 隔离安装和 CLI/TUI 冒烟测试。
- 自动任务不得执行 `npm publish`、`git push` 或工作区外写入。

建议技术栈：

- UI：`ink`、`react`
- 参数解析：`commander` 或同类成熟库
- 数据校验：`zod`
- 构建：`tsup`
- 测试：`vitest`、`fast-check`
- TUI 端到端：`node-pty`
- 日志：结构化 JSON 日志，自定义敏感信息脱敏层

---

## 2. 已冻结的架构决策

后续实现不得静默修改这些决策。如必须变更，先增加 ADR，并更新本文和测试。

| 事项 | v0.1 决策 |
|---|---|
| 三级 Agent 连续失败阈值 | 默认 3 次，可按任务类型配置；任意一次成功后对应工具的连续失败计数清零 |
| 反馈退避 | 使用质数秒序列 `2, 3, 5, 7, 11...`；单次等待上限为 **3 小时（10,800 秒）** |
| 新消息处理 | 新消息进入任一信息池后，立即把该接收者的退避轮次重置到首轮 2 秒 |
| 反馈工具形态 | **独立进程**，不得与主 Agent 或调度 Agent 运行在同一事件循环中 |
| 信息池持久化 | 独立反馈进程持有持久化 mailbox journal；投递成功并收到确认后才消费消息 |
| 信息来源 | 每条反馈必须携带结构化原始来源（用户、具体 Agent 个体或系统组件）；Agent 来源必须具体到不可复用的 `agentInstanceId` |
| Agent 个体记忆隔离 | 主、次级、三级每个具体 Agent 以不可复用 `agentInstanceId` 独占记忆、工作存档、上下文、缓存、读取回执和消息视图；禁止角色级或同级共享；跨 Agent 只经本地控制器生成当前任务有效的不可变附件 |
| Agent 待办任务序列 | 每个调度 Agent 在自己的记忆存档域维护独立的带优先级偏序集；发布者可指定前驱/后继插入位置；用户任务默认层级 0，Agent/工具任务只能层级 1 或以下 |
| Git 分流与集成 | 涉及仓库写入的多 Agent 任务由次级 Agent 统一创建隔离分支/worktree、审查三级 Agent 提交、运行门禁并执行受控合并；三级 Agent 不得自行合并、变基、推送或删除分支 |
| 破坏性变更备份 | 删除资源、删除内容、替换、截断和覆盖必须由执行工具自身先自动备份；自动创建过程不经过模型，后续读取/恢复只经受控工具 |
| 备份工具 | `backupVault` 提供 list/read/restore；`deleteBackup` 是独立特权入口和 pre-image 规则的唯一递归例外 |
| 删除备份模式策略 | 思索模式禁止；协同模式警告用户并强制暂停 Agent，逐次授权；放权模式无提示但写 HIGH 查阅优先级审计日志 |
| 任务链格式 | 版本化 JSON，位于 `.astarray/missions/<missionId>/task-chain.json` |
| 消息顺序 | 跨类型按优先级，同优先级严格 FIFO：`instruction > backup-deletion-warning > failure > permission-ask > ambiguous > success` |
| 越权工具 | harness 硬拒绝、记录审计事件，并向调度 Agent 上报 failure |
| Assist 会话授权 | 默认 10 分钟或会话结束，以先到者为准 |
| Assist 安装门禁 | 先询问用户是否已有代码库/依赖等可用资源；用户确认没有后，默认关闭的独立开关仅允许提出申请，每次实际安装仍须精确绑定的 `allow-once` 用户授权 |
| 权限组与自定义模式 | 可配置权限逐项使用 `deny/ask/allow`；Devolve 默认全部 allow，Assist 使用独立默认矩阵，Ponder 不可调整；用户可创建、命名和完整配置不设产品数量上限的自定义权限组 |
| 权限作用域与临时提升 | 主 Agent 在所有模式下永久只读；profile 和会话临时提升只作用于次级 Agent（默认覆盖会话内全部次级 Agent，可选限定具体个体），并构成其向三级 Agent 分发权限的上限；关闭会话可导出公开有效权限配置 |
| 默认三层控制流 | 主 Agent 持续交流、评估并经本地控制面插入次级偏序集，后台报告只入索引；次级持续调度、管理三级生命周期及本地/远端项目集成；三级一次激活只执行一条任务链 |
| 工具说明回访 | 每个次级/三级 Agent 首次接收工具组时获得完整公开用法；同 revision 后续只发送标准请求提醒，忘记用法直接按单工具回复，缺失能力按默认上级逐级反馈 |
| Agent 数量与通信转交 | 各层实例无累计/同级产品数量上限；资源压力通过并发调度处理。直属上级经授权可把直属低一级 Agent 的限定沟通句柄交给具体同级 Agent，但不转移任务、记忆、工具或权限 |
| 默认并发量 | 4；不设置产品硬上限，按 Provider、内存、磁盘和 OS 资源动态排队、暂停或回收 |
| Devolve 权限 | 免应用层逐次询问，但仍受工具注册表、工作区边界和操作系统权限约束 |
| Ponder 持久化 | 不写任务、记忆或遥测文件；仅使用会话内存 |
| Ponder 工具边界 | 只允许本地只读白名单查看普通项目文件、检索文本、查询只读任务状态、固定 Git 只读视图及受控事实搜索；写入、进程、通用网络、凭据及备份工具由本地硬禁用 |
| 敏感操作判断 | 由本地版本化元数据、确定性参数/真实路径检查和 OS 沙箱执行；云端或 AI 分类不具有授权效力，未知操作 fail-closed |
| 任务完成协议 | 模型必须返回 `ASTARRAY_TASK_COMPLETION_V1` 控制事件；本地验收通过后才能结案，缺失或无效时从检查点最多自动续跑 3 次 |
| 全模式敏感禁读 | `.env`/`.env.*`、私钥、凭据库、能力令牌和本地 DLP 命中内容不得进入任何模式下的模型、普通工具、证据包、缓存、反馈或存档；无例外授权入口 |
| 高严谨性事实验证 | 本地规则强制调用 `factVerification`；证据权重为“资料搜索 > 本地实验 > 纯推理”，证据只辅助用户判断，不自动给出最终合格结论 |
| 反自指与活锁 | 同一 Agent/任务读取未变化且已覆盖资源默认 30 秒内抑制；工具环、资源环、Agent 回派环和连续 3 次无进展由本地守卫暂停 |
| 模式降级 | 已开始的原子调用可正常结束；所有后续调用按新模式重新鉴权 |
| 用户终止 | 普通反馈不得中断 Agent；显式 cancel 属于控制信号，可通过 `AbortSignal` 中止 |
| 缓存 | 仅缓存确定性且无副作用的调用；v0.1 不实现语义缓存 |
| 命名 | 所有生产代码使用含义完整、可读性好的变量名，禁止无语义缩写 |

### 2.1 一致性解释

1. FIFO 与消息优先级采用“优先级队列 + 优先级内 FIFO”，不使用全局 FIFO。
2. 安全降级后，后台任务可以保留，但其后续工具调用必须重新鉴权。
3. 放权模式（Devolve）下次级 Agent 的权限项默认全部允许，但不等于绕过操作系统权限、工作区边界或未注册工具限制；主 Agent 的只读工具投影不变。
4. 本文统一中文名称：Ponder 为“思索模式”，Assist 为“协同模式”，Devolve 为“放权模式”。
5. 自定义模式使用用户名称和不可变 profile ID，不增加或改变三个内置模式的固定名称。

### 2.2 反馈退避的精确定义

反馈独立进程为每个接收者维护退避状态：

```text
等待秒数 = min(第 n 个质数, 10800)
```

- 第一次检测到接收者忙碌后等待 2 秒。
- 后续持续忙碌时依次等待 3、5、7、11 秒，直至单次等待达到 10,800 秒上限。
- 达到上限后，后续每轮最多等待 10,800 秒。
- 新消息入池、接收者变为空闲、反馈进程重连成功时，应重置到 2 秒。
- 测试必须使用虚拟时钟，禁止实际等待数小时。
- 3 小时是单次休眠上限，不是消息过期时间；消息不得因等待过久而丢弃。

### 2.3 反馈信息来源的精确定义

每条反馈消息必须包含不可缺失的 `source`：

```ts
type FeedbackMessageSource =
  | { sourceType: "user"; sourceIdentifier: string }
  | {
      sourceType: "agent";
      agentInstanceId: string;
      agentRole: "main" | "secondary" | "tertiary";
    }
  | {
      sourceType: "system";
      sourceIdentifier: string;
      componentName: string;
    };
```

- 用户提交或裁决产生的消息来源为 `user`。
- Agent 自主生成的成功、失败、模糊或调整消息来源为具体 `agent`；必须带该 Agent 个体在当前生命周期内全局唯一且不可复用的 `agentInstanceId`，只写角色或 Agent 类型无效。
- 看门狗、恢复器、反馈进程等基础设施事件来源为 `system`。
- 来源在消息首次进入反馈系统时确定，之后不可修改。
- Agent 转发用户消息时保留用户来源，不能把来源改成自己。
- 来源标识不得包含 API key、邮箱等不必要的敏感信息；本地用户可使用会话内稳定标识。
- 反馈进程在 enqueue 前进行 schema 和身份一致性校验，缺失、空值、角色不合法或伪造来源的消息应拒绝并审计。
- TUI、headless JSON、日志、journal 和审计记录必须保留并显示来源。

### 2.4 每个 Agent 个体的记忆与工作存档

每个主、次级和三级 Agent 个体均以完整且不可复用的 `agentInstanceId` 为唯一所有者，使用独立的个人记忆域与 mission 工作存档：

```text
.astarray/agent-memory/<agentInstanceId>/memory-archive.json
.astarray/missions/<missionId>/agents/<agentInstanceId>/work-archive.json
```

存档至少包含：

- schema 版本、mission ID、具体 Agent 个体 ID、Agent 层级、revision、更新时间。
- 任务分配、进度检查点、关键决策、结果、失败和交接摘要。
- 产物引用，不直接复制可由路径或内容哈希定位的大文件。

读写与附加规则：

- Agent 只能挂载、读取和写入自己的个体记忆域；上级、下级和同级都不能直接打开、搜索、修改或合并其他 `agentInstanceId` 的记忆文件。
- 禁止按照角色、层级、同级组、显示名、任务 ID 或可复用计数器建立共享记忆、缓存、读取回执、消息视图或上下文文件。
- 上级 Agent 在发布新任务或重新调用下级 Agent 前，只能请求本地 `CrossAgentContextAttachmentController` 选择性地生成附件，也可以明确不附加；Agent 模型不直接读取源存档。
- 附加单位是具体条目，不是整个文件；附加请求必须记录存档所有者 `agentInstanceId`、存档 revision、所选条目的完整结构化快照、选择原因和内容哈希。
- 任务派发时生成所选内容的不可变快照。后续存档更新不能悄悄改变已派发任务的上下文。
- 重新唤醒未回收的同一 Agent 个体可以沿用原 `agentInstanceId`；原个体已回收时，新建 Agent 必须使用新 ID，通过显式附件使用旧个体存档，禁止复用旧 ID。
- 默认不附加，只有内容与新任务相关、未明显过期且 token 成本合理时才选择。附件放入独立 `externalHistoricalContext` 分区，只对当前任务激活有效，不自动进入接收方长期记忆。
- 附加内容使用“历史工作上下文”边界包裹，优先级低于当前用户指令、当前任务约束和权限策略。
- 默认只允许同一 mission 内附加；跨 mission 使用需按长期记忆读取规则和权限门禁处理。
- 存档不得包含 secret、完整原始长输出或未经清洗的终端控制字符。
- 接收方若需保留附件结论，只能在自己的存档中写入带原始来源、附件 revision 和内容哈希的观察记录；不得复制成无来源的自身记忆。

#### 2.4.1 默认控制流、报告入档与三级生命周期

- 主 Agent 与用户持续交流和评估，生成 `TaskInsertionProposal`。本地 `ConversationTaskInsertionController` 验证来源、目标次级 Agent、目标序列、前驱/后继和 expected revision 后插入偏序集；这不是主 Agent 的写工具。
- 用户原始指导保持 `priorityTier: 0`；主 Agent 派生的设计、拆解和补充是 Agent 来源，只能使用层级 1 或以下。提案提交后主 Agent 立即继续对话，不等待后台确认。
- 次级 Agent 独占调度循环。ready set、任务状态、反馈、权限、资源或 Git 基线变化后持续重新计算和派发，直到无 ready 节点、等待用户、达到并发上限、暂停或关闭。
- 每次派发由 `TertiaryAgentAssignmentPlanner` 决定复用空闲个体或创建新 `agentInstanceId`。复用要求同一所属次级、任务/mission 连续、权限/工具/worktree 兼容、无未决副作用或控制消息且上下文/消息预算未超限。
- 三级 Agent 一次激活只绑定一个不可变 `TaskBundle` 和一条任务链。它只向任务发放源报告终态或中断原因，不能领取链外任务、调度其他 Agent、修改偏序集、操作集成/目标分支或执行远端项目控制。
- 次级 Agent 负责 Git 分流、审查、合并，并在当前权限允许时负责 GitHub/远端仓库、PR、CI、发布和产物传输。职责归属不替代执行前权限检查、用户裁决或自动备份。
- 次级 Agent 的任务包终态汇报由 `MainAgentReportArchiveIngestor` 写入独立报告索引，不唤醒主 Agent 模型、不注入当前对话、不自动写入主 Agent 记忆。主 Agent 后续仅经只读 `MainAgentReportReader` 选择所需报告。
- 次级 Agent 可在三级任务成功、确认终止、上下文/消息预算超限、权限撤销、健康异常或会话收敛时调用 `TertiaryAgentLifecycleController` 收口关闭。流程必须保存检查点/handoff、确认终态报告、撤销权限、注销 mailbox、处理 Git 资源后才终止后台运行。
- 接手必须使用新身份和空白个人记忆，只附加显式选择的旧个体 handoff 条目。必要时可创建一个只执行“记忆整理/交接包生成”任务链的三级 Agent；不得挂载旧记忆目录或复制完整消息历史。

#### 2.4.2 工具说明回访、数量语义与通信句柄转交

- `ToolDocumentationReceiptStore` 按 `agentInstanceId + toolGroupIdentifier + toolGroupRevision` 保存说明送达回执。首次分配发送该组全部已分配工具的公开 ID、用途、输入/输出 schema、示例、错误、幂等性、副作用和所需权限；相同 revision 后续只发送固定 `ASTARRAY_TOOL_HELP_REQUEST_V1` 提醒。
- 标准请求包含 `controlEventType`、`requestIdentifier`、`taskExecutionIdentifier`、`requestKind: usage-help | missing-capability`、可选 `toolIdentifier`、`capabilityIntent`、`blockingReason` 和 `knownToolGroupRevision`。请求者身份、层级、直属上级、mission 与实际 revision 由 harness 注入。
- 当前已分配工具直接返回单工具 `ASTARRAY_TOOL_HELP_RESPONSE_V1`。注册表已知但未分配/权限不足时返回 `known-but-not-usable` 并上报；没有匹配工具时生成 `ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1`。三级默认上报所属次级；次级上报会话控制面/主 Agent 报告索引。重复 request ID 幂等返回，不能触发重复上报。
- 工具说明回执不构成授权；帮助响应不能增加工具子集、权限、任务范围或安装能力。工具组 revision 变化发送可信差异，差异完整性不确定时重发完整组说明。
- Agent 实例、同级个体和历史存档不设产品数量配额。单会话保留一个当前用户沟通主 Agent；并发资源不足时实例排队、暂停或回收，不按累计创建数拒绝。
- `AgentCommunicationDelegationController` 在 `agent.communication-delegate` 权限与用户裁决通过后创建 `DelegatedAgentCommunicationGrant`。grantor 与 recipient 必须同级，target 必须是 grantor 直属且恰低一级的存活 Agent。
- grant 只向模型暴露不透明 `communicationHandleIdentifier`，绑定三个具体 Agent、mission/任务、允许消息类型、instruction 标志、回复/抄送路由、到期、最大在途消息、revision 和撤销条件。真实 IPC 地址、socket、mailbox 路径与能力令牌不可见。
- grant 默认只允许独立反馈进程通信，不转移归属、任务、偏序集、Git、记忆、工具分配或权限，不可再转授，也不改变三级默认工具帮助/权限/生命周期上报对象。投递前复检；Agent 回收、关系/任务/profile revision 变化、到期或撤销立即失效。

### 2.5 Agent 待办任务偏序集与优先调度

Agent 待办任务序列与项目 DAG 是两个独立事实域：

| 事实域 | 解决的问题 | 存储位置 |
|---|---|---|
| 项目任务链 | 某个项目如何交付、节点依赖、项目状态与产出引用 | `.astarray/missions/<missionId>/task-chain.json` |
| Agent 待办任务序列 | 某个 Agent 还需处理哪些任务、由谁发布、插入位置、优先级、分配和阻塞情况 | `.astarray/agent-memory/<agentInstanceId>/task-sequences/<taskSequenceId>.json` |

不得把 Agent 待办序列写回项目任务文档，也不得把项目产出复制进 Agent 序列。两者只能通过不可变外部引用显式关联。

建议契约：

```ts
type TaskSequenceStatus =
  | "pending"
  | "ready"
  | "assigned"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

interface AgentPendingTaskNode {
  taskIdentifier: string;
  publisherSource: FeedbackMessageSource;
  priorityTier: number;
  directPredecessorTaskIdentifiers: string[];
  directSuccessorTaskIdentifiers: string[];
  publisherOrderKey: string | null;
  creationSequenceNumber: number;
  taskSummary: string;
  status: TaskSequenceStatus;
  assignedAgentInstanceId: string | null;
  taskBundleIdentifier: string | null;
  blockingReason: string | null;
  priorityDependencyReason: string | null;
  externalTaskReference: {
    referenceType: string;
    referenceIdentifier: string;
    referencedRevision: number;
  } | null;
  createdAtIso: string;
  updatedAtIso: string;
}

interface InsertPendingTaskRequest {
  taskSequenceIdentifier: string;
  taskIdentifier: string;
  taskSummary: string;
  requestedPriorityTier: number | null;
  insertAfterTaskIdentifiers: string[];
  insertBeforeTaskIdentifiers: string[];
  publisherOrderKey: string | null;
  externalTaskReference: AgentPendingTaskNode["externalTaskReference"];
}
```

偏序与插入规则：

- 任务序列使用有向无环图保存偏序关系。添加任务时，发布者可以指定直接前驱、直接后继或二者；执行层增加 `前驱 → 新任务 → 后继` 边并验证无环。
- 指定的前驱/后继必须存在且对发布者可见；不能用未知节点探测其他发布者的任务。
- 发布者不指定插入位置时，新节点与现有节点保持不可比，不自动尾接。
- 插入不能暗中删除现有偏序边。若发布者要求“插入到现有边中间”，必须显式声明要替换的边，且该边属于其可变更范围；删边/改序在执行前自动备份旧序列。
- 每次变更使用 expected revision、原子提交和运行时 schema 校验。成环、陈旧 revision、重复 ID、非法状态迁移和越权改序均 fail closed。

优先级规则：

- `priorityTier` 从 0 开始，数值越小优先级越高。
- 认证来源为用户的任务默认层级 0；用户可明确请求层级 1 或以下。
- 来源为 Agent、system 或工具的任务只能是层级 1 或以下。即使任务由用户任务派生，也不能继承层级 0；只有保留并认证原始用户发布意图的转发才仍视为用户发布。
- 次级 Agent 分割用户任务时，原用户任务保留为层级 0 的根/聚合节点；Agent 生成的子任务使用层级 1 或以下并作为其必要前驱。调度器可因高优先根任务而先行执行这些前驱，但子任务自身来源和层级不变。
- 调度先计算所有前驱均为 `done` 的 ready set，再按 `priorityTier`、`publisherOrderKey`、`creationSequenceNumber` 稳定选择。
- 只要 ready set 中存在层级 0 节点，新的执行槽不得分配给层级 1 或以下节点。
- 层级 0 节点若依赖尚未完成的低层前驱，可以优先执行该必要前驱，并保存可解释的 `priorityDependencyReason`。
- 新到的高优先任务不强行中断正在执行的原子工具调用；在任务节点或任务包节点边界重新调度。显式 cancel 仍使用控制通道。

任务包规则：

- 次级 Agent 可以选取偏序集中的一条真实链，创建不可变 `TaskBundle` 并一次派给具体三级 Agent。
- 默认只打包相同 `priorityTier`、相同权限边界、工具集合兼容且适合由同一 Agent 连续完成的节点；混合优先层任务包必须拒绝。
- 任务包记录源序列 revision、节点顺序、每个节点状态和具体执行 `agentInstanceId`。
- 三级 Agent 严格逐节点完成。某节点失败、阻塞或取消时，所有尚未满足前驱的包内后继保持 pending。
- 新层级 0 任务到达时不打断当前原子节点；节点结束后，次级 Agent 可暂停尚未开始的包内后继并重新调度。

发布与查询能力：

- `taskSequenceManage` 是受控写工具，提供 `create-sequence / insert-task / create-bundle / cancel-task / reprioritize-user-task`。调用方身份由 harness 注入，不接受模型提供的来源字段。
- `taskSequenceStatus` 是控制面只读工具，提供 `list-sequences / list-tasks / get-task / get-ready / explain-order / get-bundle`，返回同一 revision 的一致快照。用户可在任意模式从 TUI/CLI 调用；Ponder 模型可在认证可见范围和本地只读白名单内调用，不能管理序列。
- 用户可查看自己发布任务及其派生链；Agent 可查看自己发布、被分配或明确授权观察的任务；工具发布方经内部能力接口查询。
- 查询显示来源、优先级、前驱/后继、阻塞原因、当前/分配 Agent、任务包和更新时间，不返回项目产出内容。
- TUI/控制层可在任何模式展示只读快照，不打断 Agent。思索模式下模型只能调用本地只读白名单且不能写持久化；用户若要新增/修改序列，应切换到协同或放权模式。
- 插入、改序、取消、历史压缩和清理属于可能覆盖/删除既有调度信息的变更，必须由存储工具自动备份，模型不参与备份。

### 2.6 次级 Agent 的 Git 分流、审查与合并

涉及 Git 写入的多 Agent 任务必须指定一个具体次级 Agent 个体作为 Git 集成者。其职责不转移给主 Agent，也不得下放给三级 Agent。

Git 拓扑：

```text
targetBranch @ targetBaseCommit
  └─ integration/<mission>/<secondary-agent>       # 次级 Agent 独占写入
       ├─ worker/<task>/<tertiary-agent-a>          # 三级 Agent A 独立 worktree
       ├─ worker/<task>/<tertiary-agent-b>          # 三级 Agent B 独立 worktree
       └─ conflict/<task>/<new-agent-instance>      # 必要时重新派发
```

分流规则：

- 次级 Agent 派发前记录目标分支、固定 `targetBaseCommit`、集成分支和任务允许修改路径。
- 每个写入型三级任务获得独立分支、独立 worktree 和不可复用的 `agentInstanceId`；分支元数据必须绑定 mission、task、Agent、基线提交和允许路径。
- 同一文件默认只允许一个三级 Agent 写入。并行修改同一文件必须由次级 Agent 预先声明合并顺序和冲突责任。
- 三级 Agent 只能新增提交到自己的分支，不得执行 merge、rebase、cherry-pick 到集成分支、push、force-update、分支删除或 worktree 清理。
- 三级 Agent 完成后经独立反馈进程上报 `baseCommit`、`headCommit`、修改文件、差异摘要、测试命令/退出码和未决风险，来源绑定其 `agentInstanceId`。

审查与合并规则：

- 次级 Agent 是集成分支的唯一写入者；合并前验证提交存在、祖先关系正确、提交作者/Agent 绑定有效、实际修改未越过任务允许路径。
- 审查必须覆盖：任务符合性、无关修改、敏感信息、可读命名、权限复检、自动备份合规、测试充分性、生成物和依赖变更。
- 审查失败时保持提交未合并，通过反馈工具向原 Agent 下发修正；原 Agent 已回收时，用新 `agentInstanceId` 创建修复任务并按需显式附加旧存档条目。
- 冲突不得通过 `ours`/`theirs`、强制重置或静默丢弃一侧内容解决。复杂冲突创建独立 conflict 任务，完成后重新走全套审查。
- 审查通过后采用保留来源的合并提交或等价可追溯策略。不得在无法追踪原三级 Agent 提交的情况下 squash 多个不同 Agent 的工作。
- 全部 worker 结果进入集成分支后，次级 Agent 运行目标测试、`npm run check` 和任务要求的专项验收，生成结构化 `GitIntegrationReport`。
- 次级 Agent 只有在当前模式与用户授权允许时才能把集成分支合入用户目标分支。`git push`、远端 PR、发布、强制推送及受保护分支修改始终需要独立授权。
- Ponder 不创建分支或提交。Devolve 可免应用层逐次询问，但多写入 Worker 仍要经过指定次级 Agent 的审查与集成。

Git 与自动备份的关系：

- Git 分支和 reflog 不视为工具内自动备份，也不得作为绕过备份保管库的理由。
- checkout 覆盖、reset、clean、rebase、强制移动引用、删除分支/worktree、冲突处理中的内容删除等破坏性操作，必须由底层 Git 工具在执行前自动保存未提交内容 pre-image、相关引用和恢复元数据。
- 备份过程不经过模型；跳过备份、强制合并或跳过审查不得成为模型可控参数。

建议审查报告：

```ts
interface GitIntegrationReport {
  missionId: string;
  integratingAgentInstanceId: string;
  targetBranchName: string;
  integrationBranchName: string;
  targetBaseCommit: string;
  reviewedContributions: Array<{
    taskId: string;
    contributingAgentInstanceId: string;
    workerBranchName: string;
    baseCommit: string;
    headCommit: string;
    changedPaths: string[];
    reviewDecision: "accepted" | "rejected" | "needs-rework";
    executedChecks: Array<{ command: string; exitCode: number }>;
  }>;
  integrationCommit: string | null;
  unresolvedRisks: string[];
}
```

### 2.7 工具内自动备份策略

以下操作一律属于破坏性变更：

- 删除文件、目录、记录或其他资源。
- 删除文字区间、行、字段、数组成员或结构化内容。
- 覆盖已有文件、记录或目标路径。
- 全量或部分替换既有内容。
- 截断、清空或将既有非空内容写为空。
- 重命名/移动时覆盖既有目标。
- 从备份恢复时覆盖当前目标。

强制执行流程：

```text
工具解析并校验目标
  → 工具读取目标 pre-image 与元数据
  → 工具内部写入内容寻址备份对象和追加式 manifest
  → fsync/持久化确认
  → 重新校验目标指纹未变化
  → 执行删除/修改/覆盖
  → 原子提交审计结果
```

- 备份是工具实现的一部分，不是由 Agent 调用的另一个工具，也不消耗模型推理回合。
- 自动创建备份时，备份内容、物理路径、恢复凭据和被删除原文不得自动进入模型输入、`outputText`、反馈消息或对话日志。
- 模型可在后续显式调用受控 `backupVault` 工具执行 `list/read/restore`。`read` 的业务内容可以进入该次工具结果，但底层对象路径、内容对象哈希、加密密钥和内部恢复凭据不得暴露。
- 备份失败、目标改变、空间不足、权限不足或 manifest 写入失败时，破坏性操作必须 fail closed。
- 纯新建操作只有在原子确认目标不存在时才能免备份；已存在时拒绝或改走覆盖工具。
- 备份库使用追加写、内容寻址并由普通工具禁止访问，避免“删除/覆盖备份时又需要备份”导致递归。
- 删除备份通过独立 `deleteBackup` 特权入口完成，不能伪装为普通文件删除或 `backupVault` action。
- 删除备份是 pre-image 自动备份规则的唯一明确例外；审计日志独立保存且不可被 `deleteBackup` 删除，避免无限递归。
- 协同模式：先生成结构化风险警告，将发起 Agent 状态改为 `awaiting-user-authorization` 并暂停工具循环；用户必须对本次请求作 `allow-once/deny`。授权绑定请求 ID、Agent ID、精确备份 ID、vault revision 和短有效期，不允许“会话内记住”。
- 放权模式：不显示权限警告、不等待授权，直接执行，但在 append-only 审计链写入 `reviewPriority: high` 的记录，供审计视图优先展示。
- 思索模式：禁止 list/read/restore/delete 等所有备份工具。
- 防死锁：等待用户授权前释放全部 vault/object/manifest 锁；授权通过专用控制通道送入，`awaiting-user-authorization` 状态只接收匹配请求 ID 的授权消息。删除执行采用“校验与移入 quarantine → 释放锁 → 异步物理清理”的两阶段协议。
- 恢复操作也属于覆盖：恢复前必须先备份当前目标，因此支持 redo/撤销恢复。
- 工具注册时必须声明 `mutationKind`、`backupPolicy` 与 `authorizationPolicy`；普通破坏性工具未采用自动 pre-image，或删除备份未采用特权删除与专用授权策略时，注册表硬拒绝。
- 对 shell、脚本执行器、插件或 MCP 工具，若 harness 无法证明其所有破坏性分支均受备份层保护，则不允许获得写权限。

建议存储布局：

```text
.astarray/backups/
├─ objects/<sha256>              # 加密或权限保护的内容对象，追加写
└─ manifests/<date>/<backup-id>.json
```

manifest 由工具层保存目标逻辑标识、变更类型、变更前指纹、对象哈希、创建时间、工具名、调用 ID 和恢复能力引用。受控读取工具以逻辑备份 ID 工作，不向模型暴露 manifest 路径或对象存储哈希。

### 2.8 敏感禁读、读取回执与事实证据契约

本地判定顺序固定为：

```text
认证调用源 → 敏感内容禁读 → 模式/工具权限 → 资源规范化
→ 在途 single-flight → 重复读取/循环守卫 → 实际工具执行
→ 输出 DLP → 证据/完成门禁
```

任何后级组件不得把前级拒绝改为允许。尤其是读取时间锁不能先打开 `.env` 计算内容哈希；敏感路径应在打开前拒绝，未知内容只能由不回传正文的本地可信扫描器处理。

核心契约至少包含：

```ts
interface ReadReceipt {
  readReceiptId: string;
  agentInstanceId: string;
  taskExecutionId: string;
  canonicalResourceIdentity: string;
  normalizedRange: { startOffset: number; endOffsetExclusive: number } | null;
  contentFingerprint: string;
  resourceIdentityFingerprint: string;
  firstReadMonotonicMilliseconds: number;
}

interface EvidenceItem {
  evidenceIdentifier: string;
  claimIdentifier: string;
  evidenceKind: "source-search" | "local-experiment" | "reasoning";
  relation: "supported" | "contradicted" | "mixed" | "insufficient" | "unavailable";
  sourceLocator?: string;
  sourcePublisher?: string;
  retrievedAt: string;
  summary: string;
  limitations: string[];
}

interface EvidenceBundle {
  evidenceBundleIdentifier: string;
  taskExecutionId: string;
  rigorLevel: "standard" | "high";
  coveredClaimIdentifiers: string[];
  evidenceItems: EvidenceItem[];
  unresolvedConflicts: string[];
  missingEvidence: string[];
  requiresUserJudgment: true;
}
```

`contentFingerprint`、查询哈希和来源摘要只用于本地一致性与去重，不得作为可逆秘密摘要或向模型暴露敏感资源存在性。所有时间量使用带单位的完整变量名。

---

## 3. 编码可读性强制规范

### 3.1 变量与函数命名

必须使用能直接表达业务含义的英文命名：

```ts
// 推荐
const maximumDeliveryDelaySeconds = 10_800;
const consecutiveToolFailureCount = 3;
const runnableTaskIdentifiers = taskGraph.findRunnableTasks();

function calculateNextPrimeBackoffSeconds(
  busyAttemptNumber: number,
): number {
  // ...
}

// 禁止
const max = 10800;
const n = 3;
const ids = graph.run();
function calc(i: number) {}
```

允许的短名称仅限：

- 明确的小范围坐标或数学公式，如 `x`、`y`。
- 通用循环索引，但优先写成 `taskIndex`、`messageIndex`。
- 标准错误变量 `error`，不得缩写成 `e`。
- 标准协议名或领域约定名，如 `id`、`url`、`api`、`ttl`。

其他规则：

- 布尔变量使用 `is`、`has`、`can`、`should` 前缀。
- 时间量必须在名称中写明单位，例如 `deliveryDelaySeconds`、`timeoutMilliseconds`。
- 集合使用复数，Map 名称体现键和值的含义。
- 函数名使用动词开头；纯判断函数使用 `is/has/can/should`。
- 不允许用注释弥补含糊命名。
- 不允许在核心领域代码中使用 `any`。
- 单个函数只负责一个清晰行为；复杂分支应提取为具名函数。

### 3.2 代码审查门槛

每批任务完成后，OpenCode 必须额外搜索以下模式并人工判断：

```text
变量：tmp、data、obj、val、res、ret、arr、foo、bar、x1、x2
函数：run、doIt、handle、process（没有业务限定词时）
时间量：timeout、delay、interval（名称中没有单位时）
```

测试代码也应保持可读性，但 fixture 中模拟外部协议字段时可以保留协议原名。

---

## 4. 产品接口

### 4.1 CLI

```text
astarray
astarray --mode ponder
astarray run "分析当前项目" --mode assist
astarray run "完成该任务" --mode devolve
astarray run "演示任务" --runtime mock --json
astarray resume <mission-id>
astarray status [mission-id]
astarray status [mission-id] --json
astarray cancel <mission-id>
astarray config init
astarray doctor
astarray doctor --json
astarray --version
astarray --help
```

- TTY 环境默认启动全屏 TUI。
- 非 TTY 环境不得进入 raw mode，应使用 headless 输出或返回明确错误。
- `--json` 模式的 stdout 只允许输出机器可解析结果；日志写 stderr。
- 没有真实 Provider 凭据时，`mock` runtime 仍须可运行。

### 4.2 TUI 建议布局

```text
┌─ Astarray ─ mode: Assist ─ mission: M-001 ─ agents: 3/4 ─ calls/tokens/cache ┐
│ Tasks/DAG        │ Conversation & Events           │ Agents / Mailboxes      │
│ ✓ T-001          │ user> ...                       │ L2 scheduler   idle     │
│ ● T-002          │ main> ...                       │ L3-A           busy     │
│ ○ T-003          │ [tool] read(...)                │ L3-B           blocked  │
│                  │ [feedback] ...                  │ queue: 2                │
├─────────────────────────────────────────────────────────────────────────────┤
│ Input:                                                                      │
└─ Tab:切换面板  Ctrl+M:模式  Ctrl+N:新任务  Ctrl+C:取消/退出  ?:帮助 ─────────┘
```

必须支持：

- 最小 80×24 终端尺寸。
- 终端动态缩放。
- `NO_COLOR=1`。
- 中英文宽字符和 emoji。
- 清洗来自模型与工具输出的 ANSI/OSC 控制序列。
- 正常退出、异常和 SIGINT 后恢复光标及 raw mode。

---

## 5. 建议目录结构

```text
astarray/
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vitest.config.ts
├─ AGENTS.md
├─ README.md
├─ LICENSE
├─ opencode.json
├─ PLAN_STATUS.md
├─ DELIVERY_REPORT.md
├─ docs/
│  ├─ architecture.md
│  ├─ configuration.md
│  ├─ security.md
│  └─ adr/
├─ packages/
│  ├─ core/                     # 底层架构；不依赖任何界面层
│  │  └─ src/
│  │     ├─ core/               # 类型、事件、状态机、权限、DAG
│  │     ├─ orchestration/      # Agent 编排与任务管理
│  │     ├─ runtime/            # Runtime 与工具循环
│  │     ├─ feedback-process/   # 独立反馈进程、IPC、journal
│  │     ├─ tools/              # 工具注册、策略、工作区边界
│  │     └─ infra/              # 存储、缓存、指标、脱敏
│  ├─ tui/
│  │  └─ src/
│  │     ├─ cli.tsx             # npm bin 入口
│  │     ├─ cli/                # Headless CLI 与启动装配
│  │     └─ ui/                 # React/Ink TUI
│  └─ gui/
│     └─ README.md              # GUI 边界与后续实现约束
├─ tests/
│  ├─ core/                     # 底层架构 unit/integration/fixtures
│  └─ tui/                      # TUI unit/component/integration
└─ scripts/
   ├─ verify-package.mjs
   └─ smoke-install.mjs
```

依赖方向：

```text
packages/tui → packages/core/Application Controller → Domain Core
                            ├────→ Orchestration
                            ├────→ Runtime/Tool Ports → Adapters
                            └────→ Stores/Feedback Process Client
```

- UI 不得直接访问 Provider、工具或文件系统。
- 独立反馈进程不得依赖 React/Ink。
- Agent 只能通过 feedback client 与独立反馈进程交互。
- 领域层不能依赖进程通信协议的具体实现。

---

## 6. OpenCode 原子任务链

### T00：架构定稿和契约

产出：

- `docs/architecture.md`
- `docs/adr/` 中的冻结决策记录
- 核心领域类型和 schema
- `PLAN_STATUS.md`

定义：

- 模式、Agent 状态、任务状态。
- 消息类型、优先级和确认语义。
- 具体 Agent 个体身份、工作存档和选择性附加契约。
- 破坏性变更分类、工具内备份凭证和模型不可见边界。
- 任务状态迁移。
- 权限结果 `allow | ask | deny`。
- Runtime、Tool、Store、FeedbackTransport 接口。

完成门槛：

- schema 成功与失败测试齐全。
- 文档核心约束均能映射到类型、策略或测试。
- 类型和变量命名通过可读性检查。

### T01：npm 和 TypeScript 工程骨架

实施：

- 初始化 TypeScript ESM 工程。
- 配置 Ink、React、构建器、ESLint 和 Vitest。
- `packages/tui/src/cli.tsx` 包含 Node shebang。
- `package.json` 设置 `bin`、`files`、`engines.node >= 20`。
- 提供 `build`、`typecheck`、`lint`、`test`、`check`、`prepack` scripts。

完成门槛：

```powershell
npm run typecheck
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

### T02：模式状态机与权限策略

实现：

- Ponder 仅允许本地只读白名单工具；不暴露通用 shell、进程、通用网络、写入、凭据或备份工具。高严谨性资料查询只能通过 `factVerification` 专用搜索代理。
- Assist 对只读、受限、禁止工具分别执行 allow、ask、deny。
- Devolve 允许注册工具，但不能越过工作区和系统边界。
- 会话授权过期、参数变更后二次鉴权、敏感字段脱敏。
- 敏感操作和副作用分类由本地执行，未知工具或无法证明只读的调用 fail-closed；Provider/AI 判断不能放行。

完成门槛：

- 表驱动测试覆盖模式 × 工具类别 × 授权状态。
- Ponder 的普通项目读取/检索/只读状态查询和受控事实搜索成功；写入、shell、任意网络、备份访问、路径逃逸和伪造只读声明均在本地失败。
- 降级后的下一次调用使用新策略。
- 修改参数后必须重新鉴权。

### T03：原子任务链持久化

实现：

- `.astarray/missions/<missionId>/task-chain.json`。
- `schema_version` 与单调递增的 `revision`。
- 临时文件、flush、同目录原子替换和备份恢复。
- 进程内 mission 锁。
- 损坏文件进入 recovery，不得静默覆盖。

完成门槛：

- 模拟崩溃后可恢复旧版本。
- Windows 已存在目标文件替换场景通过。
- 并发更新不会发生旧 revision 覆盖新 revision。

### T04：独立反馈进程

实现：

- 使用 `child_process.fork` 或具有同等跨平台能力的 Node 子进程机制。
- 主进程负责启动、健康检查、优雅关闭和异常重启。
- 使用显式版本化 IPC 协议，不通过 stdout 解析业务消息。
- stdout/stderr 只作诊断日志。
- 每个接收者拥有独立持久化 mailbox journal。
- 每条消息必须携带通过校验的原始信息来源；转发时来源保持不变。
- Agent 来源必须具体到已注册的 `agentInstanceId`，反馈进程校验声明来源与 IPC 客户端身份。
- 提供 enqueue、peek、deliver、ack、replay、health、shutdown。
- 投递到接收者并收到 ack 后才从未投递集合消费。
- 普通消息仅在接收 Agent 为 `idle` 时投递。
- 独立控制通道可以传递 cancel。
- 使用质数退避，单次等待封顶 10,800 秒。

必须处理：

- 反馈进程崩溃和自动重启。
- 主进程重启后重连。
- IPC 断开时的发送失败。
- 重复投递的幂等处理。
- 反馈进程孤儿化和主进程退出后的清理。
- 协议版本不兼容。
- 来源缺失、来源身份与已注册 IPC 客户端不一致或转发时来源被篡改。
- journal 损坏或部分写入。

完成门槛：

- 通过测试证明反馈进程 PID 与主进程不同。
- 杀死反馈进程后，supervisor 能重启并重放未确认消息。
- Agent busy 时普通消息不进入其上下文。
- 缺失或非法来源的消息无法入池；合法消息在 journal、投递和 ack 全链路保持来源不变。
- 用户消息经主 Agent 转发后仍显示用户来源；Agent 自主消息显示具体 Agent 和层级。
- 同优先级 FIFO，高优先级可越过低优先级。
- 虚拟时钟验证退避增长、3 小时封顶和新消息重置。
- 整个退避测试不得真实 sleep。

### T05：DAG 调度器

实现：

- 依赖校验、环检测、可运行任务计算。
- 并发限制、任务领取锁、失败传播。
- blocked、retry、cancel、reassign。
- 每次调度后原子更新 task chain。

完成门槛：

- 有依赖任务严格串行。
- 无依赖任务达到配置并发。
- 任务完成后立即重新计算可运行集合。
- 同一任务不能被两个 Worker 同时领取。
- 连续失败达到阈值后暂停并反馈，成功后计数清零。

### T05A：Agent 工作存档与上下文选择器

实现：

- 为每个次级、三级 Agent 建立独立、版本化、原子写入的 `work-archive.json`。
- Agent 身份与存档目录、文档内容一致性校验。
- 追加 assignment、progress、decision、result、failure、handoff 条目。
- 上级 Agent 可查询下级存档元数据与摘要，并按条目选择附加内容。
- 存档选择器根据显式条目、相关性、新鲜度和 token 预算生成不可变附件快照。
- 默认选择为空，不得无条件加载整个存档。
- 为附件生成 provenance：存档所有者、revision、完整条目快照、选择原因和内容哈希。
- 当前任务提示词清晰分隔当前指令与历史工作上下文；历史内容不能覆盖当前约束。

完成门槛：

- 两个同层 Agent 的工作存档相互隔离。
- Agent 不能写入另一个 Agent 的存档。
- 新任务可以不附加、附加一个条目或附加多个条目。
- 重新调用同一具体 Agent 时，可选择该 Agent 的历史条目；调用另一个 Agent 时也可由上级显式选择合法条目。
- 附件基于指定 revision；存档随后更新不会改变已生成附件。
- 超出 token 预算时明确截断或拒绝，并记录原因，不静默加载全部内容。
- 跨 mission 附加默认拒绝，获得长期记忆读取许可后才允许。

### T05B：次级 Agent Git 分流、审查与合并控制器

实现：

- `GitIntegrationCoordinator`：由具体次级 `agentInstanceId` 绑定 mission 集成会话，只有它能写集成分支。
- `GitWorktreeAllocator`：从固定基线为每个三级 Agent 创建隔离分支/worktree，并记录任务允许路径。
- `GitContributionVerifier`：验证提交祖先关系、身份绑定、实际修改路径、敏感信息、命名、备份规则和测试证据。
- `GitIntegrationReportStore`：保存结构化分流、审查、拒绝、冲突、测试和合并记录，并与次级 Agent 工作存档关联。
- 受控合并流程：审查通过 → 集成分支合并 → 集成测试 → 模式/用户门禁 → 目标分支合并。
- 破坏性 Git 工具适配器：reset、clean、checkout 覆盖、rebase、强制移动引用、删除分支/worktree 前自动创建受保护恢复点。

完成门槛：

- 两个三级 Agent 可在独立 worktree 并行提交，互不污染工作区和索引。
- 三级 Agent 无法写入集成/目标分支，无法自行 merge、rebase、push 或删除分支。
- 次级 Agent 能拒绝越界文件、错误基线、伪造 Agent 身份、敏感信息和缺失测试证据的提交。
- 冲突不会静默选边；修复任务可追溯到新 Agent 个体和原贡献提交。
- 合并报告能从最终集成提交追溯到每个三级 Agent、任务、提交和测试证据。
- 目标分支和远端操作按模式执行门禁；自动流程不得 push 或发布。
- 破坏性 Git 操作失败时恢复点仍可用，且不会把恢复能力泄露给模型。

### T05C：Agent 待办任务偏序集、任务包与状态工具

实现：

- `AgentTaskSequenceStore`：在 Agent 记忆存档域保存版本化偏序集，支持原子写入、expected revision、恢复和来源审计。
- `TaskSequencePartialOrder`：插入前驱/后继、环检测、传递关系查询、ready set 和稳定优先级排序。
- `TaskPriorityPolicy`：用户来源默认层级 0；Agent/system/工具来源硬限制为层级 1 或以下；用户来源通过认证控制通道注入。
- `TaskBundlePlanner`：将同一执行者可完成的一条链冻结为任务包，验证优先层、工具、权限、任务范围和源 revision。
- `TaskSequenceManageController`：发布、插入、改序、取消和创建任务包；任何删边、覆盖、改序或清理先走自动备份。
- `TaskSequenceStatusController`：提供一致 revision 的只读快照、ready set、阻塞原因、顺序解释和任务包状态。
- TUI/CLI 状态适配器：用户无需打断正在工作的 Agent 即可查看；项目任务/产出视图与 Agent 待办视图分栏展示。

完成门槛：

- 任意合法 DAG 插入保持无环；非法环、未知锚点、陈旧 revision 和越权改序全部拒绝。
- 用户任务不指定优先级时为层级 0；Agent、system 和工具请求层级 0 时硬拒绝。
- 调度只从 ready set 选择，优先层严格生效；同层排序确定且可重放。
- 高优先任务的必要低层前驱可被提升执行，并能由 `explain-order` 解释原因。
- 次级 Agent 可把完整链打包给一个三级 Agent；失败节点阻止包内后继，节点边界可因新用户任务重新调度。
- 状态工具在任务执行期间返回一致、无副作用的快照，不更改 busy 状态、退避轮次或任务顺序。
- Agent 序列文件不包含项目产出内容；项目任务状态不会因序列存储写入被隐式覆盖。
- 任务序列插入、改序、取消和清理的破坏性分支均先自动备份。

### T06：工具注册表与最小权限

工具描述至少包含：

```ts
interface ToolDescriptor {
  name: string;
  summary: string;
  category: "readonly" | "restricted" | "forbidden";
  mutationKind:
    | "none"
    | "create-only"
    | "delete-resource"
    | "delete-content"
    | "overwrite"
    | "replace"
    | "truncate";
  backupPolicy:
    | "not-required"
    | "automatic-preimage"
    | "protected-vault-deletion";
  authorizationPolicy:
    | "standard"
    | "backup-vault-action"
    | "backup-deletion";
  supportedTaskTypes: string[];
  inputSchema: unknown;
}
```

实现：

- 主 Agent 只获得工具名和一句话摘要。
- 次级 Agent 获得完整 schema 和用法。
- 三级 Agent 只获得任务所需工具子集。
- 工具真正执行前再次通过 policy wrapper。
- shell、删除、发布、付款类工具默认不开放；安装类工具在 T06E 完成前不开放，完成后仍必须经过“已有资源询问 + 独立开关 + 本次 allow-once”三项门禁。
- 破坏性工具缺少 `automatic-preimage` 时注册失败；`create-only` 工具目标已存在时拒绝；删除备份只能使用 `protected-vault-deletion + backup-deletion`。

完成门槛：

- 三级 Agent 无法调用子集外工具。
- 能统计工具描述注入产生的 token。
- 不会把完整工具注册表发给每个 Worker。

### T06A：工具内破坏性变更备份层

实现：

- `DestructiveBackupStore`：内容寻址对象、追加式 manifest、原子写入、fsync、校验和恢复读取。
- `DestructiveMutationGuard`：备份前/后的目标指纹校验，备份成功后才允许执行变更。
- 删除文件/目录、文本删除、替换、截断、覆盖写、重命名覆盖的受保护工具适配器。
- `backupVault`：按逻辑备份 ID 列出、读取、恢复；恢复前先备份当前版本。
- `deleteBackup`：独立删除入口；思索/协同/放权三种模式使用专用策略，不复用普通会话授权。
- `BackupDeletionAuthorizationController`：协同模式警告、暂停、单次授权、拒绝/超时恢复。
- `BackupDeletionAuditLedger`：哈希链、append-only、`HIGH` 查阅优先级，备份删除工具无权删除。
- 两阶段删除：vault revision/引用校验、原子 quarantine、释放锁、异步 purge；重启后可恢复未完成阶段。
- 工具内部备份凭证与模型可见结果严格分离。
- 备份库路径逃逸、符号链接、硬链接、并发修改和磁盘不足处理。
- 注册表检查破坏性工具声明，运行时 guard 再次强制执行，不能只信任 descriptor。

完成门槛：

- 每种破坏性变更都能证明在目标改变前已存在可校验的完整 pre-image。
- 备份失败时目标字节、目录结构或记录内容保持不变。
- 目标在备份后、修改前变化时操作中止，避免错误恢复点。
- 对同一内容去重但每次操作保留独立 manifest 和审计记录。
- 自动创建阶段不会把备份内容、路径、对象哈希和恢复能力放入 Agent 输入、工具输出、反馈消息、TUI 对话或普通日志；只有显式 `backupVault.read` 才返回经过权限检查的业务内容。
- `create-only` 对已存在目标返回稳定错误，不覆盖。
- 恢复前自动备份当前版本，连续撤销/恢复不丢状态。
- 破坏性插件或通用 shell 无法绕过 guard。
- 协同模式删除备份会暂停对应 Agent；未授权、拒绝、过期时不删除且 Agent 按明确状态恢复。
- 协同模式等待授权期间不持有 vault 锁，并可通过专用控制通道收到匹配决定。
- 放权模式删除不产生交互提示，但审计账本出现 `HIGH` 记录；该记录不可由备份删除入口移除。
- 两个 Agent 并发删除同一备份不会死锁或重复清理；vault revision 变化使陈旧授权失效。
- Windows、macOS、Linux 的文件、目录、rename-overwrite 行为均有测试。

### T06B：Ponder 本地只读边界与敏感操作分类

实现：

- `LocalToolPolicyEngine`：在 schema 暴露和工具实际执行时双重校验当前模式、认证主体、工具 ID、能力和参数。
- `LocalSensitiveOperationClassifier`：在三种模式的策略判断之前统一使用版本化确定性规则分类文件/Git 变更、进程、网络、外部发布、凭据、备份和系统操作；不发起云端分类请求。Ponder 据此硬拒绝，Assist 据此 ask/deny，Devolve 据此执行不可绕过边界与审计。
- Ponder 专用只读适配器：`readProjectFile`、`listProjectDirectory`、`searchProjectText`、`taskSequenceStatus` 与固定 Git 查询；使用只读句柄或固定参数，不经通用 shell。
- 工作区与受保护路径策略：规范化绝对/真实路径、链接/联接点、打开标志和 TOCTOU 复检；排除 `.astarray` 受保护区、备份库、凭据和策略敏感路径。
- OS 沙箱能力：Ponder 模型运行单元移除写入、进程执行和直接网络能力；隔离事实搜索代理使用独立最小网络能力。wrapper 与沙箱任一失败均拒绝。
- 稳定本地拒绝事件：记录工具 ID、规则版本和拒绝原因，不记录文件秘密，也不向模型开放策略修改能力。

完成门槛：

- Ponder 可只读查看普通项目文件、检索文本、查询获授权任务状态和 Git 只读视图，且不产生项目/任务/记忆/缓存/遥测写入。
- 写入标志、create/delete/replace/truncate/rename、Git 写命令、shell、网络、安装、发布、凭据和备份工具全部在 Provider 请求前或本地执行边界被拒绝。
- 路径穿越、绝对路径逃逸、符号链接/联接点、大小写/别名/包装命令、伪造 descriptor、TOCTOU 和未知工具反例全覆盖。
- 断网、Provider 不可用或 AI 风险分类返回错误结论时，本地授权结果不变。
- Assist 降级为 Ponder 后，旧会话授权不能沿用；后续调用立即复检。
- 关键策略分支覆盖率不低于 95%，`npm run check` 通过。

### T06C：全模式本地敏感内容禁读

实现：

- `SensitiveContentAccessPolicy`：在模式权限和工具执行前统一拒绝 `.env`、`.env.*` 及其大小写变体、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`、云/Kubernetes 凭据、私钥、证书容器、能力令牌和管理员扩展敏感路径。
- `SensitiveResourceIdentityResolver`：按规范路径、realpath、符号链接/联接点、硬链接文件身份、Git 对象来源、压缩包成员和平台大小写规则识别同一敏感资源。
- 本地可信 DLP 流式扫描器：对名称正常但内容疑似凭据的结果在进入模型前扫描；命中后丢弃整个结果，不返回正文、命中片段或可逆摘要。
- 所有通道接入：read/list/search、Git diff/log/show、归档解包、OCR/编码转换、插件/MCP、shell 适配器、事实验证上传、缓存、反馈、工作存档和错误处理。
- 程序凭据装载与模型工具分离：运行时可在最小权限进程中使用环境变量，但原值不能成为 `AgentEvent`、工具参数回显或模型上下文。
- 稳定拒绝码 `sensitive-content-read-denied`；审计只保留规则类别和脱敏资源标识。路径/DLP/编码判断不确定时 fail-closed，不提供逐次授权例外。

完成门槛：

- Ponder/Assist/Devolve 和用户明确要求读取时均拒绝 `.env`、`.env.local`、`service.env`、私钥及凭据库；会话授权和 Devolve 不能放行。
- 相对/绝对/UNC、大小写、符号链接/联接点、硬链接、Git 历史、归档、base64/编码、重命名伪装和插件工具均不能绕过。
- list/search/glob 不返回秘密内容；日志、错误、反馈、缓存、存档和证据包不包含秘密字节。
- 普通非敏感配置可按模式读取；程序运行所需环境变量仍可由隔离配置装载器使用但不进入模型。
- 三平台目标测试、安全反例、属性测试和关键分支 95% 覆盖通过；`npm run check` 通过。

### T06D：高严谨性事实验证工具

实现：

- `LocalRigorPolicyEngine`：用本地版本化规则标记 `standard/high`；法律、医疗、财务、安全、权限、破坏性操作、发布和时效性事实默认 high。用户/模型可上调，模型不能下调。
- `factVerification` 受控工具：`search-sources / record-local-experiment / record-reasoning / build-evidence-bundle`。
- 专用资料搜索代理：只接受结构化查询，不开放通用浏览/任意网络执行；来源正文、发布者、直接链接/文档标识、发布时间、取得时间和内容摘要哈希可追溯。
- `EvidenceBundleBuilder`：按 claim 记录资料、本地实验、纯推理、冲突、覆盖和局限；权重固定为“资料搜索 > 本地实验 > 纯推理”。
- 本地实验记录实际环境、步骤/命令、输入、退出状态、观察和产物哈希；纯推理记录前提与不确定性。
- `EvidenceCompletionGate`：缺少工具调用、关键主张覆盖或来源正文时给出未满足门禁；T07A 的 `LocalCompletionVerifier` 接入该端口。离线/失败时允许以 `insufficient/unavailable` 结束验证流程，但不得宣称已证实。
- 输出 schema 只允许 `supported/contradicted/mixed/insufficient/unavailable` 及辅助资料，不提供 `qualified/safe/pass` 最终判定。TUI/CLI 把证据与“等待用户判断”分区。
- 查询调用 ADR-0018 敏感禁读/上传门禁，并使用规范化查询指纹、缓存、来源去重和预算防止换词活锁。

完成门槛：

- 高严谨性任务未调用事实工具、只做纯推理或关键 claim 无覆盖时，本地完成声明被拒绝；普通任务不强制联网。
- 三层证据排序稳定；搜索结果摘要、伪造链接、重复转载、过期资料和 Agent 自述不能冒充高等级资料依据。
- 冲突证据全部展示，不以多数投票或模型偏好静默合并；资料不足时清晰交给用户判断。
- 离线/资料不可访问/本地实验失败时返回不足状态，不虚报合格；用户要求离线时不联网。
- 查询不能上传项目正文、`.env`、凭据、私钥、备份或完整提示词；提示注入型来源不能生成工具指令。
- 默认 CI 使用本地假搜索代理和确定性实验；可选真实网络契约测试隔离运行；关键分支覆盖率不低于 95%。

### T06E：Assist 安装前置确认、独立开关与逐次授权

实现：

- `InstallationOperationClassifier`：按实际效果识别安装，不依赖可绕过的命令字符串。覆盖代码库 clone/download/vendor、项目依赖新增/更新、运行时/编译器/浏览器、插件/技能/模型、工具链与系统包，以及生命周期安装脚本、lockfile/vendor 改写和依赖解析变化。
- `ExistingResourceInquiryController`：安装之前先向用户发送结构化 `existing-resource-inquiry`，说明所需能力、用途和候选资源；将 Agent 暂停为 `awaiting-existing-resource-answer`。用户提供资源时只运行只读兼容性/版本/完整性检查，失败后返回差异并再次等待用户决定。
- `AssistInstallationSettings`：独立布尔设置 `isAssistInstallationEnabled`，默认 `false`；只能由认证用户经 TUI/CLI 设置控制面更改。设置写入使用工具内自动备份、单调 revision 和审计，模型、Agent、项目配置和插件无写权限。
- `AssistInstallationAuthorizationController`：用户明确确认没有可用资源且开关开启后，生成 `assist-installation-request`。请求绑定具体 Agent/任务、来源 URL 或 registry、包/仓库标识、精确版本或 commit、完整性信息、目标路径/作用域、包管理器、参数、网络、安装脚本和预计变更摘要。
- 安装授权只允许 `allow-once`，不接入 Assist 十分钟会话授权。来源、版本/commit、完整性、目标、作用域、参数、lockfile 或安装脚本摘要变化时立即失效；批量安装必须逐项列明并对不可分割的精确计划整体确认，后续新增项重新授权。
- 实际执行前在本地复检当前仍为 Assist、设置 revision、授权 nonce、请求参数哈希、目标工作区/系统边界、敏感内容禁读和破坏性变更备份。等待答复时释放文件、任务领取和包管理器锁；其他 ready 任务可继续。
- TUI 与 Headless CLI 提供独立开关、已有资源回答和安装授权界面；非交互模式没有随命令提供的、绑定精确请求的用户授权能力时 fail-closed，不能把 `--yes`、环境变量或模型文字当作确认。

完成门槛：

- npm/pnpm/yarn、pip/uv/poetry、cargo、系统包管理器、git clone、插件/技能安装及包装 shell/脚本均被一致识别；改名、别名、间接脚本和 Agent 自述不能绕过。
- 默认开关关闭时没有任何安装命令、下载、lockfile/vendor 改写或生命周期脚本执行；开启开关但没有本次授权时结果相同。
- 每次需要安装前都先得到“是否已有资源”的用户答案；用户提供现有资源时不发起网络安装，只做只读验证。验证不兼容不能自动安装。
- 用户确认无可用资源、开关开启且精确授权有效时才执行一次；授权消费、拒绝、超时、参数变化、模式变化、设置 revision 变化和重放均 fail-closed。
- 设置修改和安装造成的破坏性写入均先由执行工具自动备份；`.env`、registry token 和凭据不进入请求、日志、反馈或模型。
- Windows、macOS、Linux 目标测试和关键分支 95% 覆盖通过；`npm run check` 通过。本任务作为高风险任务单独提交和验收。

### T06F：可配置权限组与无限命名自定义模式

实现：

- `PermissionCapabilityCatalog`：本地版本化权限目录。每个可配置权限包含稳定 ID、显示名称、说明、Devolve/Assist 默认值、适用资源、风险摘要和工具映射；未映射工具拒绝注册和执行。工具需要多项权限时取最严格结果：任一 deny 则 deny，否则任一 ask 则 ask，全部 allow 才 allow。
- 权限目录必须逐项覆盖：`project.read/create/modify/destructive-mutate`、`process.execute-sandboxed/execute-host`、`network.read/write`、`browser.read/interact`、`connector.read/write`、`database.read/write`、`cloud.read/write`、`clipboard.read/write`、`environment.read/modify`、`code-repository.acquire`、`dependency.install-project/install-global`、`extension.install`、`git.read/write-local/rewrite-history/remote-write`、`external.publish/communicate`、`financial.transact`、`system.modify`、`backup.list/read/restore/delete`、`agent.spawn/delegate/manage`、`task.read/manage` 和 `memory.read-selected/write`。增加新能力必须新增稳定权限 ID，不能塞入宽泛“其他”。用户直接管理权限组属于认证设置控制面，不作为 Agent 权限项。
- `PermissionProfileStore`：保存三个内置权限组和用户自定义组，使用单调 revision、目录版本、原子持久化、并发冲突检测和工具内自动备份。Devolve 出厂默认全部 allow；Assist 使用 ADR-0020 独立矩阵；Ponder 使用签名冻结的只读 profile，所有更新入口都拒绝修改。
- `CustomPermissionProfileController`：创建、命名、重命名、复制、导入、导出、重置和删除自定义权限组。每组使用不可复用 `permissionProfileId`；名称经 Unicode 规范化和大小写折叠后在活动组中唯一，保留内置中英文名称。系统不设置数量上限，仅使用通用单文档大小、磁盘空间和并发写入保护。
- 创建源支持空白全 deny、Assist、Devolve、Ponder 可配置视图和任一自定义组。复制后 revision/ID 独立；自定义组为未来新权限保存 fallback，默认 deny。导入只接受可配置目录字段，不得携带内部状态或执行策略。
- 运行态用 `PermissionProfileReference` 替代只有三值的模式枚举：`builtin:ponder`、`builtin:assist`、`builtin:devolve` 或 `custom:<permissionProfileId>`。任务、反馈、授权、缓存和审计绑定 profile ID、displayName 快照、revision 与目录版本；名称变更不改变身份。
- `ConfigurablePermissionPolicyEngine` 在 schema 暴露和实际执行前读取当前 profile 快照并裁决。profile revision、工具权限映射、模式引用或调用参数变化后，旧 ask 授权失效。模式/权限组选择只能来自认证用户控制面。
- TUI/CLI（以及未来 GUI）共用同一认证设置控制器，提供权限组列表、创建/命名/复制/重命名/删除/导入导出和逐项三态控件。Devolve 初始全部显示“直接允许”；Assist 显示独立默认；Ponder 仅作为不可编辑模式选择项，不进入权限编辑页。模式切换改为可搜索选择器，禁止硬编码三项循环；系统和 Agent 只能建议，不得自动进入更宽权限组。
- 内部强制执行层与权限配置产品面完全隔离：不进入 catalog/profile/schema/设置按钮/锁定项/帮助/导出/普通审计/模型描述。命中时对外仅返回稳定、最小且不包含规则类别的不可用结果；详细分类只进入隔离的受保护内部审计。

完成门槛：

- Devolve 新建/重置后所有目录权限均为 allow；任意单项切到 ask/deny 会在 schema 暴露和执行时同步生效。Assist 修改不影响 Devolve，反之亦然。
- Ponder 通过设置、控制器、导入、直接状态文件编辑、旧版本迁移、大小写/别名和并发竞态均不能改变；Ponder 不显示权限编辑控件。
- 能创建、命名、复制和使用至少 10,000 个测试权限组且没有产品数量上限分支；名称冲突、Unicode 等价名、保留名、伪造内置 ID、路径穿越和超大单项输入被稳定拒绝。
- 删除当前组前必须切换；覆盖、重置、导入、删除自动备份。并发 revision 冲突不丢更新；损坏 profile 可从备份恢复且不会回退到更宽权限。
- 目录新增权限时 Devolve 使用默认 allow、Assist 使用目录独立默认、自定义组使用各自 fallback 并标记未审阅；目录降级/未知权限 fail-closed。
- 多权限工具按最严格结果裁决；旧授权、旧缓存和正在等待的调用在 profile revision 变化后不能复用。
- 设置 UI、CLI 帮助、profile 导出、普通错误/审计和模型工具描述不包含内部执行层的名称、清单或存在性提示；只暴露可配置权限。
- TUI 80×24/120×40/60×20、键盘导航、搜索权限、长名称、重命名和大量 profile 虚拟列表通过；Headless CLI JSON 输出稳定。
- 属性测试、并发测试、迁移测试、安全反例和关键分支 95% 覆盖通过；`npm run check` 通过。本任务作为高风险任务单独提交和验收。

### T06G：主 Agent 永久只读、次级权限上限与会话临时提升

实现：

- `MainAgentReadonlyToolProjection`：无论当前引用 Assist、Devolve、自定义 profile 或存在任何临时提升，主 Agent 的模型工具投影始终只包含读取类专用工具。主 Agent 不获得写入、进程、安装、外部副作用、Agent 管理、权限管理或配置导出工具。
- `SecondaryAgentSessionController`：作为认证本地控制面接收主 Agent 转交的任务，创建不可复用的次级 `agentInstanceId`，并绑定 session、基础 profile ID/revision、目录版本和权限快照。该控制器不接受模型自由填写授权决定，也不作为主 Agent 工具注册。
- `SessionPermissionElevationStore` 与 `SessionPermissionElevationController`：保存当前会话、作用域（会话全部次级 Agent 或具体次级 Agent）、可选 `agentInstanceId`、capability、资源范围、原/新决定、基础 profile revision、目录版本、会话权限 revision、创建/到期时间和用户裁决引用。默认提升该会话全部现有及后续次级 Agent，也允许个体覆盖；只允许认证用户创建、撤销或缩短提升，且不修改基础 profile。
- `EffectiveSecondaryPermissionResolver`：按“基础 profile + 仍有效的会话级覆盖 + 该次级 Agent 个体覆盖”计算当前有效权限。会话关闭、到期、撤销、profile 切换/revision 变化、目录版本变化时相应覆盖失效；次级 Agent 回收额外撤销其个体覆盖。结果变化增加会话权限 revision，使未执行调用和旧授权重鉴权。
- `TertiaryPermissionDelegationGuard`：次级 Agent 分配三级 Agent 时对三态决定、capability、工具映射、资源范围、目标路径、期限和任务范围逐项求交。以 `deny < ask < allow` 为宽度顺序；三级 Agent 的最终权限不得宽于次级有效权限，也不得继承其他次级 Agent 的覆盖。
- 三级 Agent 权限不足时只能通过反馈进程向其所属次级 Agent 回报。次级 Agent 生成面向认证用户的提升申请；主 Agent 只转达用户对话，不拥有或消费提升。申请、裁决和后续调用绑定具体次级 Agent 与 session。
- `CurrentPermissionConfigurationExporter`：在会话运行时或关闭流程中，默认导出基础 profile 加会话级覆盖的公开有效配置；存在个体覆盖时可选择导出指定次级 Agent 的最终有效配置或分别导出多个次级 Agent。支持版本化 JSON 文件及“创建新命名自定义 profile”两种目标；导出字段仅含公开 capability 决定/资源范围、目录版本、来源 profile 引用和显示元数据。
- 导出必须剥离 session ID、agentInstanceId、授权 nonce/签名、会话令牌、普通会话授权、一次性安装/备份许可、到期计时器、内部审计和内部执行字段；导入导出结果不具有临时授权效力。导出覆盖已有文件前自动备份。
- `SessionShutdownCoordinator`：停止新派发、收敛/取消在途调用、展示可选导出、原子写出所选配置，然后无条件撤销所有临时覆盖并关闭会话。用户跳过/取消或导出失败不得延长覆盖寿命；失败只报告导出未完成。Headless 仅在显式 `--export-permissions <path>` 或等价结构化参数存在时导出。
- TUI/CLI（未来 GUI 共用控制器）分别显示会话级提升和每个具体次级 Agent 的个体提升、基础 profile、当前有效公开决定、到期和撤销入口；会话级按钮明确标注影响全部现有及后续次级 Agent。不提供“提升主 Agent”。批量提升展开为逐 capability 记录并明确作用域。

完成门槛：

- 对 Assist、Devolve、自定义 profile、全部 allow profile 和会话提升后的工具投影做表驱动测试，主 Agent 始终只有读取类工具；构造非读取调用在本地执行前拒绝。
- 本地控制器能创建次级 Agent，但主 Agent 模型工具表中不存在 spawn/权限/导出工具；伪造 Agent ID、profile revision、用户裁决或控制消息不能创建有权次级 Agent。
- 次级 deny/ask/allow 分别只允许三级分发 deny、deny/ask、任意三态；多权限工具和资源范围求交不能扩大。会话级覆盖对提升前后创建的次级 Agent一致生效；两个次级 Agent 的个体覆盖完全隔离。
- 临时提升创建、查看、使用、到期、撤销、Agent 回收、会话关闭、profile/revision/目录变化和重放路径均有动态测试；基础 profile 文件在提升期间保持字节不变。
- 关闭会话导出 JSON/新 profile 可复现公开有效决定；导出中不存在 session/Agent/nonce/签名/令牌/一次性许可/到期/internal 字段，重新导入不会恢复临时授权。
- 导出成功、用户跳过、用户取消、磁盘不可写、目标冲突和进程崩溃场景下，临时覆盖最终都被撤销；覆盖现有导出文件有自动备份且不会死锁。
- TUI 多次级 Agent 选择、逐项提升、剩余时间、撤销和关闭导出交互通过；Headless 未指定导出参数时不写文件，指定时 stdout JSON 契约稳定。
- 属性测试、并发竞态、fake clock、崩溃恢复和关键分支 95% 覆盖通过；`npm run check` 通过。本任务作为高风险任务单独提交和验收。

### T07：Agent Runtime

定义：

```ts
interface AgentRuntime {
  run(
    agentRunInput: AgentRunInput,
    cancellationSignal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
}
```

实现：

1. `ScriptedRuntime`：用于确定性测试，可模拟流式输出、工具调用、成功、失败、超时和模糊反馈。
2. `OpenAICompatibleRuntime`：读取配置，支持流式输出、工具调用、超时、取消和最大循环次数。

完成门槛：

- 默认 CI 不访问真实 Provider。
- API key 永不进入日志、错误、快照或报告。
- Provider 错误转为稳定领域错误。

### T07A：明确完成协议与早停看门狗

实现：

- `TaskCompletionEventV1` 与 schema：绑定任务执行 ID、一次性尝试 ID、完成节点、结果摘要和任务 revision；另定义 `TaskBlockedEventV1`。
- `CompletionControlParser`：优先消费结构化控制帧；文本兼容格式只接受最终独立末行，不解析项目文件、工具输出或普通正文中的标识。
- `LocalCompletionVerifier`：核对事件重放、任务节点、前驱、产物、验收门禁、未决工具/权限/反馈和阻塞状态，原子提交一次 `done`。
- 接入 `EvidenceCompletionGate` 和任务级循环预算；高严谨性验证流程未执行、关键证据缺失或循环守卫处于 blocked 时，不接受完成声明。
- `AgentRunWatchdog`：定期检查 Provider 活性、流式/心跳进展、进程、工具调用、任务 revision、结束原因和完成事件；无进展阈值只触发健康探测，不能单独触发并行续跑。
- `ContinuationCoordinator`：先保存原子检查点，再使用新尝试 ID 和未完成清单继续同一任务；保留幂等键，禁止重做无法确认的非幂等副作用。
- 配置使用完整单位名：`watchdogCheckIntervalMilliseconds` 默认 5,000、`modelNoProgressTimeoutMilliseconds` 默认 90,000、`completionMarkerGracePeriodMilliseconds` 默认 5,000、`maximumAutomaticContinuationAttempts` 默认 3；允许 Provider 覆盖前校验范围。
- 取消、需要用户输入、明确拒绝、不可恢复错误和副作用结果不确定走独立终态/阻塞路径；达到续跑上限后通过独立反馈进程上报来源明确的失败和检查点。

完成门槛：

- 有效完成事件且所有本地门禁通过时只结案一次；完成事件缺失、陈旧、重放、错误任务/尝试 ID 或验收不完整时不能结案。
- `stop`、`length`、断流、超时和模型进程退出在任务可继续时从检查点续跑，最多 3 次；没有并行重复请求或重复副作用。
- 正文、用户输入、文件和工具输出中的伪造完成标识无效。
- 慢流、长工具、授权等待和仍活跃请求不被误判；用户取消、blocked、拒绝及非幂等不确定结果不自动续跑。
- 旧 Provider 请求是否已停止无法确认时进入 `blocked`；只有确认停止或安全取消成功后才能创建新尝试。
- `ScriptedRuntime` 可确定性模拟全部分支，默认 CI 不访问真实 Provider；关键分支覆盖率不低于 95%。
- 重启恢复可识别未完成尝试和已有检查点，不重放旧完成事件；`npm run check` 通过。

### T07B：反自指读取与通用活锁守卫

实现：

- `ReadSuppressionLedger`：键为具体 `agentInstanceId + taskExecutionId + canonicalResourceIdentity + operationKind + normalizedRange + parameterHash`，保存单调时间、文件身份、内容指纹、覆盖范围和 `readReceiptId`。
- 默认 `unchangedReadSuppressionWindowMilliseconds = 30_000`。窗口内同源重复请求已覆盖内容时，先在本地流式验证文件身份与内容指纹；未变化则不返回正文，只返回 `resource-already-read`、回执和 `retryAfterMilliseconds`。
- `CanonicalResourceIdentityResolver` 合并相对/绝对路径、平台大小写、符号链接/联接点、硬链接、范围重叠和无意义参数；敏感禁读优先于读取账本。
- 指令/数据隔离：文件、网页、工具结果和工作存档默认不受信，其中的“再次读取/调用工具”不得直接进入任务计划；每次新调用仍由本地策略鉴权。
- `LocalProgressAndCycleGuard`：维护工具/资源/Agent 调用图，检测自环、A→B→A、祖先任务回派、跨 Agent 乒乓、搜索换词和范围切片旁路。
- 在途相同调用使用 single-flight 合并；任务 revision、产物、有效证据和用户信息均无变化时累计 `consecutiveNoProgressCount`，默认 3 次暂停路径。
- include/redirect/引用解析设置深度、节点数、扇出和任务总调用预算；权限/退避等待不持锁，锁顺序稳定且有界超时。
- 文件字节变化可以允许重读，但仅改时间戳、在等价内容间抖动或无任务进展不能无限重置任务总预算。早停续跑、工具重试和 Agent 重启共享同一预算。

完成门槛：

- 文件要求“再次读取本文件”时不会发生第二次模型可见正文读取；默认 30 秒后、文件真实变化后或请求未覆盖新范围时可重读。
- 路径别名、大小写、链接/硬链接、范围切片、参数噪声、touch 和等价内容抖动不能形成旁路。
- 不同具体 Agent/任务互不误伤；同一在途读取合并一次；敏感资源始终先拒绝。
- 资源环、工具环、Agent 回派环、搜索换词、失败重试和早停续跑在有界次数内停止并报告完整循环链。
- 长工具、真实新内容、有效新证据和用户补充不会被误判；进程重启不能清零任务总预算。
- fake clock、属性测试、并发和集成测试覆盖；关键分支覆盖率不低于 95%，`npm run check` 通过。

### T08：三级 Agent 编排

主 Agent：

- 接收用户消息、维护模式和任务概要。
- 启动次级调度后立即回到输入循环。
- 从 task store 查询进度。
- 通过独立反馈进程给次级 Agent 发送调整或裁决。
- 发布新任务或重新调用下级前，可调用 archive context selector 选择并附加工作存档条目；不相关时不附加。

Assist 次级 Agent：

- 维护自己的待办任务偏序集；按 ready set 和优先级调度，并可把一条依赖链冻结成任务包派给三级 Agent。
- 拆解 DAG，分配最小工具集合，调度 Worker。
- 为写入型 Worker 创建独立 Git 分支/worktree；审查其提交、处理冲突、运行集成门禁并执行受控合并。
- 处理 success、failure、ambiguous 和 instruction。
- 无法裁决时向用户返回相关任务节点和反馈原文。

三级 Agent：

- 仅执行分配任务。
- 代码任务只能在分配的隔离分支/worktree 内提交；不得自行合并、变基、推送、删除分支或清理 worktree。
- 异常、模糊、完成均通过独立反馈进程上报。
- 持续把结构化工作摘要追加到自己的独立存档。
- 不得自主扩大任务或静默放弃。

Devolve：

- 主 Agent 始终只读并只转交任务；本地会话控制器创建次级 Agent，由次级 Agent 决定调度职责。多 Git 写入 Worker 场景由该次级 Agent 承担集成职责。
- 复用同一 task store、反馈进程、Worker 和工具策略边界。

完成门槛：

- Worker 挂起时主 TUI 仍能接收消息。
- 可同时查询进度和新建 mission。
- 用户可随时通过状态视图查看 Agent 待办偏序集、顺序解释和任务包进度，而不打断 busy Agent。
- 普通反馈不打断 busy Agent。
- 上级选中的存档附件在任务输入中可追踪，未选择时不会产生隐藏注入。
- 每个三级 Agent 的贡献在合并报告中可追溯；未经次级 Agent 审查的提交不能进入集成分支。
- 显式 cancel 可中断 Provider 或工具的挂起调用。

### T08A：默认控制流、个体记忆隔离与三级 Agent 生命周期

实现：

- `AgentIndividualMemoryStore` 与 `AgentMemoryNamespacePolicy`：主、次级、三级均以不可复用 `agentInstanceId` 独占记忆目录、工作存档、上下文预算、缓存、读取回执、循环预算和消息视图；拒绝角色级、同级或显示名共享路径。
- `CrossAgentContextAttachmentController`：Agent 不直接读取他人存档；控制器按明确条目、revision、来源、可见性、脱敏和 token 预算生成 `externalHistoricalContext` 不可变附件。附件仅在当前任务激活中有效，接收方持久化观察时必须保留原始来源与哈希。
- `ConversationTaskInsertionController`：接收主 Agent 的 `TaskInsertionProposal`，在本地验证用户/Agent 来源、目标次级 Agent、偏序集 revision、前驱/后继和优先层。原始用户指导可保持层级 0，主 Agent 派生节点只能层级 1 或以下。主 Agent 提交后立即返回对话循环。
- `SecondaryContinuousDispatchLoop`：任务、反馈、权限、资源或 Git 基线变化后重新计算 ready set，按偏序、优先级、稳定同级顺序和并发上限持续派发。
- `TertiaryAgentAssignmentPlanner`：基于个体存活/空闲状态、所属次级、任务/mission 连续性、权限、工具、worktree、未决调用和上下文/消息预算，给出带原因的 `reuse-existing | create-new` 决定。
- `TertiarySingleChainExecutionGuard`：三级一次激活只绑定一个不可变任务链；禁止领取链外任务、改写偏序集、调度 Agent、写集成/目标分支或使用 GitHub/远端项目控制工具。
- `TertiaryAgentLifecycleController`：支持任务成功、终止、无进展、上下文/消息超限、权限撤销、健康异常和会话关闭时的受控收口；依次停止派发、处理未确认调用、保存检查点/handoff、确认反馈、撤销权限、注销 mailbox、处理 Git 资源和关闭后台进程。
- `MainAgentReportArchiveIngestor` 与 `MainAgentReportReader`：次级任务终态报告只写独立报告索引，绝不唤醒主 Agent 或注入当前对话；后续用户轮次按任务引用与 token 预算只读选择。
- 远端项目适配器所有权：GitHub、远端 Git、PR、CI、发布和产物传输仅向次级 Agent暴露，并仍受其当前有效权限、执行前复检、用户裁决和自动备份约束。

完成门槛：

- 两个同级 Agent 即使使用相同显示名、任务 ID、模型和输入，记忆文件、上下文、缓存键、读取回执、循环预算、mailbox 视图均不相交；角色级共享路径和跨个体直接访问全部拒绝。
- 未选择的存档内容不会出现在接收 Agent 的 prompt、日志、缓存或长期记忆；附件不能覆盖当前任务/权限，且持久化引用保留来源、revision 和哈希。
- 后台连续产生大量成功/失败汇报时，主 Agent 仍能立即处理用户消息；当前模型上下文不变化，用户后续询问时只读取相关报告。
- 用户指导与主 Agent 派生设计插入同一偏序集时来源和优先层正确，成环、陈旧 revision、未知锚点和 Agent 冒充用户层级 0 均拒绝。
- 次级 Agent 可连续分发多个 ready 任务链，稳定遵守前驱、优先级和并发限制；每次复用/新建决定可解释并可重放。
- 三级 Agent 只能完成一个任务链并向发布源报告；链外领取、兄弟 Agent 消息/记忆访问、集成分支、GitHub/远端工具均被本地拒绝。
- 关闭的每个阶段支持崩溃恢复和幂等重试；上下文超限换新个体后只收到选定 handoff，不复用身份、权限租约、缓存或完整历史，不重复未确认副作用。
- GitHub/远端操作只有次级 Agent 可发起，deny/ask/allow、用户拒绝、权限撤销和执行前参数变化均正确生效。
- 单元、属性、并发、真实独立反馈进程、崩溃恢复和 TUI/Headless 集成测试通过；个体隔离、生命周期和报告入档关键分支覆盖率不低于 95%，`npm run check` 通过。本任务作为高风险任务单独提交和验收。

### T08B：工具说明回访、无产品数量配额与受权通信转交

实现：

- `ToolDocumentationReceiptStore`：按具体 Agent、工具组和 revision 保存首次/差异说明送达回执，使用个体记忆命名空间、原子 revision 与内容哈希；新 Agent 不继承，同级不共享。
- `InitialToolGroupDocumentationBuilder`：首次分配时只为当前已分配工具生成完整公开说明；不得包含未分配工具 schema、内部执行层、凭据或其他 Agent 的回执。
- `SubsequentToolGroupReminderBuilder`：相同 revision 后续只生成固定提醒和标准格式，不重复整组 schema。工具定义变化时生成可验证 delta；无法证明完整则重新生成该组完整说明。
- `ToolHelpRequestSchema`：校验 `ASTARRAY_TOOL_HELP_REQUEST_V1` 的 usage-help/missing-capability、任务、工具、能力意图、阻塞原因和已知 revision；Agent 身份、层级、直属上级、mission、真实 revision 与来源由 harness 注入。
- `ToolDocumentationRecallController`：已分配工具按单工具返回 `ASTARRAY_TOOL_HELP_RESPONSE_V1`；未分配/权限不足返回 `known-but-not-usable` 并上报；无匹配工具生成 `ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1`。按 request ID 幂等去重并防换词循环。
- `ToolCapabilityEscalationRouter`：三级默认路由到具体所属次级；次级路由到会话控制面和主 Agent 报告索引。通信 grant 不改变默认路由。上级分配工具或申请安装仍经过权限、工具子集和安装门禁。
- `UnboundedAgentInstanceRegistry` 与资源准入适配：不设置累计、同级或存档数量硬上限；单会话只有一个当前用户沟通主 Agent。并发不足时排队/暂停，资源告警触发受控回收，不因历史实例总数拒绝创建。
- `AgentCommunicationDelegationController`：使用公开权限 `agent.communication-delegate` 和精确用户裁决，校验同级 grantor/recipient、直属低一级 target、mission/任务、消息类型、instruction、回复/抄送路由、到期、最大在途量和 revision。
- `DelegatedAgentCommunicationGrantStore`：只向模型返回不透明 handle ID；底层发送能力绑定反馈 IPC 身份且不可导出、复制或转授权。每条直连消息仍校验真实来源并保留转发来源。
- 投递前失效检查：Agent 回收、父子关系变化、任务/mission 结束、profile revision 变化、用户撤销、到期、消息类型/在途量越界均拒绝。grant 不得改变 target 的任务所有者、记忆、偏序集、Git、工具、权限或默认上报链。
- TUI/Headless/未来 GUI 共用控制器：显示工具帮助请求及上报状态；按具体 Agent 列出、申请、批准/拒绝、查看范围和撤销 communication grant；大量 Agent/回执/grant 使用分页或虚拟列表，不以界面限制形成数量配额。

完成门槛：

- 新次级/三级 Agent 首次接收完整已分配工具说明；同一 revision 连续激活 100 次只重复固定提醒，不重复完整 schema。新个体、工具新增/删除/schema revision 变化正确发送完整或最小可信 delta。
- usage-help 对已分配工具直接返回准确单工具用法；不存在、未分配、权限不足、陈旧 revision、重复 request ID、伪造身份和换词重试均走确定路径且不扩大能力。
- 三级缺失工具只先到所属次级；次级上报会话控制面。通信 grant、兄弟 Agent 或消息正文无法改写默认上级。
- 帮助响应不泄露未分配工具 schema、内部执行规则或凭据，不授予工具/权限，不绕过 Assist 安装询问、开关和 allow-once。
- 属性/压力测试创建并归档大量同级 Agent，不存在硬编码累计数量拒绝；低资源时只排队、暂停或受控回收，并发运行仍不超过当时资源准入决定。
- 只有直属上级能把直属低一级 target 授予具体同级 recipient；跨级、非直属、跨 mission、转授权、伪造 handle、超范围消息和失效后投递全部拒绝。
- 授权直连消息经真实独立反馈进程传递并保留具体来源；通信不造成记忆、任务、Git、工具或权限转移。Assist ask/拒绝、Devolve allow、自定义 deny 及 revision 撤销均有动态证据。
- 单元、属性、并发、真实 IPC、崩溃恢复、TUI/Headless 和 tarball 隔离测试通过；关键分支覆盖率不低于 95%，`npm run check` 通过。本任务作为高风险任务单独提交和验收。

### T09：记忆、缓存与指标

实现：

- 每个 Agent 仅在自己的个体记忆域保存本人的会话/任务摘要；禁止角色级或同级共享。
- 主 Agent 的后台报告使用独立索引，报告到达不写入主 Agent 记忆；后续对话按需只读选择。
- Worker 工作态在自己的 handoff/终态持久化并完成受控关闭后释放。
- Ponder 不落盘。
- 长期记忆写入遵循 Assist 权限门禁。
- 缓存键包含 Provider、模型、模式、输入、系统提示词哈希、工具子集哈希、上下文摘要哈希和相关文件指纹。
- 写操作、时间敏感调用和失败默认 bypass。
- 指标包含调用数、token、缓存状态、峰值并发和消息延迟。

完成门槛：

- 指标区分 `hit/miss/bypass/stale_reject`。
- Provider 未提供 token 时，估算值标记为 `estimated`。
- v0.1 不以模糊语义相似度复用缓存。

### T10：TUI

实现组件：

- Header/status bar。
- Conversation/Event panel。
- Task DAG panel。
- Agent/Mailbox panel。
- 输入编辑器、模式选择器、权限弹窗、帮助和恢复页面。
- 非 TTY renderer。

性能约束：

- 流式 token 以约 30–50ms 批量刷新，不逐 token 重渲染整屏。
- 可见日志使用有界窗口，完整日志进入 journal。
- 小终端自动折叠次要面板。
- React render 中不得执行副作用。
- 每条反馈在 TUI 中显示来源类型和安全的来源标识；不得只显示正文。

### T11：Headless CLI

实现并测试：

```powershell
astarray run "demo" --runtime mock --json
astarray status M-001 --json
astarray resume M-001 --json
astarray cancel M-001 --json
astarray doctor --json
```

完成门槛：

- stdout 只有结果，日志和警告写 stderr。
- exit code 稳定并形成文档。
- JSON 输出通过 schema 测试。

### T12：恢复、安全与异常加固

覆盖：

- Provider 超时和工具异常。
- Ctrl+C 和意外退出。
- task chain 或 mailbox journal 损坏。
- 投递后、ack 前崩溃。
- 反馈独立进程崩溃、孤儿进程和协议错误。
- 终端 resize、不可写工作区和磁盘满。
- 路径穿越、符号链接逃逸、ANSI/OSC 注入。
- secret 泄漏和无限 tool loop。

### T13：npm 打包和隔离安装

执行：

```powershell
npm run check
npm run build
npm pack --dry-run --json
npm pack
```

在仓库内 `.tmp/package-smoke/` 安装生成的 tarball，并验证：

```powershell
npm install <生成的-tarball>
npx astarray --version
npx astarray --help
npx astarray doctor --json
npx astarray run "smoke" --runtime mock --json
```

还需使用仓库内隔离 prefix 模拟全局安装，验证 Unix executable 和 Windows `.cmd` shim。

完成门槛：

- tarball 不包含 `.env`、API key、测试日志或 `.astarray` 运行数据。
- 安装后不依赖源码目录。
- shebang 无 BOM。
- 安装生命周期不联网，也不写用户目录。
- 反馈进程入口文件包含在 tarball 中，安装后的 CLI 能成功启动和关闭它。

### T14：文档与最终报告

README 包含：

- 安装和快速开始。
- 三种模式和权限模型。
- Provider 配置。
- 状态目录和恢复。
- Headless 用法。
- 独立反馈进程的生命周期和排错。
- 跨平台差异、安全边界、数据清理和当前限制。

生成 `DELIVERY_REPORT.md`，必须记录：

- 完成和未完成任务。
- 实际运行的验证命令及结果。
- 覆盖率。
- tarball 文件名。
- 隔离安装结果。
- 已知风险。

不得用“应该可以”代替实际运行证据。

---

## 7. 任务依赖关系

```text
T00 → T01 → T02
T02 → T03、T04、T06、T07
T03 + T04 → T05
T03 + T05 → T05A
T05 + T05A → T05B
T03 + T05A → T05C
T06 → T06A
T02 + T06 → T06B
T06B → T06C
T06C + T07B → T06D
T05 + T06D + T07 + T07B → T07A
T05 + T06C + T07 → T07B
T05B + T05C + T06 + T06A + T06B + T06C + T06D + T07 + T07A + T07B → T08
T08 → T09、T10、T11
T08 + T05A + T05C + T06G → T08A
T08A + T06F → T08B
T08A + T08B + T05B + T05C + T06G + T10 + T11 → T08C
T09 + T10 + T11 → T06E
T06E → T06F
T06F → T06G
T08C + T09 + T10 + T11 → T08D
T07 + T08D + T09 + T10 + T11 → T07C
T06G + T08C + T08D + T07C → T12
T12 → T13 → T14
```

`T03`、`T04`、`T06`、`T07` 可以并行，但不得由多个执行单元同时修改同一公共类型文件。公共类型变更统一由负责 T02 的执行单元完成。新增安全任务顺序为 T06B → T06C → T07B → T06D → T07A；界面与 CLI 可用后依次单独执行 T06E、T06F、T06G，再分别单独执行 T08A、T08B、T08C、T08D、T07C。T06B–T06G、T07A、T07B、T08A、T08B、T08C、T08D、T07C 均为高风险边界，不能相互并批。并行 Git 写入必须由次级 Agent 按 T05B 分配独立 worktree，并在集成分支集中审查合并。

---

## 8. OpenCode 每次执行多少任务

### 8.1 推荐批次

不要要求 OpenCode 在一个未经检查的超长回合里完成 T00–T14。推荐按以下批次执行：

| 批次 | 任务 | 目的 |
|---|---|---|
| Batch 1 | T00–T01 | 冻结契约并建立可构建骨架 |
| Batch 2 | T02–T03 | 完成状态机、权限和任务持久化 |
| Batch 3 | T04 | 单独完成高风险的独立反馈进程 |
| Batch 4A | T05、T05A | 完成 DAG、Agent 工作存档和选择性附加 |
| Batch 4B | T06–T07 | 完成工具边界和 Runtime |
| Batch 4C | T06A | 单独完成高风险的工具内备份事务层 |
| Batch 4D | T05B | 单独完成次级 Agent Git 分流、审查与合并控制器 |
| Batch 4E | T05C | 单独完成 Agent 待办偏序集、任务包和状态工具 |
| Batch 4F | T06B | 单独完成 Ponder 本地只读边界与敏感操作分类 |
| Batch 4G | T06C | 单独完成全模式敏感内容禁读 |
| Batch 4H | T07B | 单独完成反自指读取与通用活锁守卫 |
| Batch 4I | T06D | 单独完成高严谨性事实验证与证据包 |
| Batch 4J | T07A | 单独完成完成协议、早停检测和有界续跑 |
| Batch 5 | T08 | 单独集成三级编排 |
| Batch 6 | T09–T11 | 指标、TUI、Headless CLI；可分支并行 |
| Batch 6A | T06E | 单独完成 Assist 安装前置询问、设置开关与逐次授权 |
| Batch 6B | T06F | 单独完成可配置权限目录、内置权限组和无限命名自定义模式 |
| Batch 6C | T06G | 单独完成主 Agent 永久只读、次级权限上限、会话临时提升与关闭导出 |
| Batch 6D | T08A | 单独完成默认控制流、Agent 个体记忆/上下文隔离、持续调度、三级生命周期和报告入档 |
| Batch 6E | T08B | 单独完成工具说明回访、Agent 无产品数量配额和受权通信句柄转交 |
| Batch 6F | T08C | 单独完成主对话独占下的小任务次级直投、项目侦察、测试/验收任命和四级委派 |
| Batch 6G | T08D | 单独完成“工匠”三级 Agent、阶段触发、渐进披露和工作流定制 |
| Batch 6H | T07C | 单独完成独立模型/Provider 策略、用途允许列表和任务类型 Agent 预设 |
| Batch 7 | T12 | 集中做故障注入、安全和恢复 |
| Batch 8 | T13–T14 | 打包、隔离安装、文档和交付报告 |

### 8.2 一次任务量规则

- 默认每次让 OpenCode完成 **1–2 个高度相关的原子任务**。
- 只有依赖明确、文件改动不重叠时，单次最多并行 3 个任务。
- `T04`、`T05B`、`T05C`、`T06A`、`T06B`、`T06C`、`T06D`、`T06E`、`T06F`、`T06G`、`T07A`、`T07B`、`T07C`、`T08`、`T08A`、`T08B`、`T08C`、`T08D`、`T12` 风险较高，每次只执行一个。
- 每批建议控制在约 5–15 个生产文件、同等数量级测试文件以内。
- 若预计一次修改超过约 1,000 行生产代码，应继续拆分为接口、实现、集成三个检查点。
- 同一批必须完成代码、测试、文档和状态记录，不能只写实现后把测试留到最后。

### 8.3 每批结束检查点

每批结束必须：

1. 运行本批最小测试集。
2. 运行 `npm run typecheck` 和 `npm run lint`。
3. 检查 `git diff`，确认没有无关修改和敏感信息。
4. 若有多个三级 Agent 贡献，检查次级 Agent 的 Git 集成报告、提交来源、分支边界和合并门禁证据。
5. 检查变量、函数、时间单位命名。
6. 更新 `PLAN_STATUS.md`。
7. 记录实际命令、退出码、失败原因和遗留风险。
8. 当前批未通过时，不开始依赖它的下一批。

每完成 2 个普通批次，或者完成任一高风险任务后，再运行一次完整 `npm run check`。

### 8.4 中断与恢复

- OpenCode 每开始一个任务，先在 `PLAN_STATUS.md` 标记 `in_progress`。
- 完成全部验收条件后才标记 `done`。
- 会话意外结束后，下次从第一个 `in_progress` 或依赖已满足的 `pending` 任务恢复。
- 恢复时先查看已有 diff 和测试，不得重建或覆盖用户已有成果。
- 同一失败若连续发生 3 次，停止机械重试，记录根因、已尝试方法和最小复现。
- OpenCode/模型只有返回有效完成控制事件且本地门禁通过，任务才能标记 `done`；仅结束输出、自然语言声称完成或 Provider 返回 `stop` 都不构成完成。
- 运行时自动续跑与开发批次恢复都从持久化检查点继续；任何写入结果不确定时先阻塞裁决，不能通过“继续任务”重复执行。

---

## 9. 详细测试方案

### 9.1 单元测试

| 模块 | 必测内容 |
|---|---|
| ModeMachine | 合法/非法迁移、降级后重新鉴权 |
| PermissionPolicy | 三模式矩阵、临时授权过期、修改参数、越权工具 |
| TaskGraph | 环、缺失依赖、并发、失败传播、重复领取 |
| MailboxJournal | 优先级、FIFO、ack、重放、去重、部分写入 |
| FeedbackSource | 用户/Agent/系统来源、具体 Agent 个体、层级、缺失来源、伪造来源、转发不变性 |
| AgentWorkArchive | 个体隔离、原子追加、revision、所有权、内容清洗、损坏恢复 |
| ToolDocumentationRecall | 首次完整说明、后续提醒、delta revision、usage/missing schema、幂等响应、逐级路由 |
| DelegatedAgentCommunication | 同级/直属关系、精确授权、不透明 handle、来源、范围、撤销、到期、不可转授权 |
| ArchiveContextSelector | 默认不附加、条目选择、不可变快照、token 预算、冲突优先级 |
| AgentTaskSequence | 偏序插入、环检测、ready set、用户层级 0、自动任务不得提权、稳定同级顺序、任务包、查询快照、项目存储隔离 |
| DestructiveMutationGuard | 变更分类、pre-image、fail-closed、TOCTOU、恢复前备份、自动创建与受控读取隔离 |
| BackupVaultTool | list/read/restore 权限、逻辑 ID、内容脱敏、恢复前备份 |
| BackupDeletionController | 三模式矩阵、暂停/恢复、逐次授权、quarantine、无锁等待、审计优先级 |
| PrimeBackoff | 质数序列、10,800 秒封顶、新消息重置 |
| FeedbackSupervisor | 启动、健康检查、崩溃重启、优雅关闭、孤儿清理 |
| FailureCounter | 连续失败阈值、成功清零、不同工具分别计数 |
| AtomicTaskStore | revision、并发写、临时文件、损坏恢复 |
| Cache | key 隔离、文件失效、写操作 bypass |
| Redaction | API key、Authorization 和用户 secret |
| Metrics | token、调用数、并发峰值、估算标记 |

目标：

- 全项目行和分支覆盖率不低于 85%。
- 状态机、权限、DAG、反馈进程协议、信箱和退避分支覆盖率不低于 95%。
- 覆盖率不能代替关键不变量测试。

### 9.2 属性测试

使用 `fast-check` 或同类库验证：

- 合法 DAG 中任务永不早于依赖完成。
- 运行中任务数量永不超过配置并发。
- 任意消息序列经 enqueue/deliver/ack 后不丢失、不重复确认。
- 任意合法消息经持久化、重启、重放和转发后，其原始来源保持不变。
- 任意两个不同 `agentInstanceId` 的工作存档不会互相覆盖或混入条目。
- 任意工具说明回执只属于一个具体 `agentInstanceId`；同 revision 后续 prompt 不再包含完整工具组，revision 变化不会漏发必要差异。
- 任意通信 grant 只允许授权的 grantor/recipient/target 三元组和消息范围，不能扩大任务、记忆、工具、Git 或权限。
- 任意累计 Agent 实例数量不会触发产品配额拒绝；并发资源约束只影响运行队列和生命周期状态。
- Agent 待办偏序集与项目任务/产出存储相互独立；任务发布者可指定合法插入位置并获得可解释状态。
- 用户任务默认最高优先层，Agent/system/工具自动任务无法进入最高层。
- 任意存档附件只包含显式选中的条目，且其内容哈希对应指定 revision。
- 任意破坏性工具调用在目标变化前都存在完整 pre-image；备份失败时目标保持不变。
- 自动备份不会把备份内容、路径、对象哈希或恢复凭据注入模型；只有显式授权的 `backupVault.read` 可返回业务内容。
- 任意模式和工具组合得到唯一权限结果。
- task store revision 单调递增。
- 任一缓存关键输入变化都会改变相应 key 分量。
- 退避值不递减且永不超过 10,800 秒；重置后重新从 2 秒开始。

### 9.3 组件测试

测试：

- 80×24、120×40 和低于最小尺寸。
- DAG 更新、流式内容和 Agent 状态变化。
- 权限弹窗的允许一次、会话允许、拒绝和修改参数。
- 模式切换、帮助、无颜色、中英文和超长内容。
- resize 后输入与焦点不丢失。

快照测试必须固定时间、时区、终端宽高和随机 ID，并规范化 ANSI。

### 9.4 集成测试

核心场景：

1. Assist 成功路径：两个任务并发、第三个等待依赖、受限写入经修改参数后允许。
2. 连续失败：同一工具三次失败后上报，调度者调整后成功继续。
3. 非阻塞通信：Worker 挂起时主 Agent 仍可查询状态和创建新任务。
4. 独立反馈进程：主进程和反馈进程 PID 不同；杀死反馈进程后自动恢复。
5. 投递恢复：消息投递后、ack 前杀死反馈进程，重启后可幂等重投。
6. 主进程退出：反馈进程在规定宽限期内关闭，不遗留孤儿进程。
7. 崩溃恢复：task chain 更新中断、下游调度前退出、权限等待期间退出。
8. 来源追踪：用户裁决经主 Agent 转发后仍标记为用户；三级 Agent 失败明确显示该 Agent 标识和层级。
9. 存档选择：新任务默认不带历史；上级选择指定条目后下级只收到这些条目，并能看到存档来源与 revision。
10. 重新调用：同一 Agent 重新启动时可选用旧存档；未选择或超预算时不会隐式注入。
11. 删除/覆盖：分别对文件删除、文字删除、替换、截断和覆盖做备份后变更及恢复验证。
12. 备份故障：注入磁盘满、权限失败、manifest 失败和并发目标变化，断言原操作未执行。
13. 自动备份隔离：捕获 provider 输入、工具输出、反馈 journal 和 TUI 状态，断言自动创建过程不存在备份材料或恢复能力；显式 read 仅返回请求内容。
14. 协同模式删除：警告内容完整，Agent 状态暂停，拒绝/超时不删除，精确单次授权后继续，授权不能复用。
15. 放权模式删除：无交互提示，操作完成且生成不可删除的 HIGH 审计记录。
16. 死锁测试：授权等待期间其他只读操作可运行；两个删除者争用同一备份能完成或稳定失败；重启可恢复 quarantine 状态。
17. 工具说明回访：新次级/三级首次收到完整工具组，同 revision 后续只收提醒；忘记用法直接回复单工具说明，缺失能力按三级→所属次级→会话控制面的路径上报。
18. Agent 数量压力：创建/排队/归档大量各层个体，验证无累计/同级配额分支，资源不足时状态可解释且不超过实时准入并发。
19. 通信转交：次级 A 经授权把直属三级 X 的 handle 给次级 B，B 与 X 经真实反馈进程交流并保留来源；越权、转授、撤销和到期路径拒绝。

非幂等副作用如果无法确认是否成功，恢复后必须进入 `blocked`，不得盲目重试。

### 9.5 PTY 端到端测试

使用伪终端测试：

- 启动 TUI、输入任务、切换模式。
- 打开/关闭帮助和权限弹窗。
- resize。
- Ctrl+C 取消，随后退出。
- 退出后终端光标和 raw mode 恢复。
- 安装后的 CLI 能启动反馈子进程，退出后无残留进程。

CI 至少覆盖：

```text
Windows + Node 20/当前 LTS
Ubuntu  + Node 20/当前 LTS
macOS   + 当前 LTS
```

### 9.6 安全测试

验证：

- `../../outside` 和符号链接逃逸被拒绝。
- ANSI/OSC 控制序列被清洗。
- API key 不出现在日志、错误、快照和交付报告。
- Assist 无法通过包装命令绕过工具分类。
- Devolve 不能调用未注册工具。
- 任何破坏性工具无自动备份时不能注册或执行；通用 shell 不能绕过备份层。
- Agent 不能绕过受控工具直接读取、删除或覆盖备份库；备份工具依模式和 action 鉴权。
- Ponder 不产生状态文件。
- 自动流程不执行 `npm publish`、`git push` 或破坏性命令。

---

## 10. OpenCode 执行规则

OpenCode 开始编码前必须读取：

- `agent-main-architecture.md`
- `designtodo.txt`
- `IMPLEMENTATION_PLAN.md`
- `PLAN_STATUS.md`（存在时）
- `AGENTS.md`（存在时）

每轮遵循：

1. 选择依赖已满足的最小任务批次。
2. 先补全或确认接口和验收测试，再实现。
3. 只修改当前任务涉及的文件。
4. 新增生产逻辑必须同时新增测试。
5. 失败时修复根因，不删除测试、不降低断言、不用 skip 隐藏问题。
6. 不使用含义不清的缩写变量。
7. 不把全部任务挤进单次超长变更。
8. 不在未经验证时标记完成。
9. 打包验收必须针对 tarball，而不是源码入口。
10. 发布保留给人工确认。

推荐给 OpenCode 的首轮指令：

```text
读取 @agent-main-architecture.md、@designtodo.txt 和
@IMPLEMENTATION_PLAN.md。仅执行 Batch 1（T00–T01）。
严格遵循变量命名规范，同时完成实现、测试、文档和
PLAN_STATUS.md。运行该批全部验收命令；未通过时不要开始 Batch 2。
```

后续指令示例：

```text
读取 @IMPLEMENTATION_PLAN.md 和 @PLAN_STATUS.md。
检查上一批的实际测试证据，然后仅执行下一个未完成批次。
高风险任务 T04、T05B、T05C、T06A、T06B、T06C、T06D、T06E、T06F、T06G、T07A、T07B、T07C、T08、T08A、T08B、T08C、T08D、T12 必须单独完成和验收。
```

---

## 11. 关键注意事项

- 反馈工具已确定为独立进程，不能退化为主进程中的定时器或协程。
- 进程间消息必须包含协议版本、消息 ID、接收者、优先级、创建时间和幂等键。
- 进程间消息必须包含不可变的结构化原始来源；缺失或非法来源不得入池，转发不得覆盖来源。
- Agent 来源必须明确到具体 `agentInstanceId`；“某次级 Agent”或角色名不能作为来源。
- 主、次级、三级每个具体 Agent 各自维护独立记忆与工作存档；跨 Agent 使用必须由本地控制器显式选择条目并记录 provenance，默认不得全量注入。
- 工具组完整说明只在具体 Agent 首次接收或可信 revision 变化时发送；后续使用固定帮助请求格式。工具说明和通信句柄都不能被当成工具授权或权限转移。
- Agent 累计/同级数量不设产品配额；默认并发只是资源调度值，资源不足应排队、暂停或受控回收。
- 涉及 Git 写入的多 Agent 任务由次级 Agent 统一分配隔离分支/worktree、审查三级 Agent 提交、运行集成门禁并执行合并；三级 Agent 禁止自行合并、变基、推送或删除分支。
- Agent 待办任务序列是记忆存档域中的偏序集，与项目任务和产出追踪分离；用户任务默认层级 0，Agent/system/工具生成任务只能层级 1 或以下。
- Git 历史不是自动备份；reset、clean、checkout 覆盖、rebase、强制移动引用和删除分支/worktree 等破坏性操作必须先由底层工具创建受保护恢复点。
- 所有删除、文字删减和覆盖类操作由工具自身在修改前自动备份；备份数据与恢复能力绝不经过模型端。
- 不要依赖进程退出时一定能执行清理逻辑；journal 和 ack 设计必须能恢复。
- 3 小时是单轮退避上限，不是 TTL，也不能作为丢弃消息的理由。
- 不要为了生成质数无限保留数组；使用有界、可测试的生成策略，达到上限后直接保持上限。
- UI 与编排逻辑必须隔离，否则 headless 和故障测试会变得脆弱。
- 权限在工具实际执行前检查，不能只在任务派发时检查。
- 思索模式只开放本地只读项目查看/检索/状态工具；敏感操作判断和非授权工具禁用由本地策略与 OS 边界完成，不依赖云端或 AI。
- `.env`、私钥和凭据内容对所有模式、工具和证据通道都不可读；Devolve、授权和“验证需要”均不构成例外。
- 高严谨性由本地规则标记并强制调用事实验证工具；证据按搜索、实验、推理分层，只供用户判断，不允许工具自动声明最终合格。
- 同源短时间重复读取未变化资源返回读取回执而非正文；自指、工具/资源环、Agent 乒乓和无进展重试必须由本地循环守卫有界暂停。
- 模型结束输出不等于任务完成；必须有明确完成控制事件和本地验收。早停续跑先保存检查点、使用新尝试 ID、最多 3 次，且不得重复不确定的非幂等副作用。
- 非幂等操作必须携带幂等键或在不确定状态下请求人工裁决。
- 流式输出需要节流，避免高 CPU 和终端闪烁。
- npm 包运行时不得向安装目录写入状态。
- Windows 重点验证路径、原子替换、信号、`.cmd` shim、ConPTY 和子进程清理。
- 所有时间变量写明单位；所有日志字段采用稳定、可搜索的完整名称。
- 交付完成以 tarball 隔离安装成功为准，不以开发目录中运行成功为准。

---

## 12. 2026-08-16 新增高风险任务

### T08C：主对话独占、次级执行直投与四级 Agent

实现范围：

1. 保持主 Agent 为唯一连续用户对话对象；实现“小型、明确、无需方案讨论”任务的本地资格判断、用户确认和具体次级 `agentInstanceId` 直投。直投只绕过主 Agent 模型重复规划，不创建用户—次级聊天。
2. 次级 Agent 默认生成 `SECONDARY_USER_FACING_SUMMARY_V1`，把大量三级/四级报告压缩为目标、进度、结果、风险、用户裁决和证据引用；主 Agent 按需读取并面向用户解释。
3. 增加绑定具体任务/revision 的细节查询：主 Agent 查询负责次级 Agent，次级返回针对性摘要；不得把项目全文或下级完整上下文注入主 Agent。
4. 增加只读 `project-reconnaissance` 三级用途与 `PROJECT_CONTEXT_DIGEST_V1`；项目指纹变化时只做增量复查，原始读取和长输出保留在侦察 Agent 个体存档。
5. 次级为代码任务分别任命实现、测试、验收三级 Agent，阻止作者自验；高风险任务要求三个不同 `agentInstanceId`。次级基于不可变提交、测试、验收和人工门禁输出返修、待人工或合并裁决。
6. 扩展层级为主/次级/三级/四级。三级只能把自己任务链中的严格子链交给四级，四级不能创建第五级。四级拥有独立记忆域、mailbox、存档、读取回执和 worktree。
7. 权限、工具和任务范围逐层求交；四级工具帮助默认逐级反馈至所属三级。三级只能把直属四级贡献整合进自己的三级任务分支，项目级合并仍由次级完成。
8. TUI、Headless CLI 和 GUI 共用路由/状态控制器，明确显示当前对话对象始终为主 Agent，同时显示直投目标、四层 Agent 树、摘要、侦察、测试/验收和合并状态。

验收要求：

- 资格边界、用户来源 priority tier 0、次级派生 tier 1+、歧义回退主 Agent、授权门禁不可绕过均有单元和属性测试。
- 真实独立反馈进程验证摘要、细节查询、原始来源和路由链；主 Agent 不被后台报告自动唤醒。
- 大仓库夹具证明次级和主 Agent prompt 不包含项目全文；摘要 stale、增量刷新、反自指和敏感文件禁读有效。
- 实现/测试/验收个体隔离、作者自验反例、人工体验阻塞和旧提交验收失效均有测试。
- 四级并发、崩溃、接手、权限求交、工具帮助、第五级拒绝和 Git worktree 边界均有故障/集成测试。
- 关键路由、权限、生命周期和 Git 分支覆盖率不低于 95%；完成后运行 `npm run check`。

### T08D：“工匠”三级 Agent 阶段预设

实现范围：

1. 增加休眠的 `tertiary-preset:craftsman-v1`。会话开始时不得实例化或向次级 Agent注入完整说明；本地阶段规则命中后才经独立反馈进程向具体次级 Agent披露为可选下级。
2. 实现活跃会话时长、已验收任务链、版本化项目里程碑、项目记忆索引规模和重复工作流指纹五类本地确定性信号；不得由模型判定项目是否到达阶段。
3. 提供较早、均衡、保守三个建议模板，允许用户创建不设数量上限的自定义 `CraftsmanStageTriggerProfile`，配置 `any/all`、阈值、目标次级、冷却、提醒次数和披露动作。
4. 支持 `suggest-only`、`suggest-with-prompt`、`auto-enqueue-proposal`。自动提示词节点是本地策略来源，只能使用优先级层级 1 或以下，不能抢占用户任务或构成权限/安装/合并/验收授权。
5. 工匠只组合和深度定制所属次级已能分发的现有基础工具，生成 `CRAFTSMAN_WORKFLOW_BUNDLE_V1`；需要新依赖时只能上报、阻塞或提供现有工具降级方案。
6. 工匠使用具体三级 `agentInstanceId` 和独立记忆/worktree，不能自验；产物由不同测试/验收 Agent验证，并由次级执行项目级合并。
7. TUI、Headless CLI 和 GUI提供阶段模板、自定义信号、提示词、披露动作、当前状态、手动披露和通知审计。

验收要求：

- 初始 prompt/工具说明/可选下级列表不存在工匠完整说明，阶段命中前不存在工匠实例或隐式授权。
- 五类信号、三个模板、自定义 `any/all`、冷却、禁用、并发去重、journal 恢复和 profile revision 均有确定性测试。
- 记忆规模只读公开索引元数据；敏感文件、备份和其他 Agent私有记忆不被读取或计数。
- 自动提示节点保持层级 1+；用户层级 0 始终优先，所有工具在执行前继续鉴权。
- 至少一个真实夹具证明定制工作流减少重复规划步骤或工具调用；自然语言声称不算证据。
- 关键阶段、披露、权限、隔离和持久化分支覆盖率不低于 95%；完成后运行 `npm run check` 和 tarball 隔离安装。

### T07C：Agent 独立模型/Provider 策略与任务类型预设

实现范围：

1. 实现版本化 `ModelProviderCatalog`、公开稳定 ID、能力元数据和受保护凭据引用。公开 DTO、日志、反馈和导出不得含凭据或内部 endpoint secret。
2. 每个具体 Agent 使用独立 `AgentModelAssignment`。用户可按会话、层级、用途、任务类型和具体 Agent 设置任意长度允许列表，并选择固定、顺序 fallback、列表内自动选择或逐次手选。
3. 实现 `TaskAgentPreset`，覆盖办公文档、前端、编码、debug、测试、验收、侦察、绘图/视觉、工匠工作流定制和用户自定义类型；预设数量不设产品硬上限。
4. 按“任务显式设置 → Agent 会话覆盖 → 任务预设 → 用途列表 → 层级默认 → 会话默认”解析，并始终受全局禁用、能力、权限、数据出境、成本和并发边界约束。
5. 模型/Provider 切换只在无未决工具和未确认副作用的检查点发生，生成 `AGENT_MODEL_SWITCH_V1`；不得改变身份、记忆域、任务所有权、工具、权限或 Git 职责。
6. 故障切换有界、可审计且防活锁；允许列表耗尽时 fail-closed，不得静默使用列表外模型。
7. TUI、Headless CLI 和 GUI 共用认证设置控制器，以搜索、分页或虚拟列表承载任意规模的目录、用途列表、预设和有效策略说明。

验收要求：

- 使用 fake providers 覆盖固定、fallback、自动、手选、能力不匹配、限流、超时、目录 revision、列表耗尽和跨 Provider 数据策略。
- 并发测试证明不同 Agent 的模型分配互不污染；切换不重复未确认的工具调用或副作用。
- 办公、前端、编码、debug、测试、验收、侦察、工匠工作流定制和绘图预设均有动态测试；工匠模型预设不能使其提前披露，任何预设都不能扩大工具/权限或绕过 Assist 安装门禁。
- 凭据、完整 prompt、内部健康探针和授权能力不出现在日志、反馈、导出或快照。
- 三个界面入口行为一致；关键策略和切换分支覆盖率不低于 95%；完成后运行 `npm run check` 和 tarball 隔离安装。

### 执行约束

- `T08C`、`T08D` 和 `T07C` 必须分别单批执行；顺序为 `T08C → T08D → T07C`。
- 每轮只领取当前任务卡中的 1 个可独立验收检查点；普通检查点建议 5–15 个生产文件，预计超过约 1,000 行生产代码时继续拆分。
- 任一等待/退避量 `pn` 的单次上限为 3 小时；连续三次同因失败后停止机械重试并记录证据。
- 生产变量和函数使用完整可读名称；布尔值使用 `is/has/can/should` 前缀，时间量显式携带单位。
- 每个检查点必须同时提交实现、测试、文档和 `PLAN_STATUS.md` 证据；前一检查点未通过不得领取依赖节点。
