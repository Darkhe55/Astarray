# 「收口时序」缺陷：复现数据与最终结论（2026-10-12）

> 承接 `NON_TEST_LEVEL_FAILURE_ROOT_CAUSE_2026-10-12.md`（根因：`MissionOrchestrator.cancel()`
> 用 **2 秒上限** 等待在途 worker ⇒ `shutdown()` 返回后仍有后台落盘）。
> 本轮取得**复现数据**，并确认该缺陷**不限于一个测试文件**。

## 1. 隔离 vs 全量（决定性的对照）

| 方式 | 次数 | 结果 |
| --- | --- | --- |
| **单独**跑 `application-sdk-task-events.test.ts` | **20** | **20/20 干净**（`Tests 4 passed`、**无 Errors**）|
| **全量** `npm run test` | **10** | **3 次失败**（第 5/7/9 次）|

⇒ 该缺陷**只在并发负载下出现**；隔离跑**无法复现**。

## 2. 10 次全量的完整数据（**同时记录 `Tests` 与 `Errors`**）

| 轮次 | exit | Tests | Errors |
| --- | --- | --- | --- |
| 1,2,3,4,6,8,10 | 0 | 3019 passed | —（无）|
| **5** | **1** | 1 failed \| 3018 passed | **1 error** |
| **7** | **1** | **2 failed** \| 3017 passed | **4 errors** |
| **9** | **1** | 1 failed \| 3018 passed | **1 error** |

**⇒ 复现率 3/10 = 30%**。

## 3. 失败细节（三类写操作、多个文件）

| 轮次 | 用例失败点 | ENOENT 的 `syscall` | 错误来源 |
| --- | --- | --- | --- |
| 5 | `reliability-r4-ledger-concurrency.test.ts:172` | **`open`** | `application-sdk-task-events.test.ts` |
| 7 | `ledger-concurrency:172` **+** `instruction-continuous-reception.test.ts:93` | **`open`** + **`rename`** | `ledger-concurrency`（×4）|
| 9 | `ledger-concurrency:172` | **`mkdir`** | `ledger-concurrency` |

**关键**：`open` / `rename` / `mkdir` **三类不同写操作**都因"目录已被清理"失败
⇒ 与上一轮的根因判断一致（**收口时序**），且**不局限于单一测试文件**。

## 4. 与"甲/乙"分类的对应

- **乙（非用例级错误）**：上表的 `Errors` 行 ⇒ 确认存在，且**来源至少两个测试文件**。
- **甲（用例级失败）**：`ledger-concurrency:172` 在多次失败中出现，是**最稳定复现**的一个；
  而更早的 8 次全量里还出现过 `anthropic-messages-runtime:413`、
  `completion-gate-counterexamples:351`（那两次**未见 `Errors` 行** ⇒ 属**甲类**、与乙不同源）。

**⇒ 甲与乙是两类独立问题，但在失败轮次上会同时出现**（第 5/7/9 轮两者皆有）。

## 5. 结论与建议（**仍未改代码**）

1. **乙应修产品**：`shutdown()` 必须让在途落盘**收口**（或让写入侧对"状态目录整体不存在"
   fail-soft）。上一轮已列两处取舍：**甲方向**（真等待，可能卡住）与**乙方向**
   （fail-soft，弱化 fail-closed 须严格限定）。
2. **甲需单独查**：`ledger-concurrency:172` 可稳定复现（3/10），是**较好的切入点**；
   但它发生在**用例内**，属并发语义问题，与收口时序**不同源**。
3. **报告口径**：**必须同时给出 `Tests` 与 `Errors`** —— 本轮数据显示二者会同时出现，
   只看 `Tests` 会漏掉 `Errors`，只看 `Errors` 会漏掉纯用例失败。

## 6. 未完成（如实）

- **未改任何代码**；
- **未取得确定性触发**（仍是概率复现 30%）；无法据此验证修复 ⇒ **不改**是刻意的选择；
- 未查 `ledger-concurrency:172` 的具体断言（本轮未展开）。

---

## 7. ✅ 2026-11-08（第 64 轮）：**确定性复现已取得**，§6 第 2 条**不再成立**

> **本节推翻上一节的"未取得确定性触发"**，并推翻上一节"隔离跑无法复现"的**方法性**结论：
> 隔离跑**确实能**确定性复现 —— 只要用**受控慢 Provider** 把窗口造出来，
> 而**不需要**并发负载。

### 7.1 复现方法（可直接重跑，约 9 秒）

用一个**延迟 5 秒**才回应的假 Provider（阻塞式 SSE），让任务在 `shutdown()` 时
**必然**处于在途；关键前置条件是**假 Provider 必须真的收到过请求**。

```
① 起假 Provider：收到请求后 setTimeout(5_000) 再回 SSE（含完成标记）
② AstarrayApplicationFacade.create({ runtime: "provider", providerRuntimeRegistry: registry,
     provider: { requestTimeoutMilliseconds: 60_000, ... } })
③ createSession → submitTask
④ **同步点 A**：轮询到链文件 `task-chain.json` 首次落盘
⑤ **同步点 B（关键）**：轮询到假 Provider 的 `receivedRequestCount >= 1`
   ⇒ 此时任务**真的在途**（不是"刚提交还没派发"）
⑥ await application.shutdown()
⑦ 等到超过 5 秒延迟窗口后，读回链文件
```

### 7.2 实测结果（**确定性复现**）

```
× shutdown 返回后链文件内容**变了**（有人在其后落盘）
  expected '{"schemaVersion":1,...}' to be '{"schemaVersion":1,...}'
Tests  1 failed        ← 隔离单跑，约 9 秒，无需负载
```

⇒ `shutdown()` 返回**之后**仍发生了链落盘（任务状态被更新），
**确定性、可重复**，与上一节"3/10 全量、20/20 隔离干净"的概率型现象**是同一缺陷**，
但**触发条件已可精确构造**。

### 7.3 ⚠️ 我自己第一版探针的**空洞通过**（如实记录，供后人避开）

第一版只做：等链文件落盘 + 检查"仍在 5 秒延迟窗口内"，然后 shutdown。

**它给出了误导性的绿**：`shutdown()` 仅耗时 **6 ms** 且"之后内容未变"。
真相是：`cancel()` 见 `inFlightWorkerPromises.size === 0`（worker **尚未派发**）
⇒ 直接 `stopping = true` 让调度循环停下 ⇒ **Provider 从未被调用**，
自然不会有迟到写入 ⇒ 用例**什么都没验证到**。

**教训（可复用）**：构造"在途"场景时，**只检查时间窗口不够**，
必须检查**被调用方真的收到了请求**（外部可观测的同步点）。

### 7.4 根因（与上一节一致，现已有确定性证据）

`MissionOrchestrator.cancel()`：

- 它**只等待、不中止**（`Promise.race([allSettled(inFlightWorkerPromises), 2_000ms])`）；
- 编排器内**完全没有** `AbortController`（全文件 0 处）⇒ 在途 Provider 调用
  **不会**被取消，5 秒后照常返回，worker 走到 `handleWorkerOutcome → finishTask →
  persistChain` ⇒ **落盘发生在 shutdown 之后**。

### 7.5 三个可决策方向（**本轮仍未改代码**，取舍涉及产品可见行为）

| 方向 | 做法 | 代价 / 风险 |
| --- | --- | --- |
| **A 真等待** | 去掉或放宽 2 秒上限，等 `allSettled(inFlightWorkerPromises)` | `shutdown()` 可能阻塞到 **Provider 超时**（默认可达 120 秒）⇒ 产品可见的关停延迟 |
| **B 写入侧 fail-soft** | 状态目录整体不存在时，落盘按**已终止**处理（明确记录，不静默吞） | **不能**让上面的复现转绿（写入仍会发生，只是不崩）；弱化 fail-closed，须严格限定范围 |
| **C 中止在途 worker** | 为每次 worker 运行建 `AbortController`，`cancel()` 时 abort | **最优语义**（快关停 + 无迟到落盘），但需**新增基础设施**，且要定"被中止的 worker 是否/如何落盘终态" |

**⇒ 需要用户/设计裁决 A 还是 C**（B 单独用不足以修好），故本轮**刻意不改**，
把确定性复现留在本报告，使任何方向的选择都可**立即验证**。
