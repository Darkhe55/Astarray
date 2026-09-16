/**
 * AUTH-SCOPE-03：工具执行前的范围授权门禁与公共入口。
 *
 * - 所有经该门禁的工具调用先做**范围判定 + 裁决**，未获授权一律不执行（零副作用）；
 * - 拒绝（deny）与重放（同一授权的第二次使用）返回稳定错误码且不触达内层工具；
 * - 放权模式项目内操作默认无人工等待；协同模式项目内由本地上级批准并留回执；
 *   项目外/未知等待认证用户授权；安装类仍受独立开关约束。
 */
import type { ToolCallResult, ToolPort } from "../core/types.js";
import {
  computeOperationFingerprint,
  decideScopeAuthorization,
  resolveOperationScope,
  verifyScopeApprovalReceipt,
  type Adjudicator,
  type OperationDescriptor,
  type OperationKind,
  type RegisteredProjectRoot,
  type ScopeApprovalReceipt,
  type ScopeClass,
} from "./scope-resolution.js";

export interface ScopeGateDecisionRecord {
  receiptIdentifier: string;
  operationFingerprint: string;
  scopeClass: ScopeClass;
  decision: "allow" | "deny" | "ask-superior" | "ask-user";
  adjudicator: Adjudicator;
  decidedAtIso: string;
  authorizationRevision: number;
  approvedByAgentInstanceId: string | null;
  approvedByUserId: string | null;
  consumedAtIso: string | null;
  expiresAtIso: string | null;
}

export interface ScopeGateOutcome {
  isAllowed: boolean;
  errorCode: string | null;
  reasons: string[];
  resolution: {
    scopeClass: ScopeClass;
    projectIdentifier: string | null;
    resolvedTargetPath: string | null;
  };
  record: ScopeGateDecisionRecord | null;
}

export interface ScopeGateSuperiorApprovalPort {
  approve(input: {
    scopeClass: ScopeClass;
    operationFingerprint: string;
    requestingAgentInstanceId: string | null;
  }): Promise<{ isApproved: boolean; approvedByAgentInstanceId: string | null }>;
}

export interface ScopeAuthorizationGateOptions {
  getMode: () => "ponder" | "assist" | "devolve";
  getRegisteredProjectRoots: () => RegisteredProjectRoot[];
  getConfiguredDecision: (operationKind: OperationKind) => "deny" | "ask" | "allow";
  isInstallationEnabled: () => boolean | Promise<boolean>;
  getAuthorizationRevision: () => number;
  superiorApprovalPort?: ScopeGateSuperiorApprovalPort;
  nowIso?: () => string;
  resolveRealPath?: (inputPath: string) => Promise<string | null>;
}

const MUTATING_OPERATION_KINDS: ReadonlySet<OperationKind> = new Set([
  "project-file-write",
  "dependency-install",
  "external-software-control",
  "process-execution",
  "remote-publish",
  "backup-deletion",
]);

const READ_ONLY_OPERATION_KINDS: ReadonlySet<OperationKind> = new Set([
  "project-file-read",
]);

export class ScopeAuthorizationGate {
  private readonly recordsByFingerprint = new Map<string, ScopeGateDecisionRecord>();

  constructor(private readonly options: ScopeAuthorizationGateOptions) {}

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  private async resolve(operation: OperationDescriptor) {
    return resolveOperationScope({
      operation,
      registeredProjectRoots: this.options.getRegisteredProjectRoots(),
      ...(this.options.resolveRealPath !== undefined
        ? { resolveRealPath: this.options.resolveRealPath }
        : {}),
    });
  }

  /** 认证用户授予精确操作授权（单次使用；重放不产生副作用）。 */
  grantUserAuthorization(input: {
    operation: OperationDescriptor;
    approvedByUserId: string;
    expiresAtIso?: string | null;
  }): Promise<{ receiptIdentifier: string; operationFingerprint: string }> {
    return (async () => {
      const resolution = await this.resolve(input.operation);
      const operationFingerprint = computeOperationFingerprint({
        operation: input.operation,
        resolution,
      });
      const record: ScopeGateDecisionRecord = {
        receiptIdentifier: "scope-grant-" + operationFingerprint.slice(7, 19),
        operationFingerprint,
        scopeClass: resolution.scopeClass,
        decision: "allow",
        adjudicator: "authenticated-user",
        decidedAtIso: this.nowIso(),
        authorizationRevision: this.options.getAuthorizationRevision(),
        approvedByAgentInstanceId: null,
        approvedByUserId: input.approvedByUserId,
        consumedAtIso: null,
        expiresAtIso: input.expiresAtIso ?? null,
      };
      this.recordsByFingerprint.set(operationFingerprint, record);
      return { receiptIdentifier: record.receiptIdentifier, operationFingerprint };
    })();
  }

  listDecisionRecords(): ScopeGateDecisionRecord[] {
    return [...this.recordsByFingerprint.values()].map((record) => ({ ...record }));
  }

  /** 只读预演：解析范围并给出裁决，不消费授权、不写记录（供设置/公共入口展示）。 */
  async previewDecision(operation: OperationDescriptor): Promise<{
    scopeClass: ScopeClass;
    projectIdentifier: string | null;
    resolvedTargetPath: string | null;
    decision: "allow" | "deny" | "ask-superior" | "ask-user";
    adjudicator: Adjudicator;
    reasons: string[];
    operationFingerprint: string;
  }> {
    const resolution = await this.resolve(operation);
    const decision = decideScopeAuthorization({
      scopeClass: resolution.scopeClass,
      mode: this.options.getMode(),
      configuredDecision: this.options.getConfiguredDecision(operation.operationKind),
      isInstallationEnabled: await this.options.isInstallationEnabled(),
      isReadOnlyOperation:
        READ_ONLY_OPERATION_KINDS.has(operation.operationKind) ||
        !MUTATING_OPERATION_KINDS.has(operation.operationKind),
    });
    return {
      scopeClass: resolution.scopeClass,
      projectIdentifier: resolution.projectIdentifier,
      resolvedTargetPath: resolution.resolvedTargetPath,
      decision: decision.decision,
      adjudicator: decision.adjudicator,
      reasons: [...decision.reasons, ...resolution.reasons],
      operationFingerprint: computeOperationFingerprint({ operation, resolution }),
    };
  }

  /** 对一次工具执行做范围判定与裁决；未获授权时不执行（调用方据此短路）。 */
  async authorizeForExecution(operation: OperationDescriptor): Promise<ScopeGateOutcome> {
    const resolution = await this.resolve(operation);
    const nowIso = this.nowIso();
    const operationFingerprint = computeOperationFingerprint({ operation, resolution });
    const existingRecord = this.recordsByFingerprint.get(operationFingerprint);

    const isExistingGrantExpired =
      existingRecord !== undefined &&
      existingRecord.expiresAtIso !== null &&
      Date.parse(nowIso) > Date.parse(existingRecord.expiresAtIso);
    if (isExistingGrantExpired) {
      return {
        isAllowed: false,
        errorCode: "auth-scope-authorization-expired",
        reasons: ["已授予的授权已过期：需重新授权"],
        resolution: {
          scopeClass: resolution.scopeClass,
          projectIdentifier: resolution.projectIdentifier,
          resolvedTargetPath: resolution.resolvedTargetPath,
        },
        record: existingRecord === undefined ? null : { ...existingRecord },
      };
    }
    if (
      existingRecord !== undefined &&
      existingRecord.consumedAtIso === null &&
      existingRecord.decision === "allow" &&
      existingRecord.authorizationRevision === this.options.getAuthorizationRevision()
    ) {
      // 单次使用：消费后同一指纹再次执行视为重放。
      existingRecord.consumedAtIso = nowIso;
      return {
        isAllowed: true,
        errorCode: null,
        reasons: ["使用已授予的单次授权（消费后同一操作重放将被拒绝）"],
        resolution: {
          scopeClass: resolution.scopeClass,
          projectIdentifier: resolution.projectIdentifier,
          resolvedTargetPath: resolution.resolvedTargetPath,
        },
        record: { ...existingRecord },
      };
    }
    if (existingRecord !== undefined && existingRecord.consumedAtIso !== null) {
      return {
        isAllowed: false,
        errorCode: "auth-scope-replay-rejected",
        reasons: ["该授权已被消费：重放不产生副作用，需重新授权"],
        resolution: {
          scopeClass: resolution.scopeClass,
          projectIdentifier: resolution.projectIdentifier,
          resolvedTargetPath: resolution.resolvedTargetPath,
        },
        record: { ...existingRecord },
      };
    }

    const decision = decideScopeAuthorization({
      scopeClass: resolution.scopeClass,
      mode: this.options.getMode(),
      configuredDecision: this.options.getConfiguredDecision(operation.operationKind),
      isInstallationEnabled: await this.options.isInstallationEnabled(),
      isReadOnlyOperation:
        READ_ONLY_OPERATION_KINDS.has(operation.operationKind) ||
        !MUTATING_OPERATION_KINDS.has(operation.operationKind),
    });

    if (decision.decision === "deny") {
      return {
        isAllowed: false,
        errorCode: "auth-scope-denied",
        reasons: decision.reasons,
        resolution: {
          scopeClass: resolution.scopeClass,
          projectIdentifier: resolution.projectIdentifier,
          resolvedTargetPath: resolution.resolvedTargetPath,
        },
        record: null,
      };
    }

    if (decision.decision === "ask-user") {
      return {
        isAllowed: false,
        errorCode: "auth-scope-awaiting-user-authorization",
        reasons: [
          ...decision.reasons,
          "需要认证用户对精确操作授权（grantUserAuthorization）",
        ],
        resolution: {
          scopeClass: resolution.scopeClass,
          projectIdentifier: resolution.projectIdentifier,
          resolvedTargetPath: resolution.resolvedTargetPath,
        },
        record: null,
      };
    }

    if (decision.decision === "ask-superior") {
      const approvalPort = this.options.superiorApprovalPort;
      const approval =
        approvalPort === undefined
          ? { isApproved: false, approvedByAgentInstanceId: null }
          : await approvalPort.approve({
              scopeClass: resolution.scopeClass,
              operationFingerprint,
              requestingAgentInstanceId: null,
            });
      if (!approval.isApproved) {
        return {
          isAllowed: false,
          errorCode: "auth-scope-awaiting-superior-approval",
          reasons: [...decision.reasons, "上级未批准或不可用：不执行"],
          resolution: {
            scopeClass: resolution.scopeClass,
            projectIdentifier: resolution.projectIdentifier,
            resolvedTargetPath: resolution.resolvedTargetPath,
          },
          record: null,
        };
      }
      const record: ScopeGateDecisionRecord = {
        receiptIdentifier: "scope-superior-" + operationFingerprint.slice(7, 19),
        operationFingerprint,
        scopeClass: resolution.scopeClass,
        decision: "allow",
        adjudicator: "superior-agent",
        decidedAtIso: nowIso,
        authorizationRevision: this.options.getAuthorizationRevision(),
        approvedByAgentInstanceId: approval.approvedByAgentInstanceId,
        approvedByUserId: null,
        consumedAtIso: nowIso,
        expiresAtIso: null,
      };
      this.recordsByFingerprint.set(operationFingerprint, record);
      return {
        isAllowed: true,
        errorCode: null,
        reasons: ["上级批准（留批准回执）后执行"],
        resolution: {
          scopeClass: resolution.scopeClass,
          projectIdentifier: resolution.projectIdentifier,
          resolvedTargetPath: resolution.resolvedTargetPath,
        },
        record: { ...record },
      };
    }

    // allow：放权/思索只读等无需等待。
    const record: ScopeGateDecisionRecord = {
      receiptIdentifier: "scope-allow-" + operationFingerprint.slice(7, 19),
      operationFingerprint,
      scopeClass: resolution.scopeClass,
      decision: "allow",
      adjudicator: decision.adjudicator,
      decidedAtIso: nowIso,
      authorizationRevision: this.options.getAuthorizationRevision(),
      approvedByAgentInstanceId: null,
      approvedByUserId: null,
      consumedAtIso: nowIso,
      expiresAtIso: null,
    };
    this.recordsByFingerprint.set(operationFingerprint, record);
    return {
      isAllowed: true,
      errorCode: null,
      reasons: decision.reasons,
      resolution: {
        scopeClass: resolution.scopeClass,
        projectIdentifier: resolution.projectIdentifier,
        resolvedTargetPath: resolution.resolvedTargetPath,
      },
      record: { ...record },
    };
  }

  /** 执行前复检：结合既有回执与当前 revision 判断是否仍可执行。 */
  async recheckReceipt(input: {
    operation: OperationDescriptor;
    receipt: ScopeApprovalReceipt;
  }): Promise<{ isValid: boolean; reason: string }> {
    const resolution = await this.resolve(input.operation);
    const verification = verifyScopeApprovalReceipt({
      receipt: input.receipt,
      operation: input.operation,
      resolution,
      currentAuthorizationRevision: this.options.getAuthorizationRevision(),
      nowIso: this.nowIso(),
    });
    return verification.isValid
      ? { isValid: true, reason: "valid" }
      : { isValid: false, reason: verification.reason };
  }
}

/** 依据工具名与参数判定操作描述；返回 null 表示该工具不受范围门禁约束。 */
export function describeToolOperation(
  toolName: string,
  argumentsJson: string,
): OperationDescriptor | null {
  let parsedArguments: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      parsedArguments = parsed as Record<string, unknown>;
    }
  } catch {
    // 参数不可解析：按未知范围处理（保守）。
    return { operationKind: "unknown", targetPath: null };
  }
  const readTargetPath = (): string | null => {
    for (const key of ["path", "filePath", "targetPath", "directoryPath"]) {
      const value = parsedArguments[key];
      if (typeof value === "string" && value !== "") {
        return value;
      }
    }
    return null;
  };

  switch (toolName) {
    case "createProjectFile":
    case "replaceFileContent":
    case "writeFileTemporary":
      return { operationKind: "project-file-write", targetPath: readTargetPath() };
    case "readFile":
    case "listDirectory":
    case "searchProjectText":
    case "gitReadonlyView":
      return { operationKind: "project-file-read", targetPath: readTargetPath() };
    case "backupVault":
    case "deleteBackup":
      return { operationKind: "backup-deletion" };
    default:
      return null;
  }
}

/** 把范围门禁包在真实工具端口外：未获授权时不触达内层工具。 */
export class ScopeGatedToolPort implements ToolPort {
  constructor(
    private readonly innerToolPort: ToolPort,
    private readonly gate: ScopeAuthorizationGate,
    private readonly describeOperation: (
      toolName: string,
      argumentsJson: string,
    ) => OperationDescriptor | null = describeToolOperation,
  ) {}

  async execute(
    toolName: string,
    argumentsJson: string,
    callId: string,
    cancellationSignal: AbortSignal,
  ): Promise<ToolCallResult> {
    const operation = this.describeOperation(toolName, argumentsJson);
    if (operation === null) {
      return this.innerToolPort.execute(toolName, argumentsJson, callId, cancellationSignal);
    }
    const outcome = await this.gate.authorizeForExecution(operation);
    if (!outcome.isAllowed) {
      return {
        kind: "error",
        callId,
        errorCode: outcome.errorCode ?? "auth-scope-denied",
        errorMessage: outcome.reasons.join("；") || "范围授权未通过",
        isIdempotencyConfirmed: true,
      };
    }
    return this.innerToolPort.execute(toolName, argumentsJson, callId, cancellationSignal);
  }
}
