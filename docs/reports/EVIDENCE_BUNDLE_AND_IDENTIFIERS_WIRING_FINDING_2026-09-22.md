# 证据包构建器与任务标识接线缺口（发现与修复，2026-09-22）

> 发现方式：继续审计 builtins 上下文字段与生产装配的一致性。
> 状态：**已复现、已修复**。AGENTS.md 明确要求"高严谨性任务必须强制调用事实验证工具形成证据包"，本缺口使该要求在生产上不可达。

## 1. 症状

`factVerification` 的 `build-evidence-bundle`（ADR-0016 证据包）在真实运行链路上恒失败：

```
错误(tool-execution-failed): factVerification 证据包构建器未装配
```

同时：builtins 上下文的 `taskExecutionId` 从未被传入（读取账本键的任务分量恒为 `null`）；`factVerificationClaimIdentifier` 也从不传入（恒为 `"default-claim"`，跨任务无法区分主张）。

## 2. 根因

| 位置 | 事实 |
| --- | --- |
| `packages/core/src/tools/builtins.ts:751-755` | `build-evidence-bundle` 要求 `executionContext.evidenceBundleBuilder`，缺省抛错 |
| `packages/core/src/tools/policy-wrapper.ts`（修复前） | 选项里根本没有 evidence/标识字段，上下文自然不带 |
| `packages/core/src/application/application-runtime.ts`（修复前） | 从未构造 `EvidenceBundleBuilder`（该类无外部依赖，构造零成本） |
| `packages/core/src/tools/read-suppression-ledger.ts` | 账本键含 `taskExecutionId`，但生产中该值恒为 `null` |

## 3. 修复

1. `PolicyWrapper` 选项新增 `evidenceBundleBuilder` / `evidenceSearchAgent` / `evidenceQueryGuard` / `factVerificationClaimIdentifier`，并全部写入 builtins 上下文；同时补传 `taskExecutionId`。
2. `application-runtime` 构造 `EvidenceBundleBuilder`，按任务传入 `evidenceBundleBuilder` 与 `factVerificationClaimIdentifier: \`task-exec:\${task.id}\``。

## 4. 验证（红→绿 + 负控）

新增 `tests/core/integration/evidence-and-identifiers-production-wiring.test.ts`（3 例）：

1. **装配构建器后**：`build-evidence-bundle` 返回证据包，且 `claimIdentifier` 等于注入的主张标识；
2. **负控**：不装配构建器的同一调用仍报"证据包构建器未装配"（证明第 1 例依赖真实注入）；
3. **任务标识**：注入记录型账本桩后执行 `readFile`，账本收到的 `taskExecutionId` 恒为注入值（不再是 `null`）。

**红**：回滚生产改动后 `2 failed | 1 passed`（负控按设计保持通过）。**绿**：3/3 通过；官方门禁（完整访问 + 默认 forks 池）——构建成功、全量 **233 文件 / 1872 用例**、覆盖率 **93.09 / 85.43 / 93.19 / 93.12**、安全关键模块 **22/22**。

## 5. 残留与下一步（需用户/设计裁决）

- `search-sources` 仍需 `EvidenceSearchAgentPort`，生产无实现（离线环境）。缺省时错误信息已注明"（离线）"，属显式取舍；若要支持资料搜索依据，需要接入一个受控搜索代理并明确网络/凭据边界。
- **AGENTS.md 要求"思索模式只允许本地只读白名单工具查看项目文件、检索文本和查询只读任务状态"，但 `respondInPonderMode` 目前固定 `availableToolDescriptors: []` 且系统提示为"纯问答，不调用任何工具"**——这条硬性规则与当前实现冲突，已登记为下一个检查点（接通 Ponder 的只读白名单工具链路：提示、工具暴露、permission decider、UI 反馈与拒答路径）。
