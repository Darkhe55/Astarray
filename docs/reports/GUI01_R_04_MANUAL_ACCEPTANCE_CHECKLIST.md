# GUI-01-R-04 人工体验与打包验收清单（待执行）

> 检查点：GUI-01-R-04（docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md）
> 状态：**人工项未执行**（§0 的 Windows 侧打包与"从安装包启动 GUI"已由自动证据覆盖，见 §4；§1 十项人工体验与平台证据仍待执行）。自动断言（tests/gui）不能替代本清单的真实用户结论；执行后逐项填写实测与证据。
> 前置：打包与门禁命令需完整访问（受限沙箱下 tsup/esbuild、forks 池与 npm 安装会 `spawn EPERM`）。

## 0. 从安装包启动（打包验收）

| 项 | 命令/步骤 | 期望 |
| --- | --- | --- |
| 打包 | `npm run check` → `npm pack` | 退出码 0；产出 `astarray-0.1.0.tgz` 并记录 SHA256 |
| 包内容 | `node scripts/verify-package.mjs <tarball 实际路径>` | 退出码 0；无源码/测试/凭据泄漏 |
| 隔离安装 | `node scripts/smoke-install.mjs` | 退出码 0；隔离目录安装后 CLI 可运行 |
| 从安装包打开 GUI | 隔离目录内 `npx astarray gui --no-open` | 打印 loopback URL；浏览器打开后页面正常 |

## 1. 人工体验（真实用户完成，一次提交→授权→查看差异→验收→恢复）

| # | 项 | 步骤 | 期望 | 实测 | 结论 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 键盘 | 仅用 Tab/Shift+Tab/Enter/Space 完成提交与追认 | 焦点顺序合理、焦点可见、无鼠标依赖 | | | |
| 2 | 中文 | 中文输入法组词并提交；查看任务与结果 | 中文完整无损、无乱码/截断 | | | |
| 3 | 缩放 | 200% 浏览器缩放、≤400px 窄屏 | 无横向滚动、控件不重叠 | | | |
| 4 | 可访问性 | 系统深色模式 + 屏幕阅读器朗读状态区 | 对比度可读、aria-live 正确播报 | | | |
| 5 | 提交→授权 | 提交任务并在权限/安装请求出现时授权 | 界面反映真实裁决结果，不自动放行 | | | |
| 6 | 查看差异 | 恢复中心查看磁盘状态/损坏/检查点/对账差异 | 与 CLI `recover list/show` 一致 | | | |
| 7 | 验收 | 对"待追认"项追认/否决 | 追认写入签收；否决重开节点；两者与 CLI 状态一致 | | | |
| 8 | 恢复 | 中断服务/进程后用恢复续接 | 无重复副作用；任务顺序不清零 | | | |
| 9 | 断线恢复 | 服务重启后保持页面 | EventSource 自动重连、首帧快照完整、无重复任务 | | | |
| 10 | 资源观察 | 关闭页面并终止命令 | 端口释放、无孤儿 node 进程、无残留 SSE | | | |

## 2. 平台证据

| 平台 | 状态 | 备注 |
| --- | --- | --- |
| Windows（本机） | 待执行 | 本清单默认平台 |
| Linux | 未验证 | 需专用环境 |
| macOS | 未验证 | 需专用环境 |

## 3. 记录

- 执行人 / 日期 / 环境（浏览器与版本、操作系统、缩放比例）：
- 未通过项与返修去向：
- 对照的自动证据提交（§4 使用）：


## 4. 自动证据覆盖图（2026-09-19 追加）

> 目的：把"已由自动化证据覆盖"与"必须人工确认"分开，减少人工执行时的重复判断。
> 对照提交：`fd941b2` / `3f9d5a1`（Windows 本机；Linux/macOS 仍未验证）。
> 注意：自动证据**不能**替代本清单的人工结论，下表只标注"哪些已可复核、哪些必须人来看"。

| 检查项 | 已有自动证据（可先复核） | 仍需人工确认 |
| --- | --- | --- |
| §0 打包 | `npm pack`（215 文件）+ `verify-package.mjs` exit 0 + `smoke-install.mjs` exit 0；tarball sha256 `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f`（2026-09-19T23:18:48Z）；证据 `docs/reports/GUI01_R_04B_WINDOWS_PACKAGING_EVIDENCE_2026-09-19.md` | 仅需在 Linux 同提交复跑 |
| §0 从安装包打开 GUI | 隔离安装目录内启动 → `GET /` 200（12415 字节、含 DOCTYPE）、`GET /state` 200 且脱敏、终止后端口释放；证据 `docs/reports/GUI01_R_04B_TARBALL_GUI_SMOKE_EVIDENCE_2026-09-19.md` | 浏览器实际渲染与视觉检查 |
| 1 | 键盘 | 静态契约：label 关联/按钮 type/aria-live（`tests/gui`） | 焦点顺序、焦点可见性、纯键盘完成全流程 |
| 2 | 中文 | 无 | **必须人工**：输入法组词、提交、结果无乱码/截断 |
| 3 | 缩放 | 静态契约：viewport/lang/配色方案（`tests/gui`） | 200% 缩放与 ≤400px 实际布局 |
| 4 | 可访问性 | 静态契约：aria-live 状态区、按钮类型 | 屏幕阅读器播报、深色模式对比度实感 |
| 5 | 提交→授权 | **提交路径已脚本化**（CSRF cookie/无 token 403/202 受理回执/状态反映真实提交，见 `docs/reports/GUI01_R_04B_TARBALL_GUI_SSE_EVIDENCE_2026-09-19.md`）；服务端裁决/状态接口断言；MCP 桥接主体隔离与禁止工具拒绝（`docs/reports/BRIDGE01_04_STDIO_CLOSED_LOOP_EVIDENCE_2026-09-19.md`） | 界面是否如实反映裁决、不自动放行 |
| 6 | 查看差异 | 恢复/对账视图断言（`tests/gui`） | 与 CLI `recover list/show` 逐项人工对照 |
| 7 | 验收 | 追认/否决状态流转断言（含跨 Agent 404、陈旧签字 409） | 人工点击确认签收落盘、否决重开节点 |
| 8 | 恢复 | 中断恢复无重复副作用断言 | 真实进程中断后的续接体验 |
| 9 | 断线恢复 | **已脚本化到安装产物级**：首帧完整快照、`last-event-id` 重连仍回完整快照、任务/任务链标识不重复、终止后端口释放（`scripts/verify-gui-sse-reconnect.mjs`、`docs/reports/GUI01_R_04B_TARBALL_GUI_SSE_EVIDENCE_2026-09-19.md`）；早前单元层证据：服务端首帧快照与重连契约（`docs/reports/GUI01_R_02_LOCAL_SERVER_EVIDENCE.md`） | 浏览器 EventSource 自动重连（含服务重启后保持页面） |
| 10 | 资源观察 | 脚本化：终止后端口释放、无孤儿 node（上述 GUI 冒烟证据 §1） | 浏览器页签关闭路径、无残留 SSE |

## 5. 人工执行提示（Windows/Linux 同构）

```bash
# 1) 打包与包内容（§0 前两项）
npm run check && npm pack
node scripts/verify-package.mjs "$(ls -t astarray-*.tgz | head -1)"
node scripts/smoke-install.mjs

# 2) 从隔离安装包启动 GUI（§0 第四项；状态目录落在安装目录内，无需额外提权）
cd "$(ls -dt ../package-smoke/*/ | head -1)"   # 或 .tmp/package-smoke/<最新>/
node node_modules/astarray/dist/cli.js gui --port 0 --no-open
# 打开打印出的 http://127.0.0.1:<port>/ ，按 §1 十项逐项填写

# 3) 记录时必须填写：执行人/日期、浏览器与版本、操作系统、缩放比例、页面 URL，
#    以及本表"仍需人工确认"列的逐项结论（通过/未通过/返修去向）。
```

> Linux 执行时额外记录：发行版与内核、Node/npm 版本、输入法（fcitx/ibus）、屏幕阅读器、X11/Wayland，以及 §0 四项的退出码与 tarball mtime+SHA256（避免沿用旧包）。

