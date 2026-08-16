# ADR-0008：每个 Agent 独立工作存档和选择性附加

## 状态

Accepted — 2026-08-12

## 背景

主、次级、三级 Agent 都会形成各自的会话或任务工作态。Agent 被重新调用或上级派发相关新任务时，历史决策、进度和产物引用可能有用；但共享记忆文件或把其他 Agent 的历史自动注入会造成上下文污染、来源混淆和权限扩散。

## 决策

每个具体 Agent 个体拥有独立、版本化且物理隔离的记忆域和工作存档。主 Agent 也使用具体 `agentInstanceId` 标识自己的会话记忆域；每个次级、三级 Agent 使用自己的 `agentInstanceId` 目录：

```text
.astarray/agent-memory/<agentInstanceId>/memory-archive.json
.astarray/missions/<missionId>/agents/<agentInstanceId>/work-archive.json
```

Agent 只能读写自己的记忆域和存档，不能直接打开、搜索、修改或合并其他 Agent 的记忆文件。上级 Agent 只能向本地 `CrossAgentContextAttachmentController` 提交选择请求，由控制器查询允许公开的元数据并选择具体条目形成附件，也可以不附加。系统默认不自动注入任何其他 Agent 历史。

同级 Agent 之间没有任何隐式共享关系。存储层不得提供按角色共用的 `secondary-memory`、`tertiary-memory`、共享最近消息或共享上下文文件；同级协作同样只能走反馈消息或不可变附件。目录、文件 owner、writer capability 和运行时主体必须绑定同一个完整 `agentInstanceId`，不允许通过显示名称、任务 ID、角色名或会复用的计数器寻址。

附件必须记录存档所有者 `agentInstanceId`、存档 revision、被选条目的完整结构化快照、选择原因与内容哈希。任务派发时固定附件快照，避免存档的后续更新改变已经发布的任务含义。

附件在接收方上下文中必须位于独立的 `externalHistoricalContext` 区域，标明原始 Agent、选择者、任务、revision 和信任级别。它只对当前任务激活有效，不自动写入接收方的 `memory-archive.json`，也不得改写接收方已有记忆、系统指令、当前任务或权限。需要长期保留时，接收 Agent 只能在自己的存档中写一条带来源的独立观察或引用，不能复制成无来源的“自身记忆”。

尚未回收的同一 Agent 个体被重新唤醒时可以继续使用原 `agentInstanceId` 和自己的记忆域。原个体一旦回收，替代 Agent 必须获得新 ID；如需历史内容，由控制器显式选择并附加旧个体存档，不能复用旧 ID、挂载旧记忆目录或继承完整上下文。

存档保存结构化工作摘要和产物引用，不默认保存完整模型上下文、原始大输出、secret 或未经清洗的终端内容。历史存档的指令优先级低于当前用户指令、当前任务约束和权限规则。

主 Agent 的后台报告索引是带来源的外部收件箱，不是主 Agent 记忆；报告到达只入索引，只有后续对话明确需要时才读取所选报告，也不会自动写入主 Agent 长期记忆。

默认只允许在同一 mission 内选择存档。跨 mission 使用按长期记忆读取处理，必须经过相应权限门禁。共享项目任务链、Git 提交和产物可以通过不可变引用被多个 Agent观察，但不属于任何 Agent 的个人记忆，也不能借此共享模型上下文。

## 结果

- 每个 Agent 的记忆和模型上下文保持独立，跨 Agent 只传递有来源的最小不可变附件。
- 默认无隐藏注入，token 成本和上下文污染可控。
- 每个附件有完整 provenance，可重放并解释为何选择某段历史。
- 需要实现存档所有权校验、revision 快照、token 预算和损坏恢复。
