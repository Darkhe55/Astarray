# 隔离复现与"非用例级失败"的发现（2026-10-12）

> **2026-11-08（第 58 轮）续记**：本报告留下的"**需先取得确定性复现**"这一前提，
> **已按要求尝试并如实报告** —— 我**仍未**取得确定性复现，
> 但**定位到了具体触发用例与机制**，并修掉了**该测试**的触发路径。
> 详见文末 **§续记（2026-11-08）**。以下为原报告正文。

> 承接 `FLAKY_TEST_LOCATION_2026-10-12.md`（8 次全量定位到 3 个失败点）。
> 本轮做**隔离复现**，结果**推翻了"三者是同一类抖动"的初步印象**，并发现**另一类失败**。

## 1. 隔离复现结果（决定性的）

把 8 次全量中失败过的三个文件**单独反复跑，各 6 次**：

| 文件 | 6 次结果 |
| --- | --- |
| `anthropic-messages-runtime.test.ts` | **6/6 全绿** |
| `completion-gate-counterexamples.test.ts` | **6/6 全绿** |
| `reliability-r4-ledger-concurrency.test.ts` | **6/6 全绿** |

⇒ **18/18 全绿**。三者**单独跑都不失败** ⇒ 全量中的失败是**并发负载**导致，
而**不是**这些文件自身的不确定性。即：**把并发降下来就有可能消除**（方案 B 有效的前提）。

## 2. 但降并发**并未**干净解决 —— 发现**另一类失败**

按 `--maxWorkers` 逐档压制并发（每档 2 次全量）：

| maxWorkers | 第 1 次 | 第 2 次 |
| --- | --- | --- |
| 12 | exit 0 | exit 0 |
| 8 | exit 0 | exit 0 |
| **6** | **exit 1**（见下）| exit 0 |
| 4 | exit 0 | exit 0 |

**关键**：`maxWorkers=6` 的那次 `exit 1`，其 `Tests` 是 **3019 passed (3019)**，
**零用例失败** —— 失败**不在用例级**。

### 该轮的错误原文（摘录）

```
Serialized Error: { errno: -4058, code: 'ENOENT', syscall: 'open',
  path: '...\astarray-t07d-r1-<随机>\missions\mis...' }
  ❯ packages/core/src/infra/task-store.ts:100:7
  ❯ AsyncMutex.runExclusive packages/core/src/infra/async-mutex.ts:18:14
  ❯ DagScheduler.persistChain packages/core/src/orchestration/dag-scheduler.ts:189:5
  ❯ DagScheduler.finishTask packages/core/src/orchestration/dag-scheduler.ts:102:5
  ❯ AssistScheduler.handleWorkerOutcome packages/core/src/orchestration/mission-orchestrator.ts:640:9
  ❯ packages/core/src/orchestration/mission-orchestrator.ts:514:9

This error originated in "tests/core/unit/application-sdk-task-events.test.ts" test file.
The latest test that might've caused the error is "两个会话结果不串线".
...
Test Files  401 passed (401)
Tests      3019 passed (3019)
Errors     1 error
```

## 3. 解读（这是**真实缺陷**，不是测试小毛病）

**时序**：测试（"两个会话结果不串线"）**已结束** → `afterEach` 清理临时目录 →
**但后台的 `finishTask` 仍在写盘** ⇒ `ENOENT` ⇒ **未处理错误** ⇒ vitest 记 `Errors 1 error` ⇒ 退出码 1。

**为什么这是产品侧问题**（而非测试自身）：
- 调用链在**产品代码**里（`mission-orchestrator` → `DagScheduler.finishTask` → `task-store`）；
- 它发生在**没有 awaiting 的后台异步路径**上：任务终态落盘**晚于**调用方（facade/测试）收口
  ⇒ 任何"先关闭/清理、后台仍在写"的宿主都会遇到；
- 影响不止测试：**真实宿主若在任务收尾前退出/清理状态目录，同样会得到未处理错误**
  （fail-closed 的**拒绝**是对的，但**未被捕获的异步错误**不是）。

**性质判定**：这是"**后台异步写入缺少收口/等待**"的**真实健壮性缺陷**，
其表现强度取决于调度时序 ⇒ 因此**表现为间歇**。

## 4. 因此，本会话的三个"抖动"实为**两类**问题

| 类别 | 观察 | 处理方向 |
| --- | --- | --- |
| **甲：并发负载下的用例失败** | 8 次全量中 3 次、且每次不同文件；**隔离后 18/18 全绿** | 降并发（方案 B）可缓解；**根因仍需查**（为何负载会影响判定）|
| **乙：非用例级的未处理错误** | `Tests` 全绿但 `Errors 1 error`、exit 1；调用链在**产品后台写入** | **应修产品**（等待/收口后台任务终态落盘），或至少在 facade 关闭时 drain |

**重要**：**甲与乙会同时制造"exit 1"**，而二者**归因完全不同**。
只看 `Tests … passed` 会**漏掉乙**（本会话此前多次只截取 `Tests` 行 ⇒ 正属此漏洞）。

## 5. 建议（未实施，属用户决策）

1. **先修乙**（更明确、更像真实缺陷）：让任务终态落盘在 facade `shutdown()` 时被
   **等待/收口**（或让后台路径捕获并记录而非抛未处理错误）。需先复现稳定（见下）。
2. **甲**：降 `maxWorkers` 只是**缓解**；应查清"负载如何影响判定"（可能是共享临时目录名、
   端口、或全局单例竞争）。
3. **统计口径**：报告门禁结果时**必须同时给出 `Tests` 与 `Errors`**，
   不能只截 `Tests` 行 —— 本会话已多次因此误判。

## 6. 未完成（如实）

- **未修任何代码**（本轮只做定位与固化）；
- **乙的稳定复现未取得**：`maxWorkers=6` 仅 1/2 次出现，且未见固定触发条件；
- **未查清甲的具体机制**（负载 → 判定失败的因果链）。

---

## 续记（2026-11-08，第 58 轮，`5c14f29`）

### 1. 复现尝试（如实：**仍未**取得确定性复现）

| 方法 | 次数 | 结果 |
| --- | --- | --- |
| 触发文件**隔离单跑** | 6 | **6/6 全绿、无 `Errors`** |
| 本报告记的 `--maxWorkers=6` 全量 | 3 | **3/3 exit 0、无错误** |
| 全量**默认并发**（`npm run check`） | 7 | **2 次 exit 1**（`Tests` 全过、`Errors 1 error`） |

⇒ 结论与本报告第 1 节一致：**负载相关**，且**只在默认高并发下出现**。
**因此我仍未获得"确定性复现"**，也就**没有**去动产品侧的两个候选修法。

### 2. 但这次定位到了**具体触发用例**（此前只知道"某个文件"）

```
This error originated in "tests/core/unit/application-sdk-task-events.test.ts"
The latest test that might've caused the error is "两个会话结果不串线".
```

**机制**：该用例**提交完就立刻返回** ⇒ `afterEach` 的 `fs.rm(stateDirectory)`
先删除临时目录，而在途的链写入
（`handleWorkerOutcome` → `DagScheduler.persistChain` → `TaskStore.writeChainInternal`
写 `.task-chain.json.<pid>.<uuid>.tmp`）随后落盘 ⇒ `ENOENT`。

**探针实测**（临时探针文件，用完即删）：mock 运行时下 mission 约 **313ms** 到达 `done`。
**同一次探针还纠正了我自己的一个错误假设**：mission 完成**并不会**从
`getActiveMissionIds()` 移除（实测**始终为 2**）—— 我首版等待条件因此**永远不可能满足**，
导致该用例每次都跑满 15s 期限（实测 15048ms）。**已改为只以"终态"为判据**（修正后 102ms）。

### 3. 所做修改（**只修测试收尾时序，断言一字未改**）

新增 `waitForMissionsToSettle()`：收尾前等两个 mission 到达**终态**（可观察语义判据，
不是猜时长），随后才 `shutdown()`。

**验证**：该文件隔离连跑 6 次全绿；**全量 `check` 连跑 4 次全部 exit 0、`Errors 0`**
（基线：修前 2 次 exit 1 / 7 次运行）。

### 4. 仍未解决（**明确保留**）

- **产品侧 `shutdown()` 的"返回即静默"契约仍未成立** —— 本条只让**这个测试**不再触发它；
  其它"提交后立刻 teardown"的测试**理论上仍可踩到同一机制**；
- 本报告第 3 节列的两个修法方向（**真等待** vs **写入侧对目录消失 fail-soft**）
  **仍待定**，且因为**仍无确定性复现**，按 `mission-orchestrator.ts` 的长注释要求，
  我**不**在无复现的情况下改产品代码。
