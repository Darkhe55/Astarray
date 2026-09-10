# T07D-R2-02 生产入口连通本地协议服务器 · 证据

> 检查点：T07D-R2-02　状态：done
> 任务卡：`docs/tasks/T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md`；前驱：T07D-R2-01（done）
> 基线提交：`b8d5c93`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 行为反例（先红）

新增 `tests/core/integration/provider-fake-server.test.ts`，首轮红灯：真实适配器注册模块缺失（测试无法收集）。

## 2. 实现内容

| 文件 | 变更 |
|---|---|
| `packages/core/src/runtime/openai-compatible-provider-registration.ts` | 新增：openai-compatible 运行时注册（协议版本 `chat-completions/stream-tools-2026-09-10`，能力 streaming/tool-calling/cancellation） |
| `packages/core/src/runtime/provider-runtime-registry.ts` | 凭据解析：`doesReferenceExist` + `readCredential`；`apiKey` 只在内存 `ProviderRuntimeConfig` 中流转，描述符不含秘密 |
| `packages/core/src/runtime/openai-compatible-runtime.ts` | **增量 SSE 消费**：`readOpenAiStreamChunks` 用 TextDecoder stream 模式逐块解码（跨字节 UTF-8 中文）并按帧即时产出；超时与调用方取消分离（超时不再误判为 cancelled） |
| `packages/core/src/orchestration/mission-orchestrator.ts` | Worker 运行时异常收敛为任务失败，消除未处理拒绝 |
| `tests/core/integration/provider-fake-server.test.ts` | 新增 6 例：分片中文+慢流、429、断流、超时、取消、工具调用参数消费 |

## 3. 场景覆盖（本地 fake server，经产品入口）

| 场景 | 路径 | 结果 |
|---|---|---|
| 分片中文 + 慢流 | facade → mission → Worker → 适配器 → SSE 分块 | 任务 `done`，`summaryPreview` 含重组后的“分布式恢复完成”，请求数 ≥1 |
| 429 | 同上 | 终态非 `done`（受控失败） |
| 断流（socket destroy） | 同上 | 终态非 `done` |
| Provider 超时（服务不响应，300ms 上限） | 同上 | 终态非 `done`；不再被误判为取消 |
| 取消在途调用 | `cancelTask` → cancelled | `queryTask` 稳定返回 `cancelled` |
| 工具调用参数消费 | 注册运行时 → `run()` 事件流 | 产生 `toolCallRequested{readFile, {"filePath":"a.txt"}}`，且无 `toolCallFinished`（适配器不执行工具、不决定完成） |

## 4. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯（集成测试） | 1 | 模块缺失，0 测试可收集 |
| 绿灯（集成 6 + 适配器回归 16） | 0 | 22 通过，无 unhandled error |
| `npm run check` | **0** | 151 文件 / 1410 测试全通过 |
| `npm run test:coverage` | **0** | 语句 93.94% / 分支 87.30% / 函数 90.98% / 行 94.03% |

## 5. 结论与边界

- 产品链已连通本地协议服务器：运行时选择、凭据引用、流式增量消费、失败/取消/超时分类均可由公共入口触发。
- 适配器只产生协议事件（文本增量、工具调用声明）；没有任何本地工具执行路径，完成判定仍在本地完成协议/验收门禁。
- 限制（留给后继）：Worker 目前 `availableToolDescriptors: []`，因此工具调用的“产品级执行”属 `T07D-R2-03`；非 2xx 仍统一映射 `provider-timeout`（错误码粒度细化可在 R2-03 处理）。
- 未使用真实服务与凭据；真实小样本属 `T07D-R2-04`（缺凭据保持 blocked）。
