# T09A-R1-03 关闭、人工验收与回访工具 · 证据

> 检查点：T09A-R1-03　状态：done
> 任务卡：`docs/tasks/T09A_R1_CONTEXT_RUNTIME_WIRING_TASK_CARD.md`；前驱：T09A-R1-02（done）
> 基线提交：`c900fa9`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 实现内容

| 文件 | 变更 |
|---|---|
| `context-node-lifecycle.ts` | 新增 `ContextNodeLifecycleController`：任务开始建节点 → 成功标记 locally-verified → 按人工验收策略关闭（Devolve：`deferred-review-closed` + 胶囊 + 层级 1 延迟核验任务）或等待（Assist：`awaiting-user-acceptance` + 等待胶囊，不自动通过） |
| `local-context-graph-store.ts` | 新增 `markNodeState`（CAS，已关闭不得回退）；**`accepted-closed` 额外要求 required 子节点也必须 `accepted-closed`** |
| `worker-agent.ts` / `mission-orchestrator.ts` / `main-controller.ts` / `application-runtime.ts` | 任务成功后在产品链中执行节点收口（模式键 assist/devolve 逐层透传） |
| `context-recall-controller.ts` | 新增 `ledgerPort`（持久化回执与任务级回访预算），`finishRecallResult` 改为异步写入 |
| `context-recall-ledger-store.ts` | 新增 `FileContextRecallLedgerStore`（`agent-memory/<调用者>/recall-ledger.json`） |
| `packages/tui/src/cli/commands.ts` + `cli.tsx` | 新增 `context recall --agent --graph --request <json> [--json]`（结构化回访控制面） |

## 2. 验收对应

| 验收项 | 证据 |
|---|---|
| 产品任务生成真实胶囊 | `tests/core/integration/context-node-lifecycle.test.ts`：Devolve 与 Assist 任务完成后 `ContextClosureCapsuleStore.listCapsules(owner)` 各 1 条，verificationState 分别为 `deferred-review-closed` / `awaiting-user-acceptance` |
| 层级 1+ 核验任务 | 同测试：`deferred-verification-tasks/verify-T-001.json` 存在且 `priorityTier=1`，绑定节点标识 |
| Assist 阻塞 / Devolve 延迟 | 同测试：Assist 节点停在 `awaiting-user-acceptance` 且**不生成**延迟任务；Devolve 节点关闭并生成延迟任务 |
| 重复回访回执 | `tests/tui/unit/context-recall-command.test.ts`：CLI 首次 `status: ok`；冷却期内再次调用返回 `repeat-receipt`（跨进程持久化账本） |
| 回访预算生效 | 同文件：`maximumRecallsPerTaskExecution=1` 时第二次 `refused`（`livelock-guard-triggered`）；既有 16 例 controller 测试回归通过 |
| 延迟子节点不得让祖先被误标为已人工验收 | `tests/core/unit/context-ancestor-verification-gate.test.ts`：required 子节点仅 `deferred-review-closed` 时父节点 `accepted-closed` 抛 `context-node-not-closable`；父节点可 `deferred-review-closed` 关闭 |
| 签字 revision / 否决重开 | 复用既有 `human-verification-controller` 能力（陈旧 revision 拒绝、否决重开节点与 disputed 决策、层级 1 返修提案），其单元测试随本轮 `npm run check` 全绿 |

## 3. 命令与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | **0** | 163 文件 / 1437 测试全通过 |
| `npm run test:coverage` | **0** | 语句 93.83% / 分支 87.24% / 函数 91.34% / 行 93.90% |

## 4. 边界与后继

- 本地关闭/验收/否决目前通过服务与控制面暴露；CLI 仅新增 `context recall`（关闭/签字/否决的 CLI 子命令可在 `-04` 一并补齐）。
- 延迟片段的自动重放仍走结构化回访；把延后片段作为下一任务默认输入不在本检查点范围。
- 实际缓存与 token 指标（`-04`）待执行。
