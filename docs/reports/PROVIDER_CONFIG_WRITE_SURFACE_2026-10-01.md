# `config provider` 受保护凭据写入面 + 安装验收闭环（检查点，2026-10-01）

> 来源：用户 2026-10-01 指定「做新离线项：config provider 写入面」；
> 承接 `docs/reports/ENTRY_RUNTIME_SELECTION_INSTALL_ACCEPTANCE_2026-09-28.md` §残留。
> 基线：`HEAD == origin/main == 1d68ba5`；`typecheck` / `lint` = 0。

## 问题（写入面之前完全缺失）

会话实测：`astarray config provider list` → `error: unknown command 'provider'`（退出码 1）。
`provider-cli.ts` 已实现 `FileProviderCredentialStore` / `ProviderCliCatalog` 与三个只读命令执行器，
但 **`cli.tsx` 从未注册 `config provider` 子命令**；受保护凭据引用只能由测试 API 或手工写文件产生。
后果：`--provider-credential-reference`（2026-09-28 检查点）在真实 CLI 上**无受支持的写入路径**，
安装验收脚本只能自己写 `<stateDir>/providers/provider-credentials.json` 来造引用。

## 反例（先写行为反例，实现前 6/6 失败）

新增 `tests/tui/integration/provider-configuration-write-surface.test.ts`：实现前 6/6 失败，
失败原因是 `executeProviderCredentialSetCommand` / `executeProviderRegisterCommand` 不存在。

## 实现

- `packages/tui/src/cli/provider-cli.ts`
  - 新增 `filePath` 只读 getter（公开路径，内容仍敏感）；
  - 新增 `writeCredentialSecurely()`：先 `backupExistingFile` 生成 `.bak` → 合并现有引用 →
    以 `0o600` 排他创建**同目录受限权限临时文件**并 `sync` → `chmod 0600` → `rename` 原子替换 →
    `finally` 删除临时文件。刻意**不采用纯追加 JSONL**：JSONL 会把同一引用的历史密钥长期留档，反而扩大暴露面。
- `packages/tui/src/cli/commands.ts`
  - `readCredentialPayloadFromStdin()`：**唯一机密输入通道**，上限 64KiB（超出即拒绝，只报告上限与类别，不回显内容）；
  - `parseCredentialPayload()`：校验 `referenceId` / `baseUrl`（http|https）/ `apiKey`，错误信息与原文解耦；
  - `executeProviderCredentialSetCommand()`：写入并输出 `referenceId`、`endpointHost`（**只留主机名**，丢弃路径/查询串/用户信息）、
    `apiKeyPresent`、`isBackupCreated`、凭据文件路径；写入失败退出码 1；
  - `executeProviderRegisterCommand()`：校验支持等级四态与凭据引用存在性（fail-closed 退出码 2），
    JSON 面复用 `toProviderPublicDto`（**不含**引用 ID），人读面显示引用 ID。
- `packages/tui/src/cli.tsx`
  - 注册 `config provider credential-set|register|list|show`（`list/show` 此前**也未接线**，一并补齐）；
  - `doctor` 新增 `--provider <id>`（`executeDoctorProviderCommand` 此前同样未接线）。
- `tests/architecture/destructive-file-api-guard.test.ts`：`tui/src/cli/provider-cli.ts` 白名单令牌
  由 `writeFile` 扩为 `writeFile, rm, rename`，并写明理由（受限权限临时文件写入 → 原子 rename → 写完即删）。

## 证据

- **反例 → 绿**：`tests/tui/integration/provider-configuration-write-surface.test.ts` **7/7** 通过
  （STDIN 落盘可读回 + 输出脱敏；非法/超长输入退出码 2 且不落盘、不回显；覆盖前 `.bak` 且无 `.tmp` 残留；
  登记成功/引用缺失/非法支持等级；写入→登记→`doctor --provider` 闭环 `credentialReferenceResolved=true`）。
- **官方门禁**：`npm run check` exit 0 —— 全量 **243 文件 / 1908 用例**通过。
- **覆盖率**（`npx vitest run --coverage --maxWorkers=6`）：**93.15 / 85.43 / 93.39 / 93.16**（阈值 85）。
- **安全关键模块**：`node scripts/verify-security-coverage.mjs` → **22/22 达标**（阈值 95%）。
- **CLI 真实行为**（`dist/cli.js`，独立临时工作目录）：
  `credential-set --json` exit 0（`endpointHost=provider.example.com`，输出无 key、无 `tenant=`）；
  `register` 人读面 exit 0 且显示引用 ID；`list` exit 0（无引用 ID）；`show` exit 0；
  `doctor --provider` exit 0；非法负载 exit 2（`缺少 baseUrl`）；引用缺失 `register` exit 2
  （`受保护凭据引用不存在`）；落盘文件仅 `providers/provider-credentials.json` 与 `provider-catalog.json`，
  全目录扫描**无 key 泄漏**。
- **tarball 级安装验收**（`node scripts/verify-entry-runtime-selection.mjs --tarball <.tgz>`）：
  tarball sha256 `776483bc41ed53a262bebdf12242cd405f4f6182c423daaa0efdc97ff0d358a3`；
  **23/23** 通过——新增 [1] 组全部改走**公共写入面**（脚本不再手工写凭据文件）：
  `credential-set` 脱敏落盘 → `register` 登记 → `list` 无引用泄漏 → `doctor --provider` 引用已解析 →
  引用缺失 `register` 退出码 2；随后 [4] 组用**同一引用**驱动 `gui` / `mcp serve` / `run`。
- `node scripts/verify-package.mjs <.tgz>` → 打包校验通过（217 文件）；`node scripts/smoke-install.mjs` → 冒烟全部通过
  （首次因 npm 全局安装瞬时失败，复跑通过；属环境瞬时问题，未改仓库规避）。

## 残留

- `writeCredential`（旧 API）仍是无备份直写，仅测试与既有调用使用；生产 CLI 走 `writeCredentialSecurely`。
- 交互式（TTY 手工敲 JSON）体验未优化：当前以管道/重定向为主；`apiKey` 从**环境变量**导入的通道**刻意未提供**
  （环境变量会进入子进程环境与崩溃转储），如需请单独立项。
- `config provider` 尚无删除/轮换凭据引用命令（轮换可覆盖写入，旧值留在 `.bak`）。
