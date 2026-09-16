# ACCURACY-02 幂等签收与条目→证据覆盖 — 证据

> 检查点：ACCURACY-02（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md，未跟踪用户文件）
> 前驱：ACCURACY-01（审计与冻结，提交 `36c27e3` 已推送）。日期：2026-09-16
> 契约补充：docs/adr/0040-accuracy-tiers-budget-and-skip-status.md §9–16

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/orchestration/task-accuracy-verifier.ts`（新） | `TaskAccuracyVerifier`（幂等签收 + 收件人/版本校验 + 证据真实性与陈旧产物 + 必需条目覆盖 + 理解确认 + 快速档独立状态）、`InMemoryAccuracyAttemptJournal`（可替换为持久化实现） |
| `tests/core/integration/task-accuracy-verifier.test.ts`（新，10 用例） | 正常完成、错收件人、重复派发、崩溃重启、旧/未来版本、伪造证据（缺指纹/严格档模型自述）、陈旧产物、空证据、必需条目漏报（部分完成）、快速档、理解确认 |

## 2. 行为反例（红→绿，全部通过）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 错收件人 | 拒绝 | ✅ `wrong-recipient` |
| 重复派发产生二次副作用 | 幂等返回既有结论 | ✅ 第二次 `isIdempotentReplay=true`、verdict 不变、日志仅 1 条 |
| 崩溃重启后重复派发无法识别 | 日志恢复后仍识别 | ✅ 新建 verifier 共享日志 → 仍判重放 |
| 声明依据旧版本 | 拒绝 | ✅ `stale-revision` |
| 声明依据**未来**版本 | 拒绝 | ✅ `future-revision` |
| 证据缺内容指纹 | 视为伪造 | ✅ `forged-evidence`（`artifact-1` 被点名） |
| 严格档用模型自述当产物 | 视为伪造 | ✅ `forged-evidence` |
| 产物在证据之后又被修改 | 拒绝 | ✅ `stale-artifact`（`staleEvidenceIdentifiers=["artifact-1"]`） |
| 无任何证据 | 拒绝 | ✅ `empty-evidence` |
| 必需条目漏报（部分完成） | 拒绝且可见进度 | ✅ `missingRequiredEntryIdentifiers=["E2"]`、`coveredEntryIdentifiers=["E1"]` |
| 快速档被写成通过 | 独立状态 | ✅ `quality-check-skipped`，理由含"跳过质量门禁（不等于测试/验收通过）"；错收件人仍拒绝 |
| 严格档/歧义任务缺理解确认 | 拒绝 | ✅ `understanding-confirmation-missing`；提供复述后 `accepted` |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/task-accuracy-verifier.test.ts` | 0；**10 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| 全量门禁与推送 | 见 §5 |

## 4. 设计边界（不重复实现已有能力）

- 本模块是**既有完成门禁之上的校验层**：不替换 `CompletionControlParser`（防重放 attemptId、陈旧 revision 拒绝）、
  不替换 worker 完成门禁（未解决的可变工具失败）、不替换 `EvidenceBundleBuilder`（空条目拒绝/覆盖说明）。
- 与完成链路的**组合接线**（把校验层接到完成声明路径、档位/预算设置入口、增量 E2E）属 **ACCURACY-03**。
- 本检查点未执行真实 Provider/安装/外部软件操作。

## 5. 门禁与推送

（本轮复跑后回填。）

## 6. 未满足项与后续

- **ACCURACY-03**：设置与产品入口（档位/预算/跳过状态可见）、与完成门禁的组合接线、增量 E2E
  （关闭后无新增模型审查或人工阻塞；状态诚实；标准/严格工作量有上限；不影响权限路由）。
- 幂等日志当前为进程内实现（`InMemoryAccuracyAttemptJournal`）；跨进程持久化属 03。
- 治理文档统一修订仍未开始（新用户文档要求正式启用前完成）。
