# headless CLI 权限裁决线 + 真实写任务阻塞发现（2026-10-01）

> 来源：用户定语义「交互优先 + 非交互退化为可重提」（其余按 ADR-0011 既有定论）。
> 基线：`HEAD == origin/main == 104dcf1`。

## 1. 已完成：CLI 裁决线接线

- 新增 `packages/tui/src/cli/permission-ask-adjudication.ts`：
  - `buildPermissionAskFromEscalation()`：从调度升级文本解析 `taskId / toolName / argumentsJson / explanation`，
    **参数逐字保留**（授权按参数哈希绑定，不得改写）；解析失败返回 null → 退化为"需人工重提"，不猜测。
    实测加固点：真实升级文本的参数 JSON 键序不定（`{"content":…,"filePath":…}`）且带尾随换行，故**不锚定结尾**。
  - `runPermissionAskAdjudication()`：**只有**交互式用户明确 `allow-once` 才调用
    `grantSessionAuthorization(toolName, argumentsJson, nowUnixSeconds)` 并下发
    `{"action":"unblock","taskId":…}`；拒绝/无输入/无上下文一律不授权。
  - `InteractivePermissionAskDecisionPort`：TTY **或管道/重定向 stdin** 视为显式用户输入通道；
    无输入通道 → fail-closed（不读取、不授权、不 unblock）。不含 `--yes`、环境变量等自动放行路径。
- `run-command.ts`：捕获升级文本 → 任务 blocked 时进入**有界**裁决循环（最多 3 轮），
  JSON 输出新增 `permissionAsk` 字段（`allowed-once|denied|requires-human-resubmission`）。
- 反例 → 绿：`tests/tui/integration/permission-ask-adjudication.test.ts` **10/10**
  （实现前：模块不存在，套件失败）。

## 2. 真实写任务实测（stepfun `step-3.7-flash`，额度第 2 次）

```
astarray: [需要用户] 任务 T-001 需要权限调用 createProjectFile（…），参数: {"content": …, "filePath": "tasks/PROBE-001.md"}
astarray: [权限裁决] 任务 T-001 请求调用受限工具 createProjectFile
  说明: 执行任务需要调用工具 createProjectFile
  参数: {"content": …, "filePath": "tasks/PROBE-001.md"}
  输入 allow-once 授权 / 其他任意输入拒绝：
astarray: 已按精确参数 allow-once 授权 createProjectFile，并下发 unblock（任务 T-001）
→ 之后任务再次进入权限询问，最终 status=blocked、permissionAsk=requires-human-resubmission
```

**结论**：裁决线本身已被真实运行走通（询问 → 用户管道输入 `allow-once` → 授权 → unblock）。
但任务**仍未完成**，原因是下一节的独立缺陷。

## 3. 新发现的阻断缺陷：授权哈希对 JSON 键序敏感（**未修，待用户裁决**）

- `packages/core/src/core/permission-policy.ts:86`：`hashToolArguments()` = `sha256(原始字符串)`，**字节级**。
- `packages/core/src/tools/configurable-permission-policy-engine.ts:167-172`：授权 key 与
  `argumentHash` 同样按原始字符串哈希（`grantSessionAuthorization` 与裁决两侧一致）。
- 后果：模型第二次生成语义相同但键序不同的参数（`{"content":…,"filePath":…}` vs
  `{"filePath":…,"content":…}`）→ 哈希不同 → **授权不生效、再次要求用户逐次裁决**。
  对"参数变化即失效"的安全语义而言这偏严；对产品可用性而言，用户在提示里看到的文本与
  实际哈希对象可能逐字不同，**用户无法自行避免**该失配。

### 可修方向（需用户确认，属安全相邻改动）

1. **规范化后哈希**：递归按键排序、值保持原样的 canonical JSON，再 sha256。
   - 理由：JSON 对象键序无语义；数组顺序、值差异仍然敏感（改动仍会使授权失效）。
   - 影响面：`hashToolArguments` 或引擎私有 `hashArguments`；两侧必须同一实现，否则更糟。
   - 风险：任何"按参数绑定"的既有测试/证据需复跑；`deny`/`ask` 判定不变，只影响"已授权是否命中"。
2. **升级为会话级授权**：首次裁决即写会话级（`allow-session`），同工具后续调用免逐次。
   - 与 ADR-0011 的 `allow-once` 口径冲突，需用户明确同意才可，且必须绑定工具名与 profile revision。

## 4. 真实端点额度与产物

- 本轮真实调用：T07D-R2-04 写任务 **2 次**（均未完成产物；原因见 §3），新额度 3 次中已用 2 次，剩 1 次。
- 产物：fixture 目录内 `.astarray/`（状态/任务链/工作存档）与 mission-500e9a58 / mission-7eb9bd92；
  `tasks/PROBE-001.md` **未创建**（授权未命中，工具未执行）。
- 无泄漏：命令输出仅含参数 JSON（用户可见内容），不含任何凭据值。

## 5. 后续（提交 `c1608b5`）：§3 的两个内核缺陷已修

| 缺陷 | 修复 | 证据 |
| --- | --- | --- |
| 授权双轨失配：裁决只写旧 `SessionAuthorizationManager`，判定侧 `ConfigurablePermissionPolicyEngine` 读自己的授权表 | `MainController.grantSessionAuthorization` 同时写入引擎（绑定当前 profile revision 与 catalogVersion）；`application-runtime` 注入引擎 | `tests/core/integration/permission-authorization-hit.test.ts`（修复前引擎裁决失败） |
| 参数哈希字节级敏感（键序不同即失配） | 新增 `canonicalizeToolArguments()`（对象键递归排序；数组顺序与值差异仍敏感；非 JSON 退回原文），`hashToolArguments` 与引擎 `hashArguments` 统一使用 | 同上用例的两条规范化断言 + 真实引擎 `ask → allow`（含键序不同） |

- `run-command.ts` 亦修正：unblock 之后必须等**新一轮** permission-ask 到达再裁决（不得用上一轮旧文本重复裁决）。
- 门禁（`c1608b5`）：`npm run check` exit 0 —— 全量 **245 文件 / 1921 用例**；
  覆盖率 **92.95 / 85.37 / 93.09 / 92.97**。

## 6. 仍未达成（端到端写任务）与下一步方向

离线复现（本地拦截代理 + 管道 `allow-once`）：

- 询问 → 授权 → unblock 均已真实发生（日志可见）；
- 代理侧只收到 **2 个**模型请求，任务最终 `status=blocked`、任务链 `T-001` 停在 `blocked`，
  工作存档只有一条 `decision | 等待权限: createProjectFile`，**没有第二轮执行的记录**；
- `tasks/PROBE-001.md` 未创建。

即：授权已在判定侧可命中（§5 已证），但 **unblock 之后的重跑/再派发没有把任务推进**。
下一步建议按此顺序定位（都不需要新的真实额度）：

1. 追踪 `assist-scheduler` 消费 `{"action":"unblock"}` 后是否真的重新派发给 Worker
   （`handleInstruction` → `unblockTask` → ready set → 派发）；
2. 检查 blocked 任务重新执行时是否复用同一 `agentInstanceId` 与任务包（是否会新建实例导致上下文丢失）；
3. 检查 `PolicyWrapper` 在重跑时是否拿到同一 `argumentsJson`（工具参数由模型重新生成，可能与首次不同 → 属正常二次裁决，但不应停在 blocked 且无新询问）。

