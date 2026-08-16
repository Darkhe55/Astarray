# ADR-0024：工具说明回访与受权 Agent 通信转交

- 状态：Accepted（设计冻结，尚待 T08B 实现与动态验收）
- 日期：2026-08-14

## 背景

为每个新任务重复注入完整工具 schema 和用法会持续消耗 token；完全不再发送又会使长任务或复用 Agent 在忘记用法、工具组发生变化或缺少能力时无法恢复。另一方面，多 Agent 协作有时需要一个上级把直属下级的沟通入口授权给同级 Agent，但不能暴露 IPC 地址、能力令牌，或因此转移任务所有权、记忆和权限。

## 决策

### 每个 Agent 个体的工具说明回执

次级和三级 Agent 均以具体 `agentInstanceId + toolGroupIdentifier + toolGroupRevision` 保存独立 `ToolDocumentationReceipt`。新建 Agent 不继承旧个体回执；同级 Agent 也不共享。第一次向某个 Agent 分配某个工具组时，harness 一次性注入该组每个已分配工具的完整公开说明：稳定工具 ID、用途、输入 schema、返回 schema、示例、失败码、幂等性、副作用类别、所需权限和主要限制。

后续任务激活若工具组及相关定义 revision 未变化，不再重复发送完整说明，只发送以下固定提醒：

> 如果忘记工具用法，或者缺少可用工具，请返回 `ASTARRAY_TOOL_HELP_REQUEST_V1` 标准请求；不要猜测参数、伪造工具名或重复试错。

工具组新增、删除、schema/行为 revision 变化时，只注入经过校验的差异说明并更新回执；无法证明差异完整时重新发送该工具组完整公开说明。回执只是“说明曾经送达”的本地事实，不表示 Agent 仍记得，也不构成工具授权。

### 标准请求格式

模型返回的控制事件为：

```json
{
  "controlEventType": "ASTARRAY_TOOL_HELP_REQUEST_V1",
  "requestIdentifier": "model-generated-unique-id",
  "taskExecutionIdentifier": "current-task-execution-id",
  "requestKind": "usage-help",
  "toolIdentifier": "registered-tool-id-or-null",
  "capabilityIntent": "需要完成的具体动作",
  "blockingReason": "forgot-usage",
  "knownToolGroupRevision": 1
}
```

字段规则：

- `requestKind` 只能是 `usage-help` 或 `missing-capability`。
- `usage-help` 必须提供当前已分配的 `toolIdentifier`，`blockingReason` 使用 `forgot-usage`、`schema-uncertain` 或 `response-uncertain`。
- `missing-capability` 可将 `toolIdentifier` 置为 `null`，必须用 `capabilityIntent` 描述目标而不是猜测工具名；`blockingReason` 使用 `not-in-assigned-tool-set` 或 `no-known-match`。
- `requesterAgentInstanceId`、Agent 层级、所属上级、mission、实际工具组 revision 和消息来源均由 harness 从已认证运行时注入，模型字段不能覆盖。
- 请求只表达说明/能力缺口，不授权工具、安装依赖、扩大权限或改变任务范围。

本地直接响应使用：

```json
{
  "controlEventType": "ASTARRAY_TOOL_HELP_RESPONSE_V1",
  "requestIdentifier": "canonical-request-id",
  "resolution": "usage-provided",
  "toolIdentifier": "registered-tool-id-or-null",
  "toolDefinitionRevision": 1,
  "usageDocumentation": {},
  "escalationIdentifier": null,
  "isAuthorizationGranted": false
}
```

`resolution` 只能是 `usage-provided`、`known-but-not-usable`、`escalated-missing-tool`、`stale-request` 或 `rejected`。只有 `usage-provided` 可以携带当前已分配工具的公开 `usageDocumentation`；其他状态不得泄露不可用工具 schema。`isAuthorizationGranted` 固定为 `false`，防止把说明响应误当成授权。

逐级上报使用 `ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1`，至少保存 canonical request/escalation ID、经 harness 注入的请求者和默认上级、任务/mission、能力意图、可选工具 ID、当前工具组/目录 revision、`known-but-not-usable | missing-tool` 状态、阻塞原因和原始来源。接收上级不能改写原始来源，也不能仅凭 escalation 自动分配或安装工具。

### 本地响应与逐级上报

`ToolDocumentationRecallController` 按以下顺序处理：

1. 请求的工具存在于该 Agent 当前已分配工具组且 revision 有效：直接返回 `ASTARRAY_TOOL_HELP_RESPONSE_V1`，只包含该工具的完整公开用法和新的说明回执，不重复整个工具组。
2. 注册表存在匹配工具，但未分配、权限不足或当前任务范围不允许：返回 `known-but-not-usable` 摘要，不向 Agent 暴露不可用 schema；生成 `ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1` 上报默认上级，由上级决定是否请求授权或重新分配。
3. 注册表没有匹配工具：生成 `missing-tool` escalation，保留能力意图、已搜索目录 revision、候选为空和原始来源，不让模型自行安装、发现插件或循环改写请求。
4. 请求陈旧、重复或 revision 不一致：幂等返回已有响应，或要求基于最新任务/工具组 revision 重建请求；不得重复上报。

三级 Agent 的默认上级始终是其具体所属次级 `agentInstanceId`。次级 Agent 的缺失能力上报进入本地会话控制面和主 Agent 报告索引，由后续用户交流或专用授权界面处理；主 Agent 不因此获得写工具。授权转交通信不会自动改变工具帮助上报链。

### Agent 数量无产品配额

主、次级、三级 Agent 实例均不设置累计创建数量、存档数量或同级个体数量的产品硬上限。单个用户会话仍只有一个当前用户沟通主 Agent；不同会话、主 Agent 替代个体、次级和三级实例可持续创建。并发执行槽、Provider 限流、内存、磁盘和操作系统资源可使实例排队、暂停或回收，但不得把资源调度上限解释为 Agent 数量配额，也不得因历史实例数量达到阈值拒绝创建。

### 受权转交下级 Agent 的沟通方式

不传递真实 IPC 地址、socket、进程句柄、mailbox 路径或能力令牌。直属上级通过本地 `AgentCommunicationDelegationController` 申请创建版本化 `DelegatedAgentCommunicationGrant`，其中至少包含：

- grant ID、授权来源与裁决引用；
- grantor 上级、recipient 同级 Agent、target 直属低一级 Agent 的具体 `agentInstanceId`；
- mission/任务范围、允许消息类型、是否允许发送 instruction、回复路由；
- 创建时间、到期时间、最大在途消息数、revision 和撤销条件。

只有 target 的当前直属上级可以发起转交，recipient 必须与 grantor 同级，target 必须恰好低一级且仍存活。Assist 默认逐次询问认证用户；Devolve 和自定义模式按公开权限 `agent.communication-delegate` 的三态决定。授权只产生不透明 `communicationHandleIdentifier`，模型无法读取底层凭据。

recipient 可经独立反馈进程直接与 target 交流，但 grant 默认只允许信息沟通，不转移任务所有权、偏序集写权、Git 集成职责、记忆访问、工具分配权、权限租约或 target 的默认上级。每条消息仍使用真实发送者来源；转发保留原始来源。是否抄送原直属上级由 grant 明确规定，不能由消息正文修改。

grant 不可转授权。任一相关 Agent 回收、所属关系变化、任务/mission 结束、权限/profile revision 变化、用户撤销、到期或消息范围越界时立即失效；尚未执行消息在投递前复检。三级 Agent 的工具帮助、权限和生命周期请求仍默认发给其所属次级 Agent，除非未来另有单独的所有权转移协议。

## 后果

- 工具完整说明只在个体首次接收或定义变化时注入，显著减少重复 token。
- Agent 忘记用法时有确定恢复协议，不需要猜参数或重复失败。
- 缺失工具与“已知但未分配”被区分，权限和安装门禁不会被工具帮助绕过。
- 同级 Agent 可在授权后直接联系对方的直属下级，但不获得其记忆、任务或执行权限。
- Agent 数量没有产品配额；实际资源压力由调度、排队和回收处理。

## 验收重点

- 每个新 Agent 第一次接收完整说明；同一 revision 后续只收固定提醒；新个体和 revision 变化正确重新发送完整或差异说明。
- 标准请求 schema、身份注入、幂等去重、直接回复和逐级上报路径均可重放。
- 三级缺失工具先到所属次级；次级缺失工具进入会话控制面，不唤醒主 Agent 执行。
- 工具帮助不会授予工具、权限、安装能力或泄露未分配工具 schema。
- 大量 Agent 可创建、排队、归档和回收，不存在硬编码累计/同级数量上限；并发资源控制仍稳定。
- 通信转交只能由直属上级授权给同级个体，不能转授权、伪造来源、跨层级、跨 mission 或在失效后投递。
