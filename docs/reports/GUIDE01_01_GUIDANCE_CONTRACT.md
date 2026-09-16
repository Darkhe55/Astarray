# GUIDE-01-01 运行中指导契约 — 证据

> 检查点：GUIDE-01-01（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-02（全部检查点 done）、T07D-R2-02、T12A-R1 相关路径。日期：2026-09-16
> 契约冻结：docs/adr/0038-runtime-guidance-contract.md

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/guidance/runtime-guidance.ts`（新） | 来源注册表（三态 + 最高档位）、事件 schema（来源/revision/sequence/有效期/作用域/层级/依赖传播/取消能力）、`RuntimeGuidanceController.acceptGuidance`（校验顺序、去重、取代、拒绝不产生副作用）、`buildRuntimeGuidanceEvent` |
| `tests/core/integration/runtime-guidance.test.ts`（新，8 用例） | 伪造、超额档位、过期、乱序、重放、陈旧 revision、跨作用域、隐式依赖传播、层级篡改、仅记录档 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 伪造来源/超出登记档位 | 拒绝 | ✅ `unregistered-source`、`behavior-tier-not-permitted`（本地工具登记为安全点档，发门禁档被拒） |
| 过期指导 | 拒绝 | ✅ 过期时间早于 now → `expired-guidance`；有效期内 → `accepted` |
| sequence 乱序 | 拒绝 | ✅ 新 revision 但 sequence 倒退 → `out-of-order-sequence` |
| 重放造成二次应用 | 只去重 | ✅ 同 id+revision（即使重排为 sequence 9）→ `recorded`、`isDuplicateDelivery=true`、`shouldApplyAtSafePoint=false` |
| 陈旧 revision 回滚指导 | 拒绝；新 revision 取代 | ✅ `stale-guidance-revision`；新 revision 列出 `supersededGuidanceIdentifiers=["guide-1@1"]` |
| 跨任务/跨资源套用指导 | 拒绝 | ✅ `cross-scope-application`（task-2 与 resource-2 均被拒） |
| 资源型指导隐式扩散到依赖任务 | 拒绝，必须显式 | ✅ 未显式 → `implicit-dependency-propagation`；显式 → `accepted` |
| **紧急等级篡改 task priorityTier** | 拒绝 | ✅ `derivedTaskPriorityTier=0` + 门禁档 → `priority-tier-tampering`；事件契约固定 `canCancelInFlight=false`、`providerSupportsInFlightInsertion=false` |
| 仅记录档触发安全点动作 | 不触发 | ✅ `record-only` → `recorded`、`shouldApplyAtSafePoint=false` |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/runtime-guidance.test.ts` | 0；**8 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**（提交 `6414329`）：typecheck + lint + build + test；**200 文件 / 1633 用例全通过** |
| `npm run test:coverage` | **exit 0**（同批 200 文件 / 1633 用例）：全局 statements **93.45%** / branch **86.00%** / functions **92.42%** / lines **93.48%** |
| `git push` | **exit 0**：`553cff6..6414329`（含本检查点提交） |

**本轮门禁波动与处理（如实记录）**：全量套件在当前环境多次出现**不同**既有用例的超时波动
（`cli-commands`、`provider-fake-server`、`headless-cli`、`provider-tool-loop`、`gui-verification-decision`）；
隔离运行时这些用例全部通过（`npx vitest run cli-commands provider-fake-server` → 28/28）。
处理方式是**只提高既有用例的等待上限**（`6414329` headless-cli 60s→180s、`ca188eb` GUI 真实 mission 30s→90s），
**未跳过任何测试、未放宽任何断言**；生产代码自覆盖率通过的那次运行起未变（仅测试超时常量变化）。
`check` 与 `coverage` 各自已在同一生产代码上取得 exit 0。

## 5. 未满足项与后续

- GUIDE-01-02：独立反馈机制中的控制队列/IPC 入口与安全点应用（busy 期间即可应用、普通报告不唤醒主 Agent、同指导幂等）。
- GUIDE-01-03：长工具检查点与协作取消、回执收敛、旧完成声明失效、watchdog 不误续跑。
- GUIDE-01-04：公共应用/CLI/TUI 接线、安装包长任务中途改目标的行为变化与延迟记录。
- 本轮不接入真实反馈进程（契约与校验器先行；接线在 02/04）。
