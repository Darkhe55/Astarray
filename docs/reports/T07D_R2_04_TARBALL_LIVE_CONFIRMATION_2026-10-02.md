# T07D-R2-04 tarball 路径真实运行：干跑证据与真实执行范围（待你确认）

> 状态：**脚本已就绪，干跑通过；真实运行尚未执行**（真实额度消耗 0）。
> 请确认 §5 的额度与 §6 的升级范围后，再执行 §4 的命令。

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

## 4. 真实运行命令（需你确认后执行）

凭证只经环境变量（沿用你已有的 key，不需要写入任何文件）：

```powershell
$env:ASTARRAY_PROVIDER_API_KEY = "<你的 StepFun API key>"
node scripts/verify-t07d-r2-04-tarball-live.mjs --allow-live-request --provider-endpoint https://api.stepfun.com/v1/chat/completions --model step-3.7-flash
# 或：npm run verify:t07d-r2-04-tarball-live -- --provider-endpoint https://api.stepfun.com/v1/chat/completions --model step-3.7-flash
```

要点：
- 真实模式**要求 TTY**（管道会被拒绝，退出码 2）；
- 出现权限询问时输入一次 `allow-once`；
- 脚本**只跑 1 次任务**，不重试。

## 5. 真实运行预算

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

**不得扩大声明**（仍为未验证 / 已知限制，会写入 knownLimitations）：
- 其它模型、其它 Provider、其它协议；
- Linux/macOS（本机为 Windows）；
- TUI 与 SDK 入口（本次只验收 CLI）；
- 跨项目/安装类操作（本次为项目内单文件新建）；
- CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

## 7. 尚未做的事

- **真实运行未执行**（本文件即为执行前确认；等你的确认）。
- 未改动 `supportLevel`（升级需真实运行证据）。
