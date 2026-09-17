# GIT-PRESERVE-03 崩溃恢复与独立恢复演练 — 证据

> 检查点：GIT-PRESERVE-03（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §5，未跟踪用户文件）
> 前驱：GIT-PRESERVE-02（提交 `6eba68b`、`ea15f9f`，已推送）。日期：2026-09-16
> 契约：docs/adr/0041-local-preservation-after-remote-sync-failure.md（§12 为实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/orchestration/local-preservation-service.ts` | 新增 `restorePreservationPoint`（默认新目录、拒绝非空目标、原仓库不可用仍可恢复）、`verifyPreservationPointIntegrity`（逐项哈希/缺对象报告）、`listIncompleteSnapshotDirectories`（`.tmp-*` 崩溃残留报告）、并发改写检测（发布前重读变更指纹） |
| `packages/core/src/core/errors.ts` | 新增稳定错误码 `preservation-point-not-restorable` / `preservation-object-missing` / `restore-target-not-empty` / `restore-target-invalid` |
| `packages/core/src/public-sdk.ts` | 公共入口 `recordRemoteSyncOutcome` / `listLocalPreservationPoints` / `readLocalPreservationPoint` / `verifyLocalPreservationIntegrity` / `restoreLocalPreservationPoint` + 公开 DTO |
| `packages/tui/src/cli/commands.ts` + `cli.tsx` | `astarray preserve create\|status\|show\|restore` |
| `tests/core/integration/local-preservation-restore.test.ts`（新，7 用例） | 原仓库不可用恢复、无提交仓库恢复、目标非空拒绝、缺对象、并发改写、临时残留、完整性通过 |
| `tests/core/integration/local-preservation-product-entry.test.ts`（新，4 用例） | 公共入口接线/跨进程状态/删除原仓库后独立恢复、成功不保全、仓库不可用 failed 且拒绝恢复、非空目标拒绝 |
| `tests/tui/integration/preserve-cli.test.ts`（新，3 用例） | create→status→show→restore 全链路、no-preservation 诚实、非法状态用法错误 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 原仓库被删除后仍宣称可恢复 | 用对象归档独立恢复 | ✅ 删除仓库后恢复成功；`isOriginalRepositoryRequired=false`；`git write-tree` 与记录的 index tree oid 一致 |
| 无提交仓库无法恢复 | 空树/无引用路径也能恢复 | ✅ 恢复出 staged 与未跟踪内容，`diff --cached` 非空 |
| 覆盖当前人工工作区 | 拒绝非空目标 | ✅ `restore-target-not-empty`，用户文件保持原样 |
| 缺对象被当成完整 | 完整性报告点名缺失、恢复失败 | ✅ `isIntact=false`、`missingFilePaths` 含 bundle、恢复抛 `preservation-object-missing` |
| 快照期间并发改写 | 标注不完整，不标 ready | ✅ `status="incomplete"`、失败项 `concurrent-modification-detected` |
| 崩溃残留 `.tmp-*` 被当 ready | 报告为不完整且不列入保全点 | ✅ `listIncompleteSnapshotDirectories` 返回该目录；`listPreservationPoints` 不含它 |
| 破坏性文件 API 绕过守卫 | 白名单最小令牌 | ✅ 新代码仅 `writeFile`/`rename`（无 `copyFile`/`rm`），守卫通过 |
| 行尾自动转换改写内容 | 字节级恢复 | ✅ 恢复前强制 `core.autocrlf=false`/`core.eol=lf`（修复 LF→CRLF 差异） |
| 恢复产生新保全点 | 不重复快照 | ✅ 恢复后 `listPreservationPoints` 仍为 1，仅回写 `restoredAtIso` |
| 公共入口绕过服务 | 入口真实调用服务并可见产物 | ✅ 门面创建→另一进程 list 可见→恢复文件与未跟踪内容正确 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/local-preservation-restore.test.ts --maxWorkers=4` | **0；7 passed** |
| `npx vitest run tests/core/integration/local-preservation-product-entry.test.ts tests/tui/integration/preserve-cli.test.ts --maxWorkers=4` | **0；7 passed** |
| `npx tsc --noEmit` / `npx eslint <改动文件>` | 0 / 0 |

## 4. 设计边界

- 恢复写入**新目录**并校验 index tree 与文件内容；**不改动原仓库、不覆盖已有工作区、不自动删除快照**。
- 完整性校验基于逐文件 sha256（含 `objects.bundle`），不依赖原仓库；`git bundle verify` 在创建阶段执行。
- 磁盘不足（真实 ENOSPC）无法在本机可靠注入：错误处理路径与缺对象/不可写共用（任何 clone/写入失败都记录失败，
  不伪造成功），但**未直接实测 ENOSPC**，标"未验证"。
- 旧 `GitRecoveryPointService` 的未跟踪复制失败静默跳过仍未统一（超出本卡范围）；本卡覆盖的保全路径已诚实。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / `npx eslint .` / `npm run build` | **0 / 0 / 0** |
| `npx vitest run --maxWorkers=6` | **exit 0：214 文件 / 1719 用例全通过**（+3 文件 / +14 用例） |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：全局 **93.17 / 85.26 / 92.60 / 93.22**；`core/src/orchestration` **93.91 / 86.68 / 94.31 / 93.95**；`local-preservation-service.ts` **91.02 / 78.28 / 98.07 / 90.95** |
| `npm run verify:security-coverage` | **exit 0：关键安全模块 22/22 达标（阈值 95%）** |
| `git push` | **exit 0**（第 1 次尝试成功）：`ea15f9f..01c4fa0` 已推送 |

本检查点实现提交：`01c4fa0`（`feat(git-preserve): GIT-PRESERVE-03 崩溃恢复、独立恢复演练与产品状态入口`）。

## 6. 未满足项与后续

- **GIT-PRESERVE 三检查点（01/02/03）至此全部完成**。
- 按新用户文档推荐顺序，其后为 **READ-FORMAT-01..05** 与 **GUIDE 增量**；治理文档统一修订仍未开始。
- 真实 ENOSPC/权限耗尽的故障注入、真实远端网络故障注入仍未执行（需外部环境），标未验证。
