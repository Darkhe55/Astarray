# GOV-02a 治理文件与 ADR 改写 — 证据

> 检查点：GOV-02a（治理规则迁移的文档改写；ADR-0043 §4 映射）
> 前驱：GOV-01（提交 d530c86、dad98a6，已推送）。日期：2026-09-17
> 契约：docs/adr/0043-governance-rule-migration-and-unification.md（§6 实施记录）

## 1. 交付物

| 文件 | 改动 |
| --- | --- |
| AGENTS.md 第 29 行 | 旧条款「协同模式的任意安装尝试…逐次用户授权」改写为**范围优先**：先判 S1–S7 与 ADR-0039 矩阵；项目内受控安装（开关开启 + 参数绑定）可由有权上级按设置批准；跨项目根/项目外/全局/外部软件/未知范围必须逐次用户授权；保留已有资源询问、独立开关、精确参数绑定与执行前复检；`deny` 优先 |
| docs/adr/0019-assist-installation-preflight-and-authorization.md | 顶部新增「范围判定部分已被 ADR-0039/0043 替代」迁移说明；历史正文与安全顺序保留 |
| docs/adr/0020-configurable-permission-profiles-and-custom-modes.md 第 69 行 | 改为按范围矩阵裁决（项目内受控可由上级批准；跨根/项目外/全局/外部软件仍需逐次用户授权），保留 ADR-0019 的开关/询问/参数绑定 |
| docs/adr/0043-governance-rule-migration-and-unification.md | 追加 §6 实施记录 |

## 2. 核对与未改项

| 文件 | 结论 |
| --- | --- |
| docs/architecture.md 第 199 行（自动提示不得批准安装） | 与「上级按设置批准」不冲突（自动提示不是有权上级裁决），无需改动 |
| docs/architecture.md 第 164 行（删除备份专用流程） | 属 ADR-0010 专用流程，ADR-0043 §5 明确非目标，不改 |
| PLAN_STATUS.md 第 46 行（旧规则表述） | **用户并行脏文件**，本轮不改；列入 GOV-02a 剩余 |
| IMPLEMENTATION_PLAN.md、agent-main-architecture.md、docs/tasks/README.md | **用户并行脏文件**，本轮不改 |
| 未跟踪用户文档（2026-09-16 增量卡、rollout、SESSION_SUMMARY、LONG_SESSION、WB00） | 只读；不改不暂存 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `grep "任意安装|逐次取得人工授权" .` | 仅剩"历史/已替代"描述（ADR-0039/0019/0043、AUTH_SCOPE_01、未跟踪用户文档）与 PLAN_STATUS.md（用户脏文件） |
| `grep "逐次" AGENTS.md` | 命中新条款第 29 行与删除备份条款第 50 行（后者属 ADR-0010 专用流程） |
| `git status --porcelain` | 仅本检查点文件 + 用户并行改动 |

> 本检查点为文档改写（无生产代码变更），未运行测试；按 rollout §4 文档纠偏阶段采用差异/一致性检查取证。
> GOV-02b（测试期望修订 + 安装门禁按范围分流实现）必须先写行为反例并跑 `npm run check`/`test:coverage`。

## 4. 未满足项与后续

- **GOV-02a 剩余**：`PLAN_STATUS.md` 旧表述与 `IMPLEMENTATION_PLAN.md`/`agent-main-architecture.md`/`docs/tasks/README.md` 的同步改写，需等用户并行改动落定。
- **GOV-02b**：测试期望修订（`assist-installation-gate.test.ts`、`installation-gate-execution.test.ts` 等）与安装门禁按范围分流实现。
- 外部依赖：E2E-01 真实 Provider、GUI-01-R-04b 人工体验、BRIDGE-01-04 真实 MCP 客户端、WB-00-02（前驱未满足）。

