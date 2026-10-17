

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

### 5.4 G2（阶段二，已完成）：活锁/循环守卫接线 + **有界中止**真正生效

**规则依据**：`AGENTS.md`「**循环调用、无进展重试和 Agent 互相回派必须有本地检测与有界中止**」。

**接线**：`LocalProgressAndCycleGuard`（T07B/ADR-0017）经端口接入工具循环（`before`/`after` 双相位），
并沿 worker → 编排器 → 控制器 → 装配层 → 门面透传；门面开关 `isProgressGuardEnabled`，**缺省 false**。

**第 130 轮实测定位的两个真缺陷（本轮修好）**：

1. **中止无效**：违反发生在**内层**工具调用循环，`break` 只跳出内层 ⇒ 外层 `while` 继续请求模型。
   修：`isProgressGuardAborted` 标志 + **迭代尾 `break` 外层 `while`**。
2. **签名恒变**：签名含 `errorMessage` 自由文本，而 `resource-already-read` 的错误文本带
   **倒计时字段**（`remainingWaitMilliseconds`）⇒ 签名每次都不同 ⇒ `isNewProgress` 恒真 ⇒
   **无进展永不累计**、守卫形同虚设。修：错误只用 `errorCode`（与 `DiagnosticEvent` 同一口径）、
   成功用内容哈希。**该 bug 已固化为永久变异体**。

| 验收项 | 证据 |
| --- | --- |
| **真实应用装配入口** | 新增 `tests/core/integration/g2-progress-guard.test.ts`（2 条），经 `AstarrayApplicationFacade` 驱动真实 `submitTask/queryTask` 与假 Provider |
| **拔掉接线 ⇒ 测试必须失败** | `git checkout 8be42cc -- <6 文件>` 回退后该用例**失败**（`expected 20 to be less than or equal to 8`）；`git checkout HEAD -- <6 文件>` 恢复后**通过**（**全程不经补丁文件**，避免第 130 轮那次损坏补丁的失误） |
| **隔离包验证** | `npm pack`（prepack 门禁 **3309 用例**）⇒ 273 文件 / 1.6 MB；`verify-package` **exit 0**（「打包校验通过: 273 个文件，shebang/BOM 正确，反馈进程入口已包含」）；`verify-sdk-consumer` **exit 0** |
| **永久变异体** | `progress-guard-signature-includes-volatile-text`（58/58 被拦下） |

**⚠️ 边界（如实）**：守卫**缺省关**；是否默认启用属**用户决策**，我不擅自改默认。
**任务总调用预算的持久化**（`readTaskBudget`/`writeTaskBudget`）目前用默认实现（进程内）⇒
「进程重启不清零」这一半**尚未接线**，属 G2 的**剩余项**，不得视为已完成。

### 5.5 G3a（阶段三第一半，**⚠️ 未完成**）：**本地规则标记 + 强制调用事实验证工具**

**规则依据**：`AGENTS.md`「高严谨性任务由**本地规则标记**，并**强制调用事实验证工具形成证据包**」。

**接线**（开关 `isHighRigorEnforcementEnabled`，**缺省 false**）：

- 编排器用 `LocalRigorPolicyEngine.classifyRigor(task.description)`（**本地版本化规则**：法律/医疗/财务/
  安全边界/破坏性操作/发布决策/身份权限/时效性事实/用户要求严格 ⇒ high）判定；
- 高严谨 ⇒ 在该任务的 worker 选项里用**对象字面量后者胜**覆盖 `requiredMutatingToolNames`，追加
  `factVerification` ⇒ **完成前必须成功调用过它**（复用既有的"完成前必须调用"机制，未新造机制）；
- 开关经 控制器 → 装配层 → 门面 透传（`?? false`）。

| 验收项 | 证据 |
| --- | --- |
| **真实应用装配入口** | `tests/core/integration/g3-high-rigor-evidence.test.ts`（3 条），经 `AstarrayApplicationFacade` 驱动 |
| **拔掉接线 ⇒ 必须失败** | `git checkout d69d514 -- <4 文件>` 后第 1 条**失败**（`expected 'done' not to be 'done'`）、2/3 仍绿；`git checkout HEAD -- <4 文件>` 后 **3/3 通过** |
| **隔离包验证** | `npm pack` ⇒ 273 文件 / 1.6 MB；`verify-package` **exit 0**；`verify-sdk-consumer` **exit 0**（消费者 `finalStatus: done`） |
| **永久变异体** | `high-rigor-marking-never-matches`（59/59 被拦下） |
| **门禁** | `check` **0 —— 446 文件 / 3312 用例**；`verify:mutation-kills` **0 —— 59/59** |

**⚠️ 调试中发现（已写进测试注释）**：内部任务标识恒为 `T-001`，完成事件必须声明它，否则被
**既有完成门禁**判为「完成事件未声明本任务」⇒ blocked —— 这是门禁在正常工作，不是缺陷。

### 5.6 **G3b（阶段三第二半，未开始）**：证据包**内容**门禁

`EvidenceCompletionGate.evaluateEvidenceBundle(bundle, { requiredClaimIdentifier, requireSourceText })`
能校验：证据包缺失 / 主张标识不一致 / 条目为空 / 关系为 `unavailable` / 缺可定位资料正文。
**但它在生产里仍是零使用** ⇒ 现在只强制"**调用过**事实工具"，**没有**校验"证据包**内容是否合格**。

**⇒ G3 未完成**（只有第一半）。G3b 需要：在完成路径上取得该任务的 `EvidenceBundle`（由 `factVerification`
返回）并交给该门禁；同时定义"关键主张标识"的来源（用户/任务信封/计划）。**待做，不宣称完成。**
**❗ 2026-11-08（第 142 轮）更正：本项此前被记成"已完成"，是**错的**。**

**实际状态**：接线与三条**负向**反例都在 `main`（**缺省关** ⇒ 生产行为不变），
但**正向路径（调用事实工具后应当允许结案）至今未能演示**，且我三次接法各有缺陷：

1. 第 132 轮：把 `factVerification` 塞进 `requiredMutatingToolNames` —— 该集合只在
   `MUTATING_TOOL_NAMES` 命中时登记（`mutationKind: "none"` 的工具永远进不去）⇒ **过度拦截**；
2. 第 138 轮：把判定改用"所有成功工具"集合 —— 但**第二条**检查（"变更类 + **跨运行**"契约）
   仍然把 `factVerification` 当成"此前因权限询问被打断的写类工具"⇒ 仍被拦；
3. 第 139–141 轮：试图引入**独立** `requiredToolNames` 通道，连续三次因锚点/写入顺序/语法失败，
   **均已回退**（`typecheck` 恢复为 0）。

**⇒ 正确接法已明确（独立 `requiredToolNames` + `successfullyExecutedRequiredTools`），但尚未落地。**
**⇒ 本项不得再写作"完成"；正向反例草稿在 `.tmp/g3a-positive-path.test.ts.draft`（未入库）。**

## 6. 本窗口（第 101–142 轮）阶段总账

### 6.1 用户授权与阶段顺序

用户在**第 128 轮末**给出分阶段授权：**G9 与状态纠偏 → G2 → G3 → G5 → G1**，并附加四项硬约束
（真实装配入口验收 / 拔线必失败 / 隔离包验证 / G1 未完成不得宣称完整 Git 集成）。
第 130 轮末把轮次上限由 140 提到 **170**。

### 6.2 已完成（有证据）

| 阶段 | 内容 | 证据 |
| --- | --- | --- |
| 一（G9 + 状态纠偏） | 两处**恒真**的 `componentsReady` 改为如实的 `modulesLoadable` + `componentsReadySemantics` | 4 条验收；**拔线 4/4 失败**；隔离包（273 文件/1.6 MB、两个 verify 均 exit 0） |
| 二（G2） | `LocalProgressAndCycleGuard` 接入工具循环（before/after 双相位、**有界中止**）；开关缺省关 | 2 条反例（守卫开≈440 ms 中止 / 对照跑满）；**拔线必失败**；隔离包；变异 59/59 |
| 二附带 | 修掉两个真缺陷：内层 `break` 不跳外层 `while`；签名含**倒计时文本**导致无进展永不累计 | 同上（已固化变异体） |
| 同轮发现 | **G10**：`preset list`／`concurrent status` **未接入 argv 分发** | 全仓检索无调用点 |
| 阶段一收尾 | `PERF`/`DIAG` 决策落表；**诊断开关不控制必需审计/终态/恢复**的结构核实 | 两个开关只出现于 2 个文件、仅 gate 采集 |
| 变异集 | **28 → 59**（全部被拦下），并修复 1 条永不匹配的 find | `verify:mutation-kills` exit 0 |

### 6.3 **未完成（如实）**

- **G3a**：见 §5.5 的更正 —— 接线在但**正向未证**，**不得算完成**；
- **G3b**：`EvidenceCompletionGate` 仍**零使用**（证据包内容门禁），且 `evidenceBundleBuilder`／
  `evidenceSearchAgent` 在生产里**未装配** ⇒ 连"合格证据包"都造不出来；
- **G5**（早停 → 从检查点有界续跑）：**未开始**；
- **G1**（T08 Git 集成整层）：**未开始**；**在完成前不得宣称支持完整多 Agent Git 集成**；
- **G4**（工具说明首次下发/回访）：**仍在返修清单**（用户明确要求不得因决策表未列而视为完成）；
- **G10**：是否把两个状态命令接入 argv，**待用户决定**。

### 6.4 我在本窗口犯的错（逐条留档）

1. **事实性错误**：第 133 轮把 G3a 记成"完成"，实际正向路径不可演示（本轮更正）；
2. **接法错误 3 次**：把非变更工具塞进变更类必需集 → 改用"所有成功工具"仍被跨运行契约误伤 →
   独立通道三次落地失败（锚点/写入顺序/语法），均已回退；
3. **操作事故 1 次**（第 130 轮）：用 `git diff > 补丁` + `git checkout` + `git apply` 做"拔线"证明，
   PowerShell 写出 BOM/CRLF 使补丁损坏 ⇒ **丢失未提交修改**；此后改为**先提交、再用 `git checkout <旧提交> -- <文件>`**；
4. **纪律重复违反**：多行锚点在 CRLF 源文件上永不匹配（第 133 轮已写入纪律，第 137 轮又犯）；
5. **测试设计缺口**：只写负向反例（"不调 X ⇒ 不得 done"）无法区分"正确门禁"与"一律拦"，
   导致第 132 轮的过度拦截**藏了两轮**。

### 6.5 教训（可复用）

- **"强制调用 X"必须有正向反例**（调了 X ⇒ 必须放行），否则不可验证；
- **跨文件多行锚点在 Windows 不可靠**（行尾差异）⇒ 用唯一单行；
- **关联改动不要一次脚本改多处**：一处一改、一次一验、一次一提交；
- **"拔线证明"必须先提交**，用提交回退而不是补丁文件。

## 7. G5（早停 → 从检查点有界续跑）：可行性评估与接线计划（第 143 轮）

**规则依据**：`AGENTS.md`「输出提前结束、缺失完成事件或标识与本地状态不符时，由本地看门狗**从检查点有界续跑**，
禁止无限重试或重复副作用」。

### 7.1 组件现状（本轮实读源码）

| 组件 | 位置 | 能力 |
| --- | --- | --- |
| `RecoveryCheckpointRecorder` | `orchestration/recovery-checkpoint-recorder.ts`（292 行） | `recordToolCallState`／`getToolCallStates`：记录工具调用恢复态 |
| `RecoveryCheckpointStore` | `orchestration/recovery-checkpoint-store.ts`（208 行） | `writeCheckpoint`／`selectLatestTrustedCheckpoint`：写入与**按信任选择最新**检查点 |
| 恢复检查点 schema | `orchestration/recovery-checkpoint-schemas.ts`（184 行） | `ToolCallRecoveryState`／`RecoveryDecisionType`／`RecoveryCheckpoint` |
| `LongToolCheckpoint`（看门狗决策侧） | `runtime-guidance/long-tool-checkpoint.ts`（433 行） | `WatchdogResumeDecision`／`CompletionDeclarationOutcome` |

**缺口（与 G2/G3 同型）**：这些**能力都在**，但「早停 ⇒ 从检查点**有界**续跑」的**执行路径不存在**
（`LongToolCheckpoint` 的决策侧**无消费者**；续跑执行器**从未被构造**）；而**5 份文档**写成"已交付" ⇒
文档漂移需一并更正。

### 7.2 拟接线方案（缺省关）

1. **检测**：工具循环里「已产出文本但**缺 `ASTARRAY_TASK_COMPLETION_V1`**」且 run 结束 ⇒ 判为**早停**
   （现成判据：`CompletionDeclarationOutcome`）；
2. **取检查点**：`RecoveryCheckpointStore.selectLatestTrustedCheckpoint()` ⇒ 若无可信检查点 ⇒ **不续跑**（直接按失败收口）；
3. **有界续跑**：用一个**独立计数器**（每 `agentInstanceId` + 任务）限定 **≤ N 次**（建议 N=2，硬上限），
   超限即收口为失败并给出原因（**不得无限重试**）；
4. **不重复副作用**：续跑前用既有 `idempotencyKey` 账目复核已完成步骤，续跑只从**未完成**处开始；
5. **开关** `isCheckpointResumeEnabled`（**缺省 false**），经 控制器 → 装配层 → 门面 透传。

### 7.3 反例设计（**先红后绿**，三条缺一不可）

| # | 场景 | 期望 | 为什么必须有 |
| --- | --- | --- | --- |
| 1 | 假 Provider **先给一次无完成事件的截断输出**，随后正常完成 | 任务**最终 done**，且**续跑次数 = 1**（可观测） | **正向**：证明"续跑真的发生了" |
| 2 | 假 Provider **每次都截断**（永不发完成事件） | 任务**最终失败**，续跑次数 **≤ N**（有界） | 证明**不无限重试** |
| 3 | 续跑场景下重复执行同一写操作 | **副作用只发生一次**（幂等） | 证明**不重复副作用** |

### 7.4 前置风险（如实）

- **副作用幂等**依赖既有 idempotency 账目是否覆盖该工具（需先核实）；
- **续跑语义**会与既有「`tool-failure-threshold`／`max-iterations`」收口路径交互（需保证不互相掩盖）；
- 因此本项**必须**先写 §7.3 的三条反例，再接线；**不得**先接线后补测。

**状态：G5 = 未开始（本轮仅完成评估与计划，未接线、未宣称完成）。**

## 8. G1（T08 Git 集成整层）：可行性评估与验收条件（第 144 轮）

> ❗ 用户硬约束：**G1 未完成前，不得宣称支持完整的多 Agent Git 集成流程。**
> 本节的结论就是：**该约束当前成立**（整层在产品路径上不可达）。

### 8.1 组件现状（本轮实读）

11 个相关文件，核心四件：

| 组件 | 行数 | 能力 |
| --- | --- | --- |
| `GitIntegrationCoordinator` | 395 | `StartIntegrationSessionInput`（开集成会话）／`SubmitContributionInput`（收贡献）／`FinalizeIntegrationInput`（收口） |
| `GitContributionVerifier` | 219 | `verifyContribution`（提交哈希/测试/验收核对） |
| `GitIntegrationReportStore` | 87 | 集成报告落库 |
| `ConcurrentMergeCoordinator` | 193 | `evaluateControlledMerge`（受控合并评估；`concurrent status` 命令**已构造**它 ✓） |
| 另有 | — | `GitWorktreeAllocator`／`HumanWorktreeObserver`／`GitRecoveryPointService`／`GitProcess`／`PermissionAskSafePreview`／`InstructionMergeEligibility` |

### 8.2 缺口（第 104 轮已勘测，本轮复核）

1. **没有任何生产装配点构造 `GitIntegrationCoordinator`**（全仓无 `new GitIntegrationCoordinator`）；
2. **门面明确拒绝 `gitIntegration`**（`public-sdk` 的装配选项校验里被拒）；
3. 因此「次级 Agent 负责 分支/工作树分流 → 差异审查 → 测试验证 → 受控合并」**这条链在生产不可达**；
4. `HumanWorktreeObserver`／`StaleWriteGuard` 只在 `concurrent status` 里被 **import 用于"模块可加载"汇报**（G9 已改为如实表述）。

**⇒ 现状 = 「能力存在、路径不通」；按用户约束，任何文档/汇报都不得说"支持完整多 Agent Git 集成"。**

### 8.3 拟接线方案（分三步，每步都要真实验收入口）

**Step 1（最小可验）**：装配层构造 `GitIntegrationCoordinator` + `GitContributionVerifier` + `GitIntegrationReportStore`，
门面新增 `gitIntegration?: { integrationBranchName }` 选项（**缺省 undefined ⇒ 不启用**），
并提供「开集成会话 / 提交贡献 / 收口」三个门面方法。验收：假仓库（临时目录 `git init`）里跑完整三步，
断言分支/工作树/报告落库；**拔掉装配 ⇒ 门面方法必须不可用或抛错**（拔线必失败）。

**Step 2（多 Agent 分流）**：把 `GitWorktreeAllocator` 接进 worker 分派：每个 `agentInstanceId` 一个隔离 worktree，
三级 Agent **只能**提交到自己的分支（不得合并/变基/推送）。验收：两个并行 agent 各写一个文件 ⇒ 各自分支、
主分支不受影响；**违规操作必须被拒**。

**Step 3（合并门禁）**：`ConcurrentMergeCoordinator.evaluateControlledMerge` + `GitContributionVerifier`，
只有「提交哈希 + 测试 + 验收 + 人工体验 + 操作授权」全满足才 `merge-ready`。验收：缺任一项 ⇒ **拒绝合并**。

### 8.4 前置与风险（如实）

- **真实 `git` 可用性**：本机 `git` 版本/配置会影响测试；需在测试里**自建临时仓库**而非依赖外部；
- **人工体验结论**属**用户/平台**提供项（`merge-ready` 的另一半），我**不能**代为宣布；
- **「自动合并」授权面**：Step 3 涉及"谁能自动合并"，**属用户决策**，不得由我默认开启；
- 因此 Step 1 可以先做（缺省关、可验、可在隔离包里验证），**Step 3 必须等用户明确授权**。

**状态：G1 = 未开始（本轮仅完成评估与验收条件，未接线、未宣称支持完整 Git 集成）。**

## 9. 待验证反例库（下个窗口开工即用）

以下反例**已写好但未入库**（纪律：仍红或尚不可判别的反例不得留在 `main`），暂存 `.tmp/*.draft`。
价值在于：**下个窗口第一步就能跑**，不必重新推导。

### 9.1 `g3a-positive-path.test.ts.draft` —— G3a 的**正向**反例（最关键）

**场景**：高严谨 prompt + 开关开 + 假 Provider 先调 `factVerification(record-reasoning)`（会成功）
再发完成事件 ⇒ **断言 `done`**。

**当前表现**：**失败**。诊断已确认拦截理由是
「必需操作未成功执行：**本任务此前因权限询问被打断、且以下写类工具至今从未成功（factVerification）**」
⇒ 即 `requiredMutatingToolNames` 的**跨运行契约**误伤了非变更工具。

**用途**：它必须**转绿**，才说明 G3a 的强制"可满足"而不是"一律拦"。

### 9.2 `g3b1-evidence-bundle-required.test.ts.draft` —— G3b-1 负向反例（**尚不可判别**）

**场景**：高严谨 + 开关开 + 只 `record-reasoning`（**成功**、但**无证据包**）后宣布完成 ⇒ 断言**不得 `done`**。

**当前表现**：**通过**，但**原因是 G3a 的缺陷**（任务本来就被拦），**不是**内容门禁 ⇒ **不可判别**。

**用途**：只有 §9.1 转绿之后，它才成为真正检验内容门禁的反例。

### 9.3 `.tmp/g2-progress-guard.test.ts.pending` —— 历史副本，可删

G2 的正式反例已入库为 `tests/core/integration/g2-progress-guard.test.ts`（2 条、绿）。

### 9.4 下一步（唯一正确的顺序 + 纪律）

1. 加 worker `requiredToolNames` 选项；
2. 加 worker 的独立检查块；
3. 把编排器 G3a 块改成 `requiredToolNames: ["factVerification"]`；
4. 跑 §9.1（应绿）→ 再跑 §9.2（此时"调用了但没有证据包"才是唯一原因）；
5. 再做 G3b 的内容门禁（`EvidenceCompletionGate`）—— 那时 §9.2 才有判别力。

**纪律**：第 1–3 步**每步单独提交、单独跑 `typecheck`**，不要一次改三处
（第 139–141 轮三次失败的教训）。

### 9.5 本窗口终局核对（第 145 轮实测）

- `npm run check`：**exit 0 —— 446 文件 / 3312 用例**；
- `npm run verify:mutation-kills`：**exit 0 —— 59/59 被拦下**。

## 10. 卡片一致性扫描（第 149 轮）：候选复核清单

**方法**：扫 `docs/tasks/*.md` 全部 **42** 张卡，找出「**含完成字样**」**且**「命中已知未接线领域关键词」的交集。
命中关键词的领域：**G1 Git 集成**（Git 集成/受控合并/工作树分流/worktree）、**G4 工具说明回访**、
**G5 检查点续跑**、**G3 证据包/高严谨性**、**G10 CLI 分发**（`concurrent status`/`preset list`）。

> ⚠️ **这份清单是"候选"，不是"违规"**：关键词命中只说明该卡**提到**相关能力，
> 是否真的过度声称，**必须逐卡读上下文**才能判定 —— 我**没有**据此批量打补丁（那会制造错误结论）。

### 10.1 已注明边界（无需处理，4 张）

| 卡 | 领域 | 依据 |
| --- | --- | --- |
| `OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS.md` | G3 证据包 | 卡内已写明边界 |
| `T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD.md` | G1 Git 集成 | 见 `STATUS_UPDATE_T05D_GIT_INTEGRATION_REACHABILITY_2026-11-08.md` |
| `T08C_T07C_AGENT_ROUTING_AND_MODEL_POLICY_TASK_CARDS.md` | G1 Git 集成 | 卡内 L9 已注明"不代表厂商协议已接入产品路径" |
| `TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` | G4 工具说明回访 | 卡内已注明"04/06 大部分完成"与缺口 |

### 10.2 待逐卡复核（7 张，**未改任何卡**）

| 卡 | 命中领域 | 复核要点 |
| --- | --- | --- |
| `GUI_MVP_CODING_TASK_CARD.md` | G4 工具说明回访 | 是否声称"工具说明首次下发/回访"已完成 |
| `LESSON01_MODEL_ALIGNED_COMMUNICATION_MEMORY_TASK_CARD.md` | G1 Git 集成 | 是否把 Git 集成算作已交付 |
| `PROJECT01_ISOLATION_AND_CROSS_PROJECT_BORROWING_TASK_CARD.md` | G1 Git 集成 | worktree 相关能力是否与"不可达"冲突 |
| `T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md` | G1 Git 集成 | 同上 |
| `T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md` | G3 证据包 | 是否声称证据包已强制 |
| `T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD.md` | G1 Git 集成 | 恢复/协调是否与 G5（未接）冲突 |
| `T12_SECURITY_HARDENING_TASK_CARD.md` | G1 Git 集成 | 安全硬化是否包含未接线的合并门禁 |

### 10.3 结论（如实）

- **已确认的不一致只有 1 处**（T05D），且**已用独立状态补丁处理**（按 `AGENTS.md`，未改他人文件）；
- 其余 6 张是**关键词候选**，需逐卡读上下文；**在复核完成前，不得据本清单宣称这些卡"过度声称"**；
- 本轮**未修改任何任务卡**。
### 10.4 逐卡复核结论（第 150 轮）：**7 张全部误报**

逐卡看了**状态行 + 关键词上下文**，结论：**没有一张过度声称**。

| 卡 | 真实状态 | 判定 |
| --- | --- | --- |
| `GUI_MVP_CODING_TASK_CARD.md` | **待执行**（由 GUI-01-R 接管） | ✓ 非完成，且 L176 明确"不实现 T08B 尚未完成的工具说明回访" => **反而印证 G4 未完成** |
| `LESSON01_...` | **pending**（仅布置任务） | ✓ 非完成 |
| `PROJECT01_...` | **in_progress** + 写明"实际资源读取/导入 I/O 尚需接线" | ✓ 已注明 |
| `T07D_PROVIDER_RUNTIME_...` | `done`，但**自带范围纠偏**："历史 done 仅覆盖模块/适配器与 SDK 可导入级证据；T07D-06/07/08 产品接线未满足" | ✓ 已注明 |
| `T07D_R2_...` | `done`；关键词命中处是 **git 基线说明**（`1f7f3b1`/`b8d5c93`），非 Git 集成声明 | ✓ 误报 |
| `T12A_SESSION_RECOVERY_...` | `done`，但**自带范围纠偏**："历史 done 仅覆盖模块级；`recover` 未在 CLI 注册且 `list/resume` 为桩" | ✓ 已注明 |
| `T12_SECURITY_HARDENING_...` | `done`；关键词命中处是"不得遗留孤儿 worktree"的清理要求 | ✓ 误报 |

**⇒ 本项（扫卡与 PLAN_STATUS 一致性）结论**：

- 全仓**唯一确认的不一致是 T05D**，已用独立状态补丁处理（第 148 轮）；
- 其余 42 张卡中，涉及未接线领域的卡**要么未完成、要么自带范围纠偏**；
- **本轮未修改任何任务卡**（避免把关键词误判写成结论）。

## 11. 窗口末段最终证据（第 153–154 轮实测）

在 `ef5640f`（含接线清单测试）之上实测：

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量门禁 | `npm run check` | **exit 0 —— 447 文件 / 3315 用例** |
| 变异验证 | `npm run verify:mutation-kills` | **exit 0 —— 59/59 被拦下** |
| 打包 | `npm pack --pack-destination .tmp`（prepack 再跑一次 check） | **exit 0** —— 273 文件 / 1.6 MB |
| 包内容校验 | `node scripts/verify-package.mjs` | **exit 0** —— 「打包校验通过: 273 个文件，shebang/BOM 正确，反馈进程入口已包含」 |
| 隔离消费者验证 | `node scripts/verify-sdk-consumer.mjs` | **exit 0** —— 「SDK 消费者行为验证通过」（`acceptedStatus: accepted`、`idempotentMissionMatched: true`、`finalStatus: done`） |

**⇒ 本窗口可交付的部分（阶段一、阶段二、接线清单、一致性收口）全部有上述证据支撑；
未完成的部分（G3a 正向、G3b、G5、G1、G4、G10）在 §5.5／§5.6／§7／§8／§9 与 `PLAN_STATUS` 中如实标注。**
