# T07D-R2-01 Provider 配置与运行时注册 · 基线

> 检查点：T07D-R2-01　状态：done
> 任务卡：`docs/tasks/T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md`；前驱：T07D-R1（done）
> 基线提交：`1f7f3b1`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 现有 Provider 资产盘点（复用，不重写）

| 资产 | 位置 | 作用 |
|---|---|---|
| OpenAI 兼容运行时 | `packages/core/src/runtime/openai-compatible-runtime.ts` | Chat Completions 流式（`stream:true` + `tools`/`tool_choice:"auto"` + SSE `data:` 帧 + `[DONE]`） |
| 协议端口 | `packages/core/src/runtime/provider-protocol-port.ts` | 适配器协议边界 |
| 厂商适配器 | `openai-adapters.ts`、`anthropic-gemini-adapters.ts`、`azure-openai-adapter.ts`、`bedrock-converse-adapter.ts` | 各自契约/单元级已验证，产品接线未接 |
| 模型/Provider 目录 | `packages/core/src/orchestration/model-provider-catalog.ts` | 版本化条目：能力标签、上下文、工具/视觉、健康状态、受保护凭据引用；公开 DTO 剥离凭据引用 |
| 受保护凭据端口 | `ProtectedCredentialStorePort`（同上） | `doesReferenceExist` / `readCredential`；凭据内容不进目录/日志/导出 |
| 凭据文件实现 | `packages/tui/src/cli/provider-cli.ts`（`FileProviderCredentialStore`） | CLI 侧凭据存储 |
| 模型选择策略 | `model-selection-policy-resolver.ts`、`agent-model-assignment-controller.ts`、`bounded-provider-fallback-guard.ts` | 允许列表、逐 Agent 模型分配、受控回退 |
| 运行时装配 | `packages/core/src/application/application-runtime.ts` | `mainRuntimeFactory` / `workerRuntimeFactory`（本轮新增覆盖点） |

## 2. 首个产品目标（开始时记录）

- **运行时实现 ID**：`openai-compatible`；**协议**：OpenAI Chat Completions（流式 + 工具调用）。
- **协议版本标识**：`chat-completions/stream-tools-2026-09-10`（以 2026-09-10 官方文档核对结果冻结）。
- **适配器证据**：`buildChatRequestBody` 发送 `{ model, stream: true, messages, tools[{type:"function",function:{name,description,parameters}}], tool_choice: "auto" }`；`parseServerSentEvents` 解析 `data:` 帧并忽略 `[DONE]`。
- **官方文档核对（2026-09-10）**：
  - `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/resources/chat/completions/completions.py`（HTTP 200）：包含 `stream`、`tools`、`tool_choice`、`chat/completions`，与适配器请求形状一致。
  - `https://learn.microsoft.com/en-us/azure/ai-services/openai/reference`（HTTP 200）：包含 `stream` 与 `chat/completions`（官方 OpenAI 兼容 REST 参考）。
  - `https://platform.openai.com/docs/api-reference/chat/create`：**HTTP 403（Cloudflare 拦截）**，未能读取，如实记录。
- 未选择其他厂商作为首个目标；其他适配器保持既有验证等级，不宣称产品可用。

## 3. 冻结的公共配置与能力协商

| 项 | 内容 |
|---|---|
| 公开配置 | `PublicProviderConfiguration`：`providerId`、`modelIdentifier`、`allowedModelIdentifiers`、`requiredCapabilities`、`baseUrl`、`protectedCredentialReferenceId`、`requestTimeoutMilliseconds`（只含受保护引用，无秘密） |
| 公开能力 | `PROVIDER_RUNTIME_CAPABILITIES = streaming / tool-calling / cancellation` |
| 注册表 | `ProviderRuntimeRegistry.register/resolveRuntime/describeRegistrations`；每次 `createRuntime()` 返回独立实例 |
| 描述符 | `ProviderRuntimeDescriptor`（providerId/protocol/protocolVersion/能力），不含凭据字段 |

## 4. 稳定失败码（不静默回退 mock）

| 场景 | errorCode |
|---|---|
| 未注册 provider / 未提供注册表 | `runtime-unsupported` |
| 重复注册同一 providerId | `provider-already-registered` |
| 缺 baseUrl 或 modelIdentifier | `provider-config-missing` |
| 模型不在允许列表 | `model-not-allowed` |
| 能力不足（如要求 `vision-input`） | `capability-unavailable` |
| 受保护凭据引用不存在 | `credential-reference-missing` |

入口行为：`AstarrayApplicationFacade.create({ runtime: "provider", ... })` 无注册表直接稳定失败；
成功解析时把 `mainRuntimeFactory`/`workerRuntimeFactory` 指向已注册运行时的工厂，**不构造默认 mock 运行时**。

## 5. 命令、退出码与产物

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯（`provider-runtime-registry.test.ts`） | 1 | 模块缺失，0 测试可收集 |
| 绿灯（provider + SDK 套件） | 0 | 17 通过 |
| `npm run check` | **0** | 150 文件 / 1404 测试全通过 |
| `npm run test:coverage` | **0** | 语句 93.91% / 分支 87.27% / 函数 90.75% / 行 94.00% |

凭据泄漏断言：错误对象与 `describeRegistrations()` 的序列化结果均不含哨兵密钥 `sk-sentinel-...`。

## 6. 未满足项与后继

- `T07D-R2-02`：连通本地 fake server，真正消费增量事件/工具参数并回填受控结果（本轮只完成选择链路与注册，未发起网络请求）。
- `T07D-R2-03`：工具与多层调度接入真实 Provider 运行时。
- `T07D-R2-04`：真实服务小样本需用户凭据与费用授权；缺凭据时保持 blocked。
