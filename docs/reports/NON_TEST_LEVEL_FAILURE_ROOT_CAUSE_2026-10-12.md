# 「非用例级失败」的根因定位（2026-10-12）

> 承接 `ISOLATION_AND_NON_TEST_LEVEL_FAILURE_2026-10-12.md`：该文记录了
> `Tests 3019 passed (3019)` 却 `Errors 1 error`、exit 1 的现象。本轮**定位到根因**。

## 1. 现象回顾

`maxWorkers=6` 的某次全量运行：**零用例失败**，但 vitest 记 `Errors 1 error` ⇒ exit 1。
错误：`ENOENT ... open '...\astarray-t07d-r1-<随机>\missions\mis...'`，
调用链 `mission-orchestrator.ts:514` → `DagScheduler.finishTask:102` →
`DagScheduler.persistChain:189` → `task-store.ts:100`；
vitest 指其源自 `tests/core/unit/application-sdk-task-events.test.ts` 的
「两个会话结果不串线」。

## 2. 根因（已定位，含具体行号）

该用例**确实调用了** `application.shutdown()`（第 188 行），但 `shutdown()` **不保证**
在途任务已收口：

```
public-sdk.shutdown()
  → application-runtime.ts:996  shutdown()
      → :998  await controller.shutdown().catch(() => {})
          → main-controller.ts:387  MainController.shutdown()
              → :390  await Promise.allSettled(activeEntries.map(e => e.scheduler.cancel()))
                  → mission-orchestrator.ts:308  MissionOrchestrator.cancel()
                      → :315-318  await Promise.race([
                                    Promise.allSettled([...this.inFlightWorkerPromises]),
                                    new Promise(resolve => setTimeout(resolve, 2_000)),   ★ 2 秒超时
                                  ])
                      → :319-322  同上，对 this.runPromise 再给 2 秒
```

**★ 关键**：`cancel()` 等待在途 worker **最多 2 秒**。若某个在途 worker 超过 2 秒才走到
`handleWorkerOutcome` → `finishTask` → `persistChain`，则：

1. `shutdown()` **已经返回**；
2. 测试的 `afterEach` 随即 `fs.rm(stateDirectory, ...)` **删掉状态目录**；
3. 后台的 `persistChain` 才去 `open` 该目录下的文件 ⇒ **ENOENT**；
4. 该拒绝**无人接管** ⇒ vitest 记 `Errors 1 error` ⇒ **exit 1**。

⇒ 测试用例本身**没有任何失败**；失败是**产品后台写入在"宿主已收口"之后才发生**。

## 3. 为什么这是产品问题（而不只是测试问题）

- 调用链**全在产品代码**里；
- `Promise.race` 的 2 秒上限意味着**"shutdown 已返回"≠"在途任务已停写"**；
- 任何宿主（不只测试）若在 `shutdown()` 返回后**退出进程或清理状态目录**，
  都可能得到同样的**未处理异步错误**。

## 4. 两处取舍（**均未实施，属用户决策**）

### 方向甲：让 `cancel()` 真正等待在途写入收口
- 做法：去掉/放大 `cancel()` 里的 2 秒上限，或对"落盘类收尾"单独等待；
- **代价**：`shutdown()` 可能被**卡住**（原 2 秒上限显然是为了避免无限等待）；
  需同时定义"卡住时的上限与上报"，否则是拿一个风险换另一个。

### 方向乙：让写入侧对"状态目录已消失"**fail-soft 而非抛未处理错误**
- 做法：`task-store` 的持久化路径对 `ENOENT` 做**显式处理**（记录并视为"宿主已收口，
  无需持久化"），而不是抛出无人接管的拒绝；
- **代价**：**弱化 fail-closed**————必须严格限定"**仅**在状态目录整体不存在"时如此，
  否则会把真实的写失败静默化（这正是本会话反复强调要避免的）。

**我的倾向**：**甲 + 乙的组合**，但**必须**先取得**稳定复现**（当前仅 1/2 次），
否则无法验证修复。**本轮因此不改代码。**

## 5. 下一步（取得稳定复现的具体做法）

1. 反复单独跑 `tests/core/unit/application-sdk-task-events.test.ts`
   （它自己会 `shutdown()` 后由 `afterEach` 删目录），观察 `Errors` 出现频率；
2. 或降低 `maxWorkers` 并反复跑全量，**每轮同时记录 `Tests` 与 `Errors`**
   （只看 `Tests` 会漏掉本类失败 —— 本会话已因此误判多次）；
3. 取得稳定复现后，按方向甲/乙实现**先红后绿**的反例。

## 6. 未完成（如实）

- **未改任何代码**（含未实施甲/乙）；
- **未取得稳定复现**（本轮只定位到具体行号与因果链，未构造出确定性触发）；
- 未验证"去掉 2 秒上限"是否会导致 `shutdown()` 卡住（需实测）。