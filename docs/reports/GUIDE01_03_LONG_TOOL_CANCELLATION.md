# GUIDE-01-03 长工具检查点与协作取消 — 证据

> 检查点：GUIDE-01-03（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：GUIDE-01-02（提交 `5a4de3d`）。日期：2026-09-16
> 契约补充：docs/adr/0038-runtime-guidance-contract.md §17–23

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/runtime-guidance/long-tool-checkpoint.ts`（新） | 执行世登记、长工具检查点回执、协作取消请求与检查点交付、回执驱动终态、未知停止结果、完成声明校验（epoch/已取消/未知）、旧请求收敛与后继承接、watchdog 决策、稳定错误 |
| `tests/core/integration/long-tool-checkpoint.test.ts`（新，7 用例） | 检查点应用指导、取消仅检查点交付、停止后完成声明无效、未知停止结果 blocked、旧世声明失效、收敛与承接、watchdog 不误续跑 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 长工具中途指导要等工具结束才生效 | 检查点即时消费并出回执 | ✅ `runCheckpoint` 回执含 `appliedGuidanceIdentifiers=["guide-long-tool"]`、序号 1、耗时 60000ms |
| 取消请求被当成"已停止" | 仅 `requested`，交付到检查点 | ✅ 请求后状态 `requested`、`deliveredAtCheckpointCount=0`；检查点回执交付该请求，状态仍为 `requested` |
| 停止后迟到的完成声明被接受 | 拒绝 | ✅ `acknowledgeCancellation(stopped)` 后 `declareToolCompletion` → `rejected-cancelled` |
| 停止结果未知却按成功处理 | `unknown-stop-outcome` + blocked | ✅ 超过观察窗口 → 状态 `unknown-stop-outcome`，完成声明同判 `unknown-stop-outcome` 且理由含 blocked |
| 旧执行世的迟到声明计入成功 | `stale-epoch-invalidated` | ✅ 执行世 2 生效后声明世 1 → 失效，理由含"旧执行世" |
| 新指导沿用旧取消请求 | 收敛 + 承接最新 revision | ✅ 旧请求 `superseded` 且 `supersededByRequestIdentifier` 指向后继；后继 `instructionRevision=2`、`requested`、未交付 |
| watchdog 用旧指令/未收敛取消续跑 | 一律不续跑 | ✅ 无取消 → `shouldResume=true`；已停止 → `cancellation-active`；超时未回执 → `unknown-stop-outcome`（并把请求推进为该状态）；未登记工具调用抛 `unknown-tool-call` |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run`（guidance 三套件） | 0；**21 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| 门禁（`--maxWorkers=6`）与推送 | 见 §4 |

## 4. 门禁与推送

（本轮复跑后回填。）

## 5. 未满足项与后续

- GUIDE-01-04：公共应用/CLI/TUI 提交指导并查看接收/应用状态；检查点回执写入工作存档；安装包长任务中途改目标的实测与延迟记录。
- 真实 Provider 在途取消仍不实现（契约固定 `providerSupportsInFlightInsertion=false`）。
- 回执持久化（崩溃后仍可对账）属 EVENT-01 的对账范围。
