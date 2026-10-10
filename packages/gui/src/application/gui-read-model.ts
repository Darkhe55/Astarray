/**
 * GUI 只读视图模型（GUI-01-R-02）。
 *
 * 只消费公共应用服务与公开事件；不复制核心状态机。
 * 输出为脱敏 JSON（无凭据、无内部路径、无 .env）。
 */
import type { AgentMode } from "../../../core/src/core/types.js";

export interface GuiTaskView {
  taskIdentifier: string;
  missionIdentifier: string | null;
  status: string;
  revision: number;
}

export interface GuiSnapshot {
  sessionId: string;
  mode: AgentMode;
  connectionStatus: "connected";
  tasks: GuiTaskView[];
  missions: string[];
  /**
   * SMART-01-04：指令窗口的只读视图（容量 / 计数 / 逐条标签）。
   *
   * `isWorkCompleted` 只对 `completed` 为真：卡内硬要求"UI 状态不冒充成果完成"，
   * 因此 `dispatched`（已派发）、`awaiting-clarification`（等待澄清）与排队一律为 false。
   * **始终存在**（未提供窗口时为空窗口），保证快照形状唯一、不伪造指令。
   */
  instructions: GuiInstructionWindowView;
  /**
   * PROJECT-01-04：跨项目授权与副本的只读视图。
   *
   * 卡内验收要求"可追溯、不串数据"且"**人工能分辨副本与原件**"：
   * 副本回执必须带 `isCopyOfExternalSource` 与可读 `displayLabel`（含来源项目与 revision）。
   * **始终存在**（未提供时为空列表）。
   */
  crossProject: GuiCrossProjectView;
  /** TOOLKIT-01-04：工具包版本与升级差异（**始终存在**，缺省为空视图）。 */
  toolPackages: GuiToolPackageView;
}

export interface GuiCrossProjectAuthorizationView {
  authorizationIdentifier: string;
  sourceProjectIdentifier: string;
  targetProjectIdentifier: string;
  operationKind: string;
  state: string;
  taskIdentifier: string;
}

export interface GuiCrossProjectCopyReceiptView {
  receiptIdentifier: string;
  sourceProjectIdentifier: string;
  sourceRevision: number;
  targetProjectIdentifier: string;
  sourceResourcePath: string;
  targetResourcePath: string;
  /** 恒为 true：明确标记"这是外部来源的副本"，供人工与原件分辨。 */
  isCopyOfExternalSource: boolean;
  /** 人工可读标签（含"副本"字样与来源项目/revision）。 */
  displayLabel: string;
}

export interface GuiCrossProjectView {
  authorizations: GuiCrossProjectAuthorizationView[];
  copyReceipts: GuiCrossProjectCopyReceiptView[];
}

/** 把跨项目授权与副本回执映射为 GUI 只读视图（纯函数；副本显式标注、人工可分辨）。 */
export function buildGuiCrossProjectView(input: {
  authorizations: Array<{
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    targetProjectIdentifier: string;
    operationKind: string;
    state: string;
    taskIdentifier: string;
  }>;
  copyReceipts: Array<{
    receiptIdentifier: string;
    sourceProjectIdentifier: string;
    sourceRevision: number;
    targetProjectIdentifier: string;
    sourceResourcePath: string;
    targetResourcePath: string;
    isCopyOfExternalSource?: boolean;
  }>;
}): GuiCrossProjectView {
  return {
    authorizations: input.authorizations.map((authorization) => ({
      authorizationIdentifier: authorization.authorizationIdentifier,
      sourceProjectIdentifier: authorization.sourceProjectIdentifier,
      targetProjectIdentifier: authorization.targetProjectIdentifier,
      operationKind: authorization.operationKind,
      state: authorization.state,
      taskIdentifier: authorization.taskIdentifier,
    })),
    copyReceipts: input.copyReceipts.map((receipt) => ({
      receiptIdentifier: receipt.receiptIdentifier,
      sourceProjectIdentifier: receipt.sourceProjectIdentifier,
      sourceRevision: receipt.sourceRevision,
      targetProjectIdentifier: receipt.targetProjectIdentifier,
      sourceResourcePath: receipt.sourceResourcePath,
      targetResourcePath: receipt.targetResourcePath,
      // 卡内要求"人工能分辨副本与原件"：此处恒为 true 并由 displayLabel 明确写出。
      isCopyOfExternalSource: true,
      displayLabel:
        "副本 " +
        receipt.sourceProjectIdentifier +
        "@r" +
        String(receipt.sourceRevision) +
        " " +
        receipt.sourceResourcePath +
        " → " +
        receipt.targetProjectIdentifier +
        " " +
        receipt.targetResourcePath,
    })),
  };
}

export interface GuiInstructionView {
  instructionIdentifier: string;
  instructionText: string;
  state: string;
  admittedAtIso: string;
  /** 可渲染状态标签。 */
  stateLabel: string;
  /** 是否处于排队区（与窗口内可分辨）。 */
  isQueued: boolean;
  /** 是否可视为"工作成果完成"（只有 `completed` 为 true）。 */
  isWorkCompleted: boolean;
}

export interface GuiInstructionWindowView {
  capacity: number;
  activeCount: number;
  queuedCount: number;
  rows: GuiInstructionView[];
}

/** 指令状态 → 展示标签（与 TUI 同一口径；`dispatched` 只表示"已派发"）。 */
function guiInstructionStateLabel(state: string): string {
  switch (state) {
    case "dispatched":
      return "已派发";
    case "accepted":
      return "排队";
    case "awaiting-clarification":
      return "等待澄清";
    case "partially-completed":
      return "部分完成";
    case "completed":
      return "成果完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    case "rejected":
      return "拒绝";
    default:
      return state;
  }
}

/** 把指令窗口快照映射为 GUI 只读视图（纯函数；不做任何 I/O）。 */
export function buildGuiInstructionWindowView(input: {
  windowCapacity: number;
  activeInstructions: Array<{
    instructionIdentifier: string;
    instructionText: string;
    state: string;
    admittedAtIso: string;
  }>;
  queuedInstructions: Array<{
    instructionIdentifier: string;
    instructionText: string;
    state: string;
    admittedAtIso: string;
  }>;
}): GuiInstructionWindowView {
  const rows: GuiInstructionView[] = [
    ...input.activeInstructions.map((record) => ({
      ...record,
      stateLabel: guiInstructionStateLabel(record.state),
      isQueued: false,
      isWorkCompleted: record.state === "completed",
    })),
    ...input.queuedInstructions.map((record) => ({
      ...record,
      // 排队区一律显示"排队"，不沿用可能过期的内部状态。
      stateLabel: "排队",
      isQueued: true,
      isWorkCompleted: false,
    })),
  ];
  return {
    capacity: input.windowCapacity,
    activeCount: input.activeInstructions.length,
    queuedCount: input.queuedInstructions.length,
    rows,
  };
}

export interface GuiTaskTrackerView {
  tasksByIdentifier: Map<string, GuiTaskView>;
  missions: Set<string>;
}

export function createGuiTaskTracker(): GuiTaskTrackerView {
  return { tasksByIdentifier: new Map(), missions: new Set() };
}

export function applyGuiEventToTracker(
  tracker: GuiTaskTrackerView,
  event: {
    eventType: string;
    taskIdentifier?: string;
    status?: string;
    missionIdentifier?: string | null;
    revision?: number;
  },
): void {
  if (event.eventType === "task-status" || event.eventType === "task-finished") {
    const taskIdentifier = event.taskIdentifier;
    if (typeof taskIdentifier !== "string") {
      return;
    }
    const previous = tracker.tasksByIdentifier.get(taskIdentifier);
    tracker.tasksByIdentifier.set(taskIdentifier, {
      taskIdentifier,
      missionIdentifier: event.missionIdentifier ?? previous?.missionIdentifier ?? null,
      status: event.status ?? previous?.status ?? "accepted",
      revision: Math.max(previous?.revision ?? 0, event.revision ?? 0),
    });
    const missionIdentifier =
      event.missionIdentifier ?? previous?.missionIdentifier ?? null;
    if (missionIdentifier !== null) {
      tracker.missions.add(missionIdentifier);
    }
  }
}

export function buildGuiSnapshot(input: {
  sessionId: string;
  mode: AgentMode;
  tracker: GuiTaskTrackerView;
  /** SMART-01-04：指令窗口快照（缺省为空窗口；不伪造指令）。 */
  instructionWindow?: {
    windowCapacity: number;
    activeInstructions: Parameters<typeof buildGuiInstructionWindowView>[0]["activeInstructions"];
    queuedInstructions: Parameters<typeof buildGuiInstructionWindowView>[0]["queuedInstructions"];
  };
  /** PROJECT-01-04：跨项目授权与副本（缺省为空列表；不伪造授权）。 */
  crossProject?: Parameters<typeof buildGuiCrossProjectView>[0];
  /**
   * TOOLKIT-01-04：工具包版本与升级差异（缺省为空视图；**不伪造**条目）。
   *
   * 卡内 §11 要求用户"能看懂升级权限差异并拒绝" ⇒ 该视图必须能被界面取到，
   * 否则差异只存在于 CLI。
   */
  toolPackages?: Parameters<typeof buildGuiToolPackageView>[0];
}): GuiSnapshot {
  return {
    sessionId: input.sessionId,
    mode: input.mode,
    connectionStatus: "connected",
    tasks: [...input.tracker.tasksByIdentifier.values()].sort((left, right) =>
      left.taskIdentifier.localeCompare(right.taskIdentifier),
    ),
    missions: [...input.tracker.missions].sort(),
    instructions:
      input.instructionWindow === undefined
        ? { capacity: 0, activeCount: 0, queuedCount: 0, rows: [] }
        : buildGuiInstructionWindowView(input.instructionWindow),
    crossProject:
      input.crossProject === undefined
        ? { authorizations: [], copyReceipts: [] }
        : buildGuiCrossProjectView(input.crossProject),
    toolPackages:
      input.toolPackages === undefined
        ? { versions: [], upgradeDifferences: [] }
        : buildGuiToolPackageView(input.toolPackages),
  };
}

/* ────────── TOOLKIT-01-04：工具包版本与升级差异只读视图 ────────── */

export interface GuiToolPackageVersionInput {
  toolPackageId: string;
  version: number;
  contentHash: string;
  /** 变更 revision（启用/停用/锁定按 revision 原子提交）。 */
  revision: number;
  scope: string;
  status: string;
  readableName: string;
  sourceProjectIdentifier: string;
  enabledProjectIdentifiers: string[];
}

export interface GuiToolPackageVersionView {
  toolPackageId: string;
  version: number;
  contentHash: string;
  revision: number;
  scope: string;
  status: string;
  /** 人工可读状态标签（卡内要求用户能区分草案/已验证/已启用等）。 */
  statusDisplayLabel: string;
  /** 人工可读作用域标签（项目专用 / 用户级 / 通用）。 */
  scopeDisplayLabel: string;
  readableName: string;
  sourceProjectIdentifier: string;
  enabledProjectIdentifiers: string[];
}

export interface GuiToolPackageUpgradeDifferenceInput {
  toolPackageId: string;
  fromVersion: number;
  toVersion: number;
  addedSideEffects: string[];
  removedSideEffects: string[];
  dependencyDifferences: string[];
  permissionDifferences: string[];
  requiresReauthorization: boolean;
}

export interface GuiToolPackageUpgradeDifferenceView
  extends GuiToolPackageUpgradeDifferenceInput {
  /**
   * 可读摘要：让用户**看懂差异并据此拒绝**（卡内 §11）。
   *
   * 必须显式写出"需要/无需重新授权"，差异为空时如实写"无差异"——
   * 留白会让人误以为"没有变化"或"不知道有没有变化"。
   */
  displaySummary: string;
}

export interface GuiToolPackageView {
  versions: GuiToolPackageVersionView[];
  upgradeDifferences: GuiToolPackageUpgradeDifferenceView[];
}

/**
 * 状态 → 人工可读标签（与术语表口径一致：草案/已验证/已启用/已拒绝/已停用/已废弃）。
 *
 * **未知状态必须显式标为未知**：默认回落到"已启用"之类的乐观值会让用户误判，
 * 从而在未真正启用的工具包上做决策。
 */
function guiToolPackageStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "草案";
    case "validated":
      return "已验证";
    case "enabled":
      return "已启用";
    case "rejected":
      return "已拒绝";
    case "disabled":
      return "已停用";
    case "deprecated":
      return "已废弃";
    default:
      return "未知状态(" + status + ")";
  }
}

/** 作用域 → 人工可读标签（项目专用 / 用户级 / 通用）。 */
function guiToolPackageScopeLabel(scope: string): string {
  switch (scope) {
    case "project":
      return "项目专用";
    case "user":
      return "用户级";
    case "portable":
      return "通用";
    default:
      return "未知作用域(" + scope + ")";
  }
}

function buildUpgradeDifferenceSummary(
  difference: GuiToolPackageUpgradeDifferenceInput,
): string {
  const added = difference.addedSideEffects.join(",");
  const removed = difference.removedSideEffects.join(",");
  const dependencies = difference.dependencyDifferences.join(",");
  const permissions = difference.permissionDifferences.join(",");
  const isIdentical =
    added === "" && removed === "" && dependencies === "" && permissions === "";
  return (
    "v" +
    String(difference.fromVersion) +
    " → v" +
    String(difference.toVersion) +
    "：" +
    (isIdentical ? "无差异" : "") +
    (added === "" ? "" : " 新增副作用: " + added) +
    (removed === "" ? "" : " 移除副作用: " + removed) +
    (dependencies === "" ? "" : " 依赖差异: " + dependencies) +
    (permissions === "" ? "" : " 权限差异: " + permissions) +
    (difference.requiresReauthorization ? "；需要重新授权（新增副作用）" : "；无需重新授权")
  );
}

/**
 * 构造工具包只读视图（**纯函数**）。
 *
 * 未提供输入时返回空视图（**形状唯一、不伪造条目**），
 * 使 GUI/TUI 渲染层无需做存在性判断。
 */
export function buildGuiToolPackageView(input: {
  versions?: GuiToolPackageVersionInput[];
  upgradeDifferences?: GuiToolPackageUpgradeDifferenceInput[];
}): GuiToolPackageView {
  return {
    versions: (input.versions ?? []).map((version) => ({
      toolPackageId: version.toolPackageId,
      version: version.version,
      contentHash: version.contentHash,
      revision: version.revision,
      scope: version.scope,
      status: version.status,
      statusDisplayLabel: guiToolPackageStatusLabel(version.status),
      scopeDisplayLabel: guiToolPackageScopeLabel(version.scope),
      readableName: version.readableName,
      sourceProjectIdentifier: version.sourceProjectIdentifier,
      enabledProjectIdentifiers: [...version.enabledProjectIdentifiers],
    })),
    upgradeDifferences: (input.upgradeDifferences ?? []).map((difference) => ({
      ...difference,
      addedSideEffects: [...difference.addedSideEffects],
      removedSideEffects: [...difference.removedSideEffects],
      dependencyDifferences: [...difference.dependencyDifferences],
      permissionDifferences: [...difference.permissionDifferences],
      displaySummary: buildUpgradeDifferenceSummary(difference),
    })),
  };
}