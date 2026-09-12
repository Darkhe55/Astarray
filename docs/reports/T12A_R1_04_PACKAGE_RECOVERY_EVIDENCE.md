# T12A-R1-04 安装包恢复与进程收口 — 实现与跨进程/隔离安装证据

> 检查点：T12A-R1-04（docs/tasks/T12A_R1_RECOVERY_PRODUCT_WIRING_TASK_CARD.md）
> 前驱：T12A-R1-03（已通过，提交 `e826e12`/`d4d6083`）。
> 日期：2026-09-10

## 1. 目标与验收映射

| 验收条款 | 实现 | 证据 |
| --- | --- | --- |
| 至少一条恢复任务真正完成产物 | 新增 `MainController.resumeMission(missionId)`：读取持久化任务链的未完成任务，按原 mode 重新调度同一 mission（不新建 mission）；`recover resume --execute` 在对账通过后调用它并等待终态 | §3 隔离安装 E2E（status=done、1 个任务完成、work-archive/胶囊落盘）；§4 进程内 4 例 |
| 另一进程恢复并查询最终结果 | 恢复由第二个进程执行；第三个进程 `status` 查询到 done 与任务链 | §3 tarball E2E；§4 跨进程集成 2 例 |
| 租约接管 | 过期租约显式 `takeOverExpiredLease` 后释放，让续接会话取得新租约；运行期由编排器持有并按半周期续约、结束释放 | §3 `leaseTakeoverPerformed=true` 且事后无活动租约；§4 集成用例 |
| 无孤儿进程 / 无双调度 | 执行前检查活动租约（其他进程持有 → `mission-locked` 拒绝，不改写状态、不产生产物）；CLI 每次调用结束即退出，编排器 finally 释放租约 | §4「其他进程持有活动租约 → 拒绝双跑且不执行」；§3 调用后无遗留活动租约 |
| 退出/取消 | `cancel` 置 cancelled；`recover resume` 对已终态 mission 返回 `mission-already-terminal` 裁决且不执行 | §4「已取消 mission → mission-already-terminal」 |
| 不确定任务有可操作裁决 | 无可信检查点 → `checkpoint-not-found`，状态不变、不执行 | §4「无可信检查点 → 不执行」 |

## 2. 变更

- `packages/core/src/orchestration/main-controller.ts`：新增 `resumeMission(missionId)`（真正续接既有 mission；Ponder 拒绝；无未完成任务幂等返回）。
- `packages/tui/src/cli/commands.ts`：
  - `executeRecoverResumeCommand` 新增 `isExecutionRequested`（`--execute`）：双跑门禁 → T12A 对账 → 过期租约接管 → 续接执行 → 等待终态并回报 `status`/`leaseTakeoverPerformed`/`completedTaskCount`。
  - **缺陷修复**：`executeResumeCommand` 原先用 `handleUserMessage("恢复任务 <id>")` 重派发，实际会新建一个 mission 而原 mission 永不推进；现改用 `controller.resumeMission(missionId)`。
- `packages/core/src/orchestration/recovery-center-controller.ts`：resume 增加终态门禁（done/cancelled → 新裁决类型 `mission-already-terminal`）。
- `packages/tui/src/cli.tsx`：`recover resume` 注册 `--execute`。
- 测试：新增 `tests/tui/unit/recover-resume-execute.test.ts`（4 例，进程内真实执行）与 `tests/tui/integration/recovery-process-handoff.test.ts`（2 例，构建产物跨进程）。

## 3. tarball 隔离安装端到端证据

`npm pack`（prepack 触发 `npm run check`）→ `scripts/verify-package.mjs` → 隔离项目 `npm install <tarball>`：

```
tarball=astarray-0.1.0.tgz
打包校验通过: 201 个文件，shebang/BOM 正确，反馈进程入口已包含   (verify exit=0)
added 41 packages in 12s                                          (install exit=0)
astarray doctor --json                                            (exit=0)

# 由“崩溃进程”留下的磁盘状态：blocked mission + 未完成任务 + 可信检查点 + 过期租约
astarray recover list --json
{"missions":[{"missionIdentifier":"mission-tarball","status":"blocked","pendingTaskCount":1,
  "hasTrustedCheckpoint":true,"leaseProcessInstanceId":"crashed-process","isLeaseActive":false}],...}

# 第二个进程恢复
astarray recover resume mission-tarball --execute --json
{"resumed":true,"executed":true,"status":"done","leaseTakeoverPerformed":true,
 "completedTaskCount":1,"blockedDecisionItems":[],...}                (exit=0)

# 第三个进程查询最终结果
astarray status mission-tarball --json
{"status":"done","tasks":[{"id":"T-001","status":"done","assignedAgentId":"worker:mission-tarball:T-001"}]}  (exit=0)

# 产物
.astarray/missions/mission-tarball/{summary.json,task-chain.json,task-chain.json.bak}
.astarray/missions/mission-tarball/agents/worker~003amission-tarball~003aT-001~003a1/work-archive.json
.astarray/agent-memory/worker~003amission-tarball~003aT-001~003a1/closure-capsules/capsule-node-T-001-4.json
.astarray/agent-memory/worker~003amission-tarball~003aT-001~003a1/context-graphs/mission-tarball/context-graph.json(+.bak)
```

## 4. 跨进程与进程内测试

`tests/tui/integration/recovery-process-handoff.test.ts`（构建产物，独立进程）：
1. 第二个进程接管过期租约 → 完成 mission（done / 1 任务 / work-archive）→ 第三个进程 `status` 读到 done；事后租约非活动。
2. 其他进程持有**活动**租约 → 第二个进程返回非零并打印 `mission-locked`；mission 仍为 blocked；未产生 `agents/` 产物（无未确认写入）。

`tests/tui/unit/recover-resume-execute.test.ts`（进程内，同样走 CLI 公共入口）：
1. 过期租约 → 接管并真正完成（status=done、任务全 done、work-archive 存在、租约释放）。
2. 活动租约 → 拒绝且不执行。
3. 已取消 mission → `mission-already-terminal`，不执行。
4. 无可信检查点 → `checkpoint-not-found`，状态不变、不执行。

## 5. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；171 文件 / 1482 用例通过 |
| `npm run test:coverage` | exit 0；171 文件 / 1482 用例通过；全局 93.72% stmts / **86.62% branch** / 91.6% funcs / 93.76% lines（≥85% branch 阈值） |
| `npm pack` + `scripts/verify-package.mjs` | exit 0（201 文件；无 .env/.astarray/日志/测试；shebang 无 BOM；含反馈进程入口） |
| 隔离安装 + CLI E2E | install exit 0；resume exit 0；status exit 0（§3） |

首次覆盖率运行出现 2 个已知高负载偶发失败（`provider-tool-loop`、`run-command-gaps` 的 streamOutput 用例），复跑 171/1482 全绿；`npm run check` 全程未复现。

## 6. 剩余/后继

- 真实 Provider 凭据与费用授权仍缺（T07D-R2-04 blocked）；本检查点使用脚本化运行时与 tarball 隔离安装完成证据。
- T12A-R1 四个检查点全部通过；后续进入 **E2E-01（独立工作流验收）**，再按顺序做 BRIDGE-01、GUI-01-R、WB-00。
