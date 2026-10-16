# T08 编排层 Git 集成：**产品路径缺口**（2026-11-08，第 105 轮）

- **结论（一句话）**：T08 编排层 Git 集成（worktree 分流 → 贡献审查 → 集成分支合并 → 门禁合入）
  **能力已实现且有测试，但在整条产品路径上不可达** —— 只有**测试**在驱动它。
- **性质**：与本窗口已修的 `PERF`／`DIAG` 生产采集属**同一类**「组件存在但产品不可达」，
  但**范围更大**（`PERF`/`DIAG` 只是"采集未接线"，这里是**整层隔离/审查/合并编排**未接线）。
- **本轮**：**只报告与取证，不改产品**（理由见 §4）。

## 1. 证据（全部为可复跑的检索/构造事实）

| 检查 | 结果 |
| --- | --- |
| `new GitIntegrationCoordinator`（全仓 `packages`） | **零构造点** |
| `new GitIntegrationCoordinator`（含 `tests`） | 仅 `tests/core/integration/orchestrator-git-integration.test.ts` **import**，测试内构造 |
| 特征字段 `allowedPathsByTaskType` / `buildGitWorktreeToolPort` | 只出现在**两处**：`packages/core/src/orchestration/mission-orchestrator.ts`（**类型定义**）与**测试 harness** ⇒ **没有任何生产代码构造该选项对象** |
| `packages/core/src/application/application-runtime.ts`（装配层） | **完全不含** `gitIntegration` ⇒ **从不传给** `MainController` |
| 公开门面 `AstarrayApplicationFacade.create` 选项 | **不接受** `gitIntegration` ⇒ **宿主也无法注入** |
| `packages/tui`／`packages/gui`／`scripts` | **零命中** |

`MainController` 只在两处把 `this.options.gitIntegration ?? null` 转发给编排器
（`main-controller.ts` L840／L917），而**没有任何地方给它赋值** ⇒ 生产里恒为 `null`
⇒ 编排器的 `ensureGitIntegrationSession()` **恒早退**（`gitIntegration === null` 分支）。

## 2. 为什么这算缺口（对照仓库自身要求）

`AGENTS.md` 强制规范：

> 涉及 Git 写入的多 Agent 任务必须由次级 Agent 负责**分支/工作树分流、差异审查、测试验证和受控合并**；
> 三级 Agent 只能提交到分配给自己的隔离分支，不得自行合并、变基、推送或删除分支。

该规则依赖的**正是**这一层（worktree 分配、贡献审查、合并门禁）。
它现在**有实现、有 T08 编排测试，但没有任何生产入口** ⇒ 规则在当前产品形态下**无从执行**。

## 3. 本轮的**相关**交付（如实标注可达性）

为"使命级失败在诊断里不可见"补了一处**使命级诊断端口**：
`MissionOrchestratorOptions.missionDiagnosticEventPort?`（可选、缺省不采集），
并在 `ensureGitIntegrationSession()` 的 catch 里上报 `stage: "git"` 的事件
（该 catch 原本**只 `onUserEscalation` 就吞掉错误**）。

- 反例：`tests/core/integration/orchestrator-git-integration.test.ts` 新增
  「Git 集成会话启动失败：必须上报诊断事件，且用户升级消息照旧」——
  **实现前红**（`等待超时: Git 集成失败被上报为诊断事件`，30s），**实现后绿**（~0.5s）；
  断言同时钉住"**上报不取代既有升级消息**"。
- **⚠️ 可达性如实说明**：该端口**尚未**在装配层/门面接线，且**即使接了**，
  由于 §1 的缺口，`git` 阶段在生产里**也不会发生** ⇒
  **本条目前是"编排器级能力 + 测试证据"，不是"生产可见的改进"**。
  我不把它写成"诊断现在覆盖了 Git 失败"。

## 4. 为什么本轮不直接接线（不擅自扩大）

要真正接通需要一次**设计决定 + 多片实施**，且触及**安全关键行为**：

1. 生产装配要构造 `GitIntegrationCoordinator`（依赖 `GitProcess`／`GitWorktreeAllocator`／
   `GitIntegrationReportStore`／`GitRecoveryPointService`）并决定其**状态目录与分支归属**；
2. 要决定 `allowedPathsByTaskType`（**哪些任务类型允许改哪些路径**）—— 这是**策略**，不是实现细节；
3. 要注入 `isTargetBranchMergeAllowed`（**合并门禁的授权面**）—— 涉及"谁能自动合并"；
4. 还要决定它在 assist/devolve 两种模式下的差异与开关。

以上任一项都是**产品行为变更**（尤其 3 会让"自动合并"成为可能），
按本会话纪律（"不擅自改变生产默认行为"）**应由用户决定后再做**。

## 5. 建议

- **若要接线**：建议先出一份独立方案（上面 4 点逐条给默认值与开关），再分片实施；
- **若暂不接线**：建议**在相关卡与状态表里如实登记该缺口**（本轮已在 `PLAN_STATUS` 的产品路径审计行挂指针），
  以免后续有人误以为"Git 隔离/审查/合并已经在跑"。
