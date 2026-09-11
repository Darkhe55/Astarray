# T09A-R1-01 上下文装配与必要信息保护 · 证据

> 检查点：T09A-R1-01　状态：done
> 任务卡：`docs/tasks/T09A_R1_CONTEXT_RUNTIME_WIRING_TASK_CARD.md`；前驱：T07D-R1（done）、T07D-R2-02（done）
> 基线提交：`80274a4`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 实现内容

| 文件 | 变更 |
|---|---|
| `packages/core/src/orchestration/context-prompt-assembler.ts` | 新增：`assembleContextPrompt`（系统规则/任务必要条件/全局相关记录/局部活跃前沿四段）与 `createContextPromptProvider`（由真实存储构建） |
| `packages/core/src/application/application-runtime.ts` | 装配 `GlobalDecisionStore` + `LocalContextGraphStore`，默认构建上下文提供者；新增预算与必要条件选项 |
| `main-controller` / `mission-orchestrator` / `worker-agent` | 逐层透传提供者；Worker 在调用 Provider 前装配系统提示词，**必要条件缺失时抛 `context-mandatory-constraint-missing`（不调用 Provider）** |
| `core/errors.ts` | 新增稳定错误码 `context-mandatory-constraint-missing` |

装配规则：系统规则与任务必要条件始终进入提示词（独立于可选全局记录）；全局记录只注入“相关 + active + 预算内”的选择结果；局部活跃前沿只注入未关闭节点（标识/状态/指纹），已关闭节点只计数、不注入原文。

## 2. 验收对应

| 验收项 | 证据 |
|---|---|
| 捕获本地测试服务器收到的请求 | `tests/core/integration/context-runtime-wiring.test.ts`：请求体含 `[系统规则]`/`[任务必要条件]`/`[全局相关决策]`/`[局部活跃前沿]` 与相关记录文本 |
| 无关记录不注入 | 同上：请求体**不含** `UNRELATED-DECISION-TEXT`（不同 scope 的记录被选择器排除） |
| 已关闭原文不注入 | `context-prompt-assembler.test.ts`：活跃节点注入、已关闭节点标识不注入、`excludedClosedNodeCount=1`（图节点本身不存原文） |
| 必要约束缺失时阻塞 | `worker-context-gate.test.ts`：缺失条件 → `context-mandatory-constraint-missing` 且 Provider 未被调用 |

## 3. 命令与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯（新增套件） | 1 | 模块/行为缺失 |
| 隔离验证（5 套件） | **0** | 15 通过（3.2s） |
| `npx tsc --noEmit` | **0** | 无类型错误 |
| `npx eslint .` | **0** | 无 lint 错误 |
| `npm run check`（权威 forks 池） | 未执行 | **审批通道不可用**：`danger-full-access` 请求挂起到 600s 上限，无法复跑（详见 §4） |
| `npm run test:coverage` | 未执行 | 同上 |

## 4. 本次未能复跑的权威门禁与替代证据

- 免审批 threads 池全量：`74/75 failed` 中除 11 个已知沙箱受限套件（真实 fork/git/构建产物）外，另有 3 个真实 I/O 集成套件在高并发下超时（同一批套件**单独运行 15/15 通过**、此前权威门禁中亦通过）。已把相关测试超时放宽（60s）与轮询上限放宽（20–50s），但 threads 池在 150 文件并行下仍有调度饥饿。
- 上次权威门禁结果（本检查点前）：`npm run check` exit 0（153 文件 / 1416 测试）、`test:coverage` exit 0（分支 87.28%）。本检查点改动为新增装配模块与透传，typecheck/lint/隔离套件均通过。
- 待审批通道恢复后补跑：`npm run check`、`npm run test:coverage`。

## 5. 边界与后继

- 预算设置与延后片段持久化（TUI/CLI 公开设置）属 `T09A-R1-02`；关闭/回访/人工验收工具属 `-03`；实际缓存与指标属 `-04`。
- `LocalCompletionVerifier` 的 revision/证据包全量校验仍待 E2E-01 接入。
