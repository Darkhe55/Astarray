# GUIDE-01-02 控制队列与安全点应用 — 证据

> 检查点：GUIDE-01-02（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：GUIDE-01-01（提交 `6414329`）。日期：2026-09-16
> 契约补充：docs/adr/0038-runtime-guidance-contract.md §10–16

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/runtime-guidance/guidance-control-queue.ts`（新） | 控制队列（校验复用 GUIDE-01-01 控制器）、普通报告通道（永不唤醒主 Agent）、安全点消费（幂等、过期/跨作用域丢弃）、唤醒策略查询、独立反馈进程投递桥（`instruction`/`success` 信封） |
| `packages/core/src/runtime/tool-loop.ts`（扩展） | 可选 `guidanceSafePointPort`：`before-model-call` 注入下一次模型输入；`before-tool-execution` 应用指导并在门禁档**阻止该次工具执行**（返回 `guidance-gate-requested-pause`）；`onGuidanceApplied` 观察点 |
| `tests/core/integration/guidance-safe-point.test.ts`（新，6 用例） | busy 期间即时应用、幂等、跨作用域/过期丢弃、门禁阻止工具、报告不唤醒、跨进程信封 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 指导要等整链结束才生效 | 第二次模型调用前即注入 | ✅ 工具执行期间入队的指导在 `before-model-call`（iteration 2）注入，`runtimeInputs[1]` 含 `[运行中指导 guide-1@1]`，随后循环才 success |
| 同一指导重复应用 | 只应用一次 | ✅ 二次入队返回 `recorded`；首次消费 applied=1，再次消费 applied=0，`listAppliedGuidance()` 仍 1 条 |
| 过期指导套用到任务 | 消费点丢弃 | ✅ 入队有效、消费时已过期 → `expired-at-safe-point` |
| 别的任务的指导被套用 | 丢弃 | ✅ `cross-scope-at-safe-point`，applied=0 |
| 门禁档只记录不拦工具 | 阻止该次工具调用 | ✅ `toolExecuteCount=0`，事件流出现 `toolCallFinished` + `errorCode="guidance-gate-requested-pause"` |
| 普通报告唤醒主 Agent | 仅排队 | ✅ `shouldWakeMainAgent=false`；`evaluateWakePolicy("report")` → `wakesMainAgent=false, isQueuedOnly=true`；控制通道 `isAppliedToRunningMissionAtSafePoint=true` |
| 跨进程投递混用通道/丢来源 | 通道与来源正确 | ✅ 指导 → `instruction`（幂等键 `guidance:guide-1@2`）、报告 → `success`（`report:report-1`），来源保留 `{sourceType:"user", sourceIdentifier:"user-1"}` |

**调试记录（诚实）**：门禁用例首版用 `toolExecuteCount===0` 作运行时分支条件，导致被门禁阻止后运行时又发一次工具调用；改用运行时迭代计数后通过——这是**测试脚手架**缺陷，不是实现缺陷（诊断脚本已删除）。

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/guidance-safe-point.test.ts tests/core/integration/runtime-guidance.test.ts` | 0；**14 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` / `npm run build` | 0 / 0 / 0 |
| `npx vitest run --maxWorkers=6`（等价 test 步骤） | **exit 0：201 文件 / 1639 用例全通过** |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：201 文件 / 1639 用例；全局 statements **93.45%** / branch **86.05%** / functions **92.34%** / lines **93.50%** |
| `git push` | **exit 0**：`56f0df6..04d6ff2`（含本检查点提交） |

**并行度与波动（重要）**：默认并行度下 `npm run check` / `npm run test:coverage` 本轮多次命中**不同**既有用例超时
（`provider-fake-server`、`run-command-gaps`、`cli-commands`、`gui-settings-recovery`、`gui-verification-decision`），
而把 worker 数降到 6 后同一份代码两次全量运行**均全通过**（201/1639）。
结论：波动来自并行资源竞争而非实现缺陷；后续轮次建议门禁使用 `--maxWorkers=6` 并在报告中注明。

**本轮架构守卫拦截（真阳性，已修）**：`tests/core/unit/public-sdk.test.ts` 报
`tool-loop.ts 不得引用 ../gui` —— 原因是新目录名 `core/src/guidance` 使导入路径含 `../guidance`，
被守卫的 `../gui` 子串匹配命中。修法是把目录更名为 `core/src/runtime-guidance`（未改守卫、未绕过），
并同步更新 ADR/证据中的路径引用。

## 5. 未满足项与后续

- GUIDE-01-03：长工具检查点与协作取消、回执收敛、旧完成声明失效、watchdog 不误续跑（本轮只做"工具执行前应用 + 门禁阻止"）。
- GUIDE-01-04：把控制队列接入真实 fork 反馈进程生命周期、公共应用/CLI/TUI 提交指导并查看接收/应用状态、安装包长任务中途改目标的实测与延迟记录。
- 未接入真实 Provider 在途插入（契约明确 `providerSupportsInFlightInsertion=false`）。