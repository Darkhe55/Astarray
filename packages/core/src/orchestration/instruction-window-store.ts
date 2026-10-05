/**
 * SMART-01-02：指令窗口的**持久队列、原子准入/回执/补位**（2026-10-02）。
 *
 * 契约来源：SMART-01-01 冻结的窗口契约（docs/reports/SMART_01_01_AUDIT_AND_WINDOW_CONTRACT_2026-10-02.md）。
 *
 * 关键纪律（逐条对应反例）：
 *  ① 容量上限：超出即**排队**（不得静默丢弃）；
 *  ② 同键异参（idempotencyKey 相同但内容哈希不同）→ **拒绝**，不覆盖；
 *  ③ 同键同参 → 幂等复用，不重复占位；
 *  ④ 并发连发 → 准入必须**原子**（同步段内判定并占位），不得超容；
 *  ⑤ 重启 → 新实例读同一目录；重复投递幂等，不重复占位；
 *  ⑥⑦ 回执是**候选**：revision 不匹配或缺任务关联一律拒绝，**不释放槽位**；
 *  ⑧ 终态释放槽位并从队列**补位**；
 *  ⑨ 重复/乱序回执 → 幂等忽略，不得再补位；
 *  ⑩ 降低上限 → 超出部分回到队列（总数守恒，不丢失）。
 *
 * 与既有机制的关系：状态机取 SMART-01-01 §4.2 的六态；**不新建任务调度器**。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";

export type InstructionState =
  | "accepted"
  | "dispatched"
  | "awaiting-clarification"
  | "partially-completed"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

/** 占用窗口槽位的状态（契约 §4.3）。 */
const SLOT_OCCUPYING_STATES: ReadonlySet<InstructionState> = new Set<InstructionState>([
  "dispatched",
  "awaiting-clarification",
  "partially-completed",
]);

/** 终态（释放槽位并触发补位）。 */
const TERMINAL_STATES: ReadonlySet<InstructionState> = new Set<InstructionState>([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);

export interface InstructionRecord {
  instructionIdentifier: string;
  instructionRevision: number;
  sourceKind: "user" | "agent";
  instructionText: string;
  idempotencyKey: string;
  /** 规范化内容哈希（同键异参据此拒绝）。 */
  contentHash: string;
  state: InstructionState;
  admittedAtIso: string;
  updatedAtIso: string;
  /** 已核验的任务关联（回执候选据此判定）。 */
  linkedTaskIdentifiers: string[];
  evidenceReferences: string[];
  unresolvedQuestions: string[];
}

export interface InstructionWindowSnapshot {
  windowCapacity: number;
  activeInstructions: InstructionRecord[];
  queuedInstructions: InstructionRecord[];
  terminalInstructions: InstructionRecord[];
}

export type AdmitInstructionOutcome =
  | "admitted"
  | "queued"
  | "duplicate-idempotent"
  | "idempotency-conflict";

export interface AdmitInstructionResult {
  outcome: AdmitInstructionOutcome;
  instructionIdentifier: string;
  detail: string;
}

export interface InstructionReceipt {
  instructionIdentifier: string;
  instructionRevision: number;
  receiptOutcome: "completed" | "failed" | "cancelled" | "partially-completed";
  taskIdentifiers: string[];
  evidenceReferences: string[];
  unresolvedQuestions: string[];
}

export type SubmitReceiptOutcome =
  | "released-with-backfill"
  | "released-no-backfill"
  | "partially-completed-kept"
  | "stale-revision-rejected"
  | "missing-task-link-rejected"
  | "duplicate-receipt-ignored"
  | "unknown-instruction-rejected";

export interface SubmitReceiptResult {
  outcome: SubmitReceiptOutcome;
  detail: string;
}

interface PersistedWindowDocument {
  schemaVersion: 1;
  windowCapacity: number;
  instructions: InstructionRecord[];
  /** 排队顺序（instructionIdentifier）；窗口槽位顺序同样由此决定。 */
  queuedOrder: string[];
  /** 已处理过的回执键（instructionIdentifier + revision + outcome），用于幂等。 */
  processedReceiptKeys: string[];
}

const WINDOW_FILE_NAME = "instruction-window.json";
const DEFAULT_WINDOW_CAPACITY = 3;

export class InstructionWindowStore {
  private readonly filePath: string;
  private windowCapacity: number;
  private readonly instructionsByIdentifier = new Map<string, InstructionRecord>();
  private queuedOrder: string[] = [];
  private readonly processedReceiptKeys = new Set<string>();
  /** 幂等键 → 指令标识。 */
  private readonly instructionIdentifierByIdempotencyKey = new Map<string, string>();
  private pendingWritePromise: Promise<void> = Promise.resolve();
  private isLoaded = false;

  constructor(options: { baseDirectory: string; windowCapacity?: number }) {
    this.filePath = path.join(options.baseDirectory, "instruction-window", WINDOW_FILE_NAME);
    this.windowCapacity = options.windowCapacity ?? DEFAULT_WINDOW_CAPACITY;
  }

  private computeContentHash(instruction: {
    instructionRevision: number;
    instructionText: string;
  }): string {
    return createHash("sha256")
      .update(JSON.stringify({ revision: instruction.instructionRevision, text: instruction.instructionText }))
      .digest("hex");
  }

  private async loadFromDisk(): Promise<void> {
    if (this.isLoaded) {
      return;
    }
    this.isLoaded = true;
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(rawContent) as PersistedWindowDocument;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.instructions)) {
        return;
      }
      this.windowCapacity = parsed.windowCapacity;
      for (const instruction of parsed.instructions) {
        this.instructionsByIdentifier.set(instruction.instructionIdentifier, instruction);
        this.instructionIdentifierByIdempotencyKey.set(
          instruction.idempotencyKey,
          instruction.instructionIdentifier,
        );
      }
      this.queuedOrder = [...(parsed.queuedOrder ?? [])];
      for (const receiptKey of parsed.processedReceiptKeys ?? []) {
        this.processedReceiptKeys.add(receiptKey);
      }
    } catch {
      // 损坏窗口：按空窗口继续（不伪造历史）
    }
  }

  private async persist(): Promise<void> {
    await writeAtomicJson(this.filePath, {
      schemaVersion: 1,
      windowCapacity: this.windowCapacity,
      instructions: [...this.instructionsByIdentifier.values()],
      queuedOrder: [...this.queuedOrder],
      processedReceiptKeys: [...this.processedReceiptKeys],
    } satisfies PersistedWindowDocument);
  }

  private enqueuePersist(): Promise<void> {
    const nextWrite = this.pendingWritePromise.then(
      () => this.persist(),
      () => this.persist(),
    );
    this.pendingWritePromise = nextWrite.catch(() => undefined);
    return nextWrite;
  }

  /** 当前占用槽位的指令（按准入顺序）。 */
  private activeRecords(): InstructionRecord[] {
    return [...this.instructionsByIdentifier.values()].filter((instruction) =>
      SLOT_OCCUPYING_STATES.has(instruction.state),
    );
  }

  private queuedRecords(): InstructionRecord[] {
    return this.queuedOrder
      .map((identifier) => this.instructionsByIdentifier.get(identifier))
      .filter((instruction): instruction is InstructionRecord => instruction !== undefined);
  }

  private terminalRecords(): InstructionRecord[] {
    return [...this.instructionsByIdentifier.values()].filter((instruction) =>
      TERMINAL_STATES.has(instruction.state),
    );
  }

  /**
   * 原子准入：**同步段内**完成"查幂等 → 判容量 → 占位"，再落盘。
   * 并发调用因此不会超容（反例④）。
   */
  async admitInstruction(input: {
    instructionIdentifier: string;
    instructionRevision: number;
    sourceKind: "user" | "agent";
    instructionText: string;
    idempotencyKey: string;
    nowIso?: string;
  }): Promise<AdmitInstructionResult> {
    await this.loadFromDisk();
    const nowIso = input.nowIso ?? new Date().toISOString();
    const contentHash = this.computeContentHash(input);

    // ②③ 幂等键判定（同键同参幂等、同键异参拒绝）
    const existingIdentifier = this.instructionIdentifierByIdempotencyKey.get(input.idempotencyKey);
    if (existingIdentifier !== undefined) {
      const existing = this.instructionsByIdentifier.get(existingIdentifier);
      if (existing !== undefined) {
        if (existing.contentHash !== contentHash) {
          return {
            outcome: "idempotency-conflict",
            instructionIdentifier: existing.instructionIdentifier,
            detail: "同键异参：既有指令内容哈希不同，拒绝覆盖",
          };
        }
        return {
          outcome: "duplicate-idempotent",
          instructionIdentifier: existing.instructionIdentifier,
          detail: "同键同参：幂等复用既有指令",
        };
      }
    }

    // ④ 同步段内判容量并占位（不得有 await 夹在中间）
    const isWithinCapacity = this.activeRecords().length < this.windowCapacity;
    const record: InstructionRecord = {
      instructionIdentifier: input.instructionIdentifier,
      instructionRevision: input.instructionRevision,
      sourceKind: input.sourceKind,
      instructionText: input.instructionText,
      idempotencyKey: input.idempotencyKey,
      contentHash,
      state: isWithinCapacity ? "dispatched" : "accepted",
      admittedAtIso: nowIso,
      updatedAtIso: nowIso,
      linkedTaskIdentifiers: [],
      evidenceReferences: [],
      unresolvedQuestions: [],
    };
    this.instructionsByIdentifier.set(input.instructionIdentifier, record);
    this.instructionIdentifierByIdempotencyKey.set(input.idempotencyKey, input.instructionIdentifier);
    if (!isWithinCapacity) {
      // ① 超出容量 → 排队（**记录仍是 accepted，但不占槽位**，由 queuedOrder 表达）
      this.queuedOrder.push(input.instructionIdentifier);
    }
    await this.enqueuePersist();
    return {
      outcome: isWithinCapacity ? "admitted" : "queued",
      instructionIdentifier: input.instructionIdentifier,
      detail: isWithinCapacity ? "已进入窗口" : "窗口已满：已排队（不丢弃）",
    };
  }

  /**
   * 提交回执（**候选**）：本地核对 revision 与任务关联后才释放槽位并补位。
   */
  async submitReceipt(receipt: InstructionReceipt): Promise<SubmitReceiptResult> {
    await this.loadFromDisk();
    const instruction = this.instructionsByIdentifier.get(receipt.instructionIdentifier);
    if (instruction === undefined) {
      return { outcome: "unknown-instruction-rejected", detail: "未知指令：拒绝回执" };
    }
    const receiptKey = [
      receipt.instructionIdentifier,
      String(receipt.instructionRevision),
      receipt.receiptOutcome,
    ].join("|");
    // ⑨ 重复/乱序回执幂等忽略
    if (this.processedReceiptKeys.has(receiptKey)) {
      return { outcome: "duplicate-receipt-ignored", detail: "该回执已处理过：幂等忽略" };
    }
    // ⑥ revision 不匹配（乱序回执）→ 拒绝，不释放槽位
    if (receipt.instructionRevision !== instruction.instructionRevision) {
      return {
        outcome: "stale-revision-rejected",
        detail:
          "回执 revision（" +
          String(receipt.instructionRevision) +
          "）与当前指令 revision（" +
          String(instruction.instructionRevision) +
          "）不一致：回执仅为候选，拒绝",
      };
    }
    // ⑦ 缺任务关联 → 拒绝，不释放槽位
    if (receipt.taskIdentifiers.length === 0) {
      return {
        outcome: "missing-task-link-rejected",
        detail: "回执未给出关联任务：无法核对，拒绝释放槽位",
      };
    }

    this.processedReceiptKeys.add(receiptKey);
    instruction.linkedTaskIdentifiers = [...receipt.taskIdentifiers];
    instruction.evidenceReferences = [...receipt.evidenceReferences];
    instruction.unresolvedQuestions = [...receipt.unresolvedQuestions];
    instruction.updatedAtIso = new Date().toISOString();

    // 部分完成仍占槽位（契约：partially-completed 计入占用）
    if (receipt.receiptOutcome === "partially-completed") {
      instruction.state = "partially-completed";
      await this.enqueuePersist();
      return { outcome: "partially-completed-kept", detail: "部分完成：仍占用槽位" };
    }

    instruction.state =
      receipt.receiptOutcome === "completed"
        ? "completed"
        : receipt.receiptOutcome === "failed"
          ? "failed"
          : "cancelled";

    // ⑧ 释放槽位并从队列补位（按排队顺序）：补位者由 accepted 变为 dispatched（占槽位）。
    const backfilledIdentifier = this.queuedOrder.shift() ?? null;
    if (backfilledIdentifier !== null) {
      const backfilled = this.instructionsByIdentifier.get(backfilledIdentifier);
      if (backfilled !== undefined) {
        backfilled.state = "dispatched";
        backfilled.updatedAtIso = new Date().toISOString();
      }
    }
    await this.enqueuePersist();
    return backfilledIdentifier === null
      ? { outcome: "released-no-backfill", detail: "已释放槽位；队列为空" }
      : {
          outcome: "released-with-backfill",
          detail: "已释放槽位并从队列补入 " + backfilledIdentifier,
        };
  }

  /** ⑩ 调整窗口上限：超出新上限的**非终态**指令回到队列（总数守恒）。 */
  async setWindowCapacity(nextCapacity: number): Promise<void> {
    await this.loadFromDisk();
    this.windowCapacity = Math.max(1, Math.floor(nextCapacity));
    const active = this.activeRecords();
    if (active.length > this.windowCapacity) {
      const overflow = active.slice(this.windowCapacity);
      for (const instruction of overflow) {
        // 真正退出槽位：状态回 accepted（排队中，不占槽位），并进入排队顺序。
        instruction.state = "accepted";
        instruction.updatedAtIso = new Date().toISOString();
        if (!this.queuedOrder.includes(instruction.instructionIdentifier)) {
          this.queuedOrder.push(instruction.instructionIdentifier);
        }
      }
    }
    await this.enqueuePersist();
  }

  /** 窗口快照（活动/排队/终态；活动数即槽位占用数）。 */
  async snapshot(): Promise<InstructionWindowSnapshot> {
    await this.loadFromDisk();
    return {
      windowCapacity: this.windowCapacity,
      activeInstructions: this.activeRecords(),
      queuedInstructions: this.queuedRecords(),
      terminalInstructions: this.terminalRecords(),
    };
  }

  /** 已处理回执数（用于观测幂等行为）。 */
  async getProcessedReceiptCount(): Promise<number> {
    await this.loadFromDisk();
    return this.processedReceiptKeys.size;
  }
}
