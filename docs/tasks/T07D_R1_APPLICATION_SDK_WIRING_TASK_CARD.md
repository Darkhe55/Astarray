# T07D-R1：公共应用服务与 SDK 接线返修

> 状态：`in_progress`（T07D-R1-01 done；T07D-R1-02/03/04 pending）
> 创建日期：2026-09-10
> 类型：核心返修；高风险工作按检查点执行
> 来源：用户授权布置；本文件为Agent派生实施方案，运行态节点默认层级1或以下，不冒充用户层级0
> 前驱：INT-00

## 执行契约

必须先读取 [本批实施顺序与共同验收规则](./PRODUCT_INTEGRATION_ROLLOUT.md) 及 AGENTS.md 指定的四份治理文档。该共同文件是本卡的一部分，包含批次、测试、证据、安装、Git及停止条件。原任务卡的未满足验收要求继续有效。

## 目标与范围

复用现有核心控制器，提供可由安装包公开创建的应用服务，使 CLI/TUI/SDK 共享任务状态、权限和资源生命周期。返修 T07D-08 的未接线范围。

## 检查点

### T07D-R1-01：公共应用创建与生命周期

- 状态：done（2026-09-10）。产物：`docs/reports/T07D_R1_01_LIFECYCLE_EVIDENCE.md`。
- 工作：冻结 create/open session、submit、query、cancel、subscribe、shutdown 的公开类型与状态迁移；运行资源由应用层创建和回收，不能让消费者导入内部 MainController 或 TUI bootstrap。
- 验收：隔离消费者只从包 exports 创建应用；无会话、错误会话、已关闭会话明确失败；mock 保持离线可用。
- 前驱：本卡前驱。先通过前驱，再执行本节点。

### T07D-R1-02：真实提交和事件

- 状态：done（2026-09-10）。产物：`docs/reports/T07D_R1_02_TASK_EVENTS_EVIDENCE.md`。
- 工作：submit 委托调度并返回 accepted/任务ID；以权威执行状态驱动 started/blocked/finished；请求幂等键和会话隔离生效。
- 验收：提交后观察实际执行器调用和fixture产物；accepted不发task-finished；同请求不重复执行；两个会话结果不串线。
- 前驱：T07D-R1-01。先通过前驱，再执行本节点。

### T07D-R1-03：结果、取消与安全关闭

- 状态：pending。
- 工作：以权威结果存储替代永空 Map；接通取消、错误传播、订阅退订、资源关闭；恢复后的结果仍可查询。
- 验收：成功/失败/等待授权/取消均有稳定终态；shutdown等在途调用收敛，反馈进程和订阅释放；回调异常不破坏其他订阅者。
- 前驱：T07D-R1-02。先通过前驱，再执行本节点。

### T07D-R1-04：消费者与入口一致性

- 状态：pending。
- 工作：CLI/TUI改用同一公共应用服务；增加tarball消费者行为测试，安装后提交、查询结果、取消、关闭。
- 验收：不通过源码路径导入；比较CLI和SDK同一任务状态；验证真实文件变化而非仅字符串accepted；执行公共回归。
- 前驱：T07D-R1-03。先通过前驱，再执行本节点。

## 注意事项

不得把方法名和DTO当成实现；不得在SDK另建一套权限逻辑；同时保留自定义profile、个体身份与主Agent只读边界。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

### T07D-R1-01 验收记录

- 当前提交/工作树基线：`86923f8`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 10 个未跟踪新卡，本次未纳入暂存。
- 本检查点实现与入口证据：`docs/reports/T07D_R1_01_LIFECYCLE_EVIDENCE.md`。装配提取到 `packages/core/src/application/application-runtime.ts`（TUI bootstrap 改薄委托，对外签名不变）；`public-sdk.ts` 重写为 `create()` + 会话生命周期（create/open/list/closed）+ 真实委托（mission 标识 / 权威状态查询 / 取消，`accepted` 不发 `task-finished`）；稳定错误码 `session-not-found` / `session-already-exists` / `mode-mismatch` / `session-mismatch` / `application-closed` / `runtime-unsupported`。隔离消费者仅经包 exports 创建成功，`internalSubpathBlocked=true`、`stateDirectoryCreated=true`。
- 测试命令、退出码和产物哈希：红灯 5/5 失败（`create is not a function`）→ `npx tsc --noEmit` exit 0 → `npm run check` exit 0（146 文件 / 1388 测试）→ `npm run test:coverage` exit 0（语句 94.08% / 分支 87.32% / 函数 91.68% / 行 94.15%）→ 隔离消费者 exit 0；tarball SHA-256 `E4FAE4B3EC90FF6E31D9020150E384206225FA989064CA5E6AC4736864532344`。
- 人工/外部依赖及剩余风险：无人工裁决；真实 Provider 与人工体验不在本检查点范围。后继：`-02` 事件状态机/幂等/会话隔离结果、`-03` 结果存储与关闭收敛、`-04` CLI/TUI 切换到公共应用服务与 tarball 消费者行为测试。
- 本地提交、推送尝试与结果：提交 `dfa13d0`（应用运行时提取 + SDK 重写 + 测试 + 证据报告）；`git push origin main` 第 1 次尝试成功（`86923f8..dfa13d0`）。
### T07D-R1-02 验收记录

- 当前提交/工作树基线：`95b11c8`（与 `origin/main` 同点）；工作树含用户并行的 3 M + 10 个未跟踪新卡。
- 本检查点实现与入口证据：`docs/reports/T07D_R1_02_TASK_EVENTS_EVIDENCE.md`。`submitTask` 支持 `idempotencyKey`（同会话同键不重复执行、跨会话隔离）；新增权威状态监视器，`task-status` 承载 `accepted/running/blocked`，仅终态发一次 `task-finished`；轮询异常保守映射 `blocked`；`cancelTask`/`shutdown` 停止监视器。
- 测试命令、退出码和产物哈希：红灯 3/4 失败 → 绿灯 15 通过 → `npx tsc --noEmit` exit 0 → `npm run check` exit 0（147 文件 / 1392 测试）→ `npm run test:coverage` exit 0（分支 87.43%）→ 隔离消费者 exit 0（`duplicateMissionMatches=true`、`sessionsIsolated=true`、`missionCount=2`）；tarball SHA-256 `BADEF54CE3A29A8BB84D3957F4797F9A4C1FAB4BFAD890AA23B22BC40B6F1C3F`。
- 人工/外部依赖及剩余风险：无人工裁决；`summaryPreview` 仍为占位与关闭时在途收敛属 `-03`；CLI/TUI 切换与仓库内 tarball 消费者测试属 `-04`。
- 本地提交、推送尝试与结果：本检查点提交（见 git log 顶部）；`git push origin main` 按 AGENTS.md 规则尝试（≤5 次）。


## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮只执行 T07D-R1-01；先记录基线和失败场景，再完成该检查点。不要领取后继，未满足条件不得标记done。

