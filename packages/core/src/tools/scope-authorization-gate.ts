/**
 * AUTH-SCOPE-03：工具执行前的范围授权门禁与公共入口。
 *
 * - 所有经该门禁的工具调用先做**范围判定 + 裁决**，未获授权一律不执行（零副作用）；
 * - 拒绝（deny）与重放（同一授权的第二次使用）返回稳定错误码且不触达内层工具；
 * - 放权模式项目内操作默认无人工等待；协同模式项目内由本地上级批准并留回执；
 *   项目外/未知等待认证用户授权；安装类仍受独立开关约束。
 */
import { createHash } from "node:crypto";

import type { ToolCallResult, ToolPort } from "../core/types.js";
import { DomainError } from "../core/errors.js";
import { canonicalizeToolArguments } from "../core/permission-policy.js";
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

/** 逻辑操作预留（执行前建立、执行后结算）。 */
export interface ExecutionReservation {
  reservationIdentifier: string;
  logicalOperationFingerprint: string;
  reservedAtIso: string;
  /** null = 尚未结算（在途）。 */
  settlement: "settled" | "requires-reconciliation" | null;
  settledAtIso?: string;
  sideEffectStatus?: "none" | "partial" | "unknown";
  /**
   * 建立预留时从授权表取走的授权快照。仅当结算为"明确未执行、无副作用"时**恢复**，
   * 使重试不必再次要求用户裁决；其余结算情形不恢复（防重放）。
   */
  armedAuthorization?: {
    approvedByUserId: string | null;
    authorizationRevision: number;
    grantedAtIso: string;
  };
}

export type ExecutionReservationStatus =
  | "reserved"
  | "reserved-in-flight"
  | "replay-rejected"
  | "requires-reconciliation"
  | "awaiting-user-authorization";

export interface ExecutionReservationOutcome {
  status: ExecutionReservationStatus;
  reservationIdentifier?: string;
  logicalOperationFingerprint: string;
  errorCode?: string;
  reasons?: string[];
}

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
  /**
   * 用于判定"预留"与"授权"是否落在**同一个 gate 实例**上。
   */
  private readonly recordsByFingerprint = new Map<string, ScopeGateDecisionRecord>();
  /**
   * 逻辑操作预留表（键 = 规范化完整参数指纹，2026-10-02 用户指定语义）：
   * **执行前原子预留、执行后结算**；仅"明确未执行、无副作用"的失败可释放，
   * 执行中失败/结果未知一律进入对账，禁止自动释放或静默重放。
   */
  private readonly reservationsByLogicalOperation = new Map<string, ExecutionReservation>();
  /**
   * 逻辑操作授权表（键 = 逻辑操作指纹；2026-10-02 用户指定语义）：
   * 授权绑定**完整规范化参数**，不是只绑定范围指纹——同路径内容变化必须重新裁决。
   * 预留建立时同步消费，保证"执行前原子预留"。
   */
  private readonly authorizationsByLogicalOperation = new Map<
    string,
    { approvedByUserId: string | null; authorizationRevision: number; grantedAtIso: string }
  >();

  constructor(private readonly options: ScopeAuthorizationGateOptions) {}

  /**
   * 逻辑操作指纹：**完整规范化参数 + 操作种类 + 目标路径**。
   * 授权只绑定作用域指纹（kind/scope/project/targetPath）是不够的——
   * 同一路径的内容变化也必须重新裁决。
   */
  private computeLogicalOperationFingerprint(input: {
    operation: OperationDescriptor;
    argumentsJson: string;
  }): string {
    return (
      "logical:" +
      createHash("sha256")
        .update(
          [
            input.operation.operationKind,
            input.operation.targetPath ?? "-",
            canonicalizeToolArguments(input.argumentsJson),
          ].join("|"),
          "utf8",
        )
        .digest("hex")
    );
  }

  /**
   * 执行前**原子预留**：命中未结算的授权 → 建立预留（同一时刻只允许一个持有者）；
   * 已预留未结算 → `reserved-in-flight`；已结算成功 → `replay-rejected`；
   * 结果未知待对账 → `requires-reconciliation`；无可用授权 → 走范围裁决。
   */
  async reserveForExecution(input: {
    operation: OperationDescriptor;
    argumentsJson: string;
  }): Promise<ExecutionReservationOutcome> {
    const logicalFingerprint = this.computeLogicalOperationFingerprint(input);
    // 以下判定与预留建立**在同一同步段内完成**（无 await）：并发调用只有一个能建立预留。
    const existingReservation = this.reservationsByLogicalOperation.get(logicalFingerprint);
    if (existingReservation !== undefined) {
      if (existingReservation.settlement === null) {
        return {
          status: "reserved-in-flight",
          reservationIdentifier: existingReservation.reservationIdentifier,
          logicalOperationFingerprint: logicalFingerprint,
          errorCode: "operation-already-in-flight",
        };
      }
      if (existingReservation.settlement === "requires-reconciliation") {
        return {
          status: "requires-reconciliation",
          reservationIdentifier: existingReservation.reservationIdentifier,
          logicalOperationFingerprint: logicalFingerprint,
          errorCode: "operation-settlement-unknown",
        };
      }
      return {
        status: "replay-rejected",
        reservationIdentifier: existingReservation.reservationIdentifier,
        logicalOperationFingerprint: logicalFingerprint,
        errorCode: "auth-scope-replay-rejected",
      };
    }

    const existingAuthorization = this.authorizationsByLogicalOperation.get(logicalFingerprint);
    if (
      existingAuthorization !== undefined &&
      existingAuthorization.authorizationRevision === this.options.getAuthorizationRevision()
    ) {
      this.authorizationsByLogicalOperation.delete(logicalFingerprint);
      return this.createReservation(logicalFingerprint, existingAuthorization);
    }
    if (existingAuthorization !== undefined) {
      // revision 变化使旧授权失效（fail-closed）。
      this.authorizationsByLogicalOperation.delete(logicalFingerprint);
    }

    // 无逻辑操作授权：先做**只读预演**（不消费任何记录）决定是否需要用户裁决。
    const preview = await this.previewDecision(input.operation);
    if (preview.decision === "deny") {
      return {
        status: "awaiting-user-authorization",
        logicalOperationFingerprint: logicalFingerprint,
        errorCode: "auth-scope-denied",
        reasons: preview.reasons,
      };
    }
    if (preview.decision === "ask-user") {
      return {
        status: "awaiting-user-authorization",
        logicalOperationFingerprint: logicalFingerprint,
        errorCode: "auth-scope-awaiting-user-authorization",
        reasons: preview.reasons,
      };
    }
    // `allow` 与 `ask-superior`（协同模式项目内默认由本地上级批准）：走一次正式授权，
    // 保留回执与审计；随后**同步**建立预留，并把授权快照挂到预留上（明确无副作用的
    // 失败可据此恢复授权重试，成功后不恢复）。
    const authorization = await this.authorizeForExecution(input.operation);
    if (!authorization.isAllowed) {
      return {
        status: "awaiting-user-authorization",
        logicalOperationFingerprint: logicalFingerprint,
        errorCode: authorization.errorCode ?? "auth-scope-denied",
        reasons: authorization.reasons,
      };
    }
    return this.createReservation(logicalFingerprint);
  }

  /** 建立预留（同步段内调用；调用点前不得有 await）。 */
  private createReservation(
    logicalFingerprint: string,
    armedAuthorization?: {
      approvedByUserId: string | null;
      authorizationRevision: number;
      grantedAtIso: string;
    },
  ): ExecutionReservationOutcome {
    const reservation: ExecutionReservation = {
      reservationIdentifier: "scope-reservation-" + logicalFingerprint.slice(8, 24),
      logicalOperationFingerprint: logicalFingerprint,
      reservedAtIso: this.nowIso(),
      settlement: null,
      ...(armedAuthorization === undefined ? {} : { armedAuthorization }),
    };
    this.reservationsByLogicalOperation.set(logicalFingerprint, reservation);
    return {
      status: "reserved",
      reservationIdentifier: reservation.reservationIdentifier,
      logicalOperationFingerprint: logicalFingerprint,
    };
  }

  /**
   * 登记逻辑操作授权（用户裁决 / 入口授权调用）。
   * 与 `grantUserAuthorization` 并行存在：后者只覆盖范围指纹，前者绑定完整规范化参数。
   */
  async grantLogicalOperationAuthorization(input: {
    operation: OperationDescriptor;
    argumentsJson: string;
    approvedByUserId: string | null;
  }): Promise<{ logicalOperationFingerprint: string }> {
    const logicalFingerprint = this.computeLogicalOperationFingerprint({
      operation: input.operation,
      argumentsJson: input.argumentsJson,
    });
    // 用户对同一逻辑操作**重新授权**：清除既有结算状态，使新授权的首次执行不被
    // 旧的重放守卫挡住；在途预留不得清除（防止并发期间被重新打开）。
    const existingReservation = this.reservationsByLogicalOperation.get(logicalFingerprint);
    if (existingReservation !== undefined && existingReservation.settlement !== null) {
      this.reservationsByLogicalOperation.delete(logicalFingerprint);
    }
    this.authorizationsByLogicalOperation.set(logicalFingerprint, {
      approvedByUserId: input.approvedByUserId,
      authorizationRevision: this.options.getAuthorizationRevision(),
      grantedAtIso: this.nowIso(),
    });
    return { logicalOperationFingerprint: logicalFingerprint };
  }

  /**
   * 执行后**结算**：
   * - 成功 → `settled`（此后同一逻辑操作 = 重放，仍拒绝）；
   * - 失败且**工具自报确定未执行/无副作用**（`sideEffectStatus: "none"`）→ `released`（可重试，不再要授权）；
   * - 其余失败（部分副作用/未知）→ `requires-reconciliation`（禁止自动释放）。
   */
  async settleReservation(input: {
    reservationIdentifier: string;
    outcome: {
      kind: "success" | "error";
      isIdempotencyConfirmed?: boolean;
      sideEffectStatus?: "none" | "partial" | "unknown";
    };
  }): Promise<{ status: "settled" | "released" | "requires-reconciliation"; logicalOperationFingerprint: string }> {
    const entry = [...this.reservationsByLogicalOperation.entries()].find(
      ([, reservation]) => reservation.reservationIdentifier === input.reservationIdentifier,
    );
    if (entry === undefined) {
      throw new DomainError(
        "invalid-task-chain",
        `预留不存在: ${input.reservationIdentifier}`,
      );
    }
    const [logicalFingerprint, reservation] = entry;
    if (reservation.settlement !== null) {
      // 重复结算不改变结论（幂等）。
      return { status: reservation.settlement, logicalOperationFingerprint: logicalFingerprint };
    }
    if (input.outcome.kind === "success") {
      reservation.settlement = "settled";
      reservation.settledAtIso = this.nowIso();
      reservation.sideEffectStatus = "partial";
      return { status: "settled", logicalOperationFingerprint: logicalFingerprint };
    }
    const sideEffectStatus = input.outcome.sideEffectStatus ?? "unknown";
    if (sideEffectStatus === "none") {
      // 确定未执行、无副作用：释放预留，并**恢复**原授权（重试不必再次要求裁决）。
      this.reservationsByLogicalOperation.delete(logicalFingerprint);
      if (reservation.armedAuthorization !== undefined) {
        this.authorizationsByLogicalOperation.set(
          logicalFingerprint,
          reservation.armedAuthorization,
        );
      }
      return { status: "released", logicalOperationFingerprint: logicalFingerprint };
    }
    reservation.settlement = "requires-reconciliation";
    reservation.settledAtIso = this.nowIso();
    reservation.sideEffectStatus = sideEffectStatus;
    return { status: "requires-reconciliation", logicalOperationFingerprint: logicalFingerprint };
  }

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

  /**
   * 认证用户授予精确操作授权（单次使用；重放不产生副作用）。
   *
   * 兼容入口：给出 `argumentsJson` 时**同时**登记逻辑操作授权（绑定完整规范化参数），
   * 使 `reserveForExecution` 能直接命中；未给出参数时只登记范围指纹级记录（旧行为）。
   */
  grantUserAuthorization(input: {
    operation: OperationDescriptor;
    approvedByUserId: string;
    expiresAtIso?: string | null;
    /** 完整规范化参数（推荐给出；绑定逻辑操作 ID，避免同路径内容变化被沿用）。 */
    argumentsJson?: string;
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
      if (input.argumentsJson !== undefined) {
        await this.grantLogicalOperationAuthorization({
          operation: input.operation,
          argumentsJson: input.argumentsJson,
          approvedByUserId: input.approvedByUserId,
        });
      }
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
      operationKind: operation.operationKind,
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
      operationKind: operation.operationKind,
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
    // 本地只读、无目标路径且不触达项目文件范围：显式白名单（不受范围门禁约束）。
    case "factVerification":
    case "taskSequenceStatus":
      return null;
    default:
      // GOV-02c：未显式映射的工具不进入范围门禁；未注册/禁用工具会由注册表层
      // fail-closed 拒绝（tool-not-found），不会因此放行。
      // 新增安装/外部软件/进程执行类工具必须显式映射，并提供本地范围证据。
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
    /**
     * 只读操作**不建立预留**（2026-10-02 真实实测缺陷修复）。
     *
     * 预留/重放保护的目的是防止**重复副作用**；只读操作没有副作用，
     * 而预留表键是"逻辑操作指纹"（操作种类 + 目标路径 + 规范化参数），**不含 Agent 身份**，
     * 因此此前同一会话中不同任务以相同参数读取同一文件时，第二条会被误判为
     * `auth-scope-replay-rejected` 并拒绝执行（真实 u2-flash 实测：并发第二条任务必然失败）。
     *
     * 只读操作仍需经过 `authorizeForExecution` 的范围裁决（见调用方），
     * 此处只是不再占用"单次授权/重放保护"语义。
     */
    if (READ_ONLY_OPERATION_KINDS.has(operation.operationKind)) {
      return this.innerToolPort.execute(toolName, argumentsJson, callId, cancellationSignal);
    }
    // 执行前**原子预留**（未获授权绝不触达内层工具）。
    const reservation = await this.gate.reserveForExecution({ operation, argumentsJson });
    if (reservation.status !== "reserved") {
      const errorCodeByStatus: Record<string, string> = {
        "reserved-in-flight": "operation-already-in-flight",
        "replay-rejected": "auth-scope-replay-rejected",
        "requires-reconciliation": "operation-settlement-unknown",
        "awaiting-user-authorization": "auth-scope-awaiting-user-authorization",
      };
      return {
        kind: "error",
        callId,
        errorCode: reservation.errorCode ?? errorCodeByStatus[reservation.status] ?? "auth-scope-denied",
        errorMessage:
          (reservation.reasons ?? []).join("；") ||
          `范围授权未通过（${reservation.status}）`,
        // 预留未建立 → 内层工具未被调用 → 确定无副作用（可重试）。
        isIdempotencyConfirmed: true,
        sideEffectStatus: reservation.status === "replay-rejected" ? "partial" : "none",
      };
    }

    const reservationIdentifier = reservation.reservationIdentifier ?? "";
    let innerResult: ToolCallResult;
    try {
      innerResult = await this.innerToolPort.execute(
        toolName,
        argumentsJson,
        callId,
        cancellationSignal,
      );
    } catch (error) {
      /**
       * 执行中异常（崩溃/断连）→ **结果未知**（RELIABILITY-01-02 · R5 故障注入）：
       * 必须先按 `unknown` 结算预留再向上抛，否则预留永久停在"在途"，
       * 同一逻辑操作此后全部被 `operation-already-in-flight` 拒绝且无对账路径。
       * 结算失败不得吞掉原始异常。
       */
      try {
        await this.gate.settleReservation({
          reservationIdentifier,
          outcome: { kind: "error", isIdempotencyConfirmed: false, sideEffectStatus: "unknown" },
        });
      } catch {
        // 预留已不存在等情况：保持原始异常语义。
      }
      throw error;
    }
    // 执行后**结算**：成功 → settled（此后同逻辑操作=重放）；
    // 失败且工具自报"确定无副作用" → released（可重试）；否则 → requires-reconciliation。
    await this.gate.settleReservation({
      reservationIdentifier,
      outcome:
        innerResult.kind === "success"
          ? { kind: "success" }
          : {
              kind: "error",
              isIdempotencyConfirmed: innerResult.isIdempotencyConfirmed,
              ...(innerResult.sideEffectStatus === undefined
                ? {}
                : { sideEffectStatus: innerResult.sideEffectStatus }),
            },
    });
    return innerResult;
  }
}
