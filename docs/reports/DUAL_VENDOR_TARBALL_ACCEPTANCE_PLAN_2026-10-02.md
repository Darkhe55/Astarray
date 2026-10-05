# 双厂商 tarball 真实验收计划（stepfun + unisound U2 Flash）

> 状态：**脚本与干跑已就绪；两次真实运行均未执行**（真实额度消耗 0）。
> 基线：`HEAD == origin/main == 3c5abd3`；`npm run check` exit 0（265 文件 / 2008 用例）。

## 1. 共同前置（两家一致）

| 项 | 值 |
| --- | --- |
| 打包方式 | `npm pack --ignore-scripts`（**确定性打包**：跳过 `prepack` 的全量测试，避免负载抖动导致哈希不可复现） |
| tarball | `astarray-0.1.0.tgz` / 998785 字节 / **sha256 `1050d81ead35a17e5a7324e85f3e9d4acde7ee8cc08a8ae79178af99b9e52fb2`**（两次实测一致） |
| 运行入口 | 隔离安装后的 **`node_modules/astarray/dist/cli.js`**（安装包入口，非 dev checkout） |
| 测试目录 | `.tmp/tarball-live/<运行标识>/install/`（**全新目录**；以它为 `cwd` → 状态目录是该目录自己的 `.astarray/`） |
| 凭据 | 只经 **`--provider-api-key-env`**（默认 `ASTARRAY_PROVIDER_API_KEY`）环境变量；脚本显式断言测试目录内**不存在** `.astarray/`（不复制原凭据目录），且不打印 key |
| 交互 | 真实模式**要求 TTY**；出现权限询问时输入一次 `allow-once` |
| 任务次数 | **每家 1 次**（脚本不重试） |
| 超时护栏 | 单次请求 120s、任务 240s（可用 `--request-timeout-seconds` / `--task-timeout-seconds` 调整；硬上限 = 任务超时 + 60s） |
| 判定 | 五项判据须在**同一次运行**内全过：`status=done`、`permissionAsk=allowed-once`、产物存在、**产物逐行精确**、无其他改动 |

## 2. 第 1 家：stepfun

| 项 | 值 |
| --- | --- |
| 厂商标识 | `stepfun` |
| endpoint | `https://api.stepfun.com/v1/chat/completions` |
| 模型 | `step-3.7-flash` |
| 期望产物内容 | 四行：标题 + `厂商：stepfun` + `端点：api.stepfun.com` + `模型：step-3.7-flash` |
| 期望内容 sha256 | `774e343297f4ce88f11176089d760a4ed950a3a56f09d3d33d2cd31b0684beb1` |
| 干跑 | ✓ 6/6（成功路径 4/4、缺产物拒绝结案 2/2） |

```powershell
$env:ASTARRAY_PROVIDER_API_KEY = "<StepFun key>"
npm run verify:t07d-r2-04-tarball-live -- --vendor-identifier stepfun --provider-endpoint https://api.stepfun.com/v1/chat/completions --model step-3.7-flash
```

**通过后的记录变更**（仅此一条）：`provider-catalog.json` 中 `providerProfileId = "live-provider-1"`
（协议 `generic-openai-compatible`）的 `supportLevel`：`live-smoke-verified` → **`product-path-verified`**。

## 3. 第 2 家：unisound（U2 Flash）

| 项 | 值 |
| --- | --- |
| 厂商标识 | `unisound` |
| endpoint | `https://maas-api.unisound.com/v1/chat/completions` |
| 模型 | `u2-flash` |
| 期望产物内容 | 四行：标题 + `厂商：unisound` + `端点：maas-api.unisound.com` + `模型：u2-flash` |
| 期望内容 sha256 | `16f158425b7fe9a21e5fd716af78d2ef6519846f92b2cdd6709015d5cd64c73f` |
| 干跑 | ✓ 6/6（成功路径 4/4、缺产物拒绝结案 2/2） |

```powershell
$env:ASTARRAY_PROVIDER_API_KEY = "<Unisound 按量计费 key>"
npm run verify:t07d-r2-04-tarball-live -- --vendor-identifier unisound --provider-endpoint https://maas-api.unisound.com/v1/chat/completions --model u2-flash
```

**计费**：你的 key 是**按量计费**（与 Token Plan 专属 key 不可互换，用错会鉴权失败）。
但 **U2 Flash 当前定价为 0**（输入 / 缓存命中 / 输出 均 0 元/百万 tokens，限时免费
2026.09.30–2026.10.31）→ **本次预计花费 0 元**，尽管它是一次真实调用。

**通过后的记录变更**：**新增**一条该厂商的 `ProviderSupportRecord`
（`protocolName = "generic-openai-compatible"`、模型 `u2-flash`、`supportLevel = product-path-verified`、
`verifiedAtIso` = 实际时间、`testEvidenceReferences` = 本次 tarball 验收记录）。
**不修改** `live-provider-1` 那条。

## 4. 两家共同不覆盖的范围（写入 knownLimitations，不扩大声明）

- **非 OpenAI 兼容协议**：`anthropic-messages`、`gemini-interactions`、`bedrock-converse`、`azure-openai`
  的适配器代码存在，但 **CLI 的 `run` 只注册了 `openai-compatible`**
  （`packages/tui/src/cli/runtime-selection.ts:92` 与 `:135`），因此**当前不能对它们宣称任何等级**。
  → "多厂商支持"的准确表述是"**多厂商（OpenAI 兼容协议）**"。
- **入口范围**：只验收 **CLI**；TUI 与 SDK 入口未验证。
- **平台**：Windows；Linux/macOS 未验证。
- **任务类型**：项目内单文件新建；跨项目、安装类、Git 写操作未验证。
- **已知残留**：CLI 在给出结果后进程仍会滞留（验收脚本已规避，产品侧未修）。
- 每家的等级**分开记**，不得合并成"多厂商皆已支持"。

## 5. 建议执行顺序

1. 先跑 **stepfun**（把既有那条记录真正升级；一次只变一个变量）
2. 再跑 **unisound**（引入"新厂商记录 + 新凭据"两件新事）
3. 每次把**五项判据 + 结论行**贴回；失败时加 stderr 末尾与退出码

## 6. 未做 / 待你确认

- **两次真实运行均未执行**（本文件是执行前确认）。
- `supportLevel` 与 `provider-catalog.json` **未改动**。
- 若你希望**同时**保留 dev-checkout 路径的证据，可额外各跑一次 `verify:t07d-r2-04-live`；
  但这不影响本计划的结论范围。
