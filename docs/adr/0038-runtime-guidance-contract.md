# ADR-0038：运行中指导的事件契约（来源、作用域、sequence 与取消能力）

- 状态：Proposed（GUIDE-01-01 冻结；实现见 `packages/core/src/runtime-guidance/runtime-guidance.ts`）
- 日期：2026-09-16
- 来源：GUIDE-01 任务卡（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md）

## 背景

用户与本地监测可能在任务运行中途给出修正。指导必须可追溯（谁发的）、作用域精确（影响哪个任务/资源）、
可去重（重放不造成二次副作用）、有时效，并且**不能被"紧急"当成提权或改优先级的通道**。

## 决策

1. **来源三态 + 本地注册表**：`authenticated-user`、`registered-local-tool`、`file-task-observation`；
   每个来源登记 `maximumBehaviorTier`。未登记 → `unregistered-source`；超出登记档位 → `behavior-tier-not-permitted`。
   注册表由本地控制面维护，**模型无法注入来源**。
2. **三档行为**：`record-only`（仅记录，不触发安全点应用）、`safe-point-guidance`（安全点应用）、
   `gate-and-request-pause`（立即门禁并请求暂停/取消）。紧急仲裁在 EVENT-01 通过后才开放；
   门禁档**不授予新权限**，也不接管任务所有权。
3. **事件字段**：`guidanceIdentifier`、`guidanceRevision`（同 ID 单调）、`sequence`（来源内单调）、
   `issuedAtIso`/`expiresAtIso`、`scope{scopeKind,missionIdentifier,taskIdentifier,resourceIdentifier}`、
   `instructionText`、`derivedTaskPriorityTier`、`isDependencyPropagationExplicit`、
   `cancellationCapability{canCancelAtSafePoint, canCancelInFlight=false, providerSupportsInFlightInsertion=false}`。
4. **校验顺序与拒绝原因**：来源/档位 → 过期（`expired-guidance`）→ 作用域精确匹配
   （`cross-scope-application`）→ 优先级层级（`priority-tier-tampering`）→ 去重 → sequence
   （`out-of-order-sequence`）→ revision（`stale-guidance-revision`）。
   任何拒绝**不产生副作用**：不排入控制队列、不改任务优先级、不取消任何执行。
5. **重放去重**：同 `guidanceIdentifier` + 同 `guidanceRevision` 视为重复投递（即使传输层重新编号），
   只记录（`status = recorded`、`isDuplicateDelivery = true`）且 `shouldApplyAtSafePoint = false`；
   更高 revision 取代旧 revision，并在结果中列出 `supersededGuidanceIdentifiers`。
6. **作用域与依赖传播**：必须精确匹配 mission + task + resource；资源型指导默认**不扩散**到依赖任务，
   仅当 `isDependencyPropagationExplicit = true` 才允许（否则 `implicit-dependency-propagation`）。
7. **优先级约束**：指导派生任务层级只能 ≥1（用户层级 0 是用户专属，指导不得占用）。
   schema 允许写入 0 以便控制器**显式报告** `priority-tier-tampering`，而不是解析期静默丢弃。
8. **取消能力契约**：明确 `canCancelInFlight = false` 与 `providerSupportsInFlightInsertion = false`；
   不假定 Provider 支持在途插入；**未知停止结果一律 blocked**（实现属 GUIDE-01-03）。
9. **紧急等级不改变上述任何约束**：不授予新权限、不改 `priorityTier`、不绕过备份/安装/删除等专用授权。

## 非目标

- 控制队列与 IPC 入口、安全点应用时机（GUIDE-01-02）。
- 长工具检查点、协作取消与回执收敛的实现（GUIDE-01-03）。
- 公共应用/CLI/TUI 接线与安装包联测（GUIDE-01-04）。

## 后果与风险

- 拒绝只会"拒绝"，需要界面/CLI 把拒绝原因转成用户可理解的说明（GUIDE-01-04）。
- 去重依赖 `id + revision` 稳定；上游若每次生成新 ID 会导致重复应用——需要在发出方保持稳定标识。
- 来源注册表是本地安全边界：任何"从消息内容推断来源"的做法都违反本契约。

## 参考

- ADR-0007（反馈消息来源必填）、ADR-0013（待办偏序集与优先级层级）、ADR-0022（默认控制流与三级生命周期）、
  ADR-0028（人类/Agent 并发修改）、ADR-0036（事实核验）
- 实现与测试：`packages/core/src/runtime-guidance/runtime-guidance.ts`、`tests/core/integration/runtime-guidance.test.ts`
## 补充（GUIDE-01-02 冻结：控制队列与安全点应用）

10. **两条独立通道**：**控制队列**（运行中指导）与**普通报告**互不混用；两者都**不唤醒主 Agent**
    （`evaluateWakePolicy` 可查询）。控制队列由正在运行的任务在安全点即时消费，普通报告仅排队待读。
11. **安全点**：`before-model-call`（每次模型调用前）与 `before-tool-execution`（每次工具执行前）；
    消费发生在循环内，**不等整链结束**。
12. **应用语义**：安全点指导注入下一次模型输入（`role: system`、`name: runtime-guidance`、
    内容含 `[运行中指导 <id>@<revision>]`）；`gate-and-request-pause` 档在工具执行前
    **阻止该次工具调用**并返回稳定错误码 `guidance-gate-requested-pause`（不执行、不猜测用户意图）。
13. **幂等**：同一 `guidanceIdentifier + guidanceRevision` 只应用一次；重复入队返回 `recorded`（去重），
    安全点不会二次应用；更高 revision 取代旧 revision。
14. **消费点丢弃**：入队后过期 → `expired-at-safe-point`；作用域与目标不符 → `cross-scope-at-safe-point`
    （绝不套用到其他任务）。
15. **跨进程投递**：桥接把已应用指导封装为 `instruction` 信封、普通报告封装为 `success` 信封，
    幂等键分别为 `guidance:<id>@<revision>` 与 `report:<identifier>`；桥接**不做**权限/作用域判断，也不唤醒主 Agent。
16. **观察点**：安全点应用通过 `onGuidanceApplied` 回调暴露（写工作存档/审计属 GUIDE-01-04 接线）。

## 非目标（GUIDE-01-02 范围外）

- 长工具检查点、协作取消与回执收敛（GUIDE-01-03）。
- 把控制队列接入真实 fork 反馈进程的 IPC 生命周期与 TUI/CLI 呈现（GUIDE-01-04）。
- 紧急仲裁（EVENT-01）。