# Batch 6 高风险功能返修任务卡

> 状态：待执行  
> 编制日期：2026-08-15  
> 适用提交：`8eb52e4`、`b0f8866`、`f8c378b`、`ba2242e`  
> 对应任务：T06E、T06F、T06G、T08A  
> 对应整改项：AR-06F、AR-06G、AR-06H、AR-06I  
> 执行主体：OpenCode、受控次级 Agent 与受控三级 Agent

## 1. 返修目标与验收基线

本任务卡只处理 2026-08-15 对 Batch 6A–6D 的复验问题。不得顺带实现 T08B，也不得把“单元测试通过”当作“产品运行路径已经接入”。

返修前动态基线：

| 项目 | 结果 |
|---|---|
| 四批目标测试 | 4 个文件、70 项测试通过 |
| `npm run check` | 52 个文件、654 项测试通过 |
| 覆盖率 | Statements 92.72%、Branches 85.36%、Functions 89.59%、Lines 92.89% |
| tarball 隔离安装 | Windows 本地安装、隔离全局安装、CLI、shim、反馈进程入口通过 |
| 运行路径接入 | 除 `PermissionCapabilityCatalog` 外，本批新增控制器未进入最终 `dist` |
| 跨平台证据 | 无 Linux/macOS CI 证据 |

返修完成必须同时满足：

- T06E、T06F、T06G、T08A 的核心控制器进入真实 CLI/TUI/编排执行路径和 npm tarball。
- 安全判定来自本地可信状态，不能由模型或工具调用参数声明当前模式、用户答案、权限 revision 或 Agent 身份。
- 本批新增的覆盖、替换、删减和删除都在变更前经过工具自身的受控自动备份层。
- 每个高风险主题关键分支覆盖率不低于 95%。
- Windows、Linux、macOS 目标测试有可追溯证据；无法运行的平台不得宣称通过。
- `npm run check`、`npm run test:coverage` 和 tarball 隔离安装全部通过。
- `PLAN_STATUS.md` 的状态与动态证据一致。

## 2. 统一执行协议

### 2.1 任务粒度

- 一次只执行一张 `B6R-*` 任务卡。
- 每张卡最多修改 8 个生产代码文件；测试与文档文件不计入该上限。
- 每张卡最长执行 3 小时。预计超时必须在构建可通过且安全边界闭合的位置停止，并创建后继卡，不得把半成品标为完成。
- 等待参数 `pn` 硬上限为 3 小时；普通轮询使用 10–60 秒并持续输出进度。
- 每张高风险卡使用独立分支或 worktree，并形成一个原子提交。不得把两张卡压入同一提交。
- 当前卡未通过时，不得领取后继卡，也不得开始 T08B。

### 2.2 Agent 与 Git 职责

- 主 Agent 只与用户沟通、评估并提出任务插入，不直接执行 Git 写入。
- 次级 Agent 是唯一 Git 集成者，负责建立隔离分支/worktree、检查三级 Agent 提交、运行门禁并受控合并。
- 三级 Agent 一次激活只处理当前卡中分配的一条任务链，只提交到自己的隔离分支，不得合并、变基、推送、删除分支或领取链外任务。
- 每个具体 Agent 使用独立 `agentInstanceId` 和独立工作存档。不得在同级之间共享上下文、缓存或存档。
- 上级只可选择性附加明确列出的存档条目；附件必须带来源、revision 和哈希，不得默认复制完整历史。

### 2.3 编码与安全要求

- 先写能够复现问题的失败测试，再修改生产代码。
- 变量、函数和类型使用含义完整的英文名称；禁止 `tmp`、`ctx`、`mgr`、`req`、`res`、`cfg`、`rev` 等无语义缩写。
- 布尔变量以 `is`、`has`、`can` 或 `should` 开头；时间量名称必须包含单位。
- 核心领域代码禁止 `any`，不得使用 `skip`、`only`、降低断言或覆盖率排除来隐藏失败。
- 开始前先询问用户是否已有当前任务所需的可用依赖、运行时或工具。没有明确需要时禁止执行安装；确需安装时遵守精确内容、独立开关和逐次授权门禁。
- 任何删除、文字删减、替换、截断或覆盖必须由执行工具在变更前自动备份，模型不得手工创建备份代替工具门禁。
- 每次完成必须返回有效 `ASTARRAY_TASK_COMPLETION_V1`，且本地状态、测试、验收门禁和未决调用均确认结束。

## 3. 任务偏序与领取顺序

所有任务均来源于本次用户指令，`sourceKind=user`，默认 `priorityTier=0`。同层按下表稳定顺序执行。

| 顺序 | 任务卡 | 前驱 | 后继 | 风险 |
|---:|---|---|---|---|
| 1 | B6R-00 基线冻结与状态纠偏 | 无 | B6R-01 | 中 |
| 2 | B6R-01 T06E 分类器与两阶段门禁闭环 | B6R-00 | B6R-02 | 高 |
| 3 | B6R-02 T06E 真实执行路径与界面接入 | B6R-01 | B6R-03 | 高 |
| 4 | B6R-03 T06F 权限引擎执行前接入 | B6R-02 | B6R-04 | 高 |
| 5 | B6R-04 T06F TUI/CLI 权限组控制面 | B6R-03 | B6R-05 | 高 |
| 6 | B6R-05 T06G 临时提升有效性与权限求交 | B6R-04 | B6R-06 | 高 |
| 7 | B6R-06 T06G 主只读、次级控制面和关闭导出接入 | B6R-05 | B6R-07 | 高 |
| 8 | B6R-07 T08A 个体记忆与报告存储安全 | B6R-06 | B6R-08 | 高 |
| 9 | B6R-08 T08A 持续调度与可恢复生命周期 | B6R-07 | B6R-09 | 高 |
| 10 | B6R-09 T08A 完整编排与反馈进程接入 | B6R-08 | B6R-10 | 高 |
| 11 | B6R-10 覆盖率、跨平台和 tarball 终验 | B6R-09 | T08B | 中 |

## 4. 返修任务卡

## B6R-00：基线冻结与状态纠偏

**目标**：保存返修前可追溯证据，防止将已经存在的问题误认为返修回归。

**允许修改**：`PLAN_STATUS.md`、返修证据文档；禁止修改生产代码。

**任务链**：

1. 完整读取 `AGENTS.md`、架构文档、实施计划、状态文档、整改任务书和本任务卡。
2. 记录 Git HEAD、工作区未提交文件、Node/npm/操作系统版本。
3. 运行四批目标测试、`npm run check`、`npm run test:coverage` 和 tarball 隔离安装。
4. 扫描最终 `dist`，记录各新增控制器是否可达。
5. 将 T06E、T06F、T06G、T08A 明确标记为返修中；不得保留容易被理解为最终通过的结论。

**完成条件**：命令、退出码、测试数量、覆盖率、tarball 路径和失败摘要完整；没有修改生产代码；原有用户工作区改动保持不变。

## B6R-01：T06E 分类器与两阶段门禁闭环

**目标**：修复安装别名绕过、询问步骤未绑定、关闭开关后仍可授权以及授权跨 Agent/任务转用问题。

**主要文件**：

- `packages/core/src/tools/installation-operation-classifier.ts`
- `packages/core/src/tools/assist-installation-gate.ts`
- `packages/core/src/core/schemas.ts`
- `packages/core/src/core/types.ts`
- `tests/core/unit/assist-installation-gate.test.ts`

**任务链**：

1. 为未知非空命令、可执行文件绝对路径、大小写、包装 shell、多命令脚本、别名和间接脚本增加失败反例。无法确定副作用时必须 fail-closed，不得返回 `not-installation`。
2. 建立本地 `ExistingResourceInquiryReceipt` 状态，绑定认证用户、具体 `agentInstanceId`、任务、能力、候选资源、回答和 revision。
3. 只有用户明确回答“没有可用资源”的有效回执才能创建安装授权请求；已有资源验证失败后仍回到用户决定，不能自动安装。
4. `authorizeAllowOnce` 和执行前复检都从可信设置存储读取开关和 revision；开关关闭立即拒绝，调用方不得传入自称的当前模式或 revision。
5. 授权哈希绑定用户裁决、Agent、任务、询问回执、来源、包/仓库、精确版本/commit、完整性、目标、作用域、工具、参数、网络、脚本和预计变更。
6. 增加两个 Agent、两个任务、开关关闭后重新授权、修改 Agent/任务字段、重放和并发消费反例。

**完成条件**：所有分类和授权绕过反例先红后绿；开关与询问步骤都不能绕过；同一 nonce 只被原 Agent/任务的原计划消费一次；核心关键分支覆盖率 ≥95%；`npm run check` 通过。

**禁止事项**：本卡不修改 TUI/CLI，不执行真实安装，不把未知命令全部注册为安装工具后交给模型判断。

## B6R-02：T06E 真实执行路径与界面接入

**目标**：让 npm 安装后的 Assist 模式真实使用两阶段门禁，而不是只有孤立控制器和单元测试。

**主要文件**：CLI/TUI bootstrap、运行命令、状态模型、权限包装器及对应 TUI 集成测试；生产文件超过 8 个时拆卡。

**任务链**：

1. 在可信本地 bootstrap 中实例化分类器、询问控制器、设置存储和逐次授权控制器。
2. 所有进程、代码库取得、依赖解析和安装类工具在实际执行前先经过分类及 T06E 门禁。
3. TUI 提供独立安装开关、已有资源回答、只读验证差异、精确安装计划和“仅允许本次/拒绝”交互。
4. Headless 无可信交互通道时稳定 fail-closed；`--yes`、环境变量和模型文字不得放行。
5. 等待用户时释放任务领取锁、文件锁和包管理器锁，其他 ready 任务可继续。
6. 构建 tarball 并证明相关控制器存在于最终 bundle；从安装后的 CLI 动态触发默认关闭、询问、拒绝和允许一次路径。

**完成条件**：源码入口和 tarball 入口行为一致；TUI/Headless 集成测试覆盖门禁全链；独立反馈进程携带具体来源；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-03：T06F 权限引擎执行前接入

**目标**：用版本化权限 profile 替代运行路径中的旧三模式 `PermissionDecider`，并保证每次工具执行前重新裁决。

**主要文件**：权限目录、profile 存储、可配置策略引擎、工具注册表、策略包装器、bootstrap 和对应核心测试。

**任务链**：

1. 先增加集成失败测试，证明当前旧 `PermissionDecider` 会忽略自定义 profile 和 profile revision。
2. 在 bootstrap 和工具实际执行边界接入 `ConfigurablePermissionPolicyEngine`；派发预检不能替代执行前检查。
3. 多权限工具取最严格决定；未映射工具在注册和执行阶段均 fail-closed。
4. profile ID、revision、目录版本、工具映射和调用参数变化使旧 ask 授权、缓存与未执行调用失效。
5. T06F 的 `allow` 不能绕过 T06E 安装专用门禁、敏感禁读、自动备份和其他本地强制策略。
6. 证明内置和自定义 profile 的持久化更新并发安全，不因损坏恢复成更宽配置。

**完成条件**：最终 `dist` 包含并实际调用可配置权限引擎；运行期修改单项权限立即影响下一次执行；未知工具和陈旧授权拒绝；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-04：T06F TUI/CLI 权限组控制面

**目标**：提供认证用户可操作的权限组设置入口，同时不把设置控制器暴露成 Agent 工具。

**任务链**：

1. TUI/CLI 共用认证设置控制器，实现选择、创建、命名、复制、重命名、逐项三态、重置、导入、导出和删除。
2. Devolve 默认全部公开项为 `allow`；Assist 使用独立矩阵；Ponder 不进入编辑页。
3. 自定义 profile 数量不设产品硬上限，使用分页或虚拟列表处理大集合。
4. 删除、导入、重置和覆盖在工具层自动备份；删除当前 profile 必须先安全切换。
5. 帮助、导出、普通错误和模型 schema 只包含允许公开的配置内容。
6. 增加 80×24、120×40、60×20、Unicode 长名称、搜索、分页和 Headless JSON 契约测试。

**完成条件**：安装 tarball 后可完成完整权限组生命周期；重启后 ID/revision 保持；Agent 无法调用设置控制器；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-05：T06G 临时提升有效性与权限求交

**目标**：让会话 revision、资源范围、期限和 Agent 身份真正参与权限有效性判断。

**主要文件**：`session-permission-elevation.ts`、权限配置导出器和对应属性/fake-clock/并发测试。

**任务链**：

1. 为当前遗漏增加失败测试：会话 revision 变化、资源范围不匹配、Agent 回收、profile 切换、目录升级和到期后旧提升必须失效。
2. resolver 输入来自可信会话控制面，必须包含当前 session permission revision、规范化资源身份和具体次级 `agentInstanceId`。
3. 会话级和个体级提升分别计算；多个覆盖不能通过取更宽并集绕过基础限制。
4. 三级权限对 capability、三态、资源范围、工具、任务类型和期限逐项求交，属性测试证明 `tertiary <= secondary`。
5. 导出配置使用与运行时相同的有效性解析，不得选中已经过期或 revision 失效记录，也不得泄露会话授权能力。

**完成条件**：记录中不存在只存不查的安全字段；失效条件均有动态反例；资源范围求交和 session revision 失效通过属性/并发/fake-clock 测试；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-06：T06G 主只读、次级控制面和关闭导出接入

**目标**：把主 Agent 永久只读、次级 Agent 可信创建、临时提升和关闭清理接入真实会话生命周期。

**任务链**：

1. bootstrap 只向主 Agent 投影只读工具；任意内置/自定义 profile 或临时提升都不能扩大主 Agent 工具表。
2. 创建次级 Agent 由本地会话控制面执行，不作为主 Agent 模型工具；生成不可复用具体身份并绑定当前权限快照。
3. TUI/CLI 可查看、申请、允许、拒绝和撤销会话级或具体次级 Agent 提升，不提供“提升主 Agent”。
4. 会话关闭顺序为停止派发、收敛在途调用、可选导出、无条件撤销提升、关闭；导出失败不能保留权限。
5. 所有导出覆盖通过受控备份服务，不以普通相邻 `.bak` 代替受控备份入口。
6. 从安装后的 tarball 验证主只读、次级提升、三级上限和关闭导出/撤销。

**完成条件**：主 Agent 工具投影在全部模式下保持只读；次级/三级权限范围正确；关闭成功、跳过、失败和崩溃恢复都不残留提升；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-07：T08A 个体记忆与报告存储安全

**目标**：修复观察 ID 重复、并发丢写、伪造报告来源和覆盖不备份问题。

**主要文件**：

- `packages/core/src/orchestration/agent-individual-memory.ts`
- `packages/core/src/orchestration/main-agent-report-archive.ts`
- `packages/core/src/orchestration/cross-agent-attachment-controller.ts`
- 受控原子存储/备份适配器
- 对应单元、并发和安全反例测试

**任务链**：

1. 修正 observation ID 生成优先级错误，使用不可复用 ID；增加同一 Agent 连续追加和并发追加测试。
2. 记忆和报告写入使用 revision、进程内互斥、原子写入和受控自动备份，拒绝陈旧 revision 和丢失更新。
3. 报告来源必须由认证反馈通道注入并与 Agent 注册表、所属次级、mission 和任务包匹配；非空字符串不是认证。
4. 同一 report ID 的幂等重放必须验证内容哈希一致；不同内容不得覆盖既有报告。
5. 记忆、附件和报告读取保持 Agent 个体隔离；符号链接、路径编码和 owner 不一致均在返回内容前拒绝。
6. 任何备份数据或物理路径不得进入 Agent 上下文。

**完成条件**：连续/并发追加无重复 ID、无丢写；伪造来源与冲突重放拒绝；覆盖前受控备份有动态证据；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-08：T08A 持续调度与可恢复生命周期

**目标**：实现缺失的 `SecondaryContinuousDispatchLoop`，并把三级 Agent 收口改为阶段持久化、可恢复、幂等状态机。

**主要文件**：新增持续调度模块、`tertiary-lifecycle.ts`、调度/生命周期状态存储和对应属性/并发/崩溃测试。

**任务链**：

1. 实现 `SecondaryContinuousDispatchLoop`：任务、反馈、权限、资源或 Git 基线变化时重新计算 ready set，按偏序、priority tier、稳定同级顺序和并发准入派发。
2. 并发限制只导致排队、暂停或受控回收，不得形成 Agent 历史数量配额。
3. 生命周期状态持久化当前阶段、阶段结果、检查点、handoff 和未确认调用；重启后从第一个未完成阶段继续。
4. 再次调用 `shutdown` 不得重置为第一阶段或重复已确认副作用；每阶段使用幂等键并验证上次结果。
5. 收口顺序严格覆盖停止派发、未确认调用、检查点、handoff、反馈、权限、mailbox、Git 资源和进程终止。
6. 增加每个阶段前后崩溃、hook 失败重试、重复关闭、上下文超限换新个体和未确认非幂等调用测试。

**完成条件**：持续调度真实工作且稳定可重放；生命周期任一阶段崩溃可恢复、不重复副作用、无孤儿进程；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-09：T08A 完整编排与反馈进程接入

**目标**：将任务插入、持续派发、三级复用/新建、单链守卫、生命周期和报告归档接入真实产品控制流。

**任务链**：

1. 主 Agent 提交的任务插入提案由本地控制面验证来源、目标次级、priority tier、偏序锚点和 revision；提交后立即回到用户对话。
2. 次级 Agent 使用 B6R-08 持续调度，负责三级 Agent 生命周期、Git 分流/审查/合并和允许范围内的远端控制。
3. 三级 Agent 一次激活绑定一个不可变任务链；链外领取、兄弟记忆、调度、集成分支和远端项目工具在本地执行边界拒绝。
4. 三级终态先经独立反馈进程报告次级；次级汇总后的终态报告只写主 Agent 报告索引，不唤醒或注入主 Agent 当前上下文。
5. 安装 tarball 后运行真实独立反馈子进程、多个次级/三级 Agent、后台密集报告与前台用户输入测试。
6. 扫描 bundle，确认 T08A 生产控制器全部可达；不得用测试直接 import 源文件代替产品接入证据。

**完成条件**：默认三层控制流可从 tarball 端到端运行；后台报告不阻塞主 Agent；三级越权全部拒绝；生命周期无泄漏；关键分支覆盖率 ≥95%；`npm run check` 通过。

## B6R-10：覆盖率、跨平台和 tarball 终验

**目标**：只做最终动态验收和状态收口；发现失败时退回对应前驱卡，不在本卡混入未经拆分的高风险修复。

**任务链**：

1. 运行 T06E、T06F、T06G、T08A 的全部单元、属性、并发、安全反例、真实反馈进程、TUI/Headless 集成和崩溃恢复测试。
2. 对每个关键文件分别检查分支覆盖率，不得用全仓平均值替代单模块 ≥95% 门槛。
3. 建立或运行 Windows、Linux、macOS CI 矩阵，至少覆盖 Node 20 与一个受支持的较新版本；平台缺失保持未通过。
4. 执行 `npm run check`、`npm run test:coverage`、`npm pack` 和 `node scripts/smoke-install.mjs`。
5. 从全新 tarball 安装环境验证 CLI/TUI、独立反馈进程、安装门禁、权限组、临时提升、三层编排和关闭恢复。
6. 检查 tarball 不含 `.env`、凭据、测试、日志、运行数据或临时目录。
7. 更新 `PLAN_STATUS.md`、交付报告和实际证据；只有全部通过才恢复相关任务状态并解除 T08B 阻塞。

**完成条件**：四个任务的全部门槛均有动态证据；关键模块分支覆盖率分别 ≥95%；三平台通过；tarball 隔离安装通过；文档、Git 提交和测试数字一致。

## 5. 每张卡的统一交付格式

执行 Agent 完成一张卡时必须报告：

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: B6R-XX
agentInstanceId: <具体且不可复用的 Agent 个体 ID>
sourceKind: user
priorityTier: 0
gitBranchOrWorktree: <隔离分支或 worktree>
commitId: <原子提交；未提交时写 null 并说明原因>
changedProductionFiles:
  - <文件>
changedTestFiles:
  - <文件>
executedChecks:
  - command: <命令>
    exitCode: <退出码>
coverageEvidence: <目标模块分支覆盖率>
tarballEvidence: <需要时填写 tarball 路径与隔离结果>
remainingRisks:
  - <未决风险；没有则写 none>
completionGate: passed | failed | blocked
```

缺少明确完成事件、目标测试、覆盖率证据或未决调用未收敛时，本地控制面不得把任务卡标记完成。

## 6. OpenCode 首张卡执行提示

```text
完整读取 AGENTS.md、agent-main-architecture.md、designtodo.txt、
IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、AUDIT_REMEDIATION_TASKS.md 和
docs/tasks/BATCH6_REPAIR_TASK_CARDS.md。

本轮只执行 B6R-00，不修改生产代码，不开始 B6R-01。先检查 git status，
保留用户未提交内容，复现并记录四批目标测试、npm run check、覆盖率、
bundle 可达性和 tarball 隔离安装证据。将 T06E/T06F/T06G/T08A 明确标记为
返修中。生产代码、测试断言和覆盖率配置本轮均不得修改。

完成时返回 ASTARRAY_TASK_COMPLETION_V1；没有完整动态证据时返回 failed 或
blocked，不得宣称通过。pn 等待上限为 3 小时。
```

