/**
 * 权限询问的**公共事件**（GUI-02-01，2026-10-11 用户指定字段白名单）。
 *
 * 用户原文：
 * > 在你建议的字段上，补齐或复用公共事件信封中的：
 * > - `projectIdentifier`、`sessionIdentifier`；
 * > - 发起方具体 `agentInstanceId`；
 * > - `action`：工具包含多种操作时必须明确；
 * > - `operationFingerprint`：绑定本地保存的完整规范化参数；
 * > - 请求状态及请求自身的 revision，用于多页面同步和拒绝陈旧裁决。
 * > **不重复已有信封字段。** `explanation` 和参数摘要也必须经过本地脱敏与长度限制，
 * > 不能因为叫"摘要"就直接信任模型文本。
 * > **禁止原始 argumentsJson 进入公共事件。**
 *
 * 设计决定（如实记录）：
 * - **不改动公共信封**（`PublicAstarrayEvent` 的 `{ revision, idempotencyId }`）：
 *   给信封加 `projectIdentifier`/`sessionIdentifier`/`agentInstanceId` 会牵动
 *   **所有既有事件种类**与消费方，属破坏性改动。用户要求"**不重复已有信封字段**"，
 *   而这三项**在信封里并不存在** ⇒ 因此放在**本事件自身**上（加法式、不破坏既有）。
 * - 事件**只携带安全预览**（`PermissionAskSafePreview`），**绝不携带原始参数**；
 *   预览由本地生成、已脱敏、已限长（见 `permission-ask-safe-preview.ts`）。
 * - 依赖方向：仅 core 内部件；**不依赖界面层或终端**。
 */
import {
  buildPermissionAskSafePreview,
  type PermissionAskSafePreview,
} from "./permission-ask-safe-preview.js";
import type {
  PermissionAskRequestRecord,
  PermissionAskRequestStatus,
} from "./permission-ask-request-store.js";

/** 事件类型标识（供订阅方分派；也是 `PublicAstarrayEvent` 的新增成员名）。 */
export const PERMISSION_ASK_EVENT_TYPE = "permission-ask" as const;

/**
 * 权限询问事件。
 *
 * **不含**：原始 `argumentsJson`、原始 `explanation`（只含脱敏限长版）、
 * 任何秘密或可复用执行令牌。
 */
export interface PermissionAskPublicEvent {
  eventType: typeof PERMISSION_ASK_EVENT_TYPE;
  /** 请求身份（多页面同步与裁决入口的锚点）。 */
  askIdentifier: string;
  /** 项目标识（复用调用方提供的权威值）。 */
  projectIdentifier: string;
  /** 会话标识。 */
  sessionIdentifier: string;
  /** **发起方具体个体**（不可复用身份，作为地址）。 */
  agentInstanceId: string;
  taskIdentifier: string;
  toolName: string;
  /** 工具含多种操作时**必须明确**；不可判定为 `unknown`（保守）。 */
  action: PermissionAskSafePreview["action"];
  /** 绑定**本地保存的完整规范化参数**。 */
  operationFingerprint: string;
  /** 请求状态（多页面同步 / 拒绝陈旧裁决的依据）。 */
  status: PermissionAskRequestStatus;
  /** **请求自身的 revision**（与状态迁移同步递增）。 */
  requestRevision: number;
  expiresAtIso: string;
  /** 本地生成的结构化安全预览（已脱敏、已限长）。 */
  preview: PermissionAskSafePreview;
  /** 事件自身的权威 revision（沿用信封语义）。 */
  revision: number;
  /** 幂等 ID：同一事件重复投递时用于去重。 */
  idempotencyId: string;
}

/**
 * 由**本地权威记录**构造公共事件。
 *
 * 关键性质：**无法从返回事件还原原始参数** —— 只保留
 * `operationFingerprint`（绑定用）与安全预览（理解用）。
 */
export function buildPermissionAskEvent(input: {
  record: PermissionAskRequestRecord;
  projectIdentifier: string;
  sessionIdentifier: string;
  projectRootPath: string;
  /** 可注入更强的敏感路径匹配器（例如 `SensitiveContentAccessPolicy`）。 */
  matchSensitivePathName?: (filePath: string) => string | null;
  /** 事件幂等 ID 生成器（缺省由记录内容派生，保证同一请求同一 revision 稳定）。 */
  idempotencyIdFactory?: (record: PermissionAskRequestRecord) => string;
}): PermissionAskPublicEvent {
  const record = input.record;
  const preview = buildPermissionAskSafePreview({
    toolName: record.toolName,
    argumentsJson: record.argumentsJson,
    explanation: record.explanation,
    projectRootPath: input.projectRootPath,
    ...(input.matchSensitivePathName === undefined
      ? {}
      : { matchSensitivePathName: input.matchSensitivePathName }),
  });
  return {
    eventType: PERMISSION_ASK_EVENT_TYPE,
    askIdentifier: record.askIdentifier,
    projectIdentifier: input.projectIdentifier,
    sessionIdentifier: input.sessionIdentifier,
    agentInstanceId: record.ownerAgentInstanceId,
    taskIdentifier: record.taskIdentifier,
    toolName: record.toolName,
    action: preview.action,
    operationFingerprint: record.operationFingerprint,
    status: record.status,
    requestRevision: record.requestRevision,
    expiresAtIso: record.expiresAtIso,
    preview,
    revision: record.requestRevision,
    idempotencyId:
      input.idempotencyIdFactory?.(record) ??
      "permission-ask:" +
        record.askIdentifier +
        ":" +
        String(record.requestRevision),
  };
}
