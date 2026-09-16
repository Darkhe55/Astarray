# AUTH-SCOPE-01 范围分类与裁决者矩阵冻结 — 证据

> 检查点：AUTH-SCOPE-01（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md，**未跟踪用户文件：本轮只读取、未修改未暂存**）
> 前驱：当前编码检查点已收口（GUIDE-01-04，提交 `864b300` 已推送；全量门禁 204 文件/1650 用例全通过）
> 契约冻结：docs/adr/0039-auth-scope-and-adjudication-matrix.md
> 日期：2026-09-16

## 1. 当前实现核对（只读审计）

| 模块 | 现状 | 与 AUTH-SCOPE 的关系 | 缺口 |
| --- | --- | --- | --- |
| `packages/core/src/tools/workspace-boundary.ts` | `resolveWithinWorkspace`：`path.resolve` + 根内前缀检查 + 最近存在祖先 realpath（防符号链接逃逸）；越界抛 `path-escape-attempt` | 是 S1/S2 判定的**唯一**现有基础 | 只有"根内/根外"二元；无多项目根、无 junction 显式处理、无副作用解析 |
| `packages/core/src/tools/assist-installation-gate.ts` | 独立设置 `settings/assist-installation.json`，`isInstallationEnabled()`；协同安装请求/授权/精确参数绑定与复检 | S5 的现有实现 | 语义仍是"协同安装=逐次人工"，未按作用范围分流；未识别安装脚本副作用 |
| `packages/core/src/tools/installation-gate-guard.ts` | `InstallationGateGuard` + `InstallationGateUserPort`（界面注入） | S5 执行前门禁 | 同上 |
| `packages/core/src/tools/permission-capability-catalog.ts` / `configurable-permission-policy-engine.ts` | 三态 deny/ask/allow 能力目录与判定 | 矩阵落点（S1 上级批准、S4 ask 路由） | 目录中**没有**"作用范围"维度，也没有外部软件控制能力项 |
| `packages/core/src/core/permission-policy.ts`（mode machine / session authorization） | 三种模式与一次性会话授权 | 裁决者矩阵的模式维度 | 无"上级批准回执"与"逐级升级"的显式记录 |
| 工具面（`builtins.ts`） | readFile/listDirectory/writeFileTemporary/createProjectFile/replaceFileContent/backupVault/deleteBackup/taskSequenceStatus/searchProjectText/gitReadonlyView/factVerification | 现有能力全部在项目文件/只读查询/备份域内 | **无外部软件控制工具（S6）**；无通用进程执行工具 |
| ADR-0019（安装门禁）、ADR-0020/0021（权限组、主 Agent 只读）、ADR-0022/0025（控制流与委派） | 既有约束 | 矩阵与升级规则的依据 | 需按本 ADR 统一修订（见 §4 迁移清单） |

**结论**：范围分类、裁决者矩阵、上级批准回执、逐级升级与执行前复检**均未实现**；现有仅有一个根内/根外路径检查与安装开关。
不重复造模块：本检查点只冻结契约，实现落在 AUTH-SCOPE-02/03。

## 2. 范围分类与裁决者矩阵

见 ADR-0039 §1–§4（S1–S7 分类 + 三模式矩阵 + 判定规则 + 升级回派）。
本检查点验收要点与结论：

| 验收要点 | 结论 |
| --- | --- |
| 项目内外、未知、安装、外部软件及专用流程有明确结果 | ✅ S1–S7 与三模式矩阵逐格给出（含"未知=人工/ask"与"S7 不放宽"） |
| 没有歧义则不增加设置层级 | ✅ 不新增设置项；沿用既有三态能力目录与安装开关，范围维度作为**判定输入**而非新设置层 |
| 旧规则迁移清单 | ✅ §4 列出 AGENTS.md 条款、安装门禁语义/文案、测试预期、能力目录、CLI/TUI 文案 |
| 未占用 ADR 编号 | ✅ 登记 **ADR-0039**（现有最高为 0038） |

## 3. 与既有规则的一致性与风险

- 主 Agent 只读不变；指导/准确性开关都不授予操作权限（与 ADR-0021、GUIDE-01 一致）。
- 安装独立开关**不得**被自动批准替代（ADR-0019 保持）。
- 判定不得依赖 cwd/前缀/自述：现有 `WorkspaceBoundary` 以 `process.cwd()` 作为工作区根（application-runtime），
  AUTH-SCOPE-02 必须显式改为"已登记项目根"，否则 S1 判定会被 cwd 污染 —— **已登记为 02 的首要反例**。
- 风险：S4"未知"覆盖过宽会导致协同模式下大量人工等待；02 需给出可证明受控的白名单（如已登记构建/测试工具）。

## 4. 旧规则迁移清单（正式启用前统一修订，本轮不实施）

1. `AGENTS.md`：安装/外部软件条款（现为"协同模式任意安装逐次授权"）→ 按范围分类与裁决者矩阵改写。
2. `assist-installation-gate.ts` 注释与 `installation-gate-guard.ts` 语义文案。
3. 安装门禁相关测试预期（`tests/core/unit/assist-installation-gate*.test.ts` 等）。
4. `permission-capability-catalog.ts`：安装能力项补充范围维度说明；新增外部软件控制能力项（实现于 02）。
5. CLI/TUI 提示、帮助与导出配置文案。
6. `PLAN_STATUS.md`/任务索引等治理文件（由集成者在安全检查点合并，本轮不触碰）。

## 5. 命令与退出码

| 项 | 结果 |
| --- | --- |
| 本检查点性质 | **设计/冻结检查点：无产品代码变更**，故不新增测试、不跑全量门禁（与 INT-00、BRIDGE-01-01、GUI-01-R-01、WB-00-01 同类判定） |
| 最近一次全量门禁（同一代码基线） | `npm run build` 0；`npx vitest run --maxWorkers=6` **204 文件/1650 用例全通过**；`--coverage --maxWorkers=6` exit 0（93.33/85.69/92.21/93.39） |
| 提交与推送 | 见 §6 |

## 6. 提交与推送

（本轮提交后回填。）

## 7. 未满足项与后续

- **AUTH-SCOPE-02**（实现）：本地范围判定（真实路径/链接/子进程/安装脚本/环境写入）、上级批准回执、
  逐级升级、执行前复检；反例须覆盖链接逃逸、路径前缀碰撞、跨根写入、全局安装、子进程外写、失效上级与 revision 变化。
- **AUTH-SCOPE-03**（接线）：设置与公共入口、放权默认无人工等待、deny 生效、协同项目内批准/项目外等待人工、
  拒绝与重放零副作用、恢复与打包回归。
- 本检查点未运行任何真实安装/外部软件操作（避免隐式副作用）。
