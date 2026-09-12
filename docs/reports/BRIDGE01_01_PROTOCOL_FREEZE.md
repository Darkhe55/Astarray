# BRIDGE-01-01 目标与协议冻结 — 证据

> 检查点：BRIDGE-01-01（docs/tasks/BRIDGE01_EXTERNAL_TOOL_MVP_TASK_CARD.md）
> 前驱：T07D-R1（已通过）。日期：2026-09-12
> 决策记录：docs/adr/0032-external-tool-bridge-mcp-stdio.md

## 1. 验收对照

| 验收条款 | 结果 |
| --- | --- |
| 选择一种协议及一个目标客户端 | **MCP 2026-07-28 + stdio**；参考客户端 **Claude Desktop**（官方文档给出基于配置的本地 stdio 服务器接入） |
| 确认目标宿主已有接入能力 | 官方 quickstart（"Connect to local MCP servers"）以 Claude Desktop 为例；同页说明"many clients support MCP"（引用见 §3） |
| 列出兼容矩阵 | ADR §兼容矩阵：MCP/stdio ✅ 目标；MCP/Streamable HTTP、A2A、通用 HTTP 桥、UDS/TCP ⬜ 未实现且**不声明支持** |
| 未实现协议不声明支持 | 同上（ADR 明确"在实现并通过一致性验证前不对外声明支持"） |
| MCP 是否匹配目标（如需调整在编码前） | 匹配：stdio 为官方标准传输，无需 HTTP 服务；若 BRIDGE-01-04 的真实客户端不支持 stdio，则按卡要求在编码前调整，而不是并行实现多套协议 |

## 2. 冻结内容摘要（规范依据）

| 维度 | 冻结值 | 依据 |
| --- | --- | --- |
| 协议 | MCP，修订 `2026-07-28` | 官方 versioning 页标注为 *Current*；修订为 `YYYY-MM-DD`；版本随请求经 `_meta.io.modelcontextprotocol/*` 声明 |
| 传输（首个） | **stdio**（客户端启动子进程；换行分隔 JSON-RPC；stdout 仅允许合法 MCP 消息；stderr 仅日志） | stdio 绑定页 |
| 认证 | stdio **SHOULD NOT** 走 HTTP 授权流程；凭据来自环境变量；主体由本地 harness 绑定 | authorization 页 "Protocol Requirements" |
| 取消 | 客户端发 `notifications/cancelled`（requestId + 可选 reason）；每请求有界超时；progress 可重置超时 | cancellation 页 "Transport-Specific Cancellation" / "Timeouts" |
| 异步结果 | `tools/call` 返回**受理回执**，受理≠完成；完成/失败/取消经本地权威状态读取 | ADR §决策 6（并对照任务卡 -02 验收"接受回执不误报完成"） |
| 工具面 | `submit_task`/`query_task`/`cancel_task`/`read_result` | 任务卡 -02；复用公共应用服务 |

## 3. 规范与文档引用（2026-09-12 读取）

- 版本/修订状态：https://modelcontextprotocol.io/docs/learn/versioning.md
- 规范索引 + schema：https://modelcontextprotocol.io/specification/2026-07-28/index.md
- 传输总览（含 custom transports）：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md
- stdio 绑定（消息分帧/流方向/stderr）：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md
- 授权（OAuth 2.1 draft-13 / RFC6750 / RFC8414 / RFC7591 / RFC8707 / RFC9728 / RFC9207）：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md
- 取消与超时：https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation.md
- 本地客户端接入（Claude Desktop）：https://modelcontextprotocol.io/quickstart/user.md

## 4. 依赖与风险

| 项 | 状态 |
| --- | --- |
| 真实 MCP 客户端（BRIDGE-01-04 无头验证） | **待确认**：本地当前未见可用客户端；按协同安装门禁需先询问用户是否已有资源，再考虑逐次授权安装（不隐式下载） |
| Linux/macOS 平台 | ⬜ 未验证（本批仅 Windows 本机可执行；stdio 本身平台无关，但仍需平台证据） |
| Streamable HTTP / A2A / 通用 HTTP | ⬜ 明确不在本批范围，也不声明支持 |

## 5. 本轮无产品代码变更

本检查点为**决策/冻结**检查点（同类于 INT-00 文档阶段）：无产品代码改动，
故未运行覆盖率；`npm run check` 的结果与上一轮一致（178 文件 / 1504 用例，
全局 branch 86.54%，见 docs/reports/E2E01_04_QUALITY_STATEMENT.md）。
