# BRIDGE-01-03 边界与断连 — 实现与证据

> 检查点：BRIDGE-01-03（docs/tasks/BRIDGE01_EXTERNAL_TOOL_MVP_TASK_CARD.md）
> 前驱：BRIDGE-01-02（MCP 最小工具映射）。日期：2026-09-12

## 1. 交付

| 能力 | 实现 |
| --- | --- |
| 会话隔离 | `McpToolBridge.openSession/closeSession/isSessionOpen`；每次连接分配不可复用 `agentInstanceId`；任务归属按**认证主体**判定 → 跨主体一律 `task-not-accessible` |
| 断连重试 / 重放不重复 | 同一认证主体重连（新会话、新实例 ID）后：同一幂等键返回同一任务、不重复提交；仍可读取自己的任务 |
| 会话关闭 | 关闭或未打开的会话一律 `bridge-session-closed`；`runMcpStdioSession` 在输入流结束（断连）时自动关闭会话 |
| 逐次权限复检 | `McpBridgePermissionRecheckPort`：**每次** `tools/call` 先本地复检，拒绝时 `bridge-permission-denied` 且不触达应用服务（默认允许端口由装配方替换为真实策略） |
| 结果脱敏 | `McpBridgeResultRedactionPort`（默认复用 T02 `Redactor`）：返回文本与**错误消息**都脱敏，秘密不回显 |
| 协议层不执行底层写工具 | `MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES`（replaceFileContent/createProjectFile/writeFileTemporary/backupVault/deleteBackup/gitCommit/runCommand/shell）显式拒绝，且不出现在 `tools/list` |
| 取消后续写 | `cancel_task` 只返回本地权威状态且 `result: null`；取消后 `read_result` 仅返回 `cancelled` 状态，不返回结果 |

## 2. 验收对照（共同契约：反例优先）

| 验收条款 | 反例/证据 |
| --- | --- |
| 跨主体访问拒绝 | 桥接用例「跨主体访问任务一律拒绝（不区分不存在/不属于）」（query/read/cancel 三工具） |
| 重放不重复任务 | 桥接用例「同一主体重连后重放同一幂等键不重复任务」（`submissions` 仍为 1） |
| 输出注入 | 身份字段（含 `user:` 前缀主体、`sourceKind`、`agentInstanceId`、`sessionIdentifier`）与优先级字段注入均被拒；注入值中的秘密同样被脱敏 |
| 秘密回显 | 桥接用例「结果与错误消息均脱敏」：`sk-…` 与 `api_key=…` → `[REDACTED]` |
| 取消后续写 | 桥接用例「取消后不返回结果…」+「协议层拒绝本地写/执行工具」 |
| 会话隔离/关闭/断连 | 桥接用例「会话关闭或未打开一律 bridge-session-closed」；stdio 用例「断连即关闭桥接会话」 |
| 逐次权限 | 桥接用例「每次调用都复检」（复检次数 2、应用服务零调用） |

## 3. 命令、退出码与覆盖率

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；**180 文件 / 1531 用例**通过 |
| `npm run test:coverage` | exit 0；全局 93.69% stmts / **86.52% branch** / 91.94% funcs / 93.73% lines；`core/src/bridge` 目录 98.96% stmts / 86.89% branch / 100% funcs / 98.95% lines（`mcp-tool-bridge.ts` 90.24% branch） |
| 聚焦 | `mcp-tool-bridge` 15/15、`mcp-stdio-session` 12/12 |
| 关键安全模块专项 | 上一轮 22/22 ≥95%（本轮未改动该清单模块） |

## 4. 遗留

- **BRIDGE-01-04 真实客户端消费**：需要真实 MCP 客户端（待确认依赖，按协同安装门禁先询问用户），
  并出具绑定版本与平台的对外支持声明。
- 既有 `orchestration/external-harness-bridge-port.ts` 仍保留"用户来源主体需 `user:` 前缀"的旧规则；
  MCP 桥接链路不使用该规则（认证主体只由 harness 注入）。后续可在该旧契约下次修订时一并移除前缀式判断。
