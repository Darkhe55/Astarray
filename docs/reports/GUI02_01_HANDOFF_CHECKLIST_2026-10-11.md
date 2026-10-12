# GUI-02-01 交接清单（2026-10-11）

> 目的：把 GUI-02-01 的**已交付物**与**剩余可执行片**写成可直接接手的形式。
> 本文件由自动续跑轮次（context 预算耗尽）交付，**不含新代码**，只做交接。
> 基线提交：`4f4e50b`（`== origin/main`）。

## 1. 已交付物（可核对，均已推送）

### 1.1 核心模块（`packages/core/src/orchestration/`）

| 文件 | 职责 | 关键性质 |
| --- | --- | --- |
| `permission-ask-contract.ts` | 契约与**纯判定**（从 CLI 提取） | `shouldReusePreviousApproval` 现绑定**完整规范化参数指纹**（R1）+ 有效期 |
| `permission-ask-request-store.ts` | **请求实体**：登记 / 状态机 / revision / 有效期 / 裁决校验 | 只有 `pending` 可裁决；重复裁决幂等失败；过期落 `expired` |
| `permission-ask-event.ts` | **公共事件**（字段白名单） | **禁止原始 `argumentsJson`**；只携带安全预览 |
| `permission-ask-safe-preview.ts` | **本地结构化安全预览** | 脱敏 + 限长 + 截断标注；敏感路径回退受控详情 |
| `permission-ask-decision-entry.ts` | **裁决入口公共服务** | CSRF/主体/可见性/裁决权；**入参无参数位**；并发单一生效；CLI 与 GUI **共用** |

`packages/core/src/core/errors.ts`：新增 10 个错误码
（`permission-ask-{not-found,not-authorized,expired,already-decided,stale-revision,fingerprint-mismatch,invalid,csrf-required,unauthenticated,not-visible}`）。

`packages/tui/src/cli/permission-ask-adjudication.ts`：改为从核心**再导出**契约与纯判定，
**只保留终端 I/O 适配**（提示/stderr、TTY·管道判定、stdin 行读取、交互端口、裁决流程）。

### 1.2 测试（`tests/core/unit/gui02-01-*.test.ts`，共 8 个文件）

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `gui02-01-permission-ask-request-entity.test.ts` | 11 | 身份/指纹（含键序不变性）、持久化重启仍 pending、状态机、重复裁决、过期、陈旧 revision/指纹、无裁决权、未登记 |
| `gui02-01-permission-ask-safe-preview.test.ts` | 9 | 白名单且无 `argumentsJson`、秘密值绝不出现、脱敏生效、截断标注、敏感路径回退 |
| `gui02-01-permission-ask-coverage-branches.test.ts` | 21 | 动作判定各分支、路径归属、批量计数、候选键、可注入匹配器、非法有效期等 |
| `gui02-01-permission-ask-event.test.ts` | 6 | 事件白名单、必含字段、结构化预览、秘密不出现、敏感标记、裁决后新状态 |
| `gui02-01-permission-ask-decision-entry.test.ts` | 9 | CSRF/主体/可见性/裁决权、入参无参数位、并发单一生效、执行前重新鉴权 |
| `gui02-01-permission-ask-shared-service-consistency.test.ts` | 5 | N1 跨调用方一致、N2 重复/过期（**验证性用例**，非驱动性红例） |
| `gui02-01-r1-approval-fingerprint-reuse.test.ts` | 9 | R1：内容变化须重问 / 键序不同仍复用 等两条对称反例 |
| `gui02-01-permission-ask-fingerprint-gap.test.ts` | 8 | 原"记录现状"用例 ① 已按 R1 改写为期望行为 |

### 1.3 文档

- `docs/tasks/GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD.md` —— 检查点与用户边界（含字段白名单、S1–S6、N1–N4）
- `docs/reports/GUI02_01_EXISTING_PERMISSION_ASK_BEHAVIOR_BASELINE_2026-10-11.md` —— B1–B8 行为基线（含 §6.5 退出码的代码级证据）
- `docs/reports/GUI02_01_REMEDIATION_APPROVAL_FINGERPRINT_GAP_2026-10-11.md` —— 缺陷条目（**已修，方案 R1 / 用户选 A**）
- `docs/reports/COVERAGE_FLAKE_COUPLING_CORRECTION_2026-10-11.md` —— 覆盖率与抖动耦合的更正

## 2. 剩余可执行片（按依赖排序，每片一轮）

### 片 ①：CLI 注册接入（**建议下一片**）

- **目标**：CLI 路径请求受限工具时**生成请求实体**（`askIdentifier` + `operationFingerprint` + `pending`），
  但**裁决仍走既有 `runPermissionAskAdjudication`** ⇒ **公开行为不变**。
- **先写的反例**（`tests/tui/unit/`）：断言"经 CLI 路径会落盘一条 `pending` 请求实体，
  且 `permission-ask-reuse` / `adjudication` 的既有可观察行为不变"。
- **改动点**：`packages/tui/src/cli/permission-ask-adjudication.ts`（或其调用点）；
  需新增 `PermissionAskRequestStore` 的装配位置。
- **回归**：`permission-ask-reuse`(7) + `permission-ask-adjudication`(10) +
  `permission-ask-timeout`(5) + `b6r10-permission-ask-wait`(8) +
  `authorization-retry-closure` + `run-command-gaps`。

### 片 ②：事件接入（SSE / `/state`）

- **目标**：`PermissionAskRequestStore` 装配进 `packages/core/src/application/application-runtime.ts`；
  门面可读（如 `listPermissionAskRequests()`）并发布 `permission-ask` 事件。
- **建议拆两步**：先**只装配 + 可读**（不发布事件），再单独接事件发布。
- **反例**：断言门面读取返回实体、事件不含 `argumentsJson`、多页面同步所需的
  `status` + `requestRevision` 齐备。

### 片 ③：CLI 裁决接入同一服务

- **目标**：CLI 的**决定**改为调用 `PermissionAskDecisionEntryService`（兑现"GUI 使用同一服务"）。
- **注意**：CLI 侧目前**没有** `sessionIdentifier` / subject 解析，
  需要宿主提供 `PermissionAskAuthorityPort` 与 CSRF 事实。
- **反例**：N1（同一请求经 CLI/GUI 结果一致）在**真实 CLI 路径**上成立。

### 片 ④：基线两项

- `run-command.ts` 退出码：**代码级已定**（`§6.5`：不影响退出码，统一 `EXIT_CODES.SUCCESS`）；
  **运行时未实测** —— 需真实受限工具调用。
- TTY / 非 TTY **逐字输出**：**未实测**，需真实 TTY。

## 3. 已知陷阱（前车之鉴，务必先读）

1. **JSDoc 陷阱**：注释里出现 `*/`（例如写 `agent-memory/*/xxx/`）会**提前关闭注释块**，
   导致 `TS1434/TS1068/TS1160` 整文件解析失败。本会话已踩两次。
2. **CRLF**：仓库文件多为 CRLF，用文本锚点做批量替换前**先规范化为 LF**，写完按需落盘。
3. **覆盖率门槛贴线**：四维均为 **85**，全局分支约 11033，安全余量仅 **≈16 个分支**；
   负载抖动会让它翻红（见 `COVERAGE_FLAKE_COUPLING_CORRECTION`）。**不得放宽门槛**。
4. **`check` 偶发抖动**：首跑可能 1 failed，**复跑**即可确认；**不得放宽断言**。
5. **暂存纪律**：`git add` 只加本片文件；提交前用 `git diff --cached --name-only`
   确认**不含 `README.md`**（用户的并行改动）。
6. **更新既有 spec 前先核对原则**：本会话发现 `permission-ask-reuse` ① 与
   `canonicalizeToolArguments` 的既定原则相矛盾；**遇到冲突不要静默改断言**，
   先核对该模块的文档原则与用户要求，再决定并**在文件头写明理由**。

## 4. 不需要再做（已闭环）

- MCP 协议版本协商（`f28c17e`）
- 跨平台 `npm-cli.js` 解析（`bb8d192`）
- GUI CSRF / `undefined` / 死条目 / `internal-error` / 追认后仍列出 / 重连丢快照（6 个缺陷）
- COMM-01-01 审计（`49352ae`）
- BRIDGE-01-04 真实客户端消费（`e364228`）

---

## 5. 片 ① 的精确补丁草案（2026-10-11 侦察所得，**未实施**）

> 目的：把下一片的改动点缩小到**一处 import + 一处调用**，免去再次侦察。
> **本草案未经实施与验证**，应用后必须按 §2 片① 的流程跑反例与门禁。

### 5.1 接入点（已核对）

| 项 | 值 |
| --- | --- |
| 文件 | `packages/tui/src/cli/run-command.ts` |
| 导入区 | 第 **11–17** 行（`./permission-ask-adjudication.js` 的具名导入） |
| 注册点 | 第 **207** 行：`const decision = await runPermissionAskAdjudication({` **之前** |
| 现成依赖 | `RunCommandOptions.stateDirectory: string`（第 **44** 行）—— **无需新增注入** |
| 上游事实 | `permissionAsk`（含 `taskIdentifier` / `toolName` / `argumentsJson` / `explanation`）为该处已有变量；`escalationMessages`（第 109 行）是其来源 |

### 5.2 草案（示意，非最终）

```ts
// 导入区（在 ./permission-ask-adjudication.js 导入之后）
import { PermissionAskRequestStore } from "../../../core/src/orchestration/permission-ask-request-store.js";

// 注册点：第 207 行 runPermissionAskAdjudication 调用**之前**
if (permissionAsk !== null) {
  const requestStore = new PermissionAskRequestStore({
    baseDirectory: options.stateDirectory,
  });
  await requestStore.registerRequest({
    ownerAgentInstanceId: /* 该 CLI 路径的 owner 事实 */,
    taskIdentifier: permissionAsk.taskIdentifier,
    toolName: permissionAsk.toolName,
    argumentsJson: permissionAsk.argumentsJson,
    explanation: permissionAsk.explanation,
  });
}
```

### 5.3 必须先解决的两个开放点（下一片要定，勿跳过）

1. **`ownerAgentInstanceId` 取哪个值？**
   该 CLI 路径目前是 worker 伪个体（`worker:${missionId}:${taskId}` 形态）。
   需**先确认**它与 `PermissionAskRequestStore` 的 owner 语义一致
   （store 的磁盘布局是 `agent-memory/<owner>/permission-ask-requests/`）。
   **若不确认就填，会写出与后续裁决入口（按 `askIdentifier` 反查）不匹配的目录。**
2. **是否要保留 `registerRequest` 的返回值？**
   片 ① 的目标只是"**落盘实体、行为不变**"，故草案**丢弃返回值**；
   片 ③ 才需要把 `askIdentifier` 传给裁决入口。

### 5.4 反例（片 ① 该先写的）

- **正向**：经 CLI 路径请求受限工具 ⇒ `agent-memory/<owner>/permission-ask-requests/` 下**出现一条
  `status: "pending"`** 记录，且 `operationFingerprint` 为 `sha256:` + 64 hex。
- **行为不变**（关键）：既有授权回归 **6 套全绿**（`permission-ask-reuse` 7 /
  `adjudication` 10 / `timeout` 5 / `b6r10-permission-ask-wait` 8 /
  `authorization-retry-closure` / `run-command-gaps`）。
- **失败模式**：若注册失败，**不得**因此放行或阻断裁决 —— 需明确该失败对
  `runPermissionAskAdjudication` 的影响（建议 fail-closed 并如实上报）。

---

## 6. 片 ① 反例的可复用 harness（2026-10-11 第二轮侦察，**未实施**）

> 这消除了片 ① 最大的成本项：**不必自建"触发权限询问"的场景**。

| 项 | 值 |
| --- | --- |
| **复用文件** | `tests/tui/integration/authorization-retry-closure.test.ts` |
| **手法** | `spawn` 真实 CLI 子进程 + 本地 **HTTP 假 Provider** |
| **关键行** | 该文件第 **51** 行返回工具调用：`{ name: "createProjectFile", arguments: argumentsJson }` |
| **为何可用** | 它**已经**端到端走到 `run-command.ts:207` 的权限询问分支（本会话曾据它发现 unblock 竞态缺陷） |
| **依赖** | `node:child_process.spawn`、`node:http`、`node:fs`、`node:os`、`node:path`（该文件已 import） |

### 6.1 片 ① 该写进该文件的断言

1. **正向（新行为）**：CLI 运行结束后，`<stateDirectory>/agent-memory/<owner>/permission-ask-requests/`
   下**存在一条记录**，且：

   - `status === "pending"`
   - `operationFingerprint` 匹配 `/^sha256:[a-f0-9]{64}$/`
   - `argumentsJson` 与假 Provider 发出的**逐字一致**（不得改写、不得截断）

2. **行为不变（关键）**：同一次运行中既有裁决行为不变 —— 即**授权回归 6 套仍全绿**：
   `permission-ask-reuse`(7) / `adjudication`(10) / `timeout`(5) /
   `b6r10-permission-ask-wait`(8) / `authorization-retry-closure` / `run-command-gaps`。

3. **失败模式**：若 `registerRequest` 失败（磁盘满/权限），**必须 fail-closed 且如实上报**，
   **不得**因此静默放行（放宽授权）或静默阻断裁决（改变行为）。

### 6.2 仍需先定的开放点（同 §5.3，勿跳过）

- `ownerAgentInstanceId` 取哪个值 —— 该路径目前是 worker 伪个体；store 的布局是
  `agent-memory/<owner>/permission-ask-requests/`，**填错会写出与"按 `askIdentifier` 反查"
  不匹配的目录**；
- 片 ① 只求"落盘 + 行为不变"⇒ `registerRequest` 返回值可丢弃；片 ③ 才需把
  `askIdentifier` 传给裁决入口。

### 6.3 成本估计（供排期）

| 步骤 | 说明 |
| --- | --- |
| 反例 | 在既有文件内**新增用例**（复用 harness）⇒ 小 |
| 实现 | `run-command.ts` **一处 import + 一处调用**（§5.2 草案）⇒ 小 |
| 验证 | 6 套授权回归 + `check` + `test:coverage`（branch 门槛 85，余量约 16 分支） |
| 提交 | 单独提交；暂存前确认**不含 `README.md`** |
