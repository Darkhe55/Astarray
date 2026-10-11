# GUI-01-R-04 人工体验验收记录（用户执行，2026-10-10）

> 本文件是 `GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md` 的**实测记录**。
> 执行人：**用户**；日期：**2026-10-11**（会话内记为 2026-10-10 轮次）。
> 环境：**Windows 11 + 火狐浏览器**；被测对象为**隔离安装的 tarball**（非工作区源码）。
> **未测项一律记「未测」，不写通过**（卡内明令：自动断言不能替代人工结论）。

## 0. 被测产物（关键：避免沿用旧包）

| 项 | 值 |
| --- | --- |
| 首次被测 tarball | `sha256 78fdaf4ae068c299…`（file count 261，`verify-package` exit 0） |
| `verify-package.mjs` | **exit 0** —— 261 文件、shebang/BOM 正确、反馈进程入口已包含 |
| `smoke-install.mjs` | **exit 0** —— 隔离安装、`run --runtime mock` 冒烟到 `done`、**Windows 全局 shim 验证通过** |
| 首次被测 URL | `http://127.0.0.1:4675/`（`gui --port 0 --no-open`） |
| 复验 URL（修复后重打包） | `http://127.0.0.1:6115/`，tarball `sha256 f40e605ae308fdc5…` |

## 1. 人工体验十项（逐项实测）

| # | 项 | 用户实测结论 | 判定 |
| --- | --- | --- | --- |
| 1 | 键盘 | "tab 切换焦点顺序正常，enter space 确认正常，**无需鼠标**" | ✅ **通过** |
| 2 | 中文 | 输入显示正常、**输入内容留存**；提交后显示 `已受理：gui-task-76436644a2e2（受理不等于完成）`（含中文正文提交） | ✅ **通过**（修复后） |
| 3 | 缩放 | "浏览器缩放**无横向滚动条，控件不重叠**" | ✅ **通过** |
| 4 | 可访问性（深色模式 + 屏幕阅读器） | — | ⬜ **未测** |
| 5 | 提交→**授权** | "**提交后没有要求授权**" | ❌ **无法完成 —— 见 §3（能力缺口）** |
| 6 | 查看差异（恢复中心 vs CLI） | — | ⬜ **未测** |
| 7 | 验收（追认 / 否决） | — | ⬜ **未测** |
| 8 | 恢复（中断后续接） | — | ⬜ **未测** |
| 9 | 断线恢复（服务重启后页面保持） | — | ⬜ **未测** |
| 10 | 资源观察（端口释放、无孤儿进程） | — | ⬜ **未测** |

任务列表显示正常：`gui-task-6cd33c7039fd · done · r3`、`gui-task-76436644a2e2 · done · r3`。

## 2. 本轮人工体验**发现并已修复**的 3 个缺陷

复验用的 `gui-csrf-browser-simulation.test.ts` **3 条反例（先红后绿）**已随修复提交。

| # | 用户观察 | 根因 | 修法 | 提交 |
| --- | --- | --- | --- | --- |
| 1 | 切换权限组「**切换失败：csrf-required**」 | 前端从 `document.cookie` 读 `gui_csrf`，而服务端以 **`HttpOnly`** 下发 ⇒ **JS 永远读不到** ⇒ token 恒空 ⇒ 所有状态变更 403 | token **内嵌进页面** `<meta name="gui-csrf-token">`（跨源读不到 HTML ⇒ 不泄漏），**保留 `HttpOnly`** | `7b9b4d9` |
| 2 | 提交显示「已受理：**undefined**」 | submit 处理器**不检查 HTTP 状态**，把 403 错误体当成功体 ⇒ 把**失败**呈现成**受理** | 先 `response.json()` 再判 `response.ok`，失败显示错误码 | `7b9b4d9` |
| 3 | （自查发现）我的第 ③ 条断言曾**假绿** | 全页正则找 `response.ok`，被 budget/权限组处理器误匹配 | 断言**限定在 submit 处理器片段内** | `7b9b4d9` |

**为什么既有 72 个 GUI 测试全绿却漏掉 #1/#2**：所有用例都用
`csrfTokenFactory: () => "…"` **直接注入 token**，**从不模拟"浏览器从页面取 token"** ——
属"自证"。与 BRIDGE-01-04 的 MCP 协议版本缺陷同一类。

**修复后自检**（隔离安装产物）：cookie 仍 `HttpOnly`；页面内嵌 token（64 字符）；
用该 token `POST /commands/submit` ⇒ **HTTP 202** 且返回真实 `taskIdentifier`
（修复前必然 403）。用户随后实测确认提交显示**正确任务标识**。

## 3. §1 第 5 项**无法完成** —— 能力缺口（不是接线疏漏）

用户实测"提交后没有要求授权"。核查结论：**GUI 完全没有权限询问的呈现与批准路径**，
且这是**公共能力缺口**，不是 GUI 漏接一根线：

| 层 | 事实 | 证据 |
| --- | --- | --- |
| GUI 端口 | `GuiApplicationPort` **没有**权限询问/升级相关的任何方法 | `packages/gui/src/server/gui-server.ts:45` 起 |
| GUI 路由 | **没有**授权/批准路由（仅有 submit / cancel / set-context-budget / switch-permission-profile / verification-decision） | 同文件路由表 |
| 公共事件 | `PublicAstarrayEvent` **不发布**权限询问事件（只有 session-status / task-status / task-finished / budget-policy-updated） | `packages/core/src/public-sdk.ts` |
| 公共结果 | `PublicTaskResult` **不含** `permissionAsk` 字段 | 同上 |
| CLI 的来源 | CLI 的 `requires-human-resubmission` 来自它**自己**监听升级文本（`buildPermissionAskFromEscalation`）并做裁决循环 | `packages/tui/src/cli/run-command.ts` |

**影响**：卡内 §1 第 5 项（"提交任务并在权限/安装请求出现时授权 → 界面反映真实裁决结果、
不自动放行"）**在 GUI 上无法执行**；§0 那份自动证据里的
"提交/取消/预算写入路径已脚本化"**不覆盖**授权呈现。

**这不是我能在本记录里"测掉"的项**：它需要**先补公共能力**（公共 SDK 暴露
"某任务当前是否有待裁决的权限询问" + 一个受 CSRF 与主体校验保护的批准/拒绝入口），
再由 GUI 呈现。**属设计决策 + 安全敏感改动**，故**未擅自实现**，如实登记为缺口。

## 4. 记录字段（清单 §3 要求）

- 执行人 / 日期：**用户 / 2026-10-11**
- 浏览器与版本：**火狐**（用户未给出具体版本号 ⇒ **如实标注为未记录**）
- 操作系统：**Windows 11**
- 缩放比例：用户确认做过缩放测试（未给具体百分比 ⇒ **未记录**）
- 页面 URL：`http://127.0.0.1:4675/`（首测）→ `http://127.0.0.1:6115/`（复验）
- 未通过项与返修去向：**§1-5 授权呈现（能力缺口，见 §3）**；其余未测项**待继续执行**
