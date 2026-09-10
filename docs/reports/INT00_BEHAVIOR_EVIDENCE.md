# INT-00-02 行为证据

> 检查点：INT-00-02（行为证据）　状态：done
> 任务卡：`docs/tasks/INT00_PRODUCT_PATH_AUDIT_TASK_CARD.md`；共同契约：`docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md`
> 日期：2026-09-10；基线提交：`d42fccc`；隔离目录：`.tmp/int00-02/`
> 约束遵守：只读诊断，未安装新资源（tarball 由本仓库 `npm pack` 生成并本地解包），未触发真实付费请求，未修改产品代码。

## 1. 命令、退出码与关键输出

| # | 场景 | 命令（工作目录） | 退出码 | 关键输出 |
|---|---|---|---|---|
| 1 | 最小 CLI 任务 | `node <repo>/dist/cli.js run "INT00 behavior probe" --runtime mock --json`（`.tmp/int00-02/cli`） | **0** | `{"missionId":"mission-f94ef028","mode":"assist","status":"done","prompt":"INT00 behavior probe"}` |
| 2 | 状态快照 | `... status mission-f94ef028 --json`（同目录） | **0** | `T-001` 任务 `status: done`，`assignedAgentId: worker:mission-f94ef028:T-001` |
| 3 | 非 mock 运行时 | `... run "probe" --runtime openai-compatible --json` | **2** | stderr：`astarray: --runtime openai-compatible 尚未支持（v0.1 仅 mock）` |
| 4 | 恢复命令 | `... recover list --json` | **1** | stderr：`error: unknown option '--json'`（`recover` 未注册，被当作未知命令） |
| 5 | 上下文状态（空图） | `... context status --agent agent-x --graph graph-x --json` | **0** | `graphIdentifier: null`，四类节点分组全空，`humanVerificationPolicy: block-until-verified` |
| 6 | 上下文状态缺参 | `... context status` | **2** | stderr：`context status 需要 --agent 与 --graph` |
| 7 | 完成任务后上下文 | `... context status --agent "worker:mission-f94ef028:T-001" --graph mission-f94ef028 --json`（同目录） | **0** | 仍为 `graphIdentifier: null`、全空 —— 编排未写入任何上下文图 |
| 8 | 隔离 SDK 消费 | `node consumer.mjs`（`.tmp/int00-02/sdk-consumer`，`node_modules/astarray` 由本次 tarball 解包） | **0** | `result.status="accepted"`、`readPublicResult=null`、`events=[session-status/idle, task-finished/accepted]`、`stateDirCreated=False` |
| 9 | SDK 关闭语义 | `shutdown()` 后调用 `submitTask` / `createSession` | **0** | 两者均抛 `SDK 已关闭`；facade 未持有可用控制器，无控制器资源可回收 |

## 2. 产物与哈希

- 本次打包：`.tmp/int00-02/sdk/astarray-0.1.0.tgz`，SHA-256 `A2CD54F22B4943AFCF2C29982200DE4A0E5FF6E6B28B2285183BF4F5C7137D34`。
- CLI 任务真实产物（`.tmp/int00-02/cli/.astarray/`）：`missions/mission-f94ef028/summary.json`、`task-chain.json`、`task-chain.json.bak`、`agents/worker~003amission-f94ef028~003aT-001~003a1/work-archive.json`、`backup-vault/manifest.json`。
- SDK 隔离消费：运行目录 `stateDirCreated=False`（无 `.astarray`、无 mission、无任务/存档文件），证明 `submitTask` 未触发调度或落盘。

## 3. 事件顺序与结论

- **CLI 路径正常**：`run` 直接调用主控制器并返回真实终态；随后 `status` 可读回同一 mission 的任务链与执行者身份，且磁盘有对应产物。未观察到“accepted 当 finished”问题。
- **SDK 路径未接通**：`submitTask` 只构造 DTO 并发出 `task-finished`（`status: "accepted"`）；未调用控制器、未产生 mission 或状态文件、`readPublicResult` 始终 `null`。事件名与状态语义矛盾，属**误报**。
- **关闭**：`shutdown()` 仅置 `isClosed` 并清空监听；随后调用被拒绝。由于 facade 从未持有可用控制器，所谓“回收”不涉及任何编排资源。
- **上下文未到达产品入口**：在刚完成 mission 的同一状态目录下，`context status` 仍为空，说明运行期未装配/调用上下文图、胶囊、预算或回访组件；与 INT-00-01 的静态结论（`main-controller.ts` 0 命中）一致。
- **恢复未到达产品入口**：CLI 层 `recover` 不可达（退出码 1），且 `commands.ts` 内实现为仅判类存在性的桩。

## 4. 与 INT-00-01 的差异与新发现

- 静态结论全部得到行为验证，无相反证据。
- 新增行为级反例：完成态 mission 之后上下文图仍为空；`recover` 在 CLI 解析层即失败（而非运行后失败）。
- CLI/TUI 共用的 `bootstrapCli` 路径工作正常（mock 运行时），问题集中在 SDK facade、Provider、上下文与恢复的装配缺口。

## 5. 限制与未验证

- 仅 Windows、Node v24.18.0；未做 Linux/macOS 验证。
- 未连接真实 Provider 或付费端点（离线 agent 路径仅 mock）。
- 未做多进程并发、真实服务兼容与人工体验验证（分别属 T07D-R2-04 / E2E-01）。
