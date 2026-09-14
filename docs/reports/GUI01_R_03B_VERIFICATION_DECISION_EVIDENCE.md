# GUI-01-R-03b 待追认与人工裁决 — 证据

> 检查点：GUI-01-R-03（03b，docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md）
> 前驱：GUI-01-R-03a（done，docs/reports/GUI01_R_03_SETTINGS_RECOVERY_EVIDENCE.md）。日期：2026-09-13

## 1. 范围与实现清单

| 文件 | 变更 |
| --- | --- |
| `packages/core/src/application/application-runtime.ts` | 暴露 `humanVerificationController`、`contextClosureCapsuleStore`、`contextGraphStore`（原本仅内部局部变量），使 GUI/SDK 与产品任务路径共用同一核验与上下文存储 |
| `packages/core/src/public-sdk.ts` | 新增 `PublicPendingVerification`/`PublicVerificationDecisionResult`；新增 `listPendingVerifications()`（按 owner `agentInstanceId` 分组，不合并上下文）与 `recordVerificationDecision()`（读延迟核验任务 → 按胶囊内容哈希定位所属 mission/图 → 签收或否决；域错误码映射；跨 Agent 一律 404） |
| `packages/gui/src/server/gui-server.ts` | 端口新增 `listPendingVerifications`/`recordVerificationDecision`；新增 `GET /verifications`、`POST /commands/verification-decision`（404 未找到/无上下文、409 签字过期、能力缺失 501）；页面新增"待追认（按 Agent 隔离）"面板，逐条绑定 owner 与追认/否决按钮 |
| `tests/gui/integration/gui-verification-decision.test.ts`（新，4 用例） | 真实 Devolve 任务链路：列表、追认落盘、跨 Agent 拒绝、陈旧签字 409、否决重开节点 |

无新依赖；核验任务/胶囊/图的读写全部经真实控制器，GUI 不复制核验或恢复状态机；不同 Agent 的待追认项按 owner 分列，签收只写入该 owner 的存档。

## 2. 行为反例（先写反例，逐条验证）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 待追认列表把多个 Agent 的上下文合并成一个视图 | 按 owner 隔离 | ✅ `GET /verifications` 每条带 `ownerAgentInstanceId`；条目只来自对应 Agent 的延迟核验目录 |
| 用别的 Agent 身份裁决任务 | 拒绝且不写对方存档 | ✅ 404 `verification-not-found`；`agent-memory/another-agent-instance/acceptances` 不存在 |
| 签字不绑定上下文图 revision（图已前进仍签收） | 过期即失败 | ✅ 先 `markNodeState` 使图前进，再追认 → 409 `stale-revision`，且未生成签收文件 |
| 签收只在前端"看起来成功" | 真实存档变化 | ✅ 追认返回 `acceptanceIdentifier`，`agent-memory/<owner>/acceptances/<id>.json` 存在且 `contextGraphRevision` 等于签字时图 revision、`nodeIdentifiers` 为被核验节点 |
| 否决造成破坏性回滚/删除产物 | 只重开节点 | ✅ 否决返回 `reopenedNodeIdentifiers`，图中该节点 state 由 `deferred-review-closed` 变为 `reopened`；待追认项与产物仍在 |
| 裁决入参缺失/非法 | 400 | ✅ owner/task/decision 缺失或非法 → 400 `invalid-arguments` |

## 3. 公共入口真实调用控制器（非桩）

- 待追认来源：真实产品路径 `Devolve` 任务经门面完成后，`ContextNodeLifecycleController` 生成 `deferred-review-closed` 胶囊与层级 1 延迟核验任务（`agent-memory/<owner>/deferred-verification-tasks/verify-*.json`）。
- `GET /verifications` → `HumanVerificationController.listDeferredVerificationTasks(owner)`（逐 owner 读取，owner 取自本地存档目录）。
- `POST /commands/verification-decision`（accepted）→ `HumanVerificationController.recordUserAcceptance`，写入 `acceptances/*.json`；签字绑定 `contextGraphRevision`。
- `POST /commands/verification-decision`（rejected）→ `HumanVerificationController.recordUserRejection` → `LocalContextGraphStore.reopenNode`（只重开节点，不删除产物）。
- 所属 mission/图由 `ContextClosureCapsuleStore.listCapsules(owner)` 中 `contentHash === closureCapsuleHash` 的胶囊解析（`missionId` 即图标识），不猜测、不跨 Agent 兜底。

## 4. 测试与门禁（命令 / 退出码 / 结果）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 |
| `npx eslint .` | 0 |
| `npx vitest run tests/gui` | 0；**32 passed**（6 文件；本检查点新增 4 用例） |
| 关联回归（public-sdk / application-sdk-task-events / context-node-lifecycle / human-verification-controller） | 0；27 passed |
| `npm run check` / `npm run test:coverage` | **未完成（不得视为通过）**：受限沙箱下 `tsup`（esbuild 服务）与 forks 池报 `spawn EPERM`；升级重试 2 次均在审批通道等待 600s 超时、命令未执行 |

## 5. 未满足项与剩余风险（不声称已验收）

- 真实浏览器人工体验（键盘、中文输入法、缩放、可访问性、视觉）与从安装包打开 GUI → GUI-01-R-04（人工结论，不能用自动断言替代）。
- 断线重连自定义退避的端到端体验校验 → GUI-01-R-04。
- Linux/macOS 未验证（仅 Windows 本机）。
## 6. 提交与推送

- 实现提交：`4ed4c14` `feat(gui): GUI-01-R-03b 待追认与人工裁决（按 Agent 隔离）`（6 文件，+727/−5；仅暂存本检查点文件，用户并行改动保持未暂存）。
- 门禁状态：`npm run check` 与 `npm run test:coverage` 因审批通道不可用未执行（升级重试 2 次均 600s 超时）；本地等价证据：`npx tsc --noEmit` 0、`npx eslint .` 0、GUI 32 用例与关联 27 用例全通过。**门禁缺口按未通过记录。**
- 推送状态：`git push` 受限沙箱失败（`couldn't create signal pipe, Win32 error 5`，exit 128）；升级重试因审批通道不可用未执行。累积待推送：`b5e3be1`、`2dd9fdd`、`12e80eb`、`6cb1a2d`、`4ed4c14`。
---

## 附：门禁/推送缺口补齐（2026-09-13）

本文件正文记录的"门禁未完成/推送跳过"已在本轮补齐并验证：`npm run check`、`npm run test:coverage`（93.61/86.40/91.98/93.64，187 文件 1566 用例）、`verify:security-coverage`（22/22）、`npm pack`+`verify-package`（207 文件）+`smoke-install` 均 exit 0；`git push` 成功 `0946530..28705b2`。详见 `docs/reports/PRODUCT_INTEGRATION_SESSION_HANDOFF_2026-09-12.md` §6。
