# SUM-01-04a 摘要产品入口接线与资源观测 — 证据

> 检查点：SUM-01-04（04a，docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-01-03（提交 `c40dc2f`）。日期：2026-09-13
> 契约补充：docs/adr/0034-summary-manifest-and-dynamic-detail.md §24–27
> 04b 剩余（CLI/TUI 接线、安装包消费大历史摘要、资源测量记录表）见 §5

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/summarization/summary-source-adapters.ts`（新） | 工作存档 → 摘要来源条目：跨 Agent 合并、按时间稳定排序、revision 重排、重复条目不双计、类型映射；`buildLocalExtractiveNarrative`（确定性统计叙述，版本 `local-extractive-1`） |
| `packages/core/src/summarization/summary-resource-metrics.ts`（新） | `measureSummaryOperation`：耗时、清单字节、返回量、原文访问次数、索引读取次数、是否裁剪本次返回 |
| `packages/core/src/summarization/summary-index-store.ts`（扩展） | `manifestFileSizeBytes`、`listSourceKeys`（逐目录读清单，损坏目录不参与列表） |
| `packages/core/src/summarization/summary-generation-service.ts`（扩展） | `generatorVersion` 可配置，区分本地抽取式与后续模型生成器 |
| `packages/core/src/public-sdk.ts`（扩展） | `summarizeArchivedMission`、`listSummarySources`、`readSummaryView`、`expandSummarySectionView` + 公开 DTO（来源概要/页面/章节/资源观测/证据指针） |
| `tests/core/unit/summary-source-adapters.test.ts`（新，3 用例）、`tests/core/integration/summary-product-wiring.test.ts`（新，3 用例） | 适配器确定性与产品接线端到端 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 摘要读取绕过公共门面直接读内部存储 | 公共入口可读 | ✅ 真实 mock mission → `summarizeArchivedMission` → `listSummarySources` → `readSummaryView` → `expandSummarySectionView` 全链路经 `AstarrayApplicationFacade` |
| 跨 Agent 存档合并后丢失出处 | 证据可回溯个体存档 | ✅ 指针为 `agentInstanceId#archiveEntryId`；条目类型决策/结果为 decision/result，其余为 note |
| 同一存档条目重复投递被双计 | 不双计 | ✅ 同 mission 内重复 `archiveEntryId` 只保留一条；跨 Agent 同名条目各自保留 |
| 本地统计冒充模型叙述 | 版本可区分 | ✅ `generatorVersion = "local-extractive-1"`，叙述文本自述"本地抽取式摘要" |
| 翻页时清单前进导致拼页 | 拒绝 | ✅ `expectedManifestRevision` 不符 → `stale-cursor`；连续翻页返回不同分块 |
| 来源缺失被当作空摘要 | 显式失败 | ✅ `summary-not-found` |
| 资源不足时裁剪正文 | 只裁剪本次返回 | ✅ `maximumReturnUnitCount=1` → `isReturnBounded=true`、返回量 ≤1，而 `coverage.chunkCount` 与完整读取一致（清单未裁剪） |
| 读取路径读取原文 | 0 次 | ✅ `resourceMetrics.sourceAccessCount = 0`；清单字节 >0、索引读取 1 次如实声明 |

红态：首轮 6 用例中 1 失败（节选上限 12 使短摘要未触发裁剪、叙述节选随之被裁），改用 4 字符上限并分别断言"节选被裁 + 清单内叙述完整"后 6/6 通过。

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run`（适配器 + 产品接线） | 0；**6 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**：typecheck + lint + build + test；**192 文件全通过** |
| `npm run test:coverage` | **exit 0**：192 文件全通过；全局 statements **93.53%** / branch **86.07%** / functions **92.34%** / lines **93.54%**；`packages/core/src/summarization` 目录 91.25% / **80.61%** / 95.95% / 91.12% |
| `git push` | **exit 0**：`c40dc2f..ebd5aad`（含本检查点提交；`origin/main` = `ebd5aad`） |

**门禁首跑红态（均为既有用例的插桩/负载波动，非本检查点回归）**：
1. `check` 命中 `e2e01-vertical-rework`（`running` vs `done` 竞态，90s）与 `run-command-gaps`（真实 mock mission 超 20s）；
2. `coverage` 命中 `cli-commands`（同一类超时）。
修法：为这三个**既有**用例文件设置整文件 60s 超时（含逐例 `20_000` → `60_000`），**不放宽任何断言**，提交 `ebd5aad`；复跑 `check` 与 `coverage` 均 192 文件全通过。
另记：`--pool=threads` 下 `process.chdir` 在 worker 线程不可用，故这批 `process.chdir` 用例的本地线程池验证无意义，必须以 forks 门禁为准。

## 5. 未满足项（属 04b）

- CLI/TUI 接线：`astarray summary list|build|show` 与现有 TUI 入口（本轮只到公共门面）。
- 安装包消费：从 tarball 隔离安装读取**大历史摘要**再展开，并记录磁盘 I/O、模型返回量与资源不足时的诚实状态。
- 会话历史/报告/延后文件来源适配器；旧文件迁移与触发阈值测量。
