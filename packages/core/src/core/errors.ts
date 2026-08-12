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
  | "backup-deletion-authorization-pending"
  | "backup-deletion-authorization-invalid"
  | "feedback-protocol-mismatch"
  | "feedback-process-unavailable"
  | "provider-timeout"
  | "provider-cancelled"
  | "mission-not-found"
  | "mission-locked"
  | "stale-revision"
  | "journal-corrupted"
  | "operation-not-idempotent"
  | "tool-execution-failed"
  | "path-escape-attempt"
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
