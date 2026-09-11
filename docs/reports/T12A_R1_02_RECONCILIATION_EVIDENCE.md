# T12A-R1-02 副作用与权限对账 — 实现与重启对账证据

> 检查点：T12A-R1-02（docs/tasks/T12A_R1_RECOVERY_PRODUCT_WIRING_TASK_CARD.md）
> 前驱：T12A-R1-01（已通过，提交 `7582dad`/`dcb0288`）。
> 日期：2026-09-10

## 1. 目标与验收映射

| 验收条款 | 实现 | 证据 |
| --- | --- | --- |
| 重启先只读对账 | `RecoveryCenterController.reconcileCheckpoint`：检查点声明 Git/worktree 状态时，恢复前先跑 `ReadonlyReconciliationService`（只读） | §4 单测 15 例；§3 E2E resume |
| 未知副作用 blocked、不二次执行 | 非幂等 `result-unknown` → `blocked-uncertain-side-effect`；已确认幂等调用只进 `recoveredSafeNodes`（复用，不重跑） | 单测「after-tool-execution-before-persistence…」；E2E `tc-confirmed` 复用 + `tc-unknown` blocked |
| 旧一次性授权/临时提升不自动延续 | `reauthorizationRequiredTypes` 恒含 `session-elevation`/`installation-allow-once`/`backup-deletion`（检查点无权限引用时再加 `session-authorization`），仅上报不静默放行 | 单测「旧一次性授权/临时提升始终要求重新授权」；E2E 输出 |
| 原任务历史保持 | resume/abandon 均不删除 mission 目录、任务链与摘要（abandon 只改状态） | 单测「resume 与 abandon 都不删除任务链历史」；CLI 测试断言任务链仍在 |
| 接手 Agent 新身份有明确 handoff | 已回收/关闭 Agent → 新 `agentInstanceId` + `handoff-from-*`，`requiresHandoffIdentity=true` | T12A-R1-01 单测「已回收 Agent → 需新身份 + handoff」 |
| 未决冲突不覆盖人工变化 | `pendingConflictIdentifiers` 非空 → 阻断（`blocked-reconciliation-discrepancy`） | 单测「未决冲突 → blocked」 |

## 2. 变更

- `packages/core/src/orchestration/recovery-checkpoint-schemas.ts`：新增**可选** `gitStateRecovery`（targetBranchName / targetHeadCommitIdentifier / expectedDirty / expectedWorktreeIdentifiers）。旧检查点无该字段仍合法（向后兼容）。
- 新增 `packages/core/src/orchestration/recovery-reconciliation-ports.ts`：
  - `createLocalGitStatusPort`：受控 `GitProcess` 只读执行 `git status --porcelain=v1 --branch` + `git rev-parse HEAD`；无 `.git`、git 不可用或失败 → 抛 `ReconciliationStateUnavailableError`（调用方 fail-closed）。
  - `createLocalWorktreeExistencePort`：按 `<base>/git-worktrees/...` 真实检查目录存在性。
  - `createLocalHumanChangeObservationPort`：读取 `<base>/human-change-journal/*.json` 中 revision 最大的一条（只读；单条损坏跳过）。
- `RecoveryCenterController`：新增 `reconciliationPorts` 选项与 `reconcileCheckpoint`；resume 结果新增 `reconciliation` 与 `feedbackReplayEnqueueRange`；view 新增 `reconciliationRequired`；新增裁决类型 `blocked-reconciliation-discrepancy` / `blocked-reconciliation-unavailable`。
- `packages/tui/src/cli/commands.ts`：恢复中心装配真实 Git 只读端口（工作区 = `process.cwd()`）；JSON 输出含 `reconciliation`、`feedbackReplayEnqueueRange`、`reconciliationRequired`。
- 测试：新增 `tests/core/unit/recovery-center-reconciliation.test.ts`（15 例）与 `tests/support/recovery-checkpoint-fixture.ts`；`t12a06-cli-wiring.test.ts` 新增两条对账命令用例并把 `readonly-reconciliation-service`/`recovery-reconciliation-ports` 加回 bundle 可达性清单。

## 3. 公共入口端到端证据（dist 构建产物）

临时工作区（cwd 无 `.git`）+ 磁盘上写入声明 Git 状态的检查点：

```
recover list --json
{"recoveryCenterReady":true,"missions":[{"missionIdentifier":"mission-reconcile","exists":true,
  "reconciliationRequired":true,"status":"blocked","isCorrupted":false,...,
  "hasTrustedCheckpoint":true,...}],"requiresDecisionMissions":["mission-reconcile"],...}
exit=0

recover show mission-reconcile --json
{"missionIdentifier":"mission-reconcile","exists":true,"reconciliationRequired":true,
 "status":"blocked","hasTrustedCheckpoint":true,...}  exit=0

recover resume mission-reconcile --json
{"missionIdentifier":"mission-reconcile","resumed":false,
 "recoveredSafeNodes":["tc-confirmed"],
 "blockedDecisionItems":[
   {"item":"tc-unknown","decision":"blocked-uncertain-side-effect","reason":"工具副作用未知，需用户裁决，禁止自动二次执行"},
   {"item":"git-state-unavailable","decision":"blocked-reconciliation-unavailable","reason":"无法只读读取 Git 状态；未对账前不得继续恢复"}],
 "reauthorizationRequiredTypes":["session-elevation","installation-allow-once","backup-deletion"],
 "reconciliation":{"required":true,"gitStateAvailable":false,"isReadonlyConfirmed":false,
   "isSafeToProceed":false,"requiresHumanChangeReconciliation":false,"discrepancies":[]},
 "feedbackReplayEnqueueRange":{"fromEnqueueCursor":3,"toEnqueueCursor":3},
 "requiresUserDecision":true}
exit=1

# summary.json 保持 blocked（未因恢复尝试被改写）
{"missionId":"mission-reconcile","schemaVersion":1,"createdAtIso":"2026-09-10T00:00:00.000Z",
 "mode":"assist","prompt":"e2e","status":"blocked"}
```

即：Git 状态不可读时 fail-closed，绝不按“无差异”继续恢复；已确认调用复用而非重跑；一次性授权要求重新授权。

## 4. 五类中断点的产品恢复路径（单测）

`tests/core/unit/recovery-center-reconciliation.test.ts` 针对 T12A-07 的五个中断点逐个走**恢复中心**（而非仅分类服务）：

| 中断点 | 恢复中心结论 |
| --- | --- |
| `before-task-write` | 无未决项 → `resumed=true`，状态置 `running`；无反馈重放范围 |
| `after-tool-execution-before-persistence` | `tc-unknown` blocked，`tc-confirmed` 复用（不出现在裁决列表 → 不二次执行） |
| `after-feedback-deliver-before-ack` | 只重放 ack 之后范围 `{from:3,to:3}` |
| `mid-provider-stream` | 停止未确认 → `blocked-provider-state-unknown` |
| `before-git-merge` | Git 漂移 → `blocked-reconciliation-discrepancy` |

其余对账用例：分支变化、离线人工变化（revision 更新）、worktree 缺失、Git 状态不可读、未决冲突、worktree 存在、list/show 对账标记、权限重新授权、历史保留。

## 5. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；167 文件 / 1467 用例通过（含 dist bundle 可达性） |
| `npm run test:coverage` | exit 0；167 文件 / 1467 用例通过；全局 93.62% stmts / **86.75% branch** / 91.34% funcs / 93.69% lines（≥85% branch 阈值） |
| 聚焦回归 | `recovery-center-reconciliation` 15/15、`t12a06-cli-wiring` 11/11、`recover-center-commands` 7/7 |
| dist 端到端 | §3 全部命令 exit 码与输出如上 |

## 6. 剩余/后继

- 检查点生产端（写 `gitStateRecovery`）目前无产品调用点：真实运行链路在写入检查点时应记录目标分支/HEAD/worktree；属 T12A-R1-03/-04 与 E2E-01 联测范围。
- 恢复后任务重新派发、Git 合并前中断的真实端到端恢复（tarball 重启）属 T12A-R1-04。
- `reconciliation` 目前只读不写：对账阶段不产生任何文件变更（`isReadonlyConfirmed` 恒 true）。
