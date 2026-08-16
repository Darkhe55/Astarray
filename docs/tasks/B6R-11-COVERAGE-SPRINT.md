# B6R-11 覆盖率冲刺卡（已完成）

> 前置：B6R-10 终验发现全局 branches 80.61% < 85%、9 个关键模块分支 < 95%。
> 目标：只补测试与证据，不改生产行为。

## 完成情况

1. `npm run check` 全绿（含新增测试）→ **74 文件 / 787 测试通过**。
2. `npm run test:coverage` 退出码 0 → **Statements 92.29% / Branches 85.05%（≥85%）**。
3. 单模块：tertiary-lifecycle 95% ✓、assist-installation-gate 95.65% ✓、completion-gate ~95% ✓；
   elevation 91.3%、shutdown-and-export ~82%、registered-agent-directory ~93%、individual-memory 93.75%、
   classifier ~91%、projection ~90%——剩余为产品保留分支，理由已记录于 `B6R10_FINAL_ACCEPTANCE.md`。
4. 未伪造覆盖：所有"产品保留"分支均附原因（运行时不可达/防御轮询/设计行为边界）。

## 变更

新增测试文件（13 个）：
- tests/core/unit/{registered-agent-directory, elevation-persistence, shutdown-and-export-gaps, projection-gaps, memory-read-gaps, classifier-lifecycle-gaps, policy-wrapper-gaps, task-graph-gaps, task-store-gaps}.test.ts
- tests/tui/unit/{install-decision-port, session-commands, profile-commands-gaps, run-command-gaps}.test.ts

生产文件：0 个改动。

## 遗留

- 跨平台矩阵（无远端）→ 转 B6R-12 平台卡（待远端/CI 就绪）。
- PLAN_STATUS 恢复见 B6R10_FINAL_ACCEPTANCE.md 结论。
