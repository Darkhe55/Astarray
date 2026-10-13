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
