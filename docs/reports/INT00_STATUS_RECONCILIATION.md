# INT-00-03 状态与依赖纠偏

> 检查点：INT-00-03（状态与依赖纠偏）　状态：done
> 任务卡：`docs/tasks/INT00_PRODUCT_PATH_AUDIT_TASK_CARD.md`；共同契约：`docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md`
> 日期：2026-09-10；基线提交：`c3025bd`；依据：`docs/reports/INT00_PRODUCT_PATH_MATRIX.md`、`docs/reports/INT00_BEHAVIOR_EVIDENCE.md`
> 原则：保留历史证据，不用说明文字覆盖未满足门禁；真实服务未验证一律不得写为已支持。

## 1. 证据分级（逐项区分六类证据）

| 能力 | 契约 | 实现 | 产品接线 | 离线端到端 | 真实服务 | 人工体验 | 结论 |
|---|---|---|---|---|---|---|---|
| CLI `run` / TUI（mock） | ✅ schema + 命令定义 | ✅ `MainController` 全链路 | ✅ `bootstrapCli` 装配 | ✅ 实测 mission done + 落盘 | ❌ 未接 | ⚠ 仅组件级 | 保留；Provider 缺口见下 |
| Public SDK / 应用服务 | ✅ 公共 DTO（`public-sdk.ts`） | ⚠ facade 为桩（不持有控制器） | ❌ 无生产装配 | ❌ `readPublicResult=null`、无 mission | ❌ | ❌ | → `T07D-R1-01..04` |
| Provider 真实运行时 | ✅ 协议端口/适配器契约 | ⚠ adapter-only（未过 fake-server 契约与增量流） | ❌ `run` 拒绝非 mock；无 Provider 配置读取 | ⚠ fake-server 级（模块测试） | ❌ | ❌ | → `T07D-R2-01..04`（04 预期 blocked） |
| 上下文预算/关闭/回访 | ✅ ADR-0031 + schema | ✅ 存储/选择/回访/缓存/指标模块 | ❌ 编排零装配；仅只读 `context status` | ❌ 完成任务后图仍为空 | ❌ | ❌ | → `T09A-R1-01..04` |
| 会话恢复/对账 | ✅ ADR-0030 + schema | ✅ 检查点/分类/身份预算模块 | ❌ `recover` 未注册且为桩 | ❌ CLI 层不可达 | ❌ | ❌ | → `T12A-R1-01..04` |
| GUI | ⚠ 仅有 README 占位 | ❌ 无实现 | ❌ | ❌ | ❌ | ❌ | → `GUI-01-R` |
| 外部桥接（MCP/A2A） | ✅ 契约 + schema 校验 | ❌ 无服务器 | ❌ | ❌ | ❌ | ❌ | → `BRIDGE-01` |
| 权限/安装门禁/备份/反馈/记忆隔离 | ✅ | ✅ | ✅（`bootstrapCli` 装配 + 集成套件） | ✅ 随 `npm run check` | ❌ | ⚠ TUI 交互有组件测试 | 保留历史，无需返修 |

## 2. 未满足项到返修检查点映射

| 旧验收项 | 要求（原卡） | 实测缺口 | 返修检查点 |
|---|---|---|---|
| `T07D-06` | 产品装配“不再只允许 mock” | `run` 对非 mock 返回 exit 2；bootstrap 固定 `ScriptedRuntime` | `T07D-R1-04`、`T07D-R2-01/02/03` |
| `T07D-07` | 独立工作助手真实纵向闭环 | 无 Provider、无多层真实调度 | `E2E-01-01..04`（前驱 T07D-R1 + T07D-R2 + T09A-R1 + T12A-R1） |
| `T07D-08` | 稳定 Public SDK；消费者可导入并完成任务与结果读取 | facade 不调用控制器、结果恒 null、事件误报 | `T07D-R1-01`、`T07D-R1-02`、`T07D-R1-03` |
| `T09A`（历史 `done`） | 上下文关闭/回访实际运行 | 模块齐备但编排零装配；`context status` 恒定空图 | `T09A-R1-01..04` |
| `T12A`（历史 `done`） | 中断后的产品级恢复 | `recover` 未注册；`list/resume` 为桩 | `T12A-R1-01..04` |
| GUI-01（待执行） | GUI MVP | `packages/gui/` 仅 README | `GUI-01-R-01..04` |
| 外部桥接 | 单一外部协议 MVP | 仅契约无服务器 | `BRIDGE-01` |

## 3. 本检查点执行的状态纠偏

- `PLAN_STATUS.md`：`T09A`、`T12A` 由 `done` 改为 `re-verifying`（产品接线未通过）；`T07D` 保留 `re-verifying` 并补注 SDK/Provider 缺口指向 R 卡；新增一条 2026-09-10 纠偏说明指向本报告。
- `docs/tasks/T07D_..._TASK_CARD.md`：顶部增加范围说明——历史 `done` 仅覆盖模块/适配器与 SDK 可导入级证据，`T07D-06/07/08` 的产品接线未满足，移交 `T07D-R1/R2` 与 `E2E-01`。
- `docs/tasks/T09A_..._TASK_CARD.md`：顶部注明历史 `done` 为模块级；运行期装配缺口见本报告，移交 `T09A-R1`。
- `docs/tasks/T12A_..._TASK_CARD.md`：顶部注明历史 `done` 为模块级；`recover` 产品入口缺口移交 `T12A-R1`。
- `docs/tasks/GUI_MVP_CODING_TASK_CARD.md`：顶部注明旧边 `B6R-10 → GUI-01 → T08B` 被新批取代；GUI 不再作为已实现 `T08B` 的前驱。
- `README.md`：当前限制补充 SDK/应用服务与上下文/恢复运行接线缺口，并指向本报告。
- `DELIVERY_REPORT.md`：新增 §11 产品接线缺口与旧状态纠偏。

## 4. GUI 依赖循环核查

- 旧依赖来源：`GUI_MVP_CODING_TASK_CARD.md`（前驱 B6R-10、后继 T08B、插入边 `B6R-10 → GUI-01 → T08B`）、`BATCH6_REPAIR_TASK_CARDS.md`（`B6R-10 → T08B` 边与“未通过不得开始 T08B”）、`docs/tasks/README.md`。
- 核查结论：`T08B` 为历史实现（`docs/adr/0024` 记录设计冻结与实现），若继续保留 `GUI-01 → T08B`，则“待执行 GUI”会阻塞已实现任务，并与新批 `T07D-R1 → GUI-01-R` 形成方向冲突。
- 处置：旧边作废（保留为历史记录并加注）；新边 `T07D-R1 → GUI-01-R → WB-00`，`GUI-01-R-02` 依赖 T07D-R1、`-03` 依赖 T09A-R1/T12A-R1、`-04` 依赖 E2E-01。依赖图为 DAG，无环：`INT-00 → T07D-R1 → {T07D-R2, T09A-R1, T12A-R1, GUI-01-R, BRIDGE-01}`、`GUI-01-R → WB-00`。

## 5. 历史证据保留

- 未删除或修改任何既有测试、覆盖率、tarball 与验收记录；`done` 降级仅表示“模块级证据成立、产品接线未验证”。
- 本批新增返修卡与本次纠偏记录均不回改历史提交内容。
