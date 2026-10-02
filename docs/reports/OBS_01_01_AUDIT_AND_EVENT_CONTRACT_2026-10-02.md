# OBS-01-01 审计与共享可观测契约草案（2026-10-02）

> 任务卡：`docs/tasks/OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS.md`
> 检查点产出：**请求级账目/来源/修订契约及现有捕获审计；同键异参拒绝；明确总量/子量/估算与账单边界**。
> 卡内顺序要求：先协调 **RELIABILITY-01-01** 的工具/事件清单（**已完成**，见
> `RELIABILITY_01_01_AUDIT_MATRIX_2026-10-02.md`），再按 PERF → USAGE → DIAG 冻结**一个最小共享事件契约**。
> 本文件是审计与契约冻结，**不构成功能已启用**。

## 1. 基线

| 项 | 值 |
| --- | --- |
| commit | `20a974c`（OBS-01-01 开始） |
| 平台 | Windows（本机）；Linux/macOS 未验证 |
| 真实额度 | 0 |

## 2. 现有捕获面审计

### 2.1 PERF 侧（已有，质量较好）

| 件 | 位置 | 现状 |
| --- | --- | --- |
| 装配事件 | `orchestration/context-runtime-metrics.ts` | `ContextAssemblyRuntimeEvent`：`schemaVersion:1`、`eventType:"context-assembly"`、时间、mission、**具体 agentInstanceId**、任务、`cacheStatus`（hit/miss/bypass/**stale-reject**）、失效原因、注入计数/估算 token、预算策略 revision 与生效预算 |
| 指标复算 | 同文件 `computeContextRuntimeMetrics` | **由事件纯函数复算**；带样本量与分母；本地缓存估算与 **Provider 返回 usage 严格区分**；样本不足时标注不可比 |
| 事件持久化 | `orchestration/context-runtime-event-store.ts` | JSONL（`.astarray/context-runtime/events.jsonl`，本轮多次实测可读） |
| 样本门槛 | `MINIMUM_SAMPLE_SIZE_FOR_PERCENTAGE_BENEFIT = 10` | 百分比收益低于样本门槛时**不报告** |
| 通用指标 | `infra/metrics.ts` | 调用数、token **含 `isEstimated` 标记**、缓存状态、峰值并发、消息延迟、mission 数 |

**结论**：PERF 已具备"版本化事件 + 纯函数复算 + 样本/分母 + 估算与实测分离"的骨架，
可作为共享契约的**样板**。

### 2.2 USAGE 侧（部分具备，缺口明确）

| 件 | 现状 | 缺口 |
| --- | --- | --- |
| `TokenUsageRecord` | `provider`/`model`/`tokenCount`/`isEstimated` | **无**请求级标识（requestId/revision）、**无**来源（哪次调用/哪个任务）、**无**归因（总量 vs 子量） |
| `MetricsRegistry` | 进程内内存计数 | **不持久化**（重启即失）；无去重/乱序终值处理 |
| 预算/估价 | 上下文预算（`effectiveBudgetTokens`）存在 | **无**用量预算与费用估算（价格表缺失时的表达也未定义） |
| 额度表述 | — | 卡内要求"**不虚报余额**、不把本地估算当官方剩余额度" | 需在契约中显式约束 |

### 2.3 DIAG 侧（分散）

| 件 | 位置 | 现状 |
| --- | --- | --- |
| 稳定错误码 | `core/errors.ts` | **40+ 个稳定 `DomainErrorCode`**（含 `isRecoverable`），已具备"错误分类"的枚举基础 |
| 事件流错误字段 | `core/events.ts:29` | `errorCode?: string` 已随事件携带 |
| doctor | `packages/tui/src/cli`（`doctor` / `doctor --provider`） | 有只读诊断入口 |
| 缺失 | — | **无**错误指纹/合并/首次与最近发生/故障链/脱敏诊断包导出的统一契约 |

## 3. 差距清单

| 卡内要求 | 现状 | 差距 |
| --- | --- | --- |
| 请求级账目 | token 记录无请求标识 | **缺** |
| 来源与修订 | 事件有 agentInstanceId；usage 无 | **部分** |
| 同键异参拒绝 | 上下文装配有 revision；usage 无键 | **缺**（需在契约冻结键与哈希） |
| 总量/子量/估算/账单边界 | `isEstimated` 已区分估算 | **部分**（子量与账单边界未定义） |
| 持久化去重、分页聚合、重启 | usage 进程内 | **缺** |
| 价格缺失与估算来源 | 无 | **缺** |
| 错误指纹/合并/故障链 | 有稳定错误码 | **部分** |
| 只读诊断边界（不得偷偷执行） | doctor 为只读 | 需在契约固化"主动探测须单独授权" |
| 脱敏诊断包 | 无 | **缺** |

## 4. 共享最小事件契约草案（供 ADR 冻结）

### 4.1 通用信封（PERF / USAGE / DIAG 共用）

```
observeEventVersion: 1              // 契约版本（破坏性变更必须升版）
eventType: "perf" | "usage" | "diagnostic"
recordedAtIso: string
sourceAgentInstanceId: string       // 具体个体（不可复用）；沿用既有隔离规则
missionIdentifier: string | null
taskIdentifier: string | null
requestIdentifier: string           // 请求级标识（稳定，可跨重启对上）
requestRevision: number             // 同一请求的修订（终值/重算依据）
origin: { kind: "provider" | "local-estimate" | "system" , providerId?: string, modelIdentifier?: string }
```

**同键异参拒绝**（卡内硬要求）：键 = `requestIdentifier`；同一键不同
`inputHash`（规范化完整参数哈希）→ **拒绝写入并记录冲突**，不得覆盖。
同键同内容重试 → **复用既有回执**。

### 4.2 USAGE 事件（请求级账目）

```
usageEvent: {
  envelope,
  inputTokenCount: number | null      // null = 未知（不得填 0 冒充已知）
  outputTokenCount: number | null
  cachedTokenCount: number | null
  isEstimated: boolean                // 估算必须显式标记
  attribution: { kind: "total" | "subtotal", parentRequestIdentifier: string | null }
  costEstimate: { amountMinorUnits: number, currency: string, priceTableRevision: string } | null
}
```

**边界约束（写进契约）**：
- **总量 vs 子量**：`attribution` 必须显式；子量不得重复计入总量。
- **估算 vs 账单**：`isEstimated: true` 的记录**不得**用于"账单"结论；
  价格表缺失时 `costEstimate: null` 并给出原因，**不得**用本地估算冒充官方余额。
- 未拿到 usage（取消/超时/断连）→ 记 `null` 并标注原因，**不得补 0**。

### 4.3 PERF 事件

沿用现有 `ContextAssemblyRuntimeEvent`（已是 `schemaVersion:1` + 纯函数复算 + 样本/分母），
只需在信封层补齐 `requestIdentifier/requestRevision` 以便与 USAGE/DIAG 关联。

### 4.4 DIAG 事件

```
diagnosticEvent: {
  envelope,
  errorCode: DomainErrorCode,          // 复用既有稳定枚举
  stage: "dispatch" | "provider" | "tool" | "git" | "recovery" | "config" | "unknown",
  severity: "info" | "warning" | "error",
  fingerprint: string,                 // 错误码+组件+安全上下文的稳定哈希
  firstOccurredAtIso: string,
  lastOccurredAtIso: string,
  occurrenceCount: number,
  impact: { missionIdentifiers: string[], taskIdentifiers: string[] },
  recoveryState: "known-resolved" | "recovering" | "blocked-uncertain" | "unknown",
  chain: { rootErrorCode: string | null, wrapperErrorCodes: string[] },
  classification: "deterministic-fact" | "suspected-cause" | "insufficient-evidence"
}
```

**强制边界**：
- **正常暂停/用户拒绝/取消与程序故障分开**记录；不得把"等待"记成"失败"。
- 相同文本**不保证同因**：指纹必须含组件与安全上下文，保留每次事件关联。
- 错误数量下降**不是**已修复的证明；关闭事件需解除证据。
- 主动探测（进程执行/联网/建文件/复现步骤）**必须单独预览与授权**；
  思索模式仅用其既有只读能力；诊断本身**不得**自动安装/清理/删除备份/重试未知副作用。

### 4.5 脱敏诊断包

默认仅含：必要元数据与摘要 + 证据引用（事件 ID/revision/哈希）；
**不含**完整会话、源码、日志正文、凭据或他人个体明细。导出遵守个体/项目可见性。

## 5. 未实现声明与后续检查点

- 本轮**未**实现任何采集/持久化代码；**未**改变默认行为。
- PERF-01-01：性能事件与指标（复用现有 PERF 骨架，补信封字段）。
- USAGE-01-01：请求级账目契约与现有捕获审计（按 §4.2 冻结字段）。
- DIAG-01-01：错误分类/指纹/关联/诊断 schema，复用 `DomainError` 与现有 `doctor`。
- 02/03 各组实现与包验收；冻结前**不**新建外部时序数据库、独立遥测集群或默认守护进程。
- **未验证**：Linux/macOS；跨重启预算刷新与并发预算反例留待 02。
