# PLAN_STATUS — Astarray 实施状态

> 更新规则见 `IMPLEMENTATION_PLAN.md` §8.4：开始任务标记 `in_progress`，全部验收通过才标记 `done`。
> 会话中断后从第一个 `in_progress` 或依赖已满足的 `pending` 任务恢复。

> 2026-08-12 设计增补：反馈消息契约新增必填结构化 `source`。用户、Agent、系统来源均可追踪；转发保留原始来源。T00 契约、Schema、测试和架构文档已同步更新。
> 2026-08-12 设计增补：Agent 来源进一步收紧为具体且不可复用的 `agentInstanceId`。新增 T05A：每个次级/三级 Agent 拥有独立工作存档，上级发布任务或重新调用前可选择具体条目附加，默认不注入。
> 2026-08-12 设计增补：新增 T06A 工具内破坏性变更备份层。文件/目录删除、文字删除、替换、截断和覆盖必须先由工具自动保存完整 pre-image；备份数据、路径与恢复能力不经过模型端。
> 2026-08-12 设计增补：T06A 增加 `backupVault` 读取/恢复工具和独立 `deleteBackup` 特权入口。协同模式删除会警告用户并暂停 Agent，逐次授权；放权模式不提醒但保留 HIGH 审计记录；采用 quarantine 两阶段删除防止递归与死锁。模式中文名统一为思索/协同/放权。
> 2026-08-13 设计增补：新增 T05B。涉及 Git 写入的多 Agent 任务由次级 Agent 负责分支/worktree 分流、三级 Agent 提交审查、集成测试和受控合并；三级 Agent 只能提交自己的隔离分支。Git 历史不替代工具内自动备份，破坏性 Git 操作必须先创建受保护恢复点。
> 2026-08-13 设计增补：新增 T05C。每个调度 Agent 在自己的记忆存档域维护独立待办任务偏序集，发布者可指定前驱/后继；用户任务默认优先级层级 0，Agent/system/工具任务只能层级 1 或以下。次级 Agent 可把一条链打包给三级 Agent，并提供无副作用状态查询工具。
> 2026-08-13 设计增补：新增 T06B。Ponder 改为本地只读白名单，可查看普通项目文件、检索文本和查询只读状态；写入、进程、网络、凭据和备份工具由本地策略与 OS 边界硬禁用，敏感操作分类不依赖云端或 AI。
> 2026-08-13 设计增补：新增 T07A。模型完成时必须返回版本化明确完成控制事件；本地验收通过后才结案。缺失/无效标识或输出早停时，从原子检查点最多自动续跑 3 次，并防止并行请求与重复非幂等副作用。
> 2026-08-13 设计增补：新增 T06C。`.env`/`.env.*`、私钥、凭据库、能力令牌及本地 DLP 命中内容在 Ponder/Assist/Devolve 三种模式和全部工具通道中禁止模型读取，无授权例外。
> 2026-08-13 设计增补：新增 T07B。同一具体 Agent/任务短时间重复读取未变化且已覆盖资源时返回读取回执；增加资源/工具环、Agent 回派乒乓、搜索换词和无进展重试的本地有界守卫。
> 2026-08-13 设计增补：新增 T06D。高严谨性任务由本地规则强制调用事实验证工具；证据按“资料搜索 > 本地实验 > 纯推理”组织，只作为用户判断辅助，不自动判定合格。
> 2026-08-13 设计增补：新增 T06E。Assist 的代码库、依赖、运行时、插件、工具链、系统包等任意安装尝试采用两阶段门禁：先询问用户是否已有可用资源；用户确认没有后，只有独立设置开关开启才能提出精确的逐次安装授权，开关和会话授权均不能代替本次用户确认。
> 2026-08-13 设计增补：新增 T06F。Devolve 对全部可配置权限提供逐项 deny/ask/allow 设置并默认 allow；Assist 使用独立默认矩阵，Ponder 不可调整。用户可创建、命名和完全配置不设数量上限的自定义权限模式；底层安全不变量不受模式设置影响。
> 2026-08-13 设计增补：新增 T06G。主 Agent 在所有模式下永久只读；权限组和当前会话临时提升只作用于次级 Agent（临时提升默认覆盖当前会话全部次级 Agent，也可限定具体个体），且构成其向三级 Agent 分发权限的严格上限。会话关闭时可导出当前公开有效权限配置，导出不携带会话授权能力。
> 2026-08-13 设计增补：新增 T08A。默认工作流由主 Agent 持续交流/评估并经本地控制面向次级偏序集插入任务，次级 Agent 持续调度并负责三级生命周期与本地/远端项目集成，三级 Agent 一次激活只执行一条任务链。后台汇报只入主 Agent 报告索引，后续用户交流按需读取。
> 2026-08-13 记忆隔离增补：主、次级、三级每个具体 Agent 均以不可复用 `agentInstanceId` 独占记忆、工作存档、上下文、缓存、读取回执和消息视图；禁止角色级或同级共享。跨 Agent 仅经本地控制器传递带来源和哈希、只对当前任务有效的不可变附件。
> 2026-08-14 设计增补：新增 T08B。次级/三级 Agent 首次接收工具组时获得完整公开用法，同 revision 后续只收标准回访提醒；已分配工具直接按单工具回复，缺失能力逐级上报，三级默认先报所属次级。各层实例无产品数量配额；直属上级经授权可把直属低一级 Agent 的限定沟通句柄转交具体同级 Agent，但不转移任务、记忆、工具、Git 或权限。
> 2026-08-16 设计增补：新增 T08C。主 Agent 保持单会话唯一连续用户对话者；小型明确任务可在主会话中经用户确认直投具体次级 Agent，但结果仍由次级压缩摘要、主 Agent 面向用户解释。次级通过侦察三级 Agent 获取有界项目摘要，分别任命实现/测试/验收个体；三级可把严格子链委派给四级，项目级 Git 集成仍只属于次级。
> 2026-08-16 设计增补：新增 T07C。每个主/次级/三级/四级 Agent 拥有独立模型分配；用户可按用途配置任意长度模型/Provider 允许列表，并创建任意数量的办公、前端、编码、debug、测试、验收、侦察、绘图和自定义任务类型预设。切换只在安全检查点和允许列表内发生。
> 2026-08-17 设计增补：新增 T08D。“工匠”是阶段性显现的三级 Agent预设，只用已有已授权基础工具定制可复用工作流。会话开始时不向次级注入说明；活跃时长、已验收任务、里程碑、记忆索引规模或重复工作指纹达到本地策略后才披露。用户可配置无限阶段模板及给次级自动安排的提示词，自动节点只能位于优先级层级 1 或以下。
> 2026-08-18 设计增补：新增 T07D。T07C 只负责模型/Provider 策略；T07D 单独负责主流 Provider 原生协议、真正增量流、CLI/TUI 产品装配、稳定 Public SDK，以及从 npm tarball 完成项目分析和小型编码/测试/验收的独立工作助手纵向闭环。顺序更新为 T08C → T08D → T07C → T07D → T12。
> 2026-08-19 设计增补：新增 T05D、T07E、T12A。T05D 保护人工与 Agent并行编码并由次级协调冲突合并；T07E 对每个具体 Agent默认执行10个项目内容文件工作集预算并允许受控拆分/扩展；T12A 负责中断后统一检查点、只读外部状态对账和未知副作用阻塞。有效偏序为 T08C 后分别推进 T08D→T07C、T05D、T07E，三路通过后执行 T07D→T12A→T12。
>
> 2026-08-12 审计整改：外部验收发现 7 项阻断性问题，全部已修复并回归（详见"审计整改记录"）。修复涉及 S1 doctor 数据丢失、S2 反馈入池校验、S3 备份事务闭环、S4 授权绑定、S5 交互授权通道、S6 存档 provenance、S7 config 备份保护；另完成覆盖率与测试基建改善（S8/S9）。

## 任务总览

> ⚠️ 重新验收中（AR-00 起，依据 `AUDIT_REMEDIATION_TASKS.md`）：以下任务状态不再视为最终通过。
> 基线证据见 `.tmp/ar00-baseline-evidence.md`；每个任务须在对应 AR 主任务完成并动态复验后才恢复为 done。

| 任务 | 内容 | 状态 | 批次 | 备注 |
|---|---|---|---|---|
| T00 | 架构定稿与契约 | re-verifying | 1 | AR-00 重新验收中 |
| T01 | npm 与 TypeScript 工程骨架 | re-verifying | 1 | AR-00 重新验收中 |
| T02 | 模式状态机与权限策略 | re-verifying | 2 | AR-00 重新验收中 |
| T03 | 原子任务链持久化 | re-verifying | 2 | AR-00 重新验收中 |
| T04 | 独立反馈进程 | re-verifying | 3 | AR-00 重新验收中（AR-03 认证） |
| T05 | DAG 调度器 | re-verifying | 4 | AR-00 重新验收中 |
| T05B | 次级 Agent Git 分流、审查与合并 | re-verifying | 4D | 2026-08-13 完成；Batch 4D 检查点（491 测试全绿）；待 AR-04/AR-06 复验 |
| T05C | Agent 待办偏序集、任务包与状态工具 | re-verifying | 4E | 2026-08-13 完成；Batch 4E 检查点（471 测试全绿）；待 AR-04/AR-06I/AR-07 复验 |
| T05D | 人工与 Agent 并行编码、冲突协调及受控合并 | re-verifying | pre-T07D | T05D-01~06 全部完成（1063 测试全绿；dist 可达 + smoke-install 通过） |
| T06 | 工具注册表与最小权限 | re-verifying | 4 | AR-00 重新验收中（AR-01 受保护存储） |
| T06A | 工具内破坏性变更备份层 | re-verifying | 4C | AR-00 重新验收中（AR-01/AR-05/AR-06） |
| T06B | Ponder 本地只读边界与敏感操作分类 | re-verifying | 4F | 2026-08-13 完成；Batch 4F 检查点（510 测试全绿）；待 AR 复验 |
| T06C | 全模式本地敏感内容禁读 | re-verifying | 4G | 2026-08-13 完成；Batch 4G 检查点（524 测试全绿）；待 AR 复验 |
| T06D | 高严谨性事实验证工具 | re-verifying | 4I | 2026-08-13 完成；Batch 4I 检查点（562 测试全绿）；待 AR 复验 |
| T06E | Assist 安装前置询问、独立开关与逐次授权 | re-verifying | 6A | B6R-01/02 已返修完成；待终验（跨平台矩阵） |
| T06F | 可配置权限组与无限命名自定义模式 | re-verifying | 6B | B6R-03/04 已返修完成；待终验（跨平台矩阵） |
| T06G | 主 Agent 永久只读、次级权限上限与会话临时提升 | re-verifying | 6C | B6R-05/06 已返修完成；待终验（跨平台矩阵） |
| T07 | Agent Runtime | re-verifying | 4 | AR-00 重新验收中 |
| T07A | 明确完成协议与早停恢复 | re-verifying | 4J | 2026-08-13 完成；Batch 4J 检查点（583 测试全绿）；待 AR 复验 |
| T07B | 反自指读取与通用活锁守卫 | re-verifying | 4H | 2026-08-13 完成；Batch 4H 检查点（539 测试全绿）；待 AR 复验 |
| T07C | Agent 独立模型/Provider 策略与任务类型预设 | re-verifying | 6H | T07C-01~06 全部完成（957 测试全绿；dist 可达 + smoke-install 通过）；T07D 可开始 |
| T07D | 多 Provider 生产运行时与独立 Agent 工作助手 | re-verifying | 6I | T07D-00~08 全部完成（1117 测试全绿；SDK exports 隔离导入验证 + smoke-install 通过） |
| T07E | Agent 工作集与默认10文件读取预算 | re-verifying | pre-T07D | T07E-01~06 全部完成（1106 测试全绿；dist 可达 + smoke-install 通过） |
| T08 | 三级 Agent 编排 | re-verifying | 5 | AR-04 复验：T05B→T08 Git 编排接入完成（Batch 5 增补检查点），待 AR-04 全项复验 |
| T08A | 默认控制流、个体记忆隔离与三级 Agent 生命周期 | re-verifying | 6D | B6R-07/08/09 已返修完成；待终验（跨平台矩阵） |
| T08B | 工具说明回访、无产品数量配额与受权通信转交 | re-verifying | 6E | 2026-08-13 完成；Batch 6E 检查点（665 测试全绿）；待 AR 复验 |
| T08C | 主对话独占、次级直投、项目侦察/验收与四级委派 | re-verifying | 6F | T08C-01~07 全部完成（858 测试全绿；dist 可达 + smoke-install 通过）；T08D 可开始 |
| T08D | 阶段性“工匠”三级 Agent与工作流定制 | re-verifying | 6G | T08D-01~06 全部完成（910 测试全绿；dist 可达 + smoke-install 通过）；T07C 可开始 |
| T09 | 记忆、缓存与指标 | re-verifying | 6 | AR-00 重新验收中 |
| T10 | TUI | re-verifying | 6 | AR-00 重新验收中（AR-02 授权交互） |
| T11 | Headless CLI | re-verifying | 6 | AR-00 重新验收中 |
| T12 | 恢复、安全与异常加固 | re-verifying | 7 | AR-00 重新验收中 |
| T12A | 统一会话恢复、任务续接与外部状态对账 | in_progress | pre-T12 | T12A-01 契约完成（ADR-0030；1126 测试全绿）；T12A-02 起按检查点推进 |
| T13 | npm 打包与隔离安装 | re-verifying | 8 | AR-00 重新验收中（AR-07 终验） |
| T14 | 文档与最终报告 | re-verifying | 8 | AR-00 重新验收中（AR-07 文档对齐） |

## 审计整改记录（外部验收后）

### AR-01 隔离备份保管库与审计存储 — 2026-08-12 通过

- 新增 `ProtectedStoragePolicy`：规范化组件判定，普通工具执行前强制检查，列目录过滤受保护条目；不暴露物理布局。
- `listBackups` 返回公开 `BackupSummary` DTO（无哈希/能力标识/物理路径）；`readBackup` 返回显式编码与媒体类型。
- 双层校验（预检 + 紧邻 IO 复检）拦截"预检后目标被替换为链接"的 TOCTOU（junction 反例测试）。
- 安全反例测试先失败后通过；`npm run check` 全绿（33 文件 / 422 测试）；证据见 `.tmp/ar01-evidence.md`。
- 任务状态保持 `re-verifying`，待 AR-07 最终安全清单全部勾选后统一恢复 done。

### AR-01a 别名/链接绕过加固 — 2026-08-13 完成

- 受保护存储策略补 fail-closed 真实路径判定：词法判定之外，`assertGenericToolAccessAllowed` 解析 realpath，真实目标落入保管库/审计文件即拒绝；realpath 无法解析且路径链含符号链接（lstat 检测）时一律拒绝，拦截"工作区内链接/联接指向保管库"的别名绕过。
- Windows 大小写不敏感折叠（normalize + toLowerCase）用于审计文件路径比较与保护区包含判定；realpath 返回值大小写差异不再误放行。
- 目录条目过滤收窄：仅当目录是受保护根所在的状态目录时过滤（不在任意目录隐藏同名普通文件）。
- `backupVault read` 输出携带 `[encoding: ... , media-type: ...]` 头；`replaceFileContent` 紧邻 IO 复检结果用于后续全部操作（预检后换链被拦截）。
- 验证：确定性 mock 单测（fail-closed 链接链分支、大小写变体、词法兜底）+ 集成反例（junction 别名不可读取保护内容，Windows junction lstat 平台局限已注释说明）；`npm run check` 全绿（35 文件 / 435 测试）。

### 2026-08-12 — 阻断性问题全部修复并回归

| 项 | 问题 | 修复 |
|---|---|---|
| S1 | doctor 用固定 `.write-probe` 覆盖再删除，可能销毁用户文件 | 随机唯一文件名 + `wx` 排他创建；回归测试（用户同名文件完好、无残留） |
| S2 | 反馈入池无运行时校验，伪造来源/非法层级可入 journal | `feedbackMessageSchema` 严格校验 + Agent 来源身份注册（setAgentStatus 注册，未注册拒绝），拒绝路径写 stderr + `accepted=false` |
| S3 | 备份事务无闭环（TOCTOU/恢复不可撤销/备份 ID 暴露/purge 虚报/仅 UTF-8 文本） | 写入前 `verifyTargetUnchanged` 指纹复核；恢复前自动备份当前版本；输出不再含备份 ID；purge 物理删除失败抛错保持 quarantined；pre-image 改为 base64 快照（二进制 + 目录递归，跳过符号链接） |
| S4 | 删除授权仅查 revision，未核对请求 ID/Agent/集合/过期/最新 revision | 决策绑定严格校验（请求 ID、发起 Agent、精确备份集合、过期时间）+ 授权后读取最新 revision 比对；工具隔离前再校验一次 |
| S5 | CLI 授权通道固定 null，协同模式只能拒绝 | 新增 `InteractiveBackupDeletionAuthorizationPort`（警告→暂停→等待 yes/deny，非 TTY fail-closed），接入 bootstrap |
| S6 | 存档合并后虚构 owner/revision、Worker ID 复用、路径编码碰撞、自动附加违反"默认不附加" | 按属主分别生成附件（真实 owner+revision）；每次启动唯一实例 ID；`~XXXX` 单射幂等编码；`attachArchiveContextOnRetry` 默认关闭 |
| S7 | config init 无备份覆盖 | 覆盖前走 BackupVault 自动备份 + TOCTOU 校验 |

另（S8/S9）：反馈进程分支覆盖提升（transport 100%、mailbox 90%+，entrypoint 受 v8 源映射偏移影响部分失真）；新增 TUI 启动路径测试；`pretest` 保证 dist 新鲜（消除 skipIf 静默跳过）；ADR 0007-0010 去重重编号（重复 0008/0009 删除）；`npm prune` 清理 extraneous 自副本；git 基线提交 `2ac838a`；Windows rename 瞬时 EPERM 加有界重试。

## Batch 4D（T05B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 42 文件 / 491 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 93.16% / Branch 85.30% / Funcs 90.16% |

T05B（次级 Agent Git 分流、审查与合并，ADR-0012）：

- `GitProcess`：受控 git 子进程执行器（spawn、GIT_TERMINAL_PROMPT=0、超时 SIGKILL 且等待进程退出释放句柄、结构化输出、GitProcessError）。
- `GitRecoveryPointService`：reset/clean/checkout 覆盖/rebase/强制移动引用/删除分支前自动创建恢复点——引用 oid 备份到 `refs/astarray-recovery/` 受保护前缀 + 工作树未提交 pre-image（diff --binary + untracked 快照）；恢复前自动创建前置恢复点（恢复可撤销）；重复恢复拒绝；模型不可删除恢复引用。
- `GitWorktreeAllocator`：固定基线创建集成分支 + 每个三级 Agent 独立 worker 分支/worktree；worktree 作用域 config（启用 `extensions.worktreeConfig`）绑定提交身份；分配记录持久化（mission/任务/Agent/基线/允许路径）。
- `GitContributionVerifier`：合并前验证提交存在、祖先关系、提交作者 = 绑定 agentInstanceId、实际修改未越过允许路径、敏感信息扫描（凭据/私钥/令牌）、测试证据非空且成功；结构性问题 → rejected，仅证据不足 → needs-rework。
- `GitIntegrationReportStore`：结构化分流/审查/拒绝/测试/合并记录，与次级 Agent 工作存档关联。
- `GitIntegrationCoordinator`：startIntegrationSession（固定基线+集成分支）/submitContribution（验证通过 → `merge --no-ff` 保留来源，冲突抛 tool-execution-failed 并提示恢复点，禁止静默选边）/finalizeIntegration（集成测试失败记录 unresolvedRisks 不合并；模式/用户授权门禁通过才合入目标分支，合入前自动恢复点）。
- 实测发现并修复：worktree 共享配置导致身份覆盖（启用 worktreeConfig 扩展）；集成测试命令以 shell 在仓库目录执行（不能透传为 git 参数）；恢复点恢复前先对齐工作树到备份提交再应用补丁。

遗留：`git push`/PR/发布仍无工具（始终需要独立授权，符合 ADR-0012）；TUI/CLI 状态适配器留待后续。

## Batch 4E（T05C 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 38 文件 / 471 测试通过 |
| `npm run test:coverage` | 0 | Stmts 92.97% / Branch 85.08% / Funcs 90.37% |

T05C（Agent 待办偏序集、任务包与状态工具，ADR-0013）：

- `TaskSequencePartialOrder`：插入前驱/后继锚点（无锚点不自动追加队尾）、环检测（插入即回滚）、ready set 按 (priorityTier 升序, sequenceOrdinal 稳定序号) 排序、`explainOrder` 解释阻塞原因与"高优先任务必要前驱可先行"。
- `TaskPriorityPolicy`：用户默认层级 0（可更低）；agent/system/tool 请求层级 0 一律硬拒绝（task-priority-denied）。
- `AgentTaskSequenceStore`：`.astarray/agent-memory/<agentInstanceId>/task-sequences/<sequenceId>.json`，expected revision 原子更新、主文件损坏从备份恢复、写入前自动备份副本。
- `TaskBundlePlanner`：链结构校验（相邻直接前驱）、优先层一致、首节点及包内节点必须 pending、绑定具体三级 `agentInstanceId` 与序列 revision。
- `TaskSequenceManageController`：发布/插入/状态迁移/取消/打包/包状态推进，全部变更记录认证来源审计条目；越权改序拒绝。
- `TaskSequenceStatusController` + `taskSequenceStatus` 只读工具：身份由 harness 注入（owner = 当前 Agent 实例，模型无法填他人 ID），返回一致 revision 快照（ready set/顺序解释/任务包），无副作用。
- 序列文件只含调度信息，不含项目产出内容。

遗留：TUI/CLI 状态适配器（分栏展示）待 Batch 6 后续接入；任务状态保持 `re-verifying` 待 AR-07 最终安全清单。

## Batch 4A/4C（T05A/T06A 增补任务）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 30 文件 / 379 测试通过 |
| `npm run test:coverage` | 0 | Stmts 92.02% / Branch 85.17% / Funcs 89.25% |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + 全局 shim + 反馈入口全通过 |

T05A（Agent 工作存档，ADR-0008）：

- `AgentWorkArchiveStore`：每 Agent 独立存档（版本化 + 单调 revision + 原子写入 + 路径安全编码）。
- Worker 自动记录 assignment/result/failure/handoff；调度器重新调用任务时只附加最近结果类条目（选择器），默认不注入完整存档；附件含 SHA-256 contentHash。

T06A（破坏性变更备份层，ADR-0009）：

- `BackupVault`：破坏性变更前由工具自动保存完整 pre-image（不经过模型）；list/read/restore；quarantine 两阶段删除；manifest revision 单调。
- `BackupDeletionAuthorizationController`：协同模式经专用控制通道逐次授权（allow-once、无会话记忆、revision 校验、fail-closed）；放权模式写 HIGH 审计；哈希链审计日志。
- 新增内置工具：`replaceFileContent`（overwrite + automatic-preimage）、`backupVault`、`deleteBackup`（特权入口）。
- PolicyWrapper/CLI 装配已接入；缺少备份端口时破坏性工具拒绝执行。

实测发现并修复：Agent ID 含冒号导致 Windows 存档路径非法 → 路径段安全编码。

## Batch 8（T13–T14）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 28 文件 / 356 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.81% / Branch 85.27% / Funcs 88.39% |
| `npm pack` | 0 | `.tmp/packages/astarray-0.1.0.tgz`（13 文件 / 105 KB） |
| `node scripts/verify-package.mjs .tmp/packages/astarray-0.1.0.tgz` | 0 | 无 .env/日志/.astarray/测试文件；无 BOM；shebang 正确；反馈入口包含 |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + npx version/help/doctor/run 冒烟 + 全局 .cmd shim + 反馈入口 ESM 加载 |

T13 修复记录：npm 11 全局 `--prefix` 的 shim 位于 prefix 根目录（非 bin/）；Windows 下 execSync 的 rm/mkdir 替换为 Node fs API；`npm pack --json` 输出含 tsup ANSI 噪声需剥离；ESM 入口验证用 file:// URL。

T14 产出：`README.md`（安装/三模式/Provider/状态目录/headless/反馈进程/TUI/跨平台/安全/限制）、`DELIVERY_REPORT.md`（完成情况/实际命令证据/覆盖率/tarball/隔离安装/已知风险）。

## Batch 7（T12）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 27 文件 / 353 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.59% / Branch 85.04% / Funcs 88.09% |

本批加固与实测发现：

- **真实漏洞修复 1**：`writeFileTemporary` 接受 `../` 穿越文件名 → 已加临时目录边界校验（`isPathWithinDirectory`）。
- **真实漏洞修复 2**：Redactor 的 authorization 规则可跨行匹配（`\s+` 吞换行）且与自身占位符自匹配 → 规则改为 `[ \t]+` 并排除跨行；`containsSensitivePattern` 先剔除占位符再断言。
- 无限 tool loop：Worker 达到 maxLoopIterations 后终止并上报失败（不挂死）。
- Ponder 不产生任何状态文件（含任务链/概要）；允许的本地只读工具不得改变此性质。
- 不可写状态目录/缺失文件：TaskStore 与工具返回明确错误而非崩溃。
- 路径穿越变体（`../`、反斜杠、绝对路径、UNC、多层）全部拒绝。
- 工具分类不可绕过：大小写/包装命令/别名精确名称匹配。
- secret 不泄漏：Redactor 断言级校验（日志、JSON 输出）。

遗留风险：`writeFileTemporary` 的 `flag: "wx"`（不覆盖）在 T12 期间加入，属行为加固；跨进程 mission 锁仍为单进程内实现（多 CLI 实例并发写同一 mission 由 revision 校验兜底）。

## Batch 6（T09–T11）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 26 文件 / 339 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.56% / Branch 84.93% / Funcs 88.06% |

关键交付：

- T09：`DiskCache`（缓存键含 Provider/模型/模式/输入/系统提示词哈希/工具子集哈希/上下文摘要哈希/文件指纹；写操作/时间敏感/失败默认 bypass；stale-reject 语义）、`MetricsRegistry`（hit/miss/bypass/stale-reject、estimated token、峰值并发、消息延迟）、ANSI/OSC 清洗器。
- T10：Ink TUI（Header/会话/DAG/Agent 面板、输入框、权限与帮助弹窗、焦点循环、模式切换、500ms 状态轮询、流式节流 40ms、状态订阅驱动渲染）；组件测试覆盖 80×24/120×40/60×20、CJK/emoji、超长内容、NO_COLOR、ANSI 注入清洗。
- T11：`run/status/resume/cancel/doctor/config init` 全部实现；`--json` 模式 stdout 仅 JSON、日志走 stderr；退出码 0/1/2 稳定；11 项构建产物集成测试 + 17 项命令单元测试；反馈进程入口路径解析修复。

遗留风险：TUI 键盘输入路径未做 PTY 自动化（T13 用 node-pty 补）；指标尚未接入编排循环（v0.1 头栏显示 0）。

## Batch 6E（T08B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 53 文件 / 665 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.3x% / Branch 85.23% |

T08B（工具说明回访、无产品数量配额与受权通信转交，ADR-0024）：

- `ToolDocumentationReceiptStore` + `ToolDocumentationRecallInjector`：个体按 agentInstanceId + toolGroupIdentifier + revision 保存回执（内容哈希）；首次完整注入已分配工具说明；同 revision 连续激活只发固定提醒（ASTARRAY_TOOL_HELP_REQUEST_V1 标准格式）；revision 变化发可验证 delta（无法证明完整则完整重发）；新个体不继承、同级不共享。
- `ToolHelpRequestSchema`/`validateToolHelpRequest`：usage-help 必须带已分配 toolIdentifier 且阻塞原因限 forgot-usage/schema-uncertain/response-uncertain；missing-capability 允许 null 工具并限 not-in-assigned-tool-set/no-known-match；身份/层级/直属上级/mission/revision/来源由 harness 注入。
- `ToolDocumentationRecallController`：已分配工具直接返回单工具完整用法（usage-provided，不重复整组）；未分配/权限不足 → known-but-not-usable（不泄露 schema）+ escalation；无匹配 → missing-tool escalation；request ID 幂等去重、陈旧 revision 返回 stale-request、换词循环预算超限 rejected；isAuthorizationGranted 恒 false（不授予工具/权限/安装）。
- `UnboundedAgentInstanceRegistry`：历史实例总数不产生拒绝（10,000 实例创建/回收验证）；并发槽满 → 排队/暂停（资源限制非数量配额）；回收需允许且已回收实例不可复用。
- `AgentCommunicationDelegationController` + `DelegatedAgentCommunicationGrantStore`：target 必须恰好低一级、recipient 必须与 grantor 同级、target 存活；不透明 communicationHandleIdentifier（无 IPC/凭据暴露）；投递前失效检查全条件（用户撤销/target 回收/父子变化/mission 结束/到期/消息类型/instruction 未授权/在途超限/句柄不存在）；grant 不可转授；Agent 相关撤销批量生效。

## Batch 6D（T08A 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 52 文件 / 654 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.3x% / Branch 85.23% |

T08A（默认控制流、个体记忆隔离与三级 Agent 生命周期，ADR-0022/0023）：

- `AgentIndividualMemoryStore` + `AgentMemoryNamespacePolicy`：个体以不可复用 agentInstanceId 独占记忆域（memory-archive.json）；角色级共享路径（main/secondary/tertiary/all-agents/shared）拒绝；运行时身份/目录/文档 owner 三处一致校验；观察记录保留原始来源与附件哈希。
- `CrossAgentContextAttachmentController`：不可变附件（显式条目选择/脱敏/token 预算/内容哈希/来源校验），空选择与预算超限拒绝；verifyAttachment 防篡改。
- `ConversationTaskInsertionController`：TaskInsertionProposal 来源校验（用户与认证用户一致；主 Agent 派生层级 0 硬拒绝）、锚点/revision/环由偏序集控制器校验；提交后主 Agent 立即回对话循环。
- `TertiaryAgentAssignmentPlanner`：11 项复用条件逐项判定（存活/空闲/所属/兼容/未决/预算/冲突），create-new 带可解释原因。
- `TertiarySingleChainExecutionGuard`：一次激活绑定不可变 taskBundleId 与任务链；链外领取与禁止能力（集成分支/远端项目控制/调度等）本地拒绝。
- `TertiaryAgentLifecycleController`：九阶段受控收口（停止派发→收敛未确认调用→检查点→handoff→反馈→权限→mailbox→Git→进程），阶段失败保留状态可幂等重试，不允许杀进程代替收口。
- `MainAgentReportArchiveIngestor` + `MainAgentReportReader`：终态汇报只写独立报告索引（来源校验/内容哈希防篡改），不唤醒主 Agent 不注入对话；后续轮次按任务引用与 token 预算只读选择。

## Batch 6C（T06G 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 51 文件 / 640 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.3x% / Branch 85.01% |

T06G（主 Agent 永久只读、次级权限上限与会话临时提升，ADR-0021）：

- `MainAgentReadonlyToolProjection`：任意 profile/临时提升下主 Agent 工具投影只含读取类白名单（readFile/listDirectory/searchProjectText/taskSequenceStatus/gitReadonlyView/factVerification）；写入/进程/安装/Agent 管理/权限管理/导出工具一律不可见；空实例 ID 拒绝。
- `SecondaryAgentSessionController`：可信本地控制面创建不可复用次级 agentInstanceId，绑定 session、基础 profile 引用与权限快照；不作为主 Agent 工具。
- `SessionPermissionElevationStore/Controller`：会话级（全部现有及后续次级 Agent）与个体级提升记录，绑定 capability/资源范围/基础 profile revision/目录版本/会话权限 revision/原新决定/到期/用户裁决引用；提升方向必须更宽（deny→ask/allow、ask→allow）；撤销/批量撤销/个体回收撤销。
- `EffectiveSecondaryPermissionResolver`：基础 profile + 会话覆盖 + 个体覆盖计算有效决定；到期、profile 切换（builtin↔custom、custom↔custom）、revision/目录版本变化、Agent 回收使覆盖失效。
- `TertiaryPermissionDelegationGuard`：三态宽度 deny < ask < allow 求交；三级最终权限不得宽于次级有效权限（超出发放拒绝）。
- `CurrentPermissionConfigurationExporter`：导出基础 profile + 会话级覆盖的公开有效配置；剥离 session/Agent 身份、elevation ID、用户裁决引用、到期计时器等内部字段；覆盖导出文件前自动备份；导入无授权效力。
- `SessionShutdownCoordinator`：收敛在途调用 → 可选导出（失败只报告不阻塞）→ 无条件撤销全部提升并关闭会话；导出失败不延长权限租约。

## Batch 6B（T06F 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 50 文件 / 620 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.0x% / Branch 85.08% |

T06F（可配置权限组与无限命名自定义模式，ADR-0020）：

- `PermissionCapabilityCatalog`：44 项逐项权限（project/process/network/browser/connector/database/cloud/clipboard/environment/code-repository/dependency/extension/git/external/financial/system/backup/agent/task/memory），含 Devolve/Assist 默认值与工具映射；未映射工具拒绝注册/执行；多权限最严格裁决（任一 deny→deny，否则任一 ask→ask，全 allow→allow）；replaceFileContent 映射 project.modify + project.destructive-mutate（Assist 默认 deny）。
- `PermissionProfileStore`：内置三组——Devolve 出厂全 allow、Assist 独立矩阵、Ponder 全 deny + 签名冻结（更新入口拒绝）；自定义组单调 revision、目录版本、原子持久化、.bak 自动备份、损坏恢复、stale-revision 拒绝、特殊字符 ID 路径段安全编码。
- `CustomPermissionProfileController`：创建（空白/内置视图/自定义组复制）、重命名（ID 不变）、逐项三态、重置、导入（过滤未知权限与非法决定，不携带内部状态）、导出（仅可配置字段）、删除（当前使用组拒绝、删除前备份）；名称 Unicode 规范化 + 大小写折叠唯一，保留内置中英文名；进程内名称缓存避免 O(n²) 读盘；无产品数量上限（无计数分支）。
- `ConfigurablePermissionPolicyEngine`：schema 暴露/执行前读取 profile 快照裁决；ask 授权绑定 profile revision + 目录版本 + 参数哈希；revision/参数/模式切换（内置↔自定义）/过期后旧授权失效；未映射工具返回稳定最小"操作不可用"（无规则类别泄露）。
- `ToolRegistry` 接入目录校验：未映射工具拒绝注册。
- 内部强制执行层不进入权限目录（目录无内部项）。

## Batch 6A（T06E 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 49 文件 / 598 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.2x% / Branch 85.02% |

T06E（Assist 安装前置询问、独立开关与逐次授权，ADR-0019）：

- `InstallationOperationClassifier`：按效果分类（不依赖可绕过的命令字符串）——npm/pnpm/yarn/pip/uv/poetry/cargo、系统包管理器（apt/brew/dnf 等）、git clone/归档下载（含 -b 版本提取）、插件/技能/模型（code --install-extension、gh extension）、运行时工具链（rustup/nvm 等）、生命周期脚本、lockfile/vendor 改写；包装 shell（sh/bash/cmd -c、powershell -Command）递归解析内嵌脚本不可绕；空命令 fail-closed。
- `AssistInstallationSettingsStore`：独立布尔开关默认 false，单调 revision、写入自动备份、损坏从备份恢复、stale-revision 拒绝。
- `ExistingResourceInquiryController`：安装前结构化询问（所需能力/用途/候选类型，不读敏感配置）；用户答已有 → 只读验证端口校验（版本/完整性/兼容性），验证失败返回差异继续等待用户决定，不得自动假定"没有"并安装；答没有 → 进入开关检查。AgentStatus 新增 `awaiting-existing-resource-answer`。
- `AssistInstallationAuthorizationController`：开关开启才可生成 `assist-installation-request`（绑定 Agent/任务/来源/包/精确版本/完整性/目标/作用域/包管理器/参数/网络/脚本/变更摘要 + 一次性 nonce）；allow-once 不记忆不批量；执行前复检（模式仍 assist、设置 revision 未变、nonce 未消费未过期、参数哈希一致）通过即消费；重放/参数漂移/模式切换/revision 变化/过期全部 fail-closed。
- 反馈协议新增 `existing-resource-inquiry` 与 `assist-installation-request` payload（走 instruction 优先级）。

## Batch 4J（T07A 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 48 文件 / 583 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.47% / Branch 85.38% |

T07A（明确完成协议与早停恢复，ADR-0015）：

- `TaskCompletionEventV1` / `TaskBlockedEventV1` schema 与常量（watchdog 5s / 无进展 90s / 完成宽限 5s / 续跑上限 3）。
- `CompletionControlParser`：结构化控制帧优先；文本兼容格式只接受最终独立末行（可容忍宽限期末尾非标识行）；正文中间/项目文件/普通输出中的同名字符串忽略；非法 JSON/schema 不符返回 none 不抛错。
- `LocalCompletionVerifier`：八项验收条件——尝试 ID 防重放、任务 ID 匹配、revision 非陈旧、声明节点可完成且无未满足前驱、无未决工作项、产物/验收门禁证据、高严谨性证据门禁（接入 EvidenceCompletionGate）、循环守卫无活锁且预算未绕过、无未解决阻塞、Provider 流正常结束；accepted 只发生一次。
- `AgentRunWatchdog`：无进展超时只触发健康探测；Provider 仍活跃 → stalled-activity-unknown（不取消不续跑）；运行中工具调用不算无进展；请求已失活 → stalled-inactive（可安全续跑）。
- `ContinuationCoordinator`：先原子保存检查点再以新 completionAttemptId 续跑（保留幂等键）；旧请求停止状态不确定 → blocked 不并发续跑；达上限 → give-up 不机械重试；尝试 ID 记录防重放。
- 确定性测试（无真实 Provider）：文本末行/伪造标识/结构化帧、验收全条件、看门狗三态、续跑上限/幂等/blocked。

## Batch 4I（T06D 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 47 文件 / 562 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.1x% / Branch 85.11% |

T06D（高严谨性事实验证工具，ADR-0016）：

- `LocalRigorPolicyEngine`：版本化规则（RIGOR_RULES_VERSION）标记法律/医疗/财务/安全边界/破坏性操作/发布/身份权限/时效性/用户严格要求为 high；模型只能上调不能下调（下调拒绝）。
- `EvidenceBundleBuilder`：按 claim 合并 source > local-experiment > reasoning 固定层级排序；矛盾/不可用关系显式保留并生成局限提示；输出只含 supported/contradicted/mixed/insufficient/unavailable，无 qualified/safe/pass 判定；schema 校验（EVIDENCE_BUNDLE_SCHEMA_VERSION）。
- `EvidenceCompletionGate`：高严谨性任务未调用 factVerification、主张不一致、无覆盖或 unavailable → 未满足；仅纯推理（缺来源正文）不得宣称完成；门禁通过只说明验证流程已执行。
- `EvidenceSearchAgentPort` + `EvidenceQueryGuard`：结构化查询（不开放任意 URL）；规范化查询指纹（等价查询一致）+ 结果缓存 + 每主张调用预算（换词活锁阻断）；查询敏感内容检查（凭据/私钥/连接串拒绝上传，不上传工作区正文/.env/提示词）。
- `factVerification` 受控工具：search-sources（无资料 → unavailable，仅标题/摘要不算完整依据）/ record-local-experiment / record-reasoning（标记 insufficient）/ build-evidence-bundle。
- 必测行为：高严谨性任务缺证据拒绝完成、普通任务不强制、Agent 自述不能冒充独立依据、离线/失败形成 unavailable 不虚报、查询泄密反例被本地阻断、指纹缓存与预算防换词。

## Batch 4H（T07B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 46 文件 / 539 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.44% / Branch 85.12% |

T07B（反自指读取与通用活锁守卫，ADR-0017）：

- `ReadSuppressionLedger`：键 = agentInstanceId + taskExecutionId + 规范资源身份 + operationKind + normalizedRange + 参数哈希；单调时钟（可注入 fake clock），默认窗口 30_000ms；保存文件身份（dev:ino + realpath）与内容指纹（sha256）；窗口内同源重复读取未变化内容 → `resource-already-read`（新错误码）+ 读取回执 + firstReadAt + retryAfterMilliseconds；文件真实变化或窗口过期可重读。
- `CanonicalResourceIdentityResolver`：realpath + 符号链接/联接 + 硬链接（dev:ino）+ 平台大小写折叠；账本键基于规范身份派生，相对/绝对别名、大小写变体、无关参数噪声不能改变键。
- 敏感内容禁读优先于时间锁（敏感文件先拒绝且不登记）。
- `LocalProgressAndCycleGuard`：调用图检测直接自环/资源环 A→B→A（报告完整循环链）、深度/图节点数/扇出上限、连续无进展计数（默认 3 次暂停路径，有进展重置）、single-flight 在途调用合并、任务总调用预算持久化（重启不清零，通过注入的读写器）。
- builtins 接入：readFile 读前抑制查询 + 读后登记；未装配账本时行为不变。
- 确定性测试：fake clock、路径别名/大小写、文件变化重读、不同 Agent/任务隔离、敏感优先、环链、无进展暂停、single-flight、预算跨重启、拒绝不返回正文。

## Batch 4G（T06C 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 45 文件 / 524 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.75% / Branch 85.23% |

T06C（全模式本地敏感内容禁读，ADR-0018）：

- `SensitiveContentAccessPolicy`：全模式（Ponder/Assist/Devolve）读通道执行前统一拒绝 `.env`/`.env.*` 及大小写变体、`.npmrc`/`.pypirc`/`.netrc`/`.git-credentials`、云/K8s 凭据、私钥/证书容器（id_rsa、*.key/*.pem/*.p12/*.pfx）、能力令牌与管理员扩展路径/模式；稳定拒绝码 `sensitive-content-read-denied`（新错误码），错误只含规则类别不泄露秘密值。
- `SensitiveResourceIdentityResolver`：规范路径 + realpath + 符号链接/联接（isLinkLike）+ 硬链接身份（dev:ino）+ 平台大小写折叠识别同一敏感资源；`isSameResource` 同一性判定。
- 本地可信 DLP 扫描器：名称正常但内容疑似凭据（api key/AWS AKIA/私钥块/ghp 与 glpat token/连接串，支持 JSON 引号包裹）→ 丢弃整个结果，不返回正文或命中片段；有界扫描（256KB）。
- 接入所有读通道：readFile（读前路径 + 读后内容双检）、listDirectory（过滤敏感条目）、searchProjectText（敏感文件名跳过）、gitReadonlyView（输出 DLP，防御视图扩展）、backupVault read（备份 pre-image 内容 DLP，防 .env 备份旁路）。
- 反例覆盖：大小写变体/相对路径、符号链接与硬链接伪装、DLP 命中、目录过滤不泄露名称、错误不含秘密字节、普通配置不误杀、管理员扩展、Devolve/授权不能放行（策略在权限之前）。
- 已知限制（ADR-0018 文档语义）：内容不含任何凭据模式的凭据库文件经硬链接读取无法由 DLP 识别；名称规则 + DLP 双检覆盖 ADR 必测清单。

## Batch 4F（T06B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 44 文件 / 510 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.70% / Branch 85.23% / Funcs 89.x% |

T06B（Ponder 本地只读边界与敏感操作分类，ADR-0014）：

- `LocalSensitiveOperationClassifier`：版本化确定性分类规则（`OPERATION_CLASSIFICATION_RULES_VERSION`），按工具名静态映射 + mutationKind + 名称模式分类文件/Git 变更、进程、网络、发布、凭据、备份与系统操作；纯本地执行，不发起云端分类；大小写不敏感。
- `LocalToolPolicyEngine`：Ponder 白名单（readFile/listDirectory/searchProjectText/taskSequenceStatus/gitReadonlyView）双时点 fail-closed 校验——白名单 + 只读分类 + 声明一致（category/backupPolicy/mutationKind 伪造拒绝）+ 参数安全；敏感路径排除（.env/凭据/密钥/.git 凭证，兼容 Windows 反斜杠）；本地拒绝事件（工具 ID、规则版本、原因，不记录文件秘密）。
- 新只读工具：`searchProjectText`（工作区递归检索，有界 500 文件/100 结果/512KB，跳过敏感与二进制文件）与 `gitReadonlyView`（固定视图 status/diff/log，参数由引擎构造，模型不可注入 git 参数，无 shell）。
- `PermissionPolicy`/`PermissionDecider` 接入：Ponder 分支由本地引擎异步判定；每次裁决实时读取当前模式（降级后立即复检）；Ponder 下不查询会话授权（旧授权不沿用）；未装配引擎时 Ponder 一律 deny（与旧版一致）。
- 反例覆盖：写工具/进程/网络/凭据/备份拒绝、伪造 readonly 声明、路径穿越/绝对逃逸/受保护区/敏感文件名、git 非法视图、未知工具与不可解析参数、降级复检、断网一致性（纯本地规则）。

## Batch 5（T08）检查点记录

### 2026-08-13 — T05B→T08 编排接入增补通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 43 文件 / 495 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 93.04% / Branch 85.70% / Funcs 89.67% |

T05B→T08 接入（AR-04 身份一致性及次级 Git 集成复验项）：

- `MissionOrchestrator` 新增 `gitIntegration` 装配：首次调度前自动 `startIntegrationSession`（固定基线 + 集成分支）；写入型任务（taskType 在 allowedPathsByTaskType）自动分配隔离 worker 分支/worktree，Worker 工具端口指向 worktree。
- Worker 成功后编排层在 worktree 提交（身份已绑定）→ 证据命令实际执行上报真实退出码 → `submitContribution` 审查；审查拒绝/提交异常 → 任务 blocked + escalation（禁止 unhandled rejection）。无改动视为无贡献直接放行。
- Mission 完成时 `finalizeIntegration`：集成测试失败记录 unresolvedRisks 不合并；`isTargetBranchMergeAllowed` 门禁由装配方注入（Assist 需用户授权），通过才合入目标分支；审查结果写入次级 Agent 工作存档（decision 条目 + headCommit 引用）。
- `MainController`/`AssistScheduler`/`DevolveScheduler` 透传 `gitIntegration` 与 `secondaryAgentInstanceIdFactory`（每次 mission 不可复用实例 ID）。
- 实测发现并修复：
  - git ref 名不接受 `:`/`~` → `encodeGitRefSegment`/`decodeGitRefSegment`（合法段原样 + `seg-<hex>` 编码，单射可逆）。
  - 恢复点备份 ref 全名在 Windows 超路径限制（"Filename too long"）→ 备份 ref 改简短名 `refs/astarray-recovery/<mission>/<id>/b<i>`，referenceBackups 增加 `backupReferenceName` 字段。
  - 越界修改必须整体提交后由审查 allowedPaths 拦截（仅暂存允许路径会让越界内容绕过审查）。
- 集成测试（真实 git）：worktree 提交→审查→合并→门禁合入目标分支；越界修改被拒绝（任务 blocked、未合并、escalation）；未装配时行为与旧版一致；分配失败 escalation 且不启动 Worker。

遗留：T05C 序列接入 Assist 调度器（待办偏序集与任务包派发）与 TUI/CLI 状态适配器留待后续批次。

## Batch 5（T08）检查点记录

### 2026-08-12 — 通过（连续 3 次 `npm run check` 全绿）

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` ×3 | 0 | typecheck/lint/build/test 全绿，284 测试，无 unhandled |
| `npm run test:coverage` | 0 | Stmts 94.55% / Branch 87.45% / Funcs 93.37% |

关键验收点与证据：

- 主 Agent 派发后立即回输入循环：`handleUserMessage` 返回后后台 mission 运行（main-controller 测试）。
- 两个任务并发 + 第三个等待依赖：串行/并发行为断言。
- 连续失败阈值后 failed + 人工 retry 成功：retry 流程。
- permission-ask → 任务 blocked → 用户授权 + unblock → 成功。
- ambiguous → blocked + 升级用户。
- 非阻塞通信：Worker 挂起时仍可创建第二个任务与查询。
- 显式 cancel 中断（AbortSignal）+ cancel 等待在途 Worker 收敛。
- Devolve：无权限询问、子集边界仍生效、直接裁决方法。
- 修复记录：ToolLoop 透传 errorCode（permission-ask 判定）；task blocked 等待人工裁决（不自动重跑）；cancel 收敛语义；summary 写入互斥。

本批产出：`packages/core/src/orchestration/{mission-orchestrator,worker-agent,assist-scheduler,devolve-scheduler,main-controller,mission-manager}.ts` + ADR-0011（permission-ask 消息类型）+ 编排/主控制器/mission 管理测试。

遗留风险：真实 LLM 的任务分解（v0.1 用确定性分解，见 main-controller.decomposePromptForScriptedRun 注释）。

## Batch 4（T05–T07）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 19 文件 / 247 测试通过 |
| `npm run test:coverage` | 0 | Stmts 94.29% / Branch 86.41% / Funcs 92.98%（门槛生效，低于 85% 会失败） |
| `npm run check` | 0 | 全绿 |

关键验收点与证据：

- T05：环/缺失依赖/重复 ID 检测；并发上限（2/4 验证）；严格串行依赖；领取锁（同一任务不可双领）；失败传播 → 下游 blocked；retry/reassign/cancel/unblock；每轮调度后 revision 单调递增持久化；失败计数器（阈值 3、成功清零、分工具计数）。
- T06：主 Agent 仅预览（无 schema）；子集按任务类型；Worker 子集外调用 deny；旧基线为 Ponder 全 deny，已被新增 T06B/ADR-0014 的本地只读白名单设计替代；Assist readonly allow / restricted ask（会话授权后 allow，参数哈希变更失效）/forbidden deny；Devolve 注册工具 allow 但路径逃逸拒绝；审计事件；token 估算；shell/删除/安装/发布/付款默认未注册。
- T07：ScriptedRuntime 确定性脚本（含中途取消）；OpenAICompatibleRuntime 流式解析/工具调用累积/finish_reason 分支/超时与取消；API key 不进入错误消息；ToolLoop 工具执行回填、最大迭代保护、取消传播、事件透传。

遗留风险：跨进程 mission 锁与更多安全加固在 T12；OpenAI runtime 的 SSE 实现为整文本解析（生产可换流式，语义不变）。

## Batch 3（T04）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 14 文件 / 177 测试通过 |
| `npm run test:coverage` | 0 | Stmts 94.31% / Branch 85.32% / Funcs 93.79%（门槛 85% 已启用） |
| `npm run build` | 0 | dist/cli.js + dist/feedback-process-entry.js |
| `npm run check` | 0 | 全绿 |

关键验收点与证据：

- 反馈进程 PID ≠ 主进程：集成测试断言（`tests/core/integration/feedback-process.test.ts`）。
- 杀死反馈进程后 supervisor 重启并重放未确认消息：SIGKILL 集成测试 + 重放 ≥1。
- Agent busy 时普通消息不进入其上下文：busy 时 0 投递，转 idle 后投递。
- 同优先级 FIFO、高优先级越过：mailbox-journal 单测（instruction > failure > success；ack 前重放优先）。
- 质数退避 2,3,5,7,11 → 10800 封顶 + 新消息重置：虚拟时钟单测，全程无真实 sleep。
- 投递后 ack 前崩溃可幂等重投：journal 持久化 + 重开重放测试；客户端按 idempotencyKey 去重。

本批产出文件：`packages/core/src/feedback-process/{prime-backoff,ipc-protocol,mailbox-journal,delivery-worker,transport,process-supervisor,entrypoint}.ts` + 单测 4 组 + 真实 fork 集成测试 + `tests/core/fixtures/never-exit.mjs`。

遗留风险：跨进程 mission 锁留待 T12；`npm run test` 单独运行（未 build）时集成测试自动跳过（`describe.skipIf`）。

## Batch 2（T02–T03）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 7 文件 / 113 测试通过 |
| `npm run test:coverage` | 0 | Stmts 97.75% / Branch 90.56% / Funcs 95.12% |
| `npm run build` | 0 | 构建成功 |
| `npm run check` | 0 | 全绿 |

本批产出文件：

- `packages/core/src/core/mode-machine.ts`（迁移规则表 + 非法迁移抛错）
- `packages/core/src/core/permission-policy.ts`（PermissionPolicy 矩阵、SessionAuthorizationManager TTL/参数哈希、PermissionDecider 实时模式裁决）
- `packages/core/src/infra/redaction.ts`（Authorization/API key/JSON 凭据脱敏）
- `packages/core/src/infra/async-mutex.ts`、`packages/core/src/infra/atomic-json.ts`、`packages/core/src/infra/task-store.ts`（临时文件+flush+原子替换+备份恢复+revision 单调+mission 锁）
- 测试：mode-machine / permission-policy / redaction / task-store（113 例，含 8 写者×5 迭代并发更新不丢 revision、Windows 覆盖替换、崩溃恢复）

检查项：命名审查通过；git diff 无敏感信息；错误码新增 invalid-mode-transition / stale-revision / path-escape-attempt。

遗留风险：跨进程 mission 锁（多 CLI 实例写同一 mission）留待 T12；质数退避与反馈协议在 T04。

## Batch 1（T00–T01）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 3 文件 / 32 测试通过 |
| `npm run test:coverage` | 0 | Statements/Branches/Functions/Lines 均 100% |
| `npm run build` | 0 | dist/cli.js 2.96 KB |
| `node dist/cli.js --version` | 0 | 输出 `0.1.0` |
| `node dist/cli.js --help` | 0 | 输出全部子命令 |

检查项：

- git diff 审查：无敏感信息；仅 Batch 1 相关文件。
- 命名审查（§3.2 模式搜索）：无违规变量/函数/时间量（仅领域字符串值与标准 Node 全局命中）。
- shebang：`packages/tui/src/cli.tsx` 首行为 `#!/usr/bin/env node`，构建产物保留。

本批产出文件：

- 工程骨架：`package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`、`eslint.config.mjs`、`.gitignore`、`AGENTS.md`、`README.md`（占位）、`LICENSE`
- 契约：`packages/core/src/core/types.ts`、`packages/core/src/core/events.ts`、`packages/core/src/core/schemas.ts`、`packages/core/src/core/errors.ts`
- CLI 骨架：`packages/tui/src/cli.tsx`（run/resume/status/cancel/config/doctor 为占位 stub，报错退出码 1；真实实现见 T11）
- 测试：`tests/core/unit/schemas.test.ts`、`tests/core/unit/frozen-decisions.test.ts`、`tests/core/unit/errors.test.ts`
- 文档：`docs/architecture.md`、`docs/adr/0001`–`0006`
- 状态：`PLAN_STATUS.md`

已知风险/遗留：

- CLI 子命令为 stub，`--json` 输出约定（stdout 仅结果）尚未实施（T11）。
- 覆盖率门槛 85% 已在 vitest 配置生效；95% 专项门槛（状态机/权限/DAG/反馈协议等）在相关任务完成后追加。
- `cli.tsx` 已从覆盖率统计中排除（入口文件，无领域逻辑）。
