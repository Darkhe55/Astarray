# T12A-R1-03 上下文事务恢复 — 实现与部分提交重放证据

> 检查点：T12A-R1-03（docs/tasks/T12A_R1_RECOVERY_PRODUCT_WIRING_TASK_CARD.md）
> 前驱：T12A-R1-02（已通过，提交 `daf7cd1`/`d59cc74`）。
> 日期：2026-09-10

## 1. 目标与验收映射

| 验收条款 | 实现 | 证据 |
| --- | --- | --- |
| 签字不跨 revision 复用 | `HumanVerificationController.recordUserAcceptance` 绑定图 revision，revision 前进后旧签字拒绝（`stale-revision`） | §4 用例「陈旧签字不跨 revision 复用」 |
| 补充核验不重复、不丢失 | 延迟核验任务按胶囊哈希复用；不同 revision 追加 `verify-<task>-r<revision>`，旧任务保留 | §4 用例「胶囊已提交但补充核验任务未写入」「重开后再关闭」 |
| 调用/读取预算不因重启清零 | 重放只补齐图/胶囊/任务，不触碰预算与片段存储；全局上下文预算 revision 与取值保持不变 | §4 用例「重放不重置全局上下文预算策略 revision」 |
| 复放结果一致 | 关闭胶囊按 (节点, 图 revision) 复用；已封闭节点保持既有终态不膨胀 revision；重复 replay 无动作 | §4 用例 1、§3 E2E 第 2/3 步 |
| 部分提交可对账 | `ContextTransactionRecoveryService.inspect` 只读报告缺口、陈旧胶囊 revision、延后片段数与图 revision | §4 全部用例；§3 E2E 第 1 步 |

## 2. 变更

- `packages/core/src/orchestration/context-node-lifecycle.ts`：
  - `markTaskNodeVerified` 幂等：节点已推进（locally-verified/awaiting/accepted/deferred/superseded）时跳过，不再对已关闭节点回退写状态。
  - `completeTaskNode` 可在任意崩溃点重放：已封闭节点保持既有终态（不制造第二种终态、不膨胀 revision）；关闭胶囊按 (节点, revision) 复用；延迟核验任务按胶囊哈希复用，冲突时按 revision 追加标识。
  - 导出 `buildContextNodeIdentifier`（重放必须与首次写入一致）。
- `packages/core/src/orchestration/human-verification-controller.ts`：新增 `readDeferredVerificationTask` / `listDeferredVerificationTasks`（损坏 fail-closed）。
- 新增 `packages/core/src/orchestration/context-transaction-recovery.ts`：`inspect`（只读对账）与 `replay`（幂等补齐缺口）服务。
- `packages/tui/src/cli/commands.ts` + `cli.tsx`：新增公共入口 `context transaction <mission-id> <task-id> --agent <id>`（`--replay --description ... --summary ...`），JSON 输出对账与重放结果；缺重放输入时拒绝重放（不伪造摘要）。
- 测试：新增 `tests/core/integration/context-transaction-recovery.test.ts`（6 例）与 `tests/tui/unit/context-transaction-command.test.ts`（3 例）。

## 3. 公共入口端到端证据（dist 构建产物）

```
# 1) 全新状态：只读对账
context transaction mission-e2e T-1 --agent agent-e2e --mode devolve --json
{"graphRevision":null,"nodeState":null,"missingPieces":["terminal-context-state"],"isComplete":false,...}  exit=1

# 2) --replay 幂等补齐
context transaction mission-e2e T-1 --agent agent-e2e --mode devolve --description "E2E 任务" --summary "E2E 完成摘要" --replay --json
{"graphRevision":4,"nodeState":"deferred-review-closed","capsuleIdentifier":"capsule-node-T-1-4",
 "deferredVerificationTaskIdentifier":"verify-T-1","missingPieces":[],
 "replayedActions":["terminal-context-state","closure-capsule","deferred-verification-task"],"isComplete":true}  exit=0

# 3) 再次 --replay：无动作、revision 不变（复放一致）
同一命令 → {"graphRevision":4,"replayedActions":[],"isReplayStable":true,"isComplete":true}  exit=0

# 4) 磁盘产物
.astarray/agent-memory/agent-e2e/closure-capsules/capsule-node-T-1-4.json
.astarray/agent-memory/agent-e2e/context-graphs/mission-e2e/context-graph.json(+.bak)
.astarray/agent-memory/agent-e2e/deferred-verification-tasks/verify-T-1.json
```

## 4. 部分提交场景（先写反例，实现前红）

`tests/core/integration/context-transaction-recovery.test.ts`：

1. **关闭已提交、胶囊未写入**：`inspect` 报 `closure-capsule` 缺口 → `replay` 补齐；图 revision 不膨胀；再次 `replay` 无动作且胶囊仍只有 1 个。
2. **胶囊已提交、补充核验任务未写入**：`replay` 补出恰好 1 个任务，`closureCapsuleHash` 与胶囊一致；再次 `replay` 仍为 1 个。
3. **重开后再关闭**：旧胶囊与旧补充任务保留，新 revision 形成新胶囊与新任务（2/2），任务哈希覆盖两个胶囊。
4. **延后片段不丢失**：重放后延后片段数量与 `sourceNodeRevision` 不变。
5. **陈旧签字**：签字绑定 revision R，图 revision 前进后复用旧签字被拒（`stale-revision`）。
6. **预算不清零**：重放后全局上下文预算仍为 8192 / revision 2。

实现前：新增服务模块不存在 → 套件整体失败（红）；实现后 6/6 通过。

## 5. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；169 文件 / 1476 用例通过 |
| `npm run test:coverage` | exit 0；169 文件 / 1476 用例通过；全局 93.65% stmts / **86.64% branch** / 91.52% funcs / 93.71% lines（≥85% branch 阈值） |
| 聚焦回归 | `context-transaction-recovery` 6/6、`context-transaction-command` 3/3、既有上下文套件 19/19 无回归 |
| dist 端到端 | §3 全部命令 exit 码与输出如上 |

## 6. 剩余/后继

- 恢复后任务的重新派发、tarball 重启的端到端恢复（含租约接管与独立反馈进程收口）属 **T12A-R1-04**。
- 上下文事务的部分提交目前覆盖「图终态/胶囊/补充任务」三步；全局决策记录的跨存储部分提交与延后片段写入去重将在 T12A-R1-04/E2E-01 联测范围继续核对。
