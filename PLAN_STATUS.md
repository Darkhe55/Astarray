# PLAN_STATUS — Astarray 实施状态

> 更新规则见 `IMPLEMENTATION_PLAN.md` §8.4：开始任务标记 `in_progress`，全部验收通过才标记 `done`。
> 会话中断后从第一个 `in_progress` 或依赖已满足的 `pending` 任务恢复。

> 2026-08-12 设计增补：反馈消息契约新增必填结构化 `source`。用户、Agent、系统来源均可追踪；转发保留原始来源。T00 契约、Schema、测试和架构文档已同步更新。
> 2026-08-12 设计增补：Agent 来源进一步收紧为具体且不可复用的 `agentInstanceId`。新增 T05A：每个次级/三级 Agent 拥有独立工作存档，上级发布任务或重新调用前可选择具体条目附加，默认不注入。
> 2026-08-12 设计增补：新增 T06A 工具内破坏性变更备份层。文件/目录删除、文字删除、替换、截断和覆盖必须先由工具自动保存完整 pre-image；备份数据、路径与恢复能力不经过模型端。
> 2026-08-12 设计增补：T06A 增加 `backupVault` 读取/恢复工具和独立 `deleteBackup` 特权入口。协同模式删除会警告用户并暂停 Agent，逐次授权；放权模式不提醒但保留 HIGH 审计记录；采用 quarantine 两阶段删除防止递归与死锁。模式中文名统一为思索/协同/放权。

## 任务总览

| 任务 | 内容 | 状态 | 批次 | 备注 |
|---|---|---|---|---|
| T00 | 架构定稿与契约 | done | 1 | 2026-08-12 验收通过 |
| T01 | npm 与 TypeScript 工程骨架 | done | 1 | 2026-08-12 验收通过 |
| T02 | 模式状态机与权限策略 | done | 2 | 2026-08-12 验收通过 |
| T03 | 原子任务链持久化 | done | 2 | 2026-08-12 验收通过 |
| T04 | 独立反馈进程 | done | 3 | 2026-08-12 验收通过 |
| T05 | DAG 调度器 | done | 4 | 2026-08-12 验收通过 |
| T06 | 工具注册表与最小权限 | done | 4 | 2026-08-12 验收通过 |
| T06A | 工具内破坏性变更备份层 | done | 4C | 2026-08-12 验收通过（ADR-0009） |
| T07 | Agent Runtime | done | 4 | 2026-08-12 验收通过 |
| T08 | 三级 Agent 编排 | done | 5 | 2026-08-12 验收通过 |
| T09 | 记忆、缓存与指标 | done | 6 | 2026-08-12 验收通过 |
| T10 | TUI | done | 6 | 2026-08-12 验收通过 |
| T11 | Headless CLI | done | 6 | 2026-08-12 验收通过 |
| T12 | 恢复、安全与异常加固 | done | 7 | 2026-08-12 验收通过 |
| T13 | npm 打包与隔离安装 | done | 8 | 2026-08-12 验收通过 |
| T14 | 文档与最终报告 | done | 8 | 2026-08-12 验收通过 |

## Batch 4A/4C（T05A/T06A 增补任务）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 30 文件 / 379 测试通过 |
| `npm run test:coverage` | 0 | Stmts 92.02% / Branch 85.17% / Funcs 89.25% |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + 全局 shim + 反馈入口全通过 |

T05A（Agent 工作存档，ADR-0008）：

- `AgentWorkArchiveStore`：每 Agent 独立存档（版本化 + 单调 revision + 原子写入 + 路径安全编码）。
- Worker 自动记录 assignment/result/failure/handoff；调度器重新调用任务时只附加最近结果类条目（选择器），默认不注入完整存档；附件含 SHA-256 contentHash。

T06A（破坏性变更备份层，ADR-0009）：

- `BackupVault`：破坏性变更前由工具自动保存完整 pre-image（不经过模型）；list/read/restore；quarantine 两阶段删除；manifest revision 单调。
- `BackupDeletionAuthorizationController`：协同模式经专用控制通道逐次授权（allow-once、无会话记忆、revision 校验、fail-closed）；放权模式写 HIGH 审计；哈希链审计日志。
- 新增内置工具：`replaceFileContent`（overwrite + automatic-preimage）、`backupVault`、`deleteBackup`（特权入口）。
- PolicyWrapper/CLI 装配已接入；缺少备份端口时破坏性工具拒绝执行。

实测发现并修复：Agent ID 含冒号导致 Windows 存档路径非法 → 路径段安全编码。

## Batch 8（T13–T14）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 28 文件 / 356 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.81% / Branch 85.27% / Funcs 88.39% |
| `npm pack` | 0 | `.tmp/packages/astarray-0.1.0.tgz`（13 文件 / 105 KB） |
| `node scripts/verify-package.mjs .tmp/packages/astarray-0.1.0.tgz` | 0 | 无 .env/日志/.astarray/测试文件；无 BOM；shebang 正确；反馈入口包含 |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + npx version/help/doctor/run 冒烟 + 全局 .cmd shim + 反馈入口 ESM 加载 |

T13 修复记录：npm 11 全局 `--prefix` 的 shim 位于 prefix 根目录（非 bin/）；Windows 下 execSync 的 rm/mkdir 替换为 Node fs API；`npm pack --json` 输出含 tsup ANSI 噪声需剥离；ESM 入口验证用 file:// URL。

T14 产出：`README.md`（安装/三模式/Provider/状态目录/headless/反馈进程/TUI/跨平台/安全/限制）、`DELIVERY_REPORT.md`（完成情况/实际命令证据/覆盖率/tarball/隔离安装/已知风险）。

## Batch 7（T12）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 27 文件 / 353 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.59% / Branch 85.04% / Funcs 88.09% |

本批加固与实测发现：

- **真实漏洞修复 1**：`writeFileTemporary` 接受 `../` 穿越文件名 → 已加临时目录边界校验（`isPathWithinDirectory`）。
- **真实漏洞修复 2**：Redactor 的 authorization 规则可跨行匹配（`\s+` 吞换行）且与自身占位符自匹配 → 规则改为 `[ \t]+` 并排除跨行；`containsSensitivePattern` 先剔除占位符再断言。
- 无限 tool loop：Worker 达到 maxLoopIterations 后终止并上报失败（不挂死）。
- Ponder 不产生任何状态文件（含任务链/概要）。
- 不可写状态目录/缺失文件：TaskStore 与工具返回明确错误而非崩溃。
- 路径穿越变体（`../`、反斜杠、绝对路径、UNC、多层）全部拒绝。
- 工具分类不可绕过：大小写/包装命令/别名精确名称匹配。
- secret 不泄漏：Redactor 断言级校验（日志、JSON 输出）。

遗留风险：`writeFileTemporary` 的 `flag: "wx"`（不覆盖）在 T12 期间加入，属行为加固；跨进程 mission 锁仍为单进程内实现（多 CLI 实例并发写同一 mission 由 revision 校验兜底）。

## Batch 6（T09–T11）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 26 文件 / 339 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.56% / Branch 84.93% / Funcs 88.06% |

关键交付：

- T09：`DiskCache`（缓存键含 Provider/模型/模式/输入/系统提示词哈希/工具子集哈希/上下文摘要哈希/文件指纹；写操作/时间敏感/失败默认 bypass；stale-reject 语义）、`MetricsRegistry`（hit/miss/bypass/stale-reject、estimated token、峰值并发、消息延迟）、ANSI/OSC 清洗器。
- T10：Ink TUI（Header/会话/DAG/Agent 面板、输入框、权限与帮助弹窗、焦点循环、模式切换、500ms 状态轮询、流式节流 40ms、状态订阅驱动渲染）；组件测试覆盖 80×24/120×40/60×20、CJK/emoji、超长内容、NO_COLOR、ANSI 注入清洗。
- T11：`run/status/resume/cancel/doctor/config init` 全部实现；`--json` 模式 stdout 仅 JSON、日志走 stderr；退出码 0/1/2 稳定；11 项构建产物集成测试 + 17 项命令单元测试；反馈进程入口路径解析修复。

遗留风险：TUI 键盘输入路径未做 PTY 自动化（T13 用 node-pty 补）；指标尚未接入编排循环（v0.1 头栏显示 0）。

## Batch 5（T08）检查点记录

### 2026-08-12 — 通过（连续 3 次 `npm run check` 全绿）

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` ×3 | 0 | typecheck/lint/build/test 全绿，284 测试，无 unhandled |
| `npm run test:coverage` | 0 | Stmts 94.55% / Branch 87.45% / Funcs 93.37% |

关键验收点与证据：

- 主 Agent 派发后立即回输入循环：`handleUserMessage` 返回后后台 mission 运行（main-controller 测试）。
- 两个任务并发 + 第三个等待依赖：串行/并发行为断言。
- 连续失败阈值后 failed + 人工 retry 成功：retry 流程。
- permission-ask → 任务 blocked → 用户授权 + unblock → 成功。
- ambiguous → blocked + 升级用户。
- 非阻塞通信：Worker 挂起时仍可创建第二个任务与查询。
- 显式 cancel 中断（AbortSignal）+ cancel 等待在途 Worker 收敛。
- Devolve：无权限询问、子集边界仍生效、直接裁决方法。
- 修复记录：ToolLoop 透传 errorCode（permission-ask 判定）；task blocked 等待人工裁决（不自动重跑）；cancel 收敛语义；summary 写入互斥。

本批产出：`packages/core/src/orchestration/{mission-orchestrator,worker-agent,assist-scheduler,devolve-scheduler,main-controller,mission-manager}.ts` + ADR-0011（permission-ask 消息类型）+ 编排/主控制器/mission 管理测试。

遗留风险：真实 LLM 的任务分解（v0.1 用确定性分解，见 main-controller.decomposePromptForScriptedRun 注释）。

## Batch 4（T05–T07）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 19 文件 / 247 测试通过 |
| `npm run test:coverage` | 0 | Stmts 94.29% / Branch 86.41% / Funcs 92.98%（门槛生效，低于 85% 会失败） |
| `npm run check` | 0 | 全绿 |

关键验收点与证据：

- T05：环/缺失依赖/重复 ID 检测；并发上限（2/4 验证）；严格串行依赖；领取锁（同一任务不可双领）；失败传播 → 下游 blocked；retry/reassign/cancel/unblock；每轮调度后 revision 单调递增持久化；失败计数器（阈值 3、成功清零、分工具计数）。
- T06：主 Agent 仅预览（无 schema）；子集按任务类型；Worker 子集外调用 deny；Ponder 全 deny；Assist readonly allow / restricted ask（会话授权后 allow，参数哈希变更失效）/forbidden deny；Devolve 注册工具 allow 但路径逃逸拒绝；审计事件；token 估算；shell/删除/安装/发布/付款默认未注册。
- T07：ScriptedRuntime 确定性脚本（含中途取消）；OpenAICompatibleRuntime 流式解析/工具调用累积/finish_reason 分支/超时与取消；API key 不进入错误消息；ToolLoop 工具执行回填、最大迭代保护、取消传播、事件透传。

遗留风险：跨进程 mission 锁与更多安全加固在 T12；OpenAI runtime 的 SSE 实现为整文本解析（生产可换流式，语义不变）。

## Batch 3（T04）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 14 文件 / 177 测试通过 |
| `npm run test:coverage` | 0 | Stmts 94.31% / Branch 85.32% / Funcs 93.79%（门槛 85% 已启用） |
| `npm run build` | 0 | dist/cli.js + dist/feedback-process-entry.js |
| `npm run check` | 0 | 全绿 |

关键验收点与证据：

- 反馈进程 PID ≠ 主进程：集成测试断言（`tests/core/integration/feedback-process.test.ts`）。
- 杀死反馈进程后 supervisor 重启并重放未确认消息：SIGKILL 集成测试 + 重放 ≥1。
- Agent busy 时普通消息不进入其上下文：busy 时 0 投递，转 idle 后投递。
- 同优先级 FIFO、高优先级越过：mailbox-journal 单测（instruction > failure > success；ack 前重放优先）。
- 质数退避 2,3,5,7,11 → 10800 封顶 + 新消息重置：虚拟时钟单测，全程无真实 sleep。
- 投递后 ack 前崩溃可幂等重投：journal 持久化 + 重开重放测试；客户端按 idempotencyKey 去重。

本批产出文件：`packages/core/src/feedback-process/{prime-backoff,ipc-protocol,mailbox-journal,delivery-worker,transport,process-supervisor,entrypoint}.ts` + 单测 4 组 + 真实 fork 集成测试 + `tests/core/fixtures/never-exit.mjs`。

遗留风险：跨进程 mission 锁留待 T12；`npm run test` 单独运行（未 build）时集成测试自动跳过（`describe.skipIf`）。

## Batch 2（T02–T03）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 7 文件 / 113 测试通过 |
| `npm run test:coverage` | 0 | Stmts 97.75% / Branch 90.56% / Funcs 95.12% |
| `npm run build` | 0 | 构建成功 |
| `npm run check` | 0 | 全绿 |

本批产出文件：

- `packages/core/src/core/mode-machine.ts`（迁移规则表 + 非法迁移抛错）
- `packages/core/src/core/permission-policy.ts`（PermissionPolicy 矩阵、SessionAuthorizationManager TTL/参数哈希、PermissionDecider 实时模式裁决）
- `packages/core/src/infra/redaction.ts`（Authorization/API key/JSON 凭据脱敏）
- `packages/core/src/infra/async-mutex.ts`、`packages/core/src/infra/atomic-json.ts`、`packages/core/src/infra/task-store.ts`（临时文件+flush+原子替换+备份恢复+revision 单调+mission 锁）
- 测试：mode-machine / permission-policy / redaction / task-store（113 例，含 8 写者×5 迭代并发更新不丢 revision、Windows 覆盖替换、崩溃恢复）

检查项：命名审查通过；git diff 无敏感信息；错误码新增 invalid-mode-transition / stale-revision / path-escape-attempt。

遗留风险：跨进程 mission 锁（多 CLI 实例写同一 mission）留待 T12；质数退避与反馈协议在 T04。

## Batch 1（T00–T01）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 3 文件 / 32 测试通过 |
| `npm run test:coverage` | 0 | Statements/Branches/Functions/Lines 均 100% |
| `npm run build` | 0 | dist/cli.js 2.96 KB |
| `node dist/cli.js --version` | 0 | 输出 `0.1.0` |
| `node dist/cli.js --help` | 0 | 输出全部子命令 |

检查项：

- git diff 审查：无敏感信息；仅 Batch 1 相关文件。
- 命名审查（§3.2 模式搜索）：无违规变量/函数/时间量（仅领域字符串值与标准 Node 全局命中）。
- shebang：`packages/tui/src/cli.tsx` 首行为 `#!/usr/bin/env node`，构建产物保留。

本批产出文件：

- 工程骨架：`package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`、`eslint.config.mjs`、`.gitignore`、`AGENTS.md`、`README.md`（占位）、`LICENSE`
- 契约：`packages/core/src/core/types.ts`、`packages/core/src/core/events.ts`、`packages/core/src/core/schemas.ts`、`packages/core/src/core/errors.ts`
- CLI 骨架：`packages/tui/src/cli.tsx`（run/resume/status/cancel/config/doctor 为占位 stub，报错退出码 1；真实实现见 T11）
- 测试：`tests/core/unit/schemas.test.ts`、`tests/core/unit/frozen-decisions.test.ts`、`tests/core/unit/errors.test.ts`
- 文档：`docs/architecture.md`、`docs/adr/0001`–`0006`
- 状态：`PLAN_STATUS.md`

已知风险/遗留：

- CLI 子命令为 stub，`--json` 输出约定（stdout 仅结果）尚未实施（T11）。
- 覆盖率门槛 85% 已在 vitest 配置生效；95% 专项门槛（状态机/权限/DAG/反馈协议等）在相关任务完成后追加。
- `cli.tsx` 已从覆盖率统计中排除（入口文件，无领域逻辑）。
