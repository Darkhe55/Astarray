/**
 * TOOLKIT-01-01：工具包**登记与作用域**注册表（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §4/§5。
 *
 * 本层只做"登记、作用域、显式启用、不可变与身份"的**本地确定性判定**，
 * 不做工具生成、不执行工具、不联网、不读凭据。卡内硬要求逐条落实：
 *
 *  - **名称不是路由键**：只能以 `toolPackageId + version + contentHash` 寻址；
 *    `resolveByReadableName()` 永远返回 null（禁止"自动选最新同名工具"）；
 *  - **已启用内容不可原地修改**：同 ID+版本 换哈希一律拒绝，必须升版本；
 *  - **运行前校验实际哈希**，不一致即拒绝使用（拒绝"校验后偷换内容"）；
 *  - 作用域三层 `project` / `user` / `portable`；
 *  - **推广不自动发生**：`proposePromotion()` 只产生提案；
 *    `applyPromotionDecision()` 才改变作用域，且**不**在各项目自动启用；
 *  - **目标项目必须显式 enable** 才能执行；未启用包只能被查看；
 *  - 来源身份必须是具体 `agentInstanceId`；
 *  - 包内**不得**携带凭据、授权 nonce、私有记忆。
 */

export const TOOL_PACKAGE_SCHEMA_VERSION = "ASTARRAY_TOOL_PACKAGE_V1";

/** 包类型（卡内 §2 三类产物；确定性程序工具按检查点 05 启用）。 */
export type ToolPackageKind = "skill-template" | "recipe" | "deterministic-program";

/** 作用域（卡内 §5）：project → user → portable。 */
export type ToolPackageScope = "project" | "user" | "portable";

/** 状态最小集合（卡内 §3）：draft → validated → enabled；另有 rejected / disabled / deprecated。 */
export type ToolPackageStatus =
  | "draft"
  | "validated"
  | "enabled"
  | "rejected"
  | "disabled"
  | "deprecated";

export interface ToolPackageRegistration {
  toolPackageId: string;
  version: number;
  /** `sha256:<64 hex>`。 */
  contentHash: string;
  schemaVersion: string;
  packageKind: ToolPackageKind;
  readableName: string;
  purposeSummary: string;
  applicableConditions: string[];
  /** 来源项目（推广后仍保留来源，用于溯源）。 */
  sourceProjectIdentifier: string;
  /** 生成者**具体** agentInstanceId（不得只保存角色/模型名）。 */
  generatorAgentInstanceId: string;
  /** 验收者**具体** agentInstanceId（须与生成者不同）。 */
  acceptorAgentInstanceId: string;
  evidenceReferences: string[];
  supportedActions: string[];
  scope?: ToolPackageScope;
}

interface StoredToolPackage {
  registration: ToolPackageRegistration;
  scope: ToolPackageScope;
  status: ToolPackageStatus;
  /** 已显式启用该包（固定版本）的项目集合。 */
  enabledProjectIdentifiers: Set<string>;
}

export interface ToolPackagePromotionProposal {
  proposalIdentifier: string;
  toolPackageId: string;
  version: number;
  fromScope: ToolPackageScope;
  targetScope: ToolPackageScope;
  reason: string;
  outcome: "proposed";
}

/**
 * 禁止出现在包内的字段（凭据 / 一次性授权 / 私有记忆 / 绝对路径）。
 * 卡内 §4/§5：不得包含凭据、授权 nonce 或个体私有记忆。
 */
const FORBIDDEN_PACKAGE_FIELDS = [
  "credentialReference",
  "credentials",
  "authorizationNonce",
  "oneTimeGrant",
  "privateMemoryEntries",
  "privateMemory",
] as const;

function identityKey(input: {
  toolPackageId: string;
  version: number;
  contentHash: string;
}): string {
  return input.toolPackageId + "@" + String(input.version) + "#" + input.contentHash;
}

function versionKey(input: { toolPackageId: string; version: number }): string {
  return input.toolPackageId + "@" + String(input.version);
}

export class ToolPackageRegistry {
  /** 以 ID+版本+哈希 为键（同一包可有多条不同版本记录）。 */
  private readonly packagesByIdentity = new Map<string, StoredToolPackage>();
  /** ID+版本 → 已登记内容哈希（用于"不可原地修改"与"偷换内容"判定）。 */
  private readonly contentHashByVersion = new Map<string, string>();
  private readonly proposals = new Map<string, ToolPackagePromotionProposal>();
  private nextProposalSequence = 1;

  /**
   * 登记一个工具包。
   *
   * 拒绝情形（全部 fail-closed）：
   *  - 缺来源/验收的具体 `agentInstanceId`；
   *  - 生成者与验收者相同（作者不能自验，沿用 T08D 既有纪律）；
   *  - 携带凭据/授权 nonce/私有记忆字段；
   *  - 同 ID+版本 但内容哈希不同（**已启用内容不可原地修改**）。
   */
  register(registration: ToolPackageRegistration): void {
    const record = registration as unknown as Record<string, unknown>;
    for (const forbiddenField of FORBIDDEN_PACKAGE_FIELDS) {
      if (record[forbiddenField] !== undefined) {
        throw new Error(
          "工具包不得携带凭据、授权 nonce 或私有记忆字段: " + forbiddenField,
        );
      }
    }
    if (
      typeof registration.generatorAgentInstanceId !== "string" ||
      registration.generatorAgentInstanceId === ""
    ) {
      throw new Error(
        "工具包必须记录生成者的具体 agentInstanceId（不得只保存角色/模型名）",
      );
    }
    if (
      typeof registration.acceptorAgentInstanceId !== "string" ||
      registration.acceptorAgentInstanceId === ""
    ) {
      throw new Error(
        "工具包必须记录验收者的具体 agentInstanceId（未验收不得登记为可推广候选）",
      );
    }
    if (
      registration.generatorAgentInstanceId === registration.acceptorAgentInstanceId
    ) {
      throw new Error(
        "生成者不得担任自己产物的验收者（需要不同的 agentInstanceId）",
      );
    }
    const key = versionKey(registration);
    const existingHash = this.contentHashByVersion.get(key);
    if (existingHash !== undefined && existingHash !== registration.contentHash) {
      throw new Error(
        "已启用内容不可原地修改：同 ID+版本 的内容哈希变化必须生成新版本（" +
          key +
          "）",
      );
    }
    this.contentHashByVersion.set(key, registration.contentHash);
    const stored: StoredToolPackage = {
      registration: { ...registration },
      scope: registration.scope ?? "project",
      status: "validated",
      enabledProjectIdentifiers: new Set<string>(),
    };
    this.packagesByIdentity.set(identityKey(registration), stored);
  }

  /**
   * **名称不是路由键**：按可读名称解析一律失败。
   *
   * 保留此方法是为了让"禁止按名称路由"成为**可执行断言**而不是口头约定
   * （同名包必须显示来源与版本，禁止自动选"最新同名工具"）。
   */
  resolveByReadableName(readableName: string): null {
    void readableName;
    return null;
  }

  resolveByIdentity(input: {
    toolPackageId: string;
    version: number;
    contentHash: string;
  }): ToolPackageRegistration | null {
    const stored = this.packagesByIdentity.get(identityKey(input));
    return stored === undefined ? null : { ...stored.registration };
  }

  /** 管理视图：按 ID+版本查看（未启用的包只能被查看、不能被调用）。 */
  describePackage(input: {
    toolPackageId: string;
    version: number;
  }): {
    registration: ToolPackageRegistration;
    scope: ToolPackageScope;
    status: ToolPackageStatus;
    enabledProjectIdentifiers: string[];
  } | null {
    const stored = this.findByVersion(input);
    if (stored === null) {
      return null;
    }
    return {
      registration: { ...stored.registration },
      scope: stored.scope,
      status: stored.status,
      enabledProjectIdentifiers: [...stored.enabledProjectIdentifiers].sort(),
    };
  }

  /**
   * 项目内**显式启用**（固定版本）。这是"可调用"的唯一来源。
   *
   * `isAcceptanceRecorded === false` ⇒ 拒绝：未验收不得启用
   * （卡内 §3 第 6 步"次级核对证据后按有效项目策略登记并启用"）。
   */
  enable(input: {
    toolPackageId: string;
    version: number;
    targetProjectIdentifier: string;
    isAcceptanceRecorded?: boolean;
  }): void {
    const stored = this.findByVersion(input);
    if (stored === null) {
      throw new Error(
        "未登记的工具包不可启用: " +
          input.toolPackageId +
          "@" +
          String(input.version),
      );
    }
    if (input.isAcceptanceRecorded === false) {
      throw new Error(
        "未经验收的工具包不可启用（必须先由不同 Agent 完成验收）",
      );
    }
    if (stored.status === "rejected") {
      throw new Error("已被拒绝的工具包不可启用");
    }
    /**
     * 作用域约束：`project` 作用域只能在其**来源项目**启用；
     * 推广到 user/portable 后，才允许在目标项目显式启用。
     */
    if (
      stored.scope === "project" &&
      input.targetProjectIdentifier !== stored.registration.sourceProjectIdentifier
    ) {
      throw new Error(
        "project 作用域的包只能在来源项目启用；跨项目使用需先推广并重新验收",
      );
    }
    stored.enabledProjectIdentifiers.add(input.targetProjectIdentifier);
    stored.status = "enabled";
  }

  /** 项目内可发现的包：仅该项目**已显式启用**的条目。 */
  listDiscoverable(input: { projectIdentifier: string }): ToolPackageRegistration[] {
    const discoverable: ToolPackageRegistration[] = [];
    for (const stored of this.packagesByIdentity.values()) {
      if (!stored.enabledProjectIdentifiers.has(input.projectIdentifier)) {
        continue;
      }
      if (stored.status === "disabled" || stored.status === "deprecated") {
        continue;
      }
      discoverable.push({ ...stored.registration });
    }
    return discoverable.sort((left, right) => {
      if (left.toolPackageId !== right.toolPackageId) {
        return left.toolPackageId.localeCompare(right.toolPackageId);
      }
      return left.version - right.version;
    });
  }

  /**
   * 执行前解析：**必须**该项目已显式启用该固定版本，否则返回 null。
   *
   * "未启用包只能被查看、不能调用"在此实现；跨项目不继承启用状态。
   */
  resolveForExecution(input: {
    toolPackageId: string;
    version: number;
    projectIdentifier: string;
  }): ToolPackageRegistration | null {
    const stored = this.findByVersion(input);
    if (stored === null) {
      return null;
    }
    if (!stored.enabledProjectIdentifiers.has(input.projectIdentifier)) {
      return null;
    }
    if (stored.status !== "enabled") {
      return null;
    }
    return { ...stored.registration };
  }

  /** 运行前校验实际内容哈希（拒绝"校验后偷换内容"）。 */
  verifyContentBeforeUse(input: {
    toolPackageId: string;
    version: number;
    observedContentHash: string;
  }): { isValid: boolean; reason: string | null } {
    const stored = this.findByVersion(input);
    if (stored === null) {
      return { isValid: false, reason: "未登记的工具包" };
    }
    if (stored.registration.contentHash !== input.observedContentHash) {
      return {
        isValid: false,
        reason:
          "实际内容哈希与登记哈希不一致（可能被校验后偷换内容），拒绝使用",
      };
    }
    return { isValid: true, reason: null };
  }

  /**
   * 推广**提案**：只记录意图，**不改变任何可用性**。
   * 卡内 §5："用户级与通用推广不自动发生，运行频次或模型'认为通用'仅能产生提案。"
   */
  proposePromotion(input: {
    toolPackageId: string;
    version: number;
    targetScope: ToolPackageScope;
    reason: string;
  }): ToolPackagePromotionProposal {
    const stored = this.findByVersion(input);
    if (stored === null) {
      throw new Error("未登记的工具包不可提出推广");
    }
    const proposal: ToolPackagePromotionProposal = {
      proposalIdentifier: "promotion-" + String(this.nextProposalSequence),
      toolPackageId: input.toolPackageId,
      version: input.version,
      fromScope: stored.scope,
      targetScope: input.targetScope,
      reason: input.reason,
      outcome: "proposed",
    };
    this.nextProposalSequence += 1;
    this.proposals.set(proposal.proposalIdentifier, proposal);
    return proposal;
  }

  /**
   * 应用推广裁决（用户批准/驳回）。批准只改变**作用域**，
   * **不**在任何目标项目自动启用（卡内 §5："用户批准推广不代表批准在所有项目运行"）。
   */
  applyPromotionDecision(input: {
    proposalIdentifier: string;
    decision: "approved" | "rejected";
  }): void {
    const proposal = this.proposals.get(input.proposalIdentifier);
    if (proposal === undefined) {
      throw new Error("推广提案不存在: " + input.proposalIdentifier);
    }
    if (input.decision === "rejected") {
      return;
    }
    const stored = this.findByVersion({
      toolPackageId: proposal.toolPackageId,
      version: proposal.version,
    });
    if (stored === null) {
      throw new Error("推广提案对应的工具包已不存在");
    }
    stored.scope = proposal.targetScope;
  }

  private findByVersion(input: {
    toolPackageId: string;
    version: number;
  }): StoredToolPackage | null {
    const expectedHash = this.contentHashByVersion.get(versionKey(input));
    if (expectedHash === undefined) {
      return null;
    }
    return (
      this.packagesByIdentity.get(
        identityKey({
          toolPackageId: input.toolPackageId,
          version: input.version,
          contentHash: expectedHash,
        }),
      ) ?? null
    );
  }
}
