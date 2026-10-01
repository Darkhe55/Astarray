# 真实 CLI 离线端到端取证与残余缺口（2026-10-02）

> 本轮**不消耗真实额度**、**不升级支持等级**。按用户指令：先补两个真实 CLI 离线端到端反例，
> 覆盖"第二次拒绝后零副作用"；验收容忍换行与授权参数一致性**分开**。

## 1. 取证：三个问题的答案（真实运行记录）

| 问题 | 证据 | 结论 |
| --- | --- | --- |
| 首次调用是否进入执行 | `mission-b42ffe8c` 轨迹：尝试1/2 均为 `decision 等待权限`，尝试3 `result 已成功创建文件`；`mission-dda1710d` 同样停在询问 | **未执行**（停在门禁前） |
| 是否产生副作用 | 上述两次尝试无副作用；`mission-c42…` 之后的一次重试结算为 `kind=success`（文件确实被创建） | 失败尝试**无副作用**；成功那次**有副作用** |
| 第二次完整参数是否相同 | 逐字对照：① 键序相反；② **`content` 结尾换行不同**（第一次有 `\n`，第二次无） | **不相同** → 重新裁决是**正确行为** |

## 2. 本轮修复（离线验证通过）

| 修复 | 内容 | 证据 |
| --- | --- | --- |
| 裁决输入**分帧**（harness 级真实缺陷） | 原实现按"一次 `data` 事件"当一行读取；管道里多行裁决会一次性到达，整段被当成一行 → 误判 `deny`。改为**按换行切分、缓存半行**的行队列 | 多行管道探测：授权文案正常出现（此前为 `已拒绝权限调用`） |
| 授权类拒绝 = **确定无副作用** | `permission-ask-pending` / `tool-permission-denied` / `auth-scope-awaiting-user-authorization` / `auth-scope-denied` 在 `ToolCallResult.error.sideEffectStatus` 标记 `"none"`；`provider-cancelled` 同理。**不包含** `auth-scope-replay-rejected`/`operation-already-in-flight`（那表示此前已执行，按 none 会放宽重放保护） | `packages/core/src/tools/policy-wrapper.ts` |
| 工具自报"写入前被拒" | `createProjectFile` 因目标已存在（EEXIST）在写入前被拒 → 抛 `SideEffectNoneError` | `packages/core/src/tools/builtins.ts` |
| 重述补充"写工具成功后不得重复调用" | 实测：授权后写成功，模型仍反复调用 → 撞（正确的）重放守卫 → 连续失败触阈值 → 任务失败 | `packages/core/src/runtime/tool-loop.ts` |

## 3. 残余缺口（**未修复**，需独立检查点）

### 3.1 门禁侧

`allow-once` 授权后重跑仍可能返回 `auth-scope-replay-rejected`（"该授权已被消费"）：**被拒绝的那次尝试**
消费了作用域指纹记录，批准后的重跑撞上同一条已消费记录。离线可稳定复现：
裁决询问 1 次 → 授权成功 → 产物**未生成**。

### 3.2 完成侧（结构性）

`taskCompletionEventV1Schema` 只有 `taskExecutionId / completionAttemptId /
completedTaskIdentifiers / claimedStatus / taskSequenceRevision` —— **没有任何产物或验收字段**。
因此本地无法据完成事件对账"声明的产物是否存在/验收是否通过"，出现**产物未生成却结案 `done`**。

### 3.3 处置

- 本轮**不**实现上述两项：尝试过的语义改动（保留逻辑授权、重置已消费作用域记录、
  重置 `consumedAtIso`）会同时放宽既有测试固化的单次授权语义，
  `auth-scope-gate` / `scope-authorization-regrant` 等用例失败；
  在没有全绿反例支撑前按纪律**回退**（`scope-authorization-gate.ts` 已回到 `7a326fe`）。
- 建议独立检查点：① 完成协议扩展（产物/验收字段，版本化）；② 作用域记录与逻辑预留的
  一致性收敛（同一授权周期内的重跑语义），两者都需先写行为反例。

## 4. 门禁与状态

- `npm run check`：**250 文件 / 1944 用例**全绿（过程中两例负载抖动，独立运行通过）。
- 真实额度：**未消耗**（第 4 批 3 次仍可用）。支持等级仍为 `live-smoke-verified`（**未升级**）。
- `T07D-R2-04`：真实收口证据仍为 `mission-cbf3b73f`（§18）；因 3.2 缺口存在，
  **不得**据此宣称"验收口径完备"。
