

## D. 用户决策（2026-11-08，第 128 轮末）：**分阶段接线授权 + 硬约束**

### D.1 阶段顺序（用户指定）

1. **G9 + 状态纠偏**；
2. **G2**（活锁与循环守卫）；
3. **G3**（高严谨性标记 + 强制证据包）；
4. **G5**（早停 → 从检查点有界续跑）；
5. **G1**（T08 Git 集成整层）。

### D.2 硬约束（用户明确要求）

- **G1 未完成前，不得宣称支持完整的多 Agent Git 集成流程。**
- 每项验收**必须经过真实应用装配入口**（不能只做模块级单测）。
- 必须增加「**拔掉接线，测试必须失败**」的反例。
- 每阶段最后做**隔离包验证**（`npm pack` + 隔离安装/verify-package）。

### D.3 开关决策（用户已定）

- `PERF`：**继续默认关闭**、按需启用。
- `DIAG`：**可考虑未来默认开启"最小错误摘要"**，但**必须先验证四项**：
  **脱敏 / 重复错误抑制 / 磁盘保留 / 故障风暴**。
- **诊断开关不得控制**必需的**权限审计、任务终态、恢复记录**。

### D.4 G4 保留

**G4（工具说明首次下发／后续回访）保留在返修清单**；不因决策表未列而视为完成。

### D.5 第 7 项核实的**结构证据**（第 129 轮）

「诊断开关不得控制必需审计/终态/恢复」已核实：`isDiagnosticCollectionEnabled` 与
`isPerformanceCollectionEnabled` 在**整个生产代码里只出现于 2 个文件**：

- `packages/core/src/application/application-runtime.ts`：L904（perf 样本存储）、
  **L961（个体级诊断端口）**、**L1023（使命级诊断端口）**；
- `packages/core/src/public-sdk.ts`：L1604／L1606（仅把门面默认值 `?? false` 透传）。

⇒ 两个开关**只 gate 采集**；**权限审计（`backup-vault` 的删除审计）、任务终态（`updateMissionStatus`）、
恢复记录（`recovery-checkpoint-recorder`）的写入路径完全没有引用它们** ✓。
# 产品接线缺口总表（2026-11-08，第 101–140 轮窗口，截至第 110 轮）

## 0. 这份表是什么 / 不是什么

- **是什么**：把本窗口通过**产品可达性勘测**（`scripts/audit-product-reachability.mjs`）
  与**逐个 ripgrep 核实**发现的"**有实现、有测试、但产品里没跑**"的能力，收敛成一张可决策清单。
- **不是什么**：**不是验收结论**，也**没有**改变任何卡的状态。每项都给出**可复跑证据**，供你或卡所有者复核。
- **共同特征**：这些能力**测试全绿**，所以常规门禁**永远发现不了**它们没接线。

### 0.1 先例（同类发现**早就存在**）—— 以及**已闭环的核实**

本表**不是**第一次发现这类问题：`docs/reports/SECURITY_WIRING_GAP_SENSITIVE_CONTENT_AND_READ_SUPPRESSION_FINDING_2026-09-21.md`
（2026-09-21）就记录过同样的模式 —— 「`SensitiveContentAccessPolicy`（T06C/ADR-0018）与 `ReadSuppressionLedger`（T07B/ADR-0017）
在 `packages/` 内**没有任何生产构造点**」，并且当时同样写着「**已核实、未修改生产行为**；修复会改变用户可见行为，需显式决定」。
**本表是那份报告的通用化**（从"两个安全策略"扩到"系统性枚举候选"）。

**✅ 第 112 轮核实：那份报告的两个项目现在都已装配**（可复跑）：

| 组件 | 生产装配链（file:line） |
| --- | --- |
| `SensitiveContentAccessPolicy` | `application-runtime.ts:371` **构造** → `:870` 传入策略包装器 → `policy-wrapper.ts:368` 注入 builtins 执行上下文 → `builtins.ts` L460/682/719/988 使用 |
| `ReadSuppressionLedger` | `application-runtime.ts:375` **构造** → `:871` 传入策略包装器 → `policy-wrapper.ts:370` 注入执行上下文 → `builtins.ts:1008/1039` 使用 |

⇒ **该类问题在本仓库是"能被修好的"**（有先例、有闭环），这也说明本表的 G1–G9 **值得按同样的方式处置**。

### 0.2 一处**历史快照**辨析（避免误读为现状）

`DELIVERY_REPORT.md`（生成 2026-08-12，含 2026-08-14 状态更正）§6.0 写着
「**新增设计尚未实现**：现有 tarball 不包含 T06B/T06C/T06D/T07A/T07B，Ponder 本地只读、全模式敏感禁读、
事实验证、反自指/活锁和早停自动续跑均不能按已交付能力使用」。

- **该文件自己已声明**：「本报告是新增设计前的**历史交付快照**，不再代表当前最终完成状态」；
- 其中 **T07B 后来已完成**（`PLAN_STATUS.md` L1556「2026-08-13 完成；待 AR 复验」、L1879 起 Batch 4H 检查点记录，
  含 `LocalProgressAndCycleGuard` 的实现说明）；
- ⇒ **不要把 §6.0 当现状**；但它对理解"这些能力当时确实没有"是有用的历史依据。
## 1. 缺口总表

> 证据列的检索命令均在仓库根执行；"命中范围"指该标识符在 `packages/` 内的出现位置。

| # | 能力 | 规则依据 | 证据（可复跑） | 用户可见后果 | 接线所需决定 |
| --- | --- | --- | --- | --- | --- |
| G1 | **T08 编排层 Git 集成**（worktree 分流 → 贡献审查 → 集成分支合并 → 门禁合入） | `AGENTS.md`：涉及 Git 写入的多 Agent 任务必须由次级负责**分支/工作树分流、差异审查、测试验证和受控合并** | `rg -n "new GitIntegrationCoordinator" packages` ⇒ **0**；`rg -n "allowedPathsByTaskType\|buildGitWorktreeToolPort" packages tests` ⇒ **仅类型定义 + 测试 harness**；装配层无 `gitIntegration`；门面不接受该选项 | 多 Agent 的 Git 隔离/审查/受控合并**不会发生**；三级可自由合并的风险面无人管 | 构造 coordinator/allocator/report store/recovery point；`allowedPathsByTaskType` **策略**；`isTargetBranchMergeAllowed`（**谁可自动合并**）；assist/devolve 差异；独立开关 |
| G2 | **活锁与循环守卫**（`LocalProgressAndCycleGuard`：自环 `A→A`、资源环 `A→B→A`、回派祖先环、跨 Agent 乒乓、single-flight、无进展计数、深度/节点/**扇出上限**、**任务总调用预算（持久化）**） | `AGENTS.md`：**循环调用、无进展重试和 Agent 互相回派必须有本地检测与有界中止** | `rg -n "local-progress-and-cycle-guard\|LocalProgressAndCycleGuard" packages` ⇒ **仅 2 处、都在它自己文件**；测试内构造 **12 次**；其特征机制（扇出/总预算/无进展）在生产别处**无等价实现** | 循环/回派/扇出/预算这几类**没有本地检测与有界中止**（生产只有 watchdog 的"模型无进展→健康探测"与读取抑制账本） | 强制层（工具循环？策略包装器？编排器？）；"有界中止"语义（拒绝？暂停？上报？）；阈值是否沿用 `3/12/64/16/200`；总预算持久化位置 |
| G3 | **高严谨性任务的"标记 + 强制证据包"** | `AGENTS.md`：**高严谨性任务由本地规则标记，并强制调用事实验证工具形成证据包** | `rg -n "rigorLevel" packages` ⇒ 仅 schema 与 `local-rigor-policy-engine.ts`（**零使用**）⇒ **无产生方/消费方**；`rg -n "requiredClaimIdentifier" packages` ⇒ 仅 `evidence-completion-gate.ts` 与**同样零使用**的 `completion-verifier.ts`；已接通的是**工具与构建器本身** | **没有任何任务会被标记为高严谨** ⇒ 证据包**从不被强制**（模型可以调用 `factVerification`，但没东西要求它） | 标记规则集（哪些任务算高严谨）；强制点（结案门禁？）；与 `EvidenceCompletionGate` 接线方式；确认不影响 standard 任务 |
| G4 | **工具说明回执**（首次给完整公开用法 / 同 revision 后续只给固定提醒） | `AGENTS.md`：**第一次**接收某工具组时获得**完整公开用法**；同一工具组 revision 后续**只注入固定 `ASTARRAY_TOOL_HELP_REQUEST_V1` 提醒** | `rg -n "首次接收\|完整公开用法\|工具组 revision\|工具说明回执" packages` ⇒ 仅 3 处、都在 `tool-help-recall-controller.ts` 与 `tool-documentation-recall.ts`（**两者零使用**） | 生产**没有**首次/回访区分（工具描述符是**统一**给的）；规则要求的行为缺失 | 回执存储位置（按 `agentInstanceId` 隔离）；注入点（提示词装配）；revision 来源；`ASTARRAY_TOOL_HELP_REQUEST_V1` 的上报路由 |
| G5 | **早停 → 从检查点有界续跑** | `AGENTS.md` L54：输出提前结束、缺失完成事件或标识不符时，由本地看门狗**从检查点有界续跑**，禁止无限重试或重复副作用 | `rg -n "ContinuationCoordinator\|AgentRunWatchdog" packages` ⇒ **只在 `agent-run-watchdog.ts` 自身**；`rg -n "longToolCheckpointController"`（全仓）⇒ **4 处**（import／类型字段／构造／放进返回包），**无消费者**；另有一份报告声称它"暴露"（暴露 ≠ 被消费） | 早停只导致"**拒绝结案**"；**编排层没有任务级重试机制**（`rg -n "requeue\|reschedule\|retryTask\|retryCount" packages/core/src/orchestration` ⇒ **0 命中**）⇒ 任务**既不从检查点续跑、也不重试**，只能停在拒绝结案等上级/用户处理 ⇒ 与规则要求的"有界续跑"**不符** | 执行层落点；**幂等键与检查点如何绑定**；续跑上限配置；与 DAG `failureThreshold` 重试的关系（谁优先、是否互斥） |
| G6 | **沟通句柄转交**（直属上级把低一级 Agent 的不透明句柄转交同级） | `AGENTS.md`：直属上级经授权后，**可**把…转交 —— **许可式**，非强制 | `rg -n "AgentCommunicationDelegation\|DelegatedAgentCommunicationGrant\|replyRoute" packages` ⇒ 仅 `agent-communication-delegation.ts` 自身 | 该**能力缺失**（非违规） | 是否要做（你的决定）；grant 存储与失效条件；是否只经独立反馈进程；不可再转授的强制点 |
| G7 | **Azure OpenAI / Amazon Bedrock 原生协议适配器** | 无 `AGENTS.md` 强制条款（`IMPLEMENTATION_PLAN` 列为协议矩阵之一） | `rg -n "AzureOpenAiAdapter\|BedrockConverseAdapter" packages` ⇒ **仅各自文件**（未注册、**未从门面导出**）；生产只注册 `openai-compatible` 与 `anthropic-messages`（`packages/tui/src/cli/runtime-selection.ts` 二选一） | 用户**无法**用这两种原生协议 | ⚠️ **本项是既定延后项**（早已记录在 `PRODUCT_PATH_ACCEPTANCE_DUAL_VENDOR_2026-10-02.md` L104–105、`T07D_R2_01_PROVIDER_BASELINE.md` L13）；接它还要定凭据形态（Entra token / SigV4 端口） |
| G8 | **使命级诊断端口**（本窗口第 105 轮新增 `MissionOrchestratorOptions.missionDiagnosticEventPort`） | `AGENTS.md` 无直接条款；属 `DIAG-01` 观测范围 | 已实现且有反例（先红后绿）；**但装配层未接线**，且因 **G1** 之故 `git` 阶段在生产**不会发生** | 目前**无生产效果**（不写成"诊断已覆盖 Git 失败"） | 是否继续接（需先定 G1） |
| G9 | **能力就绪汇报恒真**（CLI `componentsReady` 的 **4 个字段**） | 无 `AGENTS.md` 直接条款；属"给用户/诊断的保证"的**正确性**问题 | `packages/tui/src/cli/commands.ts`：**L2544–2546**（`assignmentController`／`fallbackGuard`）与 **L2961–2963**（`worktreeObserver`／`staleWriteGuard`）都是**直接 `await import(...)` 后判 `X !== null`** —— 导入成功**必然非 null** ⇒ **恒真**；人类可读输出**永远打印「已装配」**（L2560–2561 一带）；**对照（不夸大）**：同文件 **L2310–2317** 的 `actionExecutor`／`workflowLifecycleController` 来自 `loadCraftsmanInfra()`（**可返回 null**）⇒ **那两处是有意义的** | 用户与诊断会看到「**已装配**」，但对应组件实际**未被装配/使用**（见 G1–G7 同类证据）⇒ **假保证** | 二选一：**(a) 真正接线**（则检查须改为验"**实际装配**"而不是"模块可加载"）；**(b) 把人类可读文案改为如实的「模块可加载」**，并（可选）在 JSON 里新增"是否实际装配"的**独立字段**（不动既有 JSON 键）。**两者都改动用户可见输出 ⇒ 需你决定**（我本轮未改） |

## 2. 与之相关的**文档漂移**（同一批核实发现）

| 文档 | 漂移 |
| --- | --- |
| `IMPLEMENTATION_PLAN.md` L1059–1060、`docs/architecture.md` L138、`docs/adr/0015-…md` L46、`PLAN_STATUS.md` L1855–1856、`docs/reports/GUIDE01_04_PRODUCT_ENTRY.md` L13 | 把 **G5**（看门狗从检查点有界续跑）写成**已交付行为**，且**无"未接线"标注** |
| `docs/reports/PRODUCT_PATH_ACCEPTANCE_DUAL_VENDOR_2026-10-02.md` L104–105、`T07D_R2_01_PROVIDER_BASELINE.md` L13 | 说「CLI 的 `run` **只**注册 `openai-compatible`」—— 对 **Anthropic 已过期**（现已接通），对其余三个仍成立 ⇒ 见状态补丁 `STATUS_UPDATE_T07D_PROVIDER_PROTOCOL_WIRING_DRIFT_2026-11-08.md` |

**处置纪律（我坚持的）**：这些是**他人的产出**，我**没有直接改写**；
除 `GUIDE01_04`／`DUAL_VENDOR` 已按仓库规则出**独立状态补丁**外，其余建议由**对应卡所有者**决定
"接线"还是"标注现状"。**本轮未改任何产品行为。**

## 3. 还有多少没核实（**别把这张表当全集**）

- 勘测脚本给出 **38 个候选**（口径：生产构造 0 + 按**模块路径**统计的生产提及 0 + 测试里构造 ≥1 + 能力型命名）；
- 本表覆盖其中 **8 项**（G1–G8）；**其余候选尚未逐个核实**；
- 已知的**假阳性来源**（脚本头部已写明）：生产**子类化**（如 `AssistScheduler extends MissionOrchestrator`）、
  **工厂/间接构造**、**公开门面导出**（属"可达但需宿主提供"，与"完全不可达"不同）；
- **分诊顺序**（先排假阳性，再看是否真缺口）：① 按模块路径 ripgrep 生产引用 → ② 生产子类 →
  ③ 门面是否导出 → ④ **生产里是否有等价内联实现** → ⑤ 才算真不可达，最后对照 `AGENTS.md` 判"缺口 / 死码"。

## 4. 建议的决策路径

1. **先决定 G2、G3、G5**（三者都有 `AGENTS.md` 强制条款，且**都是本地可做**的；
   我建议的顺序是 **G3 → G2 → G5**：G3 影响面最窄、最容易先落地并验证）；
2. **G1 单独决策**（它是**最大的一片**，且涉及"谁能自动合并"这一授权面，不宜与其它项捆绑）；
3. **G4／G6 视产品意图**（G4 是强制条款但影响面在提示词层；G6 是许可式能力）；
4. **G7 维持已记录的延后状态**（需要凭据形态设计）；
5. **每个缺口都已备好"先写行为反例再实现"的入口**：G1→`orchestrator-git-integration.test.ts`（已有 harness）、
   G2→`tests/core/unit/` 直接构造守卫、G3→`completion-gate-counterexamples.test.ts` 与 `factVerification` 链路、
   G5→`long-tool-checkpoint.test.ts`（已有控制器级用例）。

> **⚠️ 自我订正（第 110 轮）**：本文档第 109 轮的初稿把 `failureThreshold` 写成"DAG 任务级有界重试"，
> 实测它是 **`ToolFailureCounter`（工具连续失败计数，达阈值 ⇒ 暂停并反馈）**，且编排层**没有任务级重试机制**
> （`requeue|reschedule|retryTask|retryCount` 在 `packages/core/src/orchestration` **零命中**）。
> 该订正**加强**了 G5 的结论：早停时任务**既不续跑也不重试**，只能停在拒绝结案。

## 5. 阶段一（G9 + 状态纠偏）执行记录

### 5.1 G9（已完成，第 129 轮）：状态汇报改为如实

**改动**：`packages/tui/src/cli/commands.ts` 两处恒真的 `componentsReady`（4 个字段）
改为如实的 `modulesLoadable`（`typeof … === "function"`，**只表示模块可加载**），
并在 JSON 里新增 `componentsReadySemantics: "module-loadable-not-assembly"` 显式标注；
人类可读输出不再出现「已装配」这一未经核实的断言。

**验收（`tests/tui/unit/g9-status-report-honesty.test.ts`，4 条）**：
两个命令的 JSON 与人类输出都必须如实。**「拔掉接线」验证**：把该文件临时还原（`git checkout --`）后
**4/4 全部失败**；恢复补丁后 **4/4 通过** ✓。

**⚠️ 口径如实说明（并由此发现 G10）**：这两个子命令在 **CLI 的 argv 分发里没有调用点**
（全仓只有测试直接调用其导出函数）⇒ 它们**不可从 CLI 到达**。
因此本项的"入口"是**产品代码里的命令函数本身**，**不是** argv 层 —— 我**不**把它写成"真实 CLI 入口已验收"。

### 5.2 **G10（第 129 轮新发现）**：两个 CLI 子命令**声明了但没有分发**

| 命令 | 声明位置 | argv 分发 |
| --- | --- | --- |
| `preset list` | `commands.ts` `executePresetListCommand` | **无调用点** |
| `concurrent status` | `commands.ts` `executeConcurrentStatusCommand` | **无调用点** |

**核实方式**：在 `packages/tui/src` 内检索这两个函数名与 `"preset"`／`"concurrent"` 子命令串
⇒ **只有定义处与注释命中，没有分发**。

**影响**：这两个状态视图**用户无法从 CLI 调用**（G9 的假保证因此也**到不了用户** —— 这降低了 G9 的危害，
但 G10 本身是缺口）。**处置**：记入本表，**待用户决定**接不接（属"命令接线"，不在当前 G9–G1 五阶段内）。

### 5.3 阶段一的**隔离包验证**（已完成）

按用户要求「每阶段最后做隔离包验证」，本轮（第 129 轮）实测：

| 步骤 | 结果 |
| --- | --- |
| `npm pack --pack-destination .tmp`（`prepack` 会再跑一次 `check`） | **exit 0** —— `prepack` 门禁 **444 文件 / 3307 用例**；tarball `.tmp/astarray-0.1.0.tgz`，**273 文件 / 1.6 MB** |
| `node scripts/verify-package.mjs .tmp/astarray-0.1.0.tgz` | **exit 0** —— 「打包校验通过: 273 个文件，shebang/BOM 正确，反馈进程入口已包含」（无 `.env`／密钥／日志） |
| `node scripts/verify-sdk-consumer.mjs .tmp/astarray-0.1.0.tgz` | **exit 0** —— 「added 41 packages in 6s」后在**临时目录隔离安装**并跑消费者场景，输出 `finalStatus: done` ⇒ 「SDK 消费者行为验证通过」 |

⇒ **阶段一（G9 + 状态纠偏）按用户标准收尾完成**：真实（命令函数级）入口验收 + 「拔掉接线 4/4 失败」+ 隔离包验证三项齐备。
**下一阶段 = G2（活锁与循环守卫）**，其验收同样须满足这三项。
