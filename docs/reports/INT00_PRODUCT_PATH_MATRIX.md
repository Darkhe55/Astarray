# INT-00-01 产品执行路径矩阵

> 检查点：INT-00-01（入口与构建基线）　状态：done
> 任务卡：`docs/tasks/INT00_PRODUCT_PATH_AUDIT_TASK_CARD.md`；共同契约：`docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md`
> 日期：2026-09-10；执行：主 Agent（只审计，不修改产品代码）
> 说明：结论均给出代码位置、搜索范围与反例；真实命令/事件顺序的行为级证据由 INT-00-02 补齐。

## 1. 基线

| 项目 | 值 |
|---|---|
| 提交 | `8ebdaa87b72754f4c40ecab9cbf9dadb8249e6cc`（与 `origin/main` 同点） |
| 工作树 | 13 项未提交，全部为用户并行的产品接线文档：`IMPLEMENTATION_PLAN.md`、`PLAN_STATUS.md`、`docs/tasks/README.md`（M）+ 10 个未跟踪新文件（`PRODUCT_INTEGRATION_ROLLOUT.md` 与 INT00 / T07D_R1 / T07D_R2 / T09A_R1 / T12A_R1 / E2E01 / BRIDGE01 / GUI01_R / WB00 任务卡）。本次审计未改动任何产品代码 |
| 包 | `astarray@0.1.0`，`type: module`，`engines.node >= 20` |
| 导出 | `exports["."] = { import: "./dist/public-sdk.js" }`（无 `types` 条件、无子路径导出）；`bin.astarray = dist/cli.js`；`files = dist, README.md, LICENSE` |
| 运行时 | Node `v24.18.0` / npm `11.16.0`（Windows；本机唯一实测平台） |
| 依赖 | dependencies：commander、ink、react、zod；dev：vitest、tsup、typescript、eslint、fast-check 等 |
| 依赖风险 | `npm audit --audit-level=high` → exit 0；7 项（4 low / 3 moderate）均为 dev 工具链，生产依赖无 high/critical |
| 构建产物 | `dist/` 存在（`cli.js`、`public-sdk.js`、`feedback-process-entry.js` 及分块） |
| 已注册 CLI 命令 | `run`、`resume`、`status`、`context status`、`cancel`、`config init`、`config install-enabled`、`profile *`、`session *`、`doctor`（`packages/tui/src/cli.tsx`） |
| 未注册 | `recover`（`commands.ts` 内有 list / show / resume / abandon 函数，但 `cli.tsx` 未导入或注册） |

## 2. 产品路径矩阵

| # | 路径 | 公共入口 | 装配/构造点 | 是否到达真实执行 | 证据（文件:符号） | 缺口 / 反例（含搜索范围） |
|---|---|---|---|---|---|---|
| 1 | CLI headless run | `astarray run <prompt> --runtime mock --json` | `cli.tsx:43-57` → `executeRunCommand` → `bootstrapCli` | 是（mock 运行时）：`controller.handleUserMessage` 真实创建 mission 并轮询终态 | `packages/tui/src/cli/run-command.ts:56`；`bootstrap.ts:91,345-415` | `runtime !== "mock"` 直接 USAGE_ERROR（`run-command.ts:31-36`）；运行时工厂硬编码 `ScriptedRuntime`（`bootstrap.ts:379-391`） |
| 2 | TUI 交互 | `astarray`（无子命令） | `cli.tsx:38-41` → `launchTui` → `bootstrapCli` → `AstarrayApp` | 是（mock 运行时）：输入提交调用真实控制器 | `packages/tui/src/cli/tui.tsx:13,26`；`packages/tui/src/ui/app.tsx:171` | 与路径 1 共用同一 bootstrap，运行时同样固定 mock |
| 3 | Public SDK | `import { AstarrayApplicationFacade } from "astarray"` | 消费者自建 `new AstarrayApplicationFacade({})`；`bootstrapCli` 返回的 controller 未被任何 SDK 装配路径使用 | **否**：`submitTask` 只构造 DTO 并 emit 事件；`readPublicResult` 读取从未写入的 Map；`shutdown` 仅 `void controller` | `packages/core/src/public-sdk.ts:48`（类）、`:100-110`（submitTask）、`:114-116,126`（结果 Map）、`:119-124`（shutdown） | 搜索 `AstarrayApplicationFacade` 于 `packages/`：仅定义处 1 命中。反例：`tests/core/unit/public-sdk.test.ts:35` 断言 `status === "accepted"` 即通过；直接运行 `dist/public-sdk.js` 得 `readPublicResult=null`、事件 `task-finished/accepted`（无任务执行） |
| 4 | Provider 真实路径 | `astarray run --runtime openai-compatible` | `bootstrap.ts` 的 `mainRuntimeFactory` / `workerRuntimeFactory` | **否**：非 mock 被显式拒绝；bootstrap 不读取任何 Provider 配置 | `run-command.ts:31-36`；`bootstrap.ts:379-391`；`main-controller.ts:69-70,540,578,622` | 搜索 `ASTARRAY_PROVIDER|mainRuntimeFactory|workerRuntimeFactory|createRuntime|providerId` 于 `packages/`：7 命中，全部为工厂声明/调用，无环境变量或凭据读取 |
| 5 | 上下文预算/关闭/回访 | `astarray context status --agent <id> --graph <id> [--json]` | `cli.tsx:83-102` → `executeContextStatusCommand` | **否（仅只读状态视图）**：命令内临时构造图/胶囊/策略存储渲染视图，编排运行时既不构造也不调用任何上下文组件 | `packages/tui/src/cli/commands.ts:1706-1775`（尤其 `:1710-1742`） | 搜索 `ContextTierCache|ContextRecallController|LocalContextGraphStore|ContextClosureCapsuleStore|buildContextLifecycleStatusView|computeContextLifecycleMetrics|GlobalDecisionStore|HumanVerificationController` 于 `packages/`：37 命中，除定义文件外仅 `commands.ts:1710-1742`；`main-controller.ts` 0 命中 |
| 6 | 恢复入口 | `astarray recover list / show / resume / abandon` | `commands.ts` 导出 `executeRecoverListCommand`（`:1805`）、`executeRecoverResumeCommand`（`:1840`）、`executeRecoverAbandonCommand`（`:1879`） | **否 + 桩实现**：CLI 未注册该命令组；`list` 仅以 `Class !== null` 判定就绪并返回空数组，`resume` 返回硬编码 blocked 项，均不读取检查点 | `packages/tui/src/cli/commands.ts:1777-1880`；`cli.tsx` 导入列表无 Recover | 搜索 `executeRecover|recover` 于 `packages/tui/src`：仅 `commands.ts` 定义，无调用方；`cli.tsx` 0 命中 |
| 7 | 包导出与消费 | `import "astarray"` / `astarray` bin | `package.json` exports / bin | 导出可加载，但 `.` 指向的 facade 即路径 3 的桩 | `package.json:10-22`；`dist/public-sdk.js` | 无 `types` 条件（TS 消费者无类型入口）；`verify-package.mjs` 只校验打包完整性，不验证 SDK 语义 |
| 8 | 外部桥接 | `ExternalHarnessBridgePort` 契约 | `packages/core/src/orchestration/external-harness-bridge-port.ts` | **否**：仅 schema 与校验，无服务器实现 | 同左 | 搜索 `createServer|.listen(|WebSocketServer|McpServer|A2A|jsonrpc` 于 `packages/`：仅 1 命中（契约文件注释） |

## 3. 旧验收缺口到返修检查点映射

| 缺口 | 本审计现象 | 返修检查点 |
|---|---|---|
| T07D-08 Public SDK | facade 不持有可用控制器；提交早报 finished、结果不可读、关闭不回收资源 | `T07D-R1-01`（应用创建/生命周期）、`T07D-R1-02`（真实提交与事件）、`T07D-R1-03`（结果/取消/关闭）、`T07D-R1-04`（消费者与入口一致性） |
| T07D-06/07 Provider | 非 mock 被拒；无 Provider 配置/运行时注册；产品入口未连通本地协议服务器 | `T07D-R2-01/02/03`；真实服务项 `T07D-R2-04`（缺凭据时保持 blocked） |
| T09A 上下文 | 组件齐备但未进入编排；仅有只读 `context status` | `T09A-R1-01..04` |
| T12A 恢复 | `recover` 产品不可达且为桩实现 | `T12A-R1-01..04`（联测需 T07D-R2-02 + T09A-R1） |
| GUI | `packages/gui/` 仅 `README.md`（1 个文件） | `GUI-01-R`（前驱 T07D-R1 / T09A-R1 / T12A-R1） |
| 桥接 | 仅契约文件 | `BRIDGE-01`（基础需 T07D-R1） |

## 4. 限制与未验证（本检查点范围内）

- 本文件是静态调用链与最小运行诊断（`node --input-type=module` 直接调用 `dist/public-sdk.js`）的结果；系统性的命令/退出码/事件顺序证据属 INT-00-02。
- 平台：仅 Windows 实测；Linux/macOS 保留未验证。
- 真实 Provider 与真实服务未验证（无凭据）；`T07D-R2-04` 预期 blocked。
- GUI 与外部桥接仅有占位或契约，未做产品级验证。
