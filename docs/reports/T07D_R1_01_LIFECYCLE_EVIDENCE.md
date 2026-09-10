# T07D-R1-01 公共应用创建与生命周期 · 证据

> 检查点：T07D-R1-01　状态：done
> 任务卡：`docs/tasks/T07D_R1_APPLICATION_SDK_WIRING_TASK_CARD.md`；共同契约：`docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md`
> 前驱：INT-00（INT-00-01/02/03 全部通过，见 `docs/reports/INT00_*.md`）
> 基线提交：`86923f8`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 行为反例（先红）

新增 `tests/core/unit/application-sdk-lifecycle.test.ts` 后首次运行 5/5 失败，
证据为 `TypeError: AstarrayApplicationFacade.create is not a function`：原 facade 无应用创建入口，
`submitTask` 只返回字符串 `accepted`，不存在会话/关闭语义。

## 2. 实现内容

| 文件 | 变更 |
|---|---|
| `packages/core/src/application/application-runtime.ts` | 新增：把 CLI 装配从 TUI bootstrap 提取为 core 公共运行时 `createApplicationRuntime`；交互端口（备份删除/安装门禁）改为注入，core 不依赖 TUI/GUI |
| `packages/tui/src/cli/bootstrap.ts` | 改为薄委托：解析界面交互端口与反馈入口路径后调用 `createApplicationRuntime`，`bootstrapCli`/`CliBootstrap`/`BootstrapOptions` 对外签名不变 |
| `packages/core/src/public-sdk.ts` | 重写 facade：`create()` 从公开 exports 装配运行时；会话生命周期（create/open/list/closed）；`submitTask` 委托调度并返回 `missionIdentifier`；`queryTask` 读权威 mission 状态；`cancelTask` 委托取消；`subscribe`/`shutdown`；稳定 `PublicApplicationError.errorCode` |
| `tests/core/unit/application-sdk-lifecycle.test.ts` | 新增 5 例生命周期/失败路径测试 |
| `tests/core/unit/public-sdk.test.ts` | 改为从公开入口 `create()` 驱动；依赖方向检查改为不依赖正则转义 |

## 3. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯：`npx vitest run --configLoader runner --config .tmp/vitest.plain.mjs --pool=threads tests/core/unit/application-sdk-lifecycle.test.ts` | 1 | 5 failed（`create is not a function`） |
| `npx tsc --noEmit` | **0** | 无类型错误 |
| `npm run check` | **0** | 146 文件 / 1388 测试全通过（typecheck + lint + build + test） |
| `npm run test:coverage` | **0** | 语句 94.08% / 分支 87.32% / 函数 91.68% / 行 94.15% |
| 隔离消费者（仅包 exports） | **0** | 见 §4 |

## 4. 隔离消费者证据（tarball 安装到临时 `node_modules`）

- tarball：`.tmp/t07d-r1-01/pkg/astarray-0.1.0.tgz`，SHA-256 `E4FAE4B3EC90FF6E31D9020150E384206225FA989064CA5E6AC4736864532344`。
- 消费者只执行 `await import("astarray")`，输出：
  - `session`：`{ sessionId: "s1", mode: "assist", status: "idle" }`
  - `accepted`：`{ taskIdentifier: "t1", status: "accepted", missionIdentifier: "mission-27a936e8" }`
  - `queried`：`{ status: "running", missionIdentifier: "mission-27a936e8" }`（来自本地 mission 状态，非字符串占位）
  - `eventTypes`：`["session-status", "task-status", "session-status"]`（**无提前 `task-finished`**）
  - `stateDirectoryCreated`：`true`（应用层真实创建并回收运行目录）
  - `internalSubpathBlocked`：`true`（`astarray/dist/cli.js` 未在 exports 中，消费者无法走内部路径）
  - `closedAfterShutdown`：`true`

## 5. 失败路径（稳定公开错误码）

| 场景 | errorCode | 行为 |
|---|---|---|
| 提交到不存在的会话 | `session-not-found` | 拒绝，不创建 mission |
| `createSession` 重复 ID | `session-already-exists` | 拒绝 |
| 会话模式与应用模式不一致 | `mode-mismatch` | 拒绝 |
| 跨会话访问任务 | `session-mismatch` | 拒绝 |
| 关闭后的任何操作 | `application-closed` | 拒绝（含 `openSession`） |
| `runtime` 非 mock | `runtime-unsupported` | 拒绝（Provider 属 T07D-R2） |

## 6. 未满足项与后继

- `T07D-R1-02`：以权威执行状态驱动 started/blocked/finished；请求幂等；两个会话结果不串线（当前 `submitTask` 仅返回 accepted + mission 标识）。
- `T07D-R1-03`：以权威结果存储替代 `summaryPreview` 占位；取消/错误传播/关闭时在途收敛。
- `T07D-R1-04`：CLI/TUI 改用同一公共应用服务；tarball 消费者行为测试（提交/查询/取消/关闭）。
- 真实 Provider 与人工体验不在本检查点范围；平台仅 Windows。
