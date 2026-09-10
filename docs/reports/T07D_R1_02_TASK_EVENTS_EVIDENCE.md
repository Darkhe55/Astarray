# T07D-R1-02 真实提交和事件 · 证据

> 检查点：T07D-R1-02　状态：done
> 任务卡：`docs/tasks/T07D_R1_APPLICATION_SDK_WIRING_TASK_CARD.md`；前驱：T07D-R1-01（done）
> 基线提交：`95b11c8`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 行为反例（先红）

新增 `tests/core/unit/application-sdk-task-events.test.ts` 后首次运行 3/4 失败：
无 `task-finished` 事件（等待超时）、幂等键未生效、blocked 事件未由权威状态驱动。

## 2. 实现内容（`packages/core/src/public-sdk.ts`）

- `submitTask` 增加 `idempotencyKey`：同一会话内相同键返回既有任务与同一 `missionIdentifier`，不重复执行；不同会话各自执行（会话隔离）。
- 权威状态监视器：`startTaskMonitor` 按间隔轮询 `controller.queryMissionStatus`，
  状态变化时发 `task-status`（`running` / `blocked`），仅在终态（`done` / `failed` / `cancelled`）发一次 `task-finished`；
  轮询异常保守映射为 `blocked`（不谎报完成）。
- `cancelTask` 停止监视器、委托取消并发出 `task-finished cancelled`；`shutdown` 清理全部监视器、幂等表与订阅。
- `accepted` 只在 `task-status` 中发出，不再冒充 `task-finished`。

## 3. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯：`npx vitest run ... tests/core/unit/application-sdk-task-events.test.ts` | 1 | 3 failed / 1 passed（事件与幂等缺失） |
| 绿灯（同文件 + 生命周期 + public-sdk） | 0 | 15 通过 |
| `npx tsc --noEmit` | **0** | 无类型错误 |
| `npm run check` | **0** | 147 文件 / 1392 测试全通过 |
| `npm run test:coverage` | **0** | 语句 94.10% / 分支 87.43% / 函数 91.70% / 行 94.17% |
| 隔离消费者（包 exports） | **0** | 见 §4 |

## 4. 隔离消费者证据（tarball 安装到临时 node_modules）

- tarball SHA-256 `BADEF54CE3A29A8BB84D3957F4797F9A4C1FAB4BFAD890AA23B22BC40B6F1C3F`。
- 输出要点：`duplicateMissionMatches=true`（同幂等键同 mission）、`sessionsIsolated=true`（两会话 mission 不同）、
  `acceptedBeforeFinished=true`、`finishedEvents=[done, done]`（两个真实 mission 各一次）、
  `missionCount=2`（重复请求未创建第三个 mission）、`finalStatus=done`、`closedAfterShutdown=true`。

## 5. 事件语义（本检查点冻结）

| 状态 | 事件 | 说明 |
|---|---|---|
| `accepted` | `task-status` | 提交委托成功后立即发出 |
| `running` | `task-status` | 权威状态首次非 accepted |
| `blocked` | `task-status` | 非终态，可继续等待或裁决（不提前 finished） |
| `done` / `failed` / `cancelled` | `task-finished` | 仅一次，随后停止监视器 |

## 6. 未满足项与后继

- `T07D-R1-03`：权威结果存储（`summaryPreview` 仍为占位）、错误传播、关闭时在途收敛、订阅回调异常隔离已有初步实现待补测。
- `T07D-R1-04`：CLI/TUI 改用同一公共应用服务；tarball 消费者行为测试纳入仓库测试而非仅手工诊断。
- 真实 Provider 与人工体验不在本检查点范围；平台仅 Windows。
