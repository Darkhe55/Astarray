# T09A-R1-02 设置与延后片段 · 证据

> 检查点：T09A-R1-02　状态：done
> 任务卡：`docs/tasks/T09A_R1_CONTEXT_RUNTIME_WIRING_TASK_CARD.md`；前驱：T09A-R1-01（done）
> 基线提交：`4f7e815`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 实现内容

| 文件 | 变更 |
|---|---|
| `packages/core/src/orchestration/global-context-budget-store.ts` | 新增：预算策略持久化（默认 4096；非负整数；revision 单调 + expected-revision CAS；原子写 + .bak） |
| `context-prompt-assembler.ts` | 新增 `resolveContextBudget`（模型输入空间不足取较小有效值 + 缩减原因）、预算策略提供者与**按 revision/有效预算/记录指纹失效的选择缓存** |
| `global-decision-selector.ts` | 新增 `readDeferredGlobalContextFragments`（按 agentInstanceId 目录隔离；跨 Agent 返回空；损坏条目跳过） |
| `application-runtime.ts` | 装配预算存储并注入提供者（设置变化从下一请求生效） |
| `packages/tui/src/cli/commands.ts` + `cli.tsx` | 新增 `config context-budget [tokens] [--json]`；`context status` 改为读取持久化预算并显示配置/有效值 |

## 2. 验收对应

| 验收项 | 证据 |
|---|---|
| 默认 4096、可调高/低/0 | `global-context-budget-store.test.ts`：默认 4096 rev1 → 0（rev2）→ 8（rev3）并回读 |
| 非法值 | 负数/小数/NaN 被拒且不改变已存策略 |
| 并发 CAS | 陈旧 revision → `stale-revision`；同 revision 并发两次仅一次成功，revision 只 +1 |
| 修改从下一请求生效、按 revision 失效缓存 | `context-budget-provider.test.ts`：预算 4096 注入记录；revision 2 预算 0 后同一 provider 不再注入 |
| 模型空间不足 | `resolveContextBudget`：configured 4096 / 模型空间 512 → effective 512 + 缩减原因 |
| 中文估算 | `estimateGlobalDecisionTokenCount`：中文字符数/4、至少 1 token |
| 延后片段持久化且可读取、不跨 Agent 泄漏 | `deferred-context-fragments.test.ts`：agent-a 2 条、agent-b 0 条；mission 过滤；损坏条目跳过 |
| CLI 公开设置 | `config-context-budget.test.ts`：缺省显示 `configured: 4096`；设置 0 → `context-budget=0 revision=2`；非法值非 0 退出 |

## 3. 命令与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 新增 4 套件 | **0** | 10 通过（首轮 CLI 非法值用例 1 失败，为测试桩未拦截 `process.exit`，已修正） |
| `npm run check` | **0** | 160 文件 / 1432 测试全通过 |
| `npm run test:coverage` | **0** | 语句 93.87% / 分支 87.34% / 函数 91.19% / 行 93.95% |

## 4. 边界与后继

- 延后片段已可持久化读取；**自动回访注入**（把延后片段按结构化请求重新送入提示词）属 `T09A-R1-03`。
- TUI 面板暂未新增预算设置控件（CLI + SDK 路径已通）；如需图形设置可在 `-04` 一并接入。
- 关闭/人工验收/回访工具（`-03`）与实际缓存指标（`-04`）仍待执行。
