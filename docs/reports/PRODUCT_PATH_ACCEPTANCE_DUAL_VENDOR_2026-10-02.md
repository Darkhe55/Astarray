# 生产路径验收记录（tarball 隔离安装 · 双厂商）

> 基线：`HEAD == origin/main == 2ce4472`。两次真实运行分别在**同一 tarball** 上执行并通过。
> 结论严格限于实际验证到的范围（§4 逐条列出未覆盖项）。

## 1. 共同条件（两次运行一致）

| 项 | 值 |
| --- | --- |
| 来源提交 | `2ce4472bc96fc89de97225979ee615282aa53cb1` |
| tarball | `astarray-0.1.0.tgz` |
| tarball 字节数 | 998785 |
| **tarball sha256** | `1050d81ead35a17e5a7324e85f3e9d4acde7ee8cc08a8ae79178af99b9e52fb2` |
| 运行入口 | 隔离安装后的 `node_modules/astarray/dist/cli.js`（**安装包入口**） |
| 测试目录 | `.tmp/tarball-live/<运行标识>/install/`（**全新目录**，未使用仓库 `dist/`） |
| 状态目录 | 该全新目录自己的 `.astarray/`；脚本**显式断言**未复制仓库凭据目录 |
| 凭据 | 仅经 `ASTARRAY_PROVIDER_API_KEY` 环境变量（未落盘、未回显） |
| 判定 | 五项判据同一次运行全过：`status=done`、`permissionAsk=allowed-once`、产物存在、**产物逐行精确**、无其他改动 |

## 2. stepfun（已升级目录记录）

| 项 | 值 |
| --- | --- |
| 厂商标识 / 模型 | `stepfun` / `step-3.7-flash` |
| endpoint | `https://api.stepfun.com/v1/chat/completions` |
| 运行标识 | `2026-10-05T09-11-40.972Z` |
| 记录文件 | `.tmp/tarball-live/2026-10-05T09-11-40.972Z/tarball-record.json`（`isDryRun: false`） |
| 期望产物内容 sha256 | `774e343297f4ce88f11176089d760a4ed950a3a56f09d3d33d2cd31b0684beb1` |
| 脚本结论 | `T07D-R2-04 tarball 验收通过：产物正确 + 任务 done ✓` |

**目录变更（已写入并核验）**：`providerProfileId = "live-provider-1"`

| 字段 | 前 | 后 |
| --- | --- | --- |
| `supportLevel` | `live-smoke-verified` | **`product-path-verified`** |
| `verifiedAtIso` | `2026-10-01T02:38:09.093Z` | **`2026-10-05T09:11:40.972Z`** |

用官方只读入口核验（无网络、无凭据回显）：

```
$ astarray config provider list
live-provider-1	generic-openai-compatible	product-path-verified

$ astarray config provider show live-provider-1
live-provider-1	协议 generic-openai-compatible@2024-06-01
支持等级: product-path-verified	验证: 2026-10-05T09:11:40.972Z
```

## 3. unisound（已通过并**已落目录**）

| 项 | 值 |
| --- | --- |
| 厂商标识 / 模型 | `unisound` / `u2-flash` |
| endpoint | `https://maas-api.unisound.com/v1/chat/completions` |
| 运行标识 | `2026-10-05T09-12-27.737Z` |
| 记录文件 | `.tmp/tarball-live/2026-10-05T09-12-27.737Z/tarball-record.json`（`isDryRun: false`） |
| 期望产物内容 sha256 | `16f158425b7fe9a21e5fd716af78d2ef6519846f92b2cdd6709015d5cd64c73f` |
| 脚本结论 | `T07D-R2-04 tarball 验收通过：产物正确 + 任务 done ✓` |
| 计费 | 按量计费 key；**U2 Flash 当前定价 0 元/百万 tokens**（限时免费 2026.09.30–2026.10.31）→ 预计 0 元 |

**目录登记（由用户执行，已核验）**：

```powershell
'{"referenceId":"prov-unisound-1","baseUrl":"https://maas-api.unisound.com/v1","apiKey":"…"}' |
  node dist/cli.js config provider credential-set
node dist/cli.js config provider register unisound-u2-flash --protocol generic-openai-compatible `
  --api-version unversioned --capability text tool-calling `
  --support-level product-path-verified --credential-reference prov-unisound-1
```

**发现并修正的一处不一致**：`registerProvider` 建条目时把 `verifiedAtIso` 固定写 `null`
（`packages/tui/src/cli/provider-cli.ts:209`），导致刚登记完的两家里
`describeConnectionStatus().isVerified` 为 **false**（`doctor`/`show` 会显示"未验证"），
而它其实有本次实测证据。已按各家的**实际运行时间**补写 `verifiedAtIso`；
`apiVersion` 亦由占位值 `1` 改为 `unversioned`（Unisound 文档未给出协议版本号，不臆造）。

核验结果：

```
$ astarray config provider list
live-provider-1	    generic-openai-compatible	product-path-verified
unisound-u2-flash	  generic-openai-compatible	product-path-verified

$ astarray config provider show live-provider-1
支持等级: product-path-verified	验证: 2026-10-05T09:11:40.972Z

$ astarray config provider show unisound-u2-flash
unisound-u2-flash	协议 generic-openai-compatible@unversioned
支持等级: product-path-verified	验证: 2026-10-05T09:12:27.737Z
```

两条凭据引用均已存在（仅核验引用名与 host，未回显 key）：
`prov-live-1 → api.stepfun.com`、`prov-unisound-1 → maas-api.unisound.com`。

## 4. 声明范围（不扩大）

**可声明**：
- `live-provider-1` / `generic-openai-compatible` / `step-3.7-flash` / **CLI 入口** / Windows
  → `product-path-verified`（从 npm tarball 完成真实工作流）
- unisound `u2-flash` 在**同一 tarball、同一 CLI**下同样通过真实工作流
  （证据在案；等级记录待你决定是否入库）

**不可声明（未验证）**：
- **非 OpenAI 兼容协议**：`anthropic-messages`、`gemini-interactions`、`bedrock-converse`、
  `azure-openai` —— 适配器代码存在，但 CLI 的 `run` 只注册 `openai-compatible`
  （`packages/tui/src/cli/runtime-selection.ts:92` / `:135`），故**不能宣称任何等级**。
- **TUI 与 SDK 入口**（本次只验收 CLI）。
- **Linux / macOS**（本机 Windows）。
- 跨项目、安装类、Git 写操作（本次为项目内单文件新建）。
- CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

## 5. 备注

- 两次运行的 `sourceStatus` 均含你的并行未提交改动；tarball 因此包含工作树内容，
  脚本已在输出与记录文件中如实标注"工作区状态：有未提交改动"。
- tarball 采用**确定性打包**（`npm pack --ignore-scripts`）：跳过 `prepack` 的全量测试，
  避免打包重负载下已知的用例抖动导致哈希不可复现；仓库门禁由 `npm run check` 单独负责
  （本记录提交前已跑：exit 0，265 文件 / 2008 用例）。
