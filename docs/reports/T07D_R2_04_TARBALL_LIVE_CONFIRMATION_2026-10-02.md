# T07D-R2-04 tarball 路径真实运行：干跑证据与真实执行范围

> **状态（2026-10-06 更正）**：**脚本已就绪；干跑通过；真实运行已执行且通过。**
>
> 本文写于 2026-10-02，原为"执行前确认"（当时确实尚未执行真实运行）。
> 该句原始表述（"真实运行尚未执行"）**已过期**，与 2026-10-05 起的真实运行记录冲突，
> 现按实际记录更正：真实运行的判据、修复与未闭合项见 **§8**（2026-10-06 更新）。
> §1–§3 的历史数值（tarball 哈希、来源提交、干跑结果）保留为**当时**的快照，不得当作最新值。

## 1. 固定来源与 tarball

| 项 | 值 |
| --- | --- |
| 来源提交 | `e9350e205716f2bf8c7601c0acd72d98dbbc6424`（`e9350e2`，已推送） |
| 工作区状态 | **有未提交改动**（均为你自己的并行文件；`npm pack` 会把工作树内容一并打包，脚本已在记录里如实标注） |
| tarball 文件名 | `astarray-0.1.0.tgz` |
| tarball 字节数 | 998785 |
| **tarball sha256** | `1050d81ead35a17e5a7324e85f3e9d4acde7ee8cc08a8ae79178af99b9e52fb2` |
| 复现性 | 在**同一工作树状态**下重复 `npm pack` 得到**同一 sha256 与同一字节数**（已实测两次一致） |

> 若要得到"仅由提交决定"的 tarball，需要先提交/暂存你的并行改动；否则哈希包含你的未提交内容。
> 脚本会在输出中明确打印"工作区状态"，不隐瞒这一点。

## 2. 隔离安装与入口（满足"用安装包入口、全新测试目录、不复制原凭据目录"）

| 要求 | 实现 |
| --- | --- |
| 用安装包入口 | 从 `node_modules/astarray/dist/cli.js` 运行（`npm install <tarball>` 之后的真实安装产物），**不是** dev checkout 的 `dist/cli.js` |
| 全新测试目录 | `.tmp/tarball-live/<运行标识>/install/`；以该目录为 `cwd` 运行 → 状态目录是该目录自己的 `.astarray/` |
| 不复制原凭据目录 | 脚本在安装后**显式断言**该目录不存在 `.astarray/`；凭证只经 `--provider-api-key-env` 环境变量读取，不落盘、不回显 |

## 3. 干跑证据（零真实额度；两条路径）

命令：
```powershell
node scripts/verify-t07d-r2-04-tarball-live.mjs --dry-run --provider-endpoint https://api.stepfun.com/v1/chat/completions --model step-3.7-flash
```

结果（**6/6 通过**）：

| 路径 | 判据 | 结果 |
| --- | --- | --- |
| A 成功路径 | `status=done` | ✓ |
| A | `permissionAsk=allowed-once` | ✓ |
| A | 产物存在 | ✓ |
| A | 产物逐行精确（期望 sha256 `3ebded05…d8ee`） | ✓ |
| **B 缺产物拒绝结案** | **不得结案为 done** → 实测 `status=blocked` | ✓ |
| B | 无产物 | ✓ |

- B 路径的构造：假 Provider **声明** `declaredArtifacts: [".tmp/t07d-r2-04-live/LIVE-PROOF.md"]`
  但从不真正调用工具 → 本地完成门禁做产物对账后**拒绝结案**。这直接验证了卡内要求的
  "产物缺失 + 声称完成 = 阻断项"，而不是只验证"模型没声明就不算"。
- 干跑 A 的"权限裁决"路径与真实运行**完全一致**（同一 `dist`、同一 CLI、同一完成门禁）。

## 4. 真实运行命令

> **2026-10-06 更新**：原命令**不足以跑通真实模式**（缺 `--provider-endpoint`，且非交互环境必然
> exit 2）。以下为当前可用形态；凭据可经环境变量或受保护凭据文件两种方式提供。

凭证只经环境变量（沿用你已有的 key，不需要写入任何文件）：

```powershell
$env:ASTARRAY_PROVIDER_API_KEY = "<你的 StepFun API key>"
node scripts/verify-t07d-r2-04-tarball-live.mjs --allow-live-request --provider-endpoint https://api.stepfun.com/v1/chat/completions --model step-3.7-flash
# 或：npm run verify:t07d-r2-04-tarball-live -- --provider-endpoint https://api.stepfun.com/v1/chat/completions --model step-3.7-flash
```

非交互环境（服务化/管道）必须**显式**给出一次裁决，否则脚本 fail-closed（exit 2）：

```powershell
node scripts/verify-t07d-r2-04-tarball-live.mjs `
  --allow-live-request `
  --provider-endpoint https://maas-api.unisound.com/anthropic/v1/messages `
  --vendor-identifier unisound --model u2-flash --protocol-label anthropic-messages `
  --credential-source state --credential-reference-id prov-unisound-1 `
  --permission-decision allow-once
```

要点：
- 真实模式默认**要求 TTY**；非交互时必须显式 `--permission-decision allow-once`
  （该选择会写入判据文件的 `permissionDecisionSource`，供事后审计）；
- 出现权限询问时输入一次 `allow-once`；
- 脚本**只跑 1 次任务**，不重试；
- `--credential-source state` 从受保护凭据文件读取指定引用并注入子进程，
  **密钥不打印、不落盘、不进判据文件**。

## 5. 真实运行预算

> **2026-10-06 更新**：实际执行的费用范围已在
> `docs/reports/T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md` 中书面化
> （真实请求次数 2、单次真实 usage 下界 `input 110`、实测总耗时 165.43 秒、货币金额不给出）。
> 下表为**执行前**的预算估计，保留为历史快照。

| 项 | 值 |
| --- | --- |
| 任务次数 | **1 次**（脚本不重试） |
| 模型 | `step-3.7-flash` |
| 端点 | `https://api.stepfun.com/v1/chat/completions` |
| Provider 请求次数 | **不确定**：任务允许模型与工具循环多轮，可能是若干次 chat completions（非 1 次） |
| 超时护栏 | 单次请求 120s、任务 240s（可用 `--request-timeout-seconds` / `--task-timeout-seconds` 调整；脚本硬上限为任务超时 + 60s） |
| 判定 | 五项判据须在**同一次运行**内全部通过（`status=done`、`allowed-once`、产物存在、逐行精确、无其他改动） |

## 6. 等级升级所需范围（如真实运行通过）

**可以升级的**（且**仅限**这些）：

| 项 | 值 |
| --- | --- |
| 记录 | `provider-catalog.json` 中 `providerProfileId = "live-provider-1"` |
| 协议 | `generic-openai-compatible` |
| 模型 | `step-3.7-flash` |
| 等级 | `live-smoke-verified` → `product-path-verified` |
| 依据 | 在 tarball 隔离安装（sha256 `1050d81e…`，来源 `e9350e2`）下经 CLI 完成真实受控工作流，五项判据全过 |

> **2026-10-06 更正（重要）**：上表的"依据"写在 §5/§2 所述四次运行**之前**，而那四次运行
> 经本次查证**并未通过脚本发出任何 Provider 请求**（脚本 live 路径当时从不执行任务，
> 见 `T07D_R2_04_STATUS_RECONCILIATION_2026-10-06.md` §2.2 与 §6）。
> 因此：`provider-catalog.json` 中 `live-provider-1` 与 `unisound-u2-flash` 两条目的
> `supportLevel = product-path-verified` **目前缺乏 tarball 产品路径证据**。
> 本次**未修改**该文件（用户明确要求只登记）；处置由作者决定。

**不得扩大声明**（仍为未验证 / 已知限制，会写入 knownLimitations）：
- 其它模型、其它 Provider、其它协议；
- Linux/macOS（本机为 Windows）；
- TUI 与 SDK 入口（本次只验收 CLI）；
- 跨项目/安装类操作（本次为项目内单文件新建）；
- CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

## 7. 尚未做的事（2026-10-06 更正）

- ~~真实运行未执行~~ → **已执行且通过**（见 §8）。本文原为执行前确认。
- **逐请求 usage 仍未落盘**：Provider usage 捕获模块未装配到产品运行路径，
  故条款 5 只能给"范围 + 依据"（见 `T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md` §7）。
- `provider-catalog.json` 的 `supportLevel` 本次**未改动**（见 §6 更正）。

## 8. 真实运行记录与脚本修复（2026-10-06）

### 8.1 发现并修复的缺陷：live 路径"零判据通过"

原脚本判定段依赖 `rounds`，而 `rounds` **只在 `if (isDryRun) { ... }` 内被填充**
（全部 6 个提交 `f5b3957` → `883a385` 的 `runOnce(` 调用数恒为 3 = 1 处定义 + 2 处干跑，
从来没有 live 分支）。真实模式下 `rounds=[]` → `checks=[]` → `failedChecks=[]` →
写出 `verdict: "passed"` 并打印"验收通过：产物正确 + 任务 done ✓"，**而一次请求都没发**。

修复（提交 `1462fa5`，已推送 `origin/main`）：
- 真实分支真正执行一次任务，与干跑复用**同一套**判定；
- 判定逻辑移入 `scripts/lib/t07d-r2-04-acceptance-decision.mjs`；
- **fail-closed**：零轮次必定 failed；第五项"无其他改动"未提供扫描结果即判失败；
- 新增 `--permission-decision allow-once|deny`（非交互环境唯一可行路径，来源入判据文件）；
- 新增 `--credential-source state`（读受保护凭据文件，密钥不打印/不落盘）；
- 判据文件升到 **schema v2**。

先红后绿：`tests/core/unit/t07d-r2-04-acceptance-decision.test.ts` 11 例
（红 = 11/11 失败于模块不存在 → 绿 = 11/11 通过）。

### 8.2 真实运行判据（tarball 隔离安装，真实 Provider）

| 项 | 值 |
| --- | --- |
| 运行标识 | `2026-10-06T09-53-37.334Z` |
| 来源提交 | `1462fa5`（运行时**工作区干净**） |
| tarball | `astarray-0.1.0.tgz`，1,093,410 字节，sha256 `8533d919…7bab` |
| 安装包入口 | `<运行目录>/install/node_modules/astarray/dist/cli.js` |
| 厂商 / 模型 / 协议 | unisound / `u2-flash` / `anthropic-messages` |
| 端点 | `https://maas-api.unisound.com/anthropic/v1/messages` |
| 凭据 | 引用 `prov-unisound-1`（`credentialSource = state`，值不打印） |
| 裁决来源 | `permissionDecisionSource = explicit-flag` |
| 判据 | **5/5 通过**（`status=done`、`allowed-once`、产物存在、逐行精确、**无其他改动**） |
| 退出码 | **0** |
| 判据文件 | `.tmp/tarball-live/2026-10-06T09-53-37.334Z/acceptance-verdict.json`（`schemaVersion: 2`，`isRealAcceptanceEvidence: true`） |

> `isRealAcceptanceEvidence = true` 只在"真实运行 + 判据全过"时成立；干跑永远为 `false`。
> 本次运行同时验证了第五项判据"无其他改动"（扫描结果为空清单）。

### 8.3 最终取证：三项验收在同一提交上全部通过（2026-10-06）

在同一提交 `62b0d8e`（工作区**干净**）、同一 tarball
（sha256 `af66e55bfcee6ca9b6bff1f2edf2894d76ddb1cdb8b78f7739b9b15498baa244`，1,102,785 字节）
上各跑一次，**全部 5/5 判据通过、exit 0**：

| 运行标识（UTC） | 厂商 / 模型 / 协议 | 请求数 | input / output tokens | 耗时 |
|---|---|---|---|---|
| `2026-10-06T17-55-24.904Z` | unisound / `u2-flash` / anthropic-messages | 7 | 13,315 / 3,112 | 146.84 秒 |
| `2026-10-06T18-00-35.917Z` | unisound / `u2-flash` / openai-compatible | 4 | 7,977 / 1,512 | 147.51 秒 |
| `2026-10-06T18-05-44.693Z` | stepfun / `step-3.7-flash` / openai-compatible | 6 | 11,819 / 1,827 | 132.15 秒 |

逐请求 token 来自各运行目录 `live-project/.astarray/usage/entries.json`（Provider usage 接线后
由产品路径真实落盘），并经 `acceptance-verdict.json` 的 `usageObservation` 复核。
该表同时构成 §6 所述两个 catalog 条目的新证据（**重跑，未降级**）。

### 8.4 本次由真实运行发现并修复的两个缺陷（usage 接线相关）

1. **覆盖规则缺陷**（提交 `ae318f4`）：某厂商 `message_start.message.usage.input_tokens` 为 `0`、
   真实输入只在 `message_delta.usage` 给出；首版把 0 钉死，账目 input 全为 0
   （`2026-10-06T13-33-17.685Z` 运行实测）。已改为"`message_delta` 为累计终值，一律覆盖初值"。
2. **未容忍显式 `usage: null`**（提交 `62b0d8e`）：厂商在每个中间 chunk 发 `"usage": null`，
   首版只判 `!== undefined` → `Cannot read properties of null (reading 'prompt_tokens')`，
   真实任务被运行时异常终止（`2026-10-06T15-52-05.812Z` 运行 `status=blocked`、无产物、exit 1）。

两者均先补行为反例（红）再修复（绿），两个用例文件合计 10/10 通过。
