# T12：综合安全加固任务卡（v0.1 复验后新版）

> 状态：`in_progress` — T12-01~04 完成（跨进程租约 + 编排会话接入 + 反馈心跳修复 + 只读状态/doctor 一致性；1183 测试 / `npm run check` exit 0）；T12-05 待续
> 编制日期：2026-08-26
> 任务来源：用户（PLAN_STATUS 偏序 `T07D → T12A → T12 → T13 → T14`）
> 优先级层级：0
> 风险等级：高；必须按检查点单独实现和验收
> 前驱：`T12A`（T12A-01~07 已 done，1161 测试全绿，HEAD de1f579）
> 后继：`T13`、`T14`
> 相关规范：`IMPLEMENTATION_PLAN.md` §T12 范围；`AUDIT_REMEDIATION_TASKS.md` AR-06/AR-07；
> 参考任务卡：`T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD.md`

## 1. 目标与背景

`T12A` 已建立中断后统一检查点、启动只读对账、副作用 blocked 与身份/handoff 恢复。T12 是在该新架构上完成的**综合安全加固**，重点收口 `PLAN_STATUS.md` 中仍标记"留待/遗留"的并发与资源清理缺口，并对既有 Batch 7（T12 原范围：Provider 超时/工具异常、损坏 journal、孤儿进程、路径穿越、secret、无限 tool loop）在新组件上做动态复验。

当前现状（2026-08-26 侦察证据）：

- `packages/core/src/infra/task-store.ts`（行 27/48）与 `mission-manager.ts`（行 37）等全部使用**进程内 `AsyncMutex`**；跨进程仅靠 `stale-revision` CAS 兜底（task-store.ts 行 120-125）。PLAN_STATUS 三处标注"跨进程 mission 锁仍为单进程内实现"。
- 错误码 `mission-locked` 已存在（`packages/core/src/core/errors.ts`），当前仅用于备份删除绑定校验（`backup-vault.ts` 行 594-609），未用于 mission 并发所有权。
- T12A 已产出 `recovery-checkpoint-store`、`readonly-reconciliation-service`、`recovery-classification-service`、`recovery-identity-budget-service`、`fault-injection-recovery-verifier` 与 CLI `recover list/show/resume/abandon`（T12A-06）。
- 反馈进程监督器 `feedback-process/process-supervisor.ts` 有崩溃重启与重放，但"主进程/TUI 退出宽限内关闭、无孤儿进程"需在新装配（CLI recover/resume、Provider 运行时）下动态复验。
- 破坏性调用静态门禁（AR-06 项 8）存在性需动态验证；文档（README/DELIVERY_REPORT）仍是 08-12~08-22 快照。

## 2. 冻结原则（新增/沿用）

1. 并发写保护：任何进程在**推进同一 mission 的运行状态**（调度、领取、写入任务链/概要/检查点）前，必须先取得持久化的 mission 活动租约；未取得即快速失败 `mission-locked`。租约不替代 revision CAS 与检查点恢复，二者叠加。
2. 陈旧接管必须经 T12A 恢复分类，不得因租约陈旧就自动重跑未知副作用；接管路径写审计。
3. 只读对账与状态查询（recover list/show、status、doctor）不要求租约，任何时刻可用，不得被并发写阻塞或持锁等待。
4. 进程退出/收口不得遗留孤儿反馈进程、孤儿租约或孤儿 worktree；清理前先确认所有权；破坏性清理仍走自动备份。
5. 生产代码继续遵守：含义完整命名、`is/has/can/should` 布尔前缀、时间量带单位；每检查点先补红灯/故障注入测试再实现。
6. 每检查点 ≤3 小时、5–15 个生产文件预算；超过则在可构建边界继续拆卡，不与 T13/T14/GUI-01 合批。

## 3. 检查点序列

| 检查点 | 内容 | 主要验收 |
|---|---|---|
| T12-01 | 跨进程 mission 租约存储与并发写保护（契约/存储/接管） | 同 mission 两进程并发写被 `mission-locked` 快速失败；心跳续约；陈旧接管与恢复分类配合；损坏租约 fail-closed；与 revision CAS 双保险 |
| T12-02 | 编排与 CLI 接入（run/resume/recover） | 运行/续接前申请租约、结束释放；resume/recover 对活动租约拒绝；接管需恢复裁决；故障注入无重复副作用 |
| T12-03 | 反馈监督器孤儿收口与退出宽限 | CLI/TUI 退出、Ctrl+C、SIGKILL 场景无孤儿进程；与 T12A 检查点衔接；宽限计时单位明确 |
| T12-04 | 只读状态与 doctor 一致性、损坏状态目录加固 | recover list/show、status、doctor 在并发写、陈旧租约、损坏文件下稳定且不持锁；非交互 blocked 稳定 JSON |
| T12-05 | 破坏性调用盘点与静态架构门禁复核 | 生产代码破坏性文件 API 仅白名单底层模块可达（已有则动态验证，无则补齐静态测试）；Git 破坏性操作恢复点复核 |
| T12-06 | 综合终验与文档对齐 | 并发+崩溃矩阵、覆盖率、`npm run check`、tarball 隔离安装、PLAN_STATUS/README/DELIVERY_REPORT 更新、单任务提交 |

## 4. 执行注意事项

- 编码前完整读取 AGENTS.md 指定四份根目录文档、ADR-0015/0022/0030、T05D/T07E/T07D/T12A 任务卡与本卡；先核对 T12A 动态证据。
- 每检查点先写可复现缺口的失败测试（并发用真实 fork/子进程或确定性双会话夹具），再实现。
- 等待/退避量 `pn` 单次上限 3 小时；同一根因连续失败 3 次后停止机械重试并记录证据。
- 删除、删减、替换、截断、覆盖必须在执行工具内自动备份；Git 历史不替代备份。
- 每检查点同时提交实现、测试、文档与 PLAN_STATUS 证据；前一检查点未通过不得领取后继。

## 5. 完成事件

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: T12-XX
agentInstanceId: <具体且不可复用的 Agent 个体 ID>
sourceKind: user
priorityTier: 0
gitCommitId: <原子提交 ID>
concurrencyEvidence: <双进程/双会话并发与接管结果>
faultInjectionEvidence: <中断点与无重复副作用结果>
executedChecks:
  - command: <验收命令>
    exitCode: <退出码>
tarballEvidence: <T12-06 提供>
remainingRisks:
  - <没有则写 none>
completionGate: passed | failed | blocked
```

缺少并发保护、孤儿收口、故障注入、静态门禁复核或终验证据时，不得把 T12 标记为完成。
