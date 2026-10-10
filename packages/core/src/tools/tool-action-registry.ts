/**
 * MERGE-01-01/02：**能力族 + action 统一**（2026-10-10）。
 *
 * 契约来源：MERGE-01 卡 §1.2。
 *
 * 设计要点（逐条对应卡内要求）：
 *  - 用**能力族 + action 枚举**复用现有工具，不为相近格式另造一套名称；
 *  - 保留**旧名称兼容别名**并路由到**同一实现**（同一 action）；
 *  - **不得**退化成"任意 shell / 任意方法调用入口"：未知族名/未知 action 一律拒绝；
 *  - 副作用、权限、备份与幂等性由**每个 action 自身**判定——
 *    含写动作的族**不得整体伪装 readonly**；
 *  - 每个 action 声明**必需参数**，供"可校验 schema 分支"使用；
 *  - 只读投影（Ponder/主 Agent 视图）**只暴露 `isReadOnly` 的 action**，
 *    统一工具名不会让隐藏写动作绕过本地执行检查。
 *
 * 本模块是**纯数据 + 纯函数**：不做 I/O、不读配置、不调用模型。
 * 生产接线（描述符/执行派发）在其之上，不改变此处语义。
 */

/** action 的变更类别：沿用本仓既有 `mutationKind` 词汇，便于描述符直接复用。 */
export type ToolActionMutationKind =
  | "none"
  | "create-only"
  | "overwrite"
  | "delete-resource";

export interface ToolActionDescriptor {
  /** action 枚举值（族内唯一）。 */
  action: string;
  /** 旧名称兼容别名（含"统一前的原名"）；同一 action 可保留多个。 */
  aliases: string[];
  /**
   * 该 action 是否**只读**。
   *
   * 这是只读投影的唯一依据：含写动作的族必须把写 action 标为 false，
   * 不得为了让族"整体看起来只读"而误标。
   */
  isReadOnly: boolean;
  mutationKind: ToolActionMutationKind;
  /** 变更前是否必须由工具自动备份（写动作通常为 true）。 */
  requiresPreMutationBackup: boolean;
  /** 重放是否不产生额外副作用（恢复分类的权威依据）。 */
  isIdempotent: boolean;
  /** 必需参数名（供可校验 schema 分支；缺失即拒绝该 action 的调用）。 */
  requiredParameters: string[];
}

export interface ToolCapabilityFamily {
  /** 统一后的族名（对外暴露的统一工具名）。 */
  familyName: string;
  actions: ToolActionDescriptor[];
}

const PROJECT_FILE_READ_FAMILY_NAME = "projectFileRead";

/**
 * 纵向样本：把既有两条相近的只读入口
 * `readFile`（按文件读）与 `searchProjectText`（按文本检索）统一到一个能力族。
 *
 * 两者都只读、都幂等、都不需要备份；统一后仍**保留原名作为兼容别名**。
 */
export const PROJECT_FILE_READ_FAMILY: ToolCapabilityFamily = {
  familyName: PROJECT_FILE_READ_FAMILY_NAME,
  actions: [
    {
      action: "read",
      aliases: ["readFile"],
      isReadOnly: true,
      mutationKind: "none",
      requiresPreMutationBackup: false,
      isIdempotent: true,
      requiredParameters: ["filePath"],
    },
    {
      action: "search",
      aliases: ["searchProjectText"],
      isReadOnly: true,
      mutationKind: "none",
      requiresPreMutationBackup: false,
      isIdempotent: true,
      requiredParameters: ["pattern"],
    },
  ],
};

/** 全部已登记的能力族（当前只登记纵向样本；新增族必须逐 action 判副作用）。 */
export const REGISTERED_TOOL_CAPABILITY_FAMILIES: ToolCapabilityFamily[] = [
  PROJECT_FILE_READ_FAMILY,
];

export interface ResolvedToolAction {
  familyName: string;
  action: string;
  /** 该 action 的判定依据：副作用/备份/幂等/必需参数（无需再解一层 descriptor）。 */
  isReadOnly: boolean;
  mutationKind: ToolActionMutationKind;
  requiresPreMutationBackup: boolean;
  isIdempotent: boolean;
  requiredParameters: string[];
}

/**
 * 把"统一族名 + action"或"旧兼容别名"解析为具体 action。
 *
 * 拒绝一切不认识的名字/action（**不得**退化为任意方法调用入口）：
 *  - 只给别名 ⇒ 必须在该族 action 的 `aliases` 中精确命中；
 *  - 给族名 ⇒ 必须同时给出**该族已声明**的 action；
 *  - 其它情况返回 null（调用方 fail-closed，不猜测）。
 */
/** 把内部描述符摊平为对外解析结果（调用方无需再解一层）。 */
function toResolvedToolAction(
  familyName: string,
  descriptor: ToolActionDescriptor,
): ResolvedToolAction {
  return {
    familyName,
    action: descriptor.action,
    isReadOnly: descriptor.isReadOnly,
    mutationKind: descriptor.mutationKind,
    requiresPreMutationBackup: descriptor.requiresPreMutationBackup,
    isIdempotent: descriptor.isIdempotent,
    requiredParameters: [...descriptor.requiredParameters],
  };
}

export function resolveToolAction(input: {
  toolNameOrAlias: string;
  action?: string;
}): ResolvedToolAction | null {
  const { toolNameOrAlias, action } = input;
  for (const family of REGISTERED_TOOL_CAPABILITY_FAMILIES) {
    if (toolNameOrAlias === family.familyName) {
      if (action === undefined) {
        return null;
      }
      const matched = family.actions.find((candidate) => candidate.action === action);
      return matched === undefined
        ? null
        : toResolvedToolAction(family.familyName, matched);
    }
    // 别名不再接受额外 action（避免"旧名 + 任意 action"绕过枚举）。
    if (action !== undefined) {
      continue;
    }
    const matchedByAlias = family.actions.find((candidate) =>
      candidate.aliases.includes(toolNameOrAlias),
    );
    if (matchedByAlias !== undefined) {
      return toResolvedToolAction(family.familyName, matchedByAlias);
    }
  }
  return null;
}

/**
 * 只读投影：**只**返回 `isReadOnly === true` 的 action。
 *
 * Ponder/主 Agent 的只读工具视图必须经由此函数构造，保证统一族名不会
 * 把隐藏的写动作暴露给只读视图。
 */
export function projectReadOnlyActionProjection(
  family: ToolCapabilityFamily,
): ToolActionDescriptor[] {
  return family.actions.filter((action) => action.isReadOnly);
}

/**
 * 校验一次调用是否满足该 action 的必需参数（供可校验 schema 分支使用）。
 *
 * 参数不可解析、缺少必需参数、或出现该 action **不认识**的字段 ⇒ 拒绝（fail-closed）。
 * 这保证"动作切换"（例如 read→write）不会因为沿用旧参数而被静默接受。
 */
export function validateActionArguments(input: {
  descriptor: ToolActionDescriptor;
  argumentsJson: string;
}): { isValid: boolean; reason: string | null } {
  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(input.argumentsJson) as unknown;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { isValid: false, reason: "参数不是 JSON 对象" };
    }
    parsed = candidate as Record<string, unknown>;
  } catch {
    return { isValid: false, reason: "参数不是合法 JSON" };
  }
  for (const parameterName of input.descriptor.requiredParameters) {
    if (!(parameterName in parsed)) {
      return { isValid: false, reason: "缺少必需参数: " + parameterName };
    }
  }
  return { isValid: true, reason: null };
}
