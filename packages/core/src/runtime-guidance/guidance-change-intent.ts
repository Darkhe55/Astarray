/**
 * GUIDE 增量：追加 / 修订 / 新建任务三类运行中指导变更。
 */
import type { GuidanceSourceKind } from "./runtime-guidance.js";

export const GUIDANCE_CHANGE_INTENTS = ["append", "revise", "new-task"] as const;
export type GuidanceChangeIntent = (typeof GUIDANCE_CHANGE_INTENTS)[number];

export interface GuidanceChangeRequest {
  guidanceIdentifier: string;
  guidanceRevision: number;
  changeIntent: GuidanceChangeIntent | null;
  targetTaskIdentifier: string | null;
  newTaskIdentifier?: string | null;
  instructionText: string;
  requestedTaskSequenceRevision: number;
  derivedTaskPriorityTier: number;
  invalidatedArtifactIdentifiers?: string[];
  invalidatedAcceptanceEntryIdentifiers?: string[];
  sourceKind: GuidanceSourceKind;
  sourceIdentifier: string;
}

export type GuidanceChangeStatus = "accepted" | "needs-clarification" | "rejected";

export interface GuidanceChangeDecision {
  status: GuidanceChangeStatus;
  changeIntent: GuidanceChangeIntent | null;
  guidanceIdentifier: string;
  newTaskSequenceRevision: number | null;
  invalidatedArtifactIdentifiers: string[];
  invalidatedAcceptanceEntryIdentifiers: string[];
  isDuplicateDelivery: boolean;
  reasons: string[];
  clarificationQuestion: string | null;
  historyEntryCount: number;
}

export interface GuidanceChangeHistoryEntry {
  taskIdentifier: string;
  taskSequenceRevision: number;
  guidanceIdentifier: string;
  guidanceRevision: number;
  changeIntent: GuidanceChangeIntent;
  instructionText: string;
  appliedAtIso: string;
  invalidatedArtifactIdentifiers: string[];
  invalidatedAcceptanceEntryIdentifiers: string[];
}

export interface GuidanceChangeIntentControllerOptions {
  nowIso?: () => string;
  maximumAgentDerivedPriorityTier?: number;
}

const CLARIFICATION_QUESTION =
  "请明确选择变更类型：append（追加要求）/ revise（修订并要求受影响证据失效）/ new-task（新建独立任务）。";

export class GuidanceChangeIntentController {
  private readonly taskSequenceRevisionByTaskIdentifier = new Map<string, number>();
  private readonly historyByTaskIdentifier = new Map<string, GuidanceChangeHistoryEntry[]>();
  private readonly decisionByDeliveryKey = new Map<string, GuidanceChangeDecision>();
  private readonly knownTaskIdentifiers = new Set<string>();
  private readonly nowIso: () => string;
  private readonly maximumAgentDerivedPriorityTier: number;

  constructor(options: GuidanceChangeIntentControllerOptions = {}) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.maximumAgentDerivedPriorityTier = options.maximumAgentDerivedPriorityTier ?? 1;
  }

  registerExistingTask(taskIdentifier: string, taskSequenceRevision = 1): void {
    this.knownTaskIdentifiers.add(taskIdentifier);
    if (!this.taskSequenceRevisionByTaskIdentifier.has(taskIdentifier)) {
      this.taskSequenceRevisionByTaskIdentifier.set(taskIdentifier, taskSequenceRevision);
    }
  }

  readTaskRevision(taskIdentifier: string): number {
    return this.taskSequenceRevisionByTaskIdentifier.get(taskIdentifier) ?? 1;
  }

  readHistory(taskIdentifier: string): GuidanceChangeHistoryEntry[] {
    return (this.historyByTaskIdentifier.get(taskIdentifier) ?? []).map((entry) => ({
      ...entry,
      invalidatedArtifactIdentifiers: [...entry.invalidatedArtifactIdentifiers],
      invalidatedAcceptanceEntryIdentifiers: [...entry.invalidatedAcceptanceEntryIdentifiers],
    }));
  }

  isCompletionDeclarationStillValid(input: {
    taskIdentifier: string;
    declaredTaskSequenceRevision: number;
  }): boolean {
    return input.declaredTaskSequenceRevision === this.readTaskRevision(input.taskIdentifier);
  }

  applyChange(request: GuidanceChangeRequest): GuidanceChangeDecision {
    const deliveryKey = request.guidanceIdentifier + "@" + String(request.guidanceRevision);
    const previousDecision = this.decisionByDeliveryKey.get(deliveryKey);
    if (previousDecision !== undefined) {
      return { ...previousDecision, isDuplicateDelivery: true };
    }
    const decision = this.evaluate(request);
    this.decisionByDeliveryKey.set(deliveryKey, { ...decision });
    return decision;
  }

  /** 序列化当前状态（跨进程 CLI 历史/revision 需要）。 */
  snapshot(): GuidanceChangeIntentState {
    return {
      schemaVersion: 1,
      taskSequenceRevisionByTaskIdentifier: Object.fromEntries(
        this.taskSequenceRevisionByTaskIdentifier,
      ),
      historyByTaskIdentifier: Object.fromEntries(
        [...this.historyByTaskIdentifier].map(([taskIdentifier, entries]) => [
          taskIdentifier,
          entries.map((entry) => ({
            ...entry,
            invalidatedArtifactIdentifiers: [...entry.invalidatedArtifactIdentifiers],
            invalidatedAcceptanceEntryIdentifiers: [
              ...entry.invalidatedAcceptanceEntryIdentifiers,
            ],
          })),
        ]),
      ),
      decisionByDeliveryKey: Object.fromEntries(this.decisionByDeliveryKey),
      knownTaskIdentifiers: [...this.knownTaskIdentifiers],
    };
  }

  /** 从持久化状态恢复（损坏/版本不符时保持空状态，不伪造历史）。 */
  hydrate(state: GuidanceChangeIntentState): void {
    if (state.schemaVersion !== 1) {
      return;
    }
    for (const [taskIdentifier, revision] of Object.entries(
      state.taskSequenceRevisionByTaskIdentifier ?? {},
    )) {
      if (Number.isInteger(revision) && revision >= 1) {
        this.taskSequenceRevisionByTaskIdentifier.set(taskIdentifier, revision);
      }
    }
    for (const [taskIdentifier, entries] of Object.entries(
      state.historyByTaskIdentifier ?? {},
    )) {
      if (Array.isArray(entries)) {
        this.historyByTaskIdentifier.set(taskIdentifier, [...entries]);
      }
    }
    for (const [deliveryKey, decision] of Object.entries(
      state.decisionByDeliveryKey ?? {},
    )) {
      this.decisionByDeliveryKey.set(deliveryKey, { ...decision });
    }
    for (const taskIdentifier of state.knownTaskIdentifiers ?? []) {
      this.knownTaskIdentifiers.add(taskIdentifier);
    }
  }

  private evaluate(request: GuidanceChangeRequest): GuidanceChangeDecision {
    const invalidatedArtifactIdentifiers = [...new Set(request.invalidatedArtifactIdentifiers ?? [])];
    const invalidatedAcceptanceEntryIdentifiers = [...new Set(request.invalidatedAcceptanceEntryIdentifiers ?? [])];
    const base = {
      guidanceIdentifier: request.guidanceIdentifier,
      isDuplicateDelivery: false,
      invalidatedArtifactIdentifiers,
      invalidatedAcceptanceEntryIdentifiers,
    };
    if (request.changeIntent === null) {
      return {
        ...base,
        status: "needs-clarification",
        changeIntent: null,
        newTaskSequenceRevision: null,
        reasons: ["needs-clarification: 未明确变更类型，禁止静默替换旧目标"],
        clarificationQuestion: CLARIFICATION_QUESTION,
        historyEntryCount: this.readHistory(request.targetTaskIdentifier ?? "").length,
      };
    }
    if (request.changeIntent === "new-task") {
      return { ...base, ...this.evaluateNewTask(request) };
    }
    return { ...base, ...this.evaluateAppendOrRevise(request) };
  }

  private evaluateNewTask(request: GuidanceChangeRequest): GuidanceChangeEvaluation {
    const reasons: string[] = [];
    const newTaskIdentifier = request.newTaskIdentifier ?? null;
    if (newTaskIdentifier === null || newTaskIdentifier.trim() === "") {
      reasons.push("missing-new-task-identifier: 新建任务必须提供独立任务标识");
    } else if (this.knownTaskIdentifiers.has(newTaskIdentifier)) {
      reasons.push(
        "duplicate-task-identifier: 新任务标识已存在（不得复用/替换）: " + newTaskIdentifier,
      );
    }
    if (
      request.sourceKind !== "authenticated-user" &&
      (request.derivedTaskPriorityTier < 1 ||
        request.derivedTaskPriorityTier > this.maximumAgentDerivedPriorityTier)
    ) {
      reasons.push(
        "priority-tier-elevation-rejected: Agent/工具派生任务只能层级 1.." +
          String(this.maximumAgentDerivedPriorityTier) +
          "，不得占用用户层级 0 或越权提升",
      );
    }
    if (reasons.length > 0) {
      return this.rejectedDecision(request, reasons);
    }
    if (newTaskIdentifier !== null) {
      this.knownTaskIdentifiers.add(newTaskIdentifier);
      this.taskSequenceRevisionByTaskIdentifier.set(newTaskIdentifier, 1);
    }
    return {
      status: "accepted",
      changeIntent: "new-task",
      newTaskSequenceRevision: null,
      invalidatedArtifactIdentifiers: [],
      invalidatedAcceptanceEntryIdentifiers: [],
      reasons: ["new-task-inserted: 独立节点，不提升 Agent 派生节点优先级"],
      clarificationQuestion: null,
      historyEntryCount: 0,
    };
  }

  private evaluateAppendOrRevise(request: GuidanceChangeRequest): GuidanceChangeEvaluation {
    const changeIntent = request.changeIntent;
    if (changeIntent === null) {
      return this.rejectedDecision(request, [
        "missing-change-intent: append/revise 需要明确的变更类型",
      ]);
    }
    const taskIdentifier = request.targetTaskIdentifier;
    if (taskIdentifier === null || taskIdentifier.trim() === "") {
      return this.rejectedDecision(request, [
        "missing-target-task: append/revise 必须指明目标任务",
      ]);
    }
    const currentRevision = this.readTaskRevision(taskIdentifier);
    if (request.requestedTaskSequenceRevision !== currentRevision) {
      return this.rejectedDecision(request, [
        "stale-task-sequence-revision: 观察 r" +
          String(request.requestedTaskSequenceRevision) +
          "，当前 r" +
          String(currentRevision) +
          "（并发变更，需重新评估）",
      ]);
    }
    if (changeIntent === "revise") {
      if (
        request.invalidatedArtifactIdentifiers === undefined &&
        request.invalidatedAcceptanceEntryIdentifiers === undefined
      ) {
        return {
          status: "needs-clarification",
          changeIntent: "revise",
          newTaskSequenceRevision: null,
          invalidatedArtifactIdentifiers: [],
          invalidatedAcceptanceEntryIdentifiers: [],
          reasons: ["needs-clarification: 修订必须指明受影响的产物或验收条目"],
          clarificationQuestion: "本次修订影响哪些产物标识或验收条目标识？（只有这些证据会失效）",
          historyEntryCount: this.readHistory(taskIdentifier).length,
        };
      }
    }
    const nextRevision = currentRevision + 1;
    this.taskSequenceRevisionByTaskIdentifier.set(taskIdentifier, nextRevision);
    this.knownTaskIdentifiers.add(taskIdentifier);
    const history = this.historyByTaskIdentifier.get(taskIdentifier) ?? [];
    const invalidatedArtifactIdentifiers =
      changeIntent === "revise"
        ? [...new Set(request.invalidatedArtifactIdentifiers ?? [])]
        : [];
    const invalidatedAcceptanceEntryIdentifiers =
      changeIntent === "revise"
        ? [...new Set(request.invalidatedAcceptanceEntryIdentifiers ?? [])]
        : [];
    history.push({
      taskIdentifier,
      taskSequenceRevision: nextRevision,
      guidanceIdentifier: request.guidanceIdentifier,
      guidanceRevision: request.guidanceRevision,
      changeIntent,
      instructionText: request.instructionText,
      appliedAtIso: this.nowIso(),
      invalidatedArtifactIdentifiers,
      invalidatedAcceptanceEntryIdentifiers,
    });
    this.historyByTaskIdentifier.set(taskIdentifier, history);
    return {
      status: "accepted",
      changeIntent,
      newTaskSequenceRevision: nextRevision,
      invalidatedArtifactIdentifiers,
      invalidatedAcceptanceEntryIdentifiers,
      reasons: [
        changeIntent +
          "-applied-at-safe-point: 历史指导保留，revision → r" +
          String(nextRevision),
      ],
      clarificationQuestion: null,
      historyEntryCount: history.length,
    };
  }

  private rejectedDecision(
    request: GuidanceChangeRequest,
    reasons: string[],
  ): GuidanceChangeDecision {
    return {
      status: "rejected",
      changeIntent: request.changeIntent,
      guidanceIdentifier: request.guidanceIdentifier,
      newTaskSequenceRevision: null,
      invalidatedArtifactIdentifiers: [],
      invalidatedAcceptanceEntryIdentifiers: [],
      isDuplicateDelivery: false,
      reasons,
      clarificationQuestion: null,
      historyEntryCount: this.readHistory(request.targetTaskIdentifier ?? "").length,
    };
  }
}

export interface GuidanceChangeIntentState {
  schemaVersion: 1;
  taskSequenceRevisionByTaskIdentifier: Record<string, number>;
  historyByTaskIdentifier: Record<string, GuidanceChangeHistoryEntry[]>;
  decisionByDeliveryKey: Record<string, GuidanceChangeDecision>;
  knownTaskIdentifiers: string[];
}

type GuidanceChangeEvaluation = Omit<
  GuidanceChangeDecision,
  "guidanceIdentifier" | "isDuplicateDelivery"
>;
