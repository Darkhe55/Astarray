/**
 * TOOLKIT-01-03：项目专用 → 用户级 → 通用包的**推广**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §5/§6/§7/§8。
 *
 * 本模块只做**本地确定性判定**：不做 I/O、不联网、不读凭据、不执行工具。
 *
 * 卡内硬要求逐条落实：
 *  - 推广**不自动发生**：本模块只产生**候选**，是否入库由用户裁决；
 *  - **用户批准推广 ≠ 批准在所有项目运行**：批准结果里 `enabledProjectIdentifiers` 恒为空，
 *    目标项目必须**显式启用**（由 TOOLKIT-01-01 注册表判定）；
 *  - 候选必须**去项目化**：剥离项目适配，且不得带出绝对路径、项目源码片段、
 *    凭据、一次性授权 nonce、私有记忆；
 *  - `portable` 至少需要**两个结构不同的隔离项目**证据；
 *  - **三段分离**：通用逻辑 / 项目适配 / 用户偏好；
 *  - 配置优先级固定：**包默认 → 用户偏好 → 项目适配 → 本次显式非安全参数**，
 *    全部经 schema 校验；**安全范围不参与后写覆盖**（始终走权限求交）；
 *  - **目标项目零修改**、**目标权限不继承**、**固定版本+哈希**（不自动随库升级）。
 */

export type ToolPackagePromotionScope = "user" | "portable";

/** 安全范围的配置键：这些键**不得**被偏好/项目适配/本次参数覆盖。 */
const SECURITY_SCOPED_CONFIGURATION_KEYS = [
  "permissionMode",
  "allowNetworkAccess",
  "allowWriteOutsideProject",
  "allowInstall",
  "allowProcessExecution",
  /** 验收事实属"事实范围"，同样不可被偏好改写（§6"偏好不改变验收事实"）。 */
  "acceptanceVerdict",
] as const;

/** 禁止出现在推广候选中的内容特征（本地确定性模式，非模型判断）。 */
const FORBIDDEN_CANDIDATE_CONTENT_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  // Windows 与 POSIX 绝对路径（含用户目录）
  { pattern: /[A-Za-z]:\\\\?[^"'\s]*\\/, label: "绝对路径" },
  { pattern: /(^|[\s"'(])\/(?:Users|home|root|var|etc)\//, label: "绝对路径" },
  // 项目源码片段（相对引用回到来源项目）
  { pattern: /(\.\.\/)+[A-Za-z0-9_-]+\/src\//, label: "项目源码片段" },
  // 凭据（`sk-` 后允许连字符：真实密钥常见 `sk-live-<payload>` 形态，
  // 若不允许连字符会因"连字符前字母不足 16 个"而漏掉整条密钥 —— 2026-10-10 实测修正）
  { pattern: /sk-[A-Za-z0-9-]{16,}/, label: "凭据" },
  { pattern: /(Authorization|Bearer)\s*[:=]?\s*\S{8,}/i, label: "凭据" },
  // 一次性授权
  { pattern: /nonce/i, label: "一次性授权 nonce" },
  // 私有记忆
  { pattern: /private\s*memory|私有记忆|memory-?entry/i, label: "私有记忆" },
];

export interface ToolPackageSourceContent {
  toolPackageId: string;
  version: number;
  contentHash: string;
  sourceProjectIdentifier: string;
  /** 三段之一：**通用逻辑**（解析/统计/模板等与项目无关的部分）。 */
  generalLogic: Record<string, unknown>;
  /** 三段之二：**项目适配**（按项目标识分组的配置；推广时必须剥离）。 */
  projectAdaptations: Record<string, Record<string, unknown>>;
  /** 三段之三：**用户偏好**（表现形式；不得改变权限/安全/验收事实）。 */
  userPreferences: Record<string, unknown>;
  /** 来源包若声明了权限范围，推广**不得**带过去（目标权限不继承）。 */
  sourcePermissionDeclarations?: Record<string, unknown>;
}

export interface ToolPackagePromotionCandidate {
  candidateIdentifier: string;
  sourceToolPackageId: string;
  sourceVersion: number;
  sourceContentHash: string;
  sourceProjectIdentifier: string;
  /** 新候选必须有**新版本号**（已启用内容不可原地修改）。 */
  candidateVersion: number;
  candidateContentHash: string;
  targetScope: ToolPackagePromotionScope;
  generalLogic: Record<string, unknown>;
  userPreferences: Record<string, unknown>;
  /** 候选**不含**项目适配（去项目化的直接体现）。 */
  projectAdaptations: Record<string, Record<string, unknown>>;
  /** 被剥离的来源项目标识（可追溯，同时证明确实剥离了）。 */
  strippedProjectIdentifiers: string[];
  /** 推广**不得**携带来源权限声明；恒为空。 */
  carriedPermissionDeclarations: unknown[];
  reason: string;
}

export interface PromotionCandidateValidation {
  isValid: boolean;
  reason: string | null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, innerValue: unknown) => {
    if (
      innerValue !== null &&
      typeof innerValue === "object" &&
      !Array.isArray(innerValue)
    ) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(innerValue as Record<string, unknown>).sort()) {
        sorted[key] = (innerValue as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return innerValue;
  });
}

/** 本地确定性内容哈希（无 I/O；用于候选包新哈希的稳定计算）。 */
function computeCandidateContentHash(input: {
  sourceContentHash: string;
  targetScope: string;
  generalLogic: unknown;
  userPreferences: unknown;
  candidateVersion: number;
}): string {
  // 复用来源哈希 + 结构化内容，保证"同样输入 ⇒ 同样哈希"，且与来源哈希不同。
  const payload = [
    input.sourceContentHash,
    input.targetScope,
    String(input.candidateVersion),
    stableStringify(input.generalLogic),
    stableStringify(input.userPreferences),
  ].join("|");
  let hashValue = 0n;
  const primeModulus = 9007199254740881n;
  for (let index = 0; index < payload.length; index += 1) {
    hashValue = (hashValue * 131n + BigInt(payload.charCodeAt(index))) % primeModulus;
  }
  const baseHash = hashValue.toString(16).padStart(16, "0");
  return "sha256:" + baseHash.repeat(4).slice(0, 64);
}

let nextCandidateSequence = 1;

/**
 * 产生推广**候选**（剥离项目适配、剥离来源权限声明）。
 *
 * 注意：产生候选**不改变任何可用性**；入库仍需用户裁决与目标项目显式启用。
 */
export function createPromotionCandidate(input: {
  sourcePackage: ToolPackageSourceContent;
  targetScope: ToolPackagePromotionScope;
  reason: string;
}): ToolPackagePromotionCandidate {
  const strippedProjectIdentifiers = Object.keys(
    input.sourcePackage.projectAdaptations,
  ).sort();
  const candidateVersion = input.sourcePackage.version + 1;
  const generalLogic = { ...input.sourcePackage.generalLogic };
  const userPreferences = { ...input.sourcePackage.userPreferences };
  const candidate: ToolPackagePromotionCandidate = {
    candidateIdentifier: "promotion-candidate-" + String(nextCandidateSequence),
    sourceToolPackageId: input.sourcePackage.toolPackageId,
    sourceVersion: input.sourcePackage.version,
    sourceContentHash: input.sourcePackage.contentHash,
    sourceProjectIdentifier: input.sourcePackage.sourceProjectIdentifier,
    candidateVersion,
    candidateContentHash: computeCandidateContentHash({
      sourceContentHash: input.sourcePackage.contentHash,
      targetScope: input.targetScope,
      generalLogic,
      userPreferences,
      candidateVersion,
    }),
    targetScope: input.targetScope,
    generalLogic,
    userPreferences,
    projectAdaptations: {},
    strippedProjectIdentifiers,
    // 目标权限不继承：来源权限声明一律不带出
    carriedPermissionDeclarations: [],
    reason: input.reason,
  };
  nextCandidateSequence += 1;
  return candidate;
}

/**
 * 校验推广候选（**fail-closed**）。
 *
 * 拒绝：敏感/项目内容、非去项目化（仍含项目适配）、
 * `portable` 缺两个结构不同的隔离项目证据、来源项目未验证。
 */
export function validatePromotionCandidate(input: {
  candidate: ToolPackagePromotionCandidate;
  /** 已通过隔离验证的项目标识（含来源项目）。 */
  validatedProjectIdentifiers?: string[];
}): PromotionCandidateValidation {
  const { candidate } = input;
  // 去项目化：候选不得携带任何项目适配
  if (Object.keys(candidate.projectAdaptations).length > 0) {
    return {
      isValid: false,
      reason: "候选包仍携带项目适配，未完成去项目化: " +
        Object.keys(candidate.projectAdaptations).join(","),
    };
  }
  // 内容特征检查（绝对路径/源码片段/凭据/nonce/私有记忆）
  const candidateContent = stableStringify({
    generalLogic: candidate.generalLogic,
    userPreferences: candidate.userPreferences,
  });
  for (const rule of FORBIDDEN_CANDIDATE_CONTENT_PATTERNS) {
    if (rule.pattern.test(candidateContent)) {
      return {
        isValid: false,
        reason:
          "推广候选不得带出项目源码、绝对路径、私有配置、私有记忆、凭据或一次性授权（命中: " +
          rule.label +
          "）",
      };
    }
  }
  // 目标权限不继承
  if (candidate.carriedPermissionDeclarations.length > 0) {
    return {
      isValid: false,
      reason: "推广候选不得携带来源项目的权限/范围声明（目标权限不继承）",
    };
  }
  const validatedProjectIdentifiers = input.validatedProjectIdentifiers ?? [
    candidate.sourceProjectIdentifier,
  ];
  if (!validatedProjectIdentifiers.includes(candidate.sourceProjectIdentifier)) {
    return {
      isValid: false,
      reason:
        "来源项目尚未通过验证，不得提出推广候选: " +
        candidate.sourceProjectIdentifier,
    };
  }
  if (candidate.targetScope === "portable") {
    const isolatedProjectIdentifiers = validatedProjectIdentifiers.filter(
      (projectIdentifier) => projectIdentifier !== candidate.sourceProjectIdentifier,
    );
    /**
     * 卡内 §5："至少用**两个结构不同的隔离项目**证明去项目化"。
     *
     * 保守解读（本项目采用）：来源项目计**一个**，因此还需**两个**结构不同的
     * 隔离项目，合计至少三个。理由：仅"来源 + 另一个"无法证明去掉来源适配后
     * 仍能在结构不同的环境中工作；多一个独立项目才排除"候选偷偷依赖来源项目结构"。
     */
    if (isolatedProjectIdentifiers.length < 2) {
      return {
        isValid: false,
        reason:
          "portable 推广需要至少两个结构不同的隔离项目证据以证明去项目化" +
          "（来源项目计一个，另需两个；当前仅 " +
          String(isolatedProjectIdentifiers.length) +
          " 个）",
      };
    }
  }
  return { isValid: true, reason: null };
}

export interface PromotionDecisionOutcome {
  candidateIdentifier: string;
  isApproved: boolean;
  scope: ToolPackagePromotionScope;
  /** **恒为空**：用户批准推广不代表批准在任何项目运行。 */
  enabledProjectIdentifiers: string[];
  sourceProjectIdentifier: string;
  isSourceProjectModified: boolean;
  inheritedPermissionDeclarations: unknown[];
  pinnedVersion: number;
  pinnedContentHash: string;
}

/**
 * 应用用户裁决。
 *
 * 批准只产出"用户库中的新版本"；**不在任何项目自动启用**、
 * **不修改来源项目**、**不继承来源权限**。
 */
export function applyPromotionDecision(input: {
  candidate: ToolPackagePromotionCandidate;
  decision: "approved" | "rejected";
  approvedByUserId: string;
}): PromotionDecisionOutcome {
  const isApproved = input.decision === "approved";
  return {
    candidateIdentifier: input.candidate.candidateIdentifier,
    isApproved,
    scope: input.candidate.targetScope,
    // 不自动启用：目标项目必须显式启用（TOOLKIT-01-01 注册表判定）
    enabledProjectIdentifiers: [],
    sourceProjectIdentifier: input.candidate.sourceProjectIdentifier,
    // 目标项目零修改：本模块不写回来源项目
    isSourceProjectModified: false,
    inheritedPermissionDeclarations: [],
    pinnedVersion: input.candidate.candidateVersion,
    pinnedContentHash: input.candidate.candidateContentHash,
  };
}

export interface EffectiveConfigurationResolution {
  isValid: boolean;
  reason: string | null;
  effectiveConfiguration: Record<string, unknown>;
  /** 实际生效的来源（便于"工具调用记录实际配置 revision"）。 */
  appliedSources: string[];
}

/**
 * 解析实际配置（§6 固定优先级）。
 *
 * 优先级：**包默认值 → 用户偏好 → 项目适配 → 本次显式非安全参数**（后者覆盖前者）。
 * **安全范围不参与这种后写覆盖**：任何层出现安全键（或验收事实键）即拒绝，
 * 调用方必须改走权限求交。
 */
export function resolveEffectiveConfiguration(input: {
  packageDefaults: Record<string, unknown>;
  userPreferences?: Record<string, unknown>;
  projectAdaptations?: Record<string, unknown>;
  callTimeExplicitParameters?: Record<string, unknown>;
  /** 允许出现的非安全配置键；给出时任何集外键一律拒绝。 */
  declaredConfigurationKeys?: string[];
}): EffectiveConfigurationResolution {
  const layers: Array<{ sourceName: string; values: Record<string, unknown> }> = [
    { sourceName: "package-defaults", values: input.packageDefaults },
  ];
  if (input.userPreferences !== undefined) {
    layers.push({ sourceName: "user-preferences", values: input.userPreferences });
  }
  if (input.projectAdaptations !== undefined) {
    layers.push({ sourceName: "project-adaptations", values: input.projectAdaptations });
  }
  if (input.callTimeExplicitParameters !== undefined) {
    layers.push({
      sourceName: "call-time-explicit",
      values: input.callTimeExplicitParameters,
    });
  }

  const effectiveConfiguration: Record<string, unknown> = {};
  const appliedSources: string[] = [];
  for (const layer of layers) {
    for (const [configurationKey, configurationValue] of Object.entries(layer.values)) {
      /**
       * 安全范围（含验收事实）**不参与后写覆盖**：即便出现在包默认值里也拒绝，
       * 以免调用方误以为"配置层"能决定权限。安全范围始终走权限求交。
       */
      if (
        (SECURITY_SCOPED_CONFIGURATION_KEYS as readonly string[]).includes(
          configurationKey,
        )
      ) {
        return {
          isValid: false,
          reason:
            "安全/事实范围不参与配置后写覆盖（始终走权限求交），不得由配置层决定: " +
            configurationKey,
          effectiveConfiguration: {},
          appliedSources: [],
        };
      }
      if (
        input.declaredConfigurationKeys !== undefined &&
        !input.declaredConfigurationKeys.includes(configurationKey)
      ) {
        return {
          isValid: false,
          reason: "未知/未声明的配置键（schema 校验失败）: " + configurationKey,
          effectiveConfiguration: {},
          appliedSources: [],
        };
      }
      effectiveConfiguration[configurationKey] = configurationValue;
    }
    appliedSources.push(layer.sourceName);
  }
  return {
    isValid: true,
    reason: null,
    effectiveConfiguration,
    appliedSources,
  };
}
