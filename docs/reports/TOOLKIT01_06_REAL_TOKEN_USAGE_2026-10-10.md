# TOOLKIT-01-06：真实 token 消耗实测（u2-flash，2026-10-10）

> 本文件补齐 TOOLKIT-01-06 长期缺口的**真实 Provider 用量证据**。
> 卡内 §"资源收益"原文："相同 fixture 对比原流程/工具化流程，报告工具调用数、
> **模型请求/token**、延迟、失败/返修率及构建成本；**无真实 usage 标为未测，不杜撰节省**"。
> 此前只能写"无真实 usage ⇒ 未测"；本轮取得额度后**实测到真实 token 用量**。

## 0. 环境与命令

| 项 | 值 |
| --- | --- |
| Provider | 云之声 Unisound（MaaS） |
| 模型 | `u2-flash`（真实慢模型） |
| 协议 / 端点 | `anthropic-messages` / `https://maas-api.unisound.com/anthropic/v1/messages` |
| 凭据 | 受保护引用 `prov-unisound-1`（**未读取、未打印、未落盘**；脚本断言前后 sha256 一致） |
| 命令 | `node scripts/verify-u2-flash-token-usage.mjs --rounds 3` |
| 用量来源 | **真实账目** `<state-dir>/usage/entries.json`（由 `public-sdk.ts` 装配的 `UsageLedgerStore` 写入） |

**关于装配方式**：`--provider-credential-reference` 路径下，运行时的 `baseUrl`
**取自凭据条目**（`…/v1`，OpenAI 形态），且 `--provider-endpoint` 会被**忽略** ——
对 `anthropic-messages` 会 404。故本脚本与姊妹脚本一样**手动构造 registry**
并把 `baseUrl` 显式设为 Anthropic 端点。（该差异已记录，见 §4。）

## 1. 结果：**6/6 判据通过，exit 0**

**3 轮**重复只读任务，逐轮账目（**真实、非估算、非 null**）：

| 轮次 | 终态 | 延迟 | 模型请求数 | input | output | cached | estimated | missingUsage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | `done` | 11747 ms | 2 | **3966** | 139 | 0 | 0 | 0 |
| #2 | `done` | 12306 ms | 2 | **3966** | 131 | 0 | 0 | 0 |
| #3 | `done` | 7693 ms | 2 | **3966** | 138 | 0 | 0 | 0 |
| **合计** | 3/3 done | mean 10582 ms | **6** | **11898** | **408** | **0** | **0** | **0** |

**可直接引用的结论**：
- **每轮固定 2 次模型请求、3966 input tokens**（三轮**完全相同**）；
- **output 仅 131–139 tokens**（抽取式任务，输出极短）；
- **cached = 0** ⇒ 该端点/模型**未返回提示缓存命中**（不是我们未采集：字段存在且值为 0）；
- **延迟 7.7–12.3 s/轮**（mean 10.6 s），属 `machine-specific` 口径，**不得**作为跨机器结论；
- **无任何缺失或估算条目**（`missingUsage=0`、`estimated=0`）。

> **单轮 input 恒定 3966 是重要信号**：两轮之间上下文**没有增长**，
> 与 §2 交付的"**单轮成本不随轮数增长**"（`isPerRoundCostStable`）互为印证 ——
> 一个来自**真实调用**，一个来自**离线结构计量**。

## 2. 与"更大样本"结构性计量的关系（两者互补，不可互相替代）

| 口径 | 来源 | 能证明什么 | 局限 |
| --- | --- | --- | --- |
| **结构计量**（`measureRecipeReuseAcrossRounds`） | 离线、确定性、可复现 | 工具调用数守恒（6 轮 × 3 次 = 18）、一次性 vs 按轮成本、失败轮不计入节省 | **不含**真实 token |
| **真实用量**（本文件） | 真实 Provider 账目 | 真实 input/output/cached token、模型请求数、延迟 | 样本小（3 轮）、延迟不可跨机器 |

## 3. 如实标为**未测**的项（不得用 0 或估算顶替）

| 指标 | 状态 | 原因（代码证据） |
| --- | --- | --- |
| **工具调用数** | **未测** | `PublicTaskResult`（`public-sdk.ts:653`）与 `MissionStatus`（`mission-manager.ts:23`）**均无工具调用计数字段**；`MainController.getMetricsSnapshot()` **无条件 `return null`**；`perfSampleSink` 仅在 `runtime/tool-loop.ts:53` **声明**、全仓**无装配注入** ⇒ 无持久化取证 |
| **费用 / 节省金额** | **未测** | 价格表未配置（`usage-ledger-store.ts:320`）；**不得以本地估算冒充官方账单** |
| **原流程（手工）路径的 token** | **未测** | 本轮只测了**工具化路径**的真实 token；**因此仍不能给出"token 节省"结论** |
| **真实维护成本 / 跨平台可比性** | **未测** | 需跨版本与跨平台样本 |

**明确不主张**：本轮**没有**得到"工具化省了多少 token"的结论 ——
要得到它必须**在同一 fixture 下把原流程也真实跑一遍**并逐项对比，
本轮**未做**该对照。卡内"不杜撰节省"的纪律据此保持。

## 4. 附带发现 —— **已修复（2026-10-10 同一会话）**

`--provider-credential-reference` + `--provider-protocol anthropic-messages` 的组合
在本仓**当前不可用**：`runtime-selection.ts:141` 把 `baseUrl` 取自**凭据条目**
（`…/v1`，OpenAI 形态），而 `openai-compatible-runtime.ts:149` /
`anthropic-messages-runtime.ts:166` 都把 `baseUrl` 当作**完整端点**使用，
且该分支下 `--provider-endpoint` **被忽略** ⇒ 必然 404。
两处不一致（"凭据里 baseUrl 的形态" vs "运行时把 baseUrl 当完整端点"）
**属真实可用性缺口。**

**已修复（`4e8c52d`）**：显式给出的端点现在**优先**（显式输入胜过存储默认值），
未给出或空串时才回退凭据 `baseUrl`（保住"引用存在 ⇒ 无需 `--provider-endpoint`"
的原契约）；并新增 `isEndpointFromCredential` 标明来源，使诊断能回答
"我用的到底是谁的端点"。

**端到端验证**：同一条此前必然 404 的命令，修复后 **exit 0、`{"status":"done"}`**：
```bash
node dist/cli.js run "只回答两个字：可用" --runtime openai-compatible \
  --provider-endpoint https://maas-api.unisound.com/anthropic/v1/messages \
  --provider-model u2-flash --provider-protocol anthropic-messages \
  --provider-credential-reference prov-unisound-1
```
反例先红后绿：`tests/tui/unit/runtime-endpoint-priority.test.ts` **4 条**（实现前 ①③ 红）。

## 5. 复现

```bash
# 每次真实调用都计费；--rounds 硬上限 5
node scripts/verify-u2-flash-token-usage.mjs --rounds 3
# 判据落盘：.tmp/live-u2-flash-usage-state/acceptance-verdict.json
```
