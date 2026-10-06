# T07D-R2-04 费用范围声明（书面，2026-10-06）

> 目的：满足 T07D-R2-04 卡内验收条款"记录 **usage/费用范围**"。
> 纪律：本声明只陈述**有证据**的部分，并显式列出**未记录**的部分及其原因——
> 不用估算冒充账单，也不把"未记录"写成"已记录"。

## 1. 本次真实运行的标识与范围边界

| 项 | 值 |
| --- | --- |
| 运行标识 | `2026-10-06T09-53-37.334Z` |
| 判据落盘时间 | `2026-10-06T09:56:22.764Z` |
| **运行总耗时** | **165.43 秒**（由上述两个时间戳相减） |
| 来源提交 | `1462fa5`（运行时工作区**干净**） |
| 安装包 | `astarray-0.1.0.tgz`，**1,093,410 字节**，sha256 `8533d919ee9287cd2f6f61bf9f3635d73d658870ab1d08e5ceb1792a4dde7bab` |
| 隔离安装 | `.tmp/tarball-live/2026-10-06T09-53-37.334Z/install/`（不复制仓库 `.astarray`） |
| Provider / 模型 / 协议 | unisound / `u2-flash` / `anthropic-messages` |
| 端点 | `https://maas-api.unisound.com/anthropic/v1/messages` |
| 凭据 | 受保护凭据文件引用 `prov-unisound-1`（**值不打印、不落盘、不进判据文件**） |
| 裁决来源 | `permissionDecisionSource = explicit-flag`（`--permission-decision allow-once`） |
| 任务次数 | **1 次**（脚本不重试） |
| 判定 | 5/5 判据通过，进程退出码 **0** |

证据文件：`.tmp/tarball-live/2026-10-06T09-53-37.334Z/acceptance-verdict.json`（`schemaVersion: 2`，
`isRealAcceptanceEvidence: true`）与同目录 `tarball-record.json`。

## 2. 真实模型调用次数（**下界**，有直接证据）

**至少 2 次模型调用。** 证据：本次运行的隔离状态目录内存在**恰好 2 条** `context-assembly` 事件：

| 事件时间 | agentInstanceId | estimatedInjectedTokenCount |
| --- | --- | --- |
| `2026-10-06T09:53:48` | `worker:mission-c60585df:T-001:1` | 41 |
| `2026-10-06T09:54:22` | `worker:mission-c60585df:T-001:2` | 41 |

两个不同的 worker 实例各至少产生一次调用，相隔约 34 秒，与"第一次调用产出工具调用 →
第二次调用给出完成控制事件"的预期一致。

> **口径说明（不得扩大）**：`context-assembly` 事件数是**模型调用次数的下界**，
> 不等于 Provider 请求数——单个 worker 内若发生重发或重试，请求数会更多。
> 由于 §4 所述"逐请求 usage 未落盘"，**本次运行的精确请求数无法从证据复核**。
> 故本文只声明下界与护栏上界。

> ⚠️ `estimatedInjectedTokenCount = 41` 是**被注入上下文**的估算值，**不是** Provider 请求的 token 用量，
> 不得当作 usage 使用（两者口径不同）。

## 3. 单次调用的真实 usage（实测）

来自**版本化**探针 `scripts/verify-u2-flash-continuous-reception.mjs --probe-only`
（`npm run verify:u2-flash-probe`），同端点、同模型、同协议：

| 日期 | http-status | elapsed | 真实 usage |
| --- | --- | --- | --- |
| 2026-10-06（早先一次） | 200 | 8395 ms | `input_tokens = 110` / `output_tokens = 15` |
| **2026-10-06（本次复测）** | **200** | **11709 ms** | **`input_tokens = 110` / `output_tokens = 8`**，`cache_creation = 0` / `cache_read = 0` |

两次 `input_tokens` 均为 **110**，说明该协议路径下"系统提示 + 协议开销 + 极短用户消息"的
输入下限是 110 tokens。

本次验收任务的用户提示词为 **805 字符 / 19 行**（可从 `acceptance-verdict.json` 的
`rounds[0].parsedResult.prompt` 逐字复核）。

## 4. 本次运行 token 范围的诚实陈述

**未记录（关键限制）**：本次验收运行的**逐请求** input/output token 数**没有落盘**。
原因已查证并单列为缺口（见 §7）：

- `packages/core/src/measurement/provider-usage-capture.ts` 的
  `createJsonlProviderUsageCapture` 在仓库内**只**被 `scripts/verify-measurement-package.mjs`
  与其单测 `tests/core/integration/provider-usage-capture.test.ts` 引用，
  **未装配到产品运行路径**；
- 本次运行的隔离状态目录内也确实**不存在** `usage/entries.json`（已逐目录确认）。

因此下面的数字是"**下界 + 护栏上界**"的形式，**不是账单级精确值**：

| 维度 | 值 | 依据 |
| --- | --- | --- |
| 模型调用次数（**下界**） | **≥ 2** | 2 条 `context-assembly` 事件（§2）；精确请求数不可复核 |
| 单请求输入 tokens（**下界**） | ≥ 110 | 探针实测（§3）；真实请求另含系统提示、工具 schema 与工具结果，故实际更高（未记录） |
| 单请求输出 tokens（实测量级） | 8–15 | 两次探针实测（§3）；本次任务输出为"一次工具调用 + 一段完成文本" |
| 单请求超时护栏 | 120 秒 | 脚本参数 `--request-timeout-seconds`（本次使用默认值） |
| 任务超时护栏 | 240 秒 | 脚本参数 `--task-timeout-seconds`（本次使用默认值） |
| 运行总耗时（实测） | 165.43 秒 | §1 两个时间戳相减，**< 240 秒护栏** |
| 任务/重试次数硬上界 | 1 次任务、不重试 | 脚本设计（`--allow-live-request` 单次运行） |

## 5. 货币金额：不给出（有明确原因）

- 产品侧用量聚合的 `costEstimate.amountMinorUnits` 为 `null`，其
  `unavailableReason` 原文为"价格表未配置：无法给出费用估算（不得以本地估算冒充账单）"。
- 本声明据此**不给出任何货币数字**，也不把 token 数自行换算成金额。

## 6. 不得扩大的声明（范围外）

- 其它模型、其它 Provider、其它协议、其它端点；
- 其它会话、其它任务类型、其它项目；
- **2026-10-05 的四次 `isDryRun=false` 记录不得作为费用范围依据**——经查证，
  当时脚本的 live 路径**从不执行任务**（见对账报告 §2 更正与 §6 缺陷登记），
  因此它们既无判据文件也无真实请求可计入；
- 干跑（本会话 7/7 通过）由本地假 Provider 驱动，**不产生任何 Provider 费用**。

## 7. 结论与未闭合项

条款 5"记录 usage/费用范围"：**已形成本书面声明**。其中有证据的部分是
"模型调用次数下界（≥2）""单次调用真实 usage 下界（input 110 / output 8）"
"时间护栏与实测耗时（165.43 秒 < 240 秒）"。

**仍然未闭合（如实登记，不得宣称已闭合）**：本次运行自身的**逐请求 token 用量未被产品路径记录**，
因为 Provider usage 捕获模块未装配到产品运行路径。因此本声明给出的是**范围与依据**，
**不是**该次运行的账单级精确值。该缺口已在对账报告中单列。
