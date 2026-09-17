# GIT-PRESERVE-02 同步失败接线与本地保全快照 — 证据

> 检查点：GIT-PRESERVE-02（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §5，未跟踪用户文件）
> 前驱：GIT-PRESERVE-01（提交 `d780565`、`09462be`，已推送）。日期：2026-09-16
> 契约：docs/adr/0041-local-preservation-after-remote-sync-failure.md（§11 为实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/orchestration/local-preservation-service.ts`（新） | `LocalPreservationService`：触发分类（`evaluateRemoteSyncPreservationTrigger`）、版本化保全清单、index/未暂存/未跟踪/删除重命名快照、独立 `git bundle` 对象归档 + sha256、工作树之外受保护目录、临时目录原子改名发布、复用键、诚实失败状态 |
| `packages/core/src/application/application-runtime.ts` | 装配并暴露 `localPreservationService`（状态目录下 `local-preservation/`） |
| `tests/core/integration/local-preservation.test.ts`（新，8 用例） | 触发分类、成功不触发、普通仓库全清单、排除清单不静默丢弃、无提交仓库、LFS/子模块不完整标注、仓库不可用失败、指纹复用 |
| `docs/adr/0041-local-preservation-after-remote-sync-failure.md` | 追加 §11 实现记录 |

## 2. 行为反例（红→绿）

先写测试并在模块缺失时确认失败（`Tests no tests`，import 解析失败），再实现至全绿。

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 网络失败/缺远端/认证失败/拒绝/未知 | 触发保全 | ✅ 五类均 `shouldPreserve=true` |
| push 成功 / 未尝试 / 进行中 | 不触发、不留空目录 | ✅ `shouldPreserve=false`，`local-preservation` 目录不存在 |
| 已暂存 + 未暂存并存 | 分开记录且哈希不同 | ✅ `index.cachedPatchSha256 ≠ worktreeChanges.unstagedPatchSha256` |
| 未跟踪含二进制文件 | 记录路径 + 大小 + 哈希 | ✅ `binary.bin` byteCount 5、sha256 与源文件一致 |
| 删除/重命名 | 显式变更条目 | ✅ `changeKinds` 含 `deleted`、`renamed`（含原始路径） |
| 依赖缓存/构建产物 | 默认排除但显式记录，不静默丢弃 | ✅ `node_modules/pkg/index.js` 进入 `excludedUntrackedFilePaths` |
| 尚无提交的仓库 | 不用 HEAD diff，index/工作树仍记录 | ✅ `hasUnbornHead=true`、`baseCommit=null`、cached/unstaged 补丁均非空、`objectArchive.note="no-refs-to-archive"` |
| LFS 声明 / 子模块 gitlink | 标注不完整，不宣称完整可恢复 | ✅ `status="incomplete"`、失败项含 `lfs-objects-not-included`/`submodule-content-not-included` |
| 仓库不可用 | 记录失败、不伪造成功 | ✅ `status="failed"` + `failureReason`，`isComplete=false` |
| 重试产生重复全量快照 | 指纹复用同一快照 | ✅ 第二次 `isReused=true` 且目录仅 1 个；内容变化后新建（目录 2 个） |
| 对象归档只存在于原仓库 | 独立归档可校验 | ✅ `git bundle verify` 成功、sha256 与文件一致 |
| 清单被篡改仍可读 | 读取时报损坏 | ✅ `readPreservationPoint` 重算哈希，不匹配抛 `journal-corrupted`（清单 + 独立 `manifest.sha256`） |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/local-preservation.test.ts --maxWorkers=4`（实现前） | 1；`Tests no tests`（模块不存在，反例先红） |
| `npx vitest run tests/core/integration/local-preservation.test.ts --maxWorkers=4`（实现后） | 0；**8 passed**（9.6s） |
| `npx tsc --noEmit` / `npx eslint <改动文件>` | 0 / 0 |

## 4. 设计边界

- 与 `GitRecoveryPointService`（破坏性操作恢复点）**分离**：本服务是"同步失败后的本地保全"；
  ADR-0041 §2 明确四者互不等同。
- 触发判定与快照创建都在本地确定性代码中完成，不依赖模型；推送本身仍走独立授权规则。
- 旧恢复点服务对未跟踪复制失败仍是静默跳过（`git-defensive-branches.test.ts` 固化）：
  本轮**未**修改该服务与其测试（改变其文档 schema 超出 02 范围），保全路径已由新服务提供诚实行为；
  是否统一旧路径登记为 03 收口项。
- 未执行真实远端网络失败注入（需要真实远端与故障环境）；触发覆盖为本地状态机实测。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / `npx eslint .` / `npm run build` | **0 / 0 / 0** |
| `npx vitest run tests/core/integration/local-preservation.test.ts --maxWorkers=4` | **0；10 passed** |
| `npx vitest run --maxWorkers=6` | **exit 0：211 文件 / 1705 用例全通过**（+1 文件 / +10 用例） |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：全局 statements **93.27%** / branch **85.43%** / functions **92.50%** / lines **93.34%**；`core/src/orchestration` **93.97 / 86.78 / 94.12 / 94.03**；新模块 `local-preservation-service.ts` **90.97 / 77.63 / 95.00 / 91.22** |
| `npm run verify:security-coverage` | **exit 0：关键安全模块 22/22 达标（阈值 95%）** |
| `git push` | 见提交记录 |

> 架构守卫真阳性：新模块的 `fs.rm`/`writeFile`/`rename` 触发 `destructive-file-api-guard`；
> 处理为**去掉无必要的 `fs.rm`**（`.tmp-*` 残留由 list 过滤且不标 `ready`），并把模块加入
> 带理由的最小令牌白名单（`writeFile`、`rename`），未扩大守卫范围。

## 6. 未满足项与后续

- **GIT-PRESERVE-03**：崩溃恢复与独立恢复演练（原仓库不可用仍可恢复已声明范围）、产品状态入口
  （CLI/公共门面展示 `remoteSyncStatus`/`localPreservationStatus`）、并发改写与缺对象/磁盘不足反例。
- 恢复（restore）尚未实现：本轮只做保全快照与校验；默认恢复到新目录/隔离 worktree 属 03。
- 旧 `GitRecoveryPointService` 的静默复制失败仍未统一（见 §4）。
