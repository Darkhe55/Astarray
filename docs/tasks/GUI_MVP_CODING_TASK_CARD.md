# Astarray 返修序列补充任务卡：GUI MVP

> 状态：待执行  
> 编制日期：2026-08-16  
> 任务编号：GUI-01  
> 任务来源：用户  
> 优先级层级：0  
> 风险等级：高  
> 预计时长：不超过 3 小时  
> 前驱：`B6R-10`  
> 后继：`T08B`

## 1. 插入位置

本卡补充 [Batch 6 高风险功能返修任务卡](./BATCH6_REPAIR_TASK_CARDS.md) 的偏序关系。原边 `B6R-10 → T08B` 调整为：

```text
B6R-10 → GUI-01 → T08B
```

`B6R-10` 未通过时不得开始 GUI；GUI 未通过时不得把图形化界面标记为已交付，但不得因此伪造或降低底层返修标准。

## 2. 任务目标

实现一个可随 npm 包安装、由 `astarray gui` 启动的本地浏览器图形化界面 MVP。GUI 必须调用 `packages/core` 的稳定应用接口，不复制权限、安装、备份、Agent 身份或任务偏序规则。

本卡完成后，认证本地用户应能够：

- 启动本地 GUI 并看到清晰的会话状态。
- 输入一条用户指导并提交给主 Agent 的本地会话控制面。
- 查看任务偏序图、ready/running/blocked/done 等状态和优先级层级。
- 按具体 `agentInstanceId` 查看主、次级、三级 Agent 状态，不把同级个体混在一起。
- 查看带明确来源的反馈摘要；Agent 来源显示到具体个体。
- 查看当前公开模式/profile 摘要和待用户处理的权限或安装请求，但本卡不新增绕过核心控制器的权限修改逻辑。

## 3. 技术边界

### 3.1 实现方式

- 使用 Node.js 内置 HTTP 服务、Server-Sent Events 和浏览器原生 HTML/CSS/TypeScript/SVG。
- 不引入 Electron、Tauri、Vite、WebSocket 库、图表库、CSS 框架或其他新依赖。
- 开始编码前先询问用户是否已有完成任务所需的可用依赖或工具；现有依赖足够时不得执行安装。
- 若确认必须增加依赖，本卡立即暂停，只有独立安装开关开启且用户对精确包名、版本和参数逐次授权后才能继续。
- GUI 源码放在 `packages/gui/src/`，测试放在 `tests/gui/`。
- GUI 可以依赖 Core；Core、TUI 不得依赖 GUI，GUI 不得依赖 Ink 或 TUI 内部组件。

### 3.2 建议文件边界

单卡最多修改 8 个生产代码文件。建议结构：

```text
packages/gui/src/
├─ server/gui-server.ts              # loopback HTTP、SSE、Origin/Host/CSRF 校验
├─ application/gui-read-model.ts     # Core → GUI 脱敏公开 DTO
├─ application/gui-command-port.ts   # 用户输入 → 可信本地控制面
└─ client/
   ├─ index.ts                        # 原生 DOM、键盘和状态更新
   ├─ index.html                      # 页面壳
   └─ styles.css                      # 响应式布局和主题

tests/gui/
├─ unit/
├─ component/
├─ integration/
└─ accessibility/
```

如果构建、CLI 接入和应用接口导致生产文件超过上限，应在可构建边界拆成 `GUI-01A` 与 `GUI-01B`，不得通过扩大单卡范围规避 3 小时限制。

## 4. 功能要求

### 4.1 启动命令

新增：

```powershell
astarray gui
astarray gui --port 0
astarray gui --no-open
```

- 默认只监听 loopback；`--port 0` 使用操作系统分配端口。
- 不得默认监听 `0.0.0.0`、局域网或公网地址。
- 自动打开浏览器属于显式用户操作；无 TTY 或 `--no-open` 时只输出本地 URL。
- 端口占用、浏览器不可用和状态目录损坏时给出稳定错误与非零退出码，不后台遗留进程。

### 4.2 页面布局

页面至少包含：

1. 顶栏：产品名、模式中文名、profile 显示名、连接状态、反馈进程健康状态。
2. 主对话区：用户输入框、提交状态、主 Agent 回复流；提交后输入区保持可用。
3. 任务图：使用原生 SVG 显示偏序关系、priority tier 和任务状态；环或损坏状态显示错误，不静默改写数据。
4. Agent 面板：按具体 `agentInstanceId` 独立展示角色、所属上级、当前任务链、状态和上下文预算摘要。
5. 反馈面板：显示消息种类、时间和经过 schema 校验的来源；转发消息保留原始来源。
6. 请求面板：显示已有资源询问、安装授权、普通权限询问和备份删除警告的公开摘要。实际决定必须调用 Core 的认证控制器，不在浏览器端复制规则。

### 4.3 状态更新

- 初始页面通过脱敏只读快照加载状态。
- 后续使用 SSE 推送版本化状态事件，事件带 revision 和幂等 ID。
- 客户端检测 revision 跳跃时重新请求完整快照；不得在前端猜测或合并安全状态。
- 断线使用有界退避重连，最大等待不超过 `pn` 3 小时，正常重试间隔 1–30 秒。
- 页面关闭后服务端及时注销订阅，不造成监听器或消息队列泄漏。

## 5. 本地安全要求

- 服务仅接受 loopback 连接，同时校验规范化 `Host` 和 `Origin`。
- 所有会改变状态的请求使用同源、SameSite 严格会话和 CSRF 防护；浏览器正文、URL、模型输出和环境变量不能充当认证。
- HTTP 请求中的 `agentInstanceId`、角色、来源和权限声明都不可信，真实身份由本地控制面注入。
- GUI 只能获得公开、脱敏 DTO，不得提供通用文件读取 API，不得返回 `.env`、凭据、私钥、备份物理路径、授权 nonce 或内部执行规则。
- 主 Agent 仍只能使用读取类模型工具；GUI 提交用户消息不等于给主 Agent 写入工具权限。
- 权限、安装、备份删除和会话提升在实际执行前仍由 Core 重新检查；隐藏按钮或前端校验不能作为安全边界。
- 浏览器内容必须进行文本转义，禁止用未净化的 `innerHTML` 渲染 Agent、文件或反馈内容。
- GUI 日志不得记录用户输入全文、cookie、CSRF 值、授权 nonce 或敏感路径。

## 6. 编码任务链

1. 读取必读文档和 `packages/gui/README.md`，检查 Git 状态并记录现有未提交修改。
2. 先建立 `tests/gui/`，编写 CLI 启动、loopback 限制、Host/Origin/CSRF、脱敏 DTO、状态 revision、SSE 重连和 HTML 注入失败测试。
3. 定义 GUI 公开 read model 与 command port；应用接口只引用 Core 的公开类型和控制器。
4. 实现本地服务器、静态资源响应、SSE 订阅和受控关闭。
5. 实现响应式页面、用户输入、任务 SVG、Agent/反馈/请求面板和键盘导航。
6. 把 `astarray gui` 接入 CLI 和构建入口，确保静态资源进入 npm tarball。
7. 运行 GUI 目标测试、Core/TUI 回归、类型检查、lint、完整检查和覆盖率。
8. 从全新 tarball 隔离安装，启动 GUI，使用真实浏览器完成桌面和窄屏视觉/交互验收。
9. 验证退出后端口释放、SSE 清理、反馈子进程与 GUI 服务均无孤儿进程。
10. 更新 `PLAN_STATUS.md`、`ORGANIZATION.md`、GUI README 和交付报告；只有动态验收全部通过才宣称 GUI MVP 可用。

## 7. 测试方案

### 7.1 单元与组件

- 公开 DTO schema、脱敏和字段白名单。
- 任务偏序图布局输入：空图、长链、分叉、汇合、不可比节点、Unicode、超长标题。
- Agent 同名但不同 `agentInstanceId` 时保持两个独立视图。
- 消息来源：用户、具体 Agent、系统、转发保留来源、缺失/伪造来源拒绝。
- HTML/属性/URL 注入内容只能显示为文本。
- revision 重复、乱序、跳跃和重连恢复。

### 7.2 集成与安全反例

- 非 loopback 绑定请求拒绝；异常 Host、跨 Origin POST、缺失/错误 CSRF 拒绝。
- 浏览器伪造 Agent 身份、模式、profile revision 或用户授权不能改变 Core 裁决。
- 无 TTY、端口冲突、损坏状态、SSE 断线、反馈进程失败和服务关闭路径。
- GUI 与 TUI/Headless 同时观察同一会话时，只共享 Core 状态，不共享界面缓存或上下文。
- 后台密集报告时用户输入仍可提交，主 Agent 不被后台汇报自动唤醒。

### 7.3 可访问性与视觉

- 仅键盘可完成导航和提交；焦点顺序明确，有可见焦点样式。
- 使用语义化标题、表单标签、状态 live region 和足够颜色对比度。
- 目标视口：1440×900、1024×768、390×844；不得横向遮挡主要操作。
- 中文、英文、emoji、长 ID、长任务标题和 200% 缩放可用。
- 支持亮色、暗色和 `prefers-reduced-motion`；任务状态不能只靠颜色表达。

### 7.4 打包验收

- `npm run typecheck`
- `npm run lint`
- GUI 目标测试及 Core/TUI 回归测试
- `npm run test:coverage`
- `npm run check`
- `npm pack`
- tarball 隔离安装后运行 `astarray gui --port 0 --no-open`
- 浏览器检查页面加载、SSE、用户输入、任务图、Agent 来源、关闭清理

GUI 关键安全和状态分支覆盖率不得低于 95%。tarball 不得包含测试、日志、运行状态、`.env` 或凭据。

## 8. 明确不在本卡范围

- 不实现 Electron/Tauri 桌面壳、自动更新、系统托盘或原生安装包。
- 不实现远程访问、多用户账户、云同步或公网部署。
- 不复制 Core 权限策略到浏览器，不在客户端直接读写 Agent 记忆或项目文件。
- 不实现 T08B 尚未完成的工具说明回访和受权通信 grant 编辑器；只预留公开请求列表区域。
- 不修改 GUI 之外的产品视觉品牌体系；优先保证信息层级、可访问性和安全边界。

## 9. 完成事件

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: GUI-01
agentInstanceId: <具体且不可复用的 Agent 个体 ID>
sourceKind: user
priorityTier: 0
gitBranchOrWorktree: <次级 Agent 分配的隔离位置>
commitId: <原子提交 ID>
guiCommand: astarray gui
changedProductionFiles:
  - <文件>
changedTestFiles:
  - <文件>
executedChecks:
  - command: <命令>
    exitCode: <退出码>
coverageEvidence: <GUI 关键分支覆盖率>
tarballEvidence: <tarball 路径、隔离安装和浏览器验收>
securityEvidence: <loopback、Origin、CSRF、脱敏、注入反例结果>
remainingRisks:
  - <没有则写 none>
completionGate: passed | failed | blocked
```

缺少 tarball 浏览器验收、关键分支覆盖率、来源隔离或本地安全反例时，不能标记完成。

## 10. OpenCode 执行提示

```text
完整读取 AGENTS.md、agent-main-architecture.md、designtodo.txt、
IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、AUDIT_REMEDIATION_TASKS.md、
docs/tasks/BATCH6_REPAIR_TASK_CARDS.md、docs/tasks/GUI_MVP_CODING_TASK_CARD.md
和 packages/gui/README.md。

确认 B6R-10 已通过后，本轮只执行 GUI-01，不开始 T08B。开始前先询问用户
是否已有所需依赖和工具；默认使用 Node 内置 HTTP/SSE 与浏览器原生能力，
不安装新依赖。先写 GUI 安全反例和集成测试，再编码。

GUI 只能依赖 Core 稳定接口，不得依赖 TUI/Ink或复制权限规则。服务只监听
loopback，状态写入使用同源与 CSRF 防护，Agent 身份和授权由本地控制面注入。
完成后必须从 npm tarball 启动真实 GUI，验证视觉、键盘、SSE、用户输入、
具体 Agent 来源和关闭清理，并返回 ASTARRAY_TASK_COMPLETION_V1。

本卡最长 3 小时，pn 上限 3 小时；预计超时就在安全、可构建边界拆卡。
```

