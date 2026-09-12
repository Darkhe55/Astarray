# E2E-01-02 切片 1：本地协议服务器与 Provider 运行时公共入口 — 证据

> 检查点：E2E-01-02（docs/tasks/E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD.md）
> 状态：**in_progress**（切片 1 完成；本检查点整体尚未通过，未满足条件不得标 done）
> 前驱：E2E-01-01（已通过，提交 `23f38eb`/`9eca588`）。日期：2026-09-10

## 1. 本切片范围与拆分理由

E2E-01-02 要求"安装 tarball，使用本地协议服务器从用户入口完成 侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取"。共同契约 §3 允许在可构建/可测试边界继续拆分。本切片交付**本地协议服务器 + Provider 运行时公共入口真实连通**（其余步骤留待切片 2+）。

## 2. 变更

- 新增 `scripts/e2e01-local-protocol-server.mjs`：本地 OpenAI Chat Completions 兼容 SSE 服务器（确定性响应 + `ASTARRAY_TASK_COMPLETION_V1` 完成控制事件；逐请求打印 `{"event":"request",...}`；无网络、无费用；支持 `--port 0` 随机端口与 SIGTERM 收口）。
- `packages/tui/src/cli/run-command.ts`：`--runtime openai-compatible` 真实接线——构造 `ProviderRuntimeRegistry`（受保护凭据端口返回本次受控端点 + 环境变量 API key）、注册 `createOpenAiCompatibleProviderRegistration()`，以 `runtime: "provider"` 调用公共应用服务（与 SDK 消费者同一入口/同一状态源）。缺 `--provider-endpoint` 或 `--provider-model` 时 **fail-closed（退出码 2，不回退 mock）**。
- `packages/tui/src/cli.tsx`：注册 `--provider-endpoint`、`--provider-model`、`--provider-api-key-env`（凭据只从环境变量读取，不落盘、不回显）。
- 新增 `tests/tui/integration/run-provider-entry.test.ts`（3 例）；更新 `tests/tui/unit/cli-commands.test.ts` 中已过时的"--runtime openai-compatible 尚未支持"断言（改用真正非法的 runtime，并新增缺端点 fail-closed 用例）。

## 3. 证据

### 3.1 进程内入口测试（真实 HTTP）

`tests/tui/integration/run-provider-entry.test.ts`：
1. 本地协议服务器 + `executeRunCommand({runtime:"openai-compatible", providerEndpoint, providerModelIdentifier})` → 退出码 0、stdout 仅 JSON、`status:"done"`，服务器收到 ≥1 次真实请求。
2. 缺 `--provider-endpoint` → 退出码 2，stderr 含 `provider-endpoint`，stdout 为空（不静默回退 mock）。
3. 缺 `--provider-model` → 退出码 2。

### 3.2 构建产物端到端（本地协议服务器）

```
endpoint=http://127.0.0.1:2307/v1/chat/completions
node dist/cli.js run "本地协议服务器纵向探针" --mode assist --runtime openai-compatible \
  --provider-endpoint <endpoint> --provider-model fake-model --json --timeout-seconds 60
{ "missionId": "mission-9cd2e604", "mode": "assist", "status": "done", "prompt": "本地协议服务器纵向探针" }
run exit=0

== 服务器请求日志 ==
{"endpoint":"http://127.0.0.1:2307/v1/chat/completions","model":"fake-model"}
{"event":"request","requestIndex":1,"path":"/v1/chat/completions","model":"fake-model"}
```

即：公共 CLI 入口真实发起协议请求，任务到 `done`，完成后服务器进程被收口（无孤儿进程）。

## 4. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；173 文件 / 1492 用例通过 |
| `npm run test:coverage` | exit 0；173 文件 / 1492 用例通过；全局 93.73% stmts / **86.63% branch** / 91.61% funcs / 93.77% lines |
| 聚焦 `run-provider-entry` | 3/3 通过 |
| dist 端到端 | run exit 0，status=done，服务器 1 次请求（§3.2） |

## 5. 本检查点剩余（切片 2+）

- 侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取的**完整纵向编排**在公共入口可达；
- 实现/测试/验收**三种不同 agentInstanceId** 证据；**强制一次测试失败验证返修**；**拒绝未授权合并**；**主对话不被后台报告抢占**；
- 在 tarball 隔离安装下重复该场景，并以 fixture（E2E-01-01）目标功能产出真实成果物（`out/summary.json` 等）；
- 真实 Provider 场景（E2E-01-03）仍受凭据/费用授权阻塞。
