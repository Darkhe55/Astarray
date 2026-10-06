# T07D-R2-04 费用范围声明（书面，2026-10-06；usage 接线后修订版）

> 目的：满足 T07D-R2-04 卡内验收条款"记录 **usage/费用范围**"。
> 纪律：只陈述**有证据**的部分；**未记录**的部分逐条列出并说明原因（不用估算冒充账单，
> 也不把"未记录"写成"已记录"）。
>
> **本次修订要点**：原版只能给"范围 + 依据"，因为产品路径当时**不落盘** Provider usage。
> 现已完成接线（提交 `b8905a4` / `ae318f4` / `62b0d8e`），并在同一次提交 `62b0d8e` 上
> 重跑三次真实验收，**逐请求 token 已可从账目精确复核**。

## 1. 已装配：真实 usage 现在会落盘

| 项 | 变更 |
| --- | --- |
| 端口 | `packages/core/src/measurement/provider-request-usage-observation.ts`（新增） |
| 写入 | `packages/core/src/orchestration/provider-usage-ledger-observer.ts`（新增，映射为 `UsageLedgerEntry`） |
| anthropic 侧 | `AnthropicMessagesRuntime` 解析 `message_start.message.usage` 与 `message_delta.usage`（含 `cache_read_input_tokens`） |
| openai 兼容侧 | `OpenAiCompatibleRuntime` 请求 `stream_options.include_usage` 并解析收尾 chunk 的 `usage` |
| 装配 | `AstarrayApplicationFacade.create` 按状态目录构造账目观测者（CLI/TUI/SDK 共用入口） |
| 落盘位置 | 运行目录内 `.astarray/usage/entries.json`，可由 `usage overview` 与判据文件 `usageObservation` 复核 |

失败与取消**不得**写成 0：缺 usage 记 `null` 并带 `missingUsageReason`。

## 2. 最终验收运行（同一提交 `62b0d8e`、同一 tarball）

三项验收**全部通过**（各 5/5 判据、exit 0、`isRealAcceptanceEvidence: true`）：

| # | 运行标识（UTC） | 厂商 | 模型 | 协议 | 请求数 | input tokens | output tokens | 总耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | `2026-10-06T17-55-24.904Z` | unisound | `u2-flash` | anthropic-messages | **7** | **13,315** | **3,112** | 146.84 秒 |
| B | `2026-10-06T18-00-35.917Z` | unisound | `u2-flash` | openai-compatible | **4** | **7,977** | **1,512** | 147.51 秒 |
| C | `2026-10-06T18-05-44.693Z` | stepfun | `step-3.7-flash` | openai-compatible | **6** | **11,819** | **1,827** | 132.15 秒 |
| | | | | **合计** | **17** | **33,111** | **6,451** | 426.50 秒 |

- tarball：`astarray-0.1.0.tgz`，**1,102,785 字节**，
  sha256 `af66e55bfcee6ca9b6bff1f2edf2894d76ddb1cdb8b78f7739b9b15498baa244`（三次运行同一哈希）。
- 三次运行的工作区状态均为**干净（无改动）**，来源提交均为 `62b0d8e`。
- 请求数三次不同（7/4/6）：工具循环轮数由模型自己决定，脚本只提交 **1 次任务且不重试**。
- 依据：各运行目录 `acceptance-verdict.json` 的 `usageObservation` 与
  `live-project/.astarray/usage/entries.json`（逐请求记录，可逐条复核）。

## 3. 仍有未记录的部分（逐条如实登记）

**currency 金额：不给出。** 产品侧 `costEstimate.unavailableReason` 原文为
"价格表未配置：无法给出费用估算（不得以本地估算冒充账单）"，本声明同样不把 token 换算成金额。

**同日其它真实请求（未按上述精确口径记录）**：

| 时间（UTC） | 运行 | 请求数 | usage 记录情况 | 说明 |
| --- | --- | --- | --- | --- |
| 2026-10-06T15-46-49.495Z | tarball 验收（anthropic / unisound） | 4 | input 7,395 / output 1,618 | 通过；被 §2-A 取代（同一提交集内重跑） |
| 2026-10-06T15-57-22.312Z | tarball 验收（openai / stepfun） | 4 | input 7,848 / output 1,409 | 通过；被 §2-C 取代 |
| 2026-10-06T15-52-05.812Z | tarball 验收（openai / unisound） | **1** | **未读到**（记 `null` + `missingUsageReason`） | **我方缺陷**导致运行时异常终止（见 §4）；该次请求已真实发出、费用已发生 |
| 2026-10-06T13-33-17.685Z | tarball 验收（anthropic / unisound） | 4 | output 1,036；**input 记为 0（错误）** | 当时的覆盖规则缺陷把 input 钉成 0（见 §4）；真实 input 未记录 |
| 2026-10-06T09-53-37.334Z | tarball 验收（anthropic / unisound） | ≥2（2 条 `context-assembly` 事件） | **未记录** | 当时 usage 接线尚未实现 |
| 2026-10-06（两次） | `npm run verify:u2-flash-probe` | 各 1 | `input 110 / output 15`、`input 110 / output 8` | 连通探针（`max_tokens` 很小） |
| 2026-10-06（一次） | `stream_options` 兼容性探测 | 1 | **未记录** | `max_tokens=1`，只验证端点是否接受该字段（`http-status=200`） |
| 2026-10-05（四次） | tarball 运行（`isDryRun=false`） | 0（按脚本行为） | 不适用 | 当时脚本 live 路径**从不执行任务**，未发出 Provider 请求（见对账报告 §2.2） |

**口径限制（不影响 token 数，但影响可追溯性）**：

- 账目 `taskIdentifier` 目前恒为 `null`：`AgentRunInput` 只带 `missionId`/`agentId`，未带任务 ID。
- 账目 `providerProfileId` 取的是**运行时 Provider 标识**（`anthropic-messages` /
  `openai-compatible`），**不是** provider-catalog 的 profile id（两者尚未打通）。
- 仅覆盖 `anthropic-messages` 与 `openai-compatible` 两条运行时；其余适配器
  （openai-responses / gemini / bedrock / azure）仍不采集 usage。

## 4. 本次由真实运行发现并修复的两个缺陷（与费用直接相关）

1. **覆盖规则缺陷**（提交 `ae318f4`）：某厂商 `message_start.message.usage.input_tokens` 为 `0`、
   真实输入只在 `message_delta` 给出，首版实现把 0 钉死 → 账目 input 全为 0。
   已改为"`message_delta` 为累计终值，凡它给出的字段一律覆盖初值"。
2. **`usage: null` 未容忍**（提交 `62b0d8e`）：厂商在每个中间 chunk 显式发 `"usage": null`，
   首版只判 `!== undefined` → `null.prompt_tokens` 抛异常，真实任务被运行时异常终止
   （15-52-05.812Z 那次失败即此）。已修为同时判 `null` 并让类型如实包含 `| null`。

两次均由**真实验收**暴露（其中第 2 次先由失败运行的 stderr 定位、再以单测红→绿复现），
已分别补行为反例，未靠说明文字覆盖。

## 5. 结论

条款 5"记录 usage/费用范围"：**已满足**——三次最终真实运行的**逐请求 token 可精确复核**
（17 次请求 / input 33,111 / output 6,451），货币金额按产品侧既定口径**明确不给出**，
同日其余请求与三条口径限制已逐条登记。

**不得扩大**：本声明只覆盖上表所列厂商/模型/协议/平台（Windows）/入口（CLI）；
不覆盖其它模型、Provider、协议（含未接线的适配器）、平台或入口。
