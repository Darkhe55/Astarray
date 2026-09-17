# GIT-PRESERVE-01 恢复点服务审计与本地保全冻结 — 证据

> 检查点：GIT-PRESERVE-01（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §5，未跟踪用户文件）
> 前驱：ACCURACY-03（提交 `b4f2f26`、`525781e`，已推送）。日期：2026-09-16
> 冻结契约：docs/adr/0041-local-preservation-after-remote-sync-failure.md
> 基线：HEAD `525781e` == origin/main；工作树仅有用户并行改动（未跟踪文档 + 5 个既有文件）

## 1. 审计范围与方法

只读审计，**无生产代码变更**。检索与阅读：

| 命令/文件 | 目的 |
| --- | --- |
| `glob packages/core/src/**/*git*`、`grep "RecoveryPoint|recovery-point"` | 定位恢复点相关实现与调用点 |
| 阅读 `orchestration/git-recovery-point-service.ts`（396 行全文） | 现状能力与缺口 |
| 阅读 `core/types.ts`（`GitRecoveryPointDocument`）、`core/schemas.ts`（zod schema） | 清单/状态字段现状 |
| `grep "git push|lfs|submodule|shallow"`（packages、scripts） | 远端同步状态与仓库形态支持 |
| 阅读 `git-integration-coordinator.ts` 调用点、`git-process.ts`、`git-worktree-allocator.ts`、`recovery-checkpoint-store.ts`、`tools/backup-vault.ts` | 可复用能力 |
| 阅读 `tests/core/integration/git-recovery-point.test.ts`、`git-defensive-branches.test.ts` | 既有行为基线与被固化的预期 |

## 2. 现有实现清单（可复用部分）

| 组件 | 位置 | 能力 | 复用结论 |
| --- | --- | --- | --- |
| `GitRecoveryPointService` | `orchestration/git-recovery-point-service.ts` | 破坏性操作前备份受影响引用（同仓库 `refs/astarray-recovery/...`）+ `git diff --binary HEAD` 补丁 + `ls-files --others --exclude-standard` 复制未跟踪文件；受控 `restoreRecoveryPoint`；重复恢复拒绝 | **复用**：引用与 pre-image 机制保留；02 在其上扩展保全清单/对象归档/index 快照 |
| `GitProcess` | `orchestration/git-process.ts` | 受控 git 执行、超时、结构化输出、禁止任意参数透传 | **复用**：保全点全部 git 调用走此层 |
| `BackupVault` / 受控删除 | `tools/backup-vault.ts` | 变更前自动备份、`listBackups`/`restoreBackup`、删除审计 | **复用**：受控读取/恢复入口；删除继续走 ADR-0010 流程 |
| `recovery-checkpoint-store.ts` | `orchestration/` | 原子写 + 哈希链 + 追加式 journal + "最近可信版本"回退 | **复用模式**：保全清单的原子发布与完整性校验沿用该模式，不新造机制 |
| `GitWorktreeAllocator` | `orchestration/git-worktree-allocator.ts` | 隔离分支 + worktree（`<state>/git-worktrees/...`） | **复用**：恢复默认目标目录/隔离 worktree |
| `RecoveryCenterController` / `recovery-checkpoint-store` | `orchestration/` | mission/session 级恢复对账与哈希链检查点 | 语义不同（会话恢复 ≠ 工作树快照）；仅复用模式 |

## 3. 必需验收项逐条核对

卡要求"分离 remote-sync 与 local-preservation 状态；列出 LFS/子模块等支持或受限策略"。

| 卡要求 | 现状 | 缺口/结论 |
| --- | --- | --- |
| remote-sync 与 local-preservation 状态分离 | **完全缺失**：产品代码无远端同步状态机；全仓库 `git push` 仅命中 `git-integration-coordinator.ts:8` 的**注释**；无同步失败分类 | 01 已冻结两类状态与字段（ADR-0041 §3）；02 实现 |
| 网络失败立即保全（不等 5 次重试） | **缺失**：恢复点只在 merge/finalize 前由协调器创建，与推送无关 | 02 接线 |
| 认证失败/冲突拒绝/网络失败分别展示 | **缺失**：无失败分类 | 02 实现并加反例 |
| 不强推、不自动解决分歧 | 现状无推送逻辑（天然不实现），但也没有显式禁止与展示 | 02 以显式状态 + 拒绝路径冻结 |
| 版本化清单 + 哈希 + 完整性结果 | **缺失**：文档只有 `referenceBackups[].committedOid`；`untrackedFileEntries` 仅 `relativePath`（无大小/哈希）；无清单哈希与校验结果 | 02 实现（ADR-0041 §4） |
| `ready`/`incomplete`/`failed` 状态 | **缺失**：只有 `restoredAtIso`；无发布状态 | 02 实现 |
| 原子发布 | **声称与实现不符**：文件头注释写"原子写"，实际用 `fs.writeFile` 直写 `recovery-point.json`（无临时文件+改名） | 02 改用 `writeAtomicJson`/原子改名 |
| 保存目标分支/引用与 Git 对象 | **部分**：备份受影响引用为同仓库 `refs/astarray-recovery/...`；**无独立对象归档**（无 bundle）；卡明确"不是仅建立原仓库内的备份引用" | 02 增加独立对象归档 + sha256 |
| 已暂存（index）状态 | **部分/不完整**：`git diff --binary HEAD` 文本包含已暂存改动，但恢复路径是 `reset --hard` + `apply` 补丁，**只还原工作树内容，index/staged 状态不还原**；无 `git write-tree` 记录 | 02 增加 index tree oid + `diff --cached --binary` |
| 未暂存状态 | **支持**：`git diff --binary HEAD` 补丁（含未暂存） | 保留并纳入清单 |
| 范围内未跟踪文件 | **部分**：`ls-files --others --exclude-standard` + `copyFile`；**复制失败静默忽略**（`catch {}`），且既有测试 `git-defensive-branches.test.ts` 把"复制失败静默跳过"固化为预期 | 02 改为记录失败并使快照 `incomplete`；**同步修订该既有测试预期**（用户文档允许正式启用前统一修订测试预期） |
| 删除/重命名 | **部分**：文本 diff 可覆盖删除；无显式清单记录 | 02 增加 `status --porcelain=v2` 记录 |
| 无提交仓库 | **缺失且不诚实**：`diff --binary HEAD` 在未出生 HEAD 时失败被 `catch` 成空串 → 静默 `hasWorktreePreimage=false` | 02 以空树比较处理，绝不静默为空 |
| LFS / 子模块 / 浅克隆 | **完全缺失**：全仓库无 `lfs`/`submodule`/`shallow` 处理 | 01 已在 ADR-0041 §8 冻结支持矩阵；02/03 实现并标注 `lfs-objects-not-included` 等 |
| 排除清单（默认不收集依赖缓存/构建产物） | **部分**：依赖 `--exclude-standard`（.gitignore），无显式版本化排除清单；无法证明"已跟踪内容不被忽略规则遗漏" | 02 增加显式排除清单 + 已跟踪覆盖核对 |
| 工作树之外受保护存储 | **部分**：文件副本在 `<state>/git-recovery/`（工作树外），引用备份在仓库内；无独立数据归档；未显式排除保全目录自身（无递归风险但未声明） | 02 统一到 `<state>/local-preservation/...` 并显式自排除 |
| 不改动 HEAD/index/工作树；不自动 add/commit | **符合**：创建恢复点只读取、`update-ref` 备份引用、复制文件 | 保留 |
| 指纹复用、重试不重复快照 | **缺失**：每次 `randomUUID` 新目录；`restoreRecoveryPoint` 还会再建前置恢复点 | 02 实现 (commit + 工作树指纹) 复用键 |
| 并发一致性与代次 | **缺失** | 02 实现 generation 戳与有界重试 |
| 磁盘/权限失败不伪造成功 | **违背**：`copyFile` 失败静默跳过 | 02 修复（与上面同条） |
| 缺对象/仅指针不得宣称完整可恢复 | **缺失**：无对象归档与完整性结论 | 02/03 实现 |
| 默认恢复到新目录/隔离 worktree | **不符**：就地 `reset --hard` + 应用补丁，覆盖当前工作树（有前置保护点） | 03 增加新目录/隔离 worktree 默认恢复 |
| 快照删除走专用流程、不自动淘汰 | **符合**：无淘汰逻辑、无删除入口 | 03 增加受控删除入口（走 ADR-0010） |
| 本机保全不抵御磁盘损坏；跨设备灾备非目标 | 明确为边界 | 文档化（ADR-0041 §7、§10） |

## 4. 仓库形态支持矩阵（GIT-PRESERVE-01 冻结）

见 ADR-0041 §8。摘要：普通仓库**完整支持**；尚无提交仓库**支持（受限）**；
浅克隆/LFS/子模块/附加工作树/稀疏检出**受限**并必须以显式标志标注缺失对象，
不得宣称完整可恢复。

## 5. 被现有测试固化的冲突预期（必须在 02/03 修订）

| 测试 | 当前固化行为 | 与新卡冲突 | 处理 |
| --- | --- | --- | --- |
| `tests/core/integration/git-defensive-branches.test.ts`："恢复点服务：untracked 文件快照复制失败静默跳过" | 复制失败 → 静默跳过 | 卡要求"不能把缺失文件和读取失败静默当成空数据""磁盘不足不能虚报" | **02 已按新路径解决**：新增 `LocalPreservationService` 对读取/复制/校验失败记录为 `incomplete`；**旧破坏性操作路径未改**（改其文档 schema 超出 02 范围），统一旧路径登记为 03 收口项 |
| `tests/core/integration/git-recovery-point.test.ts`（3 用例） | 引用/工作树恢复、重复恢复拒绝、受保护前缀 | 与卡不冲突，作为 02 回归基线 | 保留；02 追加 index/清单/对象归档用例 |

## 6. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/git-recovery-point.test.ts tests/core/integration/git-defensive-branches.test.ts --maxWorkers=4` | **未执行**：受限沙箱下 vitest forks 池 spawn EPERM，需升级；本阶段 5 次升级调用全部在 600s 墙钟上限内未获审批而终止（审批通道停滞）。基线能力改以**静态阅读测试文件与实现**取证，标"未运行" |
| `npx tsc --noEmit` / `npx eslint .` / 全量测试 | 本检查点为审计/冻结，**无生产代码变更**，未运行（无变更可验） |

> 未验证声明：本检查点未运行任何测试；"现状能力真实可用"依据是既有测试文件的断言内容与实现代码，
> 不是本轮实测结果。GIT-PRESERVE-02 开始实现时必须先跑通基线再改行为。

## 7. 未满足项与后续

- **GIT-PRESERVE-02**：同步失败接线、独立对象归档、index/工作树/未跟踪快照、原子清单与 `ready` 状态；
  反例覆盖网络故障/缺远端触发、二进制、未跟踪、已暂存与未暂存并存、删除/重命名、无提交仓库。
- **GIT-PRESERVE-03**：崩溃恢复与独立恢复演练、产品状态入口；反例覆盖原仓库不可用、
  并发改写、缺对象、磁盘不足、重试不重复快照。
- 真实远端网络失败场景需外部环境（本机 `git push` 目标为真实仓库）；已用既有代码路径审计代替，
  未运行真实推送故障注入 —— 标**未验证**。
- 治理文档统一修订未开始；本检查点未修改任何治理文档、生产代码或既有测试。
