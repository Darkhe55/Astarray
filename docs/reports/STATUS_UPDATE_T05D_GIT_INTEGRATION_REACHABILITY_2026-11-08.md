# 状态补丁：T05D（人机并发变更 / Git 集成）可达性说明

- **日期**：2026-11-08（第 148 轮）
- **待集成到**：`docs/tasks/T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD.md`（该卡 L3 现为「状态：`done`（T05D-01~06 全部完成）」）
- **性质**：**不覆盖他人文件**，仅作独立状态补丁；不改变任何产品行为。

## 1. 为什么需要这份补丁

T05D 卡把状态写成 `done`。但本窗口（第 101–148 轮）的实际勘测显示：

**"完整的多 Agent Git 集成流程"在产品路径上不可达**，具体为：

1. 全仓**没有** `new GitIntegrationCoordinator(...)` —— 该组件（395 行，含开集成会话/收贡献/收口）**从未被构造**；
2. 门面的装配选项**明确拒绝** `gitIntegration`；
3. `ConcurrentMergeCoordinator`（193 行）**确被构造**，但只出现在 `concurrent status` 命令里，
   而该命令**本身未接入 CLI 的 argv 分发**（见 `PRODUCT_WIRING_GAPS_MASTER_2026-11-08.md` 的 **G10**）⇒ **仍不可从 CLI 调用**；
4. `HumanWorktreeObserver` / `StaleWriteGuard` 仅在 `concurrent status` 里被 **import 用于"模块可加载"汇报**；
   该汇报在第 129 轮已按 G9 改为**如实表述**（`modulesLoadable` + `componentsReadySemantics`）。

## 2. 结论（措辞要求）

- T05D 的 `done` **只能**理解为"该卡列出的检查点在其自身范围内完成"，
  **不得**被读成"支持完整的多 Agent Git 集成流程"；
- 按用户**硬约束**：**G1 未完成前，任何文档/汇报都不得宣称支持完整的多 Agent Git 集成流程**。

## 3. 若要真正闭环，需要什么（详见总表 §8）

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| Step 1 | 装配层构造 `GitIntegrationCoordinator` + `GitContributionVerifier` + `GitIntegrationReportStore`，门面新增 `gitIntegration?`（缺省不启用）；验收在临时 `git init` 仓库跑完整流程 + **拔线必失败** | **未开始** |
| Step 2 | `GitWorktreeAllocator` 接进 worker 分派（每 `agentInstanceId` 一隔离 worktree，三级只能提交自己分支） | **未开始** |
| Step 3 | `evaluateControlledMerge` + `verifyContribution` 的五项门禁 | **未开始**；**需用户明确授权"自动合并"边界** |

## 4. 证据来源

- `docs/reports/PRODUCT_WIRING_GAPS_MASTER_2026-11-08.md` **§8**（组件实读、缺口、三步验收）；
- 同文件 **§5.1**（G9 的如实化改动）与 **§5.2**（G10）。
