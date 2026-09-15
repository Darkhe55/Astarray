# ADR-0037：内容/计量缓存分离、Provider usage 捕获与质量评估

- 状态：Proposed（SUM-02-04 冻结）
- 日期：2026-09-15
- 来源：SUM-02 任务卡（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md）

## 背景

跨模型预算要求"换模型不重写历史、指标可复算"，并且摘要质量只能用**人工标注**评估
（不能用生成模型自评通过）。同时真实 Provider 的 usage 需要被捕获为权威计量。

## 决策

1. **内容缓存与计量缓存分离**：内容条目仅以内容哈希为键，**不含任何模型字段**；
   计量条目键 = 内容哈希 + provider + model + tokenizer@version + 序列化版本。
   换模型只**新增**计量条目，绝不改写内容条目（历史不被重写）。
2. **指标可复算**：`computeMeasurementCacheMetrics(snapshot)` 为纯函数，活状态与导出快照复算结果必须一致；
   无内容时 `measurementsPerContent = null`（不虚报比率）。
3. **Provider usage 捕获**：本地 JSONL 捕获端口（追加写；损坏行**显式失败**，不静默跳过），
   记录 request/provider/model/序列化版本与 input/output/cached token 数；
   `attachProviderUsageToMeasurement` 转为**权威**计量；`isCapturedUsageReusableForRequest` 绑定序列化版本。
   真实 Provider 捕获需要有效凭据与费用授权，离线环境以 `isRealProviderCaptureAvailable = false` **如实声明**。
4. **质量评估只接受人类标注**：`labelSource = "human"` 且必须带 `labeledByUserId`；
   任何 `labelSource = "model"` 抛 `model-self-evaluation-rejected`；缺标注者抛 `human-labeler-required`；
   样本集与预测不匹配抛 `sample-set-mismatch`；无负样本时 `falseSupportRate = null`。
5. **公开入口**：计量、请求预算、事实核验、缓存分离与质量评估 API 全部经公共 SDK
   （`dist/public-sdk.js`）导出，安装包消费者可直接使用（tarball 联测覆盖）。
6. **联测与评估脚本**：`scripts/verify-measurement-package.mjs`（安装包内 10 项检查）、
   `scripts/evaluate-summary-quality.mjs`（人类标注 JSONL → 指标；模型标注被拒）。

## 非目标

- 不做真实 Provider 端到端捕获与计费核对（缺凭据/费用授权，保持 blocked）。
- 不做自动质量判定或用生成模型自评。
- 缓存淘汰/容量与过期策略暂不实现（内存缓存 + 上层容量控制；JSONL 需轮转）。

## 后果与风险

- 内存缓存无淘汰策略：长会话需上层限制条目数；本 ADR 只冻结键与不变量。
- 捕获文件为追加 JSONL：损坏行会整体拒绝读取（fail-closed），需要上层轮转与校验。
- 质量指标依赖人工标注数量：样本不足时 `precision/recall` 仍会给出但分母可见，需在报告中标明样本规模。

## 参考

- ADR-0035（token 计量与请求预算）、ADR-0036（事实核验与重建）
- 实现与测试：`packages/core/src/measurement/measurement-cache.ts`、`provider-usage-capture.ts`、
  `quality-evaluation.ts`；`tests/core/integration/measurement-cache.test.ts`、
  `tests/core/integration/provider-usage-capture.test.ts`、`tests/core/unit/quality-evaluation.test.ts`
