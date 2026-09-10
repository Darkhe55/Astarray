# T07D-R1-04 消费者与入口一致性 · 证据

> 检查点：T07D-R1-04　状态：done（T07D-R1 卡全部检查点通过）
> 任务卡：`docs/tasks/T07D_R1_APPLICATION_SDK_WIRING_TASK_CARD.md`；前驱：T07D-R1-03（done）
> 基线提交：`8208679`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 行为反例（先红）

新增 `tests/tui/unit/cli-sdk-parity.test.ts`，首轮失败：`application.queryMission is not a function`
（SDK 无法按 mission 标识查询 CLI 创建的同一 mission 状态）。

## 2. 实现内容

| 文件 | 变更 |
|---|---|
| `packages/core/src/public-sdk.ts` | 新增 `PublicApplicationService`（`Pick<MainController, ...>`：任务状态/模式/权限组控制面）与 `PublicMissionState`；facade 实现该端口并全部委托同一控制器；新增 `queryMission(missionIdentifier)`；`PublicApplicationOptions.streamOutput` 供 headless 流式输出 |
| `packages/tui/src/ui/app.tsx` | 控制器参数类型由内部 `MainController` 改为公共 `PublicApplicationService`（TUI 不再依赖内部类型） |
| `packages/tui/src/cli/tui.tsx` | TUI 以 `AstarrayApplicationFacade` 承载运行时（装配仍由 `createApplicationRuntime` 完成），退出/信号统一走 `application.shutdown()` |
| `packages/tui/src/cli/run-command.ts` | headless `run` 改用公共应用服务：`create → createSession → submitTask → queryTask`，输出与退出码契约不变 |
| `scripts/sdk-consumer-scenario.mjs`、`scripts/verify-sdk-consumer.mjs` | 新增仓库内 tarball 消费者行为验证（安装后提交/查询/取消/关闭 + 产物断言）；`package.json` 新增 `verify:sdk-consumer` |
| `tests/tui/unit/cli-sdk-parity.test.ts` | 新增：CLI `run` 与 SDK `queryMission` 对同一 mission 的状态一致，并断言 `task-chain.json` 含 `T-001` 与 `done` |

## 3. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯（parity） | 1 | `queryMission is not a function` |
| 绿灯（parity + tui-launch + tui 组件 + public-sdk） | 0 | 24 通过 |
| `npm run check`（连续两次） | **0 / 0** | 149 文件 / 1398 测试全通过，无 unhandled error |
| `npm run test:coverage` | **0** | 语句 93.93% / 分支 87.30% / 函数 90.82% / 行 94.02% |
| `node scripts/verify-sdk-consumer.mjs <tarball>` | **0** | 消费者安装并执行通过 |

## 4. tarball 消费者行为证据

- tarball：`.tmp/t07d-r1-04/pkg/astarray-0.1.0.tgz`，SHA-256 `8FC96503E674B2E5A4D5C04695B41FF08A009F024C0C739897DCDB42264EEBC2`。
- 消费者报告：`acceptedStatus=accepted`、`idempotentMissionMatched=true`、`finalStatus=done`、
  `taskChainContainsTask=true`、`taskChainContainsDone=true`、`cancelObservedStatus=cancelled`、
  `missionCount=2`、`internalSubpathBlocked=true`（`astarray/dist/cli.js` 不在 exports）、`closedAfterShutdown=true`。
- 说明：消费者未采样到 `summaryPreview`（终端状态先于存档写入的时序），该项由 `T07D-R1-03` 单元测试与
  其隔离消费者证据断言；SDK 在后续查询会重试读取。

## 5. 一致性结论

- CLI（headless `run`）与 SDK 现在都经 `AstarrayApplicationFacade` 访问同一 `MainController`，
  parity 测试证明同一 mission 的终态在 CLI 与 SDK 两侧一致，且磁盘上有真实任务链产物。
- TUI 以同一 facade 承载运行时；`AstarrayApp` 只依赖公共 `PublicApplicationService` 端口。
- 消费者只使用包 `exports`，内部子路径（`dist/cli.js`）被 exports 阻断。

## 6. 未满足项与后继

- 真实 Provider（`T07D-R2`）、上下文运行接线（`T09A-R1`）、恢复产品接线（`T12A-R1`）与 `E2E-01` 仍未完成。
- 跨进程 SDK 会话/结果恢复属 `T12A-R1`；平台仅 Windows。
