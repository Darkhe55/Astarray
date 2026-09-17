# ADR-0041 远端同步失败后的本地保全（本地快照定义）

- 状态：已采纳（GIT-PRESERVE-01 冻结；实现属 GIT-PRESERVE-02/03）
- 日期：2026-09-16
- 来源：docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §5（用户指导，未跟踪文件）
- 相关：ADR-0009（变更前自动备份）、ADR-0010（受控备份访问与删除）、ADR-0012（次级 Agent 拥有 Git 集成）、
  ADR-0030（统一会话恢复）、本仓库既有 `GitRecoveryPointService` 与 `GitProcess`

## 1. 背景

现有 `GitRecoveryPointService`（T05B）只在**破坏性 Git 操作前**创建恢复点：
把受影响引用备份为同仓库内的 `refs/astarray-recovery/...`，并用
`git diff --binary HEAD` + `ls-files --others --exclude-standard` 复制工作树未提交内容。
它服务于"操作可回退"，**不是**"远端同步失败后的本地保全"：

- 产品代码里没有任何远端同步状态（全仓库检索 `git push` 只命中一处注释）；
- 快照数据只有同仓库备份引用 + 状态目录内的文件副本，没有独立对象归档；
- 没有版本化清单/哈希/完整性结果，也没有 `ready`/`incomplete` 状态；
- 没有 LFS/子模块/浅克隆/无提交仓库策略。

本 ADR 冻结"本地保全点"的正式定义、清单、范围与状态，作为 GIT-PRESERVE-02/03 的实现契约。

## 2. 定义（互不等同）

| 概念 | 含义 | 反面（不得混淆） |
| --- | --- | --- |
| 远端同步成功 | 提交已出现在被配置远端的目标引用 | 不等于本地保全点存在 |
| **本地保全点**（本 ADR） | 远端同步失败后在**工作树之外**落盘的、可独立校验与恢复的版本化数据（对象归档 + index/工作树/未跟踪范围快照 + 清单） | 不是推送成功；不是目录清单；不是仅原仓库内的备份引用；不替代变更前自动备份 |
| 破坏性操作恢复点 | ADR-0009/T05B 的**操作前**可回退点 | 不是同步失败触发，也不保证覆盖 staged/未跟踪全范围 |
| 备份金库（BackupVault） | 单次破坏性文件变更的 pre-mutation 备份 | 不承担整仓库/工作树快照 |

## 3. 状态分离（冻结）

两类状态**必须分开存储与展示**，任何一侧都不得推导另一侧：

```
remoteSyncStatus: "not-attempted" | "attempting" | "succeeded"
                | "failed-network" | "failed-authentication"
                | "failed-rejected" | "failed-no-remote" | "failed-unknown"
  字段：remoteName, branchName, attemptCount(1..5), lastFailureClass,
        lastAttemptAtIso, isForcePushProhibited(恒 true)

localPreservationStatus: "not-required" | "pending" | "ready" | "incomplete" | "failed"
  字段：preservationPointId, manifestHash, baseCommit, includedScope[],
        excludedPatterns[], integrityResult, failureReason, generation,
        createdAtIso, restoredAtIso
```

规则：

1. 认证失败、冲突拒绝与网络失败**分别展示**；`failed-rejected`/`failed-authentication`
   不重试为网络重试，**不强推、不自动解决远端分歧**。
2. 网络失败**立即**生成本地保全点，不等待 5 次重试耗尽；无远端或其他同步失败
   同样记录原因并保全。
3. 每阶段上传最多重试 5 次；保全失败不冻结整个项目，只暂停依赖该保全点的危险操作。
4. 同一提交与工作树指纹**复用已验证快照**，重试不重复全量复制。

## 4. 保全清单（版本化 manifest）

清单为带 schema 版本的 JSON，至少含：

- 仓库标识、mission/task 标识、基线提交 oid、当前 `HEAD` 与**分离 HEAD 状态**；
- 目标分支/引用及其 oid；`git worktree list` 与每个 worktree 的 HEAD（附加工作树受限支持）；
- **index（已暂存）状态**：`git write-tree` 得到的 tree oid + `git diff --cached --binary` 补丁；
- **未暂存**改动：`git diff --binary` 补丁；
- 范围内**未跟踪文件**：相对路径 + 字节数 + sha256（不是只有路径）；
- 删除/重命名记录（来自 `git status --porcelain=v2 -z`）；
- 排除清单（显式、有版本）与排除原因；
- 独立对象归档路径 + sha256（`git bundle create --all` 或等价归档）；
- `isShallowRepository`、LFS 指针文件清单、子模块路径与 gitlink oid；
- 完整性结果（每项校验的通过/失败与失败原因）、代次（generation）与并发戳。

**缺失文件、读取失败、复制失败绝不静默当作空数据**；必须写入失败原因并使状态为
`incomplete`/`failed`，`ready` 只在整个清单校验通过后设置。

## 5. 存储、安全与排除

- 数据存放于工作树之外的受保护目录（`<state>/local-preservation/<mission>/<pointId>/`），
  **排除备份自身**，避免递归；敏感数据不进入模型上下文、日志或普通导出。
- 复用 ADR-0010 的受控备份访问/恢复入口；模型不可见物理路径，也不提供删除/淘汰入口。
- 默认不收集依赖缓存与构建产物（显式排除清单，如 `node_modules/`、`dist/`、
  `.next/`、`coverage/`、`.cache/`、`target/` 等）；**已跟踪内容不得因忽略规则被静默遗漏**，
  清单必须能证明全部已跟踪改动被覆盖。
- 不改动用户 `HEAD`、index 或工作树；不为快照自动 `git add`/`git commit`。
- Git 历史归档（bundle/提交）与工作树快照**分别校验**；只有 bundle/提交不足以覆盖脏工作树。

## 6. 原子性、并发与完整性

- 临时目录写入 → 落盘/flush → 原子改名发布；不完整快照不得标记 `ready`。
- 写入前后记录工作树/index 代次；并发改写触发一致性检查，必要时有界协调或重试；
  始终不得把缺失文件与读取失败当成空数据。
- 复用 ADR-0030 的原子写 + 哈希链 + "最近可信版本"选择模式，而不新造机制。
- 磁盘不足、权限不足、git 命令失败均记录为失败并给出可读原因，不伪造成功。

## 7. 恢复

- 默认恢复到**新目录或隔离 worktree**，校验文件与暂存状态，**不覆盖当前人工工作区**；
  隔离 worktree 复用既有 `GitWorktreeAllocator` 的路径约定。
- 恢复可撤销（恢复前保护点）；恢复本身不自动删除任何快照。
- 快照删除继续走专用删除流程（ADR-0010）；**不自动淘汰旧快照**。
- 本机保全不能抵御整个磁盘损坏；跨设备灾备不属本卡。

## 8. 仓库形态支持矩阵（冻结）

| 仓库形态 | 级别 | 策略与诚实标注 |
| --- | --- | --- |
| 普通仓库（有提交） | 完整支持 | 引用 + index + 未暂存 + 未跟踪 + 对象归档 |
| 尚无提交的仓库 | 支持（受限） | `HEAD` 未出生：不执行 `diff HEAD`；改用空树比较记录 index/工作树，**不得静默为空** |
| 浅克隆 | 受限 | 记录 `--is-shallow-repository`；缺历史对象 → `history-incomplete`，不宣称完整可恢复 |
| LFS | 受限 | 归档 LFS **指针**；LFS 对象不在 Git 对象库 → `lfs-objects-not-included` |
| 子模块 | 受限 | 记录路径与 gitlink oid；默认不递归克隆内容 → `submodule-content-not-included` |
| 附加工作树（linked worktree） | 受限 | 记录 `git worktree list`；默认保全目标工作树 + 主仓库引用，逐个标注 |
| 稀疏检出 | 受限 | 记录 sparse 模式；未检出路径不得声称已保全 |

## 9. 检查点映射

- **GIT-PRESERVE-01**（本 ADR）：审计并复用恢复点服务；冻结保全清单、范围与状态。无生产代码变更。
- **GIT-PRESERVE-02**：同步失败接线（远端检查结果 → 保全触发）、独立对象归档、
  index/工作树/未跟踪快照、原子清单与 `ready` 状态；反例：网络故障/缺远端触发、
  二进制、未跟踪、已暂存与未暂存并存、删除/重命名、无提交仓库。
- **GIT-PRESERVE-03**：崩溃恢复与独立恢复演练、产品状态入口；反例：原仓库不可用仍可恢复、
  并发改写、缺对象、磁盘不足不虚报、重试不重复快照。

## 10. 非目标

- 不实现远端分歧自动解决、强推或 PR 自动化；`git push` 的独立授权规则不变。
- 不替代 ADR-0009 的变更前自动备份，也不替代 ADR-0010 的删除流程。
- 不纳入跨设备灾备、云存储或压缩去重算法选型（可在 02/03 评估，但不得改变上述状态与清单语义）。
- 不在本 ADR 授权任何安装、网络下载或外部软件控制。
