# GUI-01-R-04b 从隔离安装包启动 GUI 冒烟证据（2026-09-19）

> 检查点：GUI-01-R-04b 的"从 tarball 隔离安装打开 GUI"自动部分在返修提交上的重跑
> 安装来源：`astarray-0.1.0.tgz`（sha256 `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f`，215 文件，mtime `2026-09-19T23:18:48Z`）经 `scripts/smoke-install.mjs` 隔离安装
> 安装目录：`.tmp/package-smoke/2026-09-19T15-18-50.235Z-903399c9-5a93-4213-b8d9-f2d9f76e85a7`
> 执行：`node node_modules/astarray/dist/cli.js gui --port 0 --no-open`（状态目录 = 安装目录内 `.astarray`，即工作区内）
> 结论：**自动部分全部通过**；浏览器级人工体验与 macOS 证据仍未做，04b 保持 in_progress。

## 1. 结果

| 项 | 实测 |
| --- | --- |
| 启动输出 | `Astarray GUI 已启动：http://127.0.0.1:6649/（仅监听本机 loopback）` |
| `GET /` | 200，12415 字节，含 `<!DOCTYPE html>` |
| `GET /state` | 200，`{"sessionId":"gui-session-local","mode":"assist","connectionStatus":"connected","tasks":[],"missions":[]}` |
| 状态脱敏 | 无 Windows 绝对路径、无仓库路径、无 `apiKey|token|secret|password` 字样 |
| 终止后端口 | 6649 无监听（`port-released=True`） |
| 二次运行端口 | 6783，同样 200/200，终止后无监听 |
| 进程回收 | node 进程数 3 → 3，无孤儿；6649/6783 均无 listener |
| 隔离安装状态目录 | 仅生成 `agent-memory`、`backup-vault`、`context-runtime`、`missions` |

日志与产物：`.tmp/gui01-r-04b/gui-stdout.log`、`gui-stdout2.log`、`gui-state.json`（`.tmp/` 已 gitignore）。

## 2. 与门禁方式的差异（可复用结论）

本冒烟**无需** `danger-full-access`：只要把启动目录放在工作区内的隔离安装目录，`defaultStateDirectory()` 解析为 `<cwd>/.astarray`，全部写盘都落在工作区内；`node` 由 pwsh 直接启动，不经 npm shim，因此不触发受限沙箱下的 `spawn EPERM`。此前"打包需完整访问"的结论只针对 `npm pack`/`tsup`/`vitest`（vite 的 `exec`）链路。

## 3. 过程说明（不掩盖）

第二轮用 `Invoke-WebRequest http://127.0.0.1:6783/events` 探测 SSE：该端点按设计是长连接，3s 内不返回，该行抛错导致脚本在终止/端口核对之前退出。随后独立核对：6783 与 6649 均无监听、node 进程数回到基线（3），确认无残留。SSE 首帧快照与断线重连属人工体验项，本文件不作结论。

## 4. 未做与残留

- 键盘全流程、中文输入法、200% 缩放/≤400px、深色模式+屏幕阅读器、提权交互、差异/追认与 CLI 一致、恢复、SSE 断线重连、资源观察的**人工结论**仍未做（需真实用户，按 `docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md` 逐项填写）。
- Linux/macOS 平台证据仍未做；平台表不更新。
