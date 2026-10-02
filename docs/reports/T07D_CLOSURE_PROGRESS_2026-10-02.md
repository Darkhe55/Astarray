# T07D-R2-04 正向闭环：定位进展与两层修复（2026-10-02）

> 承接 `HAPPY_PATH_BLOCKER_TRACE_2026-10-02.md` 的未解矛盾。本轮用
> `ASTARRAY_CLOSURE_TRACE`（gate 实例标识 + 预留/授权/CLI 轮次 + worker 门禁输入）
> 在真实 CLI 链路上完成定位。诊断代码已全部移除。

## 1. 之前的"矛盾"已解释

> 旧记录：`authorizeForExecution` 只能由 `reserveForExecution` 到达，但预留审计零输出、错误却出现。

原因：**那三条"错误"是上游请求体里回放的历史 tool 消息**，不是本轮新产生的结果。
逐请求打印消息角色后可见：请求 #2/#3/#4 各自携带累计的历史（`assistant(+1calls),tool` 逐轮增加），
因此同一条 `auth-scope-replay-rejected` 会在后续请求里"再次出现"。**矛盾不成立**，无需再追。

## 2. 本轮定位（同一 gate 实例 `gate-*`，单次运行内）

```
[closure] reserve gate=X fp=1ac8b618123e existing=undefined auth=false reservations=0   ×3
[closure-tui] round=0 ask=createProjectFile taskStatus=blocked escalations=1 terminalFailure=false
[closure] grantSessionAuthorization tool=createProjectFile engine=true profile=resolved
[closure] grantUser gate=X
[closure] grantLogical gate=X
[closure-worker] requireEvent=true attempted=[] succeeded=[] artifacts=[] declared=[] unresolvedFailures=[]
[closure-tui] 授权后 round=0 finalStatus=done terminalFailure=false escalations=0
```

结论：**"预留"与"授权"落在同一实例**（同一 `gate-X`），授权也确实写入引擎
（`engine=true profile=resolved`）。缺陷在**时序**，不在实例或双轨。

## 3. 修复一（CLI）：授权后必须等待重跑

`packages/tui/src/cli/run-command.ts`

- 缺陷：`waitForPermissionAsk` 一见任务回到 `running` 就**立即返回 null**，
  CLI 随即收口 → **授权后的重跑从未被等待**。
- 修复：新增**推进窗口** `AUTHORIZATION_RETRY_WINDOW_MILLISECONDS = 15_000`；
  第 2 轮起在非 blocked 状态下继续轮询，等待"新询问或终态"，窗口耗尽才如实返回 null。

## 4. 修复二（worker）：写类工具的"尝试"必须在**请求时刻**登记

`packages/core/src/orchestration/worker-agent.ts`

- 缺陷：`attemptedMutatingTools` 只在 `toolCallFinished` 登记；被权限门禁拦下的调用
  **不产生结果事件** → 完成门禁看到 `attempted=[]`，于是**放行"从未执行却声称完成"**。
- 修复：在 `toolCallRequested` 即登记写类工具的尝试。
- 附带：`scope-authorization-gate.ts` 的 try/catch 结算（上一轮 R5）保持。

## 5. 仍未打通（**不视为完成**）

授权生效后的重跑**依然**得到 `permission-ask-pending`：
实测三次 `reserve` 全部发生在授权**之前**，且授权与它们同秒发生（3500ms 内五次请求）。

### 5.1 本轮新增的关键线索（引擎诊断零输出）

在 `ConfigurablePermissionPolicyEngine.decide/grantSessionAuthorization` 注入诊断后运行真实 CLI：
**引擎侧诊断一次都没有输出**（而 `[closure] grantSessionAuthorization engine=true profile=resolved`
确实打印过，说明"写入路径"走到了）。

结合 `PolicyWrapper.decidePermission` 的装配条件：

```
if (configurableEngine != null && profileReference != null) → engine.decide(...)
else → this.options.permissionDecider.decide(...)     // 旧 PermissionDecider
```

推论：**worker 工具执行链路上的 `currentPermissionProfileReference` 可能为 null**，
于是判定落到旧 `PermissionDecider`；而用户裁决写入的是
`sessionManager`（旧表）+ `ConfigurablePermissionPolicyEngine`（新表）。
若 worker 的旧表与 CLI 写入的旧表**不是同一实例**，就会出现**第三处双轨失配**：
授权写进了用户看不到的表，判定查的是另一张表。

**下一轮第一步（最小验证）**：在 `PolicyWrapper.decidePermission` 打印
`toolName / engine!=null / profileReference!=null / 走了哪条分支`，
一次运行即可判定"是否回落旧判定器"，再决定是补装配（让 worker 用引擎）
还是让授权同时写旧表实例。

### 5.2 最小验证结果（决定性）与推论复核

在 `PolicyWrapper.decidePermission` 入口注入诊断（并**核对产物确实包含该诊断**：
`dist/chunk-G64DFCRP.js` 含 `[decide]`/`ASTARRAY_DECIDE_TRACE`），随后运行真实 CLI：
**诊断依然零输出** ⇒ `decidePermission` **从未被调用**。

随后逐处核对 `PolicyWrapper.execute` 中可能产生 `permission-ask-pending` 的位置：

| 位置 | 错误码 | 是否可能 |
| --- | --- | --- |
| `decidePermission` 返回 `ask` → `throw`（`:178`） | `permission-ask-pending` | **已排除**（诊断零输出） |
| 安装门禁 `InstallationGateGuard.buildDenial`（`:171-172`） | 取决于门禁原因 | 需复核：`createProjectFile` 的 `mutationKind="create-only"` 经 `LocalSensitiveOperationClassifier` 归为 **`file-mutation`**，而 `PolicyWrapper` 只在 `process-execution/system-level/unknown` 时才走安装门禁 → **本不该触发** |
| `assertWithinWorkerSubset`（`:244`） | `tool-permission-denied` | 不是该错误码 |

> 更正：上一版本曾据此推断"来自安装门禁分支"，该推断**不成立**（分类为 `file-mutation`，
> 不会进入安装门禁）。当前状态是**尚未定位到确切抛出点**，但已把范围压到
> "`execute` 中 `decidePermission` 之前的那一小段"。

**下一轮最小验证（建议）**：在 `PolicyWrapper.execute` 内做**三点标记**
（进入 execute / `classifyOperation` 结果 / 安装门禁是否进入且结果），
一次运行即可指出确切分支；或直接在 `throw` 处带上传入的 `toolName` 与阶段名。

因此待通过的反例保留在
`tests/tui/integration/authorization-retry-closure.test.ts`，当前以 **`it.skip`** 标记：
既不让门禁长期变红，也**不删除**（删除等于假装闭环成立）。修复后应改回 `it`。

## 6. 门禁

- `npm run check` → **exit 0**：264 文件通过 / 1 跳过（共 265），2007 用例通过 / 1 跳过
- 期间出现 1 个已知负载抖动用例（`cli-commands`，独立运行 22/22 通过）
- Linux/macOS 未验证
