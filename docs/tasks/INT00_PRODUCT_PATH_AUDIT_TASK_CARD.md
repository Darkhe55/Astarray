# INT-00：产品执行路径审计与验收纠偏

> 状态：pending
> 创建日期：2026-09-10
> 类型：基础审计；高风险工作按检查点执行
> 来源：用户授权布置；本文件为Agent派生实施方案，运行态节点默认层级1或以下，不冒充用户层级0
> 前驱：无；本批首卡

## 执行契约

必须先读取 [本批实施顺序与共同验收规则](./PRODUCT_INTEGRATION_ROLLOUT.md) 及 AGENTS.md 指定的四份治理文档。该共同文件是本卡的一部分，包含批次、测试、证据、安装、Git及停止条件。原任务卡的未满足验收要求继续有效。

## 目标与范围

以当前提交及未提交差异为基线，为 CLI/TUI/SDK、Provider、上下文、恢复和 GUI/桥接建立入口到实际执行的调用证据链。只审计和纠正文档；代码修复交对应返修卡。

## 检查点

### INT-00-01：入口与构建基线

- 状态：done（2026-09-10）。产物：`docs/reports/INT00_PRODUCT_PATH_MATRIX.md`。
- 工作：完整读取治理文档；记录 commit、工作树差异、包版本、可执行命令和依赖现状；复核 public-sdk、run/bootstrap、context/recover、包导出及所有相关生产调用点。
- 验收：输出 docs/reports/INT00_PRODUCT_PATH_MATRIX.md；每个结论有文件/符号/调用方，缺失接线有搜索范围和反例。
- 前驱：本卡前驱。先通过前驱，再执行本节点。

### INT-00-02：行为证据

- 状态：done（2026-09-10）。产物：`docs/reports/INT00_BEHAVIOR_EVIDENCE.md`。
- 工作：通过已有离线环境执行最小 CLI 和隔离 SDK 消费场景；检查 submit 是否触发调度、accepted 是否误报 finished、结果是否来自执行、关闭是否回收资源；检查上下文/恢复能力是否到达产品入口。
- 验收：记录命令、退出码、产物、真实事件顺序；只读诊断不安装新资源，不触发真实付费请求。
- 前驱：INT-00-01。先通过前驱，再执行本节点。

### INT-00-03：状态与依赖纠偏

- 状态：done（2026-09-10）。产物：`docs/reports/INT00_STATUS_RECONCILIATION.md`。
- 工作：逐项区分契约、实现、接线、离线端到端、真实服务、人工体验证据；更新旧卡顶部范围说明及 PLAN_STATUS/README/DELIVERY_REPORT 中冲突状态，保留历史证据。
- 验收：T07D-06/07/08、T09A、T12A 未满足项映射到明确返修检查点；GUI 旧依赖不得形成循环；真实服务未验证不得写已支持。
- 前驱：INT-00-02。先通过前驱，再执行本节点。

## 注意事项

SDK可导入不代表任务执行；无HTTP监听不能单独证明没有MCP；覆盖率达标不代表执行路径接通。不得重新实现已有模块来掩盖缺口。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

### INT-00-01 验收记录

- 当前提交/工作树基线：`8ebdaa87b72754f4c40ecab9cbf9dadb8249e6cc`（与 `origin/main` 同点）；工作树 13 项未提交，全部为用户并行的产品接线文档（3 M + 10 个新卡），本检查点未改动产品代码。
- 本检查点实现与入口证据：`docs/reports/INT00_PRODUCT_PATH_MATRIX.md` 给出 8 条产品路径的入口→装配→执行结论，逐条附文件:符号、搜索范围与反例。关键结论：Public SDK facade 未接控制器（`public-sdk.ts:48,100-116`）、`run` 拒绝非 mock 且 bootstrap 固定 `ScriptedRuntime`（`run-command.ts:31-36`、`bootstrap.ts:379-391`）、上下文组件未进编排（`main-controller.ts` 0 命中）、`recover` 未在 `cli.tsx` 注册且为桩（`commands.ts:1805-1880`）、桥接仅契约。
- 测试命令、退出码和产物哈希：本检查点为文档/链路审计，未新增测试。已执行只读诊断：`git rev-parse HEAD`、`git status --porcelain`、`node -e require(package.json)`、`npm audit --audit-level=high`（exit 0）、`node --input-type=module` 调用 `dist/public-sdk.js`（输出 `submitResult.status=accepted`、`readPublicResult=null`、事件 `task-finished/accepted`）。未生成 tarball，故无产物哈希。
- 人工/外部依赖及剩余风险：无需人工裁决；剩余风险是真实 Provider/真实服务无凭据（`T07D-R2-04` 预期 blocked）、GUI 仅占位、Linux/macOS 与 Node 20 未验证。行为级证据待 INT-00-02。
- 本地提交、推送尝试与结果：提交 `8aca696`（新增 `docs/reports/INT00_PRODUCT_PATH_MATRIX.md` + 本卡验收记录）；`git push origin main` 第 1 次尝试即成功（`8ebdaa8..8aca696`）。后续补记：`d42fccc` 记录 INT-00-01 提交/推送结果并已推送。
### INT-00-02 验收记录

- 当前提交/工作树基线：`d42fccc`（与 `origin/main` 同点）；工作树仍为用户并行的 3 M + 10 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/INT00_BEHAVIOR_EVIDENCE.md` 记录 9 组命令的退出码与输出。要点：最小 CLI `run` exit 0（`mission-f94ef028` / `status done`，磁盘生成 `summary.json`、`task-chain.json`、worker `work-archive.json`、`backup-vault/manifest.json`）；非 mock 运行时 exit 2；`recover list` exit 1（命令未注册）；`context status` exit 0 但**完成任务后仍 `graphIdentifier: null`**；隔离 SDK 消费 `accepted` / `readPublicResult=null` / `stateDirCreated=False`；`shutdown()` 后调用抛 `SDK 已关闭`。
- 测试命令、退出码和产物哈希：本检查点为只读行为取证，未新增测试，未安装新资源。tarball `.tmp/int00-02/sdk/astarray-0.1.0.tgz`，SHA-256 `A2CD54F22B4943AFCF2C29982200DE4A0E5FF6E6B28B2285183BF4F5C7137D34`。
- 人工/外部依赖及剩余风险：无人工裁决；未连接真实 Provider（离线仅 mock）；Windows-only；多进程并发、真实服务兼容与人工体验分别属 `T07D-R2-04` / `E2E-01`。
- 本地提交、推送尝试与结果：提交 `a88b2c3`（`docs/reports/INT00_BEHAVIOR_EVIDENCE.md` + 本卡记录）；`git push origin main` 第 1 次尝试成功（`d42fccc..a88b2c3`）。后续补记：`c3025bd`。
### INT-00-03 验收记录

- 当前提交/工作树基线：`c3025bd`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 10 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/INT00_STATUS_RECONCILIATION.md` 给出六类证据分级（契约/实现/接线/离线端到端/真实服务/人工体验）、未满足项映射与 GUI 依赖核查。纠偏动作：`PLAN_STATUS.md` 将 `T09A`、`T12A` 由 `done` 改为 `re-verifying`（`T07D` 保留 `re-verifying` 并标注 SDK/Provider 缺口）；T07D/T09A/T12A/GUI-01 旧卡顶部加范围说明（历史 `done` 仅模块级，产品接线未满足）；`README.md` 当前限制与 `DELIVERY_REPORT.md` §11 记录产品接线缺口。
- 测试命令、退出码和产物哈希：本检查点为文档纠偏，未新增测试、未改动产品代码；沿用 INT-00-01/02 的命令证据（`npm audit` exit 0、CLI `run` exit 0、`recover list` exit 1、tarball SHA-256 `A2CD54F2…7D34`）。
- 人工/外部依赖及剩余风险：无人工裁决；真实服务/人工体验/跨平台仍无证据，不得写为已支持。
- 本地提交、推送尝试与结果：本检查点提交（新增纠偏报告 + 旧卡范围说明 + PLAN_STATUS/README/DELIVERY_REPORT 纠偏）；`git push origin main` 按 AGENTS.md 规则尝试（≤5 次）。



## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮只执行 INT-00-01；先记录基线和失败场景，再完成该检查点。不要领取后继，未满足条件不得标记done。

