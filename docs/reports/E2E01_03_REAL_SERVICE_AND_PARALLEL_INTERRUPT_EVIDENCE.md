# E2E-01-03 真实服务与并行中断：证据报告

- 节点：`E2E-01-03：真实服务与并行中断`（卡 `docs/tasks/E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD.md`）
- 日期：2026-10-09
- 代码版本：`0b712b1`（两次真实验收运行时均为干净工作区，`sourceStatus: ''`）
- 真实服务：`stepfun / step-3.7-flash / openai-compatible`，端点 `https://api.stepfun.com/v1/chat/completions`，凭据引用 `prov-live-1`
- 安装形态：`npm pack` 产出 tarball → 隔离目录 `npm install` → 以安装包自带的 `dist/cli.js` 执行（**tarball 隔离安装**）
- 人工参与：**用户在"Agent 已读、尚未写入"窗口内亲手编辑目标文件**（非脚本代改）
- 安全：真实密钥仅经环境变量注入 CLI 子进程，**全程未打印、未写入任何文档或提交**

## 1. 结论（逐条核对卡内验收）

| # | 卡内验收条款 | 结论 | 证据 |
|---|---|---|---|
| 1 | 陈旧写入被拒绝且人工修改保留 | **通过（真实 Provider）** | 判据③ `stale-human-change=true` 回填给 Provider；判据④ 目标文件逐字节等于用户所写内容；判据⑤ Agent 待写内容未落盘 |
| 2 | 恢复无重复副作用 | **通过（真实 Provider）** | 判据⑪–⑰：边界强杀（状态 `started`，4351ms）→ 崩溃后 `hasTrustedCheckpoint=true` → `requiresDecisionMissions` 含该 mission → `recover resume` 返回 `resumed=false`、`executed=false`、`blockedDecisionItems=[blocked-uncertain-side-effect]`（"禁止自动二次执行"）→ 目标文件未改变 |
| 3 | 上下文预算/回访实际执行 | **部分通过：预算 ✓ / 回访 ✗（无证据）** | 判据⑦：`context-runtime/events.jsonl` 有 1 条 `context-assembly`，`effectiveBudgetTokens=4096`、`budgetPolicyRevision=1`；但**该次运行只产生 `context-assembly` 一种事件，没有任何"回访/复用"实际发生的证据** |
| 4 | CLI/SDK最终状态一致 | **通过（真实 Provider）** | 判据⑧：CLI 持久化状态视图 `status=cancelled` 与安装包公开 SDK 查询结果一致 |

**因此本节点不应标记为 `done`**：条款 3 的"回访"半数没有证据。按卡内注意事项
"缺真实服务、人工或平台证据时按明确范围保留 blocked/pending，不用说明文字覆盖未满足门禁"，
状态保持 `pending`，并把缺口精确登记如下。

## 2. 待补缺口（精确范围）

1. **回访实际执行无证据**：需要在真实 Provider 场景中让"回访/复用已读上下文"真正发生，
   并留下可复核证据（例如该机制产生的持久化事件或回执）。当前单任务短流程不足以触发。
2. **"人工工作树"口径需确认**：本次并发变化发生在 Agent 与用户**同一个工作树**的目标文件上，
   并发语义真实（用户亲手改、Guard 拒绝陈旧写入）。
   但产品侧"独立人工工作树分配"（`GitWorktreeAllocator` 仅在提供 `gitIntegration` 时启用，
   当前无产品装配点）**仍未接线**，故不能声称"用户在独立人工工作树内作业"。
   该口径是否构成本节点的必过门禁，需用户裁决。

## 3. 原始证据位置（均在 `.tmp/`，未入库）

- ①③④ + ⑩：`.tmp/e2e01-03/2026-10-09T13-08-12.367Z/`
  - `acceptance-verdict.json`：`verdict=passed`、`isFakeProvider=false`、`isRealAcceptanceEvidence=true`、
    `humanEditDetected=true`、`failedCheckNames=[]`、`sourceCommit=0b712b1`、`sourceStatus=''`
  - `provider-requests.jsonl`（CLI 发出的请求体）、`upstream-responses.jsonl`（**新增**：上游原始响应
    与每次**真实发起**的工具名）、`cli-stdout.txt`、`cli-stderr.txt`、`cli-status-command.json`、
    `sdk-query-mission.json`
- ②（崩溃+恢复）：`.tmp/e2e01-03-interrupt/<最新时间戳>/boundary-interrupt-verdict.json`
  - `verdict=passed`、`isFakeProvider=false`、`isRealAcceptanceEvidence=true`、
    `observedToolCallState=started`、`killedAfterMilliseconds=4351`、7/7 判据

## 4. 本轮为取得真实证据而修掉的缺陷（全部是我方问题，已提交）

| 提交 | 缺陷 | 后果 |
|---|---|---|
| `2a37bf3` | `--provider-request-timeout-seconds` 硬编码 60s < 人工编辑窗口 | CLI 在用户编辑前自行超时，窗口白开 |
| `2a37bf3` | 判据①③读**未使用的假 Provider** 请求日志 | 真实模式下"请求数=0"假失败 |
| `e4fd079` | harness 看门狗 300s、CLI `--timeout-seconds` 240s 均 < 窗口 | CLI 被强杀（exit 124），②③④⑩ 失败 |
| `fdd22fb` | 代理用**子串匹配**判定工具调用 | 提示词含工具名即误扣响应；且未记录上游响应导致无法诊断 |
| `bb5603e` | 提示词未给出待写入文本 | 真实模型拒绝编造 content，**从不调用** `replaceFileContent` |
| `e70d950` | **Node `http.Server` 默认 `requestTimeout`=5 分钟** | 扣留到 5 分钟被销毁 socket，用户编辑恰在那一秒 |
| `667ae1f` / `0b712b1` | verdict 残留重复键覆盖判定；真实模式下 ⑯ 读假 Provider 计数器（空判据） | 判据标注错误 / 空过 |

## 6. 用户裁决与下一片（2026-10-09）

- **条款 3 的"回访"＝必修**：用户裁决另开一片取证，本节点在此之前保持 `pending`。
- **"人工工作树"口径＝接受同工作树并发**：用户裁决"本次同一工作树内用户亲手并发修改"已满足
  并发语义；**产品侧独立人工工作树分配（`GitWorktreeAllocator` 接线）不构成本节点的必过门禁**，
  归入另一个待办节点。故条款 2 的并发语义按本次实现取证，不再标记该口径为缺口。

### 6.1 下一片（回访取证）的目标机制

"回访"在产品内指**分级上下文回访**：

- 入口契约：`ASTARRAY_CONTEXT_RECALL_REQUEST_V1`（`orchestration/context-closure-schemas.ts`）
- 控制器：`orchestration/context-recall-controller.ts`（分级上下文回访；每次任务执行**回访次数有界**、
  敏感内容 fail-closed 丢弃整个结果）
- 账本：`orchestration/context-recall-ledger-store.ts`（回执冷却与任务级回访预算持久化）
- **证据面**：`orchestration/context-runtime-metrics.ts` 明确"原始事件来自真实装配与回访路径
  （**JSONL 持久化**）" —— 即回访实际执行应体现为 `context-runtime/events.jsonl` 中
  `context-assembly` 之外的**回访类事件**；本次真实运行只有 1 条 `context-assembly`，故无证据。

**下一片要做的事**（尚未开始）：

1. 侦察回访的实际触发条件（需要哪些前置：存在可回访的关闭/嵌套节点？模型如何发起？事件名与字段？）；
2. 构造能在**真实 Provider + tarball 隔离安装**下真正触发一次回访的场景；
3. 以持久化事件为证据，逐条记录（含回访次数上界、DLP 与预算是否参与），再回填本报告与卡内条款 3。


- 真实调用：失败尝试若干 + ①③④ 两次成功运行各 3 次 + ② 两次各约 2–3 次；均已如实登记。
- harness 进程在写出判定文件后**不退出**（子进程句柄未释放，已知残留问题），
  故真实运行的**进程退出码不可用**，结论以判定文件与日志结论行为准。
