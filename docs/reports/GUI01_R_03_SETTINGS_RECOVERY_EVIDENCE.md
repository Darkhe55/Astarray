# GUI-01-R-03a 设置与恢复交互（预算/权限组/恢复只读） — 证据

> 检查点：GUI-01-R-03（docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md），本轮按可构建边界拆分为 03a
> 前驱：GUI-01-R-02（done，docs/reports/GUI01_R_02_LOCAL_SERVER_EVIDENCE.md）。日期：2026-09-13
> 03b 剩余（已验收/待追认、人工裁决、各 Agent 上下文隔离）见本文件 §5 与任务卡

## 1. 范围与实现清单

| 文件 | 变更 |
| --- | --- |
| `packages/core/src/application/application-runtime.ts` | 暴露 `globalContextBudgetStore`、`contextRuntimeEventStore`、`mainAgentInstanceId`（原本仅内部局部变量），使 CLI/GUI/SDK 共用同一权威预算存储与真实装配事件流 |
| `packages/core/src/public-sdk.ts` | 新增公开 DTO `PublicContextSettings`/`PublicRecoveryMissionView`/`PublicRecoveryOverview`；公开事件新增 `budget-policy-updated`（带 revision/幂等 ID）；新增 `queryContextSettings`、`updateContextBudget`（CAS + 域错误码映射）、`queryRecoveryOverview`、`inspectRecoveryMission`（懒建真实 `RecoveryCenterController`，DTO 丢弃 `leaseProcessInstanceId`） |
| `packages/gui/src/server/gui-server.ts` | 端口扩展 `GuiApplicationPort`（`queryContextSettings`/`updateContextBudget`/`getCurrentPermissionProfileReference`/`listPermissionProfiles`/`switchPermissionProfile`/`queryRecoveryOverview`/`inspectRecoveryMission`，可选能力缺失时 501）；新增 `GET /settings`、`GET /recovery`、`POST /commands/set-context-budget`、`POST /commands/switch-permission-profile`；页面新增设置与恢复中心面板（预算表单、权限组切换、恢复列表） |
| `tests/gui/integration/gui-settings-recovery.test.ts`（新，5 用例） | 真实门面联测：预算→下一请求生效、409/400/403 反例、权限组跨界面一致、恢复只读与字段过滤、能力缺失 501 |

无新依赖；GUI 仍只消费公共应用服务与其 DTO，未复制预算、权限或恢复状态机；未把状态目录、租约进程标识或凭据引用暴露给前端。

## 2. 行为反例（先写反例，逐条验证）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 界面改预算只改 DTO/缓存，下一次模型请求仍用旧预算 | 下一真实装配使用新 revision | ✅ 首个任务装配 r1；`POST /commands/set-context-budget`（4096→2048，r1→r2）后第二个任务装配 `lastAssemblyBudgetPolicyRevision=2`，样本数增加（事件来自真实 `context-assembly` 记录） |
| 过期 revision 写入覆盖并发修改 | 409 且不改状态 | ✅ 409 `stale-revision`；随后 `GET /settings` 仍 r1 |
| 负数/非整数预算 | 400 | ✅ 400 `invalid-arguments` |
| 状态变更缺 CSRF | 403 | ✅ 403（沿用统一 CSRF 门禁） |
| 权限组切换仅在浏览器本地生效 | 跨界面一致 | ✅ 切到 ponder 后 SDK 门面 `getCurrentPermissionProfileReference()` 与 `GET /settings` 同值；非法 builtin id 400 |
| 界面能力缺失时静默返回空数据 | 显式失败 | ✅ `GET /recovery`、`POST /commands/set-context-budget` 返回 501 `capability-unavailable`；`GET /settings` 明确 `context: null` |
| 恢复视图泄漏内部字段/路径 | 不出现 | ✅ `GET /recovery` 无 `leaseProcessInstanceId`、无状态目录绝对路径；`inspectRecoveryMission` 视图同样不含该字段 |
| 预算/设置响应泄漏敏感信息 | 不出现 | ✅ 响应不含状态目录、`protectedCredentialReferenceId`、`.env` 字样 |

## 3. 公共入口真实调用控制器（非桩）

- `POST /commands/set-context-budget` → `AstarrayApplicationFacade.updateContextBudget` → 真实 `GlobalContextBudgetStore.updatePolicy`（CAS + 单调 revision + 原子写 `global-context/budget-policy.json`）；`GET /settings` 的 `assemblySampleSize`/`lastAssemblyBudgetPolicyRevision` 来自真实 `ContextRuntimeEventStore`（Worker 装配时由 `createContextPromptProvider` 写入 `budgetPolicyRevision`）。
- `POST /commands/switch-permission-profile` → `MainController.switchPermissionProfile` → 当前权限选择存储（持久化，写入自动备份）；SDK/CLI 读到同一选择。
- `GET /recovery` → 真实 `RecoveryCenterController.listMissions()`（`MissionManager` + 检查点存储 + 租约存储，磁盘状态与损坏标记）；`inspectRecoveryMission` 走 `inspectMission()`。
- 说明：恢复的**续接/裁决写入**（`resumeMission`、人工签收）不在本轮，属 03b；本轮只做只读状态与差异接入，避免把半套裁决流程当已交付。

## 4. 测试与门禁（命令 / 退出码 / 结果）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 |
| `npx eslint .` | 0 |
| `npx vitest run tests/gui` | 0；**28 passed**（5 文件，新增 5 用例） |
| 关联回归 `public-sdk`/`application-sdk-*`/`cli-sdk-parity`/`context-*` | 0；20 passed（6 文件） |
| `npm run check` / `npm run test:coverage` | **未完成（不得视为通过）**：受限沙箱下 `tsup`（esbuild 服务）与 forks 池需管道子进程，报 `spawn EPERM`；升级 `danger-full-access` 重试 4 次均在审批通道等待 600s 超时、命令未实际执行。下一阶段带审批重跑，并连带补跑累积的 tarball 回归 |

## 5. 未满足项与剩余风险（不声称已验收）

- 03b：已验收/待追认（`HumanVerificationController.listDeferredVerificationTasks`）、人工裁决（`recordUserAcceptance`/`recordUserRejection`）、各 Agent 上下文隔离的前端呈现——本轮未实现，未标记 done。
- 断线重连自定义退避、真实浏览器键盘/中文/缩放/可访问性人工体验 → GUI-01-R-04。
- Linux/macOS 未验证（仅 Windows 本机）。
## 6. 提交与推送

- 实现提交：见 git 记录（本检查点文件：`application-runtime.ts`、`public-sdk.ts`、`gui-server.ts`、`tests/gui/integration/gui-settings-recovery.test.ts`、本证据与任务卡）。
- 门禁/推送状态：`npm run check` 与 `npm run test:coverage` 因审批通道不可用未执行（4 次升级重试均 600s 超时）；`git push` 同因跳过，累积到下一阶段与 `b5e3be1` 一并推送。
