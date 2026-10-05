# 生产路径验收通过（tarball · 真实 Anthropic Messages 协议 · unisound）

> **结论：首次在真实厂商上跑通非 OpenAI 协议。** 从 npm tarball 隔离安装，经 CLI 使用
> **Anthropic Messages** 协议完成真实受控工作流，五项判据同一次运行全部通过。
> 基线：`HEAD == origin/main == 4b62d67`（用户执行时的工作区状态）。

## 1. 运行命令（用户在交互式终端执行）

```powershell
$env:ASTARRAY_PROVIDER_API_KEY = "<unisound 按量计费 key>"
npm run verify:t07d-r2-04-tarball-live -- `
  --vendor-identifier unisound --protocol-label anthropic-messages `
  --provider-endpoint https://maas-api.unisound.com/anthropic/v1/messages `
  --model u2-flash
```

## 2. 共同条件

| 项 | 值 |
| --- | --- |
| 来源提交 | `4b62d6784d134cae9b4b2826dcd80b136a14f231` |
| tarball | `astarray-0.1.0.tgz` |
| tarball 字节数 | 1012332 |
| **tarball sha256** | `aff66cef2a9d56099a5d90de0beaa933eb7782b7cdd7691d324005ab8d886669` |
| 运行标识 | `2026-10-05T12-12-41.497Z` |
| 记录文件 | `.tmp/tarball-live/2026-10-05T12-12-41.497Z/tarball-record.json` |
| 运行入口 | 隔离安装后的 `node_modules/astarray/dist/cli.js`（**安装包入口**） |
| 状态目录 | 全新目录自己的 `.astarray/`；脚本显式断言未复制仓库凭据目录 |
| 凭据 | 仅经 `ASTARRAY_PROVIDER_API_KEY` 环境变量（未落盘、未回显） |
| 协议 | `anthropic-messages`（经 CLI `--provider-protocol` 显式选择） |

## 3. 判定结果

脚本结论（原样）：

```
T07D-R2-04 tarball 验收通过：产物正确 + 任务 done ✓
```

该行**只在五项判据全部通过时**打印（脚本对失败项会逐条列出并退出码 1）：

| # | 判据 |
| --- | --- |
| 1 | 任务终态 `status=done` |
| 2 | 权限裁决 `permissionAsk=allowed-once` |
| 3 | 产物文件存在 |
| 4 | 产物内容**逐行精确**（结尾换行不敏感） |
| 5 | 仓库其他文件未被改动 |

产物内容（按参数渲染，含协议行）：

```
# 真实 Provider 受控改动（T07D-R2-04）
- 厂商：unisound
- 端点：maas-api.unisound.com
- 模型：u2-flash
- 协议：anthropic-messages
```

## 4. 这次通过证明了什么

1. **Anthropic Messages 运行时可用**：新实现的 `AnthropicMessagesRuntime` 在真实厂商端点下
   完成了完整工作流（不只是假服务器）。
2. **协议装配打通**：`--provider-protocol anthropic-messages` 的选择确实生效
   （请求发往 `/anthropic/v1/messages`，用 `x-api-key` 鉴权、顶层 `system`、`tool_result` 回填）。
3. **"授权 → 重跑 → 工具真正执行"闭环在真实 TTY 下成立**：`allowed-once` 被消费、
   工具落盘、门禁结案 —— 即之前 `it.skip` 的端到端缺口在**真实交互路径**下不再出现。
4. 产品不再只有一条协议路径：仓库原先只有 `OpenAiCompatibleRuntime`，
   现在多了 `anthropic-messages`。

## 5. 声明范围（不扩大）

**可声明**：
- unisound `u2-flash` 经 **Anthropic Messages 协议**、**CLI 入口**、Windows，
  从 npm tarball 完成真实工作流。

**不可声明**：
- 其它 Anthropic 兼容厂商（stepfun 的 Messages 端点路径**未核实**，未运行）；
- 其它非 OpenAI 协议（`gemini-interactions` / `bedrock-converse` / `azure-openai`）——
  仍只有适配器代码、无运行时；
- TUI / SDK 入口、Linux/macOS、跨项目与安装类操作；
- `--api-version`/协议版本号：unisound 文档未给协议版本，目录中记 `unversioned`。

## 6. 目录登记（待执行）

目录中 `unisound-u2-flash` 目前记的是 **OpenAI 兼容协议**（`generic-openai-compatible`）。
本checkpoint验证的是**同厂商的 Anthropic Messages 协议**，按"不合并声明"原则应**另立一条**：

```powershell
node dist/cli.js config provider register unisound-u2-flash-anthropic `
  --protocol anthropic-messages `
  --api-version unversioned `
  --capability text tool-calling `
  --support-level product-path-verified `
  --credential-reference prov-unisound-1 `
  --verified-at 2026-10-05T12:12:41.497Z
```

（凭据引用 `prov-unisound-1` 已存在，无需重新写入；命令由用户执行，未自行代跑。）

## 7. 仍未解决（如实登记）

- **in-repo 与安装后行为差异**：直接跑仓库 `dist/cli.js` + 管道喂 `allow-once` 的等价探针
  得到 `status=blocked` 且无授权痕迹；而**同一构建**经 tarball 安装后（两条协议）干跑均通过。
  差异仅在"直接跑 dist"与"经 npm 安装后跑安装入口"。需单变量实验判定是夹具问题还是真实环境依赖。
  端到端用例 `tests/tui/integration/cli-anthropic-protocol.test.ts` 保持 `it.skip`，不删除。
- CLI 结果后进程滞留（`cli-exit-linger.test.ts` 路径 ② 保持 `it.skip`）。
