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
- 支持 `Ponder（思索模式）`、`Assist（协同模式）`、`Devolve（放权模式）` 三种运行模式。
- 支持主 Agent、次级调度 Agent、三级执行 Agent。
- 主 Agent 派发任务后立即恢复接收用户输入。
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
| Agent 工作存档 | 每个次级、三级 Agent 个体使用独立存档文件；上级发布任务或重新调用前可选择具体条目附加，默认不自动注入 |
| Agent 待办任务序列 | 每个调度 Agent 在自己的记忆存档域维护独立的带优先级偏序集；发布者可指定前驱/后继插入位置；用户任务默认层级 0，Agent/工具任务只能层级 1 或以下 |
| Git 分流与集成 | 涉及仓库写入的多 Agent 任务由次级 Agent 统一创建隔离分支/worktree、审查三级 Agent 提交、运行门禁并执行受控合并；三级 Agent 不得自行合并、变基、推送或删除分支 |
| 破坏性变更备份 | 删除资源、删除内容、替换、截断和覆盖必须由执行工具自身先自动备份；自动创建过程不经过模型，后续读取/恢复只经受控工具 |
| 备份工具 | `backupVault` 提供 list/read/restore；`deleteBackup` 是独立特权入口和 pre-image 规则的唯一递归例外 |
| 删除备份模式策略 | 思索模式禁止；协同模式警告用户并强制暂停 Agent，逐次授权；放权模式无提示但写 HIGH 查阅优先级审计日志 |
| 任务链格式 | 版本化 JSON，位于 `.astarray/missions/<missionId>/task-chain.json` |
| 消息顺序 | 跨类型按优先级，同优先级严格 FIFO：`instruction > backup-deletion-warning > failure > permission-ask > ambiguous > success` |
| 越权工具 | harness 硬拒绝、记录审计事件，并向调度 Agent 上报 failure |
| Assist 会话授权 | 默认 10 分钟或会话结束，以先到者为准 |
| 默认并发量 | 4，可配置范围为 1–32 |
| Devolve 权限 | 免应用层逐次询问，但仍受工具注册表、工作区边界和操作系统权限约束 |
| Ponder 持久化 | 不写任务、记忆或遥测文件；仅使用会话内存 |
| 模式降级 | 已开始的原子调用可正常结束；所有后续调用按新模式重新鉴权 |
| 用户终止 | 普通反馈不得中断 Agent；显式 cancel 属于控制信号，可通过 `AbortSignal` 中止 |
| 缓存 | 仅缓存确定性且无副作用的调用；v0.1 不实现语义缓存 |
| 命名 | 所有生产代码使用含义完整、可读性好的变量名，禁止无语义缩写 |

### 2.1 三项一致性解释

1. FIFO 与消息优先级采用“优先级队列 + 优先级内 FIFO”，不使用全局 FIFO。
2. 安全降级后，后台任务可以保留，但其后续工具调用必须重新鉴权。
3. 放权模式（Devolve）的完全控制不等于绕过操作系统权限、工作区边界或未注册工具限制。
4. 本文统一中文名称：Ponder 为“思索模式”，Assist 为“协同模式”，Devolve 为“放权模式”。

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

### 2.4 次级与三级 Agent 工作存档

每个次级和三级 Agent 个体使用独立的工作存档：

```text
.astarray/missions/<missionId>/agents/<agentInstanceId>/work-archive.json
```

存档至少包含：

- schema 版本、mission ID、具体 Agent 个体 ID、Agent 层级、revision、更新时间。
- 任务分配、进度检查点、关键决策、结果、失败和交接摘要。
- 产物引用，不直接复制可由路径或内容哈希定位的大文件。

读写与附加规则：

- 次级/三级 Agent 只能写自己的存档；上级 Agent 可以读取下级存档，但不能修改或冒充下级追加历史。
- 上级 Agent 在发布新任务或重新调用下级 Agent 前，**可以选择性地**附加存档内容，也可以明确不附加。
- 附加单位是具体条目，不是整个文件；附加请求必须记录存档所有者 `agentInstanceId`、存档 revision、所选条目的完整结构化快照、选择原因和内容哈希。
- 任务派发时生成所选内容的不可变快照。后续存档更新不能悄悄改变已派发任务的上下文。
- 重新唤醒未回收的同一 Agent 个体可以沿用原 `agentInstanceId`；原个体已回收时，新建 Agent 必须使用新 ID，通过显式附件使用旧个体存档，禁止复用旧 ID。
- 默认不附加，只有内容与新任务相关、未明显过期且 token 成本合理时才选择。
- 附加内容使用“历史工作上下文”边界包裹，优先级低于当前用户指令、当前任务约束和权限策略。
- 默认只允许同一 mission 内附加；跨 mission 使用需按长期记忆读取规则和权限门禁处理。
- 存档不得包含 secret、完整原始长输出或未经清洗的终端控制字符。

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
- `taskSequenceStatus` 是控制面只读工具，提供 `list-sequences / list-tasks / get-task / get-ready / explain-order / get-bundle`，返回同一 revision 的一致快照。用户可在任意模式从 TUI/CLI 调用；Ponder 模型本身仍保持零工具权限。
- 用户可查看自己发布任务及其派生链；Agent 可查看自己发布、被分配或明确授权观察的任务；工具发布方经内部能力接口查询。
- 查询显示来源、优先级、前驱/后继、阻塞原因、当前/分配 Agent、任务包和更新时间，不返回项目产出内容。
- TUI/控制层可在任何模式展示只读快照，不打断 Agent。思索模式下模型仍不能调用工具或写持久化；用户若要新增/修改序列，应切换到协同或放权模式。
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

- Ponder 拒绝全部工具调用。
- Assist 对只读、受限、禁止工具分别执行 allow、ask、deny。
- Devolve 允许注册工具，但不能越过工作区和系统边界。
- 会话授权过期、参数变更后二次鉴权、敏感字段脱敏。

完成门槛：

- 表驱动测试覆盖模式 × 工具类别 × 授权状态。
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
- shell、删除、安装、发布、付款类工具默认不开放。
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

- 主 Agent 可以直接决定调度职责；多 Git 写入 Worker 场景仍指定一个次级 Agent 承担集成职责。
- 复用同一 task store、反馈进程、Worker 和工具策略边界。

完成门槛：

- Worker 挂起时主 TUI 仍能接收消息。
- 可同时查询进度和新建 mission。
- 用户可随时通过状态视图查看 Agent 待办偏序集、顺序解释和任务包进度，而不打断 busy Agent。
- 普通反馈不打断 busy Agent。
- 上级选中的存档附件在任务输入中可追踪，未选择时不会产生隐藏注入。
- 每个三级 Agent 的贡献在合并报告中可追溯；未经次级 Agent 审查的提交不能进入集成分支。
- 显式 cancel 可中断 Provider 或工具的挂起调用。

### T09：记忆、缓存与指标

实现：

- 主 Agent 只保存任务概要和归并摘要。
- Worker 工作态在任务结束后释放。
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
T05B + T05C + T06 + T06A + T07 → T08
T08 → T09、T10、T11
T09 + T10 + T11 → T12
T12 → T13 → T14
```

`T03`、`T04`、`T06`、`T07` 可以并行，但不得由多个执行单元同时修改同一公共类型文件。公共类型变更统一由负责 T02 的执行单元完成。并行 Git 写入必须由次级 Agent 按 T05B 分配独立 worktree，并在集成分支集中审查合并。

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
| Batch 5 | T08 | 单独集成三级编排 |
| Batch 6 | T09–T11 | 指标、TUI、Headless CLI；可分支并行 |
| Batch 7 | T12 | 集中做故障注入、安全和恢复 |
| Batch 8 | T13–T14 | 打包、隔离安装、文档和交付报告 |

### 8.2 一次任务量规则

- 默认每次让 OpenCode完成 **1–2 个高度相关的原子任务**。
- 只有依赖明确、文件改动不重叠时，单次最多并行 3 个任务。
- `T04`、`T05B`、`T05C`、`T06A`、`T08`、`T12` 风险较高，每次只执行一个。
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
高风险任务 T04、T05B、T05C、T08、T12 必须单独完成和验收。
```

---

## 11. 关键注意事项

- 反馈工具已确定为独立进程，不能退化为主进程中的定时器或协程。
- 进程间消息必须包含协议版本、消息 ID、接收者、优先级、创建时间和幂等键。
- 进程间消息必须包含不可变的结构化原始来源；缺失或非法来源不得入池，转发不得覆盖来源。
- Agent 来源必须明确到具体 `agentInstanceId`；“某次级 Agent”或角色名不能作为来源。
- 次级、三级 Agent 各自维护独立工作存档；上级使用存档必须显式选择条目并记录 provenance，默认不得全量注入。
- 涉及 Git 写入的多 Agent 任务由次级 Agent 统一分配隔离分支/worktree、审查三级 Agent 提交、运行集成门禁并执行合并；三级 Agent 禁止自行合并、变基、推送或删除分支。
- Agent 待办任务序列是记忆存档域中的偏序集，与项目任务和产出追踪分离；用户任务默认层级 0，Agent/system/工具生成任务只能层级 1 或以下。
- Git 历史不是自动备份；reset、clean、checkout 覆盖、rebase、强制移动引用和删除分支/worktree 等破坏性操作必须先由底层工具创建受保护恢复点。
- 所有删除、文字删减和覆盖类操作由工具自身在修改前自动备份；备份数据与恢复能力绝不经过模型端。
- 不要依赖进程退出时一定能执行清理逻辑；journal 和 ack 设计必须能恢复。
- 3 小时是单轮退避上限，不是 TTL，也不能作为丢弃消息的理由。
- 不要为了生成质数无限保留数组；使用有界、可测试的生成策略，达到上限后直接保持上限。
- UI 与编排逻辑必须隔离，否则 headless 和故障测试会变得脆弱。
- 权限在工具实际执行前检查，不能只在任务派发时检查。
- 非幂等操作必须携带幂等键或在不确定状态下请求人工裁决。
- 流式输出需要节流，避免高 CPU 和终端闪烁。
- npm 包运行时不得向安装目录写入状态。
- Windows 重点验证路径、原子替换、信号、`.cmd` shim、ConPTY 和子进程清理。
- 所有时间变量写明单位；所有日志字段采用稳定、可搜索的完整名称。
- 交付完成以 tarball 隔离安装成功为准，不以开发目录中运行成功为准。
