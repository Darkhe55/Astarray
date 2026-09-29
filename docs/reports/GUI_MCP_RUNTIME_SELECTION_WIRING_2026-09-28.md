# GUI/MCP 入口运行时选择接线（检查点，2026-09-28）

> 承接上一轮审计（`docs/reports/GUI_AND_MCP_RUNTIME_SELECTION_FINDING_2026-09-28.md`）：
> 两个产品入口硬编码 `runtime: "mock"`，真实 Provider 不可达。

## 1. 实现

1. 新增 `packages/tui/src/cli/runtime-selection.ts`：共享 `buildRuntimeSelection()` + 稳定错误码 `RuntimeSelectionError`（`runtime-unsupported` / `provider-endpoint-missing` / `provider-model-missing`）。缺参数**抛错而非回退 mock**；API key 只从环境变量读取（不落盘/不回显）。
2. `run-command.ts` 改为复用该函数（行为不变，去掉内联重复实现与未用导入）。
3. `executeMcpServeCommand` / `executeGuiServeCommand`：新增 `runtime`/`providerEndpoint`/`providerModelIdentifier`/`providerApiKeyEnvironmentVariable` 选项，经共享函数选择运行时；错误映射为退出码 2。
4. `cli.tsx`：`mcp serve` 与 `gui` 增加 `--runtime` / `--provider-endpoint` / `--provider-model` / `--provider-api-key-env`。

## 2. 证据

- **反例/单元**：新增 `tests/tui/unit/runtime-selection.test.ts`（5 例：mock 缺省、provider 完整参数、缺端点、缺模型、不支持的运行时）→ **5/5 通过**。
- **CLI fail-closed（真实 dist）**：
  ```
  $ astarray mcp serve --runtime openai-compatible  → astarray: …需要 --provider-endpoint… ; exit 2
  $ astarray gui       --runtime openai-compatible  → astarray: …需要 --provider-endpoint… ; exit 2
  ```
  （绝不静默回退 mock）
- **选项面**：两命令 `--help` 均列出 4 个新参数。
- **官方门禁（完整访问 + 默认 forks 池）**：构建成功；全量 **239 文件 / 1891 用例**；覆盖率 **93.06 / 85.45 / 93.35 / 93.08**；安全关键模块 **22/22**；`eslint .` 与 `tsc --noEmit` 均为 0。

## 3. 未做（下一检查点候选）

1. **受保护凭据引用优先**：当前 provider 运行仍读环境变量 API key；应优先解析 `config provider` 写入的受保护引用（`provider-cli.ts` 的 `FileProviderCredentialStore`），使 `run`/`gui`/`mcp serve` 三条路径统一。
2. **诊断面 `runtimeKind`**：便于验收直接断言入口选到的是 provider 而非 mock（当前以 CLI 退出码与选项面为证据）。
3. **tarball 级验收**：把 GUI/MCP 入口的运行时选择纳入 `scripts/verify-sdk-default-path.mjs` 风格的安装后验收（需在打包环境跑）。
4. 真实 Provider 的端到端验收仍取决于用户提供凭据与费用授权（E2E-01-03）。
