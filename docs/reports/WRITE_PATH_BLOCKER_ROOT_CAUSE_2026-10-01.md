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

## 4. 剩余一步：真实 Provider 收口（需要用户决定）

离线链路已全绿，但 **T07D-R2-04「小型受控改动」要求在真实服务上完成**。
当前额度：新 3 次累计已用 2 次，**剩 1 次**。

建议动作（1 次请求）：

```powershell
# 在隔离 fixture 内，用真实端点 + 受保护引用；stdin 管道给出一次性授权
'allow-once' | node dist/cli.js run "<创建 tasks/PROBE-LIVE.md 并给出完成控制事件的提示>" `
  --mode assist --runtime openai-compatible --provider-model step-3.7-flash `
  --provider-credential-reference prov-live-1 --timeout-seconds 150 --json
```

成功判据：`status=done`、`permissionAsk=allowed-once`、`tasks/PROBE-LIVE.md` 实际落盘且内容符合要求。
失败则如实记录并保留 blocked（不得以文本声明结案）。

