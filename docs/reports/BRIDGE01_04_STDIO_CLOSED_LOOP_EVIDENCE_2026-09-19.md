# BRIDGE-01-04 脚本化 stdio MCP 闭环证据（2026-09-19）

> 检查点：BRIDGE-01-04 的"从 tarball 启动桥接 + 完整闭环 + 协议/业务失败可区分 + 版本平台声明"部分
> 客户端：`scripts/verify-mcp-bridge-loop.mjs`（真实 stdio MCP 客户端，换行分隔 JSON-RPC；非进程内 mock）
> 桥接来源：**隔离安装产物** `astarray-0.1.0.tgz`（sha256 `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f`，215 文件）→ `.tmp/package-smoke/2026-09-19T15-18-50.235Z-903399c9-5a93-4213-b8d9-f2d9f76e85a7/node_modules/astarray/dist/cli.js`
> 执行：`node scripts/verify-mcp-bridge-loop.mjs "<上述 cli.js 路径>"` → **2 场景 / 20 项断言全部通过，exit 0**
> 结论：闭环部分完成；**第三方客户端（opencode / pi）消费**仍待用户授权，BRIDGE-01-04 保持 in_progress。

## 1. 版本与平台声明（对外支持声明绑定项）

| 项 | 值 |
| --- | --- |
| MCP 协议修订 | `2026-07-28`（服务端协商结果；`isRequestedVersionSupported: true`） |
| 服务端标识 | `astarray-mcp-bridge` / `0.1.0`（`serverInfo`） |
| 能力 | `capabilities.tools = { listChanged: false }` |
| 传输 | stdio，换行分隔 JSON-RPC；stdout 仅 MCP 消息（本次 19 条消息全部合法） |
| 运行环境 | Windows；Node `v24.18.0`；`astarray` 0.1.0（隔离安装） |
| 本机桥接实现 | 复用公共应用门面，`mode: assist`、`runtime: mock` |

## 2. 闭环与断言（实测值）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | `initialize` 协议协商 | 通过：`protocolVersion=2026-07-28`、`capabilities.tools` 存在 |
| 2 | `tools/list` 仅四个工具 | 通过：`cancel_task/query_task/read_result/submit_task` |
| 3 | 不暴露禁止的本地写/执行工具 | 通过：`shell/runCommand/writeFileTemporary` 均不在列表 |
| 4 | `submit_task` 返回受理回执 | 通过：`status=accepted`、`isCompleted=false`、含 `taskIdentifier`/`missionIdentifier=mission-89f33e95` |
| 5 | 幂等键重复提交 | 通过：同 `taskIdentifier`，`isIdempotentReplay=true` |
| 6 | `query_task` 本地权威状态 | 通过：`status=running` |
| 7 | `read_result` 不伪造结果 | 通过：`isCompleted=false`、`result=null` |
| 8 | `cancel_task` | 通过：`status=cancelled`、`isCompleted=true`、`cancellationRequested=true` |
| 9 | 业务级失败可区分 | 通过：`isError=true` 且 **无** JSON-RPC `error`，`errorCode=task-not-accessible` |
| 10 | 禁止工具经桥接调用被拒 | 通过：`isError=true`，`errorCode=bridge-local-write-tool-rejected` |
| 11 | 非法 JSON 行 | 通过：JSON-RPC `-32700` |
| 12 | 未知方法 | 通过：JSON-RPC `-32601` |
| 13 | stdout 无日志混入 | 通过：非法行 0 条 |

另核验：提交回执的 `provenance` 为 `{sourceKind: "agent", actorId: "external-harness:stdio", agentInstanceId: "mcp-client-…"}`——**主体由本地 harness 注入**，未从工具参数推断（工具面亦不含身份/优先级参数）；断连（stdin 结束）后会话收口，子进程正常退出。

## 2b. 场景 2：主体隔离与断连收口（2026-09-19 追加）

同一状态目录下启动两个真实连接（`ASTARRAY_MCP_PRINCIPAL` 分别为 `external-harness:verify-a` 与 `…:verify-b`）：

| # | 检查 | 结果 |
| --- | --- | --- |
| 14 | 主体 A 提交成功 | 通过：`provenance.actorId=external-harness:verify-a`、`status=accepted` |
| 15 | A 断连后进程自行退出 | 通过：`{exitedOnItsOwn: true, exitCode: 0}`（未走脚本 SIGKILL） |
| 16 | 不同主体读取 A 的任务 | 通过：`isError=true`、`errorCode=task-not-accessible`，无 JSON-RPC error |
| 17 | 不同主体读取 A 的任务结果 | 通过：同上 `task-not-accessible` |
| 18 | 不同主体取消 A 的任务 | 通过：同上 `task-not-accessible` |
| 19 | 隔离不误伤 | 通过：B 可提交并读取**自己**的任务（`status=running`） |
| 20 | 两个主体连接 stdout 均无日志混入 | 通过：非法行 0 条 |

要点：任务归属按**本地注入的认证主体**判定而非参数内容；任务标识里虽含 A 的 `agentInstanceId`，B 仍无法读取或取消；断连即会话收口且进程自行退出（退出码 0），不遗留孤儿进程。

## 3. 复现

```bash
# 仓库构建产物
node scripts/verify-mcp-bridge-loop.mjs
# 安装产物（本证据使用的方式：验证"从 tarball 安装的 bridge"）
node scripts/verify-mcp-bridge-loop.mjs "<安装目录>/node_modules/astarray/dist/cli.js"
```

注意：本检查点**未**在 `package.json` 增加 npm 别名，以免改变已记录 tarball（`a45ae4da…`，215 文件）的字节内容、造成"测试产物 ≠ 当前产物"的漂移；如需别名，应在下一次重新打包的检查点里一并加入并更新哈希。

沙箱说明：该脚本以**管道 stdio** 启动子进程，受限文件沙箱下会 `spawn EPERM`（本次已复现），需一次性完整访问执行；这与 GUI 冒烟（状态目录落在工作区内、无子进程）不同。

## 4. 未做与残留

- **第三方客户端消费**（`opencode` / `pi`）仍未做：本机已确认二者存在（`C:\Users\MerchRev\AppData\Roaming\npm\{opencode,pi}.ps1`），但配置/运行属外部软件操作，按治理需用户逐次授权；其中 `opencode mcp add … -- npx astarray mcp serve` + `opencode mcp list` 可在无模型条件下给出"真实第三方客户端连接 + 工具发现"证据，提交/查询/取消的模型驱动闭环仍需 Provider 凭据。
- Linux/macOS 平台未验证；本文件只声明 Windows + Node v24.18.0 的实测。
- 常驻/联网监听、Streamable HTTP、A2A 不在本批范围（ADR-0032）。
