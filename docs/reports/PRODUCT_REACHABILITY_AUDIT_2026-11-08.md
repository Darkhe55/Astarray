# 产品可达性勘测：候选清单与一处**已验证**缺口（2026-11-08，第 106 轮）

- **由来**：本会话接连抓到三处**同类**缺口（`PERF` 采集、`DIAG` 采集、**T08 编排层 Git 集成整层**）
  —— 都是"**有实现、有测试，但产品里没有入口**"。故做一次**机械枚举**，把"人工猜"换成"候选 + 分诊"。
- **工具**：`scripts/audit-product-reachability.mjs`（可复跑：`node scripts/audit-product-reachability.mjs`）。
- **本文档性质**：**候选清单 + 一处已验证缺口**；其余候选**尚未逐个核实**，不得当结论使用。

## 0. ⚠️ 这个勘测的口径与三条已知局限（先读这段）

脚本判"不可达"的口径是：**生产构造点 0 + 生产提及 0 + 测试里构造 ≥1 + 名字属能力型后缀**。
**它只是启发式，必须逐个人工抽查**。本轮我自己就踩了三次口径错误（都记在 §3），修正后仍存局限：

| 局限 | 后果 |
| --- | --- |
| **子类化**（生产 `class Y extends X` 且 `new Y(`） | X 被判"无构造" ⇒ **假阳性** |
| **工厂/间接构造**（`X.create()`／`Object.create(X.prototype)`） | 搜不到 `new X(` ⇒ 可能假阳性 |
| **公开导出**（被 `public-sdk` 提及） | 该能力**可由宿主注入** ⇒ 属"可达但需宿主提供"，与"完全不可达"**不同**（脚本已单列该列） |

## 1. 候选清单（29 个，按"生产提及"升序）

**生产提及 = 0（最可疑，8 个）**：

| 类 | 定义文件 | 测试构造 | 门面提及 |
| --- | --- | --- | --- |
| `AgentCommunicationDelegationController` | `orchestration/agent-communication-delegation.ts` | 1 | 否 |
| `ContinuationCoordinator` | `orchestration/agent-run-watchdog.ts` | 4 | 否 |
| `DelegatedAgentCommunicationGrantStore` | `orchestration/agent-communication-delegation.ts` | 1 | 否 |
| `FaultInjectionRecoveryVerifier` | `orchestration/fault-injection-recovery-verifier.ts` | 1 | 否 |
| `LocalCompletionVerifier` | `orchestration/completion-verifier.ts` | 5 | 否 |
| **`LocalProgressAndCycleGuard`** | `tools/local-progress-and-cycle-guard.ts` | **12** | 否 | ← **§2 已验证** |
| `LocalRigorPolicyEngine` | `tools/local-rigor-policy-engine.ts` | 1 | 否 |
| `ToolDocumentationRecallController` | `tools/tool-help-recall-controller.ts` | 1 | 否 |

**生产提及 1–2（21 个）**：`AgentModelAssignmentController`、`BoundedProviderFallbackGuard`、
`GitContributionVerifier`、`GitIntegrationCoordinator`、`GitIntegrationReportStore`、
`GitRecoveryPointService`、`GitWorktreeAllocator`、`QuaternaryPermissionIntersectionGuard`、
`TaskChainCumulativeBudgetController`、`ToolDocumentationReceiptStore`、`AgentAddressGuard`（门面提及 **是**）、
`AgentCreationRegistry`（门面提及 **是**）、`AgentTaskSequenceStore`、`SecondaryAgentSessionController`、
`TertiaryAgentAssignmentPlanner`、`TertiarySingleChainExecutionGuard` 等。

> Git 一族（5 个）与本会话已报告的 **T08 Git 集成整层不可达** 互相印证 ✓。

## 2. ✅ 已验证的缺口：`LocalProgressAndCycleGuard` 在生产里**零使用**

**核实方式（可靠工具，非脚本）**：用 ripgrep 按 `local-progress-and-cycle-guard|LocalProgressAndCycleGuard`
搜 `packages/` ⇒ **只有 2 处命中，都在它自己的文件里**（docstring 与 `export class`）
⇒ **生产代码零 import、零构造**；而测试里构造 **12 次**。

**该守卫按规则是必需的**——`AGENTS.md` 强制规范：

> 文件读取和其他可重复工具必须使用本地反自指/活锁保护：同一调用源短时间重复读取未变化资源时拒绝
> 并返回已有读取回执和剩余等待时间；**循环调用、无进展重试和 Agent 互相回派必须有本地检测与有界中止**。

**它实现的机制**（`local-progress-and-cycle-guard.ts` docstring）：
直接自环 `A→A`、工具/资源环 `A→B→A`、**任务回派祖先环与跨 Agent 乒乓**、
相同在途调用**合并为单飞**、相同结果/错误/无进展累计 `consecutiveNoProgressCount`（默认 3 次暂停路径）、
**include/redirect/引用解析的深度、节点数和扇出上限**、**任务总调用预算（持久化，重启不清零）**。

**生产里的近似机制只是"另外两件事"**（用 ripgrep 核过）：
- `agent-run-watchdog`：**模型无进展** → 只做**健康探测**（不取消、不续跑）；
- `read-suppression-ledger`：**重复读取未变化资源**（我已在前几轮验证它在生产里是接通的）。

⇒ **自环/资源环/回派祖先环/跨 Agent 乒乓/扇出上限/任务总调用预算**这几类**在生产里没有对应实现**，
而它们正是规则点名的"循环调用、无进展重试、互相回派"。

**本轮不改产品**：接它需要一次设计决定（在哪一层强制？工具循环？策略包装器？编排器？
失败时如何"有界中止"、以及**默认阈值**是否沿用 3/12/64/16/200），且会**改变生产行为**。

## 3. 本轮我自己的三次口径错误（都已在工具里修正或标注）

| # | 错误 | 修正 |
| --- | --- | --- |
| 1 | 脚本把**定义文件自身**排除在"生产构造"之外 ⇒ 同一文件内被别的类构造的内部助手被误报（如 `CanonicalResourceIdentityResolver`） | **含定义文件**统计构造 |
| 2 | 按**类名**统计"生产提及" ⇒ 漏掉"只 import 该模块常量"的情形 | 改为按**模块路径**统计 |
| 3 | 我另写的 PowerShell 版 import 检查**明显不可靠**（它对 `main-agent-readonly-projection` 也报"零 import"，而装配层**确有** `new MainAgentReadonlyToolProjection()`） | **放弃该检查**，改用 `grep`/ripgrep 人工抽查；并把该教训写进 `scripts/audit-product-reachability.mjs` 头部（"启发式，必须抽查"） |

> 另记：写 `scripts/audit-product-reachability.mjs` 时我用 `` `packages/*/src/**` `` 写注释，
> 其中的 **`*/` 提前终止了块注释**，导致脚本语法错 —— **注释里不能出现 `*/`**。

## 4. 建议（分诊办法与下一步）

**对每个候选，按这个顺序判**（顺序很重要，先排除假阳性）：

1. **用 ripgrep 按模块路径搜生产**（`from "…<module>.js"`）：有引用 ⇒ 不是"零提及"，需进一步看是否构造；
2. **看是否有生产子类**（`extends X`）：有 ⇒ 可达（`AssistScheduler extends MissionOrchestrator` 即此例）；
3. **看 `public-sdk` 是否导出**：导出 ⇒ "可达但需宿主提供"（`AgentAddressGuard`／`AgentCreationRegistry` 属此类）；
4. **看生产里是否有等价内联实现**：有 ⇒ 该类的**用途已被取代**（"死抽象"，**不是缺口**，
   例如 `LocalCompletionVerifier` 需要这样核实 —— 完成门禁在生产里**确实生效**，故它很可能是被取代的实现）；
5. 只有**1–4 全否**，才算"**真不可达**"，再对照 `AGENTS.md`／卡片判断**是否规则要求**：
   - 规则要求 ⇒ **缺口**（如 §2）；
   - 规则未要求 ⇒ **死码**（可删或接线，属维护问题而非合规问题）。

**建议下一步**：优先核 `AgentCommunicationDelegationController`／`DelegatedAgentCommunicationGrantStore`
（AGENTS.md 有"沟通句柄转交"整条规则）与 `LocalRigorPolicyEngine`（"高严谨性任务必须强制事实核验"），
以及 `ToolDocumentationRecallController`（工具用法首次/回访规则）。
**每一项都应先核实再决定**，不直接当缺口上报。

## 5. 第 107 轮**已核实**的三个候选（都用 ripgrep 按模块路径+特征符号核过）

判定顺序同 §4（先排假阳性）。以下三个都过了第 1–3 步（生产无引用、无子类、门面未导出），
第 4 步（**生产里是否有等价内联实现**）也核过 —— 结论：**没有**。

### 5.1 `LocalRigorPolicyEngine`：**"高严谨性由本地规则标记"这一半没接**

- **规则原文（AGENTS.md）**：「高严谨性任务由**本地规则标记**，并**强制**调用事实验证工具形成证据包。」
- **生产现状**：`rigorLevel` 在整个 `packages/` 里只出现在 ① `core/schemas.ts` 的 schema、
  ② `local-rigor-policy-engine.ts`（本引擎，**零使用**）—— **没有任何地方产生或传递 `rigorLevel`**；
  `requiredClaimIdentifier` 只出现在 `evidence-completion-gate.ts` 与 `completion-verifier.ts`
  （后者**本身也是零使用的候选**）⇒ **"强制"这半同样没有生产调用方**。
- **已接通的是"工具与构建器本身"**：装配层确有 `new EvidenceBundleBuilder()`（`application-runtime.ts`），
  `factVerification` 工具可用且会校验证据包 ⇒ **模型可以调用**，但**没有任何东西强制它调用**。
- **性质**：**规则未实现**（两半都缺），不是"死抽象"。

### 5.2 `ToolDocumentationRecallController` / `ToolDocumentationRecallInjector`：工具说明回执未接

- **规则原文（AGENTS.md）**：「次级和三级 Agent **第一次**接收某工具组时获得**完整公开用法**；
  同一工具组 revision 后续**只注入固定的 `ASTARRAY_TOOL_HELP_REQUEST_V1` 提醒**。」
- **生产现状**：`首次接收|完整公开用法|工具组 revision|工具说明回执` 在 `packages/` 内**只有 3 处命中**，
  且都在 `tool-help-recall-controller.ts` 与 `tool-documentation-recall.ts`（**两者都零使用**）
  ⇒ **生产里没有首次/回访的区分逻辑**（生产确实会把工具描述符交给 Provider，但是**统一**给的）。
- **性质**：**规则未实现**。

### 5.3 `AgentCommunicationDelegationController` / `DelegatedAgentCommunicationGrantStore`：沟通句柄转交未接

- **规则原文（AGENTS.md）**：「直属上级经当前权限和用户裁决授权后，**可**把直属低一级 Agent 的
  不透明沟通句柄转交给一个具体同级 Agent。」
- **生产现状**：两个类只出现在 `agent-communication-delegation.ts` 自身；特征字段 `replyRoute` 亦然。
- **性质**：规则是**许可式**（"**可**"）⇒ 未接线是**能力缺失**，**不是规则违反**（如实区分，不夸大）。

## 6. 第 107 轮**新增口径缺口 #4**（少报比误报更危险）

原后缀白名单漏掉 `Gate`／`Builder`／`Injector`／`Source`／`Sink`／`Adapter`／`Projector`／`Dispatcher`
⇒ 像 `EvidenceCompletionGate`、`ToolDocumentationRecallInjector` 这类**规则点名的组件根本进不了候选**。
已补齐后候选从 **29 → 38**，新增里包含：

- `AzureOpenAiAdapter`、`BedrockConverseAdapter`（`runtime/`）—— **已核实（同日，第 108 轮）**：
  生产里**只出现在各自文件**（未注册、**未从公开门面导出**）⇒ **产品与宿主都无法使用**；
  **但这不是新缺口** —— 既有报告**早已记录**该"产品接线未接"状态
  （见 `docs/reports/PRODUCT_PATH_ACCEPTANCE_DUAL_VENDOR_2026-10-02.md` L104–105 与
  `docs/reports/T07D_R2_01_PROVIDER_BASELINE.md` L13）⇒ **属既定延后项**。
  **同批表述里"CLI 的 `run` 只注册 `openai-compatible`"已部分过期**：
  `anthropic-messages` 现已接通（`packages/tui/src/cli/runtime-selection.ts` L124–129 与 L199–204
  按协议二选一注册，且两个注册器都已从门面导出）⇒ 详见新增状态补丁
  `docs/reports/STATUS_UPDATE_T07D_PROVIDER_PROTOCOL_WIRING_DRIFT_2026-11-08.md`。
- `EvidenceCompletionGate`（生产提及 1：仅被同样零使用的 `completion-verifier.ts` 以**类型**引用）。

**待办**：对新增候选按 §4 的顺序逐个核实，**先排假阳性**再定性。

## 7. ✅ 第 109 轮已核实：**"早停 → 从检查点有界续跑"这条链在生产里断了**（且**文档写成已交付**）

**规则原文（`AGENTS.md`）**：

> 输出提前结束、缺失完成事件或标识与本地状态不符时，**由本地看门狗从检查点有界续跑**，禁止无限重试或重复副作用。

### 7.1 生产里**确实有**的部分（先说这个，免得夸大成"整条都没有"）

- **完成事件协议与校验**：`core/completion-protocol.ts`（`ASTARRAY_TASK_COMPLETION_V1`、自动续跑上限默认 3）在生产中；
- **拒绝结案**：`worker-agent.ts` 会对「缺少 `ASTARRAY_TASK_COMPLETION_V1` 完成控制事件」给出拒绝理由；
- **工具连续失败计数**：`ToolFailureCounter`（默认阈值 3，达阈值 ⇒ **暂停并反馈**）——
  ⚠️ **它不是任务级重试**（我第 109 轮在此处写成了"任务级有界重试"，第 110 轮订正）：
  `rg -n "requeue|reschedule|retryTask|retryCount" packages/core/src/orchestration` ⇒ **0 命中**
  ⇒ **编排层不存在任务级重试机制**；
- **任务级恢复检查点**：`recovery-checkpoint-recorder` / `recovery-checkpoint-store` 用于 mission 恢复（本次会话也验过其哈希链校验）。

### 7.2 但**规则点名的那条执行路径不存在**（ripgrep 逐项核实）

| 组件 | 生产现状 |
| --- | --- |
| `ContinuationCoordinator`（`agent-run-watchdog.ts`） | **全仓只在自身文件出现** ⇒ **从未被构造/使用** |
| `AgentRunWatchdog`（同文件） | 同上 ⇒ **从未被构造/使用** |
| `LongToolCheckpointController`（`runtime-guidance/long-tool-checkpoint.ts`，即"**是否允许续跑**"的决策） | 装配层**构造**（`application-runtime.ts:722`）并**放进返回的运行时包**（L1200），**但全仓没有任何消费者** —— 该标识符全仓仅 **4 处**：① 装配层 import、② 装配层类型字段声明 L178、③ 构造、④ 放入返回包；第 5 处是 `docs/reports/GUIDE01_04_PRODUCT_ENTRY.md` L13 **声称它"暴露"**（暴露 ≠ 被消费） |

⇒ **"先原子保存检查点，再以新 `completionAttemptId` 续跑"这条执行路径在生产里不存在**；
生产只有「**拒绝结案**」，**且编排层没有任务级重试机制**（第 110 轮实测：`requeue|reschedule|retryTask|retryCount` 在 `packages/core/src/orchestration` **零命中**）⇒ 早停时任务**既不续跑也不重试**，只能停在拒绝结案等上级/用户处理，**不是**"从检查点续跑"（
因此"禁止重做无法确认的非幂等副作用"这一条也**缺乏对应保障**）。

### 7.3 ⚠️ 这是**文档与生产不一致**（可复核事实，不是推断）

以下文档把该能力写成**已交付行为**，且**没有**任何"未接线/延后"标注：

- `IMPLEMENTATION_PLAN.md` L1059–1060（`AgentRunWatchdog` / `ContinuationCoordinator` 各一条）；
- `docs/architecture.md` L138：「输出结束但本地状态未完成时，**从原子检查点有界续跑**」；
- `docs/adr/0015-explicit-completion-and-early-stop-recovery.md` L46；
- `PLAN_STATUS.md` L1855–1856（历史行，逐条描述两者的语义）；
- `docs/reports/GUIDE01_04_PRODUCT_ENTRY.md` L13（声称控制器"暴露"）。

### 7.4 处置与边界

- **本轮不改产品**（接它＝决定"在哪一层执行续跑、幂等键与检查点如何绑定、上限如何配置"⇒ 行为变更）；
- **本轮不擅自改那些架构文档**（若改，等于替它们下"未实现"的结论）；建议由对应卡所有者二选一：
  **接线**，或在文档里**如实标注"当前未接线"**；
- 我**不夸大**为"整条规则都没实现"：§7.1 列的三项确实存在，缺的是**§7.2 那条具体执行路径**。

> **⚠️ 自我订正（第 110 轮）**：本文档第 109 轮的初稿把 `failureThreshold` 写成"DAG 任务级有界重试"，
> 实测它是 **`ToolFailureCounter`（工具连续失败计数，达阈值 ⇒ 暂停并反馈）**，且编排层**没有任务级重试机制**
> （`requeue|reschedule|retryTask|retryCount` 在 `packages/core/src/orchestration` **零命中**）。
> 该订正**加强**了 G5 的结论：早停时任务**既不续跑也不重试**，只能停在拒绝结案。

