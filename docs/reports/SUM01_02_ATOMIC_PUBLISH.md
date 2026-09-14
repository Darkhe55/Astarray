# SUM-01-02 增量索引受控保存与原子发布 — 证据

> 检查点：SUM-01-02（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件：按规则不修改不暂存）
> 前驱：SUM-01-01（ADR-0034 契约 + 原型，提交 `33071ec`）。日期：2026-09-13
> 契约补充：docs/adr/0034-summary-manifest-and-dynamic-detail.md §12–19

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/summarization/summary-fact-extractor.ts`（新） | 本地权威事实提取：按 (sourceIdentifier, sourceRevision, contentHash) 去重、稳定排序、确定性标识（同输入同输出，构成幂等/续跑基础）；**不调用模型** |
| `packages/core/src/summarization/summary-index-store.ts`（新） | 清单读取（指纹 + 覆盖不变量 fail-closed）、CAS 原子发布（临时文件+fsync+rename+备份）、pending 草稿读写/清理、single-flight、只读失效检测；故障注入钩子供测试模拟中断发布 |
| `packages/core/src/summarization/summary-generation-service.ts`（新） | 推进流程：single-flight → 读清单/草稿 → 只提取未提取事实（本地）→ 后台生成叙述 → CAS 发布 → 清理 pending；中断留下可续跑草稿 |
| `packages/core/src/summarization/summary-manifest.ts`（扩展） | `chunkChainHash` + `manifestIntegrityHash` 完整性指纹（尾部追加 O(1) 增量、乱序全量重算）、`narrativeText` 叙述字段、`updateSummaryNarrative`、新错误码 `integrity-violation`/`stale-publish` |
| `tests/core/integration/summary-index-publish.test.ts`（新，7 用例） | 原子发布/续跑/篡改/陈旧/并发/只读/隔离反例 |

## 2. 行为反例（先写反例，红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 发布中断后留下"新摘要指旧正文" | 未发布即读不到，恢复后整份落地 | ✅ 注入写入失败 → `readManifest` 为 `null`；pending 保留 3 条事实与草稿叙述；续跑发布 revision 4、3 个分块 |
| 崩溃后重复提取事实 | 复用 pending，不重复提取/生成 | ✅ 提取器调用次数在中断+续跑全过程中保持 **1**，叙述生成 **1** |
| 清单被篡改仍被当作有效 | fail-closed | ✅ 抬高 `coveredThroughSourceRevision` → `journal-corrupted`（覆盖缺口）；只改正文 → 完整性指纹不符同样拒绝 |
| 陈旧发布覆盖新版本 | CAS 拒绝 | ✅ `stale-publish` |
| 并发请求重复生成叙述 | single-flight | ✅ 两个并发 advance → 叙述生成 **1** 次，发布 revision 相同 |
| 读取触发重摘要 | 只读 + 标记失效 | ✅ 来源前进返回 `source-advanced`、同 revision 改内容返回 `source-content-changed`；生成/提取调用数不变 |
| 跨 Agent 串档 | 隔离 | ✅ A 的清单在 B 下为 `null`；两个 Agent 同名来源各自独立可见 |

红态证据：首轮运行 7 用例中 3 失败（断言只匹配消息不匹配错误码 2 处、续跑路径空输入仍调用提取器 1 处），修正后 14/14（本文件 + SUM-01-01 用例）通过；实现中途另修复"增量指纹导致 2000 条追加 O(n²) 超时"。

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/summary-index-publish.test.ts tests/core/unit/summary-manifest.test.ts` | 0；**14 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**：typecheck + lint + build + test；**189 文件 / 1580 用例全通过** |
| `npm run test:coverage` | **exit 0**：189 文件 / 1580 用例通过；全局 statements **93.46%** / branch **86.20%** / functions **92.01%** / lines **93.49%**（阈值 85）；`packages/core/src/summarization` 目录 89.05% / **80.86%** / 92.53% / 88.84% |
| `git push` | **exit 0**：`98c4297..e606578`（`origin/main` = `e606578`） |

**首轮门禁红态（真实架构守卫拦截）**：`npm run check` 首跑 1 失败 —— `tests/architecture/destructive-file-api-guard.test.ts` 报告
`summary-index-store.ts: 不在白名单却使用破坏性 API rm`。修法不是加白名单，而是把"删除 pending 草稿"改为
底层 `removeJsonFileWithBackup`（先 .bak 备份再删除，破坏性 API 仍集中在已审查的 `infra/atomic-json.ts`），
调用方不再直接 rm；复跑 189/1580 全通过。

**已知分支覆盖缺口**：新目录 branch 80.86%（低于 95% 专项阈值，但该目录属新增功能而非既有 22 个安全模块清单）；
SUM-01-03 读取路径会覆盖陈旧/跨 Agent 游标与失效分支，届时一并抬升；本检查点不虚报达标。

## 5. 未满足项与后续

- SUM-01-03：默认摘要与章节展开分页、来源校验、陈旧/跨 Agent 游标拒绝的端到端读取路径；源码/媒体旁置索引（**不改原格式**）。
- SUM-01-04：应用/CLI/TUI 接线、安装包消费与资源指标（冷启动/内存/I/O、模型返回量）。
- 旧文件迁移与"外部变化失效"的本轮实现是**检测 + 显式拒绝**（只读路径）；迁移策略（重摘范围与预算）在 03/04 细化。
- 未冻结数值（分页大小、批量提取上限默认值、更新触发阈值）仍待测量后冻结；`maximumFactsPerBatch` 已作为有界参数预留。
