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

## 2. 剩余修复点（建议检查点，先反例后实现）

**语义**：用户 `allow-once` 针对的是"这一次精确操作"；被权限询问拦下的那次尝试**没有产生副作用**，
重跑属于同一逻辑操作的**首次真实执行**，因此应在重跑前**重新登记一次作用域授权**，
而不是让 replay 守卫把它当成第二次执行。

实现要点（不需新增语义规则，只需接线）：

1. `ScopeAuthorizationGate` 已在 `PolicyWrapper` 选项内可达；确认运行时装配把 gate 传给 worker 的 PolicyWrapper。
2. 在 CLI 裁决成功后（`permission-ask-adjudication.ts` 的 allow-once 分支）除 `grantSessionAuthorization` 外，
   再调用一次**作用域授权**：`gate.grantUserAuthorization({ operation, approvedByUserId })`，
   其中 `operation` 需由工具名 + 参数经与 `PolicyWrapper` 相同的分类逻辑构造
   （`ScopeAuthorizationGate` 已导出工具→操作种类的映射，见同文件 389 行附近的 `case "createProjectFile"`）。
3. 失败即 fail-closed（授权未登记则不放行），并在输出里如实报告。
4. 反例：新增测试——被 `permission-ask-pending` 拦下 → 用户 allow-once → 重跑**内层工具执行次数 = 1**、
   产物存在、任务 `done`；同时保留"同一指纹第二次重放仍被拒"的既有断言（不得放宽重放保护）。

## 3. 额度与产物

- 本轮真实额度消耗：**0**（全部走本地拦截代理）；新 3 次额度中累计已用 2 次，**剩 1 次**。
- 端到端改进已可见：同一写任务由 `status=blocked` → **`status=done`**、`permissionAsk=allowed-once`
  （④ 修好后才能落产物）。
- 建议：④ 实现并离线验证通过后，再用**最后 1 次**额度跑真实写任务收口 T07D-R2-04「小型受控改动」。
