# 仓库文件整理说明

> 整理日期：2026-08-12  
> 原则：保留工程入口稳定、按职责归类源码、把生成物移出根目录、移动时不覆盖既有文件。

## 1. 当前目录职责

```text
astarray/
├─ AGENTS.md                    # Agent 强制工程指引，必须留在根目录
├─ agent-main-architecture.md   # OpenCode 必读的架构设计源文档
├─ designtodo.txt               # OpenCode 必读的原始设计约束
├─ IMPLEMENTATION_PLAN.md       # OpenCode 必读的完整实施流程
├─ PLAN_STATUS.md               # 分批实施状态与验证证据
├─ DELIVERY_REPORT.md           # 当前交付结果与已知风险
├─ ORGANIZATION.md              # 本文件：目录职责与整理记录
├─ README.md / LICENSE          # npm 包说明和许可证
├─ package.json / package-lock.json
├─ tsconfig.json                # TypeScript 配置
├─ tsup.config.ts               # 构建配置
├─ vitest.config.ts             # 测试配置
├─ eslint.config.mjs            # Lint 配置
├─ docs/
│  ├─ architecture.md           # 定稿架构说明
│  └─ adr/                      # 架构决策记录
├─ packages/
│  ├─ core/                     # 底层架构
│  │  └─ src/
│  │     ├─ core/               # 领域类型、Schema、状态机、权限与 DAG
│  │     ├─ feedback-process/   # 独立反馈进程、IPC 与 mailbox
│  │     ├─ infra/              # 存储、缓存、指标、清洗等基础设施
│  │     ├─ orchestration/      # 主/次级/三级 Agent 编排
│  │     ├─ runtime/            # Agent Runtime 与工具循环
│  │     └─ tools/              # 工具注册、边界和策略包装
│  ├─ tui/                      # npm CLI 和终端界面
│  │  └─ src/
│  │     ├─ cli.tsx             # npm bin 入口
│  │     ├─ cli/                # Headless CLI 与装配
│  │     └─ ui/                 # React/Ink TUI
│  └─ gui/                      # GUI 预留边界；当前只有说明，无虚构实现
├─ tests/
│  ├─ core/                     # 底层 unit/integration/fixtures
│  └─ tui/                      # TUI unit/component/integration
├─ scripts/                     # 打包检查与隔离安装脚本
└─ .tmp/                        # 被 git 忽略的生成物和临时验证数据
   ├─ packages/<run-id>/        # 每次 npm pack 的独立 tarball 目录
   ├─ package-smoke/<run-id>/   # 每次 tarball 隔离安装环境
   ├─ global-prefix/<run-id>/   # 每次模拟全局安装环境
   └─ legacy-empty-directories/ # 空遗留目录的保留位置
```

`node_modules/`、`dist/`、`coverage/`、`.astarray/` 和 `.tmp/` 均为生成或运行目录，不属于源码，已由 `.gitignore` 排除。

## 2. 本次移动记录

| 原位置 | 新位置 | 原因 |
|---|---|---|
| `astarray-0.1.0.tgz` | `.tmp/packages/astarray-0.1.0.tgz` | npm 产物不应占用仓库根目录 |
| `GUI/` | `.tmp/legacy-empty-directories/GUI/` | 空遗留目录，无源码或引用；保留而未删除 |
| `TUI/` | `.tmp/legacy-empty-directories/TUI/` | 空遗留目录；正式 TUI 位于 `packages/tui/` |
| `src/{core,feedback-process,infra,orchestration,runtime,tools}` | `packages/core/src/` | 将底层架构集中为无界面依赖的一层 |
| `src/{cli.tsx,cli,ui}` | `packages/tui/src/` | 将 npm 命令入口、Headless CLI 和 Ink TUI 集中归类 |
| `tests/{unit,integration,fixtures}` 中的核心测试 | `tests/core/` | 测试结构与底层架构对应 |
| CLI/TUI 单元、组件与集成测试 | `tests/tui/` | 测试结构与 TUI 层对应 |
| 移动后为空的旧 `src/` 和旧测试分类目录 | `.tmp/legacy-empty-directories/` | 保留空目录痕迹，不执行删除 |

移动前已验证目标不存在，因此没有覆盖文件；本次整理没有删除任何用户文件。

## 3. 同步修正

- 移除了 `package.json` 和 lockfile 中错误的 `astarray → file:astarray-0.1.0.tgz` 自身依赖。
- `scripts/smoke-install.mjs` 现在通过 `npm pack --pack-destination .tmp/packages` 直接把新 tarball 输出到归档目录，避免根目录再次堆积。
- 冒烟脚本为每次验证生成唯一 `run-id`，不再递归清空或覆盖上一次验证目录。
- `DELIVERY_REPORT.md` 与 `PLAN_STATUS.md` 中的 tarball 路径已同步为 `.tmp/packages/astarray-0.1.0.tgz`。
- `tsconfig.json`、`tsup.config.ts`、`vitest.config.ts` 已切换到 `packages/` 和分层测试路径。
- TUI 到 Core 的引用均为单向依赖；Core 不引用 TUI 或 GUI。
- `packages/{core,tui,gui}/README.md` 分别记录各层职责和依赖边界。

## 4. 为什么部分文档仍保留根目录

`AGENTS.md` 明确要求 OpenCode 开始编码前从根目录读取：

- `agent-main-architecture.md`
- `designtodo.txt`
- `IMPLEMENTATION_PLAN.md`
- `PLAN_STATUS.md`

因此这些文件不移动。`README.md`、`LICENSE`、`package.json` 及构建配置也是 npm/Node 工程的标准根目录入口。

## 5. 后续维护约定

- 新的正式架构决策写入 `docs/adr/`。
- ADR-0014–0024 分别冻结 Ponder 本地只读、明确完成/早停恢复、事实验证、反自指/活锁、全模式敏感禁读、Assist 安装门禁、可配置权限组/自定义模式、主 Agent 永久只读/会话临时提升、默认三层控制流/三级生命周期、按具体 Agent 个体隔离记忆与上下文，以及工具说明回访/Agent 无产品数量配额/受权通信转交；对应实现任务为 T06B–T06G/T07A/T07B/T08A/T08B。
- ADR-0025 冻结主 Agent 对话独占下的小任务次级直投、次级摘要/项目侦察/测试验收职责和四级委派；ADR-0026 冻结 Agent 独立模型/Provider 策略、用途允许列表及任务类型预设；对应实现任务为 T08C/T07C，任务卡位于 `docs/tasks/T08C_T07C_AGENT_ROUTING_AND_MODEL_POLICY_TASK_CARDS.md`。
- ADR-0027 冻结阶段性显现的“工匠”三级 Agent预设、本地阶段信号、用户自定义阶段模板、提示词自动安排和工作流 bundle；对应实现任务为 T08D，任务卡位于 `docs/tasks/T08D_CRAFTSMAN_TERTIARY_PRESET_TASK_CARD.md`。
- 新的底层实现放入 `packages/core/src/`，TUI 放入 `packages/tui/src/`，GUI 放入 `packages/gui/src/`。
- Core 不得依赖 TUI/GUI；两个界面层不得互相依赖，共享规则必须下沉 Core。
- 新测试先按产品层放入 `tests/core/`、`tests/tui/` 或未来的 `tests/gui/`，层内再按 unit/component/integration 分类。
- `packages/gui/` 当前只是设计边界；未完成真实 GUI 与测试前，不应加入构建入口或宣称可用。
- npm tarball 始终输出到 `.tmp/packages/<run-id>/`。
- 不提交 `dist/`、`coverage/`、`.tmp/`、`.astarray/`、`node_modules/` 或 `*.tgz`。
- 移动正式文件后必须同步文档引用、构建入口和测试路径，并运行 `npm run check`。

## 6. OpenCode 执行注意事项

- 默认一次只完成 1–2 个高度相关的原子任务；只有文件互不重叠、依赖已满足时，最多并行 3 个。
- 反馈独立进程、工具内自动备份、三级 Agent 编排和故障恢复属于高风险任务，每次只处理其中一个主题。
- 默认控制流、三级 Agent 生命周期和按 `agentInstanceId` 隔离个体记忆属于同一个高风险任务 T08A，必须单独实现和验收；不得与权限或备份任务合批。
- 工具说明回访、Agent 数量语义和受权通信转交属于高风险任务 T08B，必须在 T08A 后单独实现和验收。
- 主对话独占下的次级直投、项目侦察、测试/验收任命和四级委派属于高风险任务 T08C；独立模型/Provider 和任务预设属于高风险任务 T07C，两者都必须单独实现和验收。
- 阶段性“工匠”预设属于高风险任务 T08D，必须在 T08C 后、T07C 前独立实现和验收；完整顺序更新为 T08C → T08D → T07C。
- 多 Provider 原生协议、真实流式传输、CLI/TUI 装配、Public SDK 和独立工作助手纵向闭环属于高风险任务 T07D；任务卡位于 `docs/tasks/T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md`。T07C 只完成选择策略，T07D 必须在 T07C 后、T12 前单独验收；完整顺序更新为 T08C → T08D → T07C → T07D → T12。
- `docs/tasks/README.md` 提供任务卡定位索引，任务实际状态仍以 `PLAN_STATUS.md` 和动态验收证据为准。
- 人工与 Agent 并行编码使用 T05D 独立任务卡；默认10文件工作集预算使用 T07E 独立任务卡；中断后的统一检查点与外部状态对账使用 T12A 独立任务卡。三者分别位于 `docs/tasks/T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD.md`、`docs/tasks/T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD.md` 和 `docs/tasks/T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD.md`。
- T08C 后形成三条偏序分支：T08D→T07C、T05D、T07E；三路都通过后才能执行T07D，随后按T12A→T12→T13→T14收口。
- Ponder 本地只读、全模式敏感禁读、反自指/活锁、事实验证和完成协议/早停恢复都属于高风险任务，必须分别单批实现和验收，不得在同一轮编码。
- 普通批次建议控制在 5–15 个生产文件及同等数量级测试文件；预计超过约 1,000 行生产代码时继续拆分。
- 每一批都必须同时完成实现、测试、文档和 `PLAN_STATUS.md`，当前批未通过不得开始依赖它的下一批。
- 修改 Core 时先运行 `tests/core/`；修改 TUI 时运行 `tests/tui/`，并确认 Core 测试未回归。GUI 将来必须建立独立的 `tests/gui/`。
- 完成两个普通批次或任一高风险任务后运行完整 `npm run check`；发布验收继续以 tarball 隔离安装为准。
- 移动、删除、文字删减、替换、截断或覆盖前必须走工具自身的自动备份层；不得让模型读取或手工代替自动备份。

## 7. 本次整理验证

2026-08-12 实际执行并通过：

- `npm run typecheck`
- `npm run lint`
- `npm run test`：28 个测试文件、356 项测试全部通过
- `npm run build`：生成 `dist/cli.js` 与 `dist/feedback-process-entry.js`
- `npm pack --json`：生成 `astarray-0.1.0.tgz`，包内 13 个文件
- 在全新隔离目录安装 tarball，验证 `--version`、`doctor --json`、mock `run --json`、Windows `.cmd` shim 和反馈进程入口均通过
- Core 源码反向依赖扫描：未发现对 TUI 或 GUI 的引用

验证数据保存在 `.tmp/reorganization-verification-20260812-1822/`；未覆盖既有验证目录。
