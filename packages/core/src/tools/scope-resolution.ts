/**
 * AUTH-SCOPE-02：本地作用范围判定、裁决者矩阵、批准回执与执行前复检。
 *
 * 硬规则（见 docs/adr/0039-auth-scope-and-adjudication-matrix.md）：
 * - 范围判定只用**已登记项目根**与真实路径解析（realpath/链接），**绝不使用 cwd、路径字符串前缀或命令自述**；
 * - 无法证明受控 → S4（未知），交由人工/上级裁决；
 * - deny 一律优先；安装类必须有独立开关；专用流程（远端发布/备份删除）不被本模块放宽；
 * - 批准回执绑定操作指纹、范围、权限 revision 与有效期；执行前必须复检。
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const OPERATION_KINDS = [
  "project-file-write",
  "project-file-read",
  "project-build-tool",
  "dependency-install",
  "external-software-control",
  "process-execution",
  "remote-publish",
  "backup-deletion",
  "unknown",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const SCOPE_CLASSES = [
  "S1-project-internal",
  "S2-cross-project-root",
  "S3-project-external",
  "S4-unknown",
  "S5-installation",
  "S6-external-software",
  "S7-special-flow",
] as const;
export type ScopeClass = (typeof SCOPE_CLASSES)[number];

export interface OperationDescriptor {
  operationKind: OperationKind;
  targetPath?: string | null;
  /** 自述范围说明：只记录，不参与判定。 */
  claimedScopeDescription?: string | null;
  /** 操作会触及多个已登记项目根。 */
  touchesAdditionalProjectRoots?: boolean;
  /** 可能产生项目外副作用（全局缓存/环境/系统目录等）。 */
  hasExternalSideEffects?: boolean;
}

export interface RegisteredProjectRoot {
  projectIdentifier: string;
  rootPath: string;
}

export interface ScopeResolution {
  scopeClass: ScopeClass;
  resolvedTargetPath: string | null;
  projectIdentifier: string | null;
  reasons: string[];
}

export type ScopeResolutionErrorCode = "invalid-operation";

export class ScopeResolutionError extends Error {
  constructor(
    readonly errorCode: ScopeResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScopeResolutionError";
  }
}

type RealPathResolver = (inputPath: string) => Promise<string | null>;

async function defaultResolveRealPath(inputPath: string): Promise<string | null> {
  const absolutePath = path.resolve(inputPath);
  try {
    return await realpath(absolutePath);
  } catch {
    // 目标不存在：对最近存在的祖先做 realpath，再拼回剩余段。
  }
  let parentPath = path.dirname(absolutePath);
  let suffixPath = path.basename(absolutePath);
  for (let depth = 0; depth < 64; depth += 1) {
    if (parentPath === path.dirname(parentPath)) {
      return null;
    }
    try {
      const realParentPath = await realpath(parentPath);
      return path.join(realParentPath, suffixPath);
    } catch {
      suffixPath = path.join(path.basename(parentPath), suffixPath);
      parentPath = path.dirname(parentPath);
    }
  }
  return null;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  const withSeparator = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(withSeparator);
}

/** shell 展开/通配/变量相关字符：出现即视为不可结构化解析。 */
const SHELL_METACHARACTERS = new Set([
  "*",
  "?",
  "<",
  ">",
  "|",
  "$",
  "`",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "!",
  "~",
]);

/** 只有明确的结构化路径才参与判定；含控制字符或 shell 展开时视为不可解析。 */
function isStructurallyResolvablePath(rawPath: string): boolean {
  const trimmedPath = rawPath.trim();
  if (trimmedPath === "") {
    return false;
  }
  for (const character of trimmedPath) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || codePoint < 0x20) {
      return false;
    }
    if (SHELL_METACHARACTERS.has(character)) {
      return false;
    }
  }
  return true;
}

export async function resolveOperationScope(input: {
  operation: OperationDescriptor;
  registeredProjectRoots: RegisteredProjectRoot[];
  resolveRealPath?: RealPathResolver;
}): Promise<ScopeResolution> {
  const resolveRealPath = input.resolveRealPath ?? defaultResolveRealPath;
  const reasons: string[] = [];
  const operation = input.operation;

  if (!OPERATION_KINDS.includes(operation.operationKind)) {
    throw new ScopeResolutionError(
      "invalid-operation",
      "未知操作类型: " + String(operation.operationKind),
    );
  }
  if (operation.claimedScopeDescription !== undefined && operation.claimedScopeDescription !== null) {
    reasons.push("自述范围不参与判定（仅记录）");
  }

  if (operation.operationKind === "dependency-install") {
    return {
      scopeClass: "S5-installation",
      resolvedTargetPath: null,
      projectIdentifier: null,
      reasons: [...reasons, "安装类操作：必须走独立安装开关与逐次授权"],
    };
  }
  if (operation.operationKind === "external-software-control") {
    return {
      scopeClass: "S6-external-software",
      resolvedTargetPath: null,
      projectIdentifier: null,
      reasons: [...reasons, "外部软件控制：协同模式需人工授权"],
    };
  }
  if (
    operation.operationKind === "remote-publish" ||
    operation.operationKind === "backup-deletion"
  ) {
    return {
      scopeClass: "S7-special-flow",
      resolvedTargetPath: null,
      projectIdentifier: null,
      reasons: [...reasons, "专用流程：不因本模块放宽"],
    };
  }

  const rawTargetPath = operation.targetPath ?? null;
  if (
    rawTargetPath === null ||
    !isStructurallyResolvablePath(rawTargetPath)
  ) {
    return {
      scopeClass: "S4-unknown",
      resolvedTargetPath: null,
      projectIdentifier: null,
      reasons: [...reasons, "目标路径无法结构化解析（动态/通配/变量）：归未知范围"],
    };
  }

  const resolvedTargetPath = await resolveRealPath(rawTargetPath);
  if (resolvedTargetPath === null) {
    return {
      scopeClass: "S4-unknown",
      resolvedTargetPath: null,
      projectIdentifier: null,
      reasons: [...reasons, "真实路径解析失败：归未知范围"],
    };
  }

  const resolvedRoots: Array<RegisteredProjectRoot & { resolvedRootPath: string }> = [];
  for (const root of input.registeredProjectRoots) {
    const resolvedRootPath = await resolveRealPath(root.rootPath);
    if (resolvedRootPath !== null) {
      resolvedRoots.push({ ...root, resolvedRootPath });
    }
  }
  const matchingRoots = resolvedRoots.filter((root) =>
    isPathWithinRoot(root.resolvedRootPath, resolvedTargetPath),
  );

  if (matchingRoots.length > 1 || operation.touchesAdditionalProjectRoots === true) {
    return {
      scopeClass: "S2-cross-project-root",
      resolvedTargetPath,
      projectIdentifier: matchingRoots[0]?.projectIdentifier ?? null,
      reasons: [...reasons, "操作跨越多个已登记项目根"],
    };
  }
  if (matchingRoots.length === 1) {
    const matchedRoot = matchingRoots[0];
    if (operation.hasExternalSideEffects === true) {
      return {
        scopeClass: "S3-project-external",
        resolvedTargetPath,
        projectIdentifier: matchedRoot?.projectIdentifier ?? null,
        reasons: [...reasons, "目标在项目根内但操作声明了项目外副作用"],
      };
    }
    return {
      scopeClass: "S1-project-internal",
      resolvedTargetPath,
      projectIdentifier: matchedRoot?.projectIdentifier ?? null,
      reasons: [...reasons, "真实路径位于已登记项目根内"],
    };
  }

  // 不在任何已登记项目根内：外部范围（写入/执行比只读更严格，但都属于项目外）。
  return {
    scopeClass: "S3-project-external",
    resolvedTargetPath,
    projectIdentifier: null,
    reasons: [...reasons, "真实路径不在任何已登记项目根内"],
  };
}

export type Adjudicator =
  | "local-readonly-policy"
  | "superior-agent"
  | "authenticated-user"
  | "dedicated-flow";

export interface ScopeAuthorizationDecision {
  decision: "allow" | "ask-superior" | "ask-user" | "deny";
  adjudicator: Adjudicator;
  requiresInstallationSwitch: boolean;
  reasons: string[];
}

export function decideScopeAuthorization(input: {
  scopeClass: ScopeClass;
  mode: "ponder" | "assist" | "devolve";
  configuredDecision: "deny" | "ask" | "allow";
  isInstallationEnabled: boolean;
  isReadOnlyOperation: boolean;
}): ScopeAuthorizationDecision {
  const reasons: string[] = [];
  // deny 一律优先（含放权模式与只读操作）。
  if (input.configuredDecision === "deny") {
    return {
      decision: "deny",
      adjudicator: "local-readonly-policy",
      requiresInstallationSwitch: input.scopeClass === "S5-installation",
      reasons: ["权限目录显式 deny：优先于任何模式与范围"],
    };
  }

  if (input.mode === "ponder") {
    if (input.isReadOnlyOperation) {
      return {
        decision: "allow",
        adjudicator: "local-readonly-policy",
        requiresInstallationSwitch: false,
        reasons: ["思索模式：仅本地只读白名单"],
      };
    }
    return {
      decision: "deny",
      adjudicator: "local-readonly-policy",
      requiresInstallationSwitch: false,
      reasons: ["思索模式：非只读操作一律拒绝"],
    };
  }

  if (input.scopeClass === "S7-special-flow") {
    return {
      decision: "ask-user",
      adjudicator: "dedicated-flow",
      requiresInstallationSwitch: false,
      reasons: ["专用流程保持既有授权，不由本模块放宽"],
    };
  }

  if (input.scopeClass === "S5-installation") {
    if (!input.isInstallationEnabled) {
      return {
        decision: "deny",
        adjudicator: "local-readonly-policy",
        requiresInstallationSwitch: true,
        reasons: ["安装功能开关关闭：拒绝（开关不得被自动批准替代）"],
      };
    }
    if (input.mode === "assist") {
      return {
        decision: "ask-user",
        adjudicator: "authenticated-user",
        requiresInstallationSwitch: true,
        reasons: ["协同模式安装：先询问已有资源，再逐次取得认证用户授权"],
      };
    }
    return {
      decision: input.configuredDecision === "ask" ? "ask-superior" : "allow",
      adjudicator:
        input.configuredDecision === "ask" ? "superior-agent" : "local-readonly-policy",
      requiresInstallationSwitch: true,
      reasons: ["放权模式安装：开关开启后按已配置决策，参数必须精确绑定"],
    };
  }

  if (input.mode === "assist") {
    if (input.scopeClass === "S1-project-internal") {
      if (input.configuredDecision === "allow") {
        return {
          decision: "allow",
          adjudicator: "superior-agent",
          requiresInstallationSwitch: false,
          reasons: ["协同模式项目内操作：按设置由有权上级自动批准（留批准回执）"],
        };
      }
      return {
        decision: "ask-superior",
        adjudicator: "superior-agent",
        requiresInstallationSwitch: false,
        reasons: ["协同模式项目内操作：默认由有权上级批准后执行"],
      };
    }
    // S2/S3/S4/S6：项目外、跨根、未知与外部软件控制需认证用户授权。
    return {
      decision: "ask-user",
      adjudicator: "authenticated-user",
      requiresInstallationSwitch: false,
      reasons: [
        input.scopeClass === "S4-unknown"
          ? "范围未知：必须人工裁决，不猜测边界"
          : "项目外/跨根/外部软件控制：需认证用户对精确操作授权",
      ],
    };
  }

  // devolve：默认按配置执行，但未知范围必须上级裁决，不得把用户离线当作同意。
  if (input.scopeClass === "S4-unknown") {
    return {
      decision: "ask-superior",
      adjudicator: "superior-agent",
      requiresInstallationSwitch: false,
      reasons: ["放权模式未知范围：交由上级裁决，不得按用户离线=同意"],
    };
  }
  if (input.configuredDecision === "ask") {
    return {
      decision: "ask-superior",
      adjudicator: "superior-agent",
      requiresInstallationSwitch: false,
      reasons: ["放权模式按已配置 ask 路由到上级裁决"],
    };
  }
  reasons.push("放权模式：无人工介入时按已配置权限执行");
  return {
    decision: "allow",
    adjudicator: "local-readonly-policy",
    requiresInstallationSwitch: false,
    reasons,
  };
}

export interface ScopeApprovalReceipt {
  receiptIdentifier: string;
  scopeClass: ScopeClass;
  adjudicator: "superior-agent" | "authenticated-user" | "dedicated-flow";
  approvedByAgentInstanceId: string | null;
  approvedByUserId: string | null;
  operationFingerprint: string;
  authorizationRevision: number;
  approvedAtIso: string;
  expiresAtIso: string | null;
}

export function computeOperationFingerprint(input: {
  operation: OperationDescriptor;
  resolution: ScopeResolution;
}): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        [
          input.operation.operationKind,
          input.resolution.scopeClass,
          input.resolution.projectIdentifier ?? "-",
          input.resolution.resolvedTargetPath ?? "-",
        ].join("|"),
        "utf8",
      )
      .digest("hex")
  );
}

export type ReceiptVerificationReason =
  | "valid"
  | "scope-mismatch"
  | "fingerprint-mismatch"
  | "stale-revision"
  | "expired";

export function verifyScopeApprovalReceipt(input: {
  receipt: ScopeApprovalReceipt;
  operation: OperationDescriptor;
  resolution: ScopeResolution;
  currentAuthorizationRevision: number;
  nowIso: string;
}): { isValid: boolean; reason: ReceiptVerificationReason } {
  if (input.receipt.scopeClass !== input.resolution.scopeClass) {
    return { isValid: false, reason: "scope-mismatch" };
  }
  const expectedFingerprint = computeOperationFingerprint({
    operation: input.operation,
    resolution: input.resolution,
  });
  if (expectedFingerprint !== input.receipt.operationFingerprint) {
    return { isValid: false, reason: "fingerprint-mismatch" };
  }
  if (input.receipt.authorizationRevision !== input.currentAuthorizationRevision) {
    return { isValid: false, reason: "stale-revision" };
  }
  if (
    input.receipt.expiresAtIso !== null &&
    Date.parse(input.nowIso) > Date.parse(input.receipt.expiresAtIso)
  ) {
    return { isValid: false, reason: "expired" };
  }
  return { isValid: true, reason: "valid" };
}

/** 执行前复检：重新解析范围（链接/根可能变化），再校验回执。 */
export async function recheckBeforeExecution(input: {
  operation: OperationDescriptor;
  registeredProjectRoots: RegisteredProjectRoot[];
  receipt: ScopeApprovalReceipt;
  currentAuthorizationRevision: number;
  nowIso: string;
  resolveRealPath?: RealPathResolver;
}): Promise<{
  resolution: ScopeResolution;
  receiptVerification: { isValid: boolean; reason: ReceiptVerificationReason };
}> {
  const resolution = await resolveOperationScope({
    operation: input.operation,
    registeredProjectRoots: input.registeredProjectRoots,
    ...(input.resolveRealPath !== undefined
      ? { resolveRealPath: input.resolveRealPath }
      : {}),
  });
  return {
    resolution,
    receiptVerification: verifyScopeApprovalReceipt({
      receipt: input.receipt,
      operation: input.operation,
      resolution,
      currentAuthorizationRevision: input.currentAuthorizationRevision,
      nowIso: input.nowIso,
    }),
  };
}

export type AgentLevel = "secondary" | "tertiary" | "quaternary";

const LEVEL_DEPTH: Record<AgentLevel, number> = {
  secondary: 1,
  tertiary: 2,
  quaternary: 3,
};

/** 升级目标：S1 由直接上级处理；跨根/项目外/未知/安装/外部软件需有权处理的次级。 */
export function resolveEscalationTarget(input: {
  requesterLevel: AgentLevel;
  scopeClass: ScopeClass;
}): { targetLevel: AgentLevel; reason: string } {
  if (input.scopeClass === "S1-project-internal") {
    const targetLevel: AgentLevel =
      input.requesterLevel === "quaternary" ? "tertiary" : "secondary";
    return { targetLevel, reason: "项目内操作沿直属上级处理" };
  }
  return {
    targetLevel: "secondary",
    reason: "需要扩大委派范围或超出上级权限：升至有权处理的次级",
  };
}

/** 升级路径必须逐级向上、无循环回派且不超过有界深度。 */
export function isValidEscalationPath(pathLevels: AgentLevel[]): boolean {
  if (pathLevels.length === 0 || pathLevels.length > 3) {
    return false;
  }
  let previousDepth = Number.POSITIVE_INFINITY;
  const seen = new Set<AgentLevel>();
  for (const level of pathLevels) {
    if (seen.has(level)) {
      return false;
    }
    seen.add(level);
    const depth = LEVEL_DEPTH[level];
    if (depth >= previousDepth) {
      return false;
    }
    previousDepth = depth;
  }
  return pathLevels.at(-1) === "secondary";
}
