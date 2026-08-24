# T07D：多 Provider 生产运行时与独立 Agent 工作助手任务卡

> 状态：`in_progress`（T07D-00~05 完成；T07D-06 未开始；真实闭环待 T05D/T07E）  
> 设计日期：2026-08-18  
> 任务来源：用户  
> 优先级层级：0  
> 风险等级：高；必须按检查点单独实现和验收  
> 前驱：`T07C`、`T05D`、`T07E`  
> 后继：`T12A`  
> 推荐偏序：`T08C` 后分别完成 `T08D → T07C`、`T05D`、`T07E`，再执行 `T07D → T12A → T12 → T13 → T14`

> 2026-08-19 前驱增补：T07D 的真实工作助手闭环还必须等待 T05D（人工—Agent并行集成）和 T07E（默认10文件工作集预算）通过；T07D 完成后先执行 T12A 统一恢复，再执行 T12 综合加固。有效偏序见根目录 `IMPLEMENTATION_PLAN.md` 最新增补和 `docs/tasks/README.md`。

## 1. 任务背景与缺口结论

Astarray 的领域架构不依赖 LangChain、LangGraph、AutoGen、CrewAI、OpenAI Agents SDK 等第三方 harness，已经具备成为独立本地 Agent 工作助手的基础；但是现有任务卡尚未覆盖完整产品链路：

1. `T07C` 负责 Provider/模型目录、允许列表、任务类型预设和安全切换，不负责厂商原生协议适配。
2. `T07` 只要求 `ScriptedRuntime` 和基础 `OpenAICompatibleRuntime`，没有规定 OpenAI Responses、Anthropic Messages、Gemini、Azure OpenAI、Amazon Bedrock 的协议与认证边界。
3. 当前 Headless CLI 只接受 `mock`；CLI bootstrap 固定装配 `ScriptedRuntime`，真实 Provider 尚未进入产品执行路径。
4. 当前 OpenAI-compatible SSE 先读取完整 `response.text()` 再解析，不是真正的增量流式处理。
5. README 中的 Provider 环境变量当前没有生产代码读取，文档描述与实际可用路径不一致。
6. npm 包只有 `astarray` 可执行入口，没有稳定、版本化的公开 SDK `exports`，无法从隔离安装的 tarball 验证“作为独立 harness 被应用嵌入”。
7. `T08C` 定义了主/次/三/四级工作流，但没有真实 Provider 驱动的“项目侦察 → 任务规划 → 实现 → 测试 → 独立验收 → 次级集成 → 主 Agent 总结”纵向验收。

本卡用于补齐上述缺口。完成前不得对外宣称“支持主流 Provider”或“已可作为生产级独立 Agent 工作助手”。

## 2. 产品定位与冻结边界

### 2.1 独立 Harness 的含义

完成后必须同时满足：

- Astarray 可以只通过 npm tarball 安装，并由 `astarray` CLI/TUI 独立启动，不要求安装另一个 Agent harness。
- Core、Provider runtime、权限、备份、调度、记忆、反馈和完成裁决均由 Astarray 自己拥有；厂商适配器只转换模型输入输出，不能决定权限或任务是否完成。
- 提供稳定、版本化的公开应用接口，使普通 Node.js 应用可以从安装包导入 Astarray，而不必引用仓库源码或 TUI 内部文件。
- 不把 LangChain、LangGraph、AutoGen、CrewAI、OpenAI Agents SDK、Claude Managed Agents 等框架加入必需依赖。未来与它们集成时使用可选桥接器，不反向污染领域核心。
- MCP/A2A 或其他外部 harness 桥接不作为本卡的生产必交付；本卡只冻结桥接端口和能力边界。任何桥接仍必须通过 Astarray 的本地工具注册、权限、敏感禁读和备份执行入口。

### 2.2 Provider 适配器的权限上限

- Provider 只接收经过本地策略允许的消息、工具公开 schema 和脱敏上下文。
- Provider 返回的工具调用、停止原因、结构化输出和错误都只是输入证据；本地工具执行、身份来源、权限判断、备份和完成门禁不交给 Provider。
- 切换 Provider 不改变 `agentInstanceId`、记忆域、任务所有权、权限、工具、Git 职责、任务优先级或已确认副作用。
- Provider 凭据只由本地受保护配置装载器使用。模型、反馈、日志、错误、缓存、导出、快照和普通审计不得获得凭据原值。
- `.env` 和其他强制禁读资源不能为了“配置 Provider”而进入模型；程序可以通过隔离配置装载器读取进程环境，但不得把值回传模型。

## 3. 目标架构

```text
CLI / TUI / GUI / Public SDK
             │
             ▼
Astarray Application Facade
             │
             ▼
AgentRuntime
  ├─ ProviderProtocolAdapter
  │   ├─ OpenAIResponsesAdapter
  │   ├─ OpenAIChatCompletionsAdapter
  │   ├─ AnthropicMessagesAdapter
  │   ├─ GeminiInteractionsAdapter
  │   ├─ AzureOpenAIAdapter
  │   ├─ BedrockConverseAdapter
  │   └─ GenericOpenAICompatibleAdapter
  ├─ ProviderTransport
  ├─ ProviderAuthenticationStrategy
  ├─ ProviderCapabilityResolver
  └─ NormalizedProviderEventStream
             │
             ▼
本地 ToolLoop / Permission / Backup / Completion / Watchdog
```

建议的规范事件至少包括：

```ts
type NormalizedProviderEvent =
  | { eventType: "response-started"; providerRequestIdentifier: string }
  | { eventType: "text-delta"; textDelta: string }
  | { eventType: "tool-call-started"; toolCallIdentifier: string; toolName: string }
  | { eventType: "tool-arguments-delta"; toolCallIdentifier: string; argumentsDelta: string }
  | { eventType: "tool-call-completed"; toolCallIdentifier: string }
  | { eventType: "usage-updated"; inputTokenCount: number | null; outputTokenCount: number | null }
  | { eventType: "provider-completed"; providerStopReason: string }
  | { eventType: "provider-error"; stableErrorCode: string; isRetryable: boolean };
```

协议字段可以保留厂商原名，但 Astarray 生产变量和函数仍必须使用完整可读名称；时间变量必须带单位，布尔值使用 `is/has/can/should` 前缀，核心领域代码禁止 `any`。

## 4. Provider 支持等级与声明规则

每个 Provider/协议必须记录一个可审计支持等级：

| 等级 | 含义 | 是否可以宣称支持 |
|---|---|---|
| `adapter-only` | 只有转换代码或单元 fixture | 不可以 |
| `fake-server-conformant` | 通过分片流、工具调用、错误和取消的本地协议服务器 | 只能称“协议适配完成” |
| `live-smoke-verified` | 用户显式提供凭据并完成可选真实 API 冒烟 | 可以注明验证日期、区域、API 版本和模型 |
| `product-path-verified` | 从 npm tarball 经 CLI/TUI/SDK 完成真实工作流 | 可以称“当前版本可用” |

没有动态证据时必须写“未验证”或“条件兼容”，不能因为类名存在、厂商声称 OpenAI-compatible 或请求返回过一次文本就宣称完整支持。

## 5. 检查点序列

一次只执行一个检查点。每个检查点预计不超过 3 小时；预计超过时必须在可构建、可测试的边界继续拆卡，不能扩大单次范围或省略验收。

| 检查点 | 内容 | 依赖 | 主要验收 |
|---|---|---|---|
| T07D-00 | 当前 Provider 产品路径审计、支持矩阵和文档纠偏 | T07C | 明确 mock/adapter/product-path 差异；README 不再暗示未接通配置可用 |
| T07D-01 | Provider 协议端口、认证/传输分层、规范事件与能力协商 | T07D-00 | 无界面/厂商 SDK 反向依赖；schema、未知事件、能力不匹配测试 |
| T07D-02 | 真正增量的 HTTP/SSE/流读取、取消、超时、背压和稳定错误 | T07D-01 | 不调用 `response.text()` 缓冲全流；分片、多字节、断流、取消、慢流测试 |
| T07D-03 | OpenAI Responses、Chat Completions 和通用 OpenAI-compatible 适配 | T07D-02 | 文本、工具、并行工具、usage、stop、错误和 fake server 契约测试 |
| T07D-04 | Anthropic Messages 与 Gemini 原生适配 | T07D-02 | content block/step 事件、工具参数增量、工具结果回填和未知事件测试 |
| T07D-05 | Azure OpenAI 与 Amazon Bedrock 适配边界 | T07D-03/04 | API key/token provider、部署模型、SigV4/Converse 端口、区域与错误映射测试 |
| T07D-06 | CLI/TUI/doctor/配置装配与受保护凭据引用 | T07D-03/04/05 | 不再只允许 mock；无凭据回显；mock 仍可离线运行 |
| T07D-07 | 独立工作助手的真实纵向闭环 | T07D-06、T08C | 项目分析及小型编码场景从 Provider 到三级执行、测试、验收、集成和主摘要全链通过 |
| T07D-08 | 稳定 Public SDK、npm exports、可选桥接端口和 tarball 终验 | T07D-07 | 隔离消费者项目可导入 SDK；CLI/TUI/SDK 同一 Core；无源码路径依赖 |

## 6. 分检查点实施要求

### 6.1 T07D-00：审计与纠偏

- 建立 `ProviderSupportRecord`，记录 provider、协议、API 版本、认证方式、能力、支持等级、验证时间、测试证据和已知限制。
- 检查 README、`doctor`、CLI help、配置示例和交付报告。未接入的环境变量不得写成已经可用。
- 记录当前 CLI runtime 门禁、bootstrap 装配、SSE 解析、公开包导出和固定任务分解的真实状态。
- 本检查点只改文档、schema 和失败测试，不顺带实现全部 Provider。

### 6.2 T07D-01/T07D-02：公共运行时基础

- 把协议转换、网络传输、认证、能力选择和 Astarray 运行时编排分成独立接口。
- 认证至少支持 Bearer、命名 API-key header、异步 token provider 和请求签名端口；模型不能自由选择认证策略或 header。
- 使用 `ReadableStream`/异步迭代真正增量读取。处理任意 chunk 边界、CRLF、UTF-8 多字节拆分、SSE 注释、未知事件、多个 `data:` 行、尾部无换行和有界未完成缓冲区。
- `AbortSignal` 必须中止底层请求和解析器。仍活跃/停止不确定的请求遵循 T07A，看门狗不能并发续跑。
- 重试只针对经过本地分类的可重试、确认无副作用阶段；遵守 `Retry-After` 和有界退避，不能重放已开始的未确认工具副作用。
- Provider 原始响应正文默认不进入错误；仅保留稳定错误码、请求追踪 ID 的安全摘要和脱敏诊断。

### 6.3 T07D-03/T07D-04/T07D-05：厂商适配

- OpenAI：分别实现 Responses 与 Chat Completions，不能用 Chat Completions 类冒充 Responses 支持。
- Anthropic：处理 Messages content blocks、`tool_use`/`tool_result`、输入 JSON delta、stop reason 和版本 header。
- Gemini：处理 Interactions 或当前选定的稳定原生 API、step/function call/function result 及其流事件；API 版本必须在目录中显式记录。
- Azure OpenAI：Endpoint、deployment/model、API 版本、API key 与异步 Entra token provider 不得硬编码为普通 Bearer 单一路径。
- Bedrock：Converse/ConverseStream 与 OpenAI-compatible 路径分别记录；普通 Bedrock 的 SigV4 使用本地签名端口，AWS 凭据不能进入 Agent 上下文。
- 通用 OpenAI-compatible 只保证经过 conformance 的公共子集。Ollama、vLLM、LM Studio、OpenRouter、Groq、Together 等必须逐实现/版本记录验证结果，不能做永久全兼容承诺。
- 适配器不得直接执行工具，不得自行接受完成事件，不得修改权限、Agent 身份或任务状态。

### 6.4 T07D-06：产品装配

CLI 至少提供等价能力：

```text
astarray run "分析当前项目" --provider <provider-id> --model <model-id> --json
astarray config provider list
astarray config provider show <provider-id>
astarray doctor --provider <provider-id> --json
```

- 不允许在命令行参数中直接传递 API key；使用受保护凭据引用、进程级安全输入或平台凭据存储端口。
- `doctor` 只报告配置是否存在、协议/能力是否匹配和安全的连通状态，不回显凭据、完整 Endpoint secret、完整响应或用户 prompt。
- CLI/TUI/未来 GUI 使用同一个 Provider 设置控制器和 `ModelProviderCatalog`；界面不能各自复制协议判断。
- `mock` 继续是默认离线测试路径。无凭据时不能静默改用未授权 Provider，也不能伪造真实模型结果。
- Assist 中若实现需要安装厂商 SDK或其他依赖，必须先询问用户是否已有可用资源，再经过独立安装开关和本次精确授权；本卡不能用“支持厂商”为理由绕过安装门禁。

### 6.5 T07D-07：独立工作辅助纵向闭环

至少完成两个从 npm 安装产物启动的场景：

#### 场景 A：只读项目分析

1. 用户在主会话提出项目分析任务。
2. 主 Agent 保持只读并生成/提交任务提案。
3. 次级 Agent 派出只读项目侦察三级 Agent。
4. 侦察 Agent 使用真实允许的文件、搜索和 Git 只读工具，生成 `PROJECT_CONTEXT_DIGEST_V1`。
5. 次级输出有界摘要，主 Agent向用户解释；项目全文、`.env`、其他 Agent私有记忆和长工具输出不进入主上下文。

#### 场景 B：小型代码任务

1. 用户确认将明确小任务直投具体次级 Agent，或由主 Agent提交任务提案。
2. 次级在偏序集内分别任命实现、测试和验收个体；作者不能自验。
3. 实现者只在隔离 worktree 修改并提交；所有覆盖/删减仍由工具自动备份。
4. 测试者运行允许的目标检查，验收者审查不可变提交和证据。
5. 次级只有在权限、测试、验收和必要人工门禁满足后才合并；否则返修或 `blocked-human-review`。
6. 主 Agent只读取次级用户摘要并向用户说明结果、风险和未决事项。

真实 Provider不可用或用户尚未提供凭据时，先用 fake server 完成全部自动门禁；需要真实凭据的节点进入明确人工/外部依赖状态，不占用 Agent机械轮询，也不阻塞无依赖 ready 节点。

### 6.6 T07D-08：Public SDK 与独立安装

- `package.json` 增加经过语义版本管理的公开 `exports`，只导出稳定应用 facade、公共 DTO、事件订阅和配置端口；不得导出内部存储路径、能力令牌、备份对象、IPC 地址或 TUI 私有组件。
- 建立全新隔离消费者 fixture，只从生成 tarball 安装 `astarray`，通过公开 API创建会话、订阅状态、提交任务、读取公开结果并安全关闭。
- SDK 嵌入路径与 CLI/TUI 使用相同应用控制器，不能维护第二套权限、任务或 Provider 实现。
- 增加依赖方向测试：Core 不依赖 TUI/GUI/第三方 harness；Provider adapters 不反向依赖界面；消费者不引用 `packages/` 源码相对路径。
- 冻结可选 `ExternalHarnessBridgePort`/MCP/A2A 桥接端口时，只定义认证主体、来源、任务信封、工具映射和权限复检契约；本卡不要求实现所有外部框架插件。

## 7. 详细测试方案

### 7.1 协议单元与属性测试

- 每家 Provider 使用官方协议字段的本地 fixture；不得依赖真实网络作为默认 CI。
- 任意字节/chunk 切分后，事件结果与完整合法流一致；UTF-8 多字节拆分不能乱码。
- 文本、推理摘要、工具名、工具参数增量、并行工具调用、usage、stop reason、拒绝、上下文超限和未知未来事件均有覆盖。
- 无界事件、无终止标记、超大单行、畸形 JSON、重复事件 ID 和参数永不闭合必须有界失败，不能无限累积内存。
- 每个适配器的厂商事件只能归一化为公开事件，不能直接改变 Astarray 任务或权限状态。

### 7.2 Fake Provider 集成测试

- 建立本地 loopback fake servers，覆盖 200 流、401/403、404 模型不存在、408/超时、409、429 + `Retry-After`、5xx、半流断开、慢流、取消和连接关闭。
- 验证工具调用结果回填、多轮 ToolLoop、最大循环、有界重试、看门狗、完成事件和非幂等不确定结果 blocked。
- 验证认证 header 正确但日志、错误、快照、反馈和 fake server 测试报告不记录真实 secret。
- 多 Agent 并发使用不同 Provider、模型、认证方式和能力时，选择、事件、缓存、usage 与错误不互相污染。

### 7.3 产品路径测试

- CLI、TUI、Public SDK 都必须使用同一 Provider runtime，不能只有单元测试能实例化适配器。
- 动态验证不支持的协议、模型能力或凭据引用会在执行前给出稳定错误，而不是回退 mock 或其他 Provider。
- TUI 流式文本实时更新并节流；取消后底层连接关闭，界面继续可操作。
- `doctor`、状态视图和 Provider 支持矩阵与实际 runtime registry 一致。
- README 示例必须由 tarball 隔离脚本实际执行；不能只有开发目录运行证据。

### 7.4 可选真实 Provider 契约测试

- 真实 API 测试默认关闭，只在认证用户明确选择 Provider、模型、费用/数据出境范围并提供本地凭据引用后运行。
- 每次测试限制最大请求数、token/费用预算、超时和工具范围；不得发送真实项目秘密或 `.env`。
- 结果记录 Provider、API 版本、区域、模型 ID、日期、能力覆盖、成功/失败和限制，但不记录凭据和完整 prompt。
- 未运行真实测试不导致默认 CI 失败，但相应支持等级不能升级为 `live-smoke-verified`。

### 7.5 安全与故障测试

- Prompt、项目文件或 Provider 输出伪造 `agentInstanceId`、用户来源、权限授权、完成事件或工具结果均不能通过本地验证。
- Provider/代理返回含 secret 的错误正文时，模型、TUI、日志和交付报告不得出现 secret。
- Provider 切换、超时、续跑、进程重启和会话恢复不会重放未确认非幂等副作用。
- Ponder 即使 Provider 请求工具也只能看到并调用本地只读白名单；Assist/Devolve 继续使用各自公开 profile 与不可配置强制边界。
- 取消、断网、DNS失败、TLS失败、系统时钟变化、速率限制、Provider 服务异常和磁盘不可写都有稳定终态。

### 7.6 打包验收

必须执行并保存退出码：

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run check
npm pack
```

随后在全新目录安装 tarball，验证：

- `npx astarray --help`
- `npx astarray doctor --json`
- mock 离线运行
- 至少一个 fake Provider 经 CLI 的流式文本和工具调用
- TUI 启动、流式更新、取消和退出清理
- 隔离消费者通过公开 SDK 导入并运行
- 包内没有测试凭据、`.env`、运行状态、日志、缓存、内部审计或源码外路径引用

## 8. 人工验收与无人时段

- 自动协议、fake server、静态检查、构建和 tarball 测试先完成；人工只处理真实凭据提供、费用/数据出境确认、真实厂商冒烟和交互体验。
- 等待真实 Provider 凭据或人工体验时，节点进入 `blocked-external-provider` 或 `blocked-human-review`，释放网络、文件、任务和 Provider 请求资源；其他无依赖节点继续运行。
- 人工至少体验：实时流式反馈、取消、Provider/模型辨识、凭据错误说明、只读项目分析、Assist 小型代码任务、返修提示和主 Agent总结是否易懂。
- 用户未处理、拒绝或真实 Provider暂不可用不能自动转为通过，也不能用 mock 证据升级真实支持等级。
- 人工裁决必须绑定任务 revision、tarball 哈希、构建/提交哈希、Provider/模型公开 ID、界面版本和认证用户来源。

## 9. 执行注意事项

- 每轮只领取一个 `T07D-*` 检查点；本卡属于高风险任务，不与 T08C、T08D、T07C、T12 或 GUI 编码合批。
- 每个检查点最多 3 小时；该限制是执行拆分阈值，不是反馈消息 TTL。反馈退避 `pn` 的单次等待上限仍为 3 小时。
- 普通检查点建议控制在 5–15 个生产文件和同等数量级测试文件；预计超过约 1,000 行生产代码时拆成契约、传输、适配器、装配和验收子卡。
- 开始实现前先询问用户是否已有所需 SDK、依赖、凭据载入设施和测试资源。现有 Node 内置能力足够时不得安装；需要安装时严格执行 Assist 两阶段门禁。
- 同一根因连续失败三次后停止机械重试，保存最小复现、协议片段、已尝试方案和未决风险。
- 任何删除、文字删减、替换、截断或覆盖必须由执行工具自身在变更前自动备份；Git 记录不能代替该备份。
- 每个检查点同时提交实现、测试、文档、支持矩阵和 `PLAN_STATUS.md` 证据；前一节点未通过不得开始后继。
- Provider 技术接入不授权联网、费用、数据出境、安装、工具执行、Git 合并、远端发布或人工验收。
- 生产实现不允许用“通用 OpenAI-compatible”掩盖厂商协议差异；兼容范围必须按协议版本和动态证据记录。

## 10. 完成事件

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: T07D-XX
agentInstanceId: <具体且不可复用的 Agent 个体 ID>
sourceKind: user
priorityTier: 0
gitBranchOrWorktree: <次级 Agent 分配的隔离位置>
commitId: <原子提交 ID>
providerProtocols:
  - <协议和支持等级>
changedProductionFiles:
  - <文件>
changedTestFiles:
  - <文件>
executedChecks:
  - command: <命令>
    exitCode: <退出码>
coverageEvidence: <协议、认证、流式、切换和产品路径覆盖率>
tarballEvidence: <tarball 路径、哈希、隔离 CLI/TUI/SDK 结果>
liveProviderEvidence: <未运行时写 not-run，不得伪造>
remainingRisks:
  - <没有则写 none>
completionGate: passed | failed | blocked
```

缺少真实产品路径、tarball SDK 消费测试、增量流式测试、凭据隔离或独立工作闭环时，不能把 T07D 标记为完成。

## 11. 可直接交给 OpenCode 的首轮指令

```text
完整读取 AGENTS.md、agent-main-architecture.md、designtodo.txt、
IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、ADR-0026、T07C 任务卡和
docs/tasks/T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md。

先核对 T07C 的实际完成证据；未通过时只报告阻塞，不得提前实现 T07D。
依赖通过后，本轮只执行 T07D-00，不开始 T07D-01。先建立真实 Provider
产品路径、支持等级和文档差异清单，编写能暴露 CLI 仅 mock、环境变量未装配、
整流缓冲和缺少 public exports 的失败验收，再做本检查点允许的最小纠偏。

使用含义完整、可读性好的变量和函数名。不得安装新依赖，除非先询问用户是否
已有可用资源，并在确认没有后完成 Assist 独立开关和精确 allow-once 授权。
完成实现、测试、文档、PLAN_STATUS 和动态命令证据前，不得返回完成事件或领取
T07D-01。
```
