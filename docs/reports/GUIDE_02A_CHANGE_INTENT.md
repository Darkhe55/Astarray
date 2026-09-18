# GUIDE 增量 02a 追加/修订/新建任务变更意图 — 证据

> 检查点：GUIDE 增量 02a（用户文档 §6 补充项；docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md）
> 前驱：READ-FORMAT-05b（提交 9cf7689、7c118b1，已推送）。日期：2026-09-17
> 契约补充：docs/adr/0038-runtime-guidance-contract.md §31–38

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/runtime-guidance/guidance-change-intent.ts（新） | 变更意图契约：append/revise/new-task、revision 单调 +1、历史追加保留、受影响证据失效、旧完成声明失效、Agent 派生任务层级约束、并发 revision 检测、幂等去重、快照/恢复 |
| packages/core/src/runtime-guidance/guidance-change-intent-journal.ts（新） | `<状态目录>/guidance/change-intent.json` 原子写日志（跨进程 CLI history/revision） |
| application-runtime.ts | 创建并恢复变更意图控制器与日志 |
| public-sdk.ts | 产品入口 `submitGuidanceChange` / `queryGuidanceChangeHistory` / `isTaskCompletionDeclarationStillValid` + 公开 DTO |
| packages/tui/src/cli/commands.ts + cli.tsx | `astarray guide change`（--intent/-–task-revision/–invalidate-*）与 `astarray guide history` |
| tests/core/integration/guidance-change-intent.test.ts（12 用例） | 契约与边界 |
| tests/core/integration/guidance-change-product-entry.test.ts（5 用例） | 公共入口（含复用 GUIDE 接收回执） |
| tests/tui/integration/guide-change-cli.test.ts（3 用例） | CLI change/history 与错误码 |

## 2. 行为反例（先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 未明确变更类型 | 澄清、不改 revision、不入队 | 通过：needs-clarification + 澄清问题 |
| 追加要求 | revision 单调 +1、历史保留、不使证据失效 | 通过：r1→r2，invalidated 为空 |
| 修订未指明受影响证据 | 澄清 | 通过 |
| 修订指明产物/验收条目 | 仅这些失效、历史保留 | 通过：invalidated 列表精确 |
| 旧完成声明（revision 落后） | 失效 | 通过：r1 false、r2 true |
| 新建任务（用户层级 0） | 接受 | 通过 |
| Agent/工具派生层级 0 或超上限 | 拒绝 | 通过：priority-tier-elevation-rejected |
| 新任务标识重复 | 拒绝 | 通过：duplicate-task-identifier |
| 并发变更（观察 revision 落后） | 拒绝且不改状态 | 通过：stale-task-sequence-revision |
| 重复指导（同标识同 revision） | 幂等去重、不重复提升 revision | 通过 |
| 撤销旧要求 | 修订使旧验收条目失效且历史保留 | 通过 |
| 跨进程 | history/revision 可读 | 通过：日志恢复后重新 hydrate |
| 复用 GUIDE 回执 | 接受后进入控制队列（受理 ≠ 已应用） | 通过：queue 状态 queued |
| 快照/恢复版本不符 | 不恢复、不伪造历史 | 通过 |
## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/integration/guidance-change-intent.test.ts --maxWorkers=4 | 0；12 passed |
| npx vitest run tests/core/integration/guidance-change-product-entry.test.ts --maxWorkers=4 | 0；5 passed |
| npx vitest run tests/tui/integration/guide-change-cli.test.ts --maxWorkers=4 | 0；3 passed（含既有 guide-cli 回归） |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- 变更意图只登记“要做什么变更”与失效范围；**把新任务插入任务偏序集**（复用 `insertTask` 与偏序/优先级规则）属 GUIDE 增量 02b。
- 修订的失效范围是**声明式**的产物/验收条目标识；本检查点不直接删除或改写任何证据，只让旧声明不再有效。
- 变更指导接受后仍走 GUIDE-01 安全点应用（受理 ≠ 已应用）；不新增消息总线。
- 去重发生在 revision 校验之前：完全相同的重放返回既有结论（幂等），不同指导需使用不同标识/指令文本。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：224 文件 / 1804 用例全通过（+3 文件 / +20 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.00 / 85.08 / 93.05 / 93.03；guidance-change 98.88 / 85.88 / 100 / 98.85 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | 见提交记录 |

## 6. 未满足项与后续

- **GUIDE 增量 02b**：新任务插入任务偏序集（来源/优先级/revision 校验）与长任务中途追加/撤销的产品入口端到端反例。
- 主 Agent 派生节点优先级层级 1 的插入校验（本地控制面）尚未与偏序集接线。
- 治理文档统一修订未开始；GUIDE-01 卡未改写。

