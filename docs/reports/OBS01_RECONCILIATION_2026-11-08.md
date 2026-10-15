# OBS-01 逐检查点对账（2026-11-08）

- **由来**：`PLAN_STATUS` 当前有效表把 `OBS（PERF/USAGE/DIAG）` 标为 **`re-verifying`**，
  并写明剩余工作是「**每卡 3 个检查点共 9 项，逐组核对全部生产采集与入口范围仍需完成**」。
  本报告即该项对账的**结果**（逐条给证据，不给形容词）。
- **结论**：**9 项中 8 项有据可核；`PERF-01-01` 的"测量"一条缺证据**（详见 §3）。
- **不做的事**：本文**不**声称整卡通过（`OBS-01-01` 里"观察开销预算**先测再定**"尚未完成）。

---

## 1. 证据基线（可复跑）

| 项 | 实测 |
| --- | --- |
| 相关测试 | **16 文件 / 104 用例全部通过**，`npx vitest run <16 个文件>`、**exit 0**、耗时 2.47s |
| 实现模块 | `packages/core/src/orchestration/perf-event-store.ts`（515 行）、`…/usage-ledger-store.ts`、`…/diagnostic-event-store.ts` |
| 入口测试 | `tests/tui/integration/cli-observability-entry.test.ts`、`tests/gui/integration/gui-observability-overview.test.ts` |
| 包级验证 | `scripts/verify-observability-entry-package.mjs`（存在；`PLAN_STATUS` 记 2026-10-10 实跑 **exit 0、8/8**） |
| 既有审计 | `docs/reports/OBS_01_01_AUDIT_AND_EVENT_CONTRACT_2026-10-02.md` |

**16 个相关测试文件**：
`diagnostic-persistent-summary`、`diagnostic-readonly-query`、`openai-compatible-usage-capture`、
`perf-overview-command`、`perf-persistent-aggregation`、`provider-request-usage-capture`、
`provider-usage-capture`、`sdk-runtime-kind-diagnostics`、`usage-ledger-persistence`、
`usage-overview-query`（以上 integration）；`b6r10-diagnostic-merge-branches`、
`diagnostic-aggregate-branches`、`perf-event-guard-branches`（以上 unit）；
`gui-observability-overview`、`cli-observability-entry`、`runtime-selection-diagnostics-report`。

## 2. 逐检查点对账

| 检查点 | 卡内验收要点（摘） | 证据 | 状态 |
| --- | --- | --- | --- |
| **PERF-01-01** | 核对已有事件接线、冻结测量口径/采样预算；**用同一工作负载测开关前后 CPU/内存/延迟，记录设备与样本** | `perf-event-store.ts`（`PerfSampleEvent`／`append`／`readWithIntegrity`／`aggregatePerfSamples`／`MINIMUM_SAMPLE_SIZE_FOR_DURATION_REPORTING`）＋ `perf-event-guard-branches.test.ts` | **部分** —— 接线与口径在，**测量记录缺**（§3） |
| **PERF-01-02** | 进程/任务测量、持久聚合、分页及告警；高并发、进程退出、**队列溢出**、时钟变化、监测器失败反例 | `perf-persistent-aggregation.test.ts`；`PerfOverflowReport`／`PerfIntegrityReport` 在 store 内 | **有据可核** |
| **PERF-01-03** | SDK/CLI 与 TUI/GUI 最小概览接线和 tarball；**长会话内存有界**；**休息时不产生模型/业务请求**；无法测量不报零 | `perf-overview-command.test.ts`（含"休息不产生请求"×3、"内存"×3 断言）、`cli-observability-entry.test.ts`、`gui-observability-overview.test.ts`；包级 8/8 | **有据可核** |
| **USAGE-01-01** | 请求级账目/来源/修订契约及现有捕获审计；**同键异参拒绝**；明确总量/子量、估算与账单边界 | `provider-usage-capture.test.ts`、`provider-request-usage-capture.test.ts`、`openai-compatible-usage-capture.test.ts` | **有据可核** |
| **USAGE-01-02** | 持久化去重、分页聚合、预算及估价；重复事件、**乱序终值**、重启、跨模型切换、**取消缺 usage**、并发预算反例 | `usage-ledger-persistence.test.ts`＋`usage-ledger-store.ts` | **有据可核** |
| **USAGE-01-03** | 公开查询/界面/导出和包验证；账目**可复算**、**不虚报余额**、价格缺失与估算来源清楚、**不泄漏其他个体明细** | `usage-overview-query.test.ts`（含"不泄漏其他个体"×2 断言）；导出/包验证见 §1 | **有据可核** |
| **DIAG-01-01** | 错误分类/指纹/关联/诊断 schema，复用 `DomainError` 与现有 `doctor`；冻结不支持的探测与信息边界 | `diagnostic-aggregate-branches.test.ts`＋`diagnostic-event-store.ts`；`doctor` 见 CLI 测试 | **有据可核** |
| **DIAG-01-02** | 持久汇总、分页、只读规则诊断及**证据包**；重复风暴、**敏感错误文本**、故障链、**不足证据**、**诊断自身失败**反例 | `diagnostic-persistent-summary.test.ts`、`diagnostic-readonly-query.test.ts`、`b6r10-diagnostic-merge-branches.test.ts` | **有据可核** |
| **DIAG-01-03** | 公共工具/CLI/SDK 及最小界面、tarball；故障**可从任务追溯到真实回执**；无未授权副作用；**不把模型推断写成确定根因** | `cli-observability-entry.test.ts`、`gui-observability-overview.test.ts`、`runtime-selection-diagnostics-report.test.ts`；tarball 见包级脚本 | **有据可核** |

## 3. ⛔ 唯一未覆盖项：`PERF-01-01` 的**测量**

**卡内原文要求**：

> 核对已有事件接线、冻结测量口径/采样预算；**用同一工作负载测开关前后 CPU/内存/延迟，记录设备与样本**

**已具备**：事件接线与测量口径（`PerfSampleEvent`、`aggregatePerfSamples`、
"样本量不足不报时长"的 `MINIMUM_SAMPLE_SIZE_FOR_DURATION_REPORTING` 口径）。

**缺什么（我实际查过的）**：在 `docs/` 全量检索 `采样预算|CPU 占用|内存峰值|rss|设备与样本|开关前后`，
**除本卡自身与一处 ADR 外无任何命中** ⇒ **没有"同一工作负载、开关前后、带设备与样本"的测量记录**。

**为什么不能含糊过去**：本卡第 89 行写明「**观察开销预算先测再定**，不预填性能提升或费用节省百分比」
⇒ 这条**正是**该卡要求先测的东西；不测就无法给出开销预算。

**下一轮的可执行做法（已想清，未在此轮做）**：
用**同一工作负载**跑两次（观测开 / 观关闭），分别记录
**CPU 占用、内存峰值（RSS）、延迟分位**与**设备信息**（OS/内核/CPU/Node 版本）与**样本量**，
把原始数据与命令退出码落成报告；若某指标在本机**无法测量，明确标注"无法测量"，
不报零**（这正是卡内"无法测量不报零"的同一条纪律）。
