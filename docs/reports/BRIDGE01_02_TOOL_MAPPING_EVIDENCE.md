# BRIDGE-01-02 最小工具映射 — 实现与证据

> 检查点：BRIDGE-01-02（docs/tasks/BRIDGE01_EXTERNAL_TOOL_MVP_TASK_CARD.md）
> 前驱：BRIDGE-01-01（ADR-0032：MCP 2026-07-28 + stdio）。日期：2026-09-12

## 1. 交付

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| MCP 工具桥接 | `packages/core/src/bridge/mcp-tool-bridge.ts` | 四个工具（`submit_task`/`query_task`/`cancel_task`/`read_result`）+ 本地强制规则；薄适配公共应用服务 |
| MCP stdio 会话 | `packages/core/src/bridge/mcp-stdio-server.ts` | 换行分隔 JSON-RPC：`initialize`/`tools/list`/`tools/call` 与 `notifications/cancelled`；stdout 仅合法 MCP 消息 |
| 公共入口 | `astarray mcp serve`（cli.tsx + commands.ts） | 以 stdio 运行；认证主体由本地 harness 注入（`ASTARRAY_MCP_PRINCIPAL`/`ASTARRAY_MCP_AGENT`，缺省为本地 stdio 主体） |

## 2. 验收对照

| 验收条款 | 实现 | 证据 |
| --- | --- | --- |
| 接受回执不误报完成 | `submit_task` 固定返回 `status: "accepted"`、`isCompleted: false`；完成/失败/取消只能经 query/read_result 读取本地权威状态 | 桥接用例「受理回执永不误报完成」；stdio 用例「tools/call submit_task 返回受理回执」 |
| 外部 Agent 不能冒充用户优先级 0 | 参数中出现 `priorityTier`/`priority`/`tier`/`isUserTask`/`isUserPriority` → `bridge-priority-injection-rejected`（拒绝而非静默忽略） | 桥接用例「参数携带优先级字段一律拒绝」 |
| 字符串 user 前缀或 schema 通过不构成认证 | 参数中出现 `sourceKind`/`sourceActorId`/`authenticatedPrincipal`/`agentInstanceId`/`sessionId` → `bridge-identity-injection-rejected`；来源恒为 `agent`，主体只由 harness 注入 | 桥接用例「参数携带身份字段一律拒绝」「来源恒为 agent，不因主体前缀获得用户权限」 |
| 绑定任务 ID 与幂等键 | 幂等键必填（≤200）；同主体同键重复提交返回同一任务且不重复调用应用服务 | 桥接用例「同一幂等键重复提交返回同一任务」 |
| 复用应用服务 | 桥接仅依赖 `McpBridgeApplicationPort`（`submitTask`/`queryTask`/`cancelTask`），由 `AstarrayApplicationFacade` 实现 | `mcp serve` 装配；跨主体访问拒绝用例 |
| 其他边界 | 跨主体访问一律 `task-not-accessible`（不区分不存在/不属于）；未完成不返回结果；取消映射本地取消；未知工具/非法参数有稳定错误码；`initialize` 版本协商；解析错误 -32700 / 方法不存在 -32601 / 参数非法 -32602 / 内部异常 -32603 | 桥接 13 例 + stdio 11 例 |

## 3. 命令、退出码与覆盖率

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；**180 文件 / 1528 用例**通过 |
| `npm run test:coverage` | exit 0；全局 93.7% stmts / **86.54% branch** / 91.9% funcs / 93.73% lines；`core/src/bridge` 目录 100% stmts/funcs/lines、**88.49% branch**（`mcp-tool-bridge.ts` 94.23% branch） |
| `npm run verify:security-coverage` | exit 0；关键安全模块 **22/22 ≥95%**（本检查点未改动该清单模块） |
| 聚焦 | `mcp-tool-bridge` 13/13、`mcp-stdio-session` 11/11 |

## 4. 兼容与遗留

- 未实现协议（MCP Streamable HTTP、A2A、通用 HTTP 桥、UDS/TCP）仍**不声明支持**（ADR-0032）。
- 既有 `orchestration/external-harness-bridge-port.ts`（T07D-08 冻结契约）仍保留"用户来源主体需 `user:` 前缀"的旧规则；本检查点的 MCP 路径**不依赖前缀认证**，该旧契约不在 MCP 桥接链路上（BRIDGE-01-03 处理边界时一并收紧/标注）。

## 5. 下一检查点

**BRIDGE-01-03 边界与断连**：会话隔离、逐次权限复检、结果脱敏、断连重试、取消与服务关闭；
协议层不得直接执行底层写工具。
