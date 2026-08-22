/**
 * 四级权限求交与 Git 子分支边界守卫（T08C-06 / ADR-0025 §5）。
 *
 * - 四级权限/工具/资源范围/期限是三级有效权限的严格子集（复用三级求交规则）；
 * - 四级不能访问兄弟或上级长期记忆、不能操作远端项目；
 * - 四级 Git 提交只进入所属三级任务分支；三级可在本地门禁验证后把直属
 *   四级贡献合入自己的三级任务分支，但不得向上合入 mission 集成分支、
 *   用户目标分支或远端；最终向上集成只属于次级 Agent。
 */
import { DomainError } from "../core/errors.js";
import { TertiaryPermissionDelegationGuard } from "../tools/session-permission-elevation.js";
import type { PermissionDecision } from "../tools/permission-capability-catalog.js";

export interface QuaternaryPermissionIntersectionGuardOptions {
  /** 三级 Agent 当前有效权限（四级上限来源）。 */
  tertiaryEffectiveDecision: PermissionDecision;
  tertiaryAllowedResourceScopes: string[];
  tertiaryExpiresAtIso: string;
}

/**
 * 四级权限守卫：求交计算四级实际获得权限，均不得超过三级当前有效权限。
 */
export class QuaternaryPermissionIntersectionGuard {
  private readonly tertiaryGuard = new TertiaryPermissionDelegationGuard();
  private readonly options: QuaternaryPermissionIntersectionGuardOptions;

  constructor(options: QuaternaryPermissionIntersectionGuardOptions) {
    this.options = options;
  }

  /** 四级决定 = 三级有效决定 ⊓ 请求（不得宽于三级）。 */
  computeQuaternaryDecision(
    requestedDecision: PermissionDecision,
  ): PermissionDecision {
    return this.tertiaryGuard.computeDelegatedDecision({
      secondaryEffectiveDecision: this.options.tertiaryEffectiveDecision,
      requestedDelegatedDecision: requestedDecision,
    });
  }

  /** 四级资源范围 ⊆ 三级允许范围。 */
  computeQuaternaryResourceScopes(
    requestedResourceScopes: string[],
  ): string[] {
    return this.tertiaryGuard.computeDelegatedResourceScope({
      secondaryAllowedResourceScopes: this.options.tertiaryAllowedResourceScopes,
      requestedResourceScopes,
    });
  }

  /** 四级期限不得晚于三级有效期限。 */
  computeQuaternaryExpiry(requestedExpiresAtIso: string): string {
    return this.tertiaryGuard.computeDelegatedExpiry({
      secondaryExpiresAtIso: this.options.tertiaryExpiresAtIso,
      requestedExpiresAtIso,
    });
  }

  /** 校验分发决定在三级上限内（超出拒绝分发）。 */
  assertQuaternaryDelegationAllowed(
    requestedDecision: PermissionDecision,
  ): void {
    this.tertiaryGuard.assertDelegationAllowed({
      secondaryEffectiveDecision: this.options.tertiaryEffectiveDecision,
      requestedDelegatedDecision: requestedDecision,
    });
  }
}

/** Git 分支类型（四级/三级写入边界）。 */
export type GitBranchKind =
  | "quaternary-isolation-branch"
  | "tertiary-task-branch"
  | "mission-integration-branch"
  | "user-goal-branch"
  | "remote";

export interface QuaternaryGitBranchPolicyOptions {
  /** 允许四级写入的分支类型（默认仅四级隔离分支）。 */
  allowedQuaternaryTargetKinds?: GitBranchKind[];
  /** 允许三级写入的分支类型（默认仅三级任务分支）。 */
  allowedTertiaryTargetKinds?: GitBranchKind[];
}

/**
 * Git 子分支集成策略：
 * - 四级提交只进入所属三级任务分支（四级隔离分支）或三级任务分支；
 * - 三级只能合入自己的三级任务分支；不能写入 mission 集成/目标/远端；
 * - 无第五级；最终向上集成只属于次级（本策略不授予次级之外的任何层级）。
 */
export class QuaternaryGitBranchPolicy {
  private readonly allowedQuaternaryTargetKinds: Set<GitBranchKind>;
  private readonly allowedTertiaryTargetKinds: Set<GitBranchKind>;

  constructor(options: QuaternaryGitBranchPolicyOptions = {}) {
    this.allowedQuaternaryTargetKinds = new Set(
      options.allowedQuaternaryTargetKinds ?? ["quaternary-isolation-branch"],
    );
    this.allowedTertiaryTargetKinds = new Set(
      options.allowedTertiaryTargetKinds ?? ["tertiary-task-branch"],
    );
  }

  /** 校验四级 Git 写入目标（只允许隔离分支；禁止远端/集成/目标分支）。 */
  assertQuaternaryCommitTarget(input: {
    agentRole: "quaternary";
    targetBranchKind: GitBranchKind;
  }): void {
    if (!this.allowedQuaternaryTargetKinds.has(input.targetBranchKind)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `四级 Agent 只能提交到隔离分支，拒绝目标: ${input.targetBranchKind}`,
      );
    }
  }

  /** 校验三级合并目标（四级贡献可合入自己的三级任务分支；禁止向上合并）。 */
  assertTertiaryMergeTarget(input: {
    targetBranchKind: GitBranchKind;
  }): void {
    if (!this.allowedTertiaryTargetKinds.has(input.targetBranchKind)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `三级 Agent 不能向 ${input.targetBranchKind} 合并（最终向上集成只属于次级）`,
      );
    }
  }
}