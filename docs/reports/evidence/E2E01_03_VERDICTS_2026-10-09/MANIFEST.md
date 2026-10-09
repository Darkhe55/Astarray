# E2E-01-03 真实验收判定文件（入库固化）

- 固化日期：2026-10-09
- 对应卡片：`docs/tasks/E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD.md` 的 `E2E-01-03：真实服务与并行中断`（状态 done，提交 `713d842`）
- 汇总报告：`docs/reports/E2E01_03_REAL_SERVICE_AND_PARALLEL_INTERRUPT_EVIDENCE.md`

## 1. 为什么固化

判定文件原本落在 `.tmp/`（运行产物、不入库）。本目录把它们**逐字节复制**入库，
使真实验收证据可被长期引用与复核；并用下方 sha256 证明副本与原件一致。

## 2. 文件清单与完整性

| 入库文件 | 来源（运行时路径） | sha256 | 字节 |
|---|---|---|---|
| `acceptance-verdict-stale-write.json` | `.tmp/e2e01-03/2026-10-09T13-08-12.367Z/acceptance-verdict.json` | `a85554d5ab3d9a0c7499a5c9b2802b0d54e3981cba7064529d375b8b12ef50b4` | 3379 |
| `boundary-interrupt-verdict.json` | `.tmp/e2e01-03-interrupt/<时间戳>/boundary-interrupt-verdict.json` | `48b210ef584410928ca6de4e832ed74454a158658c0c77d5395ecacbc2b8da78` | 4243 |
| `context-recall-verdict.json` | `.tmp/e2e01-03-recall/2026-10-09T13-59-08.716Z/context-recall-verdict.json` | `83d17068a89e04a07975144b78554ec288b77788f626e2dc88662467b49c6e4d` | 2499 |

- 复制方式：`Copy-Item`；**每个副本的 sha256 与来源文件逐一比对为相同**（`True`）。
- 密钥泄漏检查（2026-10-09）：对本目录全部文件，用受保护凭据文件中的 **2 把真实密钥**
  逐字节比对，结果 `checkedFiles=3 checkedKeys=2 leakedCount=0`。
  **本目录不含任何密钥材料**；`credentialReferenceId` 只是引用名（`prov-live-1`），不是凭据。

## 3. 三次运行的共同参数

| 项 | 值 |
|---|---|
| 安装形态 | tarball 隔离安装（`npm pack --ignore-scripts` → 独立目录 `npm install` → 安装包自带 `dist/cli.js`） |
| tarball sha256 / 字节 | `8b175e316893089a42cec781d1abb87ee8827d71b2c2465422a60e287e4ccb4e` / 1,124,541（三份一致） |
| 真实端点 | `https://api.stepfun.com/v1/chat/completions` |
| 凭据引用 | `prov-live-1`（真实密钥仅经环境变量注入 CLI 子进程，未打印、未落盘） |
| 模型 | `step-3.7-flash`（`boundary-interrupt-verdict.json` **未记录** modelIdentifier 字段——该脚本当时未写该字段，实际命令行用的是同一模型） |
| 模式 | `devolve` |

## 4. 每份文件证明什么

### 4.1 `acceptance-verdict-stale-write.json`（9 判据，`verdict=passed`）

对应条款 **1「陈旧写入被拒绝且人工修改保留」** 与条款 **4「CLI/SDK 最终状态一致」**：

- `isFakeProvider=false`、`isRealAcceptanceEvidence=true`、`sourceCommit=0b712b1`、`sourceStatus=''`、`failedCheckNames=[]`
- `humanEditDetected=true`（**用户在"已读未写"窗口亲手编辑**，由本地透传代理提供确定性同步点）
- 判据③ 陈旧写入被拒（`stale-human-change` 回填 Provider）；④ 人工字节逐字节保留；⑤ Agent 内容未落盘
- 判据⑦ 上下文预算实际执行（`effectiveBudgetTokens=4096`）；⑧ CLI 持久化视图与 SDK 一致（`cancelled/cancelled`）

### 4.2 `boundary-interrupt-verdict.json`（7 判据，`verdict=passed`）

对应条款 **2「恢复无重复副作用」**：

- `isFakeProvider=false`、`isRealAcceptanceEvidence=true`、`sourceCommit=0b712b1`、`sourceStatus=''`
- 在工具调用边界强杀：`observedToolCallState=started`、`killedAfterMilliseconds=4351`
- 崩溃后仍有可信检查点；`requiresDecisionMissions` 含该 mission
- 只读 `recover resume` 返回 `resumed=false`、`executed=false`、
  `blockedDecisionItems=[blocked-uncertain-side-effect]`（"禁止自动二次执行"）；目标文件未改变

### 4.3 `context-recall-verdict.json`（8 判据，`verdict=passed`）

对应条款 **3「上下文预算/回访实际执行」**：

- `isRealAcceptanceEvidence=true`、`sourceCommit=0918a77`、`sourceStatus=''`、`failedCheckNames=[]`
- 红：无记忆时回访被拒（`status=not-found`）且不产生账本
- 绿：真实运行真正完成（`status=done`）→ 节点 `deferred-review-closed` ＋ 关闭胶囊
  `capsule-node-T-001-4`（＝"记忆"）＋ 延迟人工核验待办 `verify-T-001`（`priorityTier=1`，
  用户已批准该副作用）→ 回访 `status=ok`、`tier=closure-capsule`、
  `estimatedTokenCount=347`（上限 512）→ `recall-ledger.json` 落盘

## 5. 复现命令

```powershell
# 条款 1 + 4（需要你在窗口内亲手编辑目标文件）
node scripts/verify-e2e01-03-concurrency-harness.mjs --allow-live-request `
  --permission-decision allow-once --mode devolve --model step-3.7-flash `
  --protocol-label openai-compatible `
  --live-provider-endpoint https://api.stepfun.com/v1/chat/completions `
  --credential-source state --credential-reference-id prov-live-1

# 条款 2（不需人工编辑）
node scripts/verify-e2e01-03-boundary-interrupt.mjs --allow-live-request `
  --permission-decision allow-once --mode devolve --model step-3.7-flash `
  --protocol-label openai-compatible `
  --live-provider-endpoint https://api.stepfun.com/v1/chat/completions `
  --credential-source state --credential-reference-id prov-live-1

# 条款 3（会按批准产生一条延迟人工核验待办）
node scripts/verify-e2e01-03-context-recall.mjs --allow-live-request `
  --live-provider-endpoint https://api.stepfun.com/v1/chat/completions `
  --credential-source state --credential-reference-id prov-live-1 `
  --model step-3.7-flash --protocol-label openai-compatible --mode devolve
# 省额度复验绿例（跳过判据③，且不会标记为真实验收证据）：
#   追加 --reuse-completed-state-directory <已完成运行的 .astarray 目录>
```

## 6. 如实说明的局限

1. **harness 类两次运行的进程退出码不可用**：脚本写出判定文件后因子进程句柄未释放而不退出
   （已知残留问题）；结论以判定文件与日志结论行为准。`context-recall` 脚本退出码正常（0）。
2. **并发发生在同一工作树**：产品侧独立"人工工作树"分配（`GitWorktreeAllocator`）仍未接线；
   经用户裁决，"同一工作树内用户亲手并发修改"满足本节点并发语义。
3. **回访由 harness 注入调用者身份**：`ContextRecallController` 未接入 Agent 运行路径，模型无法自行发起；
   回访**不写** `context-runtime/events.jsonl`，证据面是账本 + 命令返回体。
4. **供应商切换**：验收期间 `unisound` 端点直连探测 30 秒无响应（当时已不可用），
   实际真实验收使用 `stepfun / step-3.7-flash`。
5. 本目录只固化**判定文件**（小、结构化）；`provider-requests.jsonl`、`upstream-responses.jsonl`
   等较大的原始运行产物仍留在 `.tmp/`，未入库。
