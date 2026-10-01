# 写任务端到端阻塞：根因链与剩余修复点（2026-10-01）

> 承接：`docs/reports/PERMISSION_ASK_CLI_ADJUDICATION_2026-10-01.md` §6 的三条定位方向。
> 本轮全部使用**本地拦截代理**复现（零真实 Provider 额度）。
> 基线：`HEAD == origin/main == 3387740`。

## 1. 结论：两道门禁串联，历史上三层阻塞

| 层 | 现象 | 状态 |
| --- | --- | --- |
| ① 消息协议 | 工具续发请求用已废弃的 `role:"function"`，真实端点 400 | **已修** `104dcf1`（`assistant.tool_calls` + `role="tool"`） |
| ② 权限引擎 | 用户 `allow-once` 只写旧 `SessionAuthorizationManager`，判定侧 `ConfigurablePermissionPolicyEngine` 读不到；且参数哈希字节级敏感 | **已修** `c1608b5`（写入判定侧引擎 + `canonicalizeToolArguments`） |
| ③ 指令投递 | `unblock` 经反馈传输发给子进程，`scheduler:<missionId>` 的 mailbox 在父进程 → 父进程 `onMessage` **从不触发**，任务永久 blocked | **已修** `3387740`（同进程直接 `handleInstruction`，镜像审计消息） |
| ④ 范围门禁 | 一次性授权在**被拒那次**即被消费 → 重跑同一操作指纹命中 `auth-scope-replay-rejected`，内层工具**从不执行** | **未修（剩余阻塞）** |

### 1.1 ④ 的实测证据（本地代理，零额度）

代理每轮都请求 `createProjectFile`，观察运行时回填的工具结果：

```
#2 roles=system,user,assistant,tool  toolResult=错误(permission-ask-pending): 工具 createProjectFile 需要用户裁决
#3 roles=system,user,assistant,tool,assistant,tool  toolResult=错误(auth-scope-replay-rejected): 该授权已被消费：重放不产生副作用，需重新授权
#5 roles=system,user,assistant,tool  toolResult=错误(auth-scope-replay-rejected): …
```

CLI 侧最终输出：

```
astarray: [需要用户] 任务 T-001 失败：完成声明与本地工具结果不一致：createProjectFile 未成功（不得以文本声明结案）
status=blocked
```

即：模型声称完成被本地门禁拦住（门禁是对的），但**工具确实一次都没执行**。

### 1.2 代码依据

- `packages/core/src/tools/scope-authorization-gate.ts:190-222`
  - 命中未消费的 allow 记录 → 置 `consumedAtIso` 并放行；
  - 已消费 → `auth-scope-replay-rejected`（"重放不产生副作用，需重新授权"）。
- 授权入口：`grantUserAuthorization({ operation, approvedByUserId, expiresAtIso? })`（同文件 100-128）
  会写入 `consumedAtIso: null` 的新记录，**可再次授权**。
- ADR-0039 §单次授权与重放：同一操作指纹再次执行返回 `auth-scope-replay-rejected`，内层工具不被调用。

## 2. ④ 已修复（提交 `ff487d8`）

**语义**：用户 `allow-once` 针对"这一次精确操作"；被权限询问拦下的那次尝试**没有产生副作用**，
重跑是同一逻辑操作的**首次真实执行**，因此在授权时**重新登记一次**作用域授权；
**重放保护本身没有放宽**（同一指纹第二次重放仍返回 `auth-scope-replay-rejected`）。

实现（均为接线，未新增语义规则）：

1. `MainController.grantScopeAuthorizationForToolCall({toolName, argumentsJson})`：
   经 `describeToolOperation` 构造操作描述，以**解析后的认证身份**调用
   `ScopeAuthorizationGate.grantUserAuthorization`；缺身份时拒绝登记（不伪造 `approvedByUserId`）。
2. `public-sdk`：公开该入口，三入口共用。
3. `permission-ask-adjudication`：`allow-once` 分支**先**登记作用域授权**再**下发 unblock
   （unblock 会立即重新派发，顺序不能反），并如实输出作用域授权结果
   （`granted` / `not-scope-gated` / `failed:…`）。
4. `application-runtime`：注入 `scopeAuthorizationGate` 与**解析后**的 `authenticatedUserId`
   （此前写成原始 `options` 值，CLI 下为 `null`，导致首次端到端仍报"缺少可信认证身份"）。
5. `AssistScheduler.handleInstruction`：指令应用失败改为升级回用户，不再产生未处理拒绝
   （同时消除了覆盖率运行里既有的 unhandled `DomainError: 非法状态迁移 pending → pending`）。

### 2.1 反例与证据

- `tests/core/integration/scope-authorization-regrant.test.ts` **3/3**：
  无授权→等待裁决；复现实测序列（授权被消费→重跑 `auth-scope-replay-rejected`）；
  **重新登记后重跑执行一次、同指纹重放仍被拒**。
- 端到端（浏览器无关，本地拦截代理，**零真实额度**）：

```
astarray: 已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted），并下发 unblock（任务 T-001）
{ "status": "done", "permissionAsk": "allowed-once" }
产物: .tmp/live-exec-probe3/tasks/PROBE-EXEC.md 内容 "# 工具执行验证"
```

- 门禁：`npm run check` **247 文件 / 1926 用例**；覆盖率 **92.84 / 85.22 / 93.02 / 92.86**（exit 0）；
  `verify-package` ✅（217 文件）、`verify:entry-runtime-selection` ✅ 23/23、
  `verify:provider-tool-protocol` ✅ 5/5、安全关键模块 **22/22**。
- tarball sha256 `17cf197f705034e3a399a93208ff75621e88de498ca22df80f3e5fe7732ce17c`。

## 3. 四层阻塞总览（全部已修）

| 层 | 内容 | 提交 |
| --- | --- | --- |
| ① 消息协议 | `role:"function"` → `assistant.tool_calls` + `role="tool"` | `104dcf1` |
| ② 权限引擎 | 授权未写判定侧引擎 + 参数哈希键序敏感 | `c1608b5` |
| ③ 指令投递 | `unblock` 被子进程 mailbox 吞掉，scheduler 收不到 | `3387740` |
| ④ 范围门禁 | 一次性授权被"被拒那次"消费，重跑命中 replay-rejected | `ff487d8` |

## 4. 真实 Provider 首次收口实测（2026-10-01，额度 1/3）

命令（隔离范围：只允许改 `.tmp/live-write-final/`；stdin 管道给出一次性授权）：

```powershell
'allow-once' | node dist/cli.js run "<创建 .tmp/live-write-final/PROBE-LIVE.md 的提示>" `
  --mode assist --runtime openai-compatible --provider-model step-3.7-flash `
  --provider-credential-reference prov-live-1 --timeout-seconds 180 --json
```

实测时间线（mission-e7c0ba91）：

```
[需要用户] 任务 T-001 需要权限调用 createProjectFile（… 参数: {"content": "# 真实 Provider 受控改动探针…", "filePath": ".tmp/live-write-final/PROBE-LIVE.md"}）
[权限裁决] 任务 T-001 请求调用受限工具 createProjectFile …
已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted），并下发 unblock（任务 T-001）
[需要用户] 任务 T-001 失败：缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）（状态：（无文本输出））
status=blocked（permissionAsk=requires-human-resubmission）
```

### 4.1 已达成的部分（工具链路修复被真实服务验证）

| 判据 | 结果 |
| --- | --- |
| 权限裁决线（询问 → 用户 allow-once → 授权 → unblock） | ✅ 真实运行走通（含 `作用域授权: granted`） |
| **受限工具真实执行并落盘产物** | ✅ `.tmp/live-write-final/PROBE-LIVE.md` 存在，内容三行完全符合要求，sha256 `7AFD668EF3F226842552D72AD3243A5956C54A337BBF454F51E1A391A07A5CFB` |
| 无越界改动 | ✅ 该目录外无任何新文件；`git status` 仅用户并行文件 |
| 任务终态 | ⛔ `blocked`（未过本地完成门禁） |

即：**四层阻塞修复在真实服务上成立**（此前连工具都执行不了），但任务结案被另一件独立的事挡住。

### 4.2 未达成的原因（新发现，与前面四层无关）

- 工具执行后模型**没有在最终回复里重复输出** `ASTARRAY_TASK_COMPLETION_V1`，
  运行时的续轮结果为空文本（`状态：（无文本输出）`）；
- 本地完成门禁因此拒绝宣布成功（**门禁行为正确**，不是缺陷）；
- 真实模型行为：第一轮先输出完成事件再发起工具调用；工具执行后往往只回一句空/简短结论，
  **不再重复**版本化完成事件。

### 4.3 建议修复候选（属产品口径，需用户裁决）

1. **完成协议提示模板**：在任务提示/系统提示中明确"工具执行后的最终回复**仍须**包含完成控制事件"
   （不改变门禁强度，只是让模型知道协议）；
2. **协议重述点**：工具循环在回填工具结果时，附带一句本地协议提醒（如
   `"完成时仍须在最后一行输出 ASTARRAY_TASK_COMPLETION_V1 …"`）作为 `role:"system"` 续发消息；
3. 若采纳 1 或 2，需要用**新的真实额度**复跑同一写任务验证；届时 `T07D-R2-04` 可正式收口。

### 4.4 额度

- 新 3 次授权额度：**已全部用完**（① 文本探针前的两次写任务尝试 + 本次收口）。
- 真实验证结论与未达成项已如实记录；**不把"产物已落盘"当作任务通过**。



## 5. 收口复跑（额度 2/3 与 3/3，2026-10-01）

### 5.1 额度 2/3 的准备（协议重述与超时修复）

- 现象：CLI **卡死 16 分钟**（被迫人工终止）；工作存档只有两次"等待权限"。
- 根因（已修，`fe9684c`）：`InteractivePermissionAskDecisionPort` 读 stdin **无超时**，
  管道输入在第一轮被消费后第二轮永久挂起（违反 AGENTS.md「有界中止」）。
- 同时确认：Provider 单次请求超时不可配置，CLI 吃注册表默认 **30_000ms**（长任务会被掐断），
  已加 `--provider-request-timeout-seconds` 并透传（同上提交）。

### 5.2 额度 2/3（放宽超时后复跑）

- 现象：**未再卡死**；模型改用 `writeFileTemporary`（而非 `createProjectFile`），
  该工具未成功（路径含目录不符合其"仅相对文件名"约束），但模型仍输出完成事件 →
  本地门禁如实拦下：`完成声明与本地工具结果不一致：writeFileTemporary 未成功（不得以文本声明结案）`，
  任务 `failed`；**仅 1 次模型调用**，无产物。
- 结论：门禁行为正确；这是**工具选择/文案**层面的真实兼容性问题（工具名与描述未引导模型选对工具），
  属新候选（见 §5.5）。

### 5.3 额度 3/3（最终收口尝试）

- 提示中已明确"只用 `createProjectFile`"，模型的工具选择**正确**：
  ```
  [需要用户] 任务 T-001 需要权限调用 createProjectFile（参数: {"filePath": ".tmp/live-write-final/PROBE-LIVE-3.md", "content": …}）
  [权限裁决] … 输入 allow-once 授权 / 其他任意输入拒绝：
  已拒绝权限调用 createProjectFile（未授权、未继续任务）。 status=blocked, permissionAsk=denied
  ```
- **失败原因在我这一侧**：本次把裁决输入写成两行 `allow-once\nallow-once`，
  而 `readDecision()` 读取**首个数据块**（`"allow-once\nallow-once"`），trim 后不等于 `allow-once`
  → 按既定语义判为**拒绝**。属命令行输入构造错误，**不是产品缺陷**（判定逻辑与 fail-closed 语义均正确）。
- 教训（写入交接文档）：**管道只能提供一次裁决输入**（单次使用）；需要多次裁决时应使用 TTY 交互，
  或每次单独发起。

### 5.4 收口状态（如实）

| 判据 | 状态 |
| --- | --- |
| 四层阻塞修复在真实服务上成立 | ✅ 已证（2026-10-01 首次真实收口：工具执行 + 产物落盘 + 全流程走通） |
| 协议重述机制 | ✅ 单元级已证（工具执行后注入 system 重述，位于末位且首轮不注入） |
| 有界裁决输入 / 可配置请求超时 | ✅ 已修并有反例（`permission-ask-timeout.test.ts` 4/4） |
| T07D-R2-04「小型受控改动」正式结案 | ⛔ 未达成：3 次额度分别用于（1）卡死诊断、（2）工具选择错误、（3）我的输入构造错误；**无一次同时满足"产物落盘 + 任务 done"** |

**结论：不得宣称 T07D-R2-04 已收口。** 需要新的真实额度 + 单次 TTY/单次管道输入重跑，
预期可一次通过（组件已全部就绪且有离线证据）。

### 5.5 本轮新发现的产品候选（按优先级）

1. **工具选择引导**：模型在"新建指定路径文件"任务上会选 `writeFileTemporary`（仅接受相对文件名、不能带目录），
   失败后仍声称完成。候选：在 Worker 系统提示中给出工具选择要点（何时用 `createProjectFile` / `replaceFileContent` / `writeFileTemporary`），
   或让 `writeFileTemporary` 对含路径分隔符的入参给出可操作的错误提示。
2. **多次裁决的输入供给**：管道只能喂一次；`--json` 场景建议支持"裁决文件"或要求 TTY，
   并在帮助文案里写明"管道仅支持一次 `allow-once`"。
3. **完成声明 ≠ 门禁通过**：本轮两次"模型声称完成但本地门禁拒绝"都发生在**工具失败**之后，
   说明提示词还需强调"工具失败时不得输出完成事件"（当前重述文案已含此意，可再强化）。
