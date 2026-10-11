/**
 * 权限询问的**本地结构化安全预览**。
 *
 * **2026-10-11 新增（GUI-02-01，用户要求）**。用户原文：
 * > 关键参数采用**本地生成的结构化安全预览**，而非模糊的一句话。
 * > 例如展示**项目内相对路径、创建／覆盖动作、内容长度、变更摘要及影响范围**；
 * > 文件写入可提供按权限过滤的差异预览；**敏感值遮蔽，不进入事件**。
 * > 若脱敏后不足以让用户准确判断，**不能要求用户盲批**：
 * > 改走**独立受控详情**或**专用授权流程**。
 * > **指纹是绑定依据，不是用户理解操作的替代品。**
 *
 * 设计要点：
 * - **只输出白名单字段**（见 `PermissionAskSafePreview`）；**原始 `argumentsJson`
 *   绝不进入本结构**（用户明确禁止其进入公共事件）；
 * - **本地脱敏**：复用 `redactSensitiveText`（凭据样式 ⇒ `[REDACTED]`），
 *   并对 `explanation` 与差异预览**同样**处理 —— **不因名为"摘要"就信任模型文本**；
 * - **长度受限**：所有字符串都有上限，且被截断的字段**显式列入 `truncatedFields`**
 *   （不静默丢弃信息）；
 * - **敏感路径**（`.env`、私钥、凭据库等）⇒ `requiresControlledDetail: true`
 *   且**不提供内容与差异预览** ⇒ 调用方必须改走受控详情，**不得要求用户盲批**；
 * - **参数不可解析** ⇒ `action: "unknown"` + `requiresControlledDetail: true`（保守，不猜）；
 * - 依赖方向：只用 core 内部件；**不依赖界面层或终端**。
 */
import path from "node:path";

import { redactSensitiveText } from "./diagnostic-event-store.js";

/** 动作类型（工具含多种操作时必须明确）。`unknown` 为**保守**取值。 */
export type PermissionAskPreviewAction =
  | "create"
  | "overwrite"
  | "delete"
  | "read"
  | "list"
  | "search"
  | "unknown";

/** 结构化安全预览：**白名单字段**，供公共事件与授权详情卡使用。 */
export interface PermissionAskSafePreview {
  /** 要执行的动作（创建/覆盖/…；不可判定时为 `unknown`）。 */
  action: PermissionAskPreviewAction;
  /** **项目内相对路径**；不可判定或超出项目根时为 null。 */
  targetPathRelative: string | null;
  /** 内容长度（字符数）；无内容时为 0。 */
  contentLength: number;
  /** 涉及文件数（批量操作时 >1）。 */
  fileCount: number;
  /** 影响范围（本地生成的结构化描述，不是模糊一句话）。 */
  impactScope: string;
  /**
   * 按权限过滤的差异预览；**敏感路径或无内容时为 null**。
   * 已脱敏、已限长。
   */
  diffPreview: string | null;
  /** 经脱敏与限长的说明。 */
  explanation: string;
  /**
   * `true` ⇒ 脱敏后**不足以让用户准确判断**，必须改走**独立受控详情**
   * 或**专用授权流程**；调用方**不得**据此要求用户盲批。
   */
  requiresControlledDetail: boolean;
  /** 被截断/未完整展开的字段名列表（显式标注，不静默丢弃）。 */
  truncatedFields: string[];
}

/** 预览中各字段的长度上限（本地限制，防止事件膨胀与信息泄漏面扩大）。 */
export const PERMISSION_ASK_PREVIEW_LIMITS = {
  explanationCharacters: 512,
  diffPreviewCharacters: 2_000,
  targetPathCharacters: 512,
  /** 超过此长度的内容**不在预览内联展开**，只给长度。 */
  inlineContentCharacters: 1_000,
} as const;

/** 判定"敏感路径名"的本地保守规则（可注入更强的匹配器）。 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(credentials|secrets?|tokens?)(\..*)?$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.npmrc$/i,
];

function isSensitivePathName(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 截断并**登记**被截断的字段（显式，不静默）。 */
function clip(
  value: string,
  maximumCharacters: number,
  fieldName: string,
  truncatedFields: string[],
): string {
  if (value.length <= maximumCharacters) {
    return value;
  }
  if (!truncatedFields.includes(fieldName)) {
    truncatedFields.push(fieldName);
  }
  // 标记本身也计入上限：截断后的**总长度不得超过上限**（契约是"长度受限"）。
  const marker = "…[已截断]";
  const keep = Math.max(0, maximumCharacters - marker.length);
  return value.slice(0, keep) + marker;
}

/** 把绝对路径转为项目内相对路径；不在项目内或不可判定 ⇒ null。 */
function toProjectRelativePath(
  rawPath: string,
  projectRootPath: string,
): string | null {
  if (rawPath === "" || rawPath.includes("\0")) {
    return null;
  }
  const normalizedRoot = path.resolve(projectRootPath);
  const absolute = path.resolve(normalizedRoot, rawPath);
  const relative = path.relative(normalizedRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.replaceAll("\\", "/");
}

/** 从参数里读取目标路径（键序与门禁一致）。 */
function readTargetPathFromArguments(
  record: Record<string, unknown>,
): string | null {
  for (const key of ["path", "filePath", "targetPath", "directoryPath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function readContentFromArguments(
  record: Record<string, unknown>,
): string | null {
  for (const key of ["content", "contents", "text", "newContent"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/**
 * 由动作与目标路径推导动作类型。
 * 读写判定依据工具名中的动词，**不猜测语义**；不可判定即 `unknown`。
 */
export function inferPreviewAction(input: {
  toolName: string;
  hasContent: boolean;
}): PermissionAskPreviewAction {
  const toolNameLower = input.toolName.toLowerCase();
  if (toolNameLower.includes("delete") || toolNameLower.includes("remove")) {
    return "delete";
  }
  if (toolNameLower.includes("read")) {
    return "read";
  }
  if (toolNameLower.includes("list")) {
    return "list";
  }
  if (toolNameLower.includes("search") || toolNameLower.includes("grep")) {
    return "search";
  }
  if (
    toolNameLower.includes("write") ||
    toolNameLower.includes("create") ||
    toolNameLower.includes("edit") ||
    toolNameLower.includes("apply") ||
    toolNameLower.includes("save")
  ) {
    // 无内容 ⇒ 更可能是就地修改；有内容 ⇒ 更可能是新建（覆盖仍需用户判断，
    // 故此处只描述"写入"性质，覆盖与否由差异预览体现）。
    return input.hasContent ? "create" : "overwrite";
  }
  return "unknown";
}

/**
 * 生成**本地结构化安全预览**。
 *
 * 本函数**不返回**原始参数；调用方也无法从返回结构还原原始参数
 * （只保留长度与脱敏后的差异预览）。
 */
export function buildPermissionAskSafePreview(input: {
  toolName: string;
  argumentsJson: string;
  explanation: string;
  projectRootPath: string;
  /** 可注入更强的敏感路径匹配器（例如 `SensitiveContentAccessPolicy`）。 */
  matchSensitivePathName?: (filePath: string) => string | null;
}): PermissionAskSafePreview {
  const truncatedFields: string[] = [];
  const explanation = clip(
    redactSensitiveText(input.explanation),
    PERMISSION_ASK_PREVIEW_LIMITS.explanationCharacters,
    "explanation",
    truncatedFields,
  );

  let parsedArguments: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input.argumentsJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsedArguments = parsed as Record<string, unknown>;
    }
  } catch {
    parsedArguments = null;
  }

  if (parsedArguments === null) {
    // 参数不可解析：**保守**，不猜动作与路径。
    return {
      action: "unknown",
      targetPathRelative: null,
      contentLength: 0,
      fileCount: 0,
      impactScope: "范围未知（参数无法解析），需受控详情确认",
      diffPreview: null,
      explanation,
      requiresControlledDetail: true,
      truncatedFields,
    };
  }

  const rawTargetPath = readTargetPathFromArguments(parsedArguments);
  const content = readContentFromArguments(parsedArguments);
  const contentLength = content === null ? 0 : content.length;
  const action = inferPreviewAction({
    toolName: input.toolName,
    hasContent: content !== null,
  });

  const targetPathRelative =
    rawTargetPath === null
      ? null
      : toProjectRelativePath(rawTargetPath, input.projectRootPath) === null
        ? null
        : clip(
            toProjectRelativePath(rawTargetPath, input.projectRootPath) as string,
            PERMISSION_ASK_PREVIEW_LIMITS.targetPathCharacters,
            "targetPathRelative",
            truncatedFields,
          );

  const isSensitive =
    rawTargetPath !== null &&
    ((input.matchSensitivePathName ?? (() => (isSensitivePathName(rawTargetPath) ? rawTargetPath : null)))(
      rawTargetPath,
    ) !== null);

  const fileCount = Array.isArray(parsedArguments["files"])
    ? (parsedArguments["files"] as unknown[]).length
    : rawTargetPath === null
      ? 0
      : 1;

  const isContentInlined =
    content !== null &&
    content.length > PERMISSION_ASK_PREVIEW_LIMITS.inlineContentCharacters;
  if (isContentInlined && !truncatedFields.includes("content")) {
    truncatedFields.push("content");
  }

  if (isSensitive) {
    // 敏感路径：**不提供内容与差异预览** ⇒ 必须走受控详情，不得要求盲批。
    return {
      action,
      targetPathRelative,
      contentLength,
      fileCount,
      impactScope:
        "涉及敏感路径，按本地策略**不展开内容**（影响范围需经受控详情确认）",
      diffPreview: null,
      explanation,
      requiresControlledDetail: true,
      truncatedFields,
    };
  }

  let diffPreview: string | null = null;
  if (content !== null && (action === "create" || action === "overwrite")) {
    const addedLines = content
      .split(/\r?\n/)
      .slice(0, 40)
      .map((line) => "+ " + line)
      .join("\n");
    diffPreview = clip(
      redactSensitiveText(addedLines),
      PERMISSION_ASK_PREVIEW_LIMITS.diffPreviewCharacters,
      "diffPreview",
      truncatedFields,
    );
  }

  const impactScopeParts = [
    action === "unknown" ? "动作不可判定" : "动作 " + action,
    targetPathRelative === null ? "目标不在项目内或不可判定" : "项目内 " + targetPathRelative,
    fileCount > 1 ? String(fileCount) + " 个文件" : "单文件",
  ];
  if (contentLength > 0) {
    impactScopeParts.push("内容 " + String(contentLength) + " 字符");
  }

  return {
    action,
    targetPathRelative: targetPathRelative === null ? null : redactSensitiveText(targetPathRelative),
    contentLength,
    fileCount,
    impactScope: redactSensitiveText(impactScopeParts.join("；")),
    diffPreview,
    explanation,
    requiresControlledDetail: false,
    truncatedFields,
  };
}
