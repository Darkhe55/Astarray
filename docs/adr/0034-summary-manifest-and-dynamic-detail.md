# ADR-0034：会话摘要清单与动态详细度契约

- 状态：Proposed（SUM-01-01 冻结；原型实现见 `packages/core/src/summarization/summary-manifest.ts`）
- 日期：2026-09-13
- 来源：SUM-01 任务卡（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md）；依据 docs/LONG_SESSION_AND_RUNTIME_STEERING_PROPOSAL.md

## 背景

长会话历史、工作存档、报告与延后文件需要可**按需展开**的摘要，而不是一份会被固定上限裁剪的副本。
已冻结的约束是：摘要总长度**无固定硬上限**（按对话长度与信息复杂度动态调整），
不得引入 `maximumSummaryLength` 或整份摘要的 token 裁剪；**单次返回与模型注入预算独立**；
长摘要分概览/主题/证据索引分页，**不能为取一页而扫描全文**。

本 ADR 只冻结契约（manifest/游标/详细度/覆盖与 pending 语义），具体数值与持久化在 SUM-01-02 及原型测量后决定。

## 决策

1. **摘要清单（manifest）字段**（`summaryManifestSchema`，`schemaVersion = 1`）：
   `manifestIdentifier`、`agentInstanceId`、`sourceKind`（`conversation`/`work-archive`/`report`/`deferred-file`）、
   `sourceIdentifier`、`coveredThroughSourceRevision`、`coveredContentHash`、`pendingSourceRevisions`、
   `chunks`、`manifestRevision`（单调）、`generatorVersion`、`updatedAtIso`。
2. **权威来源标识**：每条来源用 `sourceRevision`（单调）**加** `contentHash` 双标识；
   分块的 `evidencePointers` 指回具体来源（sourceKind/sourceIdentifier/sourceRevision/contentHash），
   保证"引用存在"可核对，且不依赖模型叙述自证（语义正确性由 SUM-02-03 验收）。
3. **无固定总长上限**：清单只增不裁；任何 `maximumReturnUnitCount` 只裁剪**本次返回**并置
   `isReturnBounded = true`，**不修改清单**。禁止实现"达到 N 就丢弃旧分块"的行为。
4. **覆盖与 pending 尾部**：`coveredThroughSourceRevision` 表示已并入摘要的最高 revision；
   区间内的缺口 revision 必须出现在 `pendingSourceRevisions`（**不自称已覆盖**），补齐后自动移出。
5. **分块与稳定顺序**：分块按 `sourceRevisionFrom` 排序、以 `chunkIdentifier` 破平；
   每块标注 `themeIdentifier`、可用 `detailLevels`、`estimatedUnitCount`（**计量单位，不在此假设 tokenizer**；
   token 换算由 SUM-02-01 的计量适配端口决定）。
6. **重复与冲突**：同一 `sourceRevision` + 同一 `contentHash` 判为**重复投递，不双计**（计入 `duplicateDeliveryCount` 供审计）；
   同一 `sourceRevision` 内容哈希变化一律**显式拒绝**（`duplicate-source-revision`），需重新摘要而非静默覆盖。
7. **游标**：`{ agentInstanceId, manifestRevision, nextChunkIndex, detailLevel }`；
   读取前校验 **Agent 绑定**与**清单 revision**：跨 Agent 抛 `cross-agent-cursor`，陈旧抛 `stale-cursor`。
8. **分页与有界读取**：分页经 `SummaryChunkReaderPort.readChunks(fromIndex, count)` 端口读取，
   取一页只读一页（原型测试用计数端口证明 reading ≤ pageSize/页）；概览级（`summary`）**零分块读取**，
   只读清单索引。
9. **动态详细度**：`summary`（主题概览，零分块读取）→ `outline`（主题+来源范围，单块计 1 单位）
   → `section`（摘要分块）→ `detail`（摘要+证据指针）；详细度只影响返回粒度，不改变清单内容。
10. **来源范围**：首期覆盖会话历史、工作存档、报告与延后文件；源码/媒体只建**旁置索引**，不改原格式
    （旁置索引与增量发布属 SUM-01-02/03）。
11. **未冻结的数值**：分页大小、触发更新的新增量阈值、更新频率、计量单位到 token 的换算，
    全部留待原型测量（SUM-01-02/04）后冻结；本 ADR 不为等这些数值而阻塞无依赖设计。

## 非目标

- 不做摘要的语义正确性判定（SUM-02-03 用原文对照与人工标注验收）。
- 不定义模型端摘要生成提示词与调度（SUM-01-02 后台生成）。
- 不引入固定总长上限或按 token 裁剪整份摘要。
- 不在此层做 tokenizer 适配或跨模型计量缓存（SUM-02）。

## 后果与风险

- 清单会随会话持续增长，磁盘与读取开销由 SUM-01-04 测量；这换来"无固定总长裁剪"的可验收语义。
- `pendingSourceRevisions` 在跳号频繁时可能变大，属于诚实的覆盖状态而非失败；读取方可据此提示"尾部未并入"。
- 游标严格绑定清单 revision：增量发布后旧游标失效，调用方必须重新取页（避免读到跨 revision 的混合视图）。

## 参考

- docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md（SUM-01 共同规则与检查点）
- docs/LONG_SESSION_AND_RUNTIME_STEERING_PROPOSAL.md（用户已选方案）
- ADR-0029（读预算）、ADR-0031（上下文节点收口与回访）、ADR-0018（敏感禁读）
- 原型与测试：`packages/core/src/summarization/summary-manifest.ts`、`tests/core/unit/summary-manifest.test.ts`
## 补充（SUM-01-02 冻结：受控保存与原子发布）

12. **完整性指纹**：清单增加 `chunkChainHash`（按分块顺序逐块折叠的链式指纹，尾部追加为 O(1) 增量，
    乱序补齐按全量重算）与 `manifestIntegrityHash`（绑定分块链 + 覆盖元数据 + 叙述 + 清单 revision）。
    校验不通过一律 fail-closed（`integrity-violation`），**绝不把被篡改/半写的清单当作有效摘要返回**。
13. **覆盖区间不变量**：已发布清单必须满足"1..`coveredThroughSourceRevision` 内每个 revision 都能被某个分块的
    `sourceRevisionFrom..To` 覆盖，或显式列在 `pendingSourceRevisions`"；违反即 `journal-corrupted`。
    该不变量正是"新摘要不得指向旧正文/空洞"的可执行形式。
14. **事实与叙述分离**：`chunks[].summaryText` 只承载**本地权威事实**（确定性提取，不改写语义）；
    模型生成的叙述放在清单的 `narrativeText` 字段，两者不混同，叙述可单独更新（`updateSummaryNarrative`）。
15. **pending 生成草稿**：生成过程先原子写入 `pending.json`（Agent/来源键、已提取事实、待并入 revision、
    草稿叙述、基线清单 revision），崩溃后可续跑；续跑复用已提取事实与草稿叙述，**不重复提取、不重复生成**。
16. **发布为 CAS + 原子替换**：`publishManifest` 以 `expectedRevision` 做比较交换（陈旧发布抛 `stale-publish`），
    经"临时文件 → fsync → 原子 rename + 备份"落盘；写入前备份主文件（ADR-0009）。
17. **single-flight**：同一 (Agent, 来源) 的生成任务在进程内合并，并发请求只执行一次叙述生成。
18. **读取路径只读**：`readManifest`/`detectSourceInvalidation` 只读清单与本地哈希，
    外部变化只标记失效（`source-advanced`/`source-content-changed`/`no-manifest`），**不触发任何重摘要或模型调用**。
19. **按 Agent 隔离**：清单与 pending 落在 `agent-memory/<agentInstanceId>/summaries/<sourceKind>-<sourceIdentifier>/`，
    不同 Agent 的同名来源互不可见。
