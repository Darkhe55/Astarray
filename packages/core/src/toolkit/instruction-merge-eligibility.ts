/**
 * MERGE-01-02：**确定性合并的资格判定**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md` §1.1。
 *
 * 卡内硬要求逐条落实：
 *  - "第一版**仅做确定性去重/明确补充合并**；模型可提出相似候选，**本地检查后才采纳**，
 *    **不引入独立长时合并模型**" ⇒ 本模块是**纯本地确定性判定**，无模型参与；
 *  - "**只合并同项目、同任务权威、相容目标和权限作用域的 ready 指令**；
 *    保留前驱/后继偏序，**不跨依赖障碍**"；
 *  - "**语义冲突、目标不明、独立授权、跨项目、已产生副作用的在途操作不合并**"；
 *  - "用户明确修订走 **supersedes**，**不按'最新文本'猜测废弃旧任务**"；
 *  - "多项可共用一次读取/检索，但**每个子结果映射回原 ID**"；
 *  - "指令合并提供**独立开关，初始关闭**"；"**关闭后不丢组内原指令，
 *    不重放在途操作，安全点拆回未执行项**"。
 *
 * 本模块只做**本地确定性判定**：不做 I/O、不联网、不调用模型。
 */

/** 合并开关设置（卡内："独立开关，**初始关闭**"）。 */
export interface InstructionMergeSettings {
  isMergeEnabled: boolean;
}

export const DEFAULT_INSTRUCTION_MERGE_SETTINGS: InstructionMergeSettings = {
  isMergeEnabled: false,
};

export interface InstructionMergeCandidate {
  instructionIdentifier: string;
  revision: number;
  instructionText: string;
  projectIdentifier: string;
  /** 任务权威标识（同权威才可合并）。 */
  taskAuthorityIdentifier: string;
  /** 权限作用域标识（同作用域才可合并）。 */
  permissionScopeIdentifier: string;
  /** 目标标识（相容目标才可合并）。 */
  goalIdentifier: string;
  priorityTier: number;
  /** 明确声明的取代关系（**唯一**的废弃依据）。 */
  supersedesInstructionIdentifiers: string[];
  dependencyNodeIdentifiers: string[];
  completedDependencyNodeIdentifiers: string[];
  isSemanticallyConflicting: boolean;
  isGoalAmbiguous: boolean;
  requiresIndependentAuthorization: boolean;
  hasSideEffectInFlight: boolean;
}

export interface InstructionMergeEligibilityOutcome {
  canMerge: boolean;
  reason: string | null;
  mergedInstructionIdentifiers: string[];
  rejectedInstructionIdentifiers: string[];
  /**
   * 每个子结果**映射回原 ID**（卡内"每个子结果映射回原 ID"）。
   *
   * 结构为"结果键 → 原指令标识"；合并后逐个结果都能追溯回来源指令。
   */
  resultMappingByInstructionIdentifier: Record<string, string>;
  /** 因明确 `supersedes` 而被取代的指令（**不按最新文本猜测**）。 */
  supersededInstructionIdentifiers: string[];
  /** 未合并时仍**保留**的原指令（卡内"关闭后不丢组内原指令"）。 */
  retainedInstructionIdentifiers: string[];
}

/** 单条候选被拒的**具体**原因（便于逐条核对，而不是一个笼统结论）。 */
interface CandidateRejection {
  instructionIdentifier: string;
  reason: string;
}

/**
 * 判定一组候选指令是否**够格**被确定性合并。
 *
 * 保守取向：**任一**候选不满足条件即整组不合并（宁可少合并也不误合并）。
 * 拒绝时逐条给出原因，并**保留**全部原指令。
 */
export function evaluateInstructionMergeEligibility(input: {
  candidates: readonly InstructionMergeCandidate[];
  isMergeEnabled: boolean;
}): InstructionMergeEligibilityOutcome {
  const candidateIdentifiers = input.candidates.map(
    (candidate) => candidate.instructionIdentifier,
  );

  /** 开关**初始关闭**：关闭时不合并，但**不丢原指令**。 */
  if (!input.isMergeEnabled) {
    return {
      canMerge: false,
      reason:
        "指令合并开关未启用（初始关闭）：不合并，但不丢原指令（保留待逐个执行）",
      mergedInstructionIdentifiers: [],
      rejectedInstructionIdentifiers: [],
      resultMappingByInstructionIdentifier: {},
      supersededInstructionIdentifiers: [],
      retainedInstructionIdentifiers: candidateIdentifiers,
    };
  }

  /**
   * **单条**指令：没有"合并对象"，但它本身可以构成一个退化组
   * （单元素组在语义上是恒等合并）。此时逐项核对它自身的资格，
   * 而不是直接以"少于两条"拒绝 —— 否则"引用不存在的原指令"这类**建组**语义
   * 会被资格判定抢先掩盖成"无可合并对象"（实测中确实掩盖了原有断言）。
   */
  if (input.candidates.length === 0) {
    return {
      canMerge: false,
      reason: "没有候选指令",
      mergedInstructionIdentifiers: [],
      rejectedInstructionIdentifiers: [],
      resultMappingByInstructionIdentifier: {},
      supersededInstructionIdentifiers: [],
      retainedInstructionIdentifiers: [],
    };
  }

  /** 明确 supersedes ⇒ 走取代语义，**不再按文本猜测**。 */
  const supersededInstructionIdentifiers: string[] = [];
  for (const candidate of input.candidates) {
    for (const superseded of candidate.supersedesInstructionIdentifiers) {
      if (!supersededInstructionIdentifiers.includes(superseded)) {
        supersededInstructionIdentifiers.push(superseded);
      }
    }
  }
  if (supersededInstructionIdentifiers.length > 0) {
    return {
      canMerge: false,
      reason:
        "存在**明确 supersedes（取代）**关系：按取代语义处理，**不按'最新文本'猜测废弃旧任务**",
      mergedInstructionIdentifiers: [],
      rejectedInstructionIdentifiers: [],
      resultMappingByInstructionIdentifier: {},
      supersededInstructionIdentifiers,
      retainedInstructionIdentifiers: candidateIdentifiers,
    };
  }

  /** 以第一条为基准，逐条核对"同项目/同权威/同作用域/同目标"。 */
  const baseline = input.candidates[0] as InstructionMergeCandidate;
  const rejections: CandidateRejection[] = [];

  for (const candidate of input.candidates) {
    if (candidate.projectIdentifier !== baseline.projectIdentifier) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason:
          "跨项目不合并（" +
          candidate.projectIdentifier +
          " ≠ " +
          baseline.projectIdentifier +
          "）",
      });
      continue;
    }
    if (candidate.taskAuthorityIdentifier !== baseline.taskAuthorityIdentifier) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "任务权威不同不合并",
      });
      continue;
    }
    if (candidate.permissionScopeIdentifier !== baseline.permissionScopeIdentifier) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "权限作用域不同不合并",
      });
      continue;
    }
    if (candidate.goalIdentifier !== baseline.goalIdentifier) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "目标不相容（未声明为同一目标）不合并",
      });
      continue;
    }
    if (candidate.isSemanticallyConflicting) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "语义冲突不合并",
      });
      continue;
    }
    if (candidate.isGoalAmbiguous) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "目标不明不合并",
      });
      continue;
    }
    if (candidate.requiresIndependentAuthorization) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "需要独立授权不合并",
      });
      continue;
    }
    if (candidate.hasSideEffectInFlight) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason: "已产生副作用的在途操作不合并",
      });
      continue;
    }
    /** 依赖 ready：全部前驱必须已完成（**不跨依赖障碍**）。 */
    const unfinishedDependencies = candidate.dependencyNodeIdentifiers.filter(
      (dependencyNodeIdentifier) =>
        !candidate.completedDependencyNodeIdentifiers.includes(dependencyNodeIdentifier),
    );
    if (unfinishedDependencies.length > 0) {
      rejections.push({
        instructionIdentifier: candidate.instructionIdentifier,
        reason:
          "依赖未 ready（前驱未完成）不合并: " + unfinishedDependencies.join(","),
      });
      continue;
    }
  }

  if (rejections.length > 0) {
    return {
      canMerge: false,
      reason:
        "存在不够格的候选（逐条原因）: " +
        rejections
          .map(
            (rejection) => rejection.instructionIdentifier + "（" + rejection.reason + "）",
          )
          .join("；"),
      mergedInstructionIdentifiers: [],
      rejectedInstructionIdentifiers: rejections.map(
        (rejection) => rejection.instructionIdentifier,
      ),
      resultMappingByInstructionIdentifier: {},
      supersededInstructionIdentifiers: [],
      retainedInstructionIdentifiers: candidateIdentifiers,
    };
  }

  /** 全部够格：给出**逐条映射回原 ID** 的结果映射表。 */
  const resultMappingByInstructionIdentifier: Record<string, string> = {};
  for (const candidate of input.candidates) {
    resultMappingByInstructionIdentifier[candidate.instructionIdentifier] =
      candidate.instructionIdentifier;
  }
  return {
    canMerge: true,
    reason: null,
    mergedInstructionIdentifiers: [...candidateIdentifiers],
    rejectedInstructionIdentifiers: [],
    resultMappingByInstructionIdentifier,
    supersededInstructionIdentifiers: [],
    retainedInstructionIdentifiers: [],
  };
}

export interface ExecutionGroupMember {
  instructionIdentifier: string;
  hasExecuted: boolean;
  hasSideEffectInFlight: boolean;
}

export interface SafetyPointSplitOutcome {
  splitBackInstructionIdentifiers: string[];
  retainedInstructionIdentifiers: string[];
  /**
   * 是否重放了副作用。
   *
   * **恒为 false**：拆回**只针对未执行且无在途副作用**的项
   * （卡内"不重放在途操作"、"执行后不能通过拆组合并重放副作用"）。
   */
  isSideEffectReplayed: false;
}

/**
 * 关闭合并后，在**安全点**拆回未执行项（卡内 §1.1 末条）。
 *
 * 规则：只拆"**未执行**且**无在途副作用**"的成员；
 * 已执行的保留（拆回会重放副作用），有在途副作用的保留（不得打断在途操作）。
 */
export function splitExecutionGroupAtSafetyPoint(input: {
  groupIdentifier: string;
  members: readonly ExecutionGroupMember[];
}): SafetyPointSplitOutcome {
  const splitBackInstructionIdentifiers: string[] = [];
  const retainedInstructionIdentifiers: string[] = [];
  for (const member of input.members) {
    if (!member.hasExecuted && !member.hasSideEffectInFlight) {
      splitBackInstructionIdentifiers.push(member.instructionIdentifier);
    } else {
      retainedInstructionIdentifiers.push(member.instructionIdentifier);
    }
  }
  return {
    splitBackInstructionIdentifiers,
    retainedInstructionIdentifiers,
    isSideEffectReplayed: false,
  };
}
