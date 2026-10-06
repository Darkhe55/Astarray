# T07D-R2-04 状态对账（2026-10-06）

> 目的：卡内该检查点自 2026-09-10 起记为 **blocked**，理由是"用户尚未提供首个真实 Provider 的
> 凭据引用方式与费用授权"。此后已发生多次真实运行。本文把**卡内验收条款**与**现有证据**逐条比对，
> 给出可解除范围与仍需补齐项。
>
> 纪律：只登记本会话可直接确证的内容；无法确证的明确标注为"未确证"，不用说明文字覆盖门禁。

> **2026-10-06 更新（本次）**：在原对账之上补入三项查证结果——
> ① 原 §2"四次运行缺 `acceptance-verdict.json`"的**成因已查明**（§2.1 更正）；
> ② 发现并修复了验收脚本 live 路径的**"零判据通过"缺陷**（§6.1）；
> ③ 补齐了卡内"记录 usage"所缺的 **Provider 真实 usage 接线**（§6.3），
> 并在同一提交 `62b0d8e` 上完成**三次真实验收**（§2、§2.3、§5），
> 两个 catalog 条目按"重跑不降级"重新取证（§2.3）。**七项条款现已全部满足**（§4）。

## 1. 卡内 blocked 原因与解除条件

| 项 | 卡内原文 |
|---|---|
| blocked 原因 | 用户尚未提供首个真实 Provider 的凭据引用方式与费用授权 |
| 解除条件 | 提供 Provider/模型、受保护凭据引用与费用范围后执行受控在线小样本 |
| 验收 | 至少一个真实服务成功完成读任务和小型受控改动；若缺凭据或费用授权，本检查点 blocked，01~03 可保留通过但整卡不 done |

## 2. 验收条款逐条对账（2026-10-06 更新）

| # | 条款 | 证据 | 判定 |
|---|---|---|---|
| 1 | 至少一个真实服务成功完成**读任务** | **读任务的直接证据**：`npm run verify:u2-flash-continuous-reception`（本会话实测，exit 0，8/8）——真实 unisound `u2-flash`，两条任务均为"只读任务，禁止修改任何文件：用 `readFile` 读取 `package.json` 并回答 `name`"，终态均 `done`（`.tmp/live-u2-flash/acceptance-verdict.json`）。该运行经 `AstarrayApplicationFacade.create`（与 CLI 同一产品入口）。旁证：`docs/reports/T07D_R2_04_LIVE_ACCEPTANCE_PASSED_2026-10-02.md`、`docs/reports/T07D_R2_04_LIVE_PROVIDER_EVIDENCE_2026-10-01.md` | **已满足** |
| 2 | 至少一个真实服务成功完成**小型受控改动** | **受控改动的直接证据**：三次 tarball 隔离安装真实运行（§2.3/§5）各 5/5，产物 `.tmp/t07d-r2-04-live/LIVE-PROOF.md` 逐行精确 + `status=done` + 第五项"无其他改动"；另有 2026-10-02 dev-checkout 单次通过记录 | **已满足** |
| 3 | 记录**模型、协议、日期** | unisound `u2-flash`（anthropic-messages、openai-compatible）、stepfun `step-3.7-flash`（openai-compatible）；日期 2026-10-06；运行标识见 §2.3 | **已满足** |
| 4 | 记录**版本** | 三次最终运行同为提交 `62b0d8e`（工作区干净）+ tarball sha256 `af66e55b…a244`、1,102,785 字节 | **已满足** |
| 5 | 记录 **usage/费用范围** | `docs/reports/T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`（**修订版**）：三次最终真实运行的**逐请求 token 已可精确复核**（17 次请求 / input 33,111 / output 6,451），货币金额明确不给出 | **已满足**（Provider usage 已装配并实测落盘，见 §6.3） |
| 6 | **CLI/TUI/SDK 用同一配置** | 已确证：SDK 与 CLI 同经 `runtime-selection` 选 Provider 并注册同一 `anthropic-messages` 注册项（本会话修复了 SDK 侧漏导出的缺口）；TUI 即 CLI 命令面；GUI 服务自身不选 Provider，由启动方配置注入 | **已满足（GUI 为宿主注入，非独立路径）** |
| 7 | 受控在线小样本 | 已执行多次（含 u2-flash 连续接收实测 8/8；**本次新增** tarball 隔离安装下的真实受控任务，5/5 判据通过、exit 0） | **已满足** |

### 2.1 原述"四次运行缺判据文件"——成因已查明（更正）

原文把该现象记为"无法据文件确证这四次 tarball 真实运行的判据结果"。本次查明其**成因是能力时序**，
不是失败：

| 运行目录（UTC） | 目录最后写入（本地 +0800） |
|---|---|
| `2026-10-05T09-11-19.227Z` | 2026-10-05 17:11:32 |
| `2026-10-05T09-11-40.972Z` | 2026-10-05 17:11:47 |
| `2026-10-05T09-12-27.737Z` | 2026-10-05 17:12:33 |
| `2026-10-05T12-12-41.497Z` | 2026-10-05 20:12:58 |

而写入 `acceptance-verdict.json` 的能力由提交 `bde5d9b` 引入，时间为 **2026-10-05 20:54:19（+0800）**。
四次运行**全部早于**该提交，因此在结构上不可能产出该文件。
旁证：`2026-10-05T12-45-02.537Z` 的**干跑**确实带有 `acceptance-verdict.json`，
其 `tarball-record.json` 的 `sourceStatus` 显示脚本处于"已修改未提交"状态——与"判据落盘代码当时正在开发、
20:54 才提交"完全吻合。

**结论**：缺文件 = 当时**还没有这个功能**，不是运行失败。

### 2.2 但这四次运行仍不能作为"产品路径"证据（本次新发现）

成因查明并不改变一个更关键的事实：**当时脚本的 live 路径从不执行任务**。

- 这四次记录的 `sourceStatus` **均为空**（工作区干净），`sourceCommit` 为 `2ce4472` / `4b62d67`；
  两者的脚本版本都没有 live 分支（证据：`runOnce(` 调用数恒为 3 = 1 处定义 + 2 处干跑，
  详见 §6）。
- 因此这四次运行只做了"打包 + 隔离安装"，**没有发出任何 Provider 请求**，也就没有产品路径证据。
- 受影响的是 `provider-catalog.json` 中 `verifiedAtIso` 正好等于这些运行时间的两个条目
  （`live-provider-1` → `09:11:40.972Z`、`unisound-u2-flash` → `09:12:27.737Z`）。
  **本次不修改 `supportLevel`**（用户明确要求"重跑、不降级"），改为按下节重跑取证。

### 2.3 两个 catalog 条目已按"重跑不降级"重新取证（2026-10-06 本次）

| catalog 条目 | 需要的组合 | 重跑结果 |
|---|---|---|
| `unisound-u2-flash`（unisound / openai 兼容） | unisound + `u2-flash` + openai-compatible | ✅ 运行 `2026-10-06T18-00-35.917Z`：tarball 隔离安装下 **5/5 判据通过**、exit 0 |
| `live-provider-1`（stepfun / openai 兼容） | stepfun + `step-3.7-flash` + openai-compatible | ✅ 运行 `2026-10-06T18-05-44.693Z`：tarball 隔离安装下 **5/5 判据通过**、exit 0 |

两次运行均在同一提交 `62b0d8e`、同一 tarball
（sha256 `af66e55b…a244`，1,102,785 字节）、工作区**干净**。
`provider-catalog.json` 的 `verifiedAtIso` 已相应刷新为上述真实运行时间；
`supportLevel` 保持 `product-path-verified`（**未降级**）。

> 说明：catalog 的 `protocolName` 字段写的是 `generic-openai-compatible`，而运行时注册
> 使用的协议标识是 `openai-compatible`；两者命名不同但指向同一协议族，本次**未改动该字段**。
>
> ⚠️ **可追溯性限制**：`.astarray/` 已被 `.gitignore` 忽略（其中含凭据），因此
> `provider-catalog.json` 的 `supportLevel`/`verifiedAtIso` 是**本机状态、不进版本库**。
> 即"catalog 处于某个等级"无法从仓库历史复现；可复现的证据是上文所列的**运行目录判据文件**
> 与本文。后续如需让支持记录可审计，应把等级/时间另存为**入库**的支持记录（属另一项工作）。

## 3. blocked 原因是否已消除

| 解除条件 | 现状 |
|---|---|
| 提供 Provider/模型 | ✅ 已提供（stepfun `step-3.7-flash`；unisound `u2-flash`） |
| 受保护凭据引用 | ✅ 已有 `prov-live-1`、`prov-unisound-1`（写入 `.astarray/providers/provider-credentials.json`） |
| 费用范围授权 | ✅ **已形成书面声明**（`T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`），并已在用户授权下完成一次真实运行 |

**结论**：原 `blocked` 的**直接原因（缺凭据与授权）已消除**——凭据已存在、真实调用已多次发生、
费用范围已书面化。

## 4. 对账结论与建议

**结论：七项条款全部满足，`T07D-R2-04` 已具备置 `done` 的证据条件。**

逐项（2026-10-06 终态）：

| # | 条款 | 终态证据 |
|---|---|---|
| 1 | 真实服务完成**读任务** | `verify:u2-flash-continuous-reception`（本会话 exit 0，8/8）：真实 `u2-flash` 上两条**只读**任务（`readFile` 读 `package.json`）终态均 `done` |
| 2 | 真实服务完成**小型受控改动** | 三次 tarball 隔离安装真实运行（§2.3/§5）各 5/5：产物逐行精确 + `status=done` + **无其他改动** |
| 3 | 记录**模型/协议/日期** | `unisound u2-flash`（anthropic-messages、openai-compatible）、`stepfun step-3.7-flash`（openai-compatible）；2026-10-06；运行标识见 §2 |
| 4 | 记录**版本** | 三次运行同为提交 `62b0d8e`（工作区干净）+ tarball sha256 `af66e55b…a244`、1,102,785 字节 |
| 5 | 记录 **usage/费用范围** | 逐请求 token 可精确复核：17 次请求 / input 33,111 / output 6,451；货币金额明确不给出（费用范围声明修订版） |
| 6 | **CLI/TUI/SDK 同一配置** | 已确证（本次真实运行走的正是 `AstarrayApplicationFacade` 这一共用装配入口，CLI 与 SDK 同路径） |
| 7 | **受控在线小样本** | 已执行多次；最终三次见 §2，另含 u2-flash 连续接收实测 8/8 |

**卡状态**：按用户 2026-10-06 的授权（"完成后才按实际情况推进任务卡，必须逐项核对且有充分证据"），
本对账的逐项核对完成后，`T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md` 的
`T07D-R2-04` 已由 `blocked` 置 **`done`**，整卡状态同步置 `done`；
卡内新增 §「T07D-R2-04 验收记录」记录上述逐项证据。

**仍不得扩大的声明**：
- 只覆盖 `anthropic-messages` 与 `openai-compatible` 两条运行时、Windows、CLI 入口；
  其它适配器、平台与入口未验证；
- 三条口径限制（`taskIdentifier` 恒 null、`providerProfileId` 取运行时标识、
  `providerCacheUsage` 无生产者）随 §7a 登记；
- 已知限制（沿用）：CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

**风险提示（不得扩大声明）**：
- 本对账**不修改**任务卡状态；卡状态由作者按本文件决定。
- 本次真实运行只覆盖 **unisound / `u2-flash` / anthropic-messages / Windows / CLI 入口**，
  不得外推到其它模型、Provider、协议、平台或入口。
- 已知限制（沿用既有报告，未变化）：CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

## 5. 本对账的证据来源（更新）

- `docs/reports/T07D_R2_04_LIVE_ACCEPTANCE_PASSED_2026-10-02.md`
- `docs/reports/T07D_R2_04_LIVE_PROVIDER_EVIDENCE_2026-10-01.md`
- `docs/reports/T07D_R2_04_TARBALL_LIVE_CONFIRMATION_2026-10-02.md`（状态描述已更新）
- **`docs/reports/T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`（本次新增，条款 5）**
- `.tmp/tarball-live/*/tarball-record.json`（含 4 次 `isDryRun=false` 记录）
- **最终三次真实验收判据**（同一提交 `62b0d8e`、同一 tarball `af66e55b…a244`）：
  - `.tmp/tarball-live/2026-10-06T17-55-24.904Z/acceptance-verdict.json`（anthropic-messages / unisound `u2-flash`，7 请求 / input 13,315 / output 3,112）
  - `.tmp/tarball-live/2026-10-06T18-00-35.917Z/acceptance-verdict.json`（openai-compatible / unisound `u2-flash`，4 请求 / input 7,977 / output 1,512）
  - `.tmp/tarball-live/2026-10-06T18-05-44.693Z/acceptance-verdict.json`（openai-compatible / stepfun `step-3.7-flash`，6 请求 / input 11,819 / output 1,827）
- `.tmp/tarball-live/2026-10-06T15-52-05.812Z/acceptance-verdict.json`（失败运行，用于定位 `usage: null` 缺陷）
- 凭据目录 `.astarray/providers/provider-catalog.json`（`verifiedAtIso`，见 §7b）
- 本会话 u2-flash 连续接收实测（`scripts/verify-u2-flash-continuous-reception.mjs`，8/8）
  —— **读任务的直接证据**（两条只读任务终态均 `done`），判据落盘 `.tmp/live-u2-flash/acceptance-verdict.json`
- 本会话真实探针复测（`npm run verify:u2-flash-probe`）：http-status 200、`input_tokens=110`/`output_tokens=8`

## 6. 本次发现并修复的缺陷：验收脚本 live 路径"零判据通过"（2026-10-06）

**缺陷（静态可证，非推测）**：`scripts/verify-t07d-r2-04-tarball-live.mjs` 的判定段依赖 `rounds`，
而 `rounds` **只在 `if (isDryRun) { ... }` 内被填充**。该文件全部 6 个提交
（`f5b3957` → `883a385`）中 `runOnce(` 调用数恒为 3（1 处定义 + 2 处干跑），**从来没有 live 分支**。

因此真实模式下：`rounds=[]` → `checks=[]` → `failedChecks=[]` → 写出 `verdict: "passed"`，
并打印"验收通过：产物正确 + 任务 done ✓"，**而实际一次 Provider 请求都没有发出**。
若当时直接执行交接命令（在满足 TTY 的前提下），产出的将是一条**零判据的假验收记录**，
比"缺判据文件"更糟。

**修复（提交 `1462fa5`，已推送）**：
1. 真实分支**真正执行一次任务**，并与干跑复用**同一套**判定；
2. 判定逻辑移入 `scripts/lib/t07d-r2-04-acceptance-decision.mjs`，成为可测不变量；
3. **fail-closed**：零轮次必定 `failed`；卡内第五项"无其他改动"若未提供扫描结果即判失败
   （不允许"漏扫"静默变成"没有其他改动"）；
4. 非交互环境新增 `--permission-decision allow-once|deny`（此前只有 TTY 一条路，
   本会话该类环境必然 exit 2），裁决来源写入判据文件；
5. 凭据新增 `--credential-source state`（读受保护凭据文件的指定引用并注入子进程，
   密钥不打印、不落盘、不进判据文件）；
6. 判据文件升到 **schema v2**：新增 `executedRoundCount`、`isRealAcceptanceEvidence`、
   `permissionDecisionSource`、`credentialSource`、`usageObservation`。

**验证**：先红后绿（`tests/core/unit/t07d-r2-04-acceptance-decision.test.ts`，11 例：
红 = 11/11 失败于模块不存在 → 绿 = 11/11 通过）；干跑零额度复核 **7/7**；
真实运行 **5/5**、exit 0。

### 6.3 Provider 真实 usage 接线（2026-10-06 后续，提交 `b8905a4` / `ae318f4` / `62b0d8e`）

原缺口（§7a 旧文）：`usage-updated` 规范事件**只有声明、没有生产者与消费者**；
两个产品运行时各自解析 SSE 并丢弃厂商 usage；`UsageLedgerStore` 在生产路径上**从未被写入**。

已完成的接线：

| 提交 | 内容 |
|---|---|
| `b8905a4` | 新增使用量观测端口与账目观测者；`AnthropicMessagesRuntime` 解析并上报真实 usage；注册表透传；`AstarrayApplicationFacade.create` 按状态目录构造观测者 |
| `ae318f4` | 修正覆盖规则（`message_delta` 为累计终值，一律覆盖初值）；`OpenAiCompatibleRuntime` 接入（请求 `stream_options.include_usage` 并解析收尾 chunk） |
| `62b0d8e` | 容忍显式 `usage: null`（修复真实运行暴露的运行时异常终止） |

**由真实运行发现并修复的两个缺陷**（都不是靠推理发现的）：
1. 覆盖规则把 input 钉成 0（`2026-10-06T13-33-17.685Z` 运行账目实测 `input=0`）；
2. `usage: null` 抛 `Cannot read properties of null (reading 'prompt_tokens')`，
   导致 `2026-10-06T15-52-05.812Z` 的真实任务 `status=blocked`、无产物（exit 1）。

两者分别以行为反例红→绿复现并修复；两个用例文件合计 **10/10 通过**（exit 0）。
接线后三次最终真实运行的**逐请求 token 已可精确复核**（见费用范围声明 §2）。

## 7. 未闭合缺口（登记，不伪称闭合）

**(a) ~~Provider usage 未装配到产品运行路径~~ → 已装配（2026-10-06，提交 `b8905a4`/`ae318f4`/`62b0d8e`）**。
三次最终真实运行的逐请求 token 已可从 `.astarray/usage/entries.json` 精确复核。
**仍存在的口径限制**（不伪称已解决）：
- 账目 `taskIdentifier` 恒为 `null`（`AgentRunInput` 未带任务 ID）；
- 账目 `providerProfileId` 取**运行时 Provider 标识**（`anthropic-messages` / `openai-compatible`），
  不是 provider-catalog 的 profile id；
- 仅 `anthropic-messages` 与 `openai-compatible` 两条运行时接入；
  `openai-responses` / `gemini` / `bedrock` / `azure` 仍未采集 usage；
- `context-runtime-metrics` 的 `providerCacheUsage` 仍无生产者（另一条指标线）。

**(b) `provider-catalog.json` 两个条目** —— 用户要求"重跑、不降级"，已按 §2.3 重跑取证：
两个条目现由**同一提交 `62b0d8e`、同一 tarball 下 5/5 通过**的真实运行支撑，
`verifiedAtIso` 已刷新为该运行时间，`supportLevel` 保持 `product-path-verified`（未降级）。

**(c) 既有未闭合项（沿用，未变化）** —— `InstructionWindowStore` 未装配到
mission-orchestrator/main-controller；读抑制账本与 local-progress-and-cycle-guard 同样未装配；
CLI 在给出结果后进程仍会滞留（既有 `it.skip`，产品侧未修）。
