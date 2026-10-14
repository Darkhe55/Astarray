/**
 * GUI 只读视图模型（GUI-01-R-02）。
 *
 * 只消费公共应用服务与公开事件；不复制核心状态机。
 * 输出为脱敏 JSON（无凭据、无内部路径、无 .env）。
 */
import type { AgentMode } from "../../../core/src/core/types.js";
import { buildContextVisibilityDisplayRows } from "../../../core/src/toolkit/context-visibility-view.js";

export interface GuiTaskView {
  taskIdentifier: string;
  missionIdentifier: string | null;
  status: string;
  revision: number;
}

/**
 * MERGE-01-03：构造参数授权设置的 **GUI 只读视图**。
 *
 * 三态语义要点：来源不可用时用 `null` + `isAvailable: false` 如实表示"未知"，
 * **不得**退化成 `false`（会被读成"已关闭"）或 `true`（会被读成"默认开启"）。
 */
export function buildGuiParameterAuthorizationSettingsView(
  input:
    | {
        isParameterAuthorizationEnabled: boolean;
        isParameterRulesEnabled: boolean;
        configurationRevision: number;
        ruleCount: number;
      }
    | undefined,
): GuiParameterAuthorizationSettingsView {
  if (input === undefined) {
    return {
      isAvailable: false,
      isParameterAuthorizationEnabled: null,
      isParameterRulesEnabled: null,
      configurationRevision: null,
      ruleCount: null,
      mayWidenPermissions: false,
      isReadOnly: true,
      hasWriteAction: false,
      displayText: "参数授权设置未知（来源不可用；不假定默认开启）——只读，修改需经 SDK/CLI 确认门禁",
    };
  }
  /**
   * 细分关闭（或总开关关闭）⇒ 原先被 deny/ask 拦截的参数会回退 allow
   * ⇒ 必须提示"可能放宽"，而不是中性的"功能已关闭"。
   */
  const mayWidenPermissions =
    !input.isParameterAuthorizationEnabled || !input.isParameterRulesEnabled;
  const displayText = mayWidenPermissions
    ? "参数授权细分已关闭：被 deny/ask 拦截的参数将回退 allow（**可能放宽权限**）；" +
      "只读视图，放宽需既有认证用户确认后经 SDK/CLI 生效"
    : "参数授权总开关已启用、每工具细分已启用（未放宽）；只读视图";
  return {
    isAvailable: true,
    isParameterAuthorizationEnabled: input.isParameterAuthorizationEnabled,
    isParameterRulesEnabled: input.isParameterRulesEnabled,
    configurationRevision: input.configurationRevision,
    ruleCount: input.ruleCount,
    mayWidenPermissions,
    isReadOnly: true,
    hasWriteAction: false,
    displayText,
  };
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
  /**
   * NODECTX-01-03：上下文可见性四态（**始终存在**，缺省为空视图）。
   *
   * 卡内纪律："**不把"不在上下文"显示成删除**" ⇒ 视图行必须携带
   * `isShownAsDeleted: false` 与"原文完整保留、可回访"的文案。
   */
  contextVisibility: GuiContextVisibilityRowView[];
  /**
   * MERGE-01-03：参数授权设置视图（**始终存在**，缺省为空视图）。
   *
   * 卡内检查点 03 要求"CLI/TUI/GUI/SDK 设置一致"。GUI 只读：
   * **扩大权限需既有认证用户确认**，故 GUI **不提供写入路径**。
   */
  parameterAuthorizationSettings: GuiParameterAuthorizationSettingsView;
}

/** MERGE-01-03：参数授权设置的 **GUI 只读视图**。 */
export interface GuiParameterAuthorizationSettingsView {
  /** 来源是否可用（**不可用时不得显示成"默认开启"**）。 */
  isAvailable: boolean;
  /** 不可用时为 null（而不是 false —— false 会被误读成"已关闭"）。 */
  isParameterAuthorizationEnabled: boolean | null;
  isParameterRulesEnabled: boolean | null;
  configurationRevision: number | null;
  ruleCount: number | null;
  /**
   * 该配置**可能放宽**权限（细分已关闭时，原先被 deny/ask 拦截的参数会回退 allow）。
   *
   * 卡内："**关闭细分若会从 deny/ask 回退 allow，必须明确提示放宽范围，
   * 不以'关闭功能'静默扩大权限**"。
   */
  mayWidenPermissions: boolean;
  /** GUI 视图恒为只读。 */
  isReadOnly: true;
  /** GUI **没有**写入动作（不得成为放宽权限的旁路）。 */
  hasWriteAction: false;
  displayText: string;
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

/** 缺失字段的展示文案：必须是「（未知）」而不是空串 —— 空串看起来像「有值但为空」。 */
const GUI_MISSION_UNKNOWN_TEXT = "（未知）";

/** 损坏记录的展示文案。 */
const GUI_MISSION_CORRUPTED_TEXT = "记录损坏";

/**
 * **历史状态**→展示标签（磁盘上"当时"记录的 `status`）。
 *
 * 注意用「（当时记录）」后缀：历史列**只说历史**，
 * 不与运行列混同 —— 这正是卡内要求的"历史状态与运行状态分离"。
 */
function guiMissionRecordedStatusLabel(recordedStatus: string | null): string {
  switch (recordedStatus) {
    case "running":
      return "运行中（当时记录）";
    case "done":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "blocked":
      return "已阻塞";
    default:
      return "未知";
  }
}

/** **运行状态**→展示标签（"现在是否真的在跑"）。 */
function guiMissionRuntimeStateLabel(runtimeState: string): string {
  switch (runtimeState) {
    case "running":
      return "运行中";
    case "finished":
      return "已结束";
    case "interrupted-needs-reconciliation":
      return "已中断，待对账";
    case "corrupted-needs-attention":
      return GUI_MISSION_CORRUPTED_TEXT;
    default:
      return "未知";
  }
}

/** 输入只取展示所需字段（结构上兼容核心层 `MissionHistoryEntry`）。 */
export interface GuiMissionHistoryEntryInput {
  missionIdentifier: string;
  prompt: string | null;
  mode: string | null;
  projectIdentifier: string | null;
  createdAtIso: string | null;
  recordedStatus: string | null;
  runtimeState: string;
  isActivelyRunning: boolean;
  isCorrupted: boolean;
}

export interface GuiMissionHistoryPageInput {
  entries: GuiMissionHistoryEntryInput[];
  pageIndex: number;
  effectivePageSize: number;
  totalMissionCount: number;
  hasMorePages: boolean;
}

/** **列表视图**的一行。 */
export interface GuiMissionHistoryRowView {
  missionIdentifier: string;
  promptText: string;
  projectText: string;
  createdAtText: string;
  recordedStatusText: string;
  runtimeStateText: string;
  isActivelyRunning: boolean;
  isCorrupted: boolean;
  corruptedText: string | null;
}

export interface GuiMissionHistoryListView {
  rows: GuiMissionHistoryRowView[];
  pageIndex: number;
  pagingLabel: string;
  totalMissionCountText: string;
  isMoreAvailable: boolean;
  emptyStateText: string;
  hasRows: boolean;
}

export interface GuiMissionHistoryDetailView {
  missionIdentifier: string;
  promptText: string;
  modeText: string;
  projectText: string;
  createdAtText: string;
  recordedStatusText: string;
  runtimeStateText: string;
  isActivelyRunning: boolean;
  isCorrupted: boolean;
  corruptedText: string | null;
}

export interface GuiMissionHistoryRawView {
  missionIdentifier: string;
  rawRecord: Record<string, unknown>;
  rawJsonText: string;
}

function toGuiMissionHistoryRow(record: GuiMissionHistoryEntryInput): GuiMissionHistoryRowView {
  return {
    missionIdentifier: record.missionIdentifier,
    promptText: record.prompt ?? GUI_MISSION_UNKNOWN_TEXT,
    projectText: record.projectIdentifier ?? GUI_MISSION_UNKNOWN_TEXT,
    createdAtText: record.createdAtIso ?? GUI_MISSION_UNKNOWN_TEXT,
    recordedStatusText: guiMissionRecordedStatusLabel(record.recordedStatus),
    runtimeStateText: guiMissionRuntimeStateLabel(record.runtimeState),
    isActivelyRunning: record.isActivelyRunning,
    isCorrupted: record.isCorrupted,
    corruptedText: record.isCorrupted ? GUI_MISSION_CORRUPTED_TEXT : null,
  };
}

/**
 * **列表视图**（三视图之一）：只渲染**本页**行 + 分页信息。
 *
 * `pageInput.entries` 由调用方按页取（核心层保证"只读本页"），
 * 本函数**不会**去读任何数据、**不会**渲染整库 —— 它只看传进来的这一页。
 */
export function buildGuiMissionHistoryListView(
  pageInput: GuiMissionHistoryPageInput,
): GuiMissionHistoryListView {
  const rows = pageInput.entries.map(toGuiMissionHistoryRow);
  return {
    rows,
    pageIndex: pageInput.pageIndex,
    // 例如「第 1 页 · 本页 2 条」
    pagingLabel:
      "第 " + String(pageInput.pageIndex + 1) + " 页 · 本页 " + String(rows.length) + " 条",
    totalMissionCountText: "共 " + String(pageInput.totalMissionCount) + " 条历史",
    isMoreAvailable: pageInput.hasMorePages,
    emptyStateText: "暂无历史任务。",
    hasRows: rows.length > 0,
  };
}

/** **详情视图**（三视图之二）：单条完整字段。 */
export function buildGuiMissionHistoryDetailView(
  record: GuiMissionHistoryEntryInput,
): GuiMissionHistoryDetailView {
  return {
    missionIdentifier: record.missionIdentifier,
    promptText: record.prompt ?? GUI_MISSION_UNKNOWN_TEXT,
    modeText: record.mode ?? GUI_MISSION_UNKNOWN_TEXT,
    projectText: record.projectIdentifier ?? GUI_MISSION_UNKNOWN_TEXT,
    createdAtText: record.createdAtIso ?? GUI_MISSION_UNKNOWN_TEXT,
    recordedStatusText: guiMissionRecordedStatusLabel(record.recordedStatus),
    runtimeStateText: guiMissionRuntimeStateLabel(record.runtimeState),
    isActivelyRunning: record.isActivelyRunning,
    isCorrupted: record.isCorrupted,
    corruptedText: record.isCorrupted ? GUI_MISSION_CORRUPTED_TEXT : null,
  };
}

/**
 * **原始视图**（三视图之三）：**未归一**的原样记录，供核对。
 *
 * 刻意**不做**任何标签替换 —— 让用户能看到"磁盘上到底写了什么"。
 * 同时仍带上运行态字段（原始视图也不该只给一半）。
 */
export function buildGuiMissionHistoryRawView(
  record: GuiMissionHistoryEntryInput,
): GuiMissionHistoryRawView {
  const rawRecord: Record<string, unknown> = {
    missionIdentifier: record.missionIdentifier,
    prompt: record.prompt,
    mode: record.mode,
    projectIdentifier: record.projectIdentifier,
    createdAtIso: record.createdAtIso,
    recordedStatus: record.recordedStatus,
    runtimeState: record.runtimeState,
    isActivelyRunning: record.isActivelyRunning,
    isCorrupted: record.isCorrupted,
  };
  return {
    missionIdentifier: record.missionIdentifier,
    rawRecord,
    rawJsonText: JSON.stringify(rawRecord, null, 2),
  };
}

/**
 * GUI-02-04（2026-11-08）：**会话视图为空**时必须给出的说明。
 *
 * 为什么必须有它：`/state` 的任务列表是**本会话视图**，进程重启后**必然为空**。
 * 若界面只把列表清空、不写任何字（实测现状），用户会理解为"数据丢了"——
 * 这正是卡内禁止的"**重启后界面误导**"。
 *
 * 文案被界面与测试**共同引用同一常量**，避免两处各写一份而漂移。
 */
export const GUI_SESSION_VIEW_EMPTY_EXPLANATION =
  "本会话视图为空：这不代表数据丢失。进程重启后当前会话没有任务，" +
  "历史任务与磁盘状态仍在——请在下方「恢复中心」核对 mission 与检查点后再决定是否恢复。";

export interface GuiTaskRowView {
  taskIdentifier: string;
  rowText: string;
}

export interface GuiTaskListView {
  rows: GuiTaskRowView[];
  isEmpty: boolean;
  /** 为空时给出说明；非空时为 null（不给噪音）。 */
  emptyExplanation: string | null;
}

/**
 * **任务列表视图**：把"空"这件事**显式说清楚**，而不是留一片空白。
 */
export function buildGuiTaskListView(
  tasks: Array<{ taskIdentifier: string; status: string; revision: number }>,
): GuiTaskListView {
  const rows: GuiTaskRowView[] = tasks.map((task) => ({
    taskIdentifier: task.taskIdentifier,
    rowText: task.taskIdentifier + " · " + task.status + " · r" + String(task.revision),
  }));
  return {
    rows,
    isEmpty: rows.length === 0,
    emptyExplanation: rows.length === 0 ? GUI_SESSION_VIEW_EMPTY_EXPLANATION : null,
  };
}

/** 恢复闸门的三道门（顺序固定）。 */
export type GuiRecoveryGate = "explicit-confirmation" | "reconciliation" | "reauthorization";

export interface GuiRecoveryGateDecision {
  isAllowed: boolean;
  /** 被拦下的**第一道**门（允许时为 null）—— 按固定顺序，避免一次抛出一堆理由。 */
  blockedGate: GuiRecoveryGate | null;
  /** 全部未满足的门（便于界面逐项提示"还差什么"）。 */
  allBlockedGates: GuiRecoveryGate[];
  reasonText: string | null;
}

/**
 * GUI-02-04：**恢复闸门**（显式 → 对账 → 重新鉴权）。
 *
 * 卡内要求"恢复须**显式** + **先对账** + **重新鉴权**"，三者缺一不可：
 * - **显式**：必须由用户主动确认 —— "点开就恢复"是禁止的；
 * - **对账**：必须先完成对账（否则可能把未知状态当成已恢复）；
 * - **重新鉴权**：必须重新鉴权（重启后旧会话凭据不再被默认信任）。
 *
 * 本函数是**纯函数**，因此这套门是**可测的契约**，而不是靠界面自觉。
 */
export function evaluateGuiRecoveryGate(input: {
  hasExplicitUserConfirmation: boolean;
  isReconciliationSatisfied: boolean;
  isReauthorizationSatisfied: boolean;
}): GuiRecoveryGateDecision {
  const allBlockedGates: GuiRecoveryGate[] = [];
  if (!input.hasExplicitUserConfirmation) {
    allBlockedGates.push("explicit-confirmation");
  }
  if (!input.isReconciliationSatisfied) {
    allBlockedGates.push("reconciliation");
  }
  if (!input.isReauthorizationSatisfied) {
    allBlockedGates.push("reauthorization");
  }

  if (allBlockedGates.length === 0) {
    return { isAllowed: true, blockedGate: null, allBlockedGates, reasonText: null };
  }

  const blockedGate = allBlockedGates[0]!;
  const reasonTextByGate: Record<GuiRecoveryGate, string> = {
    "explicit-confirmation": "恢复必须由你**显式**确认（不提供“点开即恢复”）",
    reconciliation: "恢复前必须**先完成对账**（未知状态不得当成已恢复）",
    reauthorization: "恢复前必须**重新鉴权**（重启后旧会话授权不被默认信任）",
  };
  return {
    isAllowed: false,
    blockedGate,
    allBlockedGates,
    reasonText: reasonTextByGate[blockedGate],
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
  /** NODECTX-01-03：上下文可见性展示输入（缺省为空列表；**不伪造行**）。 */
  contextVisibility?: Parameters<typeof buildContextVisibilityDisplayRows>[0];
  /** MERGE-01-03：参数授权设置（缺省 ⇒ 空视图，**不伪造默认开启**）。 */
  parameterAuthorizationSettings?: Parameters<
    typeof buildGuiParameterAuthorizationSettingsView
  >[0];
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
    contextVisibility: buildContextVisibilityDisplayRows(input.contextVisibility ?? []),
    parameterAuthorizationSettings: buildGuiParameterAuthorizationSettingsView(
      input.parameterAuthorizationSettings,
    ),
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

/** NODECTX-01-03：上下文可见性展示行（GUI 只读）。 */
export type GuiContextVisibilityRowView = ReturnType<
  typeof buildContextVisibilityDisplayRows
>[number];

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