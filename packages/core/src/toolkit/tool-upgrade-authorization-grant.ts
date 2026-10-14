/**
 * TOOLKIT-01-04（2026-10-23）：**重新授权记录的签发权限**。
 *
 * ## 依据（用户 2026-10-22 澄清，取代我此前的错误方向）
 *
 * > "重新授权记录可以引入，**签发者不应该根据规则表设置**，应该由**拥有权限的角色**确定，
 * > **默认升级工具权限只有用户拥有**，并兼容可以**向下级逐层分发**权限的机制。"
 *
 * 此前 `issueRecord({ issuedBy })` 收的是一个**自由字符串** —— 谁都能填自己"是用户"，
 * 等于没有授权检查。本模块把"谁有资格签发"变成**本地可核验**的判定：
 *
 * - **用户本人**：默认即持有（`userIdentifier`，最高权限）；
 * - **Agent**：**默认不持有**，必须由持有者显式授予能力记录；
 * - **逐层分发不放大**：分发者只能把**自己持有的**能力授出，且**不得**超过自己的有效期；
 * - **撤销/到期即失效**：不因"曾经授过"而继续放行。
 *
 * 与 `session-permission-elevation` 的关系：那里管**会话内次级权限上限**，
 * 本模块只管**工具升级重新授权**这一个能力。二者不互相复制规则。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STATE_FILE_NAME = "tool-upgrade-authorization-grants.json";

/** 本能力标识：签发自"工具升级重新授权"记录。 */
export const TOOL_UPGRADE_REAUTHORIZATION_CAPABILITY =
  "tool-package-upgrade-reauthorization";

export interface ToolUpgradeAuthorizationGrant {
  grantIdentifier: string;
  capability: string;
  /** 被授予者（Agent 个体，不可复用）。 */
  grantedToAgentInstanceId: string;
  /** 授予者：`null` 表示由**用户本人**授予（默认唯一持有者）。 */
  grantedByUserIdentifier: string | null;
  grantedByAgentInstanceId: string | null;
  grantedAtIso: string;
  expiresAtIso: string | null;
  revokedAtIso: string | null;
}

export interface ToolUpgradeAuthorizationStoreOptions {
  stateDirectory: string;
  nowIso?: () => string;
}

/** 授权记录的持久化存储（只读写，判定在控制器）。 */
export class ToolUpgradeAuthorizationStore {
  private readonly stateDirectory: string;
  private readonly nowIso: () => string;
  private readonly grantsByAgentInstanceId = new Map<
    string,
    ToolUpgradeAuthorizationGrant[]
  >();
  private isLoaded = false;

  constructor(options: ToolUpgradeAuthorizationStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  private get stateFilePath(): string {
    return path.join(this.stateDirectory, STATE_FILE_NAME);
  }

  async ensureLoaded(): Promise<void> {
    if (this.isLoaded) {
      return;
    }
    this.isLoaded = true;
    let rawText: string;
    try {
      rawText = await fs.readFile(this.stateFilePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(rawText) as { schemaVersion?: unknown; grants?: unknown };
      if (parsed.schemaVersion !== 1) {
        return;
      }
      for (const raw of Array.isArray(parsed.grants) ? parsed.grants : []) {
        const grant = raw as ToolUpgradeAuthorizationGrant;
        const existing = this.grantsByAgentInstanceId.get(grant.grantedToAgentInstanceId) ?? [];
        existing.push(grant);
        this.grantsByAgentInstanceId.set(grant.grantedToAgentInstanceId, existing);
      }
    } catch {
      // 损坏 ⇒ 按空继续（**不伪造授权**）。
    }
  }

  async listGrantsFor(agentInstanceId: string): Promise<ToolUpgradeAuthorizationGrant[]> {
    await this.ensureLoaded();
    return [...(this.grantsByAgentInstanceId.get(agentInstanceId) ?? [])];
  }

  async appendGrant(
    input: Omit<ToolUpgradeAuthorizationGrant, "grantIdentifier" | "grantedAtIso" | "revokedAtIso">,
  ): Promise<ToolUpgradeAuthorizationGrant> {
    await this.ensureLoaded();
    const grant: ToolUpgradeAuthorizationGrant = {
      ...input,
      grantIdentifier: randomUUID(),
      grantedAtIso: this.nowIso(),
      revokedAtIso: null,
    };
    const existing = this.grantsByAgentInstanceId.get(grant.grantedToAgentInstanceId) ?? [];
    existing.push(grant);
    this.grantsByAgentInstanceId.set(grant.grantedToAgentInstanceId, existing);
    await this.persist();
    return grant;
  }

  async revokeGrant(grantIdentifier: string): Promise<boolean> {
    await this.ensureLoaded();
    for (const grants of this.grantsByAgentInstanceId.values()) {
      for (const grant of grants) {
        if (grant.grantIdentifier === grantIdentifier && grant.revokedAtIso === null) {
          grant.revokedAtIso = this.nowIso();
          await this.persist();
          return true;
        }
      }
    }
    return false;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    const grants = [...this.grantsByAgentInstanceId.values()].flat();
    await fs.writeFile(
      this.stateFilePath,
      JSON.stringify({ schemaVersion: 1, grants }, null, 2) + "\n",
      "utf8",
    );
  }
}

export interface ToolUpgradeAuthorizationControllerOptions {
  store: ToolUpgradeAuthorizationStore;
  nowIso?: () => string;
}

export type ToolUpgradeAuthorizationDecision =
  | { isAuthorized: true; authorityKind: "user" | "delegated-agent" }
  | { isAuthorized: false; reason: string };

/**
 * 判定"谁有资格签发工具升级重新授权记录"。
 *
 * 只认**本地可核验**的依据：用户身份由调用方在**认证层**确定后传入
 * （模型自称不是依据）；Agent 必须持有**未撤销、未过期**的能力记录。
 */
export class ToolUpgradeAuthorizationController {
  private readonly store: ToolUpgradeAuthorizationStore;
  private readonly nowIso: () => string;

  constructor(options: ToolUpgradeAuthorizationControllerOptions) {
    this.store = options.store;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * 签发资格判定。
   * - `authenticatedUserIdentifier` 非空 ⇒ 用户本人 ⇒ **默认授权**；
   * - 否则必须有 `issuingAgentInstanceId` 且持有有效能力 ⇒ 授权；
   * - 二者皆无 ⇒ 拒绝（**默认只有用户持有**，Agent 不得自授权）。
   */
  async resolveIssuingAuthority(input: {
    authenticatedUserIdentifier?: string | null;
    issuingAgentInstanceId?: string | null;
  }): Promise<ToolUpgradeAuthorizationDecision> {
    const userIdentifier = input.authenticatedUserIdentifier ?? null;
    if (userIdentifier !== null && userIdentifier !== "") {
      return { isAuthorized: true, authorityKind: "user" };
    }
    const agentInstanceId = input.issuingAgentInstanceId ?? null;
    if (agentInstanceId === null || agentInstanceId === "") {
      return {
        isAuthorized: false,
        reason:
          "无签发资格：本能力**默认只有用户本人**持有；Agent 须先获得显式授权",
      };
    }
    const grants = await this.store.listGrantsFor(agentInstanceId);
    const nowIso = this.nowIso();
    const hasValidGrant = grants.some(
      (grant) =>
        grant.capability === TOOL_UPGRADE_REAUTHORIZATION_CAPABILITY &&
        grant.revokedAtIso === null &&
        (grant.expiresAtIso === null || grant.expiresAtIso > nowIso),
    );
    if (!hasValidGrant) {
      return {
        isAuthorized: false,
        reason:
          "无签发资格：该 Agent 未持有（或已撤销/已过期的）工具升级重新授权能力",
      };
    }
    return { isAuthorized: true, authorityKind: "delegated-agent" };
  }

  /**
   * **向下级逐层分发**：分发者只能授出**自己持有**的能力，且**不得**超过自己的有效期。
   * - 用户 ⇒ 可授出，有效期自定（可为 null 表示不过期）；
   * - Agent ⇒ 必须自身持有有效能力；其授出的有效期**不得晚于**自身（否则等于放大权限）。
   */
  async delegateCapability(input: {
    authenticatedUserIdentifier?: string | null;
    delegatingAgentInstanceId?: string | null;
    grantedToAgentInstanceId: string;
    expiresAtIso?: string | null;
  }): Promise<{ isGranted: boolean; grantIdentifier: string | null; reason: string | null }> {
    const authority = await this.resolveIssuingAuthority({
      authenticatedUserIdentifier: input.authenticatedUserIdentifier ?? null,
      issuingAgentInstanceId: input.delegatingAgentInstanceId ?? null,
    });
    if (!authority.isAuthorized) {
      return { isGranted: false, grantIdentifier: null, reason: authority.reason };
    }
    const requestedExpiry = input.expiresAtIso ?? null;

    if (authority.authorityKind === "delegated-agent") {
      const ownGrants = await this.store.listGrantsFor(String(input.delegatingAgentInstanceId));
      const nowIso = this.nowIso();
      const ownValidGrant = ownGrants.find(
        (grant) =>
          grant.capability === TOOL_UPGRADE_REAUTHORIZATION_CAPABILITY &&
          grant.revokedAtIso === null &&
          (grant.expiresAtIso === null || grant.expiresAtIso > nowIso),
      );
      // resolveIssuingAuthority 刚判定持有，这里再取一次以拿有效期；理论上必然存在。
      if (ownValidGrant === undefined) {
        return {
          isGranted: false,
          grantIdentifier: null,
          reason: "分发者自身能力状态在判定后发生变化，拒绝分发（请重试）",
        };
      }
      // 不得放大：自身有期限时，授出的期限不得为 null（无限期）也不得晚于自身
      if (ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {
          return {
            isGranted: false,
            grantIdentifier: null,
            reason:
              "不得放大权限：分发者自身授权**有期限**，不得授出无期限能力" +
              "（自身到期 " + ownValidGrant.expiresAtIso + "）",
          };
        }
        if (requestedExpiry > ownValidGrant.expiresAtIso) {
          return {
            isGranted: false,
            grantIdentifier: null,
            reason:
              "不得放大权限：授出期限（" + requestedExpiry + "）晚于自身期限（" +
              ownValidGrant.expiresAtIso + "）",
          };
        }
      }
    }

    const grant = await this.store.appendGrant({
      capability: TOOL_UPGRADE_REAUTHORIZATION_CAPABILITY,
      grantedToAgentInstanceId: input.grantedToAgentInstanceId,
      grantedByUserIdentifier:
        authority.authorityKind === "user"
          ? (input.authenticatedUserIdentifier ?? null)
          : null,
      grantedByAgentInstanceId:
        authority.authorityKind === "delegated-agent"
          ? (input.delegatingAgentInstanceId ?? null)
          : null,
      expiresAtIso: requestedExpiry,
    });
    return { isGranted: true, grantIdentifier: grant.grantIdentifier, reason: null };
  }

  async revokeCapability(grantIdentifier: string): Promise<boolean> {
    return await this.store.revokeGrant(grantIdentifier);
  }
}
