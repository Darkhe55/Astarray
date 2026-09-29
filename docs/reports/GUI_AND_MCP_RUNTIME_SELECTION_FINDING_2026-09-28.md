# GUI 与 MCP 产品入口被锁死在 mock 运行时（发现，2026-09-28）

> 审计目标：确认产品入口（BRIDGE-01 MCP、GUI-01-R GUI）能到达真实 Provider。
> 状态：**缺口已复现**；实现留待下一检查点（本轮只提交审计与可复现证据）。

## 1. 事实（含代码位置）

| 入口 | 代码 | 事实 |
| --- | --- | --- |
| MCP stdio | `packages/tui/src/cli/commands.ts:2544-2549` | `AstarrayApplicationFacade.create({ stateDirectory, mode: "assist", runtime: "mock", statusPollIntervalMilliseconds: 25 })` —— **硬编码 mock** |
| GUI | `packages/tui/src/cli/commands.ts:2639-2644` | 同样硬编码 `runtime: "mock"` |
| CLI run（对照） | `packages/tui/src/cli/run-command.ts:58-99` | 已支持 `--runtime openai-compatible` + `--provider-endpoint/--provider-model` 选择真实 Provider |

命令行选项面同样缺失（实测）：

```
$ astarray mcp serve --help   → Options: -h, --help
$ astarray gui --help         → Options: --port <port>, --no-open, -h, --help
```

即：**BRIDGE-01 的外部客户端与 GUI 在当前构建下只能驱动 mock/脚本运行时**，无法到达任何真实模型。

## 2. 影响

- BRIDGE-01（单一外部协议 MVP）与 GUI-01-R（实际产品接线）目前只能在 mock 路径上验收；E2E-01 的真实服务验收也无法经由这两个入口完成。
- 与 rollout 文档"先使已有核心能力从 CLI/TUI/SDK 真正可达"以及 T07D-R2（首个 Provider 产品接线）不一致：能力已存在于 `run`，但未贯通到另两个产品入口。

## 3. 相邻发现：`run` 的 Provider 凭据路径与受保护存储不一致

- `run-command.ts:75-78`：API key 直接读环境变量（`ASTARRAY_PROVIDER_API_KEY` 缺省 `local-no-auth-required`），并**内联**构造 `ProviderRuntimeRegistry`。
- 仓库已有受保护凭据存储 `FileProviderCredentialStore`（`packages/tui/src/cli/provider-cli.ts:36-60`，文件 `<stateDir>/providers/provider-credentials.json`，供 `config provider` / `doctor --provider` 使用），凭据引用 ID 在公开面流转、值不落日志。
- 两条路径不一致：经由 `run` 的 Provider 运行绕过受保护引用（AGENTS.md 要求凭据不进模型上下文/日志/导出，且应使用受保护引用）。

## 4. 下一检查点建议（单卡单检查点）

**"GUI/MCP 入口运行时选择接线"**：

1. 抽取共享 `buildRuntimeSelection()`（复用 `run` 现有逻辑），并优先解析受保护凭据引用（`config provider` 写入的引用 ID）而不是内联 env key。
2. `gui` 与 `mcp serve` 增加 `--runtime` / `--provider-endpoint` / `--provider-model` / `--provider-credential-reference`；**缺参数即 exit 2，绝不静默回退 mock**（与 `run` 一致）。
3. 先写行为反例：缺 provider 参数时两命令必须 fail-closed；给定完整参数时诊断面（`getRuntimeDiagnostics`）应报告 provider 运行时（需在诊断面补 `runtimeKind`）。
4. 交付验收：扩展 `scripts/verify-sdk-default-path.mjs` 风格的 tarball 验收，覆盖 GUI/MCP 入口的运行时选择与 fail-closed。
