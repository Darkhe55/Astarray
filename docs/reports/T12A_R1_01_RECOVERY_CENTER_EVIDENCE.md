# T12A-R1-01 恢复命令到应用服务 — 实现与入口证据

> 检查点：T12A-R1-01（docs/tasks/T12A_R1_RECOVERY_PRODUCT_WIRING_TASK_CARD.md）
> 前驱：T07D-R1（应用装配）已通过；本轮只执行本检查点，不领取后继。
> 日期：2026-09-10

## 1. 目标与验收映射

| 验收条款 | 实现 | 证据 |
| --- | --- | --- |
| 状态反映磁盘/日志/租约 | `RecoveryCenterController.listMissions/inspectMission` 组合 `MissionManager.probeMissionDirectory`（磁盘）与 `MissionLeaseStore.readLeaseSummary`（租约） | 单测 1/2；E2E §3 list/show |
| 损坏状态不静默重建成功 | 摘要/任务链损坏 → `blocked-state-corrupted`，**不**写回文件；损坏 mission 在 list 中 `isCorrupted=true` 并进入 `requiresDecisionMissions` | 单测「摘要损坏 → blocked-state-corrupted，且不重写损坏文件」；E2E show mission-broken |
| abandon 保留产物 | `abandonMission` 只把 summary 状态置 `cancelled`，不删除任何文件 | 单测「状态置 cancelled，任务链与摘要文件保留」；E2E abandon + summary 回读 |
| resume 不是固定文案或纯分类结果 | resume 真实读最近可信检查点（`selectLatestTrustedCheckpoint`），据此做本地确定性分类 + 身份/预算恢复，并按结果**改写 mission 状态**或返回逐项裁决 | 单测 3 条路径（无检查点 / 可信检查点 → running / 非幂等未知 → blocked）；E2E resume |

## 2. 变更

- 新增 `packages/core/src/orchestration/recovery-center-controller.ts`：
  - `listMissions()` / `inspectMission(missionId)`：只读，返回 mission 磁盘状态、损坏标记、未完成任务数、可信检查点可用性、租约归属与活跃性。
  - `resumeMission(missionId)`：损坏 → 阻断；无可信检查点 → `checkpoint-not-found`；有检查点 → `RecoveryClassificationService.classifyRecovery` + `RecoveryIdentityAndBudgetService.recoverIdentityAndBudget`（新身份 + handoff、ready set 重算、预算恢复）；仅当无阻断项时把状态置 `running`。一次性授权不随恢复延续，作为 `reauthorizationRequiredTypes` 显式上报（与分类服务 `hasBlockingItems` 口径一致，不伪装成阻断或静默放行）。
  - `abandonMission(missionId)`：置 `cancelled` 并回读状态，明确 `artifactsRetained: true`。
- `packages/tui/src/cli/commands.ts`：`recover list/show/resume/abandon` 由占位实现改为调用上述控制器；resume 请求被阻断时返回失败退出码。
- `packages/tui/src/cli.tsx`：注册 `recover` 命令组（此前四个命令函数**未**注册，属不可达代码）。
- 测试：`tests/tui/unit/recover-center-commands.test.ts`（新增，7 例）；`tests/tui/unit/t12a06-cli-wiring.test.ts`（改为带状态目录的真实契约；bundle 可达性清单记录 `readonly-reconciliation-service` 留给 T12A-R1-02）。

## 3. 公共入口端到端证据（dist 构建产物）

命令在临时目录执行（`defaultStateDirectory()` = `<cwd>/.astarray`），磁盘上预置 `mission-e2e`（status=blocked）与 `mission-broken`（summary 为 `{ not json`）：

```
node dist/cli.js recover list --json
{"recoveryCenterReady":true,"missions":[
  {"missionIdentifier":"mission-broken","exists":true,"status":null,"isCorrupted":true,"pendingTaskCount":null,"hasTrustedCheckpoint":false,"leaseProcessInstanceId":null,"isLeaseActive":false},
  {"missionIdentifier":"mission-e2e","exists":true,"status":"blocked","isCorrupted":false,...}],
 "requiresDecisionMissions":["mission-broken","mission-e2e"], ...}
exit=0

node dist/cli.js recover show mission-e2e --json
{"missionIdentifier":"mission-e2e","exists":true,"status":"blocked","isCorrupted":false,...}  exit=0

node dist/cli.js recover show mission-broken --json
{"missionIdentifier":"mission-broken","exists":true,"status":null,"isCorrupted":true,...}  exit=0

node dist/cli.js recover resume mission-e2e --json
{"missionIdentifier":"mission-e2e","resumed":false,"recoveredSafeNodes":[],"readySetTaskNodeIdentifiers":[],
 "requiresHandoffIdentity":false,"identityRecoveries":[],
 "blockedDecisionItems":[{"item":"checkpoint-not-found","decision":"checkpoint-not-found",...}],
 "requiresUserDecision":true}
exit=1   # 非交互不得默认允许

node dist/cli.js recover abandon mission-e2e --json
{"missionIdentifier":"mission-e2e","abandoned":true,"artifactsRetained":true,"statusAfter":"cancelled",...}  exit=0

# 回读 summary.json（文件保留，仅状态变更）
{"prompt":"e2e","mode":"assist","createdAtIso":"2026-09-10T00:00:00.000Z","status":"cancelled","schemaVersion":1,"missionId":"mission-e2e"}
```

可见：list/show 的输出完全来自磁盘状态与租约读取；resume 依据检查点是否存在返回不同结果（非固定文案）；abandon 保留产物。

## 4. 行为反例（先写后实现）

`tests/tui/unit/recover-center-commands.test.ts`：

1. list 反映磁盘真实状态与损坏标记（`isCorrupted`、`requiresDecisionMissions`）。
2. 摘要损坏 → `blocked-state-corrupted` 且损坏文件字节不变（不重建成功）。
3. 无可信检查点 → `checkpoint-not-found` 且 mission 状态保持 `blocked`。
4. 存在可信检查点 → `resumed=true` 且状态真正变为 `running`；`reauthorizationRequiredTypes` 含 `session-authorization`。
5. 已回收 Agent → `requiresHandoffIdentity=true`，新 `agentInstanceId` + `handoff-from-*`，ready set 仅含前驱完成的节点（`["task-ready"]`）。
6. 非幂等工具结果未知 → `blocked-uncertain-side-effect`，安全节点仍上报（`["call-confirmed"]`），状态不变。
7. abandon → 状态 `cancelled`，任务链与摘要文件保留。

以上 7 例在实现前全部失败（5 例首批反例 + 后续断言的占位实现差异），实现后全部通过。

## 5. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check`（typecheck+lint+build+test） | exit 0；166 文件 / 1450 用例通过 |
| `npm run test:coverage` | exit 0；166 文件 / 1450 用例通过；全局 93.77% stmts / **86.96% branch** / 91.32% funcs / 93.84% lines（≥85% branch 阈值） |
| 聚焦回归（plain 配置） | `recover-center-commands` 7/7、`t12a06-cli-wiring` 9/9 |
| dist 端到端 | §3 全部命令 exit 码与输出如上 |

说明：`npm run test:coverage` 在沙箱受限模式下不可运行，已按仓库既有升级流程以完整访问权限执行；两次运行中出现过一次真实 I/O 用例在高负载下的偶发超时（`context-runtime-cache-events` 与 `run-command-gaps`），复跑全绿，属既有并行负载抖动，未改测试逻辑。

## 6. 剩余/后继

- `readonly-reconciliation-service`（副作用与权限对账）尚未接线，属 **T12A-R1-02** 范围；bundle 可达性清单已注明在该检查点加回。
- resume 目前按检查点重算 ready set 与新身份，但尚未把恢复后的任务重新派发给运行中的编排器（属后续检查点与 E2E-01 联测范围）。
- 真实 Provider / Node 20 / 跨平台证据仍待 E2E-01。
