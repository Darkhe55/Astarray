# GUI-01-R-01 旧卡依赖与 UI 范围冻结 — 证据

> 检查点：GUI-01-R-01（docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md）
> 前驱：T07D-R1（已完成）；功能联测依赖 T09A-R1/T12A-R1（均已完成）。日期：2026-09-13
> 被增补的旧卡：docs/tasks/GUI_MVP_CODING_TASK_CARD.md（GUI-01）

## 1. 现状核对（真实可用 vs 占位）

| 项 | 结论 |
| --- | --- |
| `packages/gui/` 现有文件 | **仅 `README.md`（预留说明）**，无实现、未进入构建入口、未向用户宣称交付 |
| 旧 GUI-01 卡 | 存在且要求完整（`astarray gui`、loopback HTTP + SSE、Host/Origin/CSRF、脱敏 DTO、原生 HTML/SVG、无新依赖、`tests/gui/`、打包验收、关键安全与状态分支覆盖率 ≥95%） |
| GUI-01-R 关系 | 本卡取代旧序 `B6R-10 → GUI-01 → T08B`（该边已由 INT-00 作废），界面统一消费公共应用服务 |
| 界面技能 | 当前技能目录（本会话可用清单）中**无适用前端/界面技能**（仅媒体生成与 TapTap 工具类）；不引入未核对的外部技能 |

## 2. 首期视图冻结（六类）

| 视图 | 权威来源（唯一状态机） | 首期状态 |
| --- | --- | --- |
| 会话 | `AstarrayApplicationFacade`：`createSession`/`openSession`/`listSessions`/`getActiveMissionIds`/`transitionMode`/`shutdown`（`PublicSessionState`） | ✅ 真实可用 |
| 任务图 | 任务链与 revision 由 `MissionManager.getMissionStatus(missionId).taskChain`（`revision`、`tasks[].status/dependsOn/priorityTier`）提供；当前公开 `queryMission` 只返回 `{missionIdentifier, status}` | ⚠ **需 Phase-2 只读 read model**（公开 façade 补齐 task chain + revision） |
| Agent 身份 | 运行时 `registeredAgentDirectory`（登记/校验）与工作存档；**无枚举读取**接口 | ⚠ 占位：Phase-2 需按 `agentInstanceId` 的只读列表（角色/所属上级/状态/预算） |
| 权限 | façade：`getCurrentPermissionProfileReference`/`listPermissionProfiles`/`switchPermissionProfile`/`grantSessionAuthorization`；会话提升与待处理请求在 `MainController`/反馈通道 | ⚠ 部分可用：profile 摘要可用；待处理权限/安装/备份请求需 Phase-2 只读视图 |
| 上下文 | T09A-R1：`context status`/`context metrics`/`context recall`（CLI）+ 运行时上下文存储与装配事件 | ⚠ 占位：Phase-2 只读视图（全局预算 revision、待追认、关闭胶囊、指标） |
| 恢复 | T12A-R1：`RecoveryCenterController`（`listMissions`/`inspectMission`/`resumeMission`/`abandonMission`）+ CLI `recover list/show/resume/abandon` | ⚠ 占位：Phase-2 只读视图（磁盘状态、损坏标记、检查点/对账、裁决项） |

**无重复核心状态机**：GUI 只调用公共应用服务/只读 read model；不复制权限、安装、备份、Agent 身份、任务偏序或恢复规则；所有变更请求经本地控制面重新裁决。

## 3. 公共事件的 revision 要求（当前缺口，Phase-2 关闭）

- 冻结的事件信封（SSE）：`{ eventType, revision, idempotencyId, payload }`；`revision` 取对应权威来源的版本：
  任务链 `taskChain.revision`、上下文图 `graphRevision`、全局预算 `globalContextBudgetPolicyRevision`、报告/摘要 `summaryRevision`（SUM 系列接入后）、恢复检查点 `checkpointRevision/leaseRevision`。
- **当前缺口**：公开事件类型 `PublicAstarrayEvent` 仅含 `session-status`/`task-status`/`task-finished`，**不带 revision 或幂等 ID**（`public-sdk.ts`）。
  → GUI-01-R-02 需在不破坏既有消费者的前提下扩展事件负载（新增字段视为向后兼容），并在测试中锁定「revision 跳跃即重新拉取快照、前端不猜测合并」。
- 断线重连：有界退避 1–30 秒，上限不超过单次退避上限 `pn`（3 小时）；重连后先取完整快照再续订阅。

## 4. 首期范围之外（明确不声明）

- 多人编辑、媒体工作台、细节微淘 → WB 系列。
- 真实浏览器人工体验结论（键盘/中文/200% 缩放/窄屏）→ GUI-01-R-04（需人工）。
- 非 loopback/局域网/公网访问、WebSocket、Electron/Tauri、图表库、CSS 框架 → 不做（旧卡禁止）。

## 5. 依赖与风险（供下一检查点决定）

| 项 | 状态 |
| --- | --- |
| 新依赖 | 旧卡禁止新增依赖；GUI 测试需在**无 DOM 库**前提下进行（断言服务端 HTML 字符串、协议与安全反例；真实浏览器验收留给 -04 人工） |
| 浏览器自动化 | 未确认本地是否有可用浏览器/驱动；按协同安装门禁**先询问用户是否已有资源**，不隐式下载 |
| 平台 | 仅 Windows 本机可执行；Linux/macOS 保持未验证 |

## 6. 旧卡更新（顶部依赖/范围）

已在 `docs/tasks/GUI_MVP_CODING_TASK_CARD.md` 顶部补充：GUI-01-R 接管关系、首期视图冻结与真实可用/占位划分、revision 事件要求与当前缺口、以及"未实现即不宣称交付"。
