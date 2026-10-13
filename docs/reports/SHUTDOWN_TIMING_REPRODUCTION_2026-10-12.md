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