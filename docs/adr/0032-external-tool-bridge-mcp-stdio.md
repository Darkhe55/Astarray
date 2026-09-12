# ADR-0032：外部工具桥接采用 MCP（2026-07-28）与 stdio 传输

- 状态：Accepted（BRIDGE-01-01 冻结）
- 日期：2026-09-12
- 来源：BRIDGE-01 任务卡（Agent 派生实施方案）；规范依据为官方规范（见"参考"）

## 背景

需要让外部工具/宿主以受控方式调用本地应用服务（提交任务、查询、取消、读取结果）。
任务卡要求：优先准备 MCP 接入候选；**只实施一种协议与一种传输**，
禁止同时实施 MCP/A2A/通用 HTTP 三套；未实现协议不得声明支持。

## 决策

1. **协议**：Model Context Protocol（MCP），修订 **2026-07-28**（官方 versioning 页标注的
   *Current* 版本；修订标识为 `YYYY-MM-DD`；协议版本随每次请求经
   `_meta.io.modelcontextprotocol/*` 声明并协商）。
2. **首个传输**：**stdio**。客户端以子进程方式启动本地服务器
   （`astarray mcp serve`），双端通过 stdin/stdout 交换**换行分隔的 JSON-RPC** 消息；
   不监听端口、不联网、不使用 OAuth。
   *（本决策不依赖"没有 HTTP server 就没有 MCP"的推断：stdio 就是官方标准传输之一。）*
3. **暂不实现**：MCP Streamable HTTP、A2A、通用 HTTP 工具桥、经 Unix domain socket/TCP 的
   stdio 风格通道——在实现并通过一致性验证前**不对外声明支持**。
4. **认证与主体绑定**：按规范，stdio 传输 **SHOULD NOT** 使用 HTTP 授权流程，
   凭据只从环境变量读取（如有），绝不从消息内容、模型声明或字符串前缀推断主体；
   外部 Agent 提交的任务一律以 `sourceKind: "agent"` 记录，**不得占用用户优先级层级 0**。
5. **取消语义**：stdio 下客户端发送 `notifications/cancelled`（含被取消的 JSON-RPC 请求 id 与可选原因），
   桥接映射为本地任务取消；每个请求设置**有界超时**，超时按取消处理；
   `notifications/progress` 可按规范用于重置超时。
6. **异步结果语义**：`tools/call` 的返回是**受理回执**（任务标识 + 当前状态），
   **受理绝不等于完成**；完成/失败/取消只能经 `query_task`/`read_result` 的本地权威状态读取，
   且桥接不得改写本地状态机。
7. **最小工具面**（BRIDGE-01-02 实现）：`submit_task`、`query_task`、`cancel_task`、
   `read_result` —— 全部为公共应用服务（AstarrayApplicationFacade）之上的薄适配，
   不新增第二套权限/任务/Provider 逻辑；`submit_task` 绑定幂等键（重复提交返回同一任务）。
8. **目标客户端**：以 **Claude Desktop** 作为参考客户端（官方"连接本地 MCP 服务器"文档给出
   基于配置的 stdio 启动方式）；BRIDGE-01-04 的无头验证客户端（MCP 客户端 SDK/Inspector）
   属待确认依赖，按协同安装门禁先询问用户是否已有可用资源。

## 兼容矩阵（冻结时的声明）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| MCP / stdio（2026-07-28） | ✅ 目标（BRIDGE-01-02..04 实现） | 换行分隔 JSON-RPC；stderr 仅日志；stdout 只允许合法 MCP 消息 |
| MCP / Streamable HTTP | ⬜ 未实现，不声明支持 | 需按规范实现 HTTP 授权一致性 |
| A2A | ⬜ 未实现，不声明支持 | 本卡范围外 |
| 通用 HTTP 工具桥 | ⬜ 未实现，不声明支持 | 本卡范围外 |
| 其他 stdio 风格通道（UDS/TCP） | ⬜ 未实现，不声明支持 | 规范允许，但本批不实现 |

## 后果

- 新增 CLI 入口 `astarray mcp serve`（stdio 子进程；无常驻 HTTP 服务、无端口监听）。
- 桥接层只做协议适配与主体/幂等绑定；所有写入仍经本地确定性权限策略与工具边界。
- 若目标客户端被判定不支持 stdio 或需要 HTTP，则按任务卡要求**在编码前调整本卡**，
  而不是并行实现多套协议。

## 参考（2026-09-12 读取）

- 版本与修订：https://modelcontextprotocol.io/docs/learn/versioning.md
- 规范索引（含 schema 链接）：https://modelcontextprotocol.io/specification/2026-07-28/index.md
- 传输总览：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md
- stdio 绑定：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md
- 授权：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md
- 取消：https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation.md
- 本地客户端接入（Claude Desktop 为例）：https://modelcontextprotocol.io/quickstart/user.md
