/**
 * 稳定领域错误（T00 契约）。
 * 所有 Provider/进程/IO 异常在进入领域层前必须转为 DomainError，
 * 使用稳定 errorCode，禁止把底层错误原文直接暴露给用户。
 */

export type DomainErrorCode =
  | "invalid-task-chain"
  | "dag-cycle"
  | "dependency-not-found"
  | "concurrency-limit-exceeded"
  | "invalid-mode-transition"
  | "tool-not-found"
  | "tool-permission-denied"
  | "permission-ask-pending"
  | "permission-profile-not-found"
  | "backup-deletion-authorization-pending"
  | "backup-deletion-authorization-invalid"
  | "feedback-protocol-mismatch"
  | "feedback-process-unavailable"
  | "provider-timeout"
  | "provider-cancelled"
  | "provider-protocol-error"
  | "mission-not-found"
  | "mission-locked"
  | "stale-revision"
  | "journal-corrupted"
  | "operation-not-idempotent"
  | "tool-execution-failed"
  | "path-escape-attempt"
  | "task-sequence-not-found"
  | "task-priority-denied"
  | "task-bundle-invalid"
  | "task-sequence-permission-denied"
  | "sensitive-content-read-denied"
  | "resource-already-read"
  | "livelock-guard-triggered"
  | "stale-human-change"
  | "context-graph-not-found"
  | "context-graph-invalid"
  | "context-node-not-closable"
  | "global-decision-not-found"
  | "global-decision-invalid"
  | "human-verification-policy-invalid"
  | "context-recall-invalid"
  | "context-mandatory-constraint-missing"
  | "preservation-point-not-restorable"
  | "preservation-object-missing"
  | "restore-target-not-empty"
  | "restore-target-invalid"
  | "unknown";

export class DomainError extends Error {
  readonly errorCode: DomainErrorCode;
  /** 是否可在消除根因后安全重试。非幂等不确定一律 false。 */
  readonly isRecoverable: boolean;

  constructor(
    errorCode: DomainErrorCode,
    message: string,
    isRecoverable: boolean = false,
  ) {
    super(message);
    this.name = "DomainError";
    this.errorCode = errorCode;
    this.isRecoverable = isRecoverable;
  }
}

/**
 * 「确定未进入副作用通道」的工具错误（2026-10-02 授权结算语义）。
 *
 * 工具只有在能够**证明**本次调用没有产生任何副作用时才抛出本错误
 * （例如排他创建因目标已存在而在写入前被拒、参数非法、路径/范围校验失败）；
 * 执行中失败、写入后失败或结果未知**一律不得**使用本错误——那类失败必须按
 * "结果未知"进入对账。该分类是工具实现方的本地确定性事实，不得由模型或上层推断。
 */
export class SideEffectNoneError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SideEffectNoneError";
  }
}
