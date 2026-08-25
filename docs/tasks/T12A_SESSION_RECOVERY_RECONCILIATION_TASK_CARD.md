# T12A：统一会话恢复、任务续接与外部状态对账任务卡

> 状态：`in_progress`（T12A-01/02/03 完成；T12A-04 未开始）  
> 设计日期：2026-08-19  
> 任务来源：用户  
> 优先级层级：0  
> 风险等级：高；必须按检查点单独实现和验收  
> 前驱：`T05D`、`T07E`、`T07D`、`T08A`  
> 后继：`T12`、`T13`

> 架构记录：T12A-01 必须新增 ADR-0030，冻结检查点事实源、启动只读对账、身份恢复、旧授权失效和未知副作用阻塞。

## 1. 目标

让 Astarray 在主进程、反馈进程、Provider请求或系统意外中断后，下次打开时可以从最后可信检查点恢复任务，而不是重新开始、复用陈旧授权、重复副作用或覆盖人工在离线期间完成的修改。

本卡建立统一恢复控制面。已有 task store、Agent工作存档、反馈 mailbox journal、Git提交和早停检查点都是证据来源，但不能各自独立决定恢复结果。

## 2. 冻结恢复原则

- 启动后先执行只读对账；文件、Git、进程、反馈、Provider和权限状态未确认前不得继续写入。
- 恢复的是任务状态和具体存活 Agent实例，不是盲目恢复网络连接或完整模型上下文。
- 原 Agent仅在持久化生命周期为活动/暂停、身份未回收且所有权可验证时沿用原 `agentInstanceId`；已关闭或回收则创建新身份并显式附加 handoff。
- 模型/Provider请求中断后不能假定成功或失败。确认旧请求已停止后，才可用新尝试 ID从检查点继续；停止状态不确定时进入 blocked。
- 非幂等副作用结果未知时必须 `blocked-uncertain-side-effect`，由用户裁决，禁止自动重试。
- 普通会话临时提升、一次性安装授权、备份删除授权和其他 nonce 在恢复的新进程中默认失效；不能仅凭旧日志恢复权限能力。
- 反馈 journal 按 enqueue/deliver/ack 状态幂等重放；不得重复注入已经确认的消息。
- 离线期间人工修改由 T05D 对账，不能被旧 Agent检查点覆盖。
- 文件工作集、反自指、循环、失败、工具调用和任务链累计预算由 T07B/T07E恢复，不能通过重启清零。
- 放弃、清理、重置或覆盖恢复状态属于破坏性操作，执行工具必须先自动备份。

## 3. 统一检查点内容

`RecoveryCheckpointV1` 至少记录：

- session、mission、task sequence 和 task chain 的 schema/revision。
- 主、次级、三级、四级具体 `agentInstanceId`、父子关系、生命周期和当前任务链。
- 每个任务节点的状态、前驱、优先级、执行者、检查点和完成尝试 ID。
- Git目标分支、固定基线、集成/worker分支、worktree、HEAD、脏状态摘要和允许路径。
- 人工变化观察 revision、Agent编辑意图和未决冲突。
- 工具调用状态：`planned / started / confirmed-success / confirmed-failure / result-unknown`。
- Provider请求公开 ID、安全检查点、最后事件时间、停止确认和完成事件状态。
- feedback enqueue/delivery/ack游标，不复制其他 Agent私有消息视图。
- 权限 profile/revision；只记录公开配置引用，不保存授权 nonce、凭据或一次性许可。
- 每 Agent工作集、任务链累计来源、字节/token计数、读取回执和循环预算。
- 测试、验收、人工体验、安装、备份删除和外部依赖门禁状态。
- 内容哈希、创建时间、写入进程实例和前一检查点哈希。

检查点使用原子写入和追加式事件 journal；损坏的最新检查点只能回退到已验证的前一版本，并明确报告丢失的时间窗。

## 4. 启动恢复流程

```text
发现未正常关闭的会话/mission
  → 验证检查点链、schema、revision和哈希
  → 只读对账文件、Git、worktree、进程、mailbox和Provider状态
  → 合并离线期间人工变化观察
  → 分类每个未完成工具调用和副作用
  → 撤销不可恢复的临时授权能力
  → 恢复安全的Agent/任务或创建新身份handoff
  → 重新计算偏序集ready set
  → 向用户显示可自动恢复、需裁决和不可恢复项
```

用户可以选择恢复安全节点、暂不恢复或放弃 mission；不能使用一个无范围的“全部继续”按钮跨过未知副作用、权限和冲突门禁。

## 5. 恢复分类

| 中断状态 | 默认恢复行为 |
|---|---|
| 调用尚未开始 | 可重新调度 |
| 只读调用中断 | 在预算、敏感禁读和重复读取策略下重新执行 |
| 已确认成功并有幂等结果 | 复用已确认结果，不重复调用 |
| 已确认失败且可重试 | 按原任务预算有界重试 |
| 幂等写入且外部状态可验证 | 验证结果后确认或重新执行 |
| 非幂等调用结果未知 | `blocked-uncertain-side-effect` |
| Provider请求仍可能活跃 | `blocked-provider-state-unknown` |
| 人工在离线期间修改相关文件 | 贡献 stale，进入 T05D 重对账/返修 |
| 一次性授权等待或已签发未消费 | 授权失效，重新询问 |
| Agent已回收 | 新身份 + 显式 handoff，不复用旧身份 |

## 6. 检查点序列

| 检查点 | 内容 | 主要验收 |
|---|---|---|
| T12A-01 | 检查点、恢复事件、调用状态和对账结果 schema | 版本迁移、损坏、重放、身份和秘密字段反例 |
| T12A-02 | 原子检查点存储、哈希链、journal和最近可信版本选择 | 写入中断、磁盘满、部分文件、并发revision测试 |
| T12A-03 | 文件/Git/worktree/人工变化只读对账 | 离线修改、分支变化、脏工作树、丢失worktree测试 |
| T12A-04 | Provider、工具副作用、反馈ack和权限恢复分类 | 未知副作用blocked；消息不重复；授权不复活 |
| T12A-05 | Agent身份、handoff、任务偏序和读取/循环预算恢复 | 回收身份不复用；任务顺序和预算不清零 |
| T12A-06 | CLI/TUI恢复中心、人工裁决和无依赖任务继续 | 无“全部越过”；信息清晰；等待不持锁 |
| T12A-07 | 故障注入、孤儿资源收口、三平台和tarball终验 | 多中断点可恢复；无重复副作用和孤儿进程 |

每轮只执行一个检查点；每个检查点预计不超过3小时，超过时在存储、对账、恢复控制器、界面或故障测试边界继续拆卡。

## 7. CLI/TUI 最小能力

建议提供：

```text
astarray recover list
astarray recover show <mission-id> --json
astarray recover resume <mission-id>
astarray recover abandon <mission-id>
```

- `list/show` 是只读能力，返回脱敏公开状态。
- `resume` 只恢复本地判定为安全的节点；需要裁决的项目逐项显示。
- `abandon` 不等于删除所有数据。默认只关闭调度并保留可审计存档；清理分支、worktree、检查点或状态文件必须使用独立受控操作并自动备份。
- 非交互模式遇到人工裁决项必须返回稳定 blocked JSON 和非零/约定退出码，不能默认允许。

## 8. 必测场景

1. 在任务写入前、备份后写入前、工具执行后结果持久化前、反馈deliver后ack前、Provider半流和Git合并前分别杀死进程。
2. 下次启动不会重复已确认工具调用，不会并行旧Provider请求，不会清零续跑/失败/读取预算。
3. 非幂等远端写入结果未知时严格blocked；项目文字或模型声明不能把它改成成功。
4. 离线期间人工修改、提交、切换分支或删除worktree后，旧贡献失效并进入T05D协调。
5. 最新检查点损坏时回退前一可信版本，明确显示可能丢失的时间窗，不静默当作最新状态。
6. 反馈进程和主进程以不同顺序崩溃，未ack消息幂等重放，已ack消息不重复进入Agent上下文。
7. 会话临时提升、安装allow-once和备份删除授权在恢复后不能使用；基础profile保持不变。
8. 已暂停同一Agent可在身份有效时恢复；已回收Agent必须新建身份并只接收选定handoff。
9. 用户暂不处理人工裁决时，其他无依赖ready节点继续执行，不轮询消耗模型调用。
10. Windows、Linux、macOS覆盖路径、信号、进程清理、Git worktree和原子替换差异。

## 9. 执行注意事项

- T12A不能通过“重启后全部重新运行”简化实现；这会违反副作用、读取预算和完成协议。
- 对账阶段只读，不得为了探测状态运行可能修改项目、安装依赖或访问敏感文件的命令。
- 清理孤儿进程、分支和worktree必须先确认所有权；涉及文件/引用删除或覆盖时执行工具自动备份。
- 反馈退避 `pn` 的单次等待上限为3小时；它不是检查点TTL、恢复等待期限或消息丢弃条件。
- 每个检查点同时完成实现、测试、文档、状态和故障注入证据；仅单元测试不能证明可恢复。
- 完成T12A后还需执行T12综合安全加固，再进入T13 tarball最终验收。

## 10. 完成事件

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: T12A-XX
agentInstanceId: <具体且不可复用的 Agent 个体 ID>
sourceKind: user
priorityTier: 0
recoveryCheckpointIdentifier: <检查点 ID>
recoveredMissionIdentifier: <mission ID>
recoveryDecisionCounts: <safe/blocked/new-handoff 数量>
executedChecks:
  - command: <故障注入或验收命令>
    exitCode: <退出码>
sideEffectEvidence: <无重复副作用与未知状态blocked证据>
tarballEvidence: <隔离恢复验收>
remainingRisks:
  - <没有则写 none>
completionGate: passed | failed | blocked
```

缺少中断点故障注入、外部状态对账、旧授权失效、未知副作用阻塞或tarball恢复证据时，不得标记完成。

## 11. 可直接交给 OpenCode 的首轮指令

```text
完整读取 AGENTS.md、四份根目录必读文档、ADR-0015、ADR-0022、
T05D、T07E、T07D、T08A任务卡和本任务卡。先核对全部前驱动态证据；
未通过时只报告阻塞。依赖通过后，本轮仅执行T12A-01。
先写秘密字段、旧授权、身份复用、未知副作用和损坏revision的schema反例，
不得提前实现启动恢复或资源清理。
```
