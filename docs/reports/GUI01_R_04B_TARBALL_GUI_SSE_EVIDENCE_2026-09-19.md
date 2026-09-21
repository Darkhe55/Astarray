# GUI-01-R-04b 安装产物级 GUI 提交与 SSE 契约证据（2026-09-19）

> 检查点：GUI-01-R-04b 的"从 tarball 隔离安装打开 GUI"在**提交路径与 SSE 契约**上的脚本化部分
> 脚本：`scripts/verify-gui-sse-reconnect.mjs`（Node 标准库；真实 HTTP，无浏览器、无模型）
> 产物：隔离安装的 `astarray-0.1.0.tgz`（sha256 `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f`，215 文件）→ `.tmp/package-smoke/2026-09-19T15-18-50.235Z-903399c9-5a93-4213-b8d9-f2d9f76e85a7/node_modules/astarray/dist/cli.js`
> 执行：`node scripts/verify-gui-sse-reconnect.mjs "<上述 cli.js 路径>"` → **27/27 通过，exit 0**（其中 1 项为明确标注的缺陷观察）
> 结论：提交路径与 SSE 首帧/重连的**服务端契约**已由安装产物级证据覆盖；浏览器自动重连与视觉/键盘/中文/缩放仍属人工项。

## 1. 实测结果

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | GUI 打印 loopback URL | 通过：`http://127.0.0.1:6777/` |
| 2 | `GET /` 200 且下发 CSRF cookie | 通过：`gui_csrf` 存在且 `HttpOnly` + `SameSite=Strict` |
| 3 | 无 CSRF 的提交被拒 | 通过：`403 {"error":"csrf-required"}` |
| 4 | 带 CSRF 提交（第 1 次） | 通过：`202`，`taskIdentifier=gui-task-…`、`missionIdentifier=mission-…`、`status=accepted`、`isCompleted=false` |
| 5 | 带 CSRF 提交（第 2 次） | 通过：`202` |
| 6 | `GET /state` 反映真实提交 | 通过：`tasks=2`、`missions=2`，含两次提交的标识 |
| 7 | `GET /events` 首帧 | 通过：`text/event-stream`；`eventType=snapshot`、`isReconnect=false`、含两条任务且标识与 `/state` 一致 |
| 8 | 带 `last-event-id` 重连首帧 | 通过：`eventType=snapshot`、`isReconnect=true`、标识仍与 `/state` 一致 |
| 9 | 重连不产生重复任务/任务链 | 通过：`tasks=2`、`missions=2`，标识集合逐项相同 |
| 10 | 终止后端口释放 | 通过：`released=true` |

## 1b. 取消后收敛（追加 3 项，2026-09-19）

| # | 检查 | 结果 |
| --- | --- | --- |
| 11 | `POST /commands/cancel` | 通过：`200`、`{"taskIdentifier":"gui-task-…","status":"cancelled"}` |
| 12 | 取消后 `GET /state` 收敛 | 通过：`observed=cancelled`（轮询上限 8s 内收敛，实测立即收敛） |
| 13 | 取消后带 `last-event-id` 重连快照 | 通过：该任务 `status=cancelled`、`isReconnect=true` |

要点：取消是经**公共入口**真实触发控制器并改变状态的路径（不是只改界面），且快照随事件收敛——说明 GUI 跟踪器由事件驱动而非启动时缓存。

## 1c. 设置写入与陈旧 revision（追加 7 项，2026-09-19）

| # | 检查 | 结果 |
| --- | --- | --- |
| 14 | `GET /settings` 返回上下文预算与 revision | 通过：`budgetPolicyRevision=1`、`configuredMaximumGlobalContextTokenCount=4096` |
| 15 | 带 CSRF 写入预算 | 通过：`200`，`budgetPolicyRevision=2`、tokens=`5330`（基线 +1234） |
| 16 | 重新读取 `/settings` | 通过：`revision=2`、`tokens=5330`（持久化生效，非内存回显） |
| 17 | 陈旧 revision 写入 | 通过：`409 {"error":"stale-revision"}`（不静默覆盖） |
| 18 | 非法参数（负数预算） | 通过：`400 {"error":"invalid-arguments"}` |
| 19 | 无 CSRF 的预算写入 | 通过：`403 {"error":"csrf-required"}` |
| 20 | 三次被拒写入后再读取 | 通过：已持久化值未被改变（仍为 `5330`） |

要点：预算写入经**公共入口 + 真实控制器**（revision 递增并由重新读取确认持久化），并具备三重保护——陈旧 revision `409`、参数校验 `400`、CSRF `403`；被拒写入不产生副作用。

## 1d. 权限组切换与非法输入（追加 7 项，2026-09-19）

| # | 检查 | 结果 |
| --- | --- | --- |
| 21 | `GET /settings` 返回当前权限组与可用列表 | 通过：`current` 为内置引用，`available` 为数组 |
| 22 | 切换内置权限组 | 通过：`200 {"status":"switched","reference":{...}}` |
| 23 | 重新读取 `/settings` | 通过：`permissionProfiles.current` 已变为目标组 |
| 24 | 非法内置组（`not-a-builtin-profile`） | 通过：`400 {"error":"invalid-arguments"}` |
| 25 | **缺陷观察**：不存在的自定义组 | **当前返回 `200 switched`**（非期望行为），详见 `docs/reports/GUI01_R_04B_DANGLING_PROFILE_SELECTION_FINDING_2026-09-19.md` |
| 26 | 无 CSRF 的权限组切换 | 通过：`403 {"error":"csrf-required"}` |
| 27 | 校验后恢复原权限组 | 通过：`200`（不遗留测试状态） |

要点：内置组切换与三类拒绝（非法参数 400、CSRF 403、陈旧 revision 409 见 §1c）都符合预期；**唯一非期望行为**是第 25 项——公共入口接受并持久化不存在的自定义权限组，未见权限放大（解析侧 fail-closed），但报错码误用 `task-sequence-not-found`，已在 FINDING 文档记录并给出待授权的修复方案。

## 2. 关键观察（写进断言依据）

- **CSRF 是真实门禁**：`GET /` 下发 `HttpOnly; SameSite=Strict` cookie；`POST /commands/submit` 缺 `x-csrf-token` 一律 `403 csrf-required`，不被"首帧快照/只读接口"顺带放行。
- **受理 ≠ 完成**：提交返回 `202` 与 `isCompleted=false`；状态推进通过后续快照可见。
- **快照是活视图**：两次请求之间 mock 任务状态从 `accepted` 推进到 `running`（检查 7/8 的 detail 记录了两侧状态），因此断言用"任务/任务链**身份** + 会话字段一致"而不是整份 JSON 全等；这同时证明快照取自读取时刻的真实状态，而非启动时缓存。
- **重连语义**：带 `last-event-id` 时首帧仍回**完整快照**并标记 `isReconnect=true`，任务与任务链标识集合不变（无重复）；这正是"服务重启/页面刷新后首帧完整、无重复任务"的服务端一侧保证。
- **资源回收**：`SIGKILL` 终止后端口拒绝连接（`released=true`），无孤儿监听。

## 3. 未覆盖（仍属人工项）

浏览器 EventSource 自动重连的**实际表现**、键盘全流程、中文输入法、200%/≤400px 缩放、深色模式与屏幕阅读器、差异/追认与 CLI 逐项对照、真实中断续接。清单见 `docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md` §4。

## 4. 复现与沙箱说明

```bash
node scripts/verify-gui-sse-reconnect.mjs "<安装目录>/node_modules/astarray/dist/cli.js"
```

该脚本以管道 stdio 启动 GUI 子进程，受限文件沙箱下会 `spawn EPERM`（本会话已多次复现），需一次性完整访问；脚本使用工作区内临时目录作为状态目录，不触碰用户状态。
