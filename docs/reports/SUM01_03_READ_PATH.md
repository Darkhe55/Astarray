# SUM-01-03 默认摘要读取、章节展开与旁置索引 — 证据

> 检查点：SUM-01-03（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件：不修改不暂存）
> 前驱：SUM-01-02（提交 `e606578`）。日期：2026-09-13
> 契约补充：docs/adr/0034-summary-manifest-and-dynamic-detail.md §20–23

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/summarization/summary-read-service.ts`（新） | `readSummaryDefaultView`（四级视图、默认 summary、游标校验、可注入计数 chunkReader）、`expandSummarySection`（定点章节 + 有界节选 + 证据指针）、`verifyEvidenceLocator`（清单内定位，三态原因）、`readSummaryCoverage`（只读覆盖率） |
| `packages/core/src/summarization/summary-sidecar-index.ts`（新） | 源码/媒体旁置索引：`buildSidecarIndexEntries`（只吃元数据）、`assertSidecarIndexIsPointerOnly`（禁正文键与未声明字段） |
| `packages/core/src/summarization/summary-index-store.ts`（扩展） | 旁置索引原子写入与读回（写/读均过 pointer-only 断言） |
| `packages/core/src/summarization/summary-manifest.ts`（扩展） | 新错误码 `manifest-not-found`、`chunk-not-found`；`readSummaryDefaultView` 可注入 `chunkReader` 供有界读取审计 |
| `tests/core/integration/summary-read-path.test.ts`（新，7 用例） | 概览零读取、分页有界、章节展开、陈旧/跨 Agent 游标、全程不读原文、证据定位三态、旁置索引 pointer-only |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 读取默认摘要却把分块正文读进来 | 概览零分块读取 | ✅ 计数端口读取数 **0**，返回概览主题计数（decision 2 / message 3）与覆盖率 |
| "取一页"却扫全文 | 读取量上界 = 页数 × 页大小 | ✅ 103 块 / 每页 5 → 21 页、总读取 **105**、无全量扫描；游标走完全部块 |
| 章节展开需要读整份清单正文 | 定点取一节 + 有界节选 | ✅ 按 `chunkIdentifier` 取一节，节选按上限截断（`isExcerptBounded`），带证据指针；未知章节 `chunk-not-found` |
| 陈旧/跨 Agent 游标被接受 | 拒绝 | ✅ `cross-agent-cursor`（改游标属主）与 `stale-cursor`（清单前进后旧游标） |
| 读取路径偷偷读取原文 | 观测端口计数为 0 | ✅ 概览/分页/章节展开/证据定位四条路径全部走完，观察端口记录 **0** 次 |
| 证据定位要现场重算全文哈希 | 清单内定位 | ✅ 命中 `located`；同 revision 改哈希 `content-hash-mismatch`；未索引 revision `not-indexed`；均 0 次原文访问 |
| 旁置索引夹带正文 | 拒绝且不改原格式 | ✅ 100 条源码/媒体条目全部 `pointerOnly`，读回不含正文；注入 `content` 或未声明字段 → `journal-corrupted` |

红态：首轮 7 用例中 2 失败（主题排序断言写反、错误断言只匹配消息未匹配错误码），修正后 7/7；本目录共 23 用例（含架构守卫）全通过。

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run`（summary 三套件 + 破坏性 API 守卫） | 0；**23 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**：typecheck + lint + build + test；**190 文件 / 1587 用例全通过** |
| `npm run test:coverage` | **exit 0**：190 文件 / 1587 用例通过；全局 statements **93.54%** / branch **86.20%** / functions **92.20%** / lines **93.57%**；`packages/core/src/summarization` 目录 91.76% / **81.64%**（较 02 的 80.86% 提升）/ 96.47% / 91.64% |
| `git push` | **exit 0**：`5664aac..4c8993e`（`origin/main` = `4c8993e`） |

**覆盖率首跑红态（已修复，非放宽断言）**：首跑 `test:coverage` 2 失败 —— `e2e01-vertical-rework`（既有资源竞争波动）
与 `gui-settings-recovery`（**本仓既有用例**在插桩下真实任务链路超过 5s 默认超时）。修法：为该文件设置
`vi.setConfig({ testTimeout: 30_000 })`（仅调整超时，断言不变），并复跑覆盖率（190/1587 全通过）。
途中一次误用 read(20 行)+write 组合改写测试文件导致内容截断，已用 `git checkout --` 还原后改用定点 `edit`。

## 5. 未满足项与后续

- SUM-01-04：应用/CLI/TUI 接线、安装包消费与资源指标（冷启动、内存、磁盘 I/O、模型返回量），
  并把读取路径接到真实会话历史/工作存档/报告/延后文件来源。
- 源码/媒体旁置索引目前只定义"指针-only + 原子存取"；实际接入源码扫描与媒体元数据采集在 04（不捆绑大型媒体依赖）。
- 旧文件迁移策略（重摘范围与预算）与触发阈值仍待 04 测量后冻结。
