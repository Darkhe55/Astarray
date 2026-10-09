# E2E-01-04 本地可证项刷新（2026-10-09）

> 检查点：E2E-01-04（**保持 in_progress**）本地可证项在当前提交刷新
> 基线提交：`728875f`（代码状态 `713d842` + 证据固化文档）
> 刷新对象：`docs/reports/E2E01_04_LOCAL_REFRESH_2026-09-19.md`（`6461690`，228 文件/1854 用例，分支 85.24%）
> **结论：本地可证项多数复现通过，但出现一处真实门禁缺口——全局分支覆盖率 83.26% < 阈值 85%。**
> 因此 E2E-01-04 不得 done；未决必选项（人工体验结论、Linux/macOS）仍未满足。

## 1. 门禁与覆盖率（当前提交）

| 检查 | 结果 | 退出码 / 来源 |
| --- | --- | --- |
| `npm run check`（typecheck+lint+build+test） | **290 文件 / 2186 用例通过**（2 skipped） | exit 0；`.tmp/session-r2-04/check-at-713d842.log` |
| `npx vitest run --coverage --maxWorkers=6` | 290 文件 / 2186 用例**全通过**（2 skipped） | 用例 exit 0；**覆盖率门禁 exit 1**；`.tmp/session-r2-04/coverage-maxworkers6.log` |
| 覆盖率（行/分支/函数/语句） | **92.05 / 83.26 / 92.5 / 92.09** | 分支 **未达 85% 阈值** |
| `npm run verify:security-coverage` | **22/22 达标（阈值 95%）** | exit 0；`.tmp/session-r2-04/security-coverage-2026-10-09.log` |
| `node scripts/e2e01-acceptance.mjs fixture` | 指纹 `sha256:6512b2a6322fb6b6730b68fb4029b622b8fc7f06e1f3adee0342b7d044e94c7c` | exit 0；与 2026-09-10/09-19 冻结值**一致** |
| `npm pack --ignore-scripts` + `verify-package.mjs` | **239 文件**，shebang/BOM 正确 | exit 0；`.tmp/session-r2-04/verify-package-2026-10-09.log` |
| tarball | `astarray-0.1.0.tgz` sha256 `8b175e316893089a42cec781d1abb87ee8827d71b2c2465422a60e287e4ccb4e`、1,124,541 字节 | 与三份 E2E-01-03 判定文件记录的 tarball 哈希**一致** |
| `node scripts/smoke-install.mjs` | **exit 1（两次）** | 见 §3：其内部 `prepack → npm run check` 命中抖动用例 |

## 2. 真实门禁缺口：全局分支覆盖率 83.26% < 85%

- 全局分支：covered **7845** / total **9422** = **83.26%**；**还需再覆盖 164 条分支**才能达到 85%。
- 未覆盖分支最多的文件（`coverage/coverage-summary.json` 精确口径）：

| 文件 | 未覆盖分支 | 该文件分支覆盖率 |
| --- | --- | --- |
| `packages/tui/src/cli/commands.ts` | **340** | 55.2%（759 条） |
| `packages/core/src/public-sdk.ts` | 65 | 82.24% |
| `packages/core/src/orchestration/local-preservation-service.ts` | 50 | 75.72% |
| `packages/core/src/tools/read-format/read-format-strategies.ts` | 43 | 82.52% |
| `packages/core/src/runtime/anthropic-messages-runtime.ts` | 41 | 72.66% |
| `packages/tui/src/cli/run-command.ts` | 38 | 48.64% |

> 注：`commands.ts` 单个文件即占 340 条未覆盖分支，是补齐 164 条缺口最现实的着力点。
> `anthropic-messages-runtime.ts` 与 `tools/builtins.ts`（33 条未覆盖）包含本会话新增的
> usage 捕获与陈旧写入守卫分支，属**本次口径下滑的部分成因**，应一并补测。

## 3. `smoke-install.mjs` 的两次失败是**抖动**，不是回归

`smoke-install.mjs` 执行不带 `--ignore-scripts` 的 `npm pack` → 触发 `prepack` → `npm run check`。
两次运行的失败用例**各不相同**，且**逐个隔离复跑全部通过**：

| 次 | 失败用例 | 隔离复跑 |
| --- | --- | --- |
| 1 | `tests/gui/integration/gui-settings-recovery.test.ts`（`expected 'running' to be 'done'`） | ✓ 5/5 通过（602ms） |
| 2 | `git-defensive-branches.test.ts`、`instruction-continuous-reception.test.ts`（`expected 'admitted' to be 'queued'`） | ✓ 3/3、6/6 通过（4.2s） |

另有默认并发下的首轮覆盖率尝试失败于 `reliability-git-process-tree` 与 `cli-commands`，
同样隔离通过（24/24）。**这说明：`npm run check` / `test:coverage` 在默认高并发下存在
负载型抖动**（已知抖动集见本会话记录）；`--maxWorkers=6` 下用例全绿（与 2026-09-19 基线同法）。

**未解决项**：`smoke-install.mjs` 因此在当前提交**无法稳定取得 exit 0**。
这是本节点的**真实待办**（要么降低其内部 check 的并发、要么稳定这些用例），
本报告不掩盖：该脚本两次尝试均为 exit 1。

## 4. E2E-01-03 带来的口径变化（真实 Provider 场景）

2026-10-09 E2E-01-03 已取得**真实 Provider + tarball 隔离安装**证据（见
`docs/reports/E2E01_03_REAL_SERVICE_AND_PARALLEL_INTERRUPT_EVIDENCE.md` 与
`docs/reports/evidence/E2E01_03_VERDICTS_2026-10-09/`：条款 1/2/4 于 `0b712b1`、
条款 3 于 `0918a77`，三份判定文件均 `isRealAcceptanceEvidence=true`）。
因此本节点的"真实 Provider 场景"一项**已有可用证据**，可据此更新支持矩阵；
但人工体验结论与 Linux/macOS 平台仍为 `pending-manual`。

## 5. 本轮未做的事（明确范围）

- 未编写新的补测用例（补齐 164 条分支）——这是下一步的主要工作量。
- 未在 Linux/macOS 上运行任何检查。
- 未产出入库证据快照；本轮产物仍在 `.tmp/session-r2-04/`。
