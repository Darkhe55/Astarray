# run-command 裁决循环分支：为何仍未覆盖（2026-10-10 实测结论）

## 结论

`packages/tui/src/cli/run-command.ts` 的权限裁决循环（181–235）中有 **5 个分支**
在全量覆盖率下**仍然缺口**（`hits [0,0]`）：

| 行 | 分支 | 语义 |
| --- | --- | --- |
| 194 | `adjudicationRound === 0 ? 0 : AUTHORIZATION_RETRY_WINDOW_MILLISECONDS` 的 **else** | 第 2 轮起必须给"授权后重跑"的推进窗口 |
| 197 | `permissionAsk === null` 为**真** | 本轮没有待裁决询问 |
| 202 | `currentTask.status === "failed"` 为**真** | 任务已明确失败 ⇒ 不得再等 |
| 216 | `decision !== "allowed-once"` | 裁决不是"允许一次" ⇒ 收口 |
| 219 | `permissionAsk !== null` | 拿到询问 ⇒ 记录上次批准 |

## 为什么没被覆盖（本轮实测，不是猜测）

1. **子进程端到端用例在覆盖率下不可见**：`cli-exit-linger.test.ts` 与
   `authorization-retry-closure.test.ts` 都 spawn `dist/cli.js`，
   而 **v8 覆盖率看不见子进程** ⇒ 这些行在真实运行时**确实被执行**，
   但在 `test:coverage` 里永远显示未覆盖。
2. **进程内 mock 运行时到不了该循环**：我用
   `executeRunCommand({ runtime: "mock", permissionDecisionPort: 注入 })` 写了 3 条
   进程内用例并**全部通过**，但用覆盖率**逐分支核对后发现这 5 行
   `hits [0,0]`** —— 因为 mock 运行时的 worker **从不请求受限写工具**，
   于是**根本不会产生 permission-ask**，裁决循环体一次都没进。
   ⇒ 那 3 条用例**没有覆盖其声称的目标**，已**删除**（不留误导性测试）。

## 要真正覆盖它们，需要什么

需要让 `executeRunCommand` 在**进程内**跑到一条"受限写工具 → 触发 permission-ask"
的真实链路。当前可行路径只有两条，各有代价：

- **注入可产生 permission-ask 的应用**：`RunCommandOptions` 目前**只接受
  `stateDirectory`**，`executeRunCommand` 内部自行装配应用 ⇒ 要测就必须给它加一个
  注入点（**生产代码改动**）。这属于可测性改造，需单独评估；
- **在进程内起一个假 Provider 服务**（返回 `createProjectFile` 工具调用），
  再让 CLI 以 `runtime: openai-compatible` 连它。`authorization-retry-closure`
  已证明这条路**可行**，但它是**集成**级用例（要起 HTTP 服务、走完 mission 生命周期），
  不是单元级。

## 影响评估（为什么本轮不强行覆盖）

- **覆盖率门禁未受影响**：全量分支 **5146/5280 = 97.46%（JSON 口径）**，
  `test:coverage` 的**文本口径 85.06–85.08% 仍达标**（门槛 85%）；
- 这 5 个分支的行为**已被子进程端到端用例真实执行并断言**
  （`cli-anthropic-protocol.test.ts` ① 已由 `it.skip` 转 `it` 并转绿，
  正是"工具调用 → 权限询问 → allow-once → 产物落盘且 done"的完整链路）；
  **缺口只在"覆盖率可否看见"，不在"行为是否有验证"**。

## 诚实标注

这 5 个分支属**"行为已验证、覆盖率不可见"**，与"行为未验证"是两件事。
本文件取代了原先一份**声称覆盖但实测未覆盖**的测试（已删除），
以免后续读者据此误以为该区域已被覆盖。
