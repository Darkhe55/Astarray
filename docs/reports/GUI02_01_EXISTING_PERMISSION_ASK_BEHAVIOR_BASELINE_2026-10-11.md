# GUI-02-01 现有行为记录：CLI 权限询问（提取前基线）

> 目的：**先记录现有行为，再提取**（用户 2026-10-11 明确要求）。
> 本文件是"**CLI 公开可观察行为保持兼容**"的判据基线：提取到核心应用服务层后，
> 下列每一条都必须**逐条不变**；若发现现有缺陷，**另列返修、不混入提取**。
>
> 记录范围：`packages/tui/src/cli/permission-ask-adjudication.ts`、
> `permission-ask-wait.ts`、`run-command.ts`（调用点）。
> 本次为**只读记录**，未改动任何生产代码。

## 1. 公开可观察行为（必须保持不变）

| # | 项 | 现有行为 | 证据 |
| --- | --- | --- | --- |
| B1 | **提示文案** | 逐字如 §2 所列（含标点与括号） | `permission-ask-adjudication.ts:200,211,218,224` |
| B2 | **提示输出通道** | 交互提示默认 **stderr**（`logToStderr`），**保持 stdout 仅 JSON** | `:188,197` |
| B3 | **交互顺序** | ① 复用判定 → ② 已执行判定 → ③ 非交互判定 → ④ 交互询问 | `:204-221` 及后续 |
| B4 | **TTY / 管道处理** | 非交互环境**不授权、不 unblock**，只输出结构化询问 | `:221-230` |
| B5 | **等待与超时** | 见 `permission-ask-wait.ts`；`b6r10-permission-ask-wait.test.ts` 8 条钉住（已消费文本不得重复触发询问、超时窗口等） | 同左 |
| B6 | **退出码** | 由 `run-command.ts` 决定；`requires-human-resubmission` 与 `denied` 的可观察结果不变 | `run-command.ts` |
| B7 | **授权范围** | `allowed-once` 仅本次；**一次批准不等于后续批准** | `PermissionAskDecision` 类型 |
| B8 | **续跑语义** | 复用批准只对"同工具 + 同目标路径 + 尚无副作用"生效；已成功写入 ⇒ **fail-closed** `requires-human-resubmission` | `:37-43,68-79,209-214` |

> **兼容定义（用户原文）**："不要求源码一字不改" —— 允许改变**调用位置**与**文件归属**，
> 但 B1–B8 的公开可观察行为必须不变。

## 2. 现有文案逐字基线（改动即算行为变更）

| 位置 | 文案 |
| --- | --- |
| `:199-201` | `需要权限的调用已阻断，但未能确认被请求的工具与参数：请人工检查并重新提交任务。` |
| `:210-212` | `同一目标路径已成功写入过：不再自动授权 ${toolName}（如需再次执行请重新提交任务）。` |
| `:217-220` | `同一逻辑操作（${toolName} → ${argumentsJson}）已在本次授权内批准且尚无副作用：自动复用该批准，不再重复询问。` |
| `:223-225` | `需要用户裁决（非交互环境，未授权）：` + 结构化 JSON（ADR-0011 载荷形态） |

## 3. 现有契约（提取时必须原样保留语义，不得弱化）

### 3.1 请求形态

```ts
export interface PermissionAsk {
  taskIdentifier: string;
  toolName: string;
  /** 精确参数（授权哈希绑定用；不得改写、不得截断）。 */
  argumentsJson: string;
  explanation: string;
}
```

### 3.2 裁决结果

```ts
export type PermissionAskDecision =
  | "allowed-once"
  | "denied"
  | "requires-human-resubmission";
```

### 3.3 批准复用（方案 B，2026-10-02 用户选择）

判定依据**全部是本地客观事实**：工具名 + 参数中的**目标路径** + 是否已成功写入过。

| 条件 | 结果 |
| --- | --- |
| 目标路径相同 + 工具相同 + **尚无副作用** | `reuse-without-asking`（参数只有换行/键序等格式差异） |
| 该路径**已成功写入过** 且完整参数与上次相同 | `already-executed`（**fail-closed**） |
| 路径不同 / 工具不同 / 参数不可解析 / 无批准记录 | `ask-user` |

**目标路径键（与 `describeToolOperation` 同序）**：
`["path", "filePath", "targetPath", "directoryPath"]`

### 3.4 依赖边界（用户的硬要求）

> **核心代码不得反向依赖 TUI 类型或终端交互。**
> 提取位置：**核心应用服务层**（登记、状态迁移、裁决校验）。
> CLI 保留：终端输入输出适配（提示、TTY/管道判定、读决策、等待）。

**现状问题（提取的动机）**：上述契约目前**只存在于 `packages/tui`**，
`describeToolOperation` 亦在 `packages/core/src/tools/scope-authorization-gate.ts`
与 `packages/core/src/orchestration/main-controller.ts` 各自出现 ⇒
GUI 若要复用，只能**复制规则**（用户明确禁止）。

## 4. 提取后必须新增的反例（用户指定）

| # | 反例 | 说明 |
| --- | --- | --- |
| N1 | **同一请求经 CLI／GUI 裁决结果一致** | 同一 `askIdentifier` + 同决定 ⇒ 两个适配器得到同一结果，且只生效一次 |
| N2 | **重复裁决** | 同一请求重复提交裁决 ⇒ 不重复执行，第二次幂等失败 |
| N3 | **过期裁决** | 超过有效期或 revision 已前进 ⇒ 拒绝（不得复用批准） |
| N4 | **参数变化不得复用批准** | 改一个参数后用旧批准 ⇒ 必须失败（对应公共事件要求 S3） |

## 5. 公共事件字段白名单（用户 2026-10-11 指定）

**复用既有信封字段，不重复**；`explanation` 与参数摘要也必须**本地脱敏 + 长度限制**
（不得因名为"摘要"就信任模型文本）：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `projectIdentifier`、`sessionIdentifier` | 复用信封 | —— |
| **发起方具体 `agentInstanceId`** | 新增 | 不可复用身份，作为地址 |
| `action` | 新增 | 工具含多种操作时**必须明确**（如 create / overwrite） |
| `operationFingerprint` | 新增 | 绑定**本地保存的完整规范化参数** |
| 请求**状态** + 请求自身 **revision** | 新增 | 供多页面同步、拒绝陈旧裁决 |
| `askIdentifier`、`toolName`、有效期 | 新增 | —— |

**禁止**：原始 `argumentsJson` 进入公共事件（用户明确要求）。

### 5.1 关键参数的呈现方式（用户原文要点）

**必须**是**本地生成的结构化安全预览**，而非模糊的一句话。例如：
项目内**相对路径**、**创建/覆盖**动作、**内容长度**、**变更摘要**、**影响范围**；
文件写入可提供**按权限过滤的差异预览**；**敏感值遮蔽、不进入事件**。

**若脱敏后不足以让用户准确判断 ⇒ 不能要求用户盲批**：
改走**独立受控详情**或**专用授权流程**。
**指纹是绑定依据，不是用户理解操作的替代品。**

### 5.2 裁决入口的约束（用户原文要点）

入口接收：**请求 ID、决定、预期 revision／指纹**。
服务器**从本地权威记录取原始参数**，并重新校验**主体、权限、期限、当前状态**。

**禁止**：
- 接受前端提交的**新参数替换**原请求；
- 把"知道请求 ID 或指纹"当作**有权批准**。

## 6. 已补齐的基线值（本轮记录）

### 6.1 等待与轮询（`permission-ask-wait.ts`）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 轮询间隔 | **25 ms**（`PERMISSION_ASK_POLL_INTERVAL_MILLISECONDS`） | `:21` |
| 总等待上限 | `timeoutMilliseconds`（**由调用方传入**，本文件不设默认） | `:27,35,41` |
| 授权后重跑窗口 | `advancementWindowMilliseconds`（默认 `0`；任务重新推进到 `running` 时**仍继续等待**的窗口） | `:31,39,43` |

⇒ 提取时**不得**把这两个数值改成常量默认值或改变其语义。

### 6.2 操作类型集合（定义公共事件的 `action` 字段取值）

`describeToolOperation`（`packages/core/src/tools/scope-authorization-gate.ts`）当前返回
**4 种**：

| `operationKind` | 含义 | 行 |
| --- | --- | --- |
| `project-file-write` | 项目内文件写入（含目标路径） | `:741` |
| `project-file-read` | 项目内文件读取（含目标路径） | `:746` |
| `backup-deletion` | 备份删除 | `:749` |
| `unknown` | 参数不可解析 ⇒ **保守按未知范围处理** | `:725` |

⇒ 公共事件的 `action` 字段应**直接承载这组取值**（工具含多种操作时必须明确），
并保留 `unknown` 的**保守语义**（未知不得当作低风险）。

### 6.3 既有回归护栏（提取后必须全绿）

| 测试 | 条数 | 作用 |
| --- | --- | --- |
| `tests/tui/unit/b6r10-permission-ask-wait.test.ts` | **8** | 等待/去重/超时窗口 |
| 授权相关既有用例 | 待清点 | 下一次提取时逐项列出并运行 |

### 6.4 未实测项（如实标注）

- `run-command.ts` 中 `requires-human-resubmission` / `denied` 对应的**退出码**：
### 6.5 退出码：代码级确定（运行时未实测）

**结论（可核对）**：权限裁决结果 **不影响退出码**。

| 证据 | 内容 |
| --- | --- |
| `run-command.ts:215` | `permissionAskOutcome = decision;`（记录裁决结果） |
| `run-command.ts:240` | `...(permissionAskOutcome === null ? {} : { permissionAsk: permissionAskOutcome })` —— **只写进 JSON 载荷** |
| `run-command.ts` | 全文**没有**依据 `permissionAskOutcome` 设置退出码的分支（检索 `process.exitCode` 无命中） |
| `commands.ts` | run 路径统一返回 `EXIT_CODES.SUCCESS`；**仅**用法错误走 `EXIT_CODES.USAGE_ERROR`（`:116`） |

⇒ 因此 `denied` 与 `requires-human-resubmission` **都返回成功退出码**，
状态通过 JSON 载荷的 `permissionAsk` 字段与任务状态（保持阻塞）表达。

**为何未做运行时实测（如实说明）**：要走到该分支需让任务**请求受限工具**并产生升级文本；
在 mock 运行时下无法确定性地触发（mock 执行器是否请求 `createProjectFile` 未经验证）。
**硬写一个依赖不确定行为的测试会引入假绿/假红，故不写**；
本项以**代码级证据**记录，**运行时退出码仍标为未实测**。

- TTY / 非 TTY 两条路径的**逐字输出**（含 stdout/stderr 分离）：本轮**未实测**。

> **结论**：baseline 已足以界定 B1–B8 的兼容边界与 `action` 取值；
> 退出码与 TTY 输出这两项**在提取前实测补齐**，否则不作为已验判据。

