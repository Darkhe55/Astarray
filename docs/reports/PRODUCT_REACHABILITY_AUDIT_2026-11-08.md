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
