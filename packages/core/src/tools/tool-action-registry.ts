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
  /**
   * 该 action 是否支持统一的 `format` / `view` 视图参数（MERGE-01 §1.2）。
   *
   * 与"必需参数"一样**逐 action** 判定：不适用的 action 收到这些参数必须**拒绝**，
   * 而不是静默忽略（否则调用方会以为视图语义生效了）。
   */
  supportsReadViewParameters?: boolean;
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
      supportsReadViewParameters: true,
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

/**
 * 统一视图参数允许的 `format` 取值（枚举）。
 *
 * **只列出确有实现**的取值（2026-10-10 实测校准）：
 *  - `auto`：按扩展名解析策略的**既有行为**；
 *  - `text`：强制原文视图（逐字节，不做视图过滤）。
 *
 * `code`/`markup`/`data` 等"按内容族分组"的取值**不在枚举内**：本仓
 * `ReadFormatStrategyRegistry.resolve()` 只按 `fileName/extension/contentSample` 选策略，
 * **不读 format**；把它们放进枚举会让调用方以为分组生效，实际是**静默无效参数**。
 * 待真正的策略分组实现落地后再加入（届时必须同时补反例）。
 */
export const READ_VIEW_FORMATS = ["auto", "text"] as const;
export type ReadViewFormat = (typeof READ_VIEW_FORMATS)[number];

/**
 * 统一视图参数允许的 `view` 取值。
 *
 * **当前为空**：`ReadViewReceipt` / `formatReadFileViewOutput` 只能产出原文或
 * "已过滤"两种形态，**无法产出 summary/outline**。因此不提供任何 view 取值——
 * 传入 `view` 将被**拒绝**（而非静默忽略）。待实现真正的摘要/大纲视图后再加入。
 */
export const READ_VIEW_KINDS: readonly string[] = [];
export type ReadViewKind = string;

export type NormalizeReadViewOutcome =
  | "normalized"
  | "unknown-tool-action"
  | "parameter-not-applicable"
  | "invalid-arguments"
  | "invalid-format"
  | "invalid-view";

export interface NormalizedReadViewParameters {
  outcome: NormalizeReadViewOutcome;
  /** 解析出的 action（未解析成功时为 null）。 */
  action: string | null;
  /** 规范化的 format；失败时为 null。 */
  format: ReadViewFormat | null;
  /** 规范化的 view；失败时为 null。 */
  view: ReadViewKind | null;
  /** 既有 `readFile` 视图布尔参数的规范化取值。 */
  shouldIncludeComments: boolean | null;
  shouldIncludeImports: boolean | null;
  reason: string | null;
}

/**
 * MERGE-01 §1.2：统一读取工具的 **format / view 参数化**（单一规范化入口）。
 *
 * 为什么要有这一层：`readFile` 已有 `shouldIncludeComments` / `shouldIncludeImports`，
 * 但若每个调用点各自解释"视图参数"，同一族内的语义就会分叉。此处把
 * "族名或别名 → action → 视图参数"固定为**一个确定性判定点**：
 *  - 别名与统一名走**同一实现**，规范化结果必须完全一致；
 *  - 缺省值与**既有读取行为一致**（两个布尔参数缺省 true、format 缺省 `auto`），
 *    因此引入 format/view **不改变**默认读取；
 *  - 仅 `supportsReadViewParameters` 的 action 接受这些参数，其余**拒绝**（不透传、不忽略）；
 *  - format/view 与布尔参数都做**严格类型与枚举校验**，非法一律拒绝（fail-closed）。
 */
export function normalizeReadViewParameters(input: {
  toolNameOrAlias: string;
  action?: string;
  argumentsJson: string;
}): NormalizedReadViewParameters {
  const failure = (
    outcome: NormalizeReadViewOutcome,
    reason: string,
    action: string | null = null,
  ): NormalizedReadViewParameters => ({
    outcome,
    action,
    format: null,
    view: null,
    shouldIncludeComments: null,
    shouldIncludeImports: null,
    reason,
  });

  const resolved =
    input.action === undefined
      ? resolveToolAction({ toolNameOrAlias: input.toolNameOrAlias })
      : resolveToolAction({ toolNameOrAlias: input.toolNameOrAlias, action: input.action });
  if (resolved === null) {
    return failure(
      "unknown-tool-action",
      "未知工具名/别名或未知 action（不得猜测）",
    );
  }

  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(input.argumentsJson) as unknown;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return failure("invalid-arguments", "参数不是 JSON 对象", resolved.action);
    }
    parsed = candidate as Record<string, unknown>;
  } catch {
    return failure("invalid-arguments", "参数不是合法 JSON", resolved.action);
  }

  const hasViewParameter =
    "format" in parsed || "view" in parsed || "shouldIncludeComments" in parsed ||
    "shouldIncludeImports" in parsed;
  const supportsViewParameters = (() => {
    for (const family of REGISTERED_TOOL_CAPABILITY_FAMILIES) {
      if (family.familyName !== resolved.familyName) {
        continue;
      }
      const descriptor = family.actions.find(
        (candidate) => candidate.action === resolved.action,
      );
      return descriptor?.supportsReadViewParameters === true;
    }
    return false;
  })();
  if (hasViewParameter && !supportsViewParameters) {
    return failure(
      "parameter-not-applicable",
      "该 action 不支持 format/view 视图参数（拒绝，不得静默忽略）",
      resolved.action,
    );
  }

  // format：缺省 auto；必须在枚举内
  const rawFormat = parsed["format"];
  let format: ReadViewFormat = "auto";
  if (rawFormat !== undefined) {
    if (typeof rawFormat !== "string" || !READ_VIEW_FORMATS.includes(rawFormat as ReadViewFormat)) {
      return failure(
        "invalid-format",
        "format 必须是枚举值之一: " + READ_VIEW_FORMATS.join(" | "),
        resolved.action,
      );
    }
    format = rawFormat as ReadViewFormat;
  }

  // view：**当前无任何受支持取值** ⇒ 给出 view 即拒绝（不静默忽略）。
  const rawView = parsed["view"];
  if (rawView !== undefined) {
    return failure(
      "invalid-view",
      "view 当前无受支持取值（尚未实现摘要/大纲视图）：不得静默忽略，请省略该参数",
      resolved.action,
    );
  }
  const view: ReadViewKind | null = null;

  // 既有布尔视图参数：缺省 true（与既有读取行为一致）；必须为布尔类型。
  const readBoolean = (
    parameterName: string,
    defaultValue: boolean,
  ): { isOk: true; value: boolean } | { isOk: false } => {
    const rawValue = parsed[parameterName];
    if (rawValue === undefined) {
      return { isOk: true, value: defaultValue };
    }
    if (typeof rawValue !== "boolean") {
      return { isOk: false };
    }
    return { isOk: true, value: rawValue };
  };
  const comments = readBoolean("shouldIncludeComments", true);
  const imports = readBoolean("shouldIncludeImports", true);
  if (!comments.isOk || !imports.isOk) {
    return failure(
      "invalid-arguments",
      "shouldIncludeComments/shouldIncludeImports 必须为布尔值",
      resolved.action,
    );
  }

  return {
    outcome: "normalized",
    action: resolved.action,
    format,
    view,
    shouldIncludeComments: comments.value,
    shouldIncludeImports: imports.value,
    reason: null,
  };
}
