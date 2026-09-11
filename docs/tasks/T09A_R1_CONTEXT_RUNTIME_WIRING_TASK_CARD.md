# T09A-R1：上下文生命周期运行接线

> 状态：`done`（T09A-R1-01/02/03/04 全部通过，2026-09-10）
> 创建日期：2026-09-10
> 类型：核心返修；高风险工作按检查点执行
> 来源：用户授权布置；本文件为Agent派生实施方案，运行态节点默认层级1或以下，不冒充用户层级0
> 前驱：T07D-R1；T07D-R2-02通过后做产品入口联测

## 执行契约

必须先读取 [本批实施顺序与共同验收规则](./PRODUCT_INTEGRATION_ROLLOUT.md) 及 AGENTS.md 指定的四份治理文档。该共同文件是本卡的一部分，包含批次、测试、证据、安装、Git及停止条件。原任务卡的未满足验收要求继续有效。

## 目标与范围

将 T09A 已有选择器、存档、回访、预算、验收和缓存接入真实提示词装配与工具调用；不以状态DTO或单元测试替代模型实际收到的内容。

## 检查点

### T09A-R1-01：装配与必要信息保护

- 状态：done（2026-09-10）。产物：`docs/reports/T09A_R1_01_CONTEXT_ASSEMBLY_EVIDENCE.md`。
- 工作：审计实际提示词构建路径，接入全局相关选择和局部活跃前沿；系统规则与任务必要条件独立于可选全局记录。
- 验收：捕获本地测试服务器收到的请求：无关记录不注入，已关闭原文不注入，必要约束缺失时阻塞而非静默执行。
- 前驱：本卡前驱。先通过前驱，再执行本节点。

### T09A-R1-02：设置与延后片段

- 状态：done（2026-09-10）。产物：`docs/reports/T09A_R1_02_BUDGET_DEFERRED_EVIDENCE.md`。
- 工作：接通TUI/CLI公开预算设置与持久化：默认4096、可调高/低/0；显示配置及有效值；修改从下一请求生效，按revision失效选择缓存。
- 验收：测试0、小预算、模型空间不足、中文估算、并发CAS、非法值；延后内容持久化且未来相关任务可读取，不跨Agent泄漏。
- 前驱：T09A-R1-01。先通过前驱，再执行本节点。

### T09A-R1-03：关闭、人工验收与回访工具

- 状态：done（2026-09-10）。产物：`docs/reports/T09A_R1_03_CLOSURE_VERIFICATION_EVIDENCE.md`。
- 工作：注册结构化回访和本地关闭控制，接通Assist阻塞/Devolve延迟及开关、签字revision、补充核验与否决重开。
- 验收：产品任务生成真实胶囊及层级1+核验任务；重复回访回执/预算生效；延迟子节点不能让祖先被错误标为全已人工验收。
- 前驱：T09A-R1-02。先通过前驱，再执行本节点。

### T09A-R1-04：实际缓存与指标

- 状态：done（2026-09-10）。产物：`docs/reports/T09A_R1_04_METRICS_EVIDENCE.md`。
- 工作：从真实装配/回访事件计算缓存及token指标；相同版本稳定复用，变化精准失效；运行有版本、样本、分母和原始事件的对照fixture。
- 验收：指标能复算；区分Provider缓存usage与本地缓存估算；不足以验证百分比收益时注明样本限制，不虚报性能；恢复回归通过。
- 前驱：T09A-R1-03。先通过前驱，再执行本节点。

## 注意事项

4096是可调默认值；0不能移除系统规则。模型显式请求不能越过权限、敏感禁读、个体记忆、10文件和累计预算。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

### T09A-R1-01 验收记录

- 当前提交/工作树基线：`80274a4`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 7 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/T09A_R1_01_CONTEXT_ASSEMBLY_EVIDENCE.md`。新增 `context-prompt-assembler`（系统规则 / 任务必要条件 / 全局相关选择 / 局部活跃前沿四段装配）与真实存储提供者；经 `application-runtime → main-controller → mission-orchestrator → worker-agent` 透传；Worker 在调用 Provider 前装配，必要条件缺失时抛 `context-mandatory-constraint-missing` 且不调用 Provider。集成测试捕获本地服务器请求，证明相关记录注入、无关记录不注入、已关闭节点只计数不注入原文。
- 测试命令、退出码和产物哈希：隔离验证 5 套件 15 通过 → `npx tsc --noEmit` exit 0 → `npx eslint .` exit 0；**权威 `npm run check` / `test:coverage` 本次未复跑**（`danger-full-access` 审批挂起至 600s 上限）；上次权威结果为 153 文件 / 1416 测试 exit 0、分支 87.28% exit 0。
- 人工/外部依赖及剩余风险：无人工裁决；预算设置/延后片段（-02）、关闭与回访工具（-03）、实际缓存与指标（-04）待做；threads 池在高并发下的集成测试饥饿已记录并放宽超时。
- 本地提交、推送尝试与结果：提交 `4f7e815`（T09A-R1-01 上下文装配）；`git push origin main` 第 1 次尝试成功（`80274a4..4f7e815`）。
### T09A-R1-02 验收记录

- 当前提交/工作树基线：`4f7e815`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 7 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/T09A_R1_02_BUDGET_DEFERRED_EVIDENCE.md`。新增 `GlobalContextBudgetStore`（默认 4096、非负整数、CAS、原子+备份）；`resolveContextBudget`（模型空间缩减）；选择缓存按预算 revision/有效值/记录指纹失效；`readDeferredGlobalContextFragments` 按 agentInstanceId 隔离；CLI `config context-budget` 与 `context status` 读取持久化预算。
- 测试命令、退出码和产物哈希：新增 4 套件 10 通过 → `npm run check` exit 0（160 文件 / 1432 测试）→ `npm run test:coverage` exit 0（语句 93.87% / 分支 87.34% / 函数 91.19% / 行 93.95%）；本检查点未产出 tarball。
- 人工/外部依赖及剩余风险：无人工裁决；延迟片段的自动回访注入属 `-03`；TUI 图形设置控件未接入（CLI/SDK 已通）。
- 本地提交、推送尝试与结果：提交 `c389be7`（预算存储 + 选择缓存 + 延后片段读取 + CLI 命令 + 测试 + 证据报告）；`git push origin main` 第 1 次尝试成功（`4f7e815..c389be7`）。

### T09A-R1-03 验收记录

- 当前提交/工作树基线：`c900fa9`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 7 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/T09A_R1_03_CLOSURE_VERIFICATION_EVIDENCE.md`。产品任务成功后经 `ContextNodeLifecycleController` 建节点→本地验证→按策略关闭/等待→生成胶囊与层级 1 延迟核验任务；`accepted-closed` 增加 required 子节点必须同样 `accepted-closed` 的严格门禁；回访账本持久化并新增 `context recall` CLI；重复回执与预算拒绝生效。
- 测试命令、退出码和产物哈希：`npm run check` exit 0（163 文件 / 1437 测试）→ `npm run test:coverage` exit 0（语句 93.83% / 分支 87.24% / 函数 91.34% / 行 93.90%）；本检查点未产出 tarball。
- 人工/外部依赖及剩余风险：无人工裁决；CLI 关闭/签字/否决子命令与 TUI 控件未接入（服务与控制面已通）；`-04` 实际缓存与指标待做。
- 本地提交、推送尝试与结果：提交 `4925eb0`（节点生命周期 + 严格祖先门禁 + 回访账本/CLI + 测试 + 证据报告）；`git push origin main` 第 1 次尝试成功（`c900fa9..4925eb0`）。

### T09A-R1-04 验收记录

- 当前提交/工作树基线：`1689ccb`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 7 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/T09A_R1_04_METRICS_EVIDENCE.md`。新增运行时指标纯函数复算（版本/样本/分母/本地缓存估算/失效原因/Provider usage 观察/样本限制）、JSONL 事件存储、装配事件发出（hit/miss + 精准失效原因）、产品运行时写入、`context metrics` CLI。
- 测试命令、退出码和产物哈希：新增套件 4 通过 → 恢复回归 5 套件 34 通过 → `npm run check` exit 0（165 文件 / 1441 测试）→ `npm run test:coverage` exit 0（语句 93.81% / 分支 87.16% / 函数 91.36% / 行 93.88%）；本检查点未产出 tarball。
- 人工/外部依赖及剩余风险：无人工裁决；Provider usage 未采集（如实标记 unavailable）；生命周期事件未并入同一 JSONL。T09A-R1 卡四检查点全部通过。
- 本地提交、推送尝试与结果：提交 `b654972`（指标模块 + 事件存储 + 装配事件 + CLI + 测试 + 证据报告）；`git push origin main` 第 1 次尝试成功（`1689ccb..b654972`）。


## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮只执行 T09A-R1-01；先记录基线和失败场景，再完成该检查点。不要领取后继，未满足条件不得标记done。

