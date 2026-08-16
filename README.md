# Astarray

> 愿星光破开迷途。
> May starlight pierce the path astray.

仓库目录职责与最近一次整理记录见 [`ORGANIZATION.md`](./ORGANIZATION.md)。

TUI Agent 编排工具：单一主 Agent + Ponder / Assist / Devolve 三种内置模式，并支持用户创建不限数量的命名自定义权限模式。主 Agent 将任务转交本地会话控制器后立即恢复接收用户输入；三级 Agent（主 → 次级调度/集成 → 三级执行）通过**独立反馈进程**解耦通信。

默认流程中，主 Agent 持续和用户交流、评估并提交任务插入提案，不等待后台执行或后台汇报。次级 Agent 按自己的任务偏序集持续调度，决定复用或新建三级 Agent，并统一负责 Git 分支、审查、合并以及获授权的 GitHub/远端项目操作。三级 Agent 一次只处理一条任务链，完成或中断后向所属次级 Agent 汇报。次级汇总结果只进入主 Agent 的报告存档；主 Agent 在后续用户对话确有需要时才读取。

每个 Agent 个体使用不可复用的 `agentInstanceId` 独立保存记忆、工作存档、上下文、缓存和消息视图。同级 Agent 也不共享文件或上下文。跨 Agent 只传递明确选择、带来源与哈希的只读附件；附件仅服务当前任务，不会自动并入接收方长期记忆。

次级和三级 Agent 第一次取得某工具组时接收完整公开用法；后续相同 revision 只收到标准帮助请求提醒。忘记用法时按 `ASTARRAY_TOOL_HELP_REQUEST_V1` 请求单工具说明，缺少能力时逐级上报，三级默认先报所属次级。Agent 实例没有累计或同级产品数量配额，资源不足时进入队列。直属上级经授权可把直属低一级 Agent 的限定沟通句柄交给具体同级 Agent，但不会同时转移任务、记忆、工具、Git 或权限。

每个调度 Agent 还在自己的记忆存档域维护独立的待办任务偏序集。任务发布者可指定前驱/后继插入位置；用户任务默认处于最高优先层，Agent 或工具自动生成的任务只能处于第二层或以下。次级 Agent 可将一条依赖链打包给三级 Agent；用户与获授权发布者可通过只读状态工具随时查看顺序、阻塞原因和任务包进度。该序列不替代项目任务文档或产出追踪。

## 优化目标

本项目围绕以下核心目标持续演进（详见 [`designtodo.txt`](./designtodo.txt) 与实施计划）：

1. **增加缓存有效率，而非单纯提高命中率**——缓存的意义在于切实降低下游开销：重复读取抑制、读取回执与有界检测共同保证缓存命中不浪费、不误导。
2. **减少总调用次数与总 token 消耗量**——控制面直投小任务、次级汇报压缩为带来源摘要、跨 Agent 附件不自动并入长期记忆、工具说明按 revision 回访，全部以省去重复调用与冗余上下文为目标。
3. **提高并发调用数量**——并发与调度仅受队列、回收和资源约束，不对历史 Agent 实例数量设产品配额；多 Worker、独立反馈进程与信箱机制支撑横向扩展。
4. **多 Agent 沟通架构**——主 Agent 与子 Agent 脱离：任何时刻都可与主 Agent 通信但不打断任务进行。反馈进程独立运行，报告只入存档、不自动唤醒主 Agent。
5. **安全与确定性基线**（支撑以上目标的约束）：思索模式本地只读、敏感操作本地判定、全模式敏感文件禁读、安装双重门禁、可配置权限模式、明确完成控制事件与早停恢复、事实验证与反自指/活锁防护。

## 安装与快速开始

需要 Node.js ≥ 20（支持 Windows / macOS / Linux）。

```powershell
npm install -g astarray
# 或本地安装后：
npx astarray --help
```

开发环境：

```powershell
npm install
npm run check
node dist/cli.js --help
```

### 冒烟验证

```powershell
npx astarray doctor --json
npx astarray run "分析当前项目" --mode assist --runtime mock --json
```

## 内置模式、自定义模式与权限模型

> 设计状态：可配置权限组、自定义模式、Assist 安装流程、默认控制流、Agent 个体记忆隔离和工具说明回访/通信转交仍待实现与动态验收；当前发布包尚未完整提供这些能力。

| 模式 | 中文名 | 权限 | 行为 |
|---|---|---|---|
| `ponder` | 思索模式 | 本地只读白名单 | 可查看工作区项目文件、检索文本、查询只读任务状态，并按高严谨性策略使用专用事实搜索代理；不能编辑、使用通用网络、执行进程或访问备份工具，不产生项目/任务状态文件 |
| `assist` | 协同模式 | 白名单 + 门禁询问 | 受限工具调用前必须询问用户；安装先询问是否已有资源，再受独立开关和逐次授权约束 |
| `devolve` | 放权模式 | 默认全部直接允许 | 每项可配置权限都可单独改为禁止、询问或直接允许 |

- Devolve 设置页会列出所有可配置权限，每项可选“禁止 / 询问 / 直接允许”，出厂默认全部直接允许。Assist 使用另一套独立默认矩阵；Ponder 权限不可修改。
- 用户可以创建、命名、复制和逐项定制任意数量的自定义权限模式。模式以不可变 ID 区分，名称可修改并用于界面识别；自定义模式数量不设产品上限。
- 权限组和当前会话临时提升只决定次级 Agent 的权限上限；主 Agent 始终只能使用读取工具。次级 Agent 分配给三级 Agent 的权限不能超过自己的当前有效权限。
- 用户可临时提升当前会话中全部现有及后续次级 Agent 的某项权限，也可只限定某个具体次级 Agent；关闭会话即失效。关闭时可把会话级公开有效权限导出为 JSON 或新的命名自定义模式，个体差异可选择分别导出。

- Assist 在需要代码库、项目依赖、运行时、插件、工具链或系统包之前，必须先询问用户是否已有可复用资源。用户提供现有资源时只做只读兼容性验证；只有用户明确确认没有，且设置中的独立安装开关已开启，才可提出一次精确安装申请。开关不是授权，每次安装仍需用户 `allow-once`，不能由会话授权或 Agent 判断替代。
- 高严谨性任务必须生成事实证据包，按“资料搜索 > 本地实验 > 纯推理”展示来源、冲突和局限。证据只供用户判断，工具不自动宣布最终合格。
- 同一 Agent/任务默认 30 秒内重复读取未变化且已覆盖的文件时，本地返回已有读取回执而不重复正文；工具环、Agent 回派环和连续无进展重试会被有界暂停。
- 参数变更后必须二次鉴权；模式降级后所有后续调用按新模式重新鉴权。

## Provider 配置

v0.1 CLI 仅内置 `mock` 运行时（确定性、无凭据、可离线验证）。`openai-compatible` 运行时已实现（`packages/core/src/runtime/openai-compatible-runtime.ts`，流式 + 工具调用 + 超时/取消），通过环境变量接入：

```powershell
ASTARRAY_PROVIDER_BASE_URL=https://api.openai.com/v1/chat/completions
ASTARRAY_PROVIDER_API_KEY=sk-...
ASTARRAY_MODEL=gpt-4o
```

API key 永不进入日志、错误、快照或交付报告（脱敏层见 `packages/core/src/infra/redaction.ts`）。

## 状态目录与恢复

状态位于 `.astarray/`（当前工作目录）：

```text
.astarray/
├─ agent-memory/<agentInstanceId>/ # 每个具体 Agent 独占的记忆、任务序列和个体命名空间
├─ missions/<missionId>/
│  ├─ task-chain.json      # 版本化任务链（schema_version + 单调 revision）
│  ├─ task-chain.json.bak  # 原子替换备份
│  ├─ summary.json         # mission 概要（模式/提示词/状态）
│  └─ agents/<agentInstanceId>/work-archive.json # 个体 mission 工作存档
├─ reports/main/<agentInstanceId>/ # 主 Agent 个体的只读后台报告索引，不等同于个人记忆
├─ feedback/mailboxes/     # 反馈进程持久化信箱
└─ config.json             # config init 生成
```

- 写入使用临时文件 + flush + 同目录原子替换；损坏文件从备份恢复，绝不静默覆盖。
- 崩溃后 `astarray resume <mission-id>` 从任务链恢复；投递后 ack 前崩溃由信箱重放（幂等键去重）。

## Headless 用法

```powershell
astarray run "任务" --mode assist --runtime mock --json
astarray status [mission-id] [--json]
astarray resume <mission-id> [--json]
astarray cancel <mission-id> [--json]
astarray doctor [--json]
astarray config init
```

- `--json` 模式 stdout 只输出机器可解析结果，日志与警告写 stderr。
- 退出码：`0` 成功，`1` 执行失败，`2` 用法/参数错误。

## 独立反馈进程

- 形态：独立进程（`child_process.fork`），主进程负责启动、健康检查、优雅关闭与崩溃重启；崩溃后重放未确认消息。
- 投递语义：普通消息仅在接收 Agent `idle` 时投递；投递成功并收到 ack 后才消费；同优先级严格 FIFO，优先级 `instruction > failure > permission-ask > ambiguous > success`。
- 退避：接收者忙碌时等待质数秒（2, 3, 5, 7, 11…），单次上限 3 小时；新消息入池即重置到 2 秒。
- 排错：`doctor --json` 检查反馈进程入口存在性；子进程诊断日志继承 stdout/stderr；主进程退出时子进程自动退出（心跳看门狗 + disconnect 监听）。

## TUI

TTY 下直接运行 `astarray` 进入全屏 TUI：

```text
Tab: 切换面板  Ctrl+M: 模式  Ctrl+N: 新任务  Ctrl+C: 取消/退出  ?: 帮助
1/2/3/4/Esc: 权限弹窗决策
```

要求最小 80×24 终端；支持动态缩放、`NO_COLOR=1`、中英文与 emoji；模型/工具输出中的 ANSI/OSC 序列在 UI 边界统一清洗。

## 跨平台差异与数据清理

- Windows：原子替换使用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`；全局安装 shim 为 `astarray.cmd`；信号处理与子进程清理已覆盖。
- 数据清理：删除 `.astarray/` 即清理全部任务/信箱/缓存数据；Ponder 的模型工具调用不写项目、任务、记忆、缓存或遥测文件。
- 任务运行要求模型以版本化 `ASTARRAY_TASK_COMPLETION_V1` 控制事件明确声明完成。本地运行时还会核对任务节点、验收门禁和未决调用；若输出提前结束且本地状态未完成，看门狗从最近检查点有界续跑，超过续跑上限后转为失败/人工处理，不无限循环。

## 当前限制

- 任务分解使用确定性单任务（真实 LLM 分解由次级 Agent 运行时演进）。
- `openai-compatible` 运行时需配置环境变量；headless `--runtime` 仅 `mock`。
- 指标面板当前显示基线值（MetricsRegistry 已实现，尚未接入编排循环）。
- 多 CLI 实例并发写同一 mission 由 revision 校验兜底（跨进程锁为后续演进项）。
