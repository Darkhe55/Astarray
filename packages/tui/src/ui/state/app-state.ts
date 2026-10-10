/**
 * TUI 应用状态（T10）。
 * 纯数据 + 订阅通知；React 渲染只读该状态，不在 render 中执行副作用。
 */
import type { AgentMode, AgentStatus, TaskDependencyNode } from "../../../../core/src/core/types.js";
import { stripAnsiControlSequences } from "../../../../core/src/infra/ansi-sanitizer.js";

/** B6R-04b：权限组公开摘要（TUI 面板数据）。 */
export interface UiPermissionProfileSummary {
  permissionProfileId: string;
  displayName: string;
  isBuiltin: boolean;
  revision: number;
}

export type ConversationSource = "user" | "main" | "tool" | "feedback" | "system";

export interface UiConversationEntry {
  entryId: string;
  source: ConversationSource;
  text: string;
}

export interface UiMission {
  missionId: string;
  mode: AgentMode;
  status: string;
  prompt: string;
  tasks: TaskDependencyNode[];
}

export interface UiPermissionAsk {
  missionId: string;
  taskId: string;
  toolName: string;
  argumentsJson: string;
  explanation: string;
}

export interface UiMetricsSnapshot {
  toolCalls: number;
  providerCalls: number;
  estimatedTokenCount: number;
  cacheHits: number;
  cacheMisses: number;
}

export const MAX_CONVERSATION_ENTRIES = 500;

/**
 * SMART-01-04：指令窗口在 TUI 中的展示记录（只取渲染需要的字段）。
 *
 * `state` 沿用指令窗口的既有六态（含 `dispatched` / `awaiting-clarification` / `completed` …），
 * 由 `AppState.getInstructionWindowView()` 映射为**不得冒充成果完成**的标签。
 */
export interface UiInstructionWindowRecord {
  instructionIdentifier: string;
  instructionText: string;
  state: string;
  admittedAtIso: string;
}

export interface UiInstructionWindowRow extends UiInstructionWindowRecord {
  /** 可渲染状态标签（已派发 / 排队 / 等待澄清 / 成果完成 / 失败 / 取消 / 拒绝 / 部分完成）。 */
  stateLabel: string;
  /** 是否处于排队区（与窗口内可分辨）。 */
  isQueued: boolean;
  /**
   * 是否可视为"**工作成果完成**"。
   *
   * 卡内明文：UI 必须区分"已派发"与"工作成果完成"。因此只有 `completed` 为 true；
   * `dispatched`（已派发）、`awaiting-clarification`（等待澄清）、排队与其余非终态一律 false。
   */
  isWorkCompleted: boolean;
}

export interface UiInstructionWindowView {
  capacity: number;
  activeCount: number;
  queuedCount: number;
  rows: UiInstructionWindowRow[];
}

/** 指令状态 → 展示标签（`dispatched` 只表示"已派发"，绝不表示成果完成）。 */
function instructionStateLabel(state: string): string {
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

export class AppState {
  mode: AgentMode = "assist";
  readonly conversation: UiConversationEntry[] = [];
  readonly missions = new Map<string, UiMission>();
  readonly agentStatuses = new Map<string, AgentStatus>();
  readonly mailboxQueueDepths = new Map<string, number>();
  permissionAsk: UiPermissionAsk | null = null;
  showHelp = false;
  inputText = "";
  /** B6R-04b：当前权限组引用显示名快照。 */
  currentPermissionProfileDisplayName: string | null = null;
  /** B6R-04b：权限组公开列表（分页）。 */
  permissionProfiles: UiPermissionProfileSummary[] = [];
  permissionProfilePage = 1;
  permissionProfilePageSize = 20;
  permissionProfileTotal = 0;
  /** B6R-04b：权限组搜索过滤词（空 = 全部）。 */
  permissionProfileSearch = "";
  /** SMART-01-04：指令窗口容量（0 = 未加载）。 */
  private instructionWindowCapacity = 0;
  /** SMART-01-04：窗口内（占用槽位）指令。 */
  private activeInstructions: UiInstructionWindowRecord[] = [];
  /** SMART-01-04：排队区指令（与窗口内可分辨）。 */
  private queuedInstructions: UiInstructionWindowRecord[] = [];
  metrics: UiMetricsSnapshot = {
    toolCalls: 0,
    providerCalls: 0,
    estimatedTokenCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
    this.notify();
  }

  pushConversation(source: ConversationSource, text: string): void {
    // UI 边界统一清洗模型/工具输出中的 ANSI/OSC 控制序列（防终端注入）
    const sanitizedText = stripAnsiControlSequences(text);
    this.conversation.push({
      entryId: `entry-${this.conversation.length}-${Date.now()}`,
      source,
      text: sanitizedText,
    });
    if (this.conversation.length > MAX_CONVERSATION_ENTRIES) {
      this.conversation.splice(0, this.conversation.length - MAX_CONVERSATION_ENTRIES);
    }
    this.notify();
  }

  upsertMission(mission: UiMission): void {
    this.missions.set(mission.missionId, mission);
    this.notify();
  }

  setAgentStatus(agentId: string, status: AgentStatus): void {
    this.agentStatuses.set(agentId, status);
    this.notify();
  }

  setMailboxQueueDepth(agentId: string, depth: number): void {
    this.mailboxQueueDepths.set(agentId, depth);
  }

  openPermissionAsk(ask: UiPermissionAsk): void {
    this.permissionAsk = ask;
    this.notify();
  }

  closePermissionAsk(): void {
    this.permissionAsk = null;
    this.notify();
  }

  toggleHelp(): void {
    this.showHelp = !this.showHelp;
    this.notify();
  }

  setInputText(text: string): void {
    this.inputText = text;
  }

  setMetrics(snapshot: UiMetricsSnapshot): void {
    this.metrics = snapshot;
  }

  // ─── B6R-04b：权限组状态 ──────────────────────────────────────────────

  setPermissionProfiles(input: {
    currentDisplayName: string | null;
    profiles: UiPermissionProfileSummary[];
    page: number;
    pageSize: number;
    total: number;
  }): void {
    this.currentPermissionProfileDisplayName = input.currentDisplayName;
    this.permissionProfiles = input.profiles;
    this.permissionProfilePage = input.page;
    this.permissionProfilePageSize = input.pageSize;
    this.permissionProfileTotal = input.total;
    this.notify();
  }

  // ─── SMART-01-04：指令窗口（窗口内 / 排队；不冒充成果完成）────────────────

  /**
   * 写入指令窗口快照（来自 SDK `queryInstructionWindow` 或 CLI 同一落盘窗口）。
   *
   * 只保存渲染所需事实；`isWorkCompleted` 在读取时按状态映射，避免调用方自行"猜完成"。
   */
  setInstructionWindow(input: {
    windowCapacity: number;
    activeInstructions: UiInstructionWindowRecord[];
    queuedInstructions: UiInstructionWindowRecord[];
  }): void {
    this.instructionWindowCapacity = input.windowCapacity;
    this.activeInstructions = [...input.activeInstructions];
    this.queuedInstructions = [...input.queuedInstructions];
    this.notify();
  }

  /** 清空指令窗口展示（关闭会话/切换状态源时调用，避免展示过期状态）。 */
  clearInstructionWindow(): void {
    this.instructionWindowCapacity = 0;
    this.activeInstructions = [];
    this.queuedInstructions = [];
    this.notify();
  }

  /** 只读渲染视图：排队与窗口内可分辨，且逐条给出"是否成果完成"。 */
  getInstructionWindowView(): UiInstructionWindowView {
    const rows: UiInstructionWindowRow[] = [
      ...this.activeInstructions.map((record) => ({
        ...record,
        stateLabel: instructionStateLabel(record.state),
        isQueued: false,
        isWorkCompleted: record.state === "completed",
      })),
      ...this.queuedInstructions.map((record) => ({
        ...record,
        // 排队区一律显示"排队"，不沿用可能过期的内部状态。
        stateLabel: "排队",
        isQueued: true,
        isWorkCompleted: false,
      })),
    ];
    return {
      capacity: this.instructionWindowCapacity,
      activeCount: this.activeInstructions.length,
      queuedCount: this.queuedInstructions.length,
      rows,
    };
  }
}
