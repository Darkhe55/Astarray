# BRIDGE-01-04 真实第三方客户端消费证据（2026-10-10）

> 检查点 BRIDGE-01-04 的"**真实客户端完整闭环**"部分。
> 客户端：**`opencode` 1.18.35** 与 **`pi`（`@earendil-works/pi-coding-agent` 1.1.0）**，
> 均为本机已安装的**第三方**客户端，通过 **MCP stdio** 消费本仓桥接。
> 桥接来源：隔离安装的 tarball（**当前 HEAD**，非工作区源码）。
> **token 实际消耗：两次成功闭环合计约 1 万 input tokens，全部为用户授权的真实额度。**

## 0. 为什么这一步不可替代 —— 本轮实测印证了卡内判断

脚本化闭环（`scripts/verify-mcp-bridge-loop.mjs`，20/20）里那个"客户端"是
**我们自己按自己的理解写的** ⇒ 它回显我们自己通告的版本，"协商成功"是**自证**。

本轮**两个真实客户端立刻各暴露一个脚本永远发现不了的问题**：

| # | 真实客户端暴露的问题 | 脚本化闭环能否发现 |
| --- | --- | --- |
| 1 | **协议版本 `2026-07-28` 不被任何真实客户端接受** ⇒ 两家都**直接拒连** | ❌ 不能（脚本回显我们自己的版本） |
| 2 | **跨主体访问返回业务级失败**（`task-not-accessible`），而非协议错误 | ❌ 不能（脚本的主体是我们自己注入的，不会去试别人的任务） |

问题 1 已修复（见 §2）。问题 2 是**正确行为**，但它"是业务失败而不是协议崩溃"
这一点**只有真实客户端能证明**（它决定客户端把失败呈现成错误还是正常结果）。

## 1. 环境与配置

| 项 | 值 |
| --- | --- |
| 桥接 | 隔离安装 tarball `astarray-0.1.0.tgz`（含本轮 MCP 协商修复）→ `.tmp/bridge01-04-install` |
| 传输 | stdio，换行分隔 JSON-RPC；stdout 仅 MCP 消息 |
| 工具面 | `submit_task`、`query_task`、`cancel_task`、`read_result`（**4 个**，两家客户端实测列举一致） |
| 主体注入 | `ASTARRAY_MCP_PRINCIPAL`，两家分别设为 `external-harness:pi` / `external-harness:opencode` |
| 共享状态 | 两个客户端指向**同一状态目录**（`cwd=.tmp/bridge01-04-clients`），故可交叉验证主体隔离 |
| `pi` 模型 | 云之声 `u2-flash`（**用仓库中有效的云之声凭据**；pi 自己 `models.json` 里那把 key 已失效 —— 直连端点亦 401） |
| `opencode` 模型 | `stepfun/step-3.7-flash`（用户本轮新增）；**`opencode/*` 全部免费项与 `teamorouter/deepseek-flash-free` 实测不可用/拥挤**，如实记录 |

**凭据纪律**：本轮**未打印、未落盘**任何密钥。`pi` 的 `--api-key` 只接受从文件读入的
变量（值从不进入日志）；仓库云之声凭据始终经受保护文件路径读取。

## 2. 阻断性发现并已修复：MCP 协议版本不被真实客户端接受

**现象**（修复前，两家一致）：

```
astarray failed — Server's protocol version is not supported: 2026-07-28
```

**根因**：`MCP_SUPPORTED_PROTOCOL_VERSION = "2026-07-28"`，且 `initialize`
**无条件**回该值。真实客户端支持集（从其实现读出）：

- `@earendil-works/pi-mcp`：`SUPPORTED_PROTOCOL_VERSIONS =`
  `["2025-11-25","2025-06-18","2025-03-26","2024-11-05"]`，
  按 `LATEST_PROTOCOL_VERSION = "2025-11-25"` 发起；
- `opencode`：同样不接受 `2026-07-28`。

**修法**（按 MCP 规范，未放宽任何安全约束）：新增
`MCP_COMPATIBLE_PROTOCOL_VERSIONS` 与 `selectNegotiatedProtocolVersion()` ——
**客户端请求的版本在兼容集内就回该版本**；否则回首选版本并如实报
`isRequestedVersionSupported: false`。另修掉一处自相矛盾（成功协商被误报为 false）。

**验证**：新增反例 6 条（先红后绿）；修正 `mcp-stdio-session.test.ts` 中
**原先断言缺陷行为**的那条用例；重装 tarball 后两家**均 connected**。

## 3. 闭环证据（逐条真实返回）

### 3.1 `pi` 提交（云之声 u2-flash，工具调用经 pi 的 `codemode`）

```json
{"taskIdentifier":"bridge-mcp-client-mv3q9905-2-bridge0104-pi-key",
 "missionIdentifier":"mission-e45631b2","status":"accepted","isCompleted":false,
 "isIdempotentReplay":false,
 "provenance":{"sourceKind":"agent","actorId":"external-harness:pi",
               "agentInstanceId":"mcp-client-mv3q9905-2"}}
```

- `status=accepted`、**`isCompleted=false`** ⇒ 受理 ≠ 完成（卡内要求的状态可区分）。

### 3.2 `opencode` 跨主体访问 pi 的任务 ⇒ **业务级失败**（正确拒绝）

```
✗ astarray_query_task  {"taskIdentifier":"…bridge0104-pi-key"} failed
  Error: {"errorCode":"task-not-accessible","message":"任务不存在或不属于当前调用主体"}
✗ astarray_cancel_task {"taskIdentifier":"…bridge0104-pi-key"} failed
  Error: {"errorCode":"task-not-accessible", …}
```

**要点**：这是**业务级**失败（工具结果带 `isError: true`），**不是** JSON-RPC 协议错误；
且它证明**主体隔离在真实客户端下生效** —— 一个客户端看不到另一个的任务。

### 3.3 `opencode` 自己的完整闭环（submit → query → cancel）

```json
// ① submit
{"taskIdentifier":"bridge-mcp-client-mv3qjqq0-2-bridge0104-oc-key",
 "missionIdentifier":"mission-a70983a5","status":"accepted","isCompleted":false,
 "provenance":{"sourceKind":"agent","actorId":"external-harness:opencode",
               "agentInstanceId":"mcp-client-mv3qjqq0-2"}}
// ② query
{"taskIdentifier":"…bridge0104-oc-key","status":"done","isCompleted":true,
 "summaryPreview":"（mock 执行器）"}
// ③ cancel
{"taskIdentifier":"…bridge0104-oc-key","status":"done","isCompleted":true,
 "cancellationRequested":true,"result":null}
```

**主体由本地注入**：`actorId` 是 `external-harness:opencode`，
**不是**模型在参数里给的（对照 §3.4）。

### 3.4 身份注入防护（真实客户端下实测拒绝）

`pi` 首次尝试时按提示词把 `sourceKind` 放进了工具参数，桥接**当场拒绝**：

```json
{"errorCode":"bridge-identity-injection-rejected",
 "message":"工具参数不得携带身份字段（sourceKind）：认证主体只由本地 harness 注入"}
```

⇒ ADR-0032 的"主体由本地注入、不得从工具参数推断"在**真实客户端**下确实生效。

### 3.5 协议失败 vs 业务失败（可区分，实测）

对同一桥接逐条发送：

| 输入 | 回应 | 性质 |
| --- | --- | --- |
| `initialize` 请求 `2025-11-25` | `result.protocolVersion="2025-11-25"`、`isRequestedVersionSupported=true` | 协商成功（修复后） |
| `resources/list`（未实现的方法） | `error.code = -32601` | **协议失败** |
| `NOT JSON AT ALL` | `error.code = -32700`、`id=null` | **协议失败** |
| `tools/call submit_task` 成功 | `result` 内 `isError:false` | 正常 |
| `tools/call` 越权任务 | `result` 内 `isError:true` + `errorCode` | **业务失败**（见 §3.2） |

⇒ **协议失败走 JSON-RPC `error`，业务失败走 `result.isError`** —— 两者可区分。

## 4. 对外支持声明（绑定版本与平台）

| 项 | 值 |
| --- | --- |
| MCP 协议 | 首选 `2026-07-28`；**兼容并协商** `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` |
| 服务端标识 | `astarray-mcp-bridge` / `0.1.0` |
| 传输 | stdio，换行分隔 JSON-RPC |
| 工具面 | 4 个（`submit_task`/`query_task`/`cancel_task`/`read_result`）；本地写/执行工具**不暴露** |
| 运行环境 | **Windows** / Node v24.18.0 / astarray 0.1.0（隔离安装） |
| 已实测客户端 | `opencode` 1.18.35（模型 `stepfun/step-3.7-flash`）、`pi` 1.1.0（模型 云之声 `u2-flash`） |

**仍未验证（不得据本文件推断）**：
- **macOS / Linux 平台** —— 本证据仅 Windows（本会话另有 Linux 全量测试，但**未**在 Linux 上跑真实 MCP 客户端）；
- 仅验证了 **stdio** 传输；Streamable HTTP / A2A / 通用 HTTP 按 ADR-0032 **不在本批范围**；
- `read_result` 未由真实客户端在**已完成**任务上取回正文（本轮 read-only mock 任务
  `result` 为 `null`）。

## 5. 复现

```powershell
# 桥接（隔离安装产物）
node <install>/node_modules/astarray/dist/cli.js mcp serve
# pi（云之声；--api-key 从文件读入变量，不打印）
pi -p --no-session --approve --provider yunzhisheng --model u2-flash --tools '*' --api-key $key "<prompt>"
# opencode
opencode run --model stepfun/step-3.7-flash "<prompt>"
```
