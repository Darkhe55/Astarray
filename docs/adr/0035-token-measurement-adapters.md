# ADR-0035：token 计量适配与保守估算

- 状态：Proposed（SUM-02-01 冻结；实现见 `packages/core/src/measurement/token-measurement.ts`）
- 日期：2026-09-15
- 来源：SUM-02 任务卡（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md）

## 背景

SUM-02 要求"跨模型预算与摘要事实可靠性"：持久化保存完整消息/段落/决策，token 只用于**目标模型本轮预算**。
但同一段文本在不同 Provider、模型、tokenizer 与本地序列化方式下 token 数不同，
把某次计量当成通用事实会导致预算错误、无谓截断或超限请求。

## 决策

1. **来源三态**：任何计量结果都携带 `measurementSourceKind`：
   `provider-usage`（Provider 返回的权威 usage）、`local-tokenizer`（本地已注册 tokenizer 适配器）、
   `conservative-estimate`（未知组合下的保守估算）。
2. **版本绑定**：计量 DTO 记录 `providerIdentifier`、`modelIdentifier`、`tokenizerIdentifier`、
   `tokenizerVersion` 与 `serializationVersion`（本地提示/上下文序列化版本，当前 `1`）。
   `isMeasurementReusableFor` 判定：序列化版本不一致一律不可复用；本地 tokenizer 计量还要求 tokenizer 版本一致。
3. **保守估算规则**（`conservative-estimate-v1`，确定性可复算）：
   `max(ceil(utf8Bytes/3), ceil(asciiCharacters/3), nonAsciiCodePointCount)` 再加 5%+1 的余量。
   规则只声明**不低估**，不声明与任何具体 tokenizer 的准确率一致。
4. **不声明统一字符/token 换算**：DTO 不含 `charactersPerToken`/`tokensPerCharacter` 之类字段；
   `accuracyClaim` 只能取 `none`（估算）、`tokenizer-reported`（本地 tokenizer）、`provider-reported`（Provider usage）。
5. **Provider usage 为权威来源**：`isAuthoritative = true`；与真实请求/响应的绑定与计量缓存属 SUM-02-04。
6. **未知组合一律回落**：无法匹配本地适配器时返回保守估算，并给出 `fallbackReason`
   （`no-tokenizer-declared` / `tokenizer-not-registered`），绝不猜测 tokenizer 身份。
7. **无隐式联网计量**：适配器注册强制 `adapterKind === "local"`，非本地实现抛 `non-local-adapter-rejected`；
   本模块不包含任何网络导入或调用。在线计量/第三方 tokenizer 服务属于新依赖，须走 ADR-0019 安装门禁与逐次授权，不在本卡。
8. **空文本拒绝**：空字符串返回 `invalid-measurement-input`，避免产生无意义计量污染预算。

## 非目标

- 不实现具体 tokenizer（BPE 等）本身；本地适配器由调用方注入。
- 不做计费、费率与配额判断。
- 不做上下文裁剪与分页决策（SUM-02-02 基于本计量进行分页/预留）。

## 后果与风险

- 保守估算会**高估** token 数：预算可能更早触发分页/拆分，但不会因低估而截断正文（与"状态诚实"一致）。
- 本地 tokenizer 与 Provider 实际计数仍可能有差异：计量用于**本轮预算**而非账单；差异由 SUM-02-04 的实测样本评估。
- 版本字段使历史计量在升级后自动失效，避免复用过期计量。

## 参考

- docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md（SUM-02 共同规则）
- ADR-0029（读预算）、ADR-0034（摘要清单/详细度/资源观测）、ADR-0019（安装门禁）
- 实现与测试：`packages/core/src/measurement/token-measurement.ts`、`tests/core/unit/token-measurement.test.ts`
