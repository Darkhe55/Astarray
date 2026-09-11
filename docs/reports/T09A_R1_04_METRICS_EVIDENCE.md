# T09A-R1-04 实际缓存与指标 · 证据

> 检查点：T09A-R1-04　状态：done（T09A-R1 卡四个检查点全部通过）
> 任务卡：`docs/tasks/T09A_R1_CONTEXT_RUNTIME_WIRING_TASK_CARD.md`；前驱：T09A-R1-03（done）
> 基线提交：`1689ccb`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 实现内容

| 文件 | 变更 |
|---|---|
| `context-runtime-metrics.ts` | 新增：原始装配事件 → 指标**纯函数复算**（metricsVersion / eventSchemaVersion / sampleSize / 明确分母 / 本地缓存命中与 token 估算 / 失效原因计数 / Provider usage 观察 / 样本限制说明） |
| `context-runtime-event-store.ts` | 新增：`context-runtime/events.jsonl` 追加与读取（损坏行跳过） |
| `context-prompt-assembler.ts` | 装配时发出真实事件：`cacheStatus`（hit/miss）+ `invalidationReason`（budget-policy-revision-change / effective-budget-change / global-records-change）+ 注入计数与 token 估算 |
| `application-runtime.ts` | 装配事件写入状态目录（产品运行即产证据） |
| `packages/tui/src/cli/commands.ts` + `cli.tsx` | 新增 `context metrics [--json]`：由事件复算并显示版本/样本/分母/本地命中率/Provider usage 状态/样本限制 |

## 2. 验收对应

| 验收项 | 证据 |
|---|---|
| 指标能复算 | `context-runtime-metrics.test.ts`：同一 fixture 两次复算 JSON 完全一致；版本/样本/分母断言 |
| 相同版本稳定复用、变化精准失效 | `context-runtime-cache-events.test.ts`：同一 provider 连续装配 → `miss, hit`；预算 revision 变更 → `miss` 且 `invalidationReason=budget-policy-revision-change` |
| 区分 Provider 缓存 usage 与本地缓存估算 | 指标对象分别给出 `providerCacheUsage`（本轮 `available=false` + 原因：适配器未请求 usage 字段）与 `localCacheEstimate`（由事件派生的本地估算） |
| 样本不足不虚报性能 | `percentageBenefitReportable=false` + `percentageBenefitNote`（“样本不足（< 10 次装配事件）：命中率可观察，但不得据此宣称百分比收益”） |
| 运行有版本/样本/分母/原始事件对照 fixture | 事件 JSONL 为原始事件；指标输出含 `metricsVersion`、`sampleSize`、`denominators`；CLI `context metrics` 直接展示 |
| 真实装配/回访事件 | 产品任务运行写入装配事件（测试断言事件存储可读且 `effectiveBudgetTokens=4096`）；回访事件沿用持久化回访账本与既有生命周期指标函数 |
| 恢复回归通过 | 恢复相关 5 套件（classification / checkpoint-store / identity-budget / checkpoint-schemas / fault-injection-recovery）**34 测试全通过** |

## 3. 命令与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 新增指标套件 | **0** | 4 通过 |
| 恢复回归（5 套件） | **0** | 34 通过 |
| `npm run check` | **0** | 165 文件 / 1441 测试全通过 |
| `npm run test:coverage` | **0** | 语句 93.81% / 分支 87.16% / 函数 91.36% / 行 93.88% |

## 4. 边界与后继

- Provider 侧缓存 usage 尚未采集（适配器未请求 `stream_options.include_usage`）；本轮如实标记 `unavailable` 并禁止用本地估算替代，可在 `T07D-R2-04`/`E2E-01` 接入真实 usage 后再对比。
- 生命周期指标（`computeContextLifecycleMetrics`）已有纯函数与测试；本轮未把生命周期事件写入同一 JSONL（需要时可在 `-04` 后续或 E2E-01 扩展）。
- T09A-R1 卡四个检查点全部通过，卡状态置 `done`。
