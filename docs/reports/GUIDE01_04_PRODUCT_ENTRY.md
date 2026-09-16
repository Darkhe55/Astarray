# GUIDE-01-04 公共入口、跨进程状态与 CLI — 证据

> 检查点：GUIDE-01-04（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：GUIDE-01-03（提交 `d80461c`，已推送）。日期：2026-09-16
> 契约补充：docs/adr/0038-runtime-guidance-contract.md §24–30

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/runtime-guidance/guidance-submission-journal.ts`（新） | 跨进程状态日志（原子写；提交记录 + 应用/丢弃 upsert；缺应用结果时如实标注未知） |
| `packages/core/src/runtime-guidance/guidance-control-queue.ts`（扩展） | 状态视图（`GuidanceStatusEntry`：queued/applied/dropped/superseded + 提交/应用时间 + 延迟）、`listGuidanceStatus`、状态变更回调（回写日志） |
| `packages/core/src/application/application-runtime.ts`（扩展） | 创建来源注册表/控制队列/长工具控制器/状态日志；队列透传到 MainController；暴露 `guidanceControlQueue`、`longToolCheckpointController`、`guidanceSubmissionJournal`、`authenticatedUserId` |
| `packages/core/src/orchestration/{main-controller,mission-orchestrator,worker-agent}.ts`（扩展） | 队列透传 + `buildWorkerGuidanceSafePointPort`（按任务绑定作用域）+ worker 把安全点端口交给 `runToolLoop` |
| `packages/core/src/public-sdk.ts`（扩展） | `submitRuntimeGuidance`（异步、落盘后受理）、`queryGuidanceStatus`（内存 + 日志合并）+ 公开 DTO |
| `packages/tui/src/cli/commands.ts` + `cli.tsx`（扩展） | `astarray guide submit/status` |
| 测试：`tests/core/integration/guidance-product-entry.test.ts`(2)、`tests/tui/integration/guide-cli.test.ts`(2) | 产品入口与 CLI |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 中途提交指导只是"记录"，行为不变 | 下一次模型调用前实际生效 | ✅ 任务运行到第一次迭代时提交指导，第二次迭代的 `toolResultMessages` 含 `[运行中指导 …]` 与指导文本（真实任务链、真实安全点） |
| 受理被当成已应用 | 状态诚实 | ✅ 内存队列状态为 `applied` 且 `latencyMilliseconds ≥ 0`；无进程消费时保持 `queued`、`latencyMilliseconds = null` |
| 换进程就查不到提交 | 跨进程可读 | ✅ 提交写入 `guidance/submissions.json`；**新 facade（新进程语义）** 读到 `queued`、`isApplicationStatusKnown=false` |
| 应用结果不落盘 | 新进程能读到 applied + 延迟 | ✅ 应用后新 facade 读到 `status=applied`、`isApplicationStatusKnown=true`、延迟 ≥ 0（应用进程 upsert 回写） |
| 指导改变主 Agent 工具权限 | 主 Agent 仍只读 | ✅ 提交前后 `getMainAgentToolProjection()` 完全一致 |
| 空指导/非法档位被接受 | 拒绝 | ✅ 空文本 → 用法错误 2 且队列无条目；CLI 非法档位 → 退出码 2 |

**调试记录（诚实）**：首版把"提交落盘"与"状态回写"都挂在队列回调上，导致回调以空文档回写、把刚写入的提交记录覆盖掉（日志为空）。修法：回调跳过 `queued`（提交由公共入口显式 await 落盘），应用/丢弃改为 upsert（日志中不存在时补记）。CLI 测试随即由 `no-guidance` 变绿。

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run`（guidance 全部套件 + 入口/CLI） | 0；**31 passed**（8+6+7+2+2+6 中的 guidance 相关） |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| 门禁（`--maxWorkers=6`）与推送 | 见 §5 |

## 4. 安装包与延迟记录

- CLI 在单进程调用下如实返回 `queued`（受理 ≠ 已应用）；应用延迟只在真实应用后由日志给出。
- 安装包内长任务中途改目标的端到端实测（需真实运行中的安装包进程 + 真实任务）**未执行**，属后续增量。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | **exit 0**（本地直接执行） |
| `npm run lint` | **exit 0**（本地直接执行） |
| 触及区域套件（`--pool=threads`，7 文件） | **exit 0：34 passed**（guidance 产物入口/安全点/契约/长工具 + guide CLI + 计量/缓存） |
| `npm run build` + `npx vitest run --maxWorkers=6` + `--coverage --maxWorkers=6` | **未完成**：升级执行两次均在审批通道等待 600s 超时（命令未执行） |
| `git push` | **未执行**（同一原因）→ 累积待推送 `5e5a644`（+ 本记录提交） |

说明：build/forks 池在受限沙箱下会 `spawn EPERM`，必须走升级审批；本轮审批通道不可用，故全量门禁与推送顺延到下一轮补跑。

## 6. 未满足项与后续

- 独立反馈进程的控制车道 IPC 接线（当前为同进程安全点 + 跨进程状态日志）。
- 长任务延迟 p50/p95 采样与安装包端到端实测。
- 与 2026-09-16 新增用户文档（AUTH-SCOPE 等）的权限域整合属后续检查点，本轮未触碰。
