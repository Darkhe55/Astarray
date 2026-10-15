# GUI 授权闭环打通：「提交 → 授权 → 批准 → 产物落盘」（2026-11-08）

- **结论**：用户从会话开始就想验的这条链路，**首次全链路自动验证通过**
- **提交**：`ed4b5e6`（登记）、`743071e`（批准后授权并唤醒）
- **验证方式**：**自动**（不依赖人工点击）—— 由本会话直接驱动 GUI 自己的 HTTP 路由
- **⚠️ 边界**：本证据来自 **Windows + 真实 Provider(sensenova)**；
  **Linux/macOS 的人工体验仍未做**（如实保留）

---

## 1. 端到端结果（决定性）

```
① 提交         => mission-98954105（accepted）           POST /commands/submit
② 第 15 秒     => 出现授权请求（owner=worker:mission-98954105:T-001:1）
                                                          GET /permission-asks 非空
③ 批准         => {"status":"allowed","requestRevision":2}
                                                          POST /commands/permission-ask-decision
④ 状态转换     => blocked → **running** → **done**（第 117 秒）
★ 产物         => **真实落盘**（24B，内容 "# 批准闭环第二版"）
```

**关键**：`blocked → running` 这一步此前**从不存在**（批准只记录状态、不唤醒任务）；
现在能看到完整迁移，且**工具真的执行、产物真的落盘**。

## 2. 修掉的两个缺陷（都是"半成品"类）

### 2.1 登记缺失（`ed4b5e6`）

`registerPermissionAskRequest`（登记并广播待决授权）**全仓只有一个调用方**
（`run-command.ts`），且是在 `AstarrayApplicationFacade.create` 的
`onPermissionAskWithIdentity` 选项里调的。`gui` 命令**没传它** ⇒
**没有任何人登记** ⇒ `/permission-asks` 恒空 ⇒ 界面「待授权」区永远空。

**磁盘对照证据**：CLI 各次运行的 `agent-memory/<owner>/permission-ask-requests/`
都有文件；GUI 那次**连 owner 目录都不存在**。

### 2.2 批准不生效（`743071e`）

GUI 的 `decidePermissionAsk` 覆盖项**只调 `decidePermissionAskRequest`**（记录裁决），
没有做 CLI 做的三件事：

| # | 必须做 | 作用 |
| --- | --- | --- |
| ① | `grantSessionAuthorization` | 让重跑时该工具被判 **allow** |
| ② | `grantScopeAuthorizationForToolCall` | 重新登记**一次性**作用域授权（被拦那次已消费） |
| ③ | 下发 `{action:"unblock"}` | **唤醒**被阻塞的任务重派发 |

⇒ "记了个 allowed 的状态"，但授权没进权限引擎、任务没被唤醒。

## 3. ⚠️ 我自己在这一程犯的错（如实记录）

1. **同意第一次修复的"位置"选错**：我先把回调加进 `configurePermissionAskAdjudication`，
   被 `typecheck` 当场拦下（`TS2353`）才查清它是 **create 的选项**。
   **教训：先看类型签名，别照"看起来相关"的函数名猜。**
2. **批准修复第一版取值取错**：用 `queryTask({taskIdentifier: 记录里的 taskIdentifier})`
   换 mission ⇒ 服务端报 `任务不存在: T-001`（授权记录里是 mission 内部的 `T-001`，
   而门面任务表用 `gui-task-…`）。改从 **owner 标识内嵌的 mission** 取。
   **这一条是端到端验证抓到的，静态守卫抓不到。**
3. **我的验证脚本自己有 bug**：第一次把 `blocked` 当终态，3 秒就退出，
   差点漏掉 `blocked → running` 的转换。
4. **本会话第四次被"自己的注释"绊倒**：静态守卫用裸子串匹配，
   而注释里就有那个字面量 ⇒ **把代码删掉后断言仍通过**（空洞守卫）。
   已一律改为锚定**调用形态 / 属性键形态**，并用**变异探针**逐个证明承重。

## 4. 仍未完成（**不因本报告改变**）

| 项 | 状态 |
| --- | --- |
| **Linux / macOS** 平台的 GUI 人工体验 | **未做**（Windows 浏览器连不进 WSL，实测过；WSL 内无浏览器） |
| **真实浏览器人工体验**（本闭环是我用 HTTP 自动跑的） | 用户此前已确认「待授权卡出现 + 已授权」；**全链路浏览器点击路径**建议由用户复测一次 |
| 屏幕阅读器（§4 可访问性） | **已通过**（用户确认「念了页码」，见 `GUI_MANUAL_EXPERIENCE_ROUND3_2026-11-08.md`） |
| macOS 平台证据 | **未取得**（无环境） |

**⇒ GUI-02-02「提交→授权」这一条可以按"已交付且有端到端证据"记；
但整卡的 Linux/macOS 人工体验门槛仍在，故整卡不判通过。**
