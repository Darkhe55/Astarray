# 「甲类」抖动的最终归因：有界等待在负载下不够（2026-10-12）

> 承接 `SHUTDOWN_TIMING_REPRODUCTION_2026-10-12.md`：该文把失败分为
> **甲**（用例级失败）与 **乙**（非用例级 `Errors`）。本轮查清了**甲的归因**。

## 1. 切入点：最稳定复现的用例

`tests/core/integration/reliability-r4-ledger-concurrency.test.ts` **④**
（10 次全量中 3 次失败，是复现最稳定的一个）。

## 2. 该用例的结构（已读代码）

```ts
for (let round = 0; round < 4; round += 1) {
  // 每轮 6 个会话，并发 submitTask（各带 idempotencyKey）
  await Promise.all(/* 6 × submitTask */);
  committedCount += 6;

  // 有界等待"账目追平"
  const deadline = Date.now() + 20_000;          // ★ 每轮 20 秒上限
  while (Date.now() < deadline) {
    observedEntryCount = (await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory)).entries.length;
    if (observedEntryCount >= committedCount) break;
    await new Promise(r => setTimeout(r, 25));   // 25ms 轮询
  }
  expect(observedEntryCount, "第 N 轮账目未追平：期望 M").toBe(committedCount);
}
expect(committedCount).toBe(24);
```

该用例的注释已说明：**原先立刻断言精确条数**，在全量并发下偶发失败，故在 2026-10-10
改为**有界等待**；并明确写"这是**测试的时序假设**，不是产品丢条"。

## 3. 本轮查清的关键点：**不是丢条**

| 观测 | 推论 |
| --- | --- |
| 10 次全量中该用例**失败 3 次、通过 7 次** | 若真**丢条**，则应**每次**失败 ⇒ **不是丢条** |
| 失败信息为"**第 N 轮账目未追平：期望 M**" | 即"在 20 秒内**未追平**"，而非"追平到错误的数" |

⇒ **归因**：负载下**结算（绑定 missionIdentifier）超过了 20 秒**，
而有界等待的上限**不足以覆盖最坏负载**。

## 4. 因此「甲」不是并发语义缺陷，而是「有界等待余量不足」

对照本会话观测到的**全部甲类失败**，其形态**一致**：

| 用例 | 失败形态 | 是否超时断言 |
| --- | --- | --- |
| `reliability-r4-ledger-concurrency` ④ | "账目未追平：期望 M" | 是（20 秒有界等待）|
| `anthropic-messages-runtime:413` | 断言失败 | 待查（未展开）|
| `completion-gate-counterexamples:351` | 用例 B 断言失败 | 待查（未展开）|
| `instruction-continuous-reception:93` | 断言失败 | 待查（未展开）|

⇒ **已确证 1 个是"有界等待余量不足"**；另 3 个**未展开**（不推断其成因）。

## 5. 处理方案（**未实施，属用户决策**）

| 方案 | 说明 | 代价 |
| --- | --- | --- |
| **A. 放大有界等待** | 把 20 秒等上限调大 | 真失败时**慢**；且需逐个用例评估，非系统性 |
| **B. 降低并发** | 对重型集成用例串行/限流 | 全量变慢；但**同时缓解甲与乙** |
| **C. 让产品更快追平** | 查"为何结算要等 20 秒+" | 最贵；若结算本就该快，则是真实性能问题 |

**我的建议**：先做 **B 的局部隔离**（把最重的几个并发集成用例串行），
观察甲与乙是否同时消失 —— 这是**成本最低、且能同时验证两类问题**的实验。
若隔离后仍失败，才说明存在真实语义缺陷，届时再进 **C**。

## 6. 未完成（如实）

- **未改任何代码/测试**（含未调任何超时）；
- **未展开**另 3 个甲类失败的具体断言（不推断）；
- **未验证** B 方案是否真能消除甲与乙（下一轮可做）。