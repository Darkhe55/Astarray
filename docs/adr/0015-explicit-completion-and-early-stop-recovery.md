# ADR-0015：明确完成事件与本地早停恢复

## 状态

Accepted — 2026-08-13

## 背景

不同 Provider 和模型会因长度限制、连接中断、超时、自身早停策略或错误的 `finish_reason` 在任务尚未完成时结束一轮输出。把“请求结束”或自然语言中的“完成”直接当作任务完成，会遗漏实现、测试或交付步骤；只要求一个文本标识又会被工具输出、项目内容或模型误报伪造。

## 完成协议

模型只有在其认为任务全部完成时，才能返回版本化控制事件 `ASTARRAY_TASK_COMPLETION_V1`。文本兼容传输的精确末行格式是：

```text
ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"...","completionAttemptId":"...","completedTaskIdentifiers":["..."],"claimedStatus":"complete","taskSequenceRevision":0}
```

模型返回字段至少包含：

- `taskExecutionId`：当前任务执行 ID；
- `completionAttemptId`：本轮一次性尝试 ID；
- `completedTaskIdentifiers`：声明完成的任务/任务包节点；
- `claimedStatus: "complete"`；
- `taskSequenceRevision`：声明所依据的本地状态修订号。

本地解析器从规范化最终结果计算 `resultDigest` 并附加到内部事件；不要求模型自行计算或决定摘要值。

优先使用 Provider 的结构化控制帧或受控 `finishTask` 协议调用；兼容仅文本的 Provider 时，标识必须位于最终输出的独立末行，并由本地解析器转换为同一控制事件。出现在用户内容、项目文件、普通模型正文或工具输出中的同名字符串一律忽略。

完成事件是必要条件，不是充分条件。`LocalCompletionVerifier` 只有同时确认以下条件才提交 `done`：

1. 事件 schema、任务 ID、一次性尝试 ID和状态 revision 有效且未重放；
2. 声明范围内所有必要节点均处于可完成状态，无未满足前驱；
3. 无运行中的工具调用、待确认副作用、待处理权限请求或未确认反馈；
4. 任务要求的产物存在，类型检查、测试、构建或其他验收门禁有本地证据；
5. 高严谨性任务已执行 ADR-0016 的事实验证流程，关键主张有证据关系或明确的不足/不可用记录；不得把证据不足改写为合格；
6. ADR-0017 的循环守卫无未解决活锁，任务级总调用预算未被绕过；
7. 没有未解决的 `blocked`、`failed`、取消或用户输入需求；
8. Provider 流正常结束，控制事件位于允许的最终通道。

模型无法用自述覆盖本地状态。标识合法但门禁未完成时，运行时记录 `completion_claim_rejected` 并继续未完成项。

## 早停检测与续跑

本地 `AgentRunWatchdog` 定期检查 Provider 请求、流式事件时间、运行进程、工具调用、任务 revision、完成事件和 Provider 结束原因。云端 `finish_reason` 只作为输入事实，不作为完成裁决。

`modelNoProgressTimeoutMilliseconds` 到期只触发本地健康探测，不单独证明早停。若 Provider 请求、运行进程或传输心跳仍确认活跃，继续等待并服从独立的请求硬超时；只有请求已结束、连接/进程已失活，或硬超时在安全取消原请求后，才能创建新的续跑请求。无法确认旧请求已经停止时进入 `blocked`，不得并发续跑。

默认配置为：

- `watchdogCheckIntervalMilliseconds = 5_000`；
- `modelNoProgressTimeoutMilliseconds = 90_000`，可按 Provider 配置；
- `completionMarkerGracePeriodMilliseconds = 5_000`；
- `maximumAutomaticContinuationAttempts = 3`。

一次输出结束且缺少有效完成事件，或完成声明被本地验收拒绝，并且任务仍可继续时，运行时判定为疑似早停。它先原子保存本地检查点，再以新的 `completionAttemptId` 请求同一任务继续，提供未完成节点、已确认产物和验收缺口，要求从检查点继续且不得重做已确认的非幂等副作用。

以下情况不得触发并行或无限续跑：

- Provider 请求仍活跃、模型仍在流式输出或工具正在运行时，不启动第二请求；
- 明确的用户取消立即终止；
- 需要用户输入时返回独立的 `ASTARRAY_TASK_BLOCKED_V1` 控制事件并暂停；
- 明确拒绝、不可恢复错误或非幂等副作用结果不确定时进入 `failed/blocked`，交给反馈和人工裁决；
- 自动续跑达到上限后停止，附带来源明确的失败反馈和检查点，不机械重试。

检查点和续跑必须幂等：每轮尝试 ID 唯一，旧完成事件不可重放，工具调用使用幂等键；对无法确认的写入禁止自动重试。上下文长度耗尽时可基于本地工作存档和任务状态构造最小续跑上下文，但不得因此跳过存档选择、权限复检或敏感数据规则。

## 必测行为

- 合法完成事件且全部本地门禁通过时仅结案一次。
- 普通 `stop`、`length`、断流、超时和进程退出在任务未完成时创建检查点并有界续跑。
- 缺少标识、重复标识、陈旧 revision、错误任务/尝试 ID 和正文/工具输出内伪造标识均不结案。
- 模型提前输出完成标识但缺少产物或测试证据时拒绝声明并继续缺口。
- 慢流、长时只读工具、授权等待和活跃 Provider 不被误判为早停。
- 早停续跑沿用 ADR-0017 的任务级循环/调用预算和读取回执，不能通过新尝试 ID 重置活锁保护。
- 只有“无进展”但 Provider/进程仍活跃时仅健康探测，不取消、不续跑；旧请求停止状态不确定时进入 `blocked`。
- `blocked`、用户取消、明确拒绝和非幂等不确定结果不会自动循环。
- 连续三次早停后停止并反馈；任一成功进展更新检查点，但不重置整个任务的安全上限。
- ScriptedRuntime 覆盖全部分支；真实 Provider 测试可选，默认 CI 离线。

## 结果

任务完成不再等同于一轮模型输出结束。模型必须明确声明，本地运行时必须独立验收；疑似早停可自动恢复，同时受到幂等、并发和重试上限约束。
