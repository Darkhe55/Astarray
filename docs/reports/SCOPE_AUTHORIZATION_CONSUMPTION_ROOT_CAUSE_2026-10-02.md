# 作用域授权消费语义：根因定位（2026-10-02）

> 承接 `SCOPE_AUTHORIZATION_CONSUMPTION_2026-10-02.md` §2 的未决线索。本轮用
> `ASTARRAY_GATE_TRACE` 诊断（gate 实例标识 + reserve/authorizeReplay 调用栈）**定位完成**。
> 诊断代码已全部移除，工作树与提交一致。

## 1. 根因（调用栈实证）

真实 CLI 链路（独立探针 + 假 Provider，零真实额度）的 trace：

```
[gate-trace] constructed tag=gate-instance-ub4hd8
[gate-trace] reserve tag=gate-instance-ub4hd8 fp=263372ff2ccd reservations=0 loggedicals=0 scopeRecords=0
[gate-trace] reserve tag=gate-instance-ub4hd8 fp=263372ff2ccd reservations=0 loggedicals=0 scopeRecords=1
[gate-trace] authorizeReplay branch tag=gate-instance-ub4hd8 fp=847f879a5d38
             stack= at async ScopeAuthorizationGate.reserveForExecution (chunk-…:2301)
                    <- at async ScopeGatedToolPort.execute (chunk-…:2689)
                    <- at async runToolLoop (chunk-…:233)
                    <- at async WorkerAgent.run (chunk-…:893)
```

结论：**同一次任务里，模型在授权后重新发起的工具调用使用了不同的完整参数**
（`content` 结尾换行不同 → 逻辑操作指纹 `847f879a5d38` ≠ 首次 `263372ff2ccd`），
于是按"授权绑定完整规范化参数"的既定语义**必须重新裁决**。

- 这不是"被拒尝试消费授权"的缺陷（同指纹重跑在 gate 层已被 5/5 反例覆盖，见上一份文档 §1）；
- 这是**参数抖动带来的授权抖动**：模型每次重发都微调参数（换行/键序/措辞），
  每次都要用户再批一次 —— 这正是你在真实 TTY 里看到"两次甚至多次授权请求"的原因。

## 2. 影响

| 场景 | 现状 |
| --- | --- |
| 模型一次成功 + 直接给完成事件 | 一次授权即可（正常路径） |
| 模型写成功后**再次**调用写工具（同参数） | 命中重放保护被拒 → 连续失败触阈值 → 任务失败（已用重述提示缓解） |
| 模型重发时**微调参数**（换行/键序） | 每次都要重新裁决（本轮定位的真正用户痛点） |

## 3. 候选修法（**未实施**，需用户裁决）

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| A. 授权绑定"工具 + 解析后目标路径"（忽略内容/键序） | 一次授权覆盖同一路径的所有重试，彻底消除抖动 | 与用户 2026-10-02 明确要求"授权绑定逻辑操作 ID 和完整规范化参数，同路径内容变化也不能沿用"**冲突** |
| B. 保持完整参数绑定，仅在**同一任务/同一授权周期内**允许"未产生副作用"的重试复用 | 不放松跨周期语义 | 仍需改写既有 `auth-scope-gate` / `scope-authorization-regrant` 反例固化的单次语义 |
| C. 只靠提示词约束模型"一次成功即给完成事件、不要重发" | 零语义变更 | 已实施（重述提示），对模型的参数抖动只能缓解、不能保证 |

## 4. 本轮已交付

- `tests/core/integration/scope-consumption-semantics.test.ts`（5/5）：同指纹下的释放/重放/对账/并发/重新授权语义回归防护。
- 诊断代码已清零；`git diff` 中 gate 文件与已提交版本一致。
- 产物对账（上一检查点）保证：即使因授权抖动导致产物未生成，也**不会再被误判为完成**。

## 5. 门禁

`npm run check`：**253 文件 / 1962 用例**（慢窗口下 1 个 60s 超时用例，独立运行通过）。
