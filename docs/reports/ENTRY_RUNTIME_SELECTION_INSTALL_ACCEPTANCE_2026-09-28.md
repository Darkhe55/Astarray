# 三入口运行时选择安装验收 + 受保护凭据引用（检查点，2026-09-28）

> 交接来源：`docs/reports/HANDOFF_2026-09-28.md` §4（唯一无需外部输入的离线项）。
> 基线校验：`HEAD == origin/main == e61cdbf`（交接记录的 `fdc97a6` 已推进，以 origin/main 为准）；`typecheck` / `lint` = 0。

## 反例（先写行为反例，实现前 4/4 失败）

新增 `tests/tui/integration/runtime-selection-diagnostics-report.test.ts`：

- 实现前：`4 failed`（`gui` / `mcp serve` 未解析 `--runtime-diagnostics-file`，无任何诊断报告可读）。
- 失败原因不是断言写错，而是**验收面缺失**：两个长驻入口无法证明「本次实际选中的运行时」，
  只能靠 `--help` 文本与退出码间接推断。

## 实现

- 新增 `packages/tui/src/cli/runtime-diagnostics-report.ts`：`writeRuntimeDiagnosticsReport()` 把本次入口实际选中的运行时写成公开诊断 JSON
  （`reportVersion=RUNTIME_SELECTION_DIAGNOSTICS_V1`、`entryRuntimeKind`、`providerId`、`modelIdentifier`、
  `protectedCredentialReferenceId`、`runtimeDiagnostics`）；只含公开标识，不含凭据值/端点内联 secret/响应正文；
  未给路径时零副作用；覆盖前经 `backupExistingFile` 自动备份 `.bak`，写入走 `writeAtomicJson`（临时文件 → rename）。
- `executeMcpServeCommand` / `executeGuiServeCommand`（`tui/src/cli/commands.ts`）新增可选
  `runtimeDiagnosticsFilePath`，在会话创建前写入报告；`cli.tsx` 两命令新增 `--runtime-diagnostics-file <path>`。
- **修复交接文档的隐含假设缺口**：`run` 此前**没有** `--provider-credential-reference` 选项
  （`cli.tsx` 只有 action 内联字段，未注册 commander 选项），`astarray run ... --provider-credential-reference` 会报
  `error: unknown option`，即交接 §4 步骤 1 第三条在 `run` 上不可达。现已注册该选项，三入口统一。

## 证据

- **反例 → 绿**：`tests/tui/integration/runtime-selection-diagnostics-report.test.ts` `5/5` 通过
  （引用被选用 ×2、mock 默认、引用缺失 fail-closed 且不写报告、`.bak` 自动备份 + 无路径零副作用）。
- **官方门禁**：`typecheck` = 0、`lint` = 0、`build` 成功；全量 **242 文件 / 1901 用例**通过
  （见下方「已知抖动」）。
- **覆盖率**（`npx vitest run --coverage --maxWorkers=6`）：**93.18 / 85.49 / 93.40 / 93.20**
  （Stmts / Branch / Funcs / Lines，阈值 85）——接管交接 §4 遗留的待复跑项。
- **安全关键模块**：`node scripts/verify-security-coverage.mjs` → **22/22 达标**（阈值 95%）。
- **tarball 级安装验收**（本次新脚本 `scripts/verify-entry-runtime-selection.mjs`，
  npm script `verify:entry-runtime-selection`）：
  - tarball `astarray-0.1.0.tgz`，sha256 `c7315b4c700a0b6afdbd500c1e885018f4b7e17b1112982bbca2f3d39b62e273`；
  - 隔离安装后 **17/17** 检查通过：
    1. `gui --help` / `mcp serve --help` 含 `--runtime` / `--provider-endpoint` / `--provider-model`
       / `--provider-credential-reference` / `--runtime-diagnostics-file`；
    2. 4 个缺参组合（gui/mcp × 缺端点/缺模型）均 **退出码 2** 且 stderr 给出缺参原因（不回退 mock）；
    3. 受保护凭据引用（`<cwd>/.astarray/providers/provider-credentials.json`）被选用：
       报告 `entryRuntimeKind=provider`、`providerId=openai-compatible`、
       `protectedCredentialReferenceId=cred-ref-install-1`、`runtimeDiagnostics.runtimeKind=provider`，
       且报告不含凭据值、不含 `apiKey` 字段；
    4. 引用缺失 → 退出码 2、stderr 说明原因、**不写报告**（fail-closed）；
    5. 未给 `--runtime` → 报告 `mock` 且 `providerId=null`（离线默认未被破坏，不误报 provider）；
    6. `run --provider-credential-reference` 用引用内端点驱动任务到 `done`（协议服务器收到真实请求）。
  - `node scripts/verify-package.mjs <.tgz>` → 打包校验通过（217 文件，shebang/BOM 正确，反馈进程入口已包含）。
  - `node scripts/smoke-install.mjs` → 冒烟全部通过（含全局安装 shim 与安装后反馈进程入口加载）。

### 已知抖动（非本检查点回归）

全量套件在**高并发/高负载**下偶发 1 例失败，且两次落在**不同**文件：
`tests/core/integration/summary-product-wiring.test.ts`（一次，`expected 'running' to be 'done'`）与
`tests/tui/integration/headless-cli.test.ts`（一次）。两者**单独复跑均通过**，同轮其它 241 文件全绿；
本检查点改动不涉及这两个文件（`commands.ts` 仅新增 MCP/GUI 路径的报告写入）。
上方覆盖率的 `242/242` 全绿运行即为干净证据。建议后续单独立项排查该负载相关抖动。

## 残留

- `config provider` 仍**只有 list/show/doctor**（本会话实测 `astarray config provider list` → `error: unknown command 'provider'`）；
  受保护引用的**写入面**只能由 `FileProviderCredentialStore` 的 API 或直接写
  `<stateDir>/providers/provider-credentials.json` 完成。因此本次安装验收脚本按存储公开文件名以 CLI 之外的本地步骤预置引用，
  该缺口记入下一检查点候选（“给 `config provider` 补受保护引用写入/登记命令”，需先定机密输入通道：不得经命令行传递 key）。
- 诊断报告为**可选**入口参数；未提供时行为与之前完全一致（无新副作用）。
- 交接 §5 外部输入（真实 Provider 凭据与费用授权、第三方客户端授权、Linux 同提交重跑、GUI-01-R-04b 人工项）本轮未推进。
