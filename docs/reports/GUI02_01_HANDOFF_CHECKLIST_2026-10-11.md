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
