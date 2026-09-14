# GUI-01-R-02 本地服务和基础工作流 — 证据

> 检查点：GUI-01-R-02（docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md）
> 前驱：GUI-01-R-01（done，docs/reports/GUI01_R_01_SCOPE_FREEZE.md）。日期：2026-09-13
> 被增补的旧卡：docs/tasks/GUI_MVP_CODING_TASK_CARD.md（loopback/Host/Origin/CSRF、SSE、清洗、收口、无新依赖）

## 1. 范围与实现清单

| 文件 | 变更 |
| --- | --- |
| `packages/core/src/public-sdk.ts` | 关闭 R-01 记录的 revision 缺口：`PublicAstarrayEvent` 全事件追加 `revision` 与 `idempotencyId`；`TaskRecord` 增加 `revision` 并从 `taskChain.revision` 读取；新增 `nextEventIdempotencyId`/`nextSessionEventRevision`，6 处 emit 点全部带版本与幂等 ID |
| `packages/gui/src/application/gui-read-model.ts`（新） | 只读视图模型：事件→任务跟踪→脱敏快照（`GuiTaskView`/`GuiSnapshot`）；revision 取最大值，乱序/重复事件不回退 |
| `packages/gui/src/server/gui-server.ts`（新） | 本地宿主：loopback HTTP、`GET /`、`GET /state`、`GET /events`（SSE）、`POST /commands/submit`、`POST /commands/cancel`；Host/Origin/CSRF 校验；输入清洗；HTML 转义；监听失败有界拒绝；`close()` 收口 |
| `packages/tui/src/cli/commands.ts` | `executeGuiServeCommand`：复用 `AstarrayApplicationFacade`（createSession→startGuiServer→等待本地关闭信号→close/shutdown），默认打开浏览器、端口校验 |
| `packages/tui/src/cli.tsx` | `astarray gui [--port <n>] [--no-open]` |
| `tests/gui/`（新，4 文件 23 用例） | 集成：`gui-server.test.ts`(11)、`gui-command.test.ts`(2)；单元：`gui-server-security.test.ts`(7)、`gui-read-model.test.ts`(3) |

无新依赖（仅 Node 内置 `node:http`/`node:crypto` + 既有 zod/commander）；GUI 源码只依赖 `packages/core`，未依赖 tui/Ink，未复制核心状态机。

## 2. 行为反例（先写反例，逐条验证）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| `host: "0.0.0.0"`/`"192.168.1.10"` 启动 | 启动前拒绝 | ✅ `startGuiServer` rejects `/loopback/`（未监听任何外部地址） |
| `Host: evil.example` | 403 且不进入路由 | ✅ 403 `loopback-host-origin-required` |
| 跨 Origin（`Origin: http://evil.example`）+ 正确 CSRF 的 POST | 拒绝 | ✅ 403 且 `submitTask` 调用数为 0 |
| 缺失/错误 `x-csrf-token` 的 POST | 拒绝 | ✅ 403 `csrf-required` 且调用数为 0 |
| 输入含控制字符与 HTML 注入（`"  生成\u0007报告 <b>x</b>  "`） | 去控制字符、限长 4000、去首尾空白 | ✅ 收到 `"生成报告 <b>x</b>"`，页面渲染经 `escapeHtmlText` 输出实体 |
| 空/纯空白 prompt | 400 | ✅ 400 `prompt-required` |
| 提交回执被误当完成 | 受理≠完成 | ✅ 202 `{status:"accepted", isCompleted:false}`，真实任务随后由公共门面推进到 `done` |
| SSE 首帧与推送事件 | 首帧快照带 `id:`/`revision`，推送事件带幂等 ID | ✅ 断言 `revision:7`、`idempotencyId:"event-sse-1"`；首轮断言先于推送帧到达而失败（红），改为等待推送事件幂等 ID 后通过（绿） |
| 重连（`Last-Event-ID`） | 回完整快照且含离线期间任务 | ✅ 快照 `isReconnect:true` 且包含离线期间提交的 `gui-task-*` 与 `mission-for-*` |
| 监听端口被占用 | 有界拒绝，不悬挂 | ✅ 首次实现监听错误未拒绝（红）；改为 `server.once("error", reject)`；测试 `.rejects.toThrow()` 通过 |
| 关闭后收口 | 端口释放、SSE 结束、订阅取消、无孤儿 | ✅ 关闭后同端口可再次绑定；打包进程 kill 后 `PORT_4189_LISTENING=False` |
| `astarray gui --port 70000` | 用法错误 2，不改状态 | ✅ 返回 2 且 stderr 含「端口无效」 |

## 3. 公共入口真实调用控制器（非桩）

- 测试 `tests/gui/integration/gui-server.test.ts > 经 GUI 命令提交真实任务并由公共应用服务完成`：`POST /commands/submit` → 真实 `AstarrayApplicationFacade.submitTask` → 轮询 `queryTask` 至 `done`（mock Provider 运行时），证明 GUI 只是公共门面的消费者。
- 测试 `tests/gui/integration/gui-command.test.ts`：调用 CLI 公共入口 `executeGuiServeCommand`（port 0），打印真实 loopback URL，`GET /state` 返回 `{sessionId:"gui-session-local",mode:"assist",connectionStatus:"connected"}`；关闭信号后该 URL 连接失败。
- 打包产物冒烟：`node dist/cli.js gui --port 0 --no-open` → `Astarray GUI 已启动：http://127.0.0.1:4189/`；`GET /` 200（3554 字节，`Set-Cookie: gui_csrf=…; SameSite=Strict; HttpOnly`），`GET /state` 返回脱敏 JSON；终止后端口释放。

## 4. 测试与门禁（命令 / 退出码 / 结果）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0（无类型错误） |
| `npx eslint .` | 0（含 `packages/gui/**`、`tests/gui/**`） |
| `npx vitest run tests/gui`（4 文件） | 0；**23 passed** |
| `npm run check`（typecheck+lint+build+test） | build 通过；用例 183/184 文件、1553/1554；唯一失败为既有计时波动 `provider-runtime-registry.test.ts`（5s 超时），隔离复跑 6/6 通过 |
| `npm run test:coverage` | **0；184 文件 / 1554 用例全通过**；全局 statements 93.52% / branch 86.44% / functions 91.68% / lines 93.55%（阈值 85） |
| 打包 CLI 冒烟（见 §3） | 页面/状态/退出收口均符合 |

说明：受限文件沙箱下 `tsup`（esbuild 服务）与 forks 池/spawn 类用例会因管道子进程 `spawn EPERM` 失败，上述 check/coverage 在获准的完整访问下一次通过；未使用 `--pool=threads` 的结果冒充正式门禁。

## 5. 未满足项与剩余风险（不声称已验收）

- 真实浏览器人工体验（键盘、中文输入法、200% 缩放、窄屏、可访问性、视觉）→ GUI-01-R-04 人工项，本检查点不做结论。
- 断线重连的客户端退避使用浏览器原生 `EventSource` 自动重连（间隔约 3 秒，落在旧卡 1–30 秒区间）并依赖服务端首帧快照；自定义退避与「最大等待不超过 3 小时」的端到端体验校验留给 -04。
- Linux/macOS 未验证（仅 Windows 本机）。
- 设置与恢复交互（预算/权限组/恢复差异）属 GUI-01-R-03，本检查点不声明。
## 6. 提交与推送

- 实现提交：`b5e3be1` `feat(gui): GUI-01-R-02 本地宿主、SSE 状态接口与 astarray gui 入口`（11 文件，+1479/−16；仅暂存本检查点文件，用户并行改动保持未暂存）。
- 推送尝试：`git push` 共 4 次。第 1 次（普通沙箱）失败：`couldn't create signal pipe, Win32 error 5` → `Could not read from remote repository`（exit 128）。第 2–4 次按沙箱拒绝规则升级 `danger-full-access` 重试，3 次均在审批通道等待 600s 超时、命令未实际执行（无对应后台作业）。
- 结论：本轮跳过上传，按用户常设 Git 规则把 `b5e3be1` 累积到下一阶段完成时一并再试（单阶段上限 5 次，已用 4 次）。
