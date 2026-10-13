# 反馈进程重复 shutdown：5 秒滞留的真因与修复（2026-10-13）

> 关联：`docs/reports/SESSION_HANDOFF_2026-10-10.md` §3②「超时型抖动」
> （`tests/tui/unit/run-command-gaps.test.ts` 曾 `Test timed out in 60000ms`）。
> 结论：**该用例的超时预算被一段**结构性固定等待**吃掉**，不是玄学抖动。
> 修复提交：`5f0ef84`。基线：`HEAD == origin/main == 5f0ef84`。

## 1. 为什么值得查（前几轮的判断错在哪）

前几轮把它记为"负载抖动 / 未复现"，理由是隔离复跑全绿。这个推理有缺口：
**隔离复跑全绿只说明"在无负载时够快"，不能说明"没有结构性浪费"。**
本轮换成**分解耗时**（先量单用例，再量被调用函数），一次就定位到确定性的 5 秒。

## 2. 定位过程（每步都有实测数字）

### 2.1 先排除"真 mission 等待"（原假设）

文件头注释原以为慢在真实 mission 链路。逐用例计时后**证伪**：

| 用例 | 耗时 |
| --- | --- |
| 配置非法 → 退出码 2 | 8ms |
| run 成功：streamOutput | 234ms |
| Ponder 问答 JSON | 10ms |
| **bootstrap useFeedbackProcess:true** | **5181ms** |
| 无 `timeoutSeconds` 时等待终态 | 265ms |

⇒ 95% 的时间在**独立反馈进程**那条用例上，与 mission 等待无关。

### 2.2 再分解 bootstrap 用例（`bootstrapCli` + `shutdown`）

临时脚本（`.tmp/`，已删，不入库）实测：

```
round 1: bootstrapCli=249ms shutdown=5005ms total=5254ms
round 2: bootstrapCli=176ms shutdown=5002ms total=5178ms
round 3: bootstrapCli=245ms shutdown=5012ms total=5257ms
```

`shutdown` **恒为 5005ms** —— 恰好等于
`SHUTDOWN_GRACE_PERIOD_MILLISECONDS_DEFAULT = 5_000`。这不是"慢"，是**等满宽限期**。

### 2.3 排除子进程启动与子进程退出

- 直接 `FeedbackProcessSupervisor.start()`：**185–203ms**（8 轮，很稳）⇒ 不是启动慢；
- 子进程自身退出：`exitCode=0 signal=null`，约 **9–15ms** ⇒ 子进程退得干净。

### 2.4 找到根因：同一客户端被 shutdown 两次

`packages/core/src/application/application-runtime.ts`：

```ts
await controller.shutdown().catch(() => {});
await feedbackClient?.shutdown().catch(() => {});   // ← 第一次
await supervisor?.stop().catch(() => {});           // ← stop() 内部又 client.shutdown()：第二次
```

`FeedbackProcessSupervisor.stop()` 内部已经 `await activeClient.shutdown()` 并等待子进程退出。
而子进程在收到**第一个** `shutdown` 后即：

```ts
sendToParent({ type: "shutdownComplete", requestId });
setImmediate(() => processExit(0));
```

⇒ 子进程**已退出**，第二个请求**永远不会有应答**，客户端只能等到
`ForkFeedbackClientOptions.requestTimeoutMilliseconds`（默认 **5_000ms**）超时；
而该异常又被 `catch {}` 静默吞掉 ⇒ **不留任何日志痕迹**。

三个变体对照（真实子进程）：

| 序列 | 耗时 |
| --- | --- |
| A. `supervisor.stop()` 单次 | **8ms** |
| B. `client.shutdown()` 两次 | **5013ms** |
| C. `client.shutdown()` + `supervisor.stop()`（**与生产同序**） | **5002ms** |

A 与 C 的差就是根因。

## 3. 影响范围（不只影响测试）

1. **每个启用独立反馈进程的 CLI/SDK 收口都多滞留约 5 秒**，且被 `catch {}` 掩盖；
   `run-command.ts:152` 规定 `useFeedbackProcess: runConfig.runtime !== "mock"` ⇒
   **真实 Provider 运行（非 mock）走的就是这条路径**。
2. 该 5 秒是**固定成本**：不随任务大小变化，但会挤占调用方（含测试）的等待预算 ——
   负载下这段固定等待叠加其它开销，就可能撞上用例的 60s 上限。

## 4. 修复（根因 + 纵深防御）

| 层次 | 文件 | 改动 |
| --- | --- | --- |
| 根因 | `packages/core/src/application/application-runtime.ts` | 删除多余的 `feedbackClient?.shutdown()`；就地写明"反馈进程由 supervisor 独占收口"及原理，防止后人加回 |
| 纵深防御 | `packages/core/src/feedback-process/transport.ts` | `ForkFeedbackClient.shutdown()` 改为**幂等**：已发出过请求即直接返回，不再发注定无应答的第二个请求 |

## 5. 反例（先红后绿，两个层次各自钉住）

| 用例 | 修复前（红） | 修复后（绿） |
| --- | --- | --- |
| `tests/core/unit/feedback-client.test.ts`「重复 shutdown 不等于重复等待」 | `expected 202 to be less than 100` | 通过；并断言**只发出 1 个** shutdown 请求 |
| `tests/core/unit/feedback-supervisor.test.ts`「client.shutdown() 后再 stop()…」 | `expected 5014 to be less than 2000` | 通过（真实子进程 + 生产默认 5_000ms 请求超时） |

## 6. 实测收益

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| `run-command-gaps` bootstrap 用例 | 5181ms | **184ms**（约 **28×**） |
| 该文件 tests 汇总 | 5.70s | **845ms** |
| 该文件 Duration | 7.20s | **3.27s** |
| `feedback-supervisor.test.ts` 整体 | 13.0s | **8.2s** |

## 7. 门禁（真实退出码，修复后）

| 门禁 | 退出码 | 证据 |
| --- | --- | --- |
| 两个目标测试文件 | **0** | 18 passed |
| `npm run check` | **0** | **406 文件 / 3047 用例通过、skipped 0** |
| `npm run test:coverage` | **0** | stmts 92.58 ／ **branch 85.23** ／ funcs 93.03 ／ lines 92.6 |
| `npm run typecheck` / `lint` / `build` | **0** | — |
| 修复进入产物 | — | `hasRequestedShutdown` 命中 `dist/chunk-YRIW6SVC.js`；`feedbackClient?.shutdown` 在 `dist` 中**已不存在** |

## 8. 如实保留（不夸大）

- 本修复**只**消除了这一条**确定性**的 5 秒固定等待；
  **不能据此宣布"全量门禁抖动已消除"** —— 既往 8 次全量实测的 3 次失败中，
  失败点分别为 `anthropic-messages-runtime`、`completion-gate-counterexamples`、
  `reliability-r4-ledger-concurrency`，与本文件不同（见
  `docs/reports/FLAKY_TEST_LOCATION_2026-10-12.md`）。
  本轮的重复全量实测结果见 §9。
- `FeedbackProcessSupervisor` 未向客户端透传 `requestTimeoutMilliseconds`，
  故 supervisor 层反例使用生产默认 5_000ms 并断言 `< 2_000ms`（而非把超时调小来"造绿"）。
- **后续补充**：本轮最终定位到**三层**互相独立的原因 ——
  ① 反馈进程重复 shutdown 白等 5s（本节，已修）；
  ② vitest **默认 5_000ms** 对真子进程用例不足（§10，已修一部分）；
  ③ **夹具自配 20s provider 超时**（§14，已修）。
  未修完的部分一律保留在各自小节，未用文字覆盖。

## 9. 修复后重复全量实测（`5f0ef84` **之后**、`dbbb4d7` 之前）

同一脚本连续 9 次（`4 + 5` 两批），每次完整输出落盘：

| 运行 | 退出码 | 失败点 |
| --- | --- | --- |
| 1 | 0 | — |
| 2 | 1 | `toolkit01-tool-package-cli.test.ts` ③ **`Test timed out in 5000ms`** |
| 3 | 1 | `reliability-r4-ledger-concurrency.test.ts` ④ **超时** + `authorization-retry-closure` ① 产品侧 20s Provider 超时 |
| 4 | 0 | — |
| 5 | 0 | — |
| 6 | 1 | `toolkit01-tool-package-cli.test.ts` ③ **超时** |
| 7 | 0 | — |
| 8 | 1 | `reliability-r4-ledger-concurrency.test.ts` ④ **超时** |
| 9 | 0 | — |

⇒ **失败 4/9 ≈ 44%，全部是 `Test timed out in 5000ms`** ⇒ 说明 `5f0ef84`
（反馈进程 5 秒滞留）**不是**全量抖动的主因；真正的系统性原因是
**这些文件沿用了 vitest 默认 5_000ms**（详见 §10）。

## 10. 真正的系统性根因：大量"真子进程"用例沿用默认 5_000ms

### 10.1 审计（客观脚本，非抽样感觉）

扫描 `tests/**/*.test.ts`：**403** 个文件，其中
**21 个使用子进程（`spawn`/`execFile`/`child_process`）却完全没有任何 `testTimeout`**；
而仓库另有 **33 个文件**已经按耗时显式设置预算（20s–240s）——
**"显式给预算"才是本仓既有约定**，这 21 个是遗漏。

### 10.2 这 21 个文件中**隔离**耗时最长的（≥1.5s，全部 >30% 预算）

| 测量用例 | 隔离耗时 |
| --- | --- |
| `local-preservation-restore.test.ts`「原仓库不可用仍可恢复…」 | **4168ms** |
| `local-preservation.test.ts`「同一提交与工作树指纹复用已验证快照」 | **3449ms** |
| `local-preservation-product-entry.test.ts`「网络失败联网接线…」 | **3420ms** |
| `preserve-cli.test.ts`「create → status → show → restore」 | **3368ms** |
| `local-preservation.test.ts`「普通仓库：引用归档…」 | **3127ms** |
| `git-defensive-branches.test.ts`「验证器：diff-tree/log 命令失败」 | **2976ms** |
| `smart01-instruction-cli-entry.test.ts`「dist/cli.js 与 SDK 跨进程共享」 | **2833ms** |
| `git-defensive-branches.test.ts`「集成分支 tip 解析失败」 | **2607ms** |
| `local-preservation-restore.test.ts`「无提交仓库恢复到新目录」 | **2529ms** |

**4168ms 距 5000ms 只剩 20%**。全量门禁并发下实测的争用系数约 **1.4–3×**
（如 `toolkit01` ③ 隔离 1438ms → 满载 >5000ms），故上表每一条在满载时都可能翻红。

### 10.3 处置

1. **本轮已修**（`dbbb4d7`）：`toolkit01-tool-package-cli.test.ts` 与
   `reliability-r4-ledger-concurrency.test.ts` 各补 `vi.setConfig({ testTimeout: 60_000 })`
   —— 这两个文件是 9 次实测中**实际红过**的。
2. **尚未处理（如实登记）**：其余 **19 个**"子进程但无预算"的文件。
   它们属**同一系统性缺口**，正确做法是**一次性**统一处置（在 `vitest.config.ts`
   设定全局 `testTimeout`，或逐文件补预算），而不是每次红一个补一个。
   这需要与用户确认取舍：全局放宽会同时改变**全部** 403 个文件的默认上限。

**因此本节结论不写成"抖动已修复"** —— 只写成
"已定位主因是默认 5_000ms 对真子进程用例不足，并已修掉其中 2 个实际翻红者；
剩余 19 个同类文件待统一处置"。

## 11. `dbbb4d7` 之后的累积实测（截至本轮）

同一脚本继续连跑，**每次完整输出落盘**：

| 批次 | 次数 | 结果 |
| --- | --- | --- |
| `dbbb4d7` 之后第 1 批（`.tmp/flake3`） | 6 | **6/6 全绿**（406 文件 / 3047 用例，timedOut=0） |
| `dbbb4d7` 之后第 2 批（`.tmp/flake4`） | 8 | **8/8 全绿**（同上，timedOut=0） |

⇒ **`dbbb4d7` 之后连续 14 次全量实测全部 exit 0、timedOut=0**；
而修复前同一脚本为 **4/9 失败（≈44%）**。

**但仍须注意两点（不夸大）**：

1. 这**不足以证明**"抖动已消除" —— `git-defensive-branches` 在修复前的批次里
   红过、在修复后的批次里全绿，而它**并未被本次改动**（其隔离最长用例 2976ms）；
   这正好说明**批次方差真实存在**，也说明剩余 19 个文件仍是暴露面。
2. 统计功效有限：14 次全绿若真实失败率为 5%，出现全绿的概率仍有 ~49%
   ⇒ 只能说"**主因已消除且未再复现**"，不能说"失败率为 0"。

## 12. 待用户决策的一项（不擅自扩大）

其余 19 个"子进程但无 `testTimeout`"文件的统一处置方式有两条，**各有取舍**：

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| **A. 全局** | 在 `vitest.config.ts` 设 `testTimeout: 60_000` | 一行修完 403 个文件；但会把**全部**文件的默认上限从 5s 提到 60s |
| **B. 逐文件** | 只给这 19 个文件各加 `vi.setConfig({ testTimeout: 60_000 })` | 改动范围精确、每处可附实测理由；但要改 19 个文件 |

**本轮未擅自选择**：两种都会改变门禁语义（虽然方向与产品行为无关），
且 AGENTS.md 要求"不得用无依据地放大超时掩盖竞态"——
本轮已用实测把"配置不足"与"竞态"区分开，故该决策留待用户确认。

## 13. 顺带更正的一处过时注释

`tests/tui/integration/authorization-retry-closure.test.ts` 的 describe 块内
两段 2026-10-02 旧注释仍写着"本用例继续以 `it.skip` 标记 / 故保持 it.skip"，
而代码**早已**是 `it(...)` 且有真实断言 —— 会让人误以为该正向闭环未被门禁覆盖。
本轮就地更正为与代码一致，并写明该用例剩余的真实风险（负载下撞产品 20s Provider 超时）。
**该风险已在 §14 修复（提高夹具预算）。**

## 14. 第二层根因：**夹具自配的 20s provider 超时**（已修，`5052feb`）

### 14.1 怎么发现的（以及一次我自己的方法论失误）

`b2e7f20` 之后我在**干净环境**重跑 `npm run check`，仍失败 1 例，原文：

```
astarray: [需要用户] 任务 T-001 失败：Provider 请求失败或超时（20000ms）（状态：运行时异常终止）
```

**注意**：此前我曾得到"26 文件失败"的"结果"，那是**我自己把 `npm run check`
与另一个全量 `npm run test` 并发跑**造成的（两个 406 文件套件争用），
叠加 `%TEMP%` 下已累积 **6260 个** `astarray-*` 残留目录
（即文档已记载的 `EPERM rename` 诱因）。处置：
1. `job_kill` 中止并发作业 → 确认无 node 进程残留；
2. 清理 6260 个目录（`removed=6260 failed=0`，只匹配 `astarray-*`）；
3. **独占环境**重跑，才得到真实结果（405/406）。

⇒ **教训：门禁实测必须独占环境；并发跑同一套件的结果不可用于判定。**

### 14.2 根因

使用 CLI 夹具的用例**自己**传 `--provider-request-timeout-seconds 20` +
`--timeout-seconds 40`，而**产品默认是 30s**（`provider-runtime-registry.ts:196`）。
满载下本地假 SSE 服务把响应拖过 20s ⇒ **产品按自己的超时**把任务判失败
（`blocked`/`failed`），用例断言随之失败。

**这与 §10 是两个不同层次**：§10 撞的是 **vitest 的 5_000ms 默认**；
本节撞的是**产品自带的 20s**。两者都必须分别处置。

### 14.3 修复（只改夹具数字）

| 文件 | provider | run |
| --- | --- | --- |
| `cli-exit-linger.test.ts`（2 处） | 20 → **120** | 40 → **180** |
| `cli-anthropic-protocol.test.ts` | 20 → **120** | 40 → **180** |
| `authorization-retry-closure.test.ts` | 20 → **120** | 40 → **180** |
| `artifact-presence-cli.test.ts` | 30 → **120** | 8 → **180** |
| `gui02-01-cli-permission-ask-registration.test.ts` | 20 → **120** | 40 → **180** |

另给最后一个文件补 `vi.setConfig({ testTimeout: 240_000 })` —— 它此前**从未设置**
框架预算（默认 5_000ms），却自配 `--timeout-seconds 180`，
即**框架预算比它自己的夹具预算还短**。
`permission-ask-timing.test.ts` 有意用 10s 测**截止行为**，**未改动**。

### 14.4 仍未处理（如实）

- **每次全量运行仍残留约 41 个 `astarray-*` 目录**（清理泄漏真实存在，未修）；
- 其余 11 个"子进程但无 `testTimeout`"文件隔离 <1.5s，未纳入；
- 全局 `testTimeout` 方案仍待用户决策（§12）。


