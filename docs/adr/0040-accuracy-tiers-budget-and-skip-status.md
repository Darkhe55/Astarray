# ADR-0040：可关闭的任务准确性检查（档位、预算与跳过状态）

- 状态：Proposed（ACCURACY-01 冻结；实现落在 ACCURACY-02/03）
- 日期：2026-09-16
- 来源：用户增量设计 `docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md`（未跟踪用户文件；本 ADR 为 Agent 派生冻结稿）

## 背景

需要一层**可关闭**的任务准确性检查：既不能拖慢简单任务，也不能把"跳过"伪装成"通过"。
任务卡要求复用既有派发、独立反馈、完成协议与验收器，不新增第二套调度系统。

## 决策

1. **档位与预设**：`fast` / `standard`（推荐默认）/ `strict`。
   - **fast**：跳过本机制新增的**理解复述、语义审查与质量门禁**；必须记录独立状态
     `quality-check-skipped`，**不得**写成"测试/验收通过"；任务明确要求的测试仍属交付内容。
   - **standard**：简单任务直接执行，有歧义才澄清；完成时检查交付要求与证据覆盖。
   - **strict**：增加简短理解确认与**独立质量审查**（不同 agentInstanceId）。
2. **生效范围**：项目默认 + 当前任务覆盖；**仅认证用户可配置**；Agent 不得自行降级（降级尝试记录并拒绝）。
3. **预算**：每次准确性检查的模型调用次数与墙钟耗时有上界（数值在 ACCURACY-02 冻结）；
   预算耗尽记录"检查不足"（`quality-check-budget-exhausted`）而不是无限重试或静默通过。
4. **跳过状态是独立状态**：`quality-check-skipped` 与 `passed`/`failed`/`blocked` 互斥；
   对外报告、验收记录与完成事件必须显式呈现跳过状态。
5. **完成声明必须绑定证据**：稳定**验收条目 ID** + 真实产物/测试回执 + 当前版本校验 +
   **必需条目覆盖** + 证据来源（`factVerification`/本地实验/资料），不能只接受模型自述。
6. **检查范围有界**：只检查当前目标、范围、验收条目与关联产物，不扩展为全项目审计；
   未变化的相同任务版本与产物**复用有效证据**。
7. **执行一致性不消耗模型往返**：任务归属、版本、防重复执行与未决副作用由本地控制面判定。
8. **部分完成可报告进度，但不得据此结案**；结案必须满足第 5 条与既有完成门禁。

## 现有可复用能力（不重造）

`CompletionControlParser`（防重放 `completionAttemptId`、`taskSequenceRevision` 陈旧拒绝）、
worker 完成门禁（未解决的可变工具失败 → 不得 done）、`HumanVerificationController`（签收绑定上下文图 revision、
否决重开节点）、延迟核验任务（待追认）、`EvidenceBundleBuilder`（空条目拒绝 + 覆盖说明）、
`factVerification` 工具与 ADR-0016 证据优先级、`scripts/e2e01-acceptance.mjs` 的证据包校验。

## 非目标

- 不新增调度系统或消息总线（复用派发/独立反馈/完成协议）。
- 不因准确性检查授予任何权限（安装、外部软件、远端发布、备份删除仍走各自门禁）。
- 不做语义理解的确定性证明（只给出覆盖与来源报告）。

## 风险

- 快速档被误读为"通过" → 以独立状态与强制文案约束。
- 严格档增加延迟 → 预算上界 + 可关闭 + 只检查当前目标。
- 证据复用可能掩盖变化 → 以任务版本/产物指纹作为复用条件。
## 补充（ACCURACY-02 冻结：幂等签收、理解确认与条目→证据覆盖）

9. **幂等签收**：同一 `completionAttemptId` 的重复声明返回**既有结论**并标记 `isIdempotentReplay = true`，
   不重复产生副作用；幂等日志可由持久化实现提供，**崩溃重启后仍能识别重复派发**。
10. **版本一致性**：声明的 `taskSequenceRevision` 低于当前 → `stale-revision`；
    **高于当前 → `future-revision`**（未来版本不可信），两者都拒绝。
11. **收件人校验**：`deliveredToRecipientIdentifier` 必须与任务期望收件人一致（错收件人拒绝）；
    该检查与版本检查在**快速档下同样执行**（不新增模型审查或人工等待）。
12. **证据真实性**：产物/测试回执类证据必须有内容指纹（缺失 → `forged-evidence`）；
    `model-claim` 仅允许在快速/标准档使用，**严格档视为伪造证据**。
13. **陈旧产物**：证据记录 `producedAtRevision`；若产物当前 revision 更高 → `stale-artifact` 拒绝。
14. **条目 → 证据覆盖**：必需验收条目必须全部出现在完成声明中，否则 `required-entry-missing`；
    存在必需条目却没有任何证据引用 → `empty-evidence`；**部分完成只报告已覆盖条目，不得结案**。
15. **理解确认**：严格档必须提供 `understandingConfirmation`；标准档仅在**存在歧义**时要求；快速档跳过。
16. **快速档独立状态**：`verdict = "quality-check-skipped"`，理由明确写"跳过质量门禁（不等于测试/验收通过）"；
    与 `accepted`/`rejected` 互斥。

## 非目标（ACCURACY-02 范围外）

- 不新建调度系统或消息总线；本模块是既有完成门禁之上的**校验层**，
  与既有 `CompletionControlParser`/worker 完成门禁的**组合接线**属 ACCURACY-03。
- 不做语义蕴含判断；只校验覆盖、来源、版本与指纹。
- 理解确认的具体交互界面与档位设置入口属 ACCURACY-03。

## 补充（ACCURACY-03 冻结：设置、预算、跳过状态与产品入口）

17. **策略存储**：准确性策略（开关、默认档、预算上界、任务级档位覆盖）持久化在
    `<state>/settings/accuracy.json`，带单调 `revision`；缺失或损坏时读取**默认策略**
    （开启、标准档、模型审查次数上界与墙钟上界均为有限值），不静默覆盖已有设置。
18. **配置权限**：配置只允许认证用户；请求携带 `requestingAgentInstanceId` 时，
    **Agent 不得降级档位或关闭检查**，否则 `accuracy-tier-downgrade-rejected`；
    并发配置以 `expectedRevision` 做 CAS，不匹配 → `accuracy-policy-stale-revision`。
    预算必须为非负整数，否则 `accuracy-policy-invalid`。
19. **任务级覆盖**：`taskTierOverrides` 只影响被点名的任务，其余任务沿用默认档。
20. **预算记账**：标准/严格档每次真实校验消耗一次模型审查额度；额度耗尽或墙钟窗口超限 →
    `quality-check-budget-exhausted`，以**独立跳过状态**记录"检查不足"而**不是通过**。
    额度消耗从审计日志恢复，**跨进程重启不重置上界**（墙钟窗口按进程窗口计算）。
21. **关闭语义**：`isEnabled = false` 时完成校验返回
    `quality-check-skipped(accuracy-disabled)`，**不调用任何验收端口、不发起校验层、
    不新增人工阻塞**；该状态绝不等同于测试/验收通过。
22. **幂等优先于预算**：命中既有 `completionAttemptId` 结论时直接返回
    （`isIdempotentReplay = true`），不消耗预算、不再次发起校验层、不重复副作用。
23. **审计**：每次校验在 `<state>/accuracy/verification-audit.jsonl` 追加一条记录，
    含 `isVerificationLayerInvoked`；关闭与预算耗尽路径必须为 `false`，
    供本地/人工核验"关闭后没有新增模型审查"。
24. **产品入口**：公共门面提供 `queryAccuracyPolicy` / `configureAccuracyPolicy` /
    `verifyTaskCompletion` / `queryAccuracyVerificationAudit`，CLI 提供 `accuracy status` /
    `accuracy configure`；入口复用与门禁同一份策略与幂等日志，不实现第二套判定。
    本机制**不改变权限路由**（权限组、工具权限、范围授权保持不变）。
25. **增量 E2E（当前阶段）**：以"关闭 ⇒ 无新增模型审查/人工阻塞且状态诚实"、
    "标准/严格档工作量有上界"、"重复派发跨进程幂等"、"权限路由不变"作为验收断言；
    真实 Provider 下的端到端成本/时延验证仍待外部凭据（见 E2E-01）。

## 非目标（ACCURACY-03 范围外）

- 不在本阶段接入真实 Provider 的模型审查调用（模型审查端口由后续接线注入）；
- 不改变既有完成门禁、调度或权限判定；
- 不做语义蕴含判断，不把跳过状态写成通过。

