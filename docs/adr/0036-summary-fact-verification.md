# ADR-0036：摘要事实核验与依据原始分块重建叙述

- 状态：Proposed（SUM-02-03 冻结；实现见 `packages/core/src/measurement/summary-fact-verification.ts`）
- 日期：2026-09-15
- 来源：SUM-02 任务卡（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md）

## 背景

长会话摘要的叙述**引用存在不等于语义正确**：同一来源可以被正确引用却写错了数值、漏掉关键约束，
或者引用根本不存在的 revision。任务卡要求"权威字段本地提取，叙述引用证据，依据原始分块重建摘要；
对照原文检查事实支持、关键遗漏、错误归因；不能仅摘要再摘要"。

## 决策

1. **核验输入必须是原始条目**：每条输入携带 `sourceIdentifier`、`sourceRevision` 与 `contentHash`；
   缺 revision/哈希抛 `missing-original-source`；`derivedFromSummaryIdentifier` 非空（本身是摘要产物）
   抛 `summary-of-summary-rejected`——**禁止摘要再摘要**。
2. **本地规则化权威字段提取**（确定性、不调用模型）：五类 `claimKind` ——
   `number-with-unit`、`identifier`、`decision-status`、`timestamp`、`negation`；
   数值/单位、状态决策与否定约束标记为 `isKeyFact`（关键事实）。
3. **核验报告字段**：`supportedClaimIdentifiers`、`omittedKeyClaimIdentifiers`（关键遗漏）、
   `unsupportedNumericAssertions`（叙述中的无出处数值断言）、`conflictingValues`（同单位不同值）、
   `citationErrors`（`not-found` / `content-hash-mismatch`），以及 `verdict` 与 `notes`。
4. **判定规则**：出现数值冲突、无出处数值断言或引用错误 → `unsupported`；
   仅有未覆盖的关键事实 → `partially-supported`；全部覆盖且无冲突 → `supported`。
5. **引用存在 ≠ 语义正确**：引用合法只用于引用校验，**不参与**"事实支持"判定；
   叙述中的数值必须与权威字段（按单位归桶）一致，否则记为冲突。
6. **依据原始分块重建叙述**：`rebuildNarrativeFromClaims` 只做确定性拼接
   （原始归一值 + `sourceIdentifier@sourceRevision` 指针），**不经过模型再生成**；
   重建结果必须能被同一核验器判为 `supported`（正对照），且长度随证据增长、无固定上限。
7. **只报告、不代替结论**：核验器报告来源、覆盖、冲突与局限，不替用户给出最终合格结论（与 ADR-0016 一致）。

## 非目标

- 不做语义蕴含/等价判断与自动改写（规则化提取只覆盖可确定的字段）。
- 不做人工标注样本的质量评估（SUM-02-04）。
- 不替换模型叙述；重建路径是可核验的低可读性备选。

## 后果与风险

- 规则化提取对非常规表述（省略单位的数值、同义单位）会漏检：漏检表现为"未覆盖关键事实"或"无出处数值断言"，
  属于**保守报告**而非误判为支持。
- 单位别名（`token`/`tokens`、`字节`/`B`）需要在规则内归一，否则可能产生假冲突；
  当前归一表已覆盖常用组合，列表在实现中可扩展。
- 重建叙述可读性弱于模型叙述，但 100% 可回溯，适合高严谨性任务与审计。

## 参考

- ADR-0016（高严谨性任务的证据要求）、ADR-0034（摘要清单/详细度）、ADR-0035（token 计量与请求预算）
- 实现与测试：`packages/core/src/measurement/summary-fact-verification.ts`、`tests/core/integration/summary-fact-verification.test.ts`
