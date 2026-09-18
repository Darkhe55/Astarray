# GUIDE 增量 02b 新任务插入任务偏序集 — 证据

> 检查点：GUIDE 增量 02b（用户文档 §6 补充项，收口 GUIDE 增量）
> 前驱：GUIDE 增量 02a（提交 2324916、ec4c3be，已推送）。日期：2026-09-17
> 契约补充：docs/adr/0038-runtime-guidance-contract.md §39–43

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/public-sdk.ts | `submitGuidanceChange` 接受 `insertionTarget`（ownerAgentInstanceId/sequenceId/expectedSequenceRevision/锚点）与 `insertionTaskTitle`；new-task 缺少插入目标 → 澄清；插入失败 → 拒绝且不登记变更意图；结果新增 `insertedSequenceRevision` |
| tests/core/integration/guidance-change-poset-insertion.test.ts（新，4 用例） | 插入成功（用户层级 0、锚点 dependsOn、序列 revision 前进）、缺目标澄清、并发 revision 落后拒绝、重复标识拒绝 |
| tests/core/integration/guidance-change-product-entry.test.ts | 02a 用例更新：new-task 缺少插入目标时产品入口要求澄清（02b 起为硬前置） |

## 2. 行为反例（先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| new-task 指定插入目标 | 插入次级序列、用户层级 0、序列 revision 前进 | 通过：节点 priorityTier=0、dependsOn 含既有任务 |
| new-task 缺少插入目标 | 澄清、不插入 | 通过：序列不变、无历史 |
| 并发序列 revision 落后 | 拒绝插入且不登记变更意图 | 通过：task-insertion-failed，序列不变 |
| 重复任务标识 | 拒绝插入 | 通过：task-insertion-failed，序列不变 |
| 既有任务 revision | 不受 new-task 影响 | 通过 |
## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/integration/guidance-change-poset-insertion.test.ts --maxWorkers=4 | 0；4 passed |
| npx vitest run tests/core/integration/guidance-change-{intent,product-entry,poset-insertion}.test.ts tests/tui/integration/guide-change-cli.test.ts --maxWorkers=4 | 0；24 passed |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- 插入只写任务偏序集节点（taskId/title/priorityTier/externalReference + 锚点），不承载产出内容。
- 用户来源层级默认 0；Agent/工具来源的层级约束仍由既有 `TaskPriorityPolicy` 与变更意图控制器双重校验。
- 真实长任务中途追加/撤销的运行端到端演练未执行（需真实 Provider/长任务）；以公共入口 + 真实偏序集插入取证。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：225 文件 / 1808 用例全通过（+1 文件 / +4 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.02 / 85.09 / 93.05 / 93.04；public-sdk 90.00 / 80.06 / 90.32 / 90.21 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | 见提交记录 |

## 6. 未满足项与后续

- **GUIDE 增量（§6）至此收口**（02a 变更意图契约/产品入口 + 02b 偏序集插入）。
- 未验证：真实长任务中途追加/撤销的运行中端到端演练。
- 后续：WB-00 剩余检查点、E2E-01/GUI-01-R/BRIDGE-01 外部依赖项，以及**治理文档统一修订**（正式启用前必须完成）。

