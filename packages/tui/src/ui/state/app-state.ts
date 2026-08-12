/**
 * TUI 应用状态（T10）。
 * 纯数据 + 订阅通知；React 渲染只读该状态，不在 render 中执行副作用。
 */
import type { AgentMode, AgentStatus, TaskDependencyNode } from "../../../../core/src/core/types.js";
import { stripAnsiControlSequences } from "../../../../core/src/infra/ansi-sanitizer.js";

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

export class AppState {
  mode: AgentMode = "assist";
  readonly conversation: UiConversationEntry[] = [];
  readonly missions = new Map<string, UiMission>();
  readonly agentStatuses = new Map<string, AgentStatus>();
  readonly mailboxQueueDepths = new Map<string, number>();
  permissionAsk: UiPermissionAsk | null = null;
  showHelp = false;
  inputText = "";
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
}
