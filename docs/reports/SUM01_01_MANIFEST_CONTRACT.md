# SUM-01-01 摘要清单/游标/动态详细度契约 — 证据

> 检查点：SUM-01-01（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪的用户文件：按规则不修改不暂存）
> 前驱：T09A-R1 / T07D-R1 接线（已完成）。日期：2026-09-13
> 决策冻结：docs/adr/0034-summary-manifest-and-dynamic-detail.md

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `docs/adr/0034-summary-manifest-and-dynamic-detail.md`（新） | 登记未占用编号并通过边界冻结：manifest 字段、sourceRevision+contentHash 双标识、coverage/pending 尾部、分块与稳定顺序、游标绑定、四级动态详细度、无固定总长上限、计量单位不假设 tokenizer、未冻结数值清单 |
| `packages/core/src/summarization/summary-manifest.ts`（新，原型） | zod schema（manifest/chunk/evidence pointer/cursor）+ `createSummaryManifest`、`appendSummarySource`（重复不双计 / 同 revision 内容变化拒绝 / 缺口进 pending）、`summarizeManifestCoverage`、`createSummaryCursor`、`validateSummaryCursor`、`readSummaryPage`（分页端口 + 单次返回预算）、`buildDynamicDetailView`（summary/outline/section/detail） |
| `tests/core/unit/summary-manifest.test.ts`（新，7 用例） | 长短/分支/重复/缺口/游标/分页/详细度反例 |

原型不接入任何模型调用、不落盘（持久化属 SUM-01-02）、不修改既有读取工具（合并属 SUM-01-03/04）。

## 2. 行为反例（先写反例，红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 摘要被固定总长裁剪（引入 maximumSummaryLength 之类） | 清单只增不裁 | ✅ 300→2000 条来源连续追加后 `chunks` 仍为 2000；单次返回预算只置 `isReturnBounded` 并裁剪本次返回，清单长度不变 |
| 重复消息被双计 | 同 revision + 同 contentHash 不双计 | ✅ `wasDuplicate=true`，分块数与证据数不变，审计计数 +1 |
| 同 revision 内容变化被静默覆盖 | 显式拒绝 | ✅ 抛 `SummaryContractError(duplicate-source-revision)` |
| 跳号覆盖却自称已覆盖 | 缺口进 pending 尾部 | ✅ append revision 5 后 pending=`[3,4]`；补 3、4 后清空 |
| 游标可跨 Agent 使用 | 拒绝 | ✅ `cross-agent-cursor` |
| 用陈旧游标读取（清单已前进） | 拒绝 | ✅ `stale-cursor` |
| "取一页"却扫全文 | 只读一页 | ✅ 计数端口下 103 块 / 每页 10 → 11 页共读取 **110** 块（上界 = 页数×pageSize），无一次全量扫描 |
| 详细度只是文案差异 | 逐级展开且返回量受控 | ✅ `summary(3) < outline(10) < detail(100)` 计量单位；`summary` 级零分块读取；显式 `maximumReturnUnitCount=60` 时返回 6 块且清单仍 30 块 |

红态证据：先写测试运行 → `Failed to resolve import ... summary-manifest.js`（模块不存在，1 file failed / no tests）；实现后 7/7 通过。

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/unit/summary-manifest.test.ts` | 0；**7 passed** |
| `npx tsc --noEmit` | 0 |
| `npx eslint .` | 见下（本轮复跑） |
| `npm run check` / `test:coverage` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**：typecheck + lint + build + test；**188 文件 / 1573 用例全通过** |
| `npm run test:coverage` | **exit 0**：188 文件 / 1573 用例通过；全局 statements **93.60%** / branch **86.38%** / functions **92.04%** / lines **93.63%**（阈值 85）；`packages/core/src/summarization` 目录 93.40% / 86.36% / 95.83% / 93.10% |
| `git push` | **exit 0**：`1103da4..33071ec`（`origin/main` = `33071ec`） |

## 5. 未满足项与后续检查点

- SUM-01-02：受控保存增量索引与原子发布（崩溃不出现"新摘要指旧正文"、single-flight、旧文件迁移/外部变化失效）。
- SUM-01-03：默认摘要与章节展开分页、来源校验、陈旧/跨 Agent 游标拒绝的端到端读取路径；源码/媒体旁置索引。
- SUM-01-04：应用/CLI/TUI 接线、安装包消费与资源指标。
- 尚未冻结的具体数值（分页大小、触发阈值、更新频率、token 换算）在 02/04 测量后冻结。
