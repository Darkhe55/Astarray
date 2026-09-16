# ACCURACY-03 设置、预算与产品入口 — 证据

> 检查点：ACCURACY-03（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md，未跟踪用户文件）
> 前驱：ACCURACY-02（提交 `8e99b76` 已推送）。日期：2026-09-16
> 契约补充：docs/adr/0040-accuracy-tiers-budget-and-skip-status.md §17–25

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/orchestration/accuracy-policy-store.ts`（新） | `AccuracyPolicyStore`（`<state>/settings/accuracy.json`，revision CAS，默认标准档 + 有限预算，Agent 降级/关闭拒绝）、`FileAccuracyAttemptJournal`（跨进程幂等）、`FileAccuracyVerificationAuditLog`、`AccuracyBudgetTracker`（额度从审计恢复）、`AccuracyCompletionGate`（策略 → 幂等 → 预算 → ACCURACY-02 校验层） |
| `packages/core/src/application/application-runtime.ts` | 装配并暴露 `accuracyPolicyStore` / `accuracyAttemptJournal` / `accuracyVerificationAuditLog` |
| `packages/core/src/public-sdk.ts` | 公共入口 `queryAccuracyPolicy` / `configureAccuracyPolicy` / `verifyTaskCompletion` / `queryAccuracyVerificationAudit` + 公开 DTO + ACCURACY 导出块 |
| `packages/tui/src/cli/commands.ts` + `cli.tsx` | `astarray accuracy status` / `accuracy configure`（经公共门面，`--tier/--enable/--disable/--max-model-calls/--max-wall-clock-ms/--expected-revision/--json`） |
| `tests/core/integration/accuracy-policy-gate.test.ts`（新，7 用例） | 默认策略与跨进程可见、Agent 降级拒绝、过期 revision、任务级覆盖、关闭不调用验收端口、预算耗尽、快速档、跨进程幂等/预算恢复 |
| `tests/core/integration/accuracy-product-entry.test.ts`（新，6 用例） | 公共入口配置跨进程可见、关闭不新增校验层/人工阻塞且权限路由不变、严格档通过 + 跨进程重放、错收件人/缺条目/陈旧产物/缺理解确认拒绝、任务级覆盖、陈旧 revision 不落盘 |
| `tests/tui/integration/accuracy-cli.test.ts`（新，3 用例） | status/configure 默认与持久化、非法档位用法错误、关闭状态如实输出、陈旧 revision 失败不覆盖 |

## 2. 行为反例（红→绿，全部通过）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| Agent 请求降级档位 | 拒绝 | ✅ `accuracy-tier-downgrade-rejected` |
| Agent 请求关闭检查 | 拒绝 | ✅ `accuracy-tier-downgrade-rejected` |
| 用过期 revision 并发配置 | 拒绝且不落盘 | ✅ `accuracy-policy-stale-revision`；后续读取仍为 strict r2 |
| 关闭后仍发起校验层 | 不调用任何验收端口 | ✅ 端口桩"被调用即抛错"未触发；审计 `isVerificationLayerInvoked=false` |
| 关闭被写成通过 | 独立状态 | ✅ `quality-check-skipped(accuracy-disabled)`，文案"不等于测试/验收通过" |
| 关闭新增人工阻塞 | 不产生待核验任务 | ✅ 配置前后 `listPendingVerifications()` 均为空 |
| 配置改变权限路由 | 权限组不变 | ✅ 配置前后 `getCurrentPermissionProfileReference()` 相等 |
| 标准档无限次模型审查 | 预算耗尽后记录不足 | ✅ 第 2 次 `quality-check-budget-exhausted`（审计 true→false） |
| 重启后预算被重置 | 从审计恢复额度 | ✅ 新进程首次调用即耗尽 |
| 快速档被写成通过 | 独立状态 | ✅ `quality-check-skipped(tier-fast)`；错收件人仍拒绝 |
| 重复派发重复副作用 | 幂等且不耗预算 | ✅ 同 attemptId → `isIdempotentReplay=true`，跨进程命中，重放不新增校验层记录 |
| 任务级覆盖影响其他任务 | 只影响被点名任务 | ✅ `task-fast` → fast，其余 strict |
| 严格档缺理解确认 | 拒绝 | ✅ `understanding-confirmation-missing` |
| CLI 非法档位 | 用法错误（退出码 2） | ✅ `非法准确性档位：sloppy` |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/accuracy-policy-gate.test.ts tests/core/integration/accuracy-product-entry.test.ts` | 0；**13 passed** |
| `npx vitest run tests/tui/integration/accuracy-cli.test.ts` | 0；**3 passed** |
| `npm run typecheck` / `npx eslint .` / `npm run build` | 0 / 0 / 0 |

## 4. 设计边界（不重复实现已有能力）

- 本模块是**既有完成门禁之上的校验层与设置面**：不替换 `CompletionControlParser`、
  不替换 worker 完成门禁、不替换 `EvidenceBundleBuilder`、不改变权限组与范围授权判定。
- 幂等判定**优先于**预算消耗：重放不消耗额度、不再次进入校验层。
- 真实 Provider 下的模型审查调用端口由后续接线注入；本轮不声称真实模型审查成本已测。
- 增量 E2E 以"关闭 ⇒ 无新增模型审查/人工阻塞且状态诚实""标准/严格档有上界"
  "跨进程幂等""权限路由不变"为断言；真实 Provider 端到端成本/时延仍待外部凭据（E2E-01）。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / `npx eslint .` / `npm run build` | **0 / 0 / 0** |
| `npx vitest run --maxWorkers=6` | **exit 0：210 文件 / 1695 用例全通过**（新增 3 文件 / 16 用例） |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：全局 statements **93.34%** / branch **85.62%** / functions **92.45%** / lines **93.39%**；`core/src/orchestration` **94.17 / 87.32 / 94.08 / 94.22**；新增模块 `accuracy-policy-store.ts` **96.80 / 85.89 / 100 / 96.80** |
| `npm run verify:security-coverage` | **exit 0：关键安全模块 22/22 达标（阈值 95%）** |
| `git push` | **exit 0**（第 3 次尝试成功，前两次审批通道停滞）：`8e99b76..b4f2f26` 已推送 |

本检查点实现提交：`b4f2f26`（`feat(accuracy): ACCURACY-03 档位/预算设置、组合门与产品入口`）。

## 6. 未满足项与后续

- 真实 Provider 成本/时延 E2E、GUI/TUI 交互式档位设置界面仍未接入（外部凭据与 UX 依赖）。
- 治理文档统一修订（AGENTS.md 安装/外部软件条款、测试预期、权限目录、CLI/TUI 文案）仍未开始。
- 按新用户文档推荐顺序，其后为 GIT-PRESERVE-01/02/03、READ-FORMAT-01..05、GUIDE 增量。
