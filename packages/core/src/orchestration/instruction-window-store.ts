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
  /**
   * 已加载/已写入状态的**内容指纹**（用于乐观并发守卫）。
   *
   * 背景（反例⑤实测）：同一状态目录被两个实例并存访问时，各自持有内存快照并整体覆盖落盘，
   * 会造成**静默丢指令**。本仓既有约定是"同一状态目录由单一本地控制面访问"，
   * 但静默覆盖不可接受，故此处改为：写入前复核磁盘指纹，发现外部写入即**响亮失败**。
   *
   * 这是"检测并拒绝"，不是分布式共识——它消除静默覆盖，但不承诺"最后写入者胜"的并发正确性。
   */
  private lastKnownStateFingerprint: string | null = null;
  /**
   * 我方是否已向该目录提交过状态。
   *
   * 用途：首次落盘时磁盘上可能已有"前一次会话"的合法内容（我方尚未读过），
   * 这属于正常接管，不算冲突；只有在**我方已经提交过**之后再发现外部变化，才是真正的并发冲突。
   */
  private hasCommittedState = false;

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
      this.lastKnownStateFingerprint = this.computeStateFingerprint();
    } catch {
      // 损坏窗口：按空窗口继续（不伪造历史）
    }
  }

  /** 当前内存状态的指纹（不含易变的时间戳字段之外的排序依赖，故先规范化排序）。 */
  private computeStateFingerprint(): string {
    const instructions = [...this.instructionsByIdentifier.values()]
      .map((instruction) => instruction.instructionIdentifier)
      .sort();
    const queued = [...this.queuedOrder];
    const receipts = [...this.processedReceiptKeys].sort();
    return createHash("sha256")
      .update(JSON.stringify({ capacity: this.windowCapacity, instructions, queued, receipts }))
      .digest("hex");
  }

  /** 磁盘文档的状态指纹（缺文件视为 null）。 */
  private async readDiskStateFingerprint(): Promise<string | null> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(rawContent) as PersistedWindowDocument;
      const instructions = (parsed.instructions ?? [])
        .map((instruction) => instruction.instructionIdentifier)
        .sort();
      const queued = [...(parsed.queuedOrder ?? [])];
      const receipts = [...(parsed.processedReceiptKeys ?? [])].sort();
      return createHash("sha256")
        .update(
          JSON.stringify({ capacity: parsed.windowCapacity, instructions, queued, receipts }),
        )
        .digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * 乐观并发守卫：若磁盘状态与"我方已知状态"不一致，说明有其它实例写入，
   * 此时**拒绝覆盖**并响亮失败（避免静默丢指令）。
   */
  private async assertForeignWriteBeforeCommit(): Promise<void> {
    const diskFingerprint = await this.readDiskStateFingerprint();
    // 判定口径：
    //  · 我方"已接管过内容"（known 非空）时，磁盘必须仍是同一已知状态；
    //    否则说明有外部实例写入 → 拒绝提交（响亮失败）。
    //  · 我方从未读到内容（known 为空）且我方也从未提交过 → 首次落盘，允许。
    //  · 我方从未读到内容但**我方已提交过** → 磁盘消失，拒绝。
    if (this.lastKnownStateFingerprint !== null) {
      if (diskFingerprint !== this.lastKnownStateFingerprint) {
        throw new Error(
          "指令窗口并发冲突：检测到外部实例已写入（另一进程正在使用同一状态目录）。" +
            "本仓约定同一状态目录由单一本地控制面访问；已拒绝覆盖以避免静默丢指令。" +
            "请确保同一状态目录不被并发访问后重试。",
        );
      }
      return;
    }
    if (this.hasCommittedState && diskFingerprint === null) {
      throw new Error(
        "指令窗口并发冲突：已提交过状态，但磁盘状态文件消失或不可读；" +
          "拒绝覆盖以规避静默丢指令。",
      );
    }
  }

  private async persist(): Promise<void> {
    await writeAtomicJson(
      this.filePath,
      {
        schemaVersion: 1,
        windowCapacity: this.windowCapacity,
        instructions: [...this.instructionsByIdentifier.values()],
        queuedOrder: [...this.queuedOrder],
        processedReceiptKeys: [...this.processedReceiptKeys],
      } satisfies PersistedWindowDocument,
      {
        // 守卫放在 rename 紧前面：检测到外部写入即抛错，本次写入不提交。
        beforeCommit: async () => {
          await this.assertForeignWriteBeforeCommit();
        },
      },
    );
    // 写入成功后复核并记录**磁盘实际状态**指纹（而非当前内存指纹）：
    // 并发写链下内存在提交后可能已继续变化，用内存指纹会导致下一次守卫误判为"外部写入"。
    this.lastKnownStateFingerprint = await this.readDiskStateFingerprint();
    this.hasCommittedState = true;
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

    // 部分完成仍占槽位（契约：partially-completed 计入占用）；
    // 若回执带有**未决问题**，按契约进入 awaiting-clarification（同样占槽位，等待用户澄清）。
    if (receipt.receiptOutcome === "partially-completed") {
      instruction.state =
        receipt.unresolvedQuestions.length > 0 ? "awaiting-clarification" : "partially-completed";
      await this.enqueuePersist();
      return {
        outcome: "partially-completed-kept",
        detail:
          instruction.state === "awaiting-clarification"
            ? "存在未决问题：进入等待澄清（仍占用槽位）"
            : "部分完成：仍占用槽位",
      };
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
