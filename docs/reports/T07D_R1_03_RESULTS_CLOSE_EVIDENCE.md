# T07D-R1-03 结果、取消与安全关闭 · 证据

> 检查点：T07D-R1-03　状态：done
> 任务卡：`docs/tasks/T07D_R1_APPLICATION_SDK_WIRING_TASK_CARD.md`；前驱：T07D-R1-02（done）
> 基线提交：`bb77141`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 行为反例（先红）

新增 `tests/core/unit/application-sdk-results-cancel.test.ts` 后首次运行 3/5 失败：
`summaryPreview` 仍为 `null`（无权威结果）、取消后查询回落为 `running`、提交失败未转稳定错误码。

## 2. 实现内容

| 文件 | 变更 |
|---|---|
| `packages/core/src/application/application-runtime.ts` | 新增 `readMissionResultSummaries(missionId)`：从 `AgentWorkArchiveStore` 的 `result` 条目读取权威执行输出；`shutdown` 先调用控制器级关闭再释放反馈进程 |
| `packages/core/src/orchestration/main-controller.ts` | 新增 `MainController.shutdown()`：取消全部在途编排并等待调度器/Worker 收敛 |
| `packages/core/src/public-sdk.ts` | 终态时捕获权威结果摘要；终态粘滞（query 不再回落）；`cancelTask` 幂等且只发一次 `task-finished`；`submitTask` 失败转 `submit-failed`；`shutdown` 等待在途轮询收敛后再释放 |
| `tests/core/unit/application-sdk-results-cancel.test.ts` | 新增 5 例 |

### 2.1 顺带修复的真实缺陷

原 `shutdown` 只停止反馈进程，不收敛在途 mission：测试清理目录后后台仍写工作存档，触发
`ENOENT ... .work-archive.json.<pid>.<uuid>.tmp` 的 unhandled rejection（`npm run check` 因此一度 exit 1）。
按本检查点“shutdown 等在途调用收敛”要求，加入 `MainController.shutdown()` 后复跑门禁无 unhandled error。

## 3. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯 | 1 | 3 failed / 2 passed |
| 绿灯（4 个 SDK 套件） | 0 | 20 通过 |
| `npx tsc --noEmit` | **0** | 无类型错误 |
| `npm run check` | **0** | 148 文件 / 1397 测试全通过，无 unhandled error |
| `npm run test:coverage` | **0** | 语句 94.10% / 分支 87.33% / 函数 91.55% / 行 94.18% |
| 隔离消费者（包 exports） | **0** | 见 §4 |

## 4. 隔离消费者证据

- tarball SHA-256 `FF0314EE6517B849CE62AC0EDDDC2B8BC95FDB1AE7B204F16AA1EAE29A476A63`。
- 输出：`finalStatus=done`、`summaryPreview="（mock 执行器）"`（来自 Agent 工作存档 result 条目，非占位）、
  `closedAfterShutdown=true`、`stateDirectoryPresent=true`、`missionCount=2`；
  在途任务后立即 `shutdown()`，进程 300ms 后干净退出（exit 0）且 stderr 无错误。

## 5. 终态与事件语义

| 情形 | 行为 |
|---|---|
| 成功 | `task-status accepted` → （`running`）→ `task-finished done`，`summaryPreview` 为权威输出 |
| 失败 | `submitTask` 阶段失败 → 拒绝 `submit-failed` 且不留下任务；执行期失败 → `task-finished failed` |
| 等待授权 | 权威状态 `blocked` → `task-status blocked`（非终态，可继续等待） |
| 取消 | `cancelTask` 幂等：首次发 `task-finished cancelled`，重复取消无事件、状态不回退 |
| 订阅 | `unsubscribe` 后不再收事件；单个回调抛错不影响其他订阅者 |
| 关闭 | 停止监视器、等待在途轮询、取消在途 mission、释放运行时；关闭后调用报 `application-closed` |

## 6. 未满足项与后继

- `T07D-R1-04`：CLI/TUI 改用同一公共应用服务；把 tarball 消费者行为测试纳入仓库测试（当前为手工隔离消费者证据）。
- 跨进程 SDK 会话/结果恢复（重启后按 taskIdentifier 查询）不在本检查点范围，属 T12A-R1。
- 真实 Provider 与人工体验不在本检查点范围；平台仅 Windows。
