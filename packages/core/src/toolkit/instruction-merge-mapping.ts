/**
 * MERGE-01：**执行组到原指令映射**与**合并开关**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md` §1.1/§1.2。
 *
 * 卡内硬要求逐条落实：
 *  - "原始用户指令**追加保存**，保留每条**来源、ID、revision、优先级、取消权和验收条件**"
 *    ⇒ 原指令为**不可变追加**记录（同 ID 新内容必须升 revision）；
 *  - "执行组**仅引用原指令**，**不能覆盖原文、伪装用户指令或自动认定被合并项完成**"
 *    ⇒ 组只保存引用；引用绑定 revision 与内容指纹，原指令变化即**失效**；
 *    组派生物标记为 `group-derivative`（来源仍是原指令）；
 *  - "SMART 窗口按**原始未完成意图**计数，**不按执行组数量**计数" ⇒ 窗口计数只看原指令；
 *  - "**未准入候选只保存关联**" + 合并开关 ⇒ 开关关闭时不得建组，只记录候选关联；
 *  - "**组完成不自动关闭全部原指令**，逐项由本地门禁核验" ⇒ 关闭只能经逐项核验。
 *
 * 本模块只做**本地确定性判定**：不做 I/O、不联网、不调用模型。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";

import {
  evaluateInstructionMergeEligibility,
  type InstructionMergeCandidate,
} from "./instruction-merge-eligibility.js";

/** 重新导出资格候选类型：调用方经本模块即可拿到建组所需的完整入参类型。 */
export type { InstructionMergeCandidate };

export interface OriginalInstructionRecord {
  instructionIdentifier: string;
  instructionText: string;
  /** 来源类型：用户 / Agent / 系统。**不得**被组改写。 */
  sourceKind: "user" | "agent" | "system";
  sourceActorIdentifier: string;
  revision: number;
  priorityTier: number;
  cancellationRightHolderIdentifier: string;
  acceptanceCriteria: string[];
  isCompleted: boolean;
}

export interface ExecutionGroupMappingEntry {
  instructionIdentifier: string;
  instructionText: string;
  sourceKind: OriginalInstructionRecord["sourceKind"];
  sourceActorIdentifier: string;
  revision: number;
  contentFingerprint: string;
  priorityTier: number;
  cancellationRightHolderIdentifier: string;
  acceptanceCriteria: string[];
}

export interface DerivedWorkItem {
  derivedIdentifier: string;
  groupIdentifier: string;
  derivedText: string;
  producedByAgentInstanceId: string;
  /**
   * 来源种类**恒为** `group-derivative`。
   *
   * 卡内："不能……**伪装用户指令**" ⇒ 由组派生的内容绝不能被标成 `user`。
   */
  sourceKind: "group-derivative";
  originatingInstructionIdentifiers: string[];
  /**
   * 是否覆盖了原指令文本。
   *
   * **恒为 false**：本模块**不提供**任何改写原文的能力（卡内"不能覆盖原文"）。
   */
  isOriginalInstructionTextOverridden: false;
}

/**
 * 组内**单个成员**的结算结果（MERGE-01-03）。
 *
 * 关键语义：卡内要求"**部分失败只影响对应节点**"、"**取消一项不得取消其他项**"
 * ⇒ 结算必须**逐成员**记录，而不是整组一个状态。
 */
export type GroupMemberOutcome = "pending" | "succeeded" | "failed" | "cancelled";

export interface GroupMemberSettlement {
  groupIdentifier: string;
  instructionIdentifier: string;
  outcome: GroupMemberOutcome;
  reason: string | null;
  settledByAgentInstanceId: string | null;
  settledAtIso: string | null;
}

export interface MemberSettlementOutcome {
  isSettled: boolean;
  reason: string | null;
}

export interface MemberCancellationOutcome {
  isCancelled: boolean;
  reason: string | null;
}

export interface InstructionMergePersistenceOutcome {
  isPersisted: boolean;
  reason: string | null;
}

export interface InstructionMergeRestoreOutcome {
  isRestored: boolean;
  restoredInstructionCount: number;
  restoredGroupCount: number;
  reason: string | null;
}

export interface InstructionMergeController {
  appendInstruction(record: OriginalInstructionRecord): void;
  createExecutionGroup(input: {
    groupIdentifier: string;
    referencedInstructionIdentifiers: string[];
    createdByAgentInstanceId: string;
    /**
     * 建组**必须**附带的资格候选（MERGE-01-02）。
     *
     * 缺省 ⇒ **fail-closed 拒绝**：卡内要求"**本地检查后才采纳**"，
     * 没有资格数据就无法检查，"没数据就当通过"等于取消该门禁。
     */
    mergeCandidates?: readonly InstructionMergeCandidate[];
  }): { isCreated: boolean; reason: string | null };
  describeGroupMapping(input: { groupIdentifier: string }): ExecutionGroupMappingEntry[];
  isGroupReferenceStillValid(input: {
    groupIdentifier: string;
  }): { isValid: boolean; reason: string | null };
  createDerivedWorkItem(input: {
    groupIdentifier: string;
    derivedText: string;
    producedByAgentInstanceId: string;
  }): DerivedWorkItem;
  listCandidateAssociations(): Array<{ instructionIdentifier: string; revision: number }>;
  countUnfinishedOriginalIntentions(): number;
  countExecutionGroups(): number;
  isWindowCapacityExceeded(): boolean;
  markGroupCompleted(input: { groupIdentifier: string }): void;
  /** 逐成员结算（部分失败/成功只影响对应节点）。 */
  settleGroupMember(input: {
    groupIdentifier: string;
    instructionIdentifier: string;
    outcome: "succeeded" | "failed";
    reason: string | null;
  }): MemberSettlementOutcome;
  /** 取消**单个**成员（不得取消其他项；须由取消权持有者发起）。 */
  cancelGroupMember(input: {
    groupIdentifier: string;
    instructionIdentifier: string;
    cancelledByAgentInstanceId: string;
    reason: string;
  }): MemberCancellationOutcome;
  /** 读取组内逐成员结算（含未结算者，如实报 pending）。 */
  describeGroupMemberSettlements(input: {
    groupIdentifier: string;
  }): GroupMemberSettlement[];
  /** 跨重启落盘（卡内"原始用户指令**追加保存**"）。 */
  persistToDisk(): Promise<InstructionMergePersistenceOutcome>;
  /** 从磁盘恢复组、原指令与成员结算。 */
  restoreFromDisk(): Promise<InstructionMergeRestoreOutcome>;
  isInstructionCompleted(instructionIdentifier: string): boolean;
  verifyInstructionCompletion(input: {
    instructionIdentifier: string;
    verifiedByGateIdentifier: string;
    isAccepted: boolean;
  }): { isCompleted: boolean; reason: string | null };
}

function computeInstructionContentFingerprint(record: OriginalInstructionRecord): string {
  // 指纹只覆盖**内容与元数据**，不含 `isCompleted` —— 完成状态变化不应使引用失效。
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        [
          record.instructionIdentifier,
          record.instructionText,
          record.sourceKind,
          record.sourceActorIdentifier,
          String(record.revision),
          String(record.priorityTier),
          record.cancellationRightHolderIdentifier,
          record.acceptanceCriteria.join(","),
        ].join("|"),
        "utf8",
      )
      .digest("hex")
  );
}

/**
 * 创建合并控制器。
 *
 * `isMergeEnabled` 即卡内"合并开关"：关闭时**不得新建执行组**，
 * 但候选关联仍被记录（"轮到它时可复用已验证结果"）。
 */
export const INSTRUCTION_MERGE_STATE_SCHEMA_VERSION = 1;

export function createInstructionMergeController(options: {
  isMergeEnabled: boolean;
  windowCapacity: number;
  /**
   * 状态目录（MERGE-01-03）。提供后可用 `persistToDisk`/`restoreFromDisk`
   * 跨重启恢复组、原指令与**成员结算**（卡内"原始用户指令**追加保存**"）。
   */
  stateDirectory?: string;
}): InstructionMergeController {
  /** instructionIdentifier → 最新 revision 记录（**追加**语义：同 ID 新记录替换"最新"视图）。 */
  const latestInstructionByIdentifier = new Map<string, OriginalInstructionRecord>();
  /** 历史 revision 内容指纹（用于判断"引用时的 revision 是否仍是最新且内容一致"）。 */
  const fingerprintByRevisionKey = new Map<string, string>();
  const groupMappings = new Map<
    string,
    Array<{ instructionIdentifier: string; revision: number; contentFingerprint: string }>
  >();
  const completedGroupIdentifiers = new Set<string>();
  /** 成员结算：`groupIdentifier|instructionIdentifier` → 结算结果（MERGE-01-03）。 */
  const memberSettlementByKey = new Map<string, GroupMemberSettlement>();
  /** 建组时**冻结的资格成员快照**：晚到指令不得并入既有组。 */
  const frozenMemberIdentifiersByGroupIdentifier = new Map<string, string[]>();
  const candidateAssociations: Array<{ instructionIdentifier: string; revision: number }> = [];
  const derivedWorkItems: DerivedWorkItem[] = [];
  let derivedSequence = 0;

  /** 合并状态文件路径（与暂存目录隔离；仅状态目录绑定后可用）。 */
  const mergeStateFilePath = (): string =>
    path.join(
      options.stateDirectory as string,
      "instruction-merge-state.json",
    );

  const revisionKey = (instructionIdentifier: string, revision: number): string =>
    instructionIdentifier + "@" + String(revision);

  return {
    appendInstruction(record) {
      latestInstructionByIdentifier.set(record.instructionIdentifier, { ...record });
      fingerprintByRevisionKey.set(
        revisionKey(record.instructionIdentifier, record.revision),
        computeInstructionContentFingerprint(record),
      );
    },

    createExecutionGroup(input) {
      if (!options.isMergeEnabled) {
        /**
         * 合并开关关闭：**不得**建组；未准入候选**只保存关联**。
         * 这里对每个引用原指令各记一条关联（去重后），供后续复用。
         */
        for (const instructionIdentifier of input.referencedInstructionIdentifiers) {
          const instruction = latestInstructionByIdentifier.get(instructionIdentifier);
          if (instruction === undefined) {
            continue;
          }
          const isAlreadyRecorded = candidateAssociations.some(
            (association) =>
              association.instructionIdentifier === instructionIdentifier &&
              association.revision === instruction.revision,
          );
          if (!isAlreadyRecorded) {
            candidateAssociations.push({
              instructionIdentifier,
              revision: instruction.revision,
            });
          }
        }
        return {
          isCreated: false,
          reason: "合并开关未启用：不得新建执行组（候选只保存关联）",
        };
      }
      if (input.referencedInstructionIdentifiers.length === 0) {
        return {
          isCreated: false,
          reason: "执行组必须映射到至少一条原指令（空映射不得存在）",
        };
      }
      /**
       * **资格判定门禁**（MERGE-01-02）：卡内"只合并同项目、同任务权威、相容目标和
       * 权限作用域的 ready 指令"，且"**本地检查后才采纳**"。
       *
       * 这一层此前缺失 ⇒ 判定层与建组层各自成立却互不相识，
       * 跨项目/语义冲突/目标不明/在途副作用/依赖未 ready 的指令**照样能建组**。
       */
      if (input.mergeCandidates === undefined) {
        return {
          isCreated: false,
          reason:
            "未提供合并资格候选（mergeCandidates）：无法执行本地资格判定，" +
            "按 fail-closed 拒绝建组（不得「没数据就当通过」）",
        };
      }
      const eligibilityOutcome = evaluateInstructionMergeEligibility({
        candidates: input.mergeCandidates,
        isMergeEnabled: options.isMergeEnabled,
      });
      if (!eligibilityOutcome.canMerge) {
        return {
          isCreated: false,
          reason: "合并资格判定未通过: " + String(eligibilityOutcome.reason),
        };
      }
      /** 资格判定通过的候选必须与实际引用**一致**（不得用无关候选蒙混过关）。 */
      const eligibleIdentifiers = new Set(eligibilityOutcome.mergedInstructionIdentifiers);
      const isReferenceConsistent = input.referencedInstructionIdentifiers.every(
        (instructionIdentifier) => eligibleIdentifiers.has(instructionIdentifier),
      );
      if (!isReferenceConsistent) {
        return {
          isCreated: false,
          reason:
            "引用的指令不在通过资格判定的集合内（判定与建组引用必须一致）",
        };
      }
      const missingIdentifiers = input.referencedInstructionIdentifiers.filter(
        (instructionIdentifier) =>
          !latestInstructionByIdentifier.has(instructionIdentifier),
      );
      if (missingIdentifiers.length > 0) {
        return {
          isCreated: false,
          reason: "引用的原指令不存在: " + missingIdentifiers.join(","),
        };
      }
      /**
       * **晚到指令不得并入既有组**（MERGE-01-03"连续输入"）。
       *
       * 组一旦建立，其成员集合对调用方就是**承诺**：悄悄扩大等于改变了
       * 已对外声明的合并范围（可能连带扩大权限/副作用面）。须新建组。
       */
      const frozenMembers = frozenMemberIdentifiersByGroupIdentifier.get(
        input.groupIdentifier,
      );
      if (frozenMembers !== undefined) {
        const isSameMemberSet =
          frozenMembers.length === input.referencedInstructionIdentifiers.length &&
          frozenMembers.every((instructionIdentifier) =>
            input.referencedInstructionIdentifiers.includes(instructionIdentifier),
          );
        if (!isSameMemberSet) {
          return {
            isCreated: false,
            reason:
              "该执行组已存在且成员集合已冻结：晚到指令不得并入既有组（须新建组）；" +
              "原成员: " +
              frozenMembers.join(",") +
              "，本次请求: " +
              input.referencedInstructionIdentifiers.join(","),
          };
        }
      }
      groupMappings.set(
        input.groupIdentifier,
        input.referencedInstructionIdentifiers.map((instructionIdentifier) => {
          const instruction = latestInstructionByIdentifier.get(
            instructionIdentifier,
          ) as OriginalInstructionRecord;
          return {
            instructionIdentifier,
            revision: instruction.revision,
            contentFingerprint: computeInstructionContentFingerprint(instruction),
          };
        }),
      );
      /** 冻结本次成员集合（首次建组或原样重建）。 */
      frozenMemberIdentifiersByGroupIdentifier.set(input.groupIdentifier, [
        ...input.referencedInstructionIdentifiers,
      ]);
      return { isCreated: true, reason: null };
    },

    describeGroupMapping(input) {
      const mapping = groupMappings.get(input.groupIdentifier) ?? [];
      return mapping.map((entry) => {
        const instruction = latestInstructionByIdentifier.get(
          entry.instructionIdentifier,
        ) as OriginalInstructionRecord;
        return {
          instructionIdentifier: entry.instructionIdentifier,
          // 原文**逐字**来自原指令记录（组不保存也不改写文本）
          instructionText: instruction.instructionText,
          sourceKind: instruction.sourceKind,
          sourceActorIdentifier: instruction.sourceActorIdentifier,
          revision: entry.revision,
          contentFingerprint: entry.contentFingerprint,
          priorityTier: instruction.priorityTier,
          cancellationRightHolderIdentifier: instruction.cancellationRightHolderIdentifier,
          acceptanceCriteria: [...instruction.acceptanceCriteria],
        };
      });
    },

    isGroupReferenceStillValid(input) {
      const mapping = groupMappings.get(input.groupIdentifier);
      if (mapping === undefined) {
        return { isValid: false, reason: "执行组不存在" };
      }
      for (const entry of mapping) {
        const instruction = latestInstructionByIdentifier.get(entry.instructionIdentifier);
        if (instruction === undefined) {
          return {
            isValid: false,
            reason: "原指令已不存在: " + entry.instructionIdentifier,
          };
        }
        if (instruction.revision !== entry.revision) {
          return {
            isValid: false,
            reason:
              "原指令 revision 已前进（引用失效）: " +
              entry.instructionIdentifier +
              "（引用 r" +
              String(entry.revision) +
              " → 最新 r" +
              String(instruction.revision) +
              "）",
          };
        }
        if (computeInstructionContentFingerprint(instruction) !== entry.contentFingerprint) {
          return {
            isValid: false,
            reason: "原指令内容已变化（引用失效）: " + entry.instructionIdentifier,
          };
        }
      }
      return { isValid: true, reason: null };
    },

    createDerivedWorkItem(input) {
      derivedSequence += 1;
      const derived: DerivedWorkItem = {
        derivedIdentifier: "derived-" + String(derivedSequence),
        groupIdentifier: input.groupIdentifier,
        derivedText: input.derivedText,
        producedByAgentInstanceId: input.producedByAgentInstanceId,
        sourceKind: "group-derivative",
        originatingInstructionIdentifiers: (
          groupMappings.get(input.groupIdentifier) ?? []
        ).map((entry) => entry.instructionIdentifier),
        isOriginalInstructionTextOverridden: false,
      };
      derivedWorkItems.push(derived);
      return derived;
    },

    listCandidateAssociations() {
      return candidateAssociations.map((association) => ({ ...association }));
    },

    countUnfinishedOriginalIntentions() {
      let unfinishedCount = 0;
      for (const instruction of latestInstructionByIdentifier.values()) {
        if (!instruction.isCompleted) {
          unfinishedCount += 1;
        }
      }
      return unfinishedCount;
    },

    countExecutionGroups() {
      return groupMappings.size;
    },

    isWindowCapacityExceeded() {
      /**
       * 卡内："SMART 窗口按**原始未完成意图**计数，**不按执行组数量**计数：
       * 窗口 3 条不能通过合并塞入第 4 条。"
       */
      return this.countUnfinishedOriginalIntentions() > options.windowCapacity;
    },

    markGroupCompleted(input) {
      completedGroupIdentifiers.add(input.groupIdentifier);
      /**
       * **刻意不做任何事**：卡内"组完成**不自动关闭全部原指令**"。
       * 这里显式留空，避免后来者误以为漏写而"顺手"补上自动关闭。
       */
      void completedGroupIdentifiers;
    },

    settleGroupMember(input) {
      if (!groupMappings.has(input.groupIdentifier)) {
        return { isSettled: false, reason: "执行组不存在" };
      }
      const memberKey = input.groupIdentifier + "|" + input.instructionIdentifier;
      const existing = memberSettlementByKey.get(memberKey);
      /**
       * **已终态不得被覆盖**：卡内"执行后不能通过拆组合并重放副作用"，
       * 重复结算等于改写既有结果（可能让已成功的节点被重跑）。
       */
      if (existing !== undefined && existing.outcome !== "pending") {
        return {
          isSettled: false,
          reason:
            "该成员已结算（" +
            existing.outcome +
            "），不得覆盖既有结果（防止重放副作用）",
        };
      }
      memberSettlementByKey.set(memberKey, {
        groupIdentifier: input.groupIdentifier,
        instructionIdentifier: input.instructionIdentifier,
        outcome: input.outcome,
        reason: input.reason,
        settledByAgentInstanceId: null,
        settledAtIso: new Date().toISOString(),
      });
      /**
       * **只结算该成员**：不触碰同组其他成员的结算
       * （卡内"部分失败只影响对应节点"）。
       */
      return { isSettled: true, reason: null };
    },

    cancelGroupMember(input) {
      const mapping = groupMappings.get(input.groupIdentifier);
      if (mapping === undefined) {
        return { isCancelled: false, reason: "执行组不存在" };
      }
      const isMember = mapping.some(
        (entry) => entry.instructionIdentifier === input.instructionIdentifier,
      );
      if (!isMember) {
        return {
          isCancelled: false,
          reason: "该指令不属于此执行组（不得跨组取消）",
        };
      }
      const instruction = latestInstructionByIdentifier.get(input.instructionIdentifier);
      if (instruction === undefined) {
        return { isCancelled: false, reason: "原指令不存在" };
      }
      /** 保留**取消权**语义：只有取消权持有者可取消。 */
      if (instruction.cancellationRightHolderIdentifier !== input.cancelledByAgentInstanceId) {
        return {
          isCancelled: false,
          reason:
            "无取消权：该指令的取消权属于 " +
            instruction.cancellationRightHolderIdentifier,
        };
      }
      const memberKey = input.groupIdentifier + "|" + input.instructionIdentifier;
      const existing = memberSettlementByKey.get(memberKey);
      if (existing !== undefined && existing.outcome !== "pending") {
        return {
          isCancelled: false,
          reason: "该成员已结算（" + existing.outcome + "），不得再取消",
        };
      }
      memberSettlementByKey.set(memberKey, {
        groupIdentifier: input.groupIdentifier,
        instructionIdentifier: input.instructionIdentifier,
        outcome: "cancelled",
        reason: input.reason,
        settledByAgentInstanceId: input.cancelledByAgentInstanceId,
        settledAtIso: new Date().toISOString(),
      });
      /**
       * **只取消该成员**：同组其他成员**保持原结算**
       * （卡内"取消一项不得取消其他项"）。
       */
      return { isCancelled: true, reason: null };
    },

    describeGroupMemberSettlements(input) {
      const mapping = groupMappings.get(input.groupIdentifier) ?? [];
      return mapping.map((entry) => {
        const memberKey = input.groupIdentifier + "|" + entry.instructionIdentifier;
        return (
          memberSettlementByKey.get(memberKey) ?? {
            groupIdentifier: input.groupIdentifier,
            instructionIdentifier: entry.instructionIdentifier,
            outcome: "pending" as const,
            reason: null,
            settledByAgentInstanceId: null,
            settledAtIso: null,
          }
        );
      });
    },

    async persistToDisk() {
      if (options.stateDirectory === undefined) {
        return { isPersisted: false, reason: "未绑定状态目录，无法落盘" };
      }
      await writeAtomicJson(mergeStateFilePath(), {
        schemaVersion: INSTRUCTION_MERGE_STATE_SCHEMA_VERSION,
        // 原指令**追加保存**（卡内"原始用户指令追加保存"）
        instructions: [...latestInstructionByIdentifier.values()],
        groupMappings: [...groupMappings.entries()],
        frozenMembers: [...frozenMemberIdentifiersByGroupIdentifier.entries()],
        memberSettlements: [...memberSettlementByKey.values()],
        completedGroupIdentifiers: [...completedGroupIdentifiers],
      });
      return { isPersisted: true, reason: null };
    },

    async restoreFromDisk() {
      if (options.stateDirectory === undefined) {
        return {
          isRestored: false,
          restoredInstructionCount: 0,
          restoredGroupCount: 0,
          reason: "未绑定状态目录，无法恢复",
        };
      }
      let parsed: {
        schemaVersion?: number;
        instructions?: OriginalInstructionRecord[];
        groupMappings?: Array<
          [string, Array<{ instructionIdentifier: string; revision: number; contentFingerprint: string }>]
        >;
        frozenMembers?: Array<[string, string[]]>;
        memberSettlements?: GroupMemberSettlement[];
        completedGroupIdentifiers?: string[];
      };
      try {
        parsed = JSON.parse(
          await fs.readFile(mergeStateFilePath(), "utf8"),
        ) as typeof parsed;
      } catch {
        return {
          isRestored: false,
          restoredInstructionCount: 0,
          restoredGroupCount: 0,
          reason: "状态文件缺失或损坏（不假装已恢复）",
        };
      }
      if (parsed.schemaVersion !== INSTRUCTION_MERGE_STATE_SCHEMA_VERSION) {
        return {
          isRestored: false,
          restoredInstructionCount: 0,
          restoredGroupCount: 0,
          reason: "状态文件 schemaVersion 不符",
        };
      }
      for (const instruction of parsed.instructions ?? []) {
        latestInstructionByIdentifier.set(instruction.instructionIdentifier, {
          ...instruction,
        });
        fingerprintByRevisionKey.set(
          revisionKey(instruction.instructionIdentifier, instruction.revision),
          computeInstructionContentFingerprint(instruction),
        );
      }
      for (const [groupIdentifier, mapping] of parsed.groupMappings ?? []) {
        groupMappings.set(groupIdentifier, mapping.map((entry) => ({ ...entry })));
      }
      for (const [groupIdentifier, frozenMembers] of parsed.frozenMembers ?? []) {
        frozenMemberIdentifiersByGroupIdentifier.set(groupIdentifier, [...frozenMembers]);
      }
      for (const settlement of parsed.memberSettlements ?? []) {
        memberSettlementByKey.set(
          settlement.groupIdentifier + "|" + settlement.instructionIdentifier,
          { ...settlement },
        );
      }
      for (const groupIdentifier of parsed.completedGroupIdentifiers ?? []) {
        completedGroupIdentifiers.add(groupIdentifier);
      }
      return {
        isRestored: true,
        restoredInstructionCount: latestInstructionByIdentifier.size,
        restoredGroupCount: groupMappings.size,
        reason: null,
      };
    },

    isInstructionCompleted(instructionIdentifier) {
      return (
        latestInstructionByIdentifier.get(instructionIdentifier)?.isCompleted ?? false
      );
    },

    verifyInstructionCompletion(input) {
      const instruction = latestInstructionByIdentifier.get(input.instructionIdentifier);
      if (instruction === undefined) {
        return { isCompleted: false, reason: "原指令不存在" };
      }
      if (!input.isAccepted) {
        return {
          isCompleted: false,
          reason: "逐项核验未通过（不得关闭原指令）",
        };
      }
      if (input.verifiedByGateIdentifier === "") {
        return { isCompleted: false, reason: "缺少核验门禁标识" };
      }
      latestInstructionByIdentifier.set(input.instructionIdentifier, {
        ...instruction,
        isCompleted: true,
      });
      return { isCompleted: true, reason: null };
    },
  };
}

/* ────────── 与实际 SMART 窗口的**装配桥接** ────────── */

/** 窗口快照中计数所需的最小形状（避免依赖具体 store 实现）。 */
export interface WindowIntentionCountInput {
  windowCapacity: number;
  activeInstructions: Array<{ instructionIdentifier: string }>;
  queuedInstructions: Array<{ instructionIdentifier: string }>;
}

export interface WindowIntentionCountOutcome {
  /** 窗口内（已准入 + 排队）**尚未逐项核验完成**的原指令条数。 */
  unfinishedIntentionCount: number;
  windowCapacity: number;
  isCapacityExceeded: boolean;
  /** 已逐项核验关闭、因而不占窗口的条数（便于核对扣除是否生效）。 */
  completedIntentionCount: number;
}

/**
 * 按**原始未完成意图**统计窗口占用（卡内 §1.2）。
 *
 * 为什么必须有这一层（2026-10-10 由反例暴露）：`InstructionWindowStore` 只知道自己
 * 有哪些**记录**，不知道"某条原指令其实已被逐项核验关闭"；而合并控制器只知道
 * 原指令的完成状态，不知道窗口里有哪些记录。两者**各自计数、互不相识**，
 * 于是"窗口按原始未完成意图计数"这句在**真实装配路径上并不成立**。
 *
 * 判定规则：
 *  - 计数对象是**原指令**：已准入 + 排队的记录各算一条；
 *  - 已由**逐项核验**关闭的原指令**不占**窗口；
 *  - **执行组数量完全不参与**计数（组不是意图）；
 *  - 计数覆盖**排队**记录：未准入候选必须真的等在队列里，
 *    不能因为"合并后窗口看起来有空位"而被提前准入。
 */
export function countUnfinishedIntentionsInWindow(input: {
  windowSnapshot: WindowIntentionCountInput;
  mergeController: Pick<InstructionMergeController, "isInstructionCompleted">;
}): WindowIntentionCountOutcome {
  const candidateIdentifiers = [
    ...input.windowSnapshot.activeInstructions.map(
      (record) => record.instructionIdentifier,
    ),
    ...input.windowSnapshot.queuedInstructions.map(
      (record) => record.instructionIdentifier,
    ),
  ];
  let unfinishedIntentionCount = 0;
  let completedIntentionCount = 0;
  for (const instructionIdentifier of candidateIdentifiers) {
    if (input.mergeController.isInstructionCompleted(instructionIdentifier)) {
      completedIntentionCount += 1;
      continue;
    }
    unfinishedIntentionCount += 1;
  }
  return {
    unfinishedIntentionCount,
    windowCapacity: input.windowSnapshot.windowCapacity,
    isCapacityExceeded: unfinishedIntentionCount > input.windowSnapshot.windowCapacity,
    completedIntentionCount,
  };
}
