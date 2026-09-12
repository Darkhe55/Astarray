# E2E-01-04 质量与交付声明（本地可证项）

> 检查点：E2E-01-04（**in_progress**：本地可证项已完成；人工体验与非 Windows 平台未验证，属未决必选项）
> 日期：2026-09-10；命令通道：本机完整访问（非沙箱受限通道）
> 证据工具：`scripts/verify-security-coverage.mjs`（`npm run verify:security-coverage`）

## 1. 门禁与覆盖率（本次运行）

| 检查 | 结果 |
| --- | --- |
| `npm run test:coverage` | exit 0；**178 文件 / 1504 用例**通过；全局 93.71% stmts / **86.54% branch** / 91.83% funcs / 93.75% lines（阈值 85%，满足） |
| 关键安全模块专项（分支 ≥95%） | **22/22 达标**（阈值 95%；下表含分母） |
| `node scripts/smoke-install.mjs` | exit 0 |
| `npm pack` + `node scripts/verify-package.mjs <tarball>` | exit 0；201 个文件、shebang/BOM 正确、含反馈进程入口 |
| tarball sha256 | `9bffc6442423c67f19139ac54bf36ac4eee0d276fcddbe4406f968a1e7a8c1a3` |

## 2. 关键安全模块分支覆盖率（AR-07 §1 清单，22 模块）

| 模块 | 分支 | 分母 |
| --- | --- | --- |
| core/completion-protocol.ts | 100.00% | 13/13 |
| orchestration/work-archive-store.ts | 100.00% | 18/18 |
| tools/evidence-search-agent-port.ts | 100.00% | 14/14 |
| feedback-process/mailbox-journal.ts | 95.91% | 47/49 |
| tools/protected-storage-policy.ts | 95.65% | 22/23 |
| tools/installation-gate-guard.ts | 100.00% | 32/32 |
| tools/configurable-permission-policy-engine.ts | 100.00% | 31/31 |
| tools/permission-profile-store.ts | 100.00% | 42/42 |
| tools/policy-wrapper.ts | 98.27% | 57/58 |
| tools/local-tool-policy-engine.ts | 97.61% | 41/42 |
| tools/local-progress-and-cycle-guard.ts | 97.95% | 48/49 |
| orchestration/agent-run-watchdog.ts | 97.05% | 33/34 |
| tools/session-permission-elevation.ts | 95.65% | 66/69 |
| tools/sensitive-content-access-policy.ts | 96.36% | 53/55 |
| tools/backup-vault.ts | 96.42% | 81/84 |
| feedback-process/process-supervisor.ts | 98.21% | 55/56 |
| feedback-process/entrypoint.ts | 95.38% | 62/65 |
| tools/read-suppression-ledger.ts | 100.00% | 27/27 |
| tools/local-sensitive-operation-classifier.ts | 100.00% | 11/11 |
| tools/current-permission-selection.ts | 100.00% | 12/12 |
| tools/permission-capability-catalog.ts | 100.00% | 14/14 |
| orchestration/unbounded-agent-registry.ts | 100.00% | 18/18 |

说明：与 AR-07 台账（2026-09-10）相比，个别模块分母随本批代码变化而移动
（work-archive-store 16→18、policy-wrapper 54→58、process-supervisor 56→56/55 覆盖），
全部仍 ≥95%；全局覆盖率不能替代本专项。

## 3. 平台矩阵（明确未验证的保持未验证）

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows（本机） | ✅ 已验证 | Node v24.18.0；全量 `check`/`coverage`、真实 git 端到端、tarball 隔离安装、smoke-install 均在本机执行 |
| Linux | ⬜ 未验证 | 本环境无 Linux 运行通道（无 CI/容器）；不在本检查点声明通过 |
| macOS | ⬜ 未验证 | 同上 |

## 4. mock / fake / 真实 状态区分

| 类别 | 状态 |
| --- | --- |
| mock（脚本化运行时） | ✅ 已验证（`run --runtime mock` 全流程、CLI/TUI 套件） |
| local-fake（本地协议服务器） | ✅ 已验证（`run --runtime openai-compatible` 对本地 SSE 服务器；tarball 隔离安装下同样验证） |
| 真实 Provider | ⬜ 未验证——E2E-01-03 需用户真实 Provider 凭据与费用授权，当前缺失 |

## 5. 人工体验与待追认

| 项 | 状态 |
| --- | --- |
| 人工工作流走查（体验结论） | `pending-manual`（证据包强制保持 pending；无人工结论时不得视为通过） |
| 真实 Provider 观察 | `pending-manual` / 未验证 |
| 依赖 audit 遗留 | 沿用既有台账；本检查点未新增结论 |

## 6. 结论与未决必选项

- 本地可证项（门禁、覆盖率、关键模块专项、tarball 回归）**全部通过**，且均可由脚本重复复现。
- **未决必选项（因此本检查点不标 done）**：
  1. 人工体验结论（人工走查）；
  2. Linux / macOS 平台验证；
  3. 真实 Provider 场景（E2E-01-03，待凭据与费用授权）。
- 依共同契约：上述未跑/未获结论项明确保持未验证，不以说明文字覆盖。
