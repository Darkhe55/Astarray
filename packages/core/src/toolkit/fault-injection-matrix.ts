/**
 * RELIABILITY-01-02：**故障注入矩阵**（2026-10-10，R5）。
 *
 * 契约来源：`docs/tasks/2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS.md`
 * §"故障注入矩阵"与检查点 01/02。
 *
 * 卡内要求：对代表性操作在"**派发前、已持久化未执行、执行中、副作用完成但回执未写、
 * 回执写入但确认丢失、恢复过程中**"注入崩溃/断连；覆盖同键并发、异参重放、取消与完成竞态、
 * **磁盘满**、**损坏记录**、**零预算**、**权限撤销**、**休息边界**、**父进程退出**；
 * 并"使用可握手的受控子进程/假服务/虚拟时钟，**禁止用过窄真实计时窗口证明正确**"。
 *
 * 本模块把矩阵做成**可核对**的数据 + 校验函数（不是散文）：
 *  - 每个注入时点必须标注**结论**（已证实 / 缺陷已修 / **未验证** / 有缺口）；
 *  - **已证实**的条目必须给出**存在且可达**的证据引用（文件必须真的在仓里）；
 *  - **未验证**的条目**不得**提供证据引用（不能拿别的测试冒充）；
 *  - 卡内点名的**覆盖维度**必须逐项出现在矩阵中（缺失即矩阵不完整）。
 *
 * 本模块做**只读文件系统存在性检查**（判断证据引用是否真的存在）；
 * 不联网、不执行被测代码。
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** 注入时点（卡内列举）。 */
export type FaultInjectionTiming =
  | "before-dispatch"
  | "persisted-not-executed"
  | "inflight"
  | "side-effect-done-receipt-missing"
  | "receipt-written-ack-lost"
  | "during-recovery";

/** 覆盖维度（卡内列举）。 */
export type FaultCoverageDimension =
  | "same-key-concurrency"
  | "different-argument-replay"
  | "cancel-complete-race"
  | "disk-full"
  | "corrupted-record"
  | "zero-budget"
  | "permission-revocation"
  | "rest-boundary"
  | "parent-process-exit"
  | "child-process-timeout";

export type FaultVerdict = "confirmed" | "fixed" | "not-verified" | "gap";

export interface FaultInjectionEntry {
  entryIdentifier: string;
  timing: FaultInjectionTiming;
  dimension: FaultCoverageDimension;
  /** 代表性操作（读/写/安装/推送/合并/配置提交/反馈确认/任务提交）。 */
  representativeOperation: string;
  verdict: FaultVerdict;
  /** 结论说明（含"未验证"的原因）。 */
  summary: string;
  /**
   * 证据引用（相对仓库根的文件路径）。
   *
   * 仅 `confirmed` / `fixed` 必须给出，且**必须真的存在**。
   */
  evidenceFilePaths?: string[];
  /** 已知限制（跨平台等）。 */
  limitation?: string;
}

/**
 * 矩阵数据（2026-10-10 逐条核对既有测试与修复记录）。
 *
 * 纪律：**不确定就不算已证实** —— 宁可写 `not-verified`，也不拿相邻测试冒充。
 */
export const FAULT_INJECTION_MATRIX: readonly FaultInjectionEntry[] = [
  {
    entryIdentifier: "inflight-unknown-side-effect",
    timing: "inflight",
    dimension: "same-key-concurrency",
    representativeOperation: "作用域受限写操作（createProjectFile）",
    verdict: "fixed",
    summary:
      "内层工具端口直接 throw：原先预留永久停在'在途'且无对账路径；现按 unknown 结算为 operation-settlement-unknown（禁止自行放行）",
    evidenceFilePaths: [
      "tests/core/integration/reliability-sensitive-refusal-settlement.test.ts",
      "tests/core/integration/permission-refusal-side-effect.test.ts",
    ],
  },
  {
    entryIdentifier: "inflight-structured-unknown-failure",
    timing: "inflight",
    dimension: "cancel-complete-race",
    representativeOperation: "作用域受限写操作（结构化未知失败）",
    verdict: "confirmed",
    summary: "返回 kind:error + sideEffectStatus:none ⇒ 结算 released，重试可执行",
    evidenceFilePaths: ["tests/core/integration/permission-refusal-side-effect.test.ts"],
  },
  {
    entryIdentifier: "receipt-missing-claim-pending",
    timing: "side-effect-done-receipt-missing",
    dimension: "same-key-concurrency",
    representativeOperation: "任务提交（幂等账目 claim 已落盘、missionIdentifier 仍为 null）",
    verdict: "confirmed",
    summary:
      "重启后同键不重复执行，返回 idempotency-claim-pending（不假定成功）",
    evidenceFilePaths: [
      "tests/core/integration/reliability-sdk-idempotency.test.ts",
      "tests/core/integration/reliability-r4-ledger-concurrency.test.ts",
    ],
  },
  {
    entryIdentifier: "restart-after-settlement",
    timing: "during-recovery",
    dimension: "different-argument-replay",
    representativeOperation: "任务提交（新 facade 指向同一状态目录）",
    verdict: "confirmed",
    summary: "同键同参复用同一 mission；异参拒绝",
    evidenceFilePaths: [
      "tests/core/integration/reliability-sdk-idempotency.test.ts",
      "tests/core/integration/reliability-r4-ledger-corruption.test.ts",
    ],
  },
  {
    entryIdentifier: "zero-budget-across-restart",
    timing: "during-recovery",
    dimension: "zero-budget",
    representativeOperation: "恢复分类（幂等 planned/started/result-unknown）",
    verdict: "fixed",
    summary:
      "尾部分支原先无条件 bounded-retry（预算失效）；现预算 ≤0 返回 blocked-uncertain-side-effect",
    evidenceFilePaths: [
      "tests/core/integration/reliability-recovery-classification.test.ts",
    ],
  },
  {
    entryIdentifier: "corrupted-record-rejected",
    timing: "persisted-not-executed",
    dimension: "corrupted-record",
    representativeOperation: "幂等账目文件存在但损坏",
    verdict: "fixed",
    summary:
      "损坏账目原先与'不存在'无法区分（重启后重复执行）；现默认 fail-closed idempotency-ledger-corrupted",
    evidenceFilePaths: [
      "tests/core/integration/reliability-r4-ledger-corruption.test.ts",
      "tests/core/integration/reliability-sdk-idempotency.test.ts",
    ],
  },
  {
    entryIdentifier: "disk-full-checkpoint-store",
    timing: "inflight",
    dimension: "disk-full",
    representativeOperation: "恢复检查点持久化",
    verdict: "confirmed",
    summary: "磁盘失败路径有反例覆盖（检查点存储）",
    evidenceFilePaths: ["tests/core/unit/recovery-checkpoint-store.test.ts"],
  },
  {
    entryIdentifier: "disk-full-lossless-staging",
    timing: "inflight",
    dimension: "disk-full",
    representativeOperation: "无损暂存（NODECTX-01-02）",
    verdict: "confirmed",
    summary: "暂存写入失败 ⇒ 可见性完全不变、不假报成功、不移出上下文",
    evidenceFilePaths: [
      "tests/core/integration/nodectx01-lossless-context-manager.test.ts",
    ],
  },
  {
    entryIdentifier: "rest-boundary",
    timing: "inflight",
    dimension: "rest-boundary",
    representativeOperation: "计划休息期间的指令与期限判定",
    verdict: "confirmed",
    summary: "休息优先于补位；不把休息当故障",
    evidenceFilePaths: [
      "tests/core/integration/main-agent-deadline-supervisor.test.ts",
      "tests/core/integration/instruction-stop-recovery.test.ts",
    ],
  },
  {
    entryIdentifier: "child-process-timeout",
    timing: "inflight",
    dimension: "child-process-timeout",
    representativeOperation: "git 命令超时（子进程）",
    verdict: "confirmed",
    summary: "夹具派生的孙进程持续写心跳 + 1s 超时；Windows 已证实收口",
    evidenceFilePaths: ["tests/core/integration/reliability-git-process-tree.test.ts"],
    limitation: "POSIX 进程树收口未验证（跨平台风险项）",
  },
  {
    entryIdentifier: "permission-revocation-race",
    timing: "before-dispatch",
    dimension: "permission-revocation",
    representativeOperation: "权限提升撤销后的执行",
    verdict: "confirmed",
    summary: "提升撤销/失效后不再放行（持久化与生效性均有反例）",
    evidenceFilePaths: [
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
    ],
  },
  {
    entryIdentifier: "before-dispatch-crash",
    timing: "before-dispatch",
    dimension: "parent-process-exit",
    representativeOperation: "任务提交：派发前进程被强杀（父进程外部终止子进程）",
    verdict: "confirmed",
    summary:
      "真实跨进程**硬杀**注入（收到子进程 stdin 握手后立即 SIGKILL，不用任何计时窗口）：① 若 claim 未落盘则重试允许且必须给出明确结果；② 若 claim 已落盘未结算则 fail-closed（idempotency-claim-pending，不重跑）；③ pending claim 与异参同键冲突检查照旧生效。既有 idempotency ② 的'重启'走优雅 shutdown（claim 已结算），**未**覆盖本形态",
    evidenceFilePaths: [
      "tests/core/integration/reliability-before-dispatch-crash.test.ts",
    ],
    limitation:
      "硬杀落点在'claim 未落盘'与'claim 已落盘未结算'之间浮动；为避免'过窄计时窗口'，冲突检查用例改为**确定性植入** pending claim 验证，两个相位均由该套件覆盖",
  },
  {
    entryIdentifier: "guidance-receipt-write-interrupted",
    timing: "receipt-written-ack-lost",
    dimension: "corrupted-record",
    representativeOperation: "运行指导：回执写入被崩溃/断电打断",
    verdict: "fixed",
    summary:
      "先说结论（如实记录排查过程）：本仓指导的『记录与应用』在**同一个同步块**内完成，故『回执已写、确认未到』的间隙**并不存在**（原假设被跨进程注入证伪）。该时点真正的形态是『回执写入过程被打断』——磁盘留下不完整 JSON，而 `readDocument()` 此前**静默返回空日志** ⇒ `queryGuidanceStatus()` 报 0 条、用户指导**静默消失**（与已返修的幂等账目损坏同类）。已新增 `readAllWithIntegrity()`/`readAllStrict()`，并让产品默认查询路径 **fail-closed**（损坏即显式失败），合法条目仍保留供诊断",
    evidenceFilePaths: [
      "tests/core/unit/reliability-guidance-journal-integrity.test.ts",
    ],
  },
  {
    entryIdentifier: "smart01-continuous-reception-real-run",
    timing: "inflight",
    dimension: "permission-revocation",
    representativeOperation:
      "SMART-01-04：慢模型/长下级任务在途时**真实运行**下的持续接收（180 秒内派发或如实超时）",
    verdict: "confirmed",
    summary:
      "**真实运行已通过（2026-10-10，云之声 u2-flash）**：`verify:u2-flash-continuous-reception` " +
      "**退出码 0、判据 8/8 通过** —— 真实慢模型（单次约 4.6–5s）在途期间仍能接收新指令" +
      "（派发 18ms、接收 13ms，均远低于 180 秒上限）；派发状态与成果完成**可区分**" +
      "（提交时 accepted、终态 done）；两条指令均收敛到终态（关闭回收）；" +
      "且专门断言**运行前后受保护凭据文件 sha256 一致**（未写入凭据）。" +
      "此前该条为 `not-verified`（无额度）；本轮取得额度后改判。" +
      "**附注**：`--probe-only` 模式在 Windows + Node v24.18.0 上连通检查通过但退出路径" +
      "触发 libuv 断言 `UV_HANDLE_CLOSING`（3/3 复现、非管道问题），全量模式不受影响，已如实记录未修",
    /**
     * 证据引用必须**仓库相对且以 `tests/` 开头**（见
     * `tests/core/unit/reliability-fault-injection-matrix.test.ts` ⑨）。
     * 真实运行判据本体在 `.tmp/live-u2-flash/acceptance-verdict.json`（**产物**，
     * 已 gitignore 不进版本库），故这里引用**可移植门禁**：它校验验证脚本的契约，
     * 并在产物存在时逐条核对判据。人类可读实测报告见
     * `docs/reports/SMART01_04_LIVE_U2_FLASH_EVIDENCE_2026-10-10.md`。
     */
    evidenceFilePaths: [
      "tests/tui/integration/smart01-04-live-u2-flash-verdict.test.ts",
      "tests/tui/unit/smart01-instruction-cli-entry.test.ts",
    ],
  },
  {
    entryIdentifier: "load-sensitive-full-gate-flake",
    timing: "inflight",
    dimension: "cancel-complete-race",
    representativeOperation:
      "全量门禁并发下与本次改动无关的用例偶发失败（**已定位到具体用例**）",
    verdict: "not-verified",
    summary:
      "**已定位到具体用例**（此前只笼统记为『负载抖动』）：" +
      "`tests/core/integration/reliability-r4-ledger-concurrency.test.ts` ④" +
      "（多轮交错并发 4×6 幂等账目追平，有界 20s 等待）在本会话至少 2 次全量运行中" +
      "失败，而**隔离单跑 3/3 通过**；另有少量 provider/gui 用例。" +
      "根因此前定位到 `%TEMP%` 下大量 `astarray-*` 目录导致清理失败，清洁后连续通过。" +
      "**未在产品代码中修复**，故**不标为已修**；" +
      "`run-command-gaps` 曾 60s 超时但本会话**未复现**，同样保持未验证",
  },
];

export interface FaultMatrixAuditEntry extends FaultInjectionEntry {
  isAccepted: boolean;
  reason: string | null;
  /** 证据引用中**实际存在**的文件（用于核对）。 */
  existingEvidenceFilePaths: string[];
}

export interface FaultMatrixAuditOutcome {
  entries: FaultMatrixAuditEntry[];
  /** 矩阵是否覆盖卡内点名的**全部**覆盖维度。 */
  isCoverageComplete: boolean;
  missingCoverageDimensions: FaultCoverageDimension[];
  /** 结论为"未验证/有缺口"的条目（**不得**视为通过）。 */
  unverifiedEntryIdentifiers: string[];
  isAccepted: boolean;
  reason: string | null;
}

const REQUIRED_COVERAGE_DIMENSIONS: readonly FaultCoverageDimension[] = [
  "same-key-concurrency",
  "different-argument-replay",
  "cancel-complete-race",
  "disk-full",
  "corrupted-record",
  "zero-budget",
  "permission-revocation",
  "rest-boundary",
  "parent-process-exit",
  "child-process-timeout",
];

/**
 * 审计故障注入矩阵（**纯函数 + 只读存在性检查**）。
 *
 * fail-closed 规则：
 *  - `confirmed` / `fixed` **必须**给出至少一个证据引用，且引用的文件**必须存在**；
 *  - `not-verified` / `gap` **不得**给出证据引用（不能拿别的测试冒充已证实）；
 *  - 卡内点名的覆盖维度若有缺失 ⇒ 矩阵**不完整**（`isCoverageComplete: false`）。
 *
 * 注意：`isAccepted` 表示"矩阵本身**如实地**登记了现状"，
 * **不表示**可靠性要求已满足 —— 仍有未验证条目时调用方必须看到它们。
 */
export function auditFaultInjectionMatrix(input: {
  entries: readonly FaultInjectionEntry[];
  repositoryRoot: string;
}): FaultMatrixAuditOutcome {
  const entries = input.entries.map((entry) => {
    const evidenceFilePaths = entry.evidenceFilePaths ?? [];
    const existingEvidenceFilePaths = evidenceFilePaths.filter((relativePath) =>
      existsSync(path.join(input.repositoryRoot, relativePath)),
    );
    const base = { ...entry, existingEvidenceFilePaths };
    const requiresEvidence = entry.verdict === "confirmed" || entry.verdict === "fixed";
    if (requiresEvidence) {
      if (evidenceFilePaths.length === 0) {
        return {
          ...base,
          isAccepted: false,
          reason: "结论为已证实/已修，但**未提供证据引用**（不得空口宣称）",
        };
      }
      if (existingEvidenceFilePaths.length !== evidenceFilePaths.length) {
        const missing = evidenceFilePaths.filter(
          (relativePath) => !existingEvidenceFilePaths.includes(relativePath),
        );
        return {
          ...base,
          isAccepted: false,
          reason: "证据引用的文件不存在（引用必须可核对）: " + missing.join(","),
        };
      }
      return { ...base, isAccepted: true, reason: null };
    }
    if (evidenceFilePaths.length > 0) {
      return {
        ...base,
        isAccepted: false,
        reason:
          "结论为未验证/有缺口，却提供了证据引用（不得拿未覆盖的测试冒充已证实）",
      };
    }
    return { ...base, isAccepted: true, reason: null };
  });

  const coveredDimensions = new Set(entries.map((entry) => entry.dimension));
  const missingCoverageDimensions = REQUIRED_COVERAGE_DIMENSIONS.filter(
    (dimension) => !coveredDimensions.has(dimension),
  );
  const isCoverageComplete = missingCoverageDimensions.length === 0;
  const unverifiedEntryIdentifiers = entries
    .filter((entry) => entry.verdict === "not-verified" || entry.verdict === "gap")
    .map((entry) => entry.entryIdentifier);

  const rejectedEntries = entries.filter((entry) => !entry.isAccepted);
  return {
    entries,
    isCoverageComplete,
    missingCoverageDimensions,
    unverifiedEntryIdentifiers,
    isAccepted: rejectedEntries.length === 0 && isCoverageComplete,
    reason:
      rejectedEntries.length > 0
        ? "存在不成立的矩阵条目: " + rejectedEntries.map((entry) => entry.entryIdentifier).join(",")
        : isCoverageComplete
          ? null
          : "覆盖维度缺失: " + missingCoverageDimensions.join(","),
  };
}
