/**
 * 权限询问（permission-ask）的**公共契约与纯判定**。
 *
 * **2026-10-11 提取（GUI-02-01）**：以下语义原**只存在于 CLI 所在包**，
 * 使 GUI 若要复用它只能**复制授权规则**（用户明确禁止）。按用户决策提出：
 *
 * - **提取到核心应用服务层**：请求形态、批准复用判定、升级文本解析、裁决端口协议；
 * - **CLI 保留终端 I/O 适配**：提示输出、TTY/管道判定、读决策、等待；
 * - **GUI 使用同一服务**，不复制规则；
 * - **核心不得反向依赖界面层类型或终端交互** —— 本模块不 import 任何界面层模块、
 *   不触碰 `process.stdin`/`stderr`/`readline`。
 *   （注意：`tests/core/unit/public-sdk.test.ts` 的依赖方向守卫是**纯文本**匹配，
 *    故此处**刻意不写出界面包的目录字面量**，以免注释被误判为跨层依赖。）
 *
 * **行为兼容**：本次为**纯搬移**，不改语义。CLI 公开可观察行为基线见
 * `docs/reports/GUI02_01_EXISTING_PERMISSION_ASK_BEHAVIOR_BASELINE_2026-10-11.md`
 * （B1–B8、文案逐字基线、批准复用三态、目标路径键序）。
 */

import { hashToolArguments } from "../core/permission-policy.js";

/** 结构化权限询问：**精确参数不得改写、不得截断**（授权按参数哈希绑定）。 */
export interface PermissionAsk {
  taskIdentifier: string;
  toolName: string;
  /** 精确参数（授权哈希绑定用；不得改写、不得截断）。 */
  argumentsJson: string;
  explanation: string;
}

export type PermissionAskDecision =
  | "allowed-once"
  | "denied"
  | "requires-human-resubmission";

/** 本授权周期内**已批准过**的一次操作（用于抑制参数抖动带来的重复裁决）。 */
export interface PreviousApprovalRecord {
  toolName: string;
  /** 上次批准时的完整参数（用于识别"完全相同即已执行"）。 */
  argumentsJson: string;
  /** 同一目标路径是否已经**成功写入**过（成功后不得靠抖动复用，必须 fail-closed）。 */
  hasSucceededWithSameTarget: boolean;
  /**
   * 该批准的**有效期**（ISO 时间点）。
   *
   * GUI-02-01 R1（2026-10-11）：用户 S3 要求"**过期**…不得复用批准"。
   * 缺省 `null` 表示不设期限（保持既有调用方行为不变）；
   * 一旦提供且已过期 ⇒ 判定为 `ask-user`（必须重新询问）。
   */
  expiresAtIso?: string | null;
}

export type ApprovalReuseDecision =
  /** 同一逻辑操作（同工具 + 同目标路径）且尚无副作用 → 直接复用本次批准，不再询问。 */
  | "reuse-without-asking"
  /** 该目标路径已成功执行过 → 不得复用（重放保护不放宽）。 */
  | "already-executed"
  /** 不是同一逻辑操作或缺少依据 → 必须询问用户。 */
  | "ask-user";

/** 参数中承载目标路径的键（与 `describeToolOperation` 同序）。 */
const TARGET_PATH_KEYS = ["path", "filePath", "targetPath", "directoryPath"] as const;

function readTargetPath(argumentsJson: string): string | null {
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (parsedArguments === null || typeof parsedArguments !== "object") {
    return null;
  }
  const record = parsedArguments as Record<string, unknown>;
  for (const key of TARGET_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/**
 * 方案 B（2026-10-02 用户选择）：**同一授权周期内容忍"无副作用重试"的参数抖动**。
 *
 * 判定依据全部是本地的客观事实：工具名 + 参数中的**目标路径** + 是否已成功写入过。
 * - 目标路径相同、工具相同、尚无副作用 → 复用（参数只有换行/键序等格式差异）；
 * - 该路径已成功写入过，且完整参数与上次相同 → 判"已执行"（fail-closed）；
 * - 其余（路径不同/工具不同/参数不可解析/无批准记录）→ 必须询问用户。
 *
 * 该判定**不放松跨周期语义**：它只在"用户已经对同一逻辑操作批准过一次、且尚无副作用"时
 * 免除重复询问；一旦成功，同一逻辑操作再次调用仍被门禁重放保护拒绝。
 */
export function shouldReusePreviousApproval(input: {
  pendingAsk: PermissionAsk;
  previousApproval: PreviousApprovalRecord | null;
}): ApprovalReuseDecision {
  const { pendingAsk, previousApproval } = input;
  if (previousApproval === null) {
    return "ask-user";
  }
  if (previousApproval.toolName !== pendingAsk.toolName) {
    return "ask-user";
  }
  /**
   * **R1（2026-10-11 用户批准）**：改为比较**完整规范化参数指纹**。
   *
   * 旧实现只比"工具名 + 目标路径"，导致**同一路径、内容不同**也复用批准，
   * 与 S3"绑定完整参数指纹"冲突。
   *
   * 复用 `hashToolArguments`（`core/permission-policy.ts`）：它**先递归键序规范化再 sha256**，
   * 因而同时满足两条要求：
   *  - **内容变化 ⇒ 指纹变化** ⇒ `ask-user`（消除缺陷）；
   *  - **仅键序/空白差异 ⇒ 同一指纹** ⇒ 仍复用（**保住** 2026-10-02 方案 B 的格式抖动容忍）。
   *
   * 目标路径的比较**保留**：它给出更明确的"路径不同"信号，且与门禁的作用域判定同源。
   */
  const pendingTargetPath = readTargetPath(pendingAsk.argumentsJson);
  const approvedTargetPath = readTargetPath(previousApproval.argumentsJson);
  if (pendingTargetPath === null || approvedTargetPath === null) {
    // 参数不可解析或无可判定路径 ⇒ 保守询问。
    return "ask-user";
  }
  if (pendingTargetPath !== approvedTargetPath) {
    return "ask-user";
  }
  /**
   * **有效期（R1）**：S3 要求"过期…不得复用批准"。
   * 缺省不设期限（保持既有调用方行为不变）；已过期 ⇒ 必须重新询问。
   */
  const expiresAtIso = previousApproval.expiresAtIso ?? null;
  if (expiresAtIso !== null && Date.parse(expiresAtIso) <= Date.now()) {
    return "ask-user";
  }
  /**
   * 完整规范化参数指纹比较：**这是 R1 的核心**。
   * 注意顺序 —— 先判"已成功写入"（fail-closed），再判指纹：
   * 已成功写入时无论指纹是否相同都不得复用（重放保护不放宽）。
   */
  if (previousApproval.hasSucceededWithSameTarget) {
    return "already-executed";
  }
  if (
    hashToolArguments(pendingAsk.argumentsJson) !==
    hashToolArguments(previousApproval.argumentsJson)
  ) {
    return "ask-user";
  }
  return "reuse-without-asking";
}

/** 裁决执行需要的最小应用面（避免依赖 facade 具体类型）。 */
export interface PermissionAskApplicationPort {
  grantSessionAuthorization(
    toolName: string,
    argumentsJson: string,
    nowUnixSeconds: number,
  ): Promise<void>;
  /**
   * 重新登记作用域一次性授权（被询问拦下的那次会消耗它；缺失实现时跳过，
   * 由调用方在结果上如实反映）。
   */
  grantScopeAuthorizationForToolCall?(input: {
    toolName: string;
    argumentsJson: string;
  }): Promise<{ receiptIdentifier: string; operationFingerprint: string } | null>;
  sendSchedulerInstruction(missionId: string, instructionText: string): void;
}

export interface PermissionAskDecisionPort {
  /** 是否具备可信交互通道（TTY）。false 时必须 fail-closed。 */
  isInteractive(): boolean;
  /** 询问用户；返回 null 表示无裁决（fail-closed）。 */
  readDecision(ask: PermissionAsk): Promise<"allow-once" | "deny" | null>;
}

/**
 * 匹配形态（**不锚定结尾**）：真实升级文本的参数 JSON 键序不定
 * （实测 `{"content": ..., "filePath": ...}`），且可能带尾随换行。
 */
const ESCALATION_PATTERN =
  /任务\s+(\S+)\s+需要权限调用\s+(\S+?)\s*[（(]([\s\S]*?)[）)]，参数:\s*(\{[\s\S]*\})\s*$/;

/**
 * 从调度层升级文本解析结构化询问。
 * 来源：`mission-orchestrator` 的 permission-ask 分支（同一字符串即 ADR-0011 要求送达用户的内容）。
 * 解析失败返回 null：调用方必须退化为"需人工重提"，不得猜测工具或参数。
 */
export function buildPermissionAskFromEscalation(
  escalationText: string,
): PermissionAsk | null {
  const normalizedText = escalationText.trim();
  const matched = ESCALATION_PATTERN.exec(normalizedText);
  if (matched === null) {
    return null;
  }
  const taskIdentifier = matched[1];
  const toolName = matched[2];
  const explanation = matched[3];
  const argumentsJson = matched[4];
  if (
    taskIdentifier === undefined ||
    toolName === undefined ||
    explanation === undefined ||
    argumentsJson === undefined
  ) {
    return null;
  }
  try {
    // 逐字保留原始 JSON（授权按参数哈希绑定），此处只做可解析性校验。
    JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  return {
    taskIdentifier,
    toolName,
    argumentsJson,
    explanation: explanation.trim(),
  };
}
