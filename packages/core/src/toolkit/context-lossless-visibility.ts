/**
 * NODECTX-01-01：**有损兜底盘点** 与 **节点可见性**语义（2026-10-10）。
 *
 * 契约来源：`docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md` §2.1 / §2.2 与检查点 01。
 *
 * 卡内硬要求逐条落实：
 *  - "所有 Astarray **可控制的**……语义压缩、滚动摘要替代历史、静默截断兜底**均禁用**，
 *    **不提供重新开启该机制的开关**" ⇒ 处置只有"禁用并移除 / 改写为无损 /
 *    声明不支持"三类，且 `isReenablable` **恒为 false**；
 *  - "**不把现有 SUM 组件仅改名后继续做有损截断**" ⇒ `rename-only` 是**非法处置**；
 *  - "**仅保证本项目控制的**……Provider 内部不可观察行为**不得宣称已禁用**"
 *    ⇒ 非本项目控制的项**必须**处置为 `declare-unsupported`；
 *  - §2.2 "节点业务执行/验收状态与上下文可见性**分开存储**，
 *    **不能把'暂不入提示词'当 done**" ⇒ 可见性三态与业务状态**互不影响**；
 *  - "永久关闭**不代表物理删除、永不查阅**" ⇒ 恒为"内容仍在盘上、允许显式回访"。
 *
 * 本模块只做**本地确定性判定**：不做 I/O、不联网、不调用模型。
 */

/** 上下文可见性三态（卡内 §2.2 表）。 */
export const CONTEXT_VISIBILITY_STATES = [
  "active",
  "temporarily-closed",
  "permanently-closed",
] as const;
export type ContextVisibilityState = (typeof CONTEXT_VISIBILITY_STATES)[number];

/** 节点业务状态（与可见性**分开存储**）。 */
export type NodeBusinessStatus = "pending" | "in-progress" | "completed" | "failed";

export interface NodeVisibilityRecord {
  nodeIdentifier: string;
  visibilityState: ContextVisibilityState;
  businessStatus: NodeBusinessStatus;
  /**
   * 是否可视为"业务完成"。
   *
   * **只由业务状态决定**：卡内禁止把"暂不入提示词"当 done，
   * 也禁止反过来用可见性宣称完成。
   */
  isBusinessCompleted: boolean;
  /** 原文是否仍在磁盘（永久关闭**不等于**物理删除）。 */
  isContentRetainedOnDisk: true;
  /** 是否允许显式回访（永久关闭仍可查阅）。 */
  isExplicitRecallAllowed: true;
}

export function createNodeVisibilityRecord(input: {
  nodeIdentifier: string;
  visibilityState: ContextVisibilityState;
  businessStatus: NodeBusinessStatus;
}): NodeVisibilityRecord {
  return {
    nodeIdentifier: input.nodeIdentifier,
    visibilityState: input.visibilityState,
    businessStatus: input.businessStatus,
    // 与可见性**无关**：只有业务状态为 completed 才算完成。
    isBusinessCompleted: input.businessStatus === "completed",
    isContentRetainedOnDisk: true,
    isExplicitRecallAllowed: true,
  };
}

/** 该节点当前是否出现在提示词装配里（`active` 才是）。 */
export function isContextVisibleInPrompt(record: NodeVisibilityRecord): boolean {
  return record.visibilityState === "active";
}

/* ────────── 有损兜底盘点 ────────── */

export type LossyKind =
  | "summary-replaces-history"
  | "silent-truncation"
  | "budget-eviction"
  | "budget-silent-reduction"
  | "provider-internal-compaction";

export type LossyDisposition =
  /** 真正禁用并移除该路径（卡内要求的"明确真正禁用点"）。 */
  | "disable-and-remove"
  /** 改写为**无损**替代（例如分页/分段加载，而非截尾）。 */
  | "rewrite-lossless"
  /** 本项目**无法保证**（如 Provider 内部不可观察）⇒ 如实声明不支持。 */
  | "declare-unsupported";

export interface LossyFallbackInventoryEntry {
  fallbackIdentifier: string;
  /** 可定位的代码/装配点（检查点要求"明确真正禁用点"）。 */
  locationIdentifier: string;
  lossKind: LossyKind;
  /** 是否属于**本项目可控**范围。 */
  isUnderOurControl: boolean;
  disposition: LossyDisposition;
}

export interface LossyFallbackAuditEntry extends LossyFallbackInventoryEntry {
  isAccepted: boolean;
  reason: string | null;
  /**
   * 是否可被重新开启。
   *
   * **恒为 false**：卡内"不提供重新开启该机制的开关"。
   */
  isReenablable: false;
}

/**
 * 本仓**实际**有损兜底盘点（2026-10-10 逐处核对）。
 *
 * 每一条都定位到具体代码/装配点，并给出**处置**；`rename-only` 之类的"改术语"不是处置。
 */
export const LOSSY_FALLBACK_INVENTORY: readonly LossyFallbackInventoryEntry[] = [
  {
    fallbackIdentifier: "global-budget-eviction",
    locationIdentifier:
      "packages/core/src/orchestration/context-prompt-assembler.ts（resolveContextBudget）+ context-lifecycle-metrics.ts（global-budget-eviction 事件）",
    lossKind: "budget-eviction",
    isUnderOurControl: true,
    disposition: "rewrite-lossless",
  },
  {
    fallbackIdentifier: "provider-input-space-silent-reduction",
    locationIdentifier:
      "packages/core/src/orchestration/context-prompt-assembler.ts（resolveContextBudget 的 budgetReductionReason）",
    lossKind: "budget-silent-reduction",
    isUnderOurControl: true,
    disposition: "rewrite-lossless",
  },
  {
    fallbackIdentifier: "provider-side-auto-compaction",
    locationIdentifier:
      "Provider 内部（不可观察）；本仓仅能在适配器层声明不支持",
    lossKind: "provider-internal-compaction",
    isUnderOurControl: false,
    disposition: "declare-unsupported",
  },
];

/**
 * 审计盘点（**纯函数**，fail-closed）。
 *
 * 拒绝：
 *  - 非法处置（含 `rename-only` 这类"只改术语"）；
 *  - **非本项目可控**的项被标成"已禁用"（卡内：不得宣称 Provider 内部行为已禁用）；
 *  - 本项目可控的项被处置为 `declare-unsupported`（可控就必须真禁用或改无损）。
 */
export function auditLossyFallbackInventory(
  inventory: readonly LossyFallbackInventoryEntry[],
): LossyFallbackAuditEntry[] {
  return inventory.map((entry) => {
    const base: Omit<LossyFallbackAuditEntry, "isAccepted" | "reason"> = {
      ...entry,
      isReenablable: false,
    };
    const isKnownDisposition =
      entry.disposition === "disable-and-remove" ||
      entry.disposition === "rewrite-lossless" ||
      entry.disposition === "declare-unsupported";
    if (!isKnownDisposition) {
      return {
        ...base,
        isAccepted: false,
        reason:
          "非法处置：" +
          String(entry.disposition) +
          "（只改术语/改名不算处置，必须禁用、改写为无损或声明不支持）",
      };
    }
    if (!entry.isUnderOurControl && entry.disposition !== "declare-unsupported") {
      return {
        ...base,
        isAccepted: false,
        reason:
          "非本项目可控的项不得标为已禁用/已无损（Provider 内部不可观察，只能声明不支持）",
      };
    }
    if (entry.isUnderOurControl && entry.disposition === "declare-unsupported") {
      return {
        ...base,
        isAccepted: false,
        reason:
          "本项目可控的有损项必须**真正禁用或改写为无损**，不得以'声明不支持'回避",
      };
    }
    if (entry.locationIdentifier.trim() === "") {
      return {
        ...base,
        isAccepted: false,
        reason: "缺少可定位的代码/装配点（检查点要求明确真正禁用点）",
      };
    }
    return { ...base, isAccepted: true, reason: null };
  });
}
