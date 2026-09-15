# SUM-02-03 摘要事实核验与重建 — 证据

> 检查点：SUM-02-03（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-02-02（提交 `6b0f2f5`）。日期：2026-09-15
> 契约冻结：docs/adr/0036-summary-fact-verification.md

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/measurement/summary-fact-verification.ts`（新） | `extractAuthoritativeClaims`（五类权威字段，本地规则化）、`assertVerifiableOriginalSources`（原始出处/非摘要再摘要）、`verifyNarrativeAgainstClaims`（支持/关键遗漏/无出处数值断言/数值冲突/引用错误 + verdict）、`rebuildNarrativeFromClaims`（原始证据确定性拼接 + 来源指针） |
| `tests/core/integration/summary-fact-verification.test.ts`（新，7 用例） | 提取、数值冲突、无出处断言、关键遗漏、引用校验、摘要再摘要拒绝、重建正对照 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 引用合法即判"语义正确" | 引用合法但不参与支持判定，数值必须一致 | ✅ 引用真实来源却写 `8192 token`（原文 4096）→ `conflictingValues` 命中、verdict `unsupported` |
| 叙述臆造无出处的数值 | 标记无出处断言 | ✅ `延迟 30s`（权威单位桶无 `s`）→ `unsupportedNumericAssertions` 命中 |
| 关键事实被漏写仍判通过 | 关键遗漏 → partially-supported | ✅ 只提到标识、漏掉预算/状态 → `omittedKeyClaimIdentifiers` 非空、verdict `partially-supported` |
| 引用不存在/被篡改的来源 | 显式引用错误 | ✅ `not-found` 与 `content-hash-mismatch` 分别命中 |
| 拿摘要当原文继续核验（摘要再摘要） | 拒绝 | ✅ `derivedFromSummaryIdentifier` 非空 → `summary-of-summary-rejected`；缺哈希/revision → `missing-original-source` |
| 重建叙述只是又一次模型生成 | 必须可核验 | ✅ 重建叙述带 `sourceIdentifier@sourceRevision` 指针、全部 claim 被使用、核验为 `supported`（0 冲突/0 无出处断言/0 引用错误），长度随证据增长 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/summary-fact-verification.test.ts` | 0；**7 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 见 §4 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**：typecheck + lint + build + test；**196 文件 / 1615 用例全通过** |
| `npm run test:coverage` | **exit 0**：196 文件 / 1615 用例通过；全局 statements **93.46%** / branch **85.93%** / functions **92.41%** / lines **93.48%**；`packages/core/src/measurement` 目录 99.55% / **88.05%** / **100%** / 99.54% |
| `git push` | **exit 0**：`6b0f2f5..36017d8`（`origin/main` = `36017d8`） |

## 5. 未满足项与后续

- SUM-02-04：内容缓存与计量缓存分离、真实产品请求捕获及 tarball 联测、人工标注样本质量评估
  （不能用生成模型自评通过）。
- 规则化字段提取的覆盖范围（同义单位、省略单位数值、多语言状态词）随真实样本继续扩展。
- `verifyNarrativeAgainstClaims` 尚未接入产品叙述生成路径（属 SUM-02-04 的接线范围）。
