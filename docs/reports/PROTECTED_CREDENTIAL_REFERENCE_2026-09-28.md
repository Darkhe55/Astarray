# 受保护凭据引用优先（检查点，2026-09-28）

> 承接 `docs/reports/GUI_MCP_RUNTIME_SELECTION_WIRING_2026-09-28.md` §3①：三入口 provider 运行此前只读环境变量 API key，绕过 `config provider` 写入的受保护引用。

## 实现

- `packages/tui/src/cli/runtime-selection.ts`：`buildRuntimeSelection` 改为 async，新增 `providerCredentialReference` / `stateDirectory`：
  - 给出引用时**优先**走 `FileProviderCredentialStore`（`<stateDir>/providers/provider-credentials.json`），apiKey 由受保护引用在请求时读取，不回显；
  - 引用不存在 → `provider-credential-not-found`；缺状态目录 → `provider-state-directory-missing`；缺模型 → `provider-model-missing`（均映射退出码 2，**不回退环境变量、不回退 mock**）；
  - 未给引用时保持原环境变量路径。
- `run-command.ts` / `executeMcpServeCommand` / `executeGuiServeCommand` 传入状态目录与引用；`cli.tsx` 三个命令均新增 `--provider-credential-reference`。

## 证据

- **反例**：新增 `tests/tui/unit/runtime-credential-selection.test.ts`（引用存在 / 引用缺失 / 环境变量路径）修复前 2 失败 1 通过。
- **绿**：该文件 + `runtime-selection.test.ts` 共 **8/8** 通过（含既有的 5 例适配 async）。
- **官方门禁**：`tsc --noEmit` = 0、`eslint .` = 0；完整访问 + 默认 forks 池 **构建成功、全量 241 文件 / 1896 用例通过**。
- **待复跑（本轮提权通道连续停滞）**：覆盖率（`test:coverage`）与安全关键模块专项（`verify-security-coverage`）；本轮多次 600s 停滞，未取得数字，计入下轮首个动作。

## 残留

- 受保护引用的**写入面**仍由 `config provider` 提供，尚未做端到端（写入 → 引用运行 → 真实请求）的 tarball 级验收（需真实 Provider 凭据与费用授权，E2E-01-03）。
