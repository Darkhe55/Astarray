# ADR-0021：主 Agent 永久只读、次级权限上限与会话临时提升

- 状态：Accepted（设计冻结，尚待 T06G 实现与动态验收）
- 日期：2026-08-13

## 背景

可配置权限组若直接作用于主 Agent，会使主 Agent 同时掌握用户对话、全局记忆和高副作用工具，破坏“主 Agent 只接收、转交和裁决”的分层。另一方面，用户需要在不永久修改权限组的情况下，只为当前会话中的执行 Agent 临时放宽某项权限，并能在会话结束时保存这次公开权限组合供以后复用。

## 决策

### 主 Agent 永久只读

主 Agent 模型在 Ponder、Assist、Devolve、自定义模式及任何临时提升状态下都只能调用读取类白名单工具。profile、临时覆盖和三级 Agent 分配均不能扩大主 Agent 权限。

用户任务转交给本地 `SecondaryAgentSessionController`。控制器创建不可复用的次级 `agentInstanceId` 并绑定权限快照；这属于可信会话控制面，不是主 Agent 模型可调用的 Agent 创建工具。

### 次级 Agent 权限上限

profile 和会话临时覆盖只作用于具体次级 Agent。次级 Agent 是执行权限持有者，并决定向所属三级 Agent 分发哪些工具、资源范围和三态权限。分发必须满足：

```text
tertiaryEffectivePermission
  <= delegatedPermission
  <= secondaryEffectivePermission
  = baseProfileDecision + validSessionElevation
```

三态宽度顺序为 `deny < ask < allow`。三级 Agent 不读取完整 profile，不直接提升权限，也不能把权限转给兄弟 Agent。权限不足时经反馈工具回报次级 Agent，由次级 Agent 向认证用户请求。

### 当前会话临时提升

认证用户可以为当前 `sessionId` 选择一个或多个公开 capability，从基础决定临时提升到 ask 或 allow。默认作用域为 `all-secondary-agents-in-session`，覆盖该会话全部现有及后续次级 Agent；也可显式使用 `specific-secondary-agent` 并绑定具体 `agentInstanceId`。记录至少绑定：

- 会话、作用域、可选具体次级 Agent、capability 和资源范围；
- 基础 profile ID/revision、目录版本和会话权限 revision；
- 原决定、新决定、创建时间、可选到期时间及用户裁决引用。

提升不修改基础 profile，也不使用普通 Assist 会话授权记录。会话级覆盖明确应用于全部现有及后续次级 Agent；个体覆盖不传播到其他次级 Agent。会话关闭、到期、撤销、profile/revision/目录变化时全部失效；具体 Agent 回收会额外撤销其个体覆盖。尚未执行的调用重新鉴权。用户可随时查看和撤销公开临时提升。

### 会话关闭时导出

会话运行期间或关闭流程中，认证用户可把当前公开有效权限导出为：

1. 版本化 JSON 配置；或
2. 新的命名自定义 profile。

默认导出“基础 profile + 会话级覆盖”的当前会话公开有效配置。存在个体覆盖时，用户还可导出指定次级 Agent 的最终有效快照，或把多个次级 Agent 的配置分别导出。导出只保存公开 capability 决定、资源范围、目录版本、来源 profile 和显示元数据；删除全部会话/Agent 身份、nonce、用户裁决签名、一次性许可、令牌、到期计时器、内部字段及内部执行信息。导入后的配置没有原会话授权效力。

导出成功或用户跳过后再销毁临时覆盖。导出失败不得让会话或权限租约无限存活；会话仍安全关闭并报告导出失败。覆盖已有导出文件时先自动备份。

## 后果

- Devolve 的“默认全部允许”明确指次级 Agent，而不是主 Agent。
- 主 Agent 保持轻量且无法直接执行副作用；本地控制器负责可信派发。
- 会话临时提升提供便利，但必须按具体次级 Agent 隔离并在关闭时失效。
- 导出的是可复用权限配置，不是授权凭据或会话恢复令牌。

## 验收重点

- 任意 profile 和临时提升都不能让主 Agent 获得非读取工具。
- 次级 Agent 权限决定三级 Agent 的严格上限，deny/ask/allow、资源范围和工具子集均不能扩张。
- 临时提升绑定会话和具体次级 Agent，撤销、到期、关闭、profile 变化和重放均正确失效。
- 会话关闭导出可复现公开有效配置，但不保留任何授权能力或内部字段。
