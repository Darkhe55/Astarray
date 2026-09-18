# GOV-01 治理规则迁移范围冻结与冲突清单 — 证据

> 检查点：GOV-01（治理文档统一，用户文档 §5 迁移与 §7 正式启用前修订要求）
> 前驱：GUIDE 增量 02b（提交 744a08f、055d2ac，已推送）。日期：2026-09-17
> 冻结契约：docs/adr/0043-governance-rule-migration-and-unification.md
> 基线：HEAD `055d2ac` == origin/main；工作树仅用户并行改动（5 个既有文件 + 未跟踪 steering/WB 文档）

## 1. 审计范围与方法（只读，无生产代码变更）

| 命令/文件 | 目的 |
| --- | --- |
| `grep "任意安装|逐次取得?人工授权|逐次.*授权|安装" docs` | 找出仍陈述旧安装规则的文档/卡片 |
| `grep "安装" AGENTS.md` | 定位治理文件中的旧条款（第 29 行） |
| `grep "installation-gate|assist-installation|安装" tests/**/*.test.ts` | 找出断言旧语义的测试与规模 |
| 阅读 `docs/adr/0019/0020/0039/0033/0042`、`docs/architecture.md`、`assist-installation-gate.ts` | 核对旧/新规则与保留要素 |
| `git status --porcelain` | 确认用户并行脏文件，划定不可触碰范围 |

## 2. 旧规则分布（grep 计数，冻结时工作树）

| 文件 | 命中数 | 性质 |
| --- | --- | --- |
| docs/adr/0019-assist-installation-preflight-and-authorization.md | 1 | 旧规则权威来源（保留历史 + 标注替代） |
| docs/adr/0020-configurable-permission-profiles-and-custom-modes.md | 1 | "即使 allow 仍须 ADR-0019 精确逐次" |
| docs/architecture.md | 1 | 自动提示不得批准安装（与新矩阵核对） |
| docs/adr/0039-auth-scope-and-adjudication-matrix.md | 3 | 新矩阵（权威） |
| docs/tasks/BATCH6_REPAIR_TASK_CARDS.md | 2 | 历史任务卡 |
| docs/tasks/AR07_FINAL_ACCEPTANCE.md | 2 | 历史验收记录 |
| docs/tasks/GUI_MVP_CODING_TASK_CARD.md | 1 | 历史卡片 |
| docs/adr/0033 / 0035 / 0042、docs/reports/* | 各 1–2 | 引用安装门禁的衍生文档 |
| AGENTS.md 第 29 行 | 1 | 治理文件旧条款（本轮不改，GOV-02a） |

## 3. 断言旧语义的测试（规模）

| 测试文件 | 命中数 |
| --- | --- |
| tests/core/unit/assist-installation-gate.test.ts | 24 |
| tests/core/unit/installation-gate-execution.test.ts | 15 |
| tests/core/unit/ar07-module-gaps-5.test.ts | 3 |
| tests/core/unit/classifier-lifecycle-gaps.test.ts | 3 |
| tests/tui/unit/install-decision-port.test.ts | 2 |
| 其余（auth-scope、craftsman、tool-registry 等） | 各 1–3 |

这些用例本身是安全要素的回归（开关默认关闭、先询问、参数绑定、复检），**修订期望时不得放宽**；
需改的是"协同模式安装一律逐次人工"的表述，而非开关/询问/绑定/复检。

## 4. 用户并行脏文件（本轮不可触碰，GOV-02a 前需其落定）

| 文件 | 状态 | 处理 |
| --- | --- | --- |
| IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、agent-main-architecture.md、docs/tasks/README.md | 已修改（未暂存） | 保持原样；GOV-02a 改写前先核对用户改动 |
| tests/core/unit/application-sdk-task-events.test.ts | 已修改（未暂存） | 不触碰 |
| docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md、PRODUCT_INTEGRATION_ROLLOUT.md、SESSION_SUMMARY…、LONG_SESSION…、WB00… | 未跟踪用户文件 | 只读；不修改、不暂存 |
## 5. 冻结结论（摘要，权威见 ADR-0043）

1. **范围优先**：安装/外部软件不再一律人工；先判 S1–S7，再按 ADR-0039 矩阵选择上级自动批准或人工裁决。
2. **必须保留**：独立安装开关（默认关闭、关闭即拒绝）、已有资源询问/选择回执、精确内容与参数绑定、一次性 nonce、
   revision 与执行前复检；不得用会话记忆/推断/批量许可放行；`deny` 优先；S4 不得把用户离线当同意。
3. **不得存在同时生效的矛盾描述**：旧表述改写为引用或标注「已被 ADR-0039/0043 替代」，历史记录保留。
4. **顺序**：GOV-02a 文档改写（用户并行文件落定后）→ GOV-02b 测试期望修订 + 安装门禁按范围分流（先行为反例）。

## 6. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `git rev-parse HEAD` | `055d2ac`（与 origin/main 一致） |
| `git status --porcelain` | 仅用户并行改动（5 个已修改文件 + 未跟踪 steering/WB 文档） |
| `grep`/`read` 审计（见 §1） | 全部执行成功；清单见 §2–§4 |

> 本检查点为设计/审计冻结（无生产代码变更），未运行测试：按 rollout §4，文档纠偏阶段采用链接/差异与审计取证，
> 不为文档新增无意义代码测试。GOV-02b 实现改动时必须先写行为反例并跑 `npm run check`/`test:coverage`。

## 7. 未满足项与后续

- **GOV-02a**：AGENTS.md、ADR-0019/0020、architecture.md 与状态表/索引改写（用户并行文件落定后；保留历史与替代标注）。
- **GOV-02b**：测试期望修订（`assist-installation-gate`、`installation-gate-execution` 等）与安装门禁按范围分流实现；先行为反例，不得放宽。
- 外部依赖仍未满足：E2E-01 真实 Provider、GUI-01-R-04b 人工体验、BRIDGE-01-04 真实 MCP 客户端、WB-00-02（前驱 GUI-01-R）。
- 本轮未修改 AGENTS.md、设计大纲、实施计划、状态表、任务索引与生产代码。

## 8. 提交与推送

- 本检查点提交：`d530c86`（docs(governance): GOV-01 安装/外部软件规则迁移范围冻结与冲突清单）。
- `git push`：**exit 0**（第 1 次尝试成功，`055d2ac..d530c86`）。

