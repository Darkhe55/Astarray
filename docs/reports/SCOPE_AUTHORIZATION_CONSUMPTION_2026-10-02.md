# 作用域授权消费语义：反例与未决线索（2026-10-02）

> 本文件记录检查点 2 的**实际进展**：反例已建立并通过，但**根因未定位完成**——不得当作已修复。

## 1. 已完成：消费语义反例（`tests/core/integration/scope-consumption-semantics.test.ts`，5/5 通过）

| 反例 | 断言 |
| --- | --- |
| ① 一次 `allow-once` 后：首次**无副作用失败** → 重试必须能执行 | `released` 后再次 `reserveForExecution` → `reserved`，且错误码**不是** `auth-scope-replay-rejected` |
| ② 成功结算后同逻辑操作再次调用 | 必须 `replay-rejected`（重放保护**不放宽**） |
| ③ 结果未知 | 进入 `requires-reconciliation`，且再次预留仍为对账（**不得自动放行**） |
| ④ 并发同一逻辑操作 | 只允许一个持有预留（另一个 `reserved-in-flight`） |
| ⑤ 用户重新授权（同参数） | 必须能再次执行（不得残留已消费状态） |

结论：**在同一 gate 实例内**，"被拒绝的尝试消费掉一次性授权"这一路径**已不再出现**。
这些用例作为既有语义的回归防护保留。

## 2. 未解决：真实 CLI 链路仍命中 `auth-scope-replay-rejected`

离线稳定复现（`/tmp` 脚本，零真实额度）：一次授权后重跑，工具结果为
`错误(auth-scope-replay-rejected): 该授权已被消费：重放不产生副作用，需重新授权`，
产物**未生成**；任务链以失败/阻塞结束（不再被误判为 `done`，见上一检查点的产物对账）。

**本次排查得到的硬事实**：

1. 该中文文案**不在当前构建产物中**：递归扫描 `dist`（107 个 `.js`，含子目录）无一命中；
   `dist` 仅含**逻辑预留**路径的 `auth-scope-replay-rejected`（错误码与短语，无该文案）。
2. 在 gate 的 `authorizeForExecution` "命中已消费记录"分支加诊断（`ASTARRAY_CONSUME_TRACE`）后，
   驱动真实 CLI：**诊断从未输出** → 该拒绝**不是**由 `authorizeForExecution` 产生的。
3. 同一时间 `dist/*.map` 中**存在**该文案（源码含之，行 499）。

**推论（待验证）**：真实 CLI 路径要么走到**第二个 gate 实例/第二条代码路径**，
要么加载了**与本仓库当前 `dist` 不同的构建**（例如 `.tmp` 下的 tarball 安装缓存）。
下一步应先固定证据：在 CLI 进程内打印实际加载的模块路径与 gate 实例标识，
再决定是"实例不一致"还是"消费语义仍有第二处落点"。

## 3. 本检查点刻意未做

- **未**放宽单次授权语义（既有 `auth-scope-gate` / `scope-authorization-regrant` 用例固化之）。
- **未**声称该缺口已修复；产物对账（上一检查点）已确保"未生成产物不得结案"，
  但"批准后重跑为何仍被拒"的根因仍待定位。

## 4. 门禁

`npm run check`：**253 文件 / 1962 用例**；慢窗口下出现 1 个 60s 超时用例
（`cli-commands`，独立运行 22/22 通过），与本机负载敏感性一致（详见
`COMPLETION_ARTIFACT_RECONCILIATION_2026-10-02.md` §4）。
