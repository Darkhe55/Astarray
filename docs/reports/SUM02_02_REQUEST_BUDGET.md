# SUM-02-02 完整请求计量与包装/输出预留 — 证据

> 检查点：SUM-02-02（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-02-01（提交 `d02b4eb`）。日期：2026-09-15
> 契约补充：docs/adr/0035-token-measurement-adapters.md §9–14

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/measurement/request-budget.ts`（新） | `assembleRequestBudget`（有效预算=min(全局配置,模型输入空间)−输出/包装预留；记录级选入；必要约束 blocked；剩余记录分页）；`remeasureRecordsForTarget`（目标键 = provider|model|tokenizer@version|serialization；同目标才复用）；`isMeasurementReusableForTarget`；`buildMeasurementTargetKey` |
| `tests/core/integration/request-budget-assembly.test.ts`（新，7 用例） | 只分页不裁剪、必要约束 blocked、预算可调、优先级稳定序、模型切换重计量、预留耗尽 blocked、**装配不改动已发布摘要清单** |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 超预算时截断记录正文充当"选入" | 记录级选择 + 剩余分页 | ✅ 20 条记录 → `requires-pagination`；选入∪分页无重无漏覆盖 20 条；选中记录正文长度与原文完全一致 |
| 分页丢失记录 | 无重无漏 | ✅ `new Set(union).size === union.length`，且 union 等于全部记录标识 |
| 必要约束放不下时静默丢弃 | 整体 blocked | ✅ `mandatory-context-exceeds-budget`，`selectedRecordIdentifiers=[]`，notes 记录 mandatory>effective |
| 预留（输出/包装）被忽略 | 从有效预算扣除 | ✅ 4096−512−64=3520；预留吃满 → `budget-exhausted-by-reservations` |
| 预算配置被写死 | 4096 可调规则保持 | ✅ 4096 与 8192 下有效预算与选入数量单调递增，且两次记录总数都完整保留 |
| 选择顺序不稳定 | 优先级+标识全序 | ✅ 高层级（值小）优先；被选集合按标识有序；分页中不存在比已选更低层级值的记录 |
| 模型切换沿用旧计量 | 重新计量 | ✅ 切到本地 tokenizer 目标 → 4/4 重新计量、来源 `local-tokenizer`；同目标再跑 → 4/4 复用；切到未知模型 → 4/4 保守估算 |
| 装配过程裁剪已发布摘要 | 清单字节与 revision 不变 | ✅ 用真实发布清单作为输入装配后，`manifest.json` 字节完全一致、`manifestRevision` 与分块数不变 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/request-budget-assembly.test.ts` | 0；**7 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**：typecheck + lint + build + test；**195 文件 / 1608 用例全通过** |
| `npm run test:coverage` | **exit 0**：195 文件 / 1608 用例通过；全局 statements **93.41%** / branch **85.94%** / functions **92.40%** / lines **93.44%**；`packages/core/src/measurement` 目录 **100%** / **89.24%** / **100%** / **100%** |
| `git push` | **exit 0**：`d02b4eb..446a539`（`origin/main` = `446a539`） |

## 5. 未满足项与后续

- 产品级接线（把装配结果送入真实 Provider 请求并捕获 usage）属 **SUM-02-04**；本轮为可被装配器调用的纯规则实现 + 真实清单不变性验证。
- SUM-02-03：权威字段本地提取与叙述引用证据（对照原文检查事实支持/遗漏/错误归因）。
- SUM-02-04：内容缓存与计量缓存分离、真实请求捕获与 tarball 联测、人工标注质量评估。
