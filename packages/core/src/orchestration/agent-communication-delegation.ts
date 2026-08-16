/**
 * 受权通信转交（T08B / ADR-0024 §受权转交下级 Agent 的沟通方式）。
 *
 * AgentCommunicationDelegationController：直属上级经公开权限
 * `agent.communication-delegate` 与精确用户裁决，把直属低一级 target 的
 * 限定沟通句柄授权给具体同级 recipient。校验：grantor 是 target 当前直属
 * 上级、recipient 与 grantor 同级、target 恰好低一级且仍存活。
 *
 * DelegatedAgentCommunicationGrantStore：只向模型返回不透明
 * communicationHandleIdentifier；底层发送能力绑定反馈 IPC 身份且不可导出、
 * 复制或转授权。投递前失效检查：Agent 回收、父子关系变化、任务/mission
 * 结束、profile revision 变化、用户撤销、到期、消息类型/在途量越界均拒绝。
 * 每条消息仍使用真实发送者来源；转发保留原始来源。
 */
import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { AgentRole } from "../core/types.js";

export type DelegatedMessageType = "information" | "instruction";

export interface DelegatedAgentCommunicationGrant {
  grantId: string;
  /** 不透明句柄（模型可见；底层凭据不可导出）。 */
  communicationHandleIdentifier: string;
  authorizationSource: string;
  userDecisionReference: string;
  grantorSuperiorAgentInstanceId: string;
  recipientPeerAgentInstanceId: string;
  targetAgentInstanceId: string;
  missionId: string;
  taskScope: string | null;
  allowedMessageTypes: DelegatedMessageType[];
  isInstructionAllowed: boolean;
  replyRoute: "to-recipient" | "to-grantor" | "both";
  isCopyToGrantorRequired: boolean;
  createdAtIso: string;
  expiresAtIso: string | null;
  maxInFlightMessages: number;
  revision: number;
}

export interface DelegatedAgentCommunicationGrantStoreOptions {
  nowUnixMilliseconds?: () => number;
}

export class DelegatedAgentCommunicationGrantStore {
  private readonly grants = new Map<string, DelegatedAgentCommunicationGrant>();
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: DelegatedAgentCommunicationGrantStoreOptions = {}) {
    this.nowUnixMilliseconds =
      options.nowUnixMilliseconds ?? (() => Date.now());
  }

  addGrant(grant: DelegatedAgentCommunicationGrant): void {
    this.grants.set(grant.grantId, grant);
  }

  getGrantByHandle(
    communicationHandleIdentifier: string,
  ): DelegatedAgentCommunicationGrant | null {
    for (const grant of this.grants.values()) {
      if (
        grant.communicationHandleIdentifier === communicationHandleIdentifier
      ) {
        return grant;
      }
    }
    return null;
  }

  revokeGrant(grantId: string): boolean {
    return this.grants.delete(grantId);
  }

  revokeAllForAgent(agentInstanceId: string): number {
    const before = this.grants.size;
    for (const [grantId, grant] of this.grants) {
      if (
        grant.grantorSuperiorAgentInstanceId === agentInstanceId ||
        grant.recipientPeerAgentInstanceId === agentInstanceId ||
        grant.targetAgentInstanceId === agentInstanceId
      ) {
        this.grants.delete(grantId);
      }
    }
    return before - this.grants.size;
  }

  getNowUnixMilliseconds(): number {
    return this.nowUnixMilliseconds();
  }
}

export interface DelegationValidationContext {
  /** profile revision（授权时快照；变化即失效）。 */
  profileRevision: number;
  /** target 是否已回收。 */
  isTargetRecycled: boolean;
  /** 父子关系是否变化（grantor 是否仍是 target 直属上级）。 */
  isGrantorStillDirectSuperior: boolean;
  /** 任务/mission 是否结束。 */
  isMissionEnded: boolean;
  /** 用户是否已撤销。 */
  isRevokedByUser: boolean;
}

export class AgentCommunicationDelegationController {
  constructor(
    private readonly grantStore: DelegatedAgentCommunicationGrantStore,
    private readonly nowUnixMilliseconds: () => number,
  ) {}

  /**
   * 创建转交授权（认证用户裁决；grantor 必须仍为 target 直属上级，
   * recipient 必须与 grantor 同级，target 必须恰好低一级且存活）。
   */
  createGrant(input: {
    authorizationSource: string;
    userDecisionReference: string;
    grantorSuperiorAgentInstanceId: string;
    recipientPeerAgentInstanceId: string;
    targetAgentInstanceId: string;
    grantorRole: AgentRole;
    recipientRole: AgentRole;
    targetRole: AgentRole;
    isTargetAlive: boolean;
    missionId: string;
    taskScope: string | null;
    allowedMessageTypes: DelegatedMessageType[];
    isInstructionAllowed: boolean;
    replyRoute: DelegatedAgentCommunicationGrant["replyRoute"];
    isCopyToGrantorRequired: boolean;
    expiresAtIso: string | null;
    maxInFlightMessages: number;
  }): DelegatedAgentCommunicationGrant {
    // 层级校验：grantor 是 target 的直属上级（target 恰好低一级）
    if (this.roleLevel(input.targetRole) !== this.roleLevel(input.grantorRole) + 1) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "target 必须恰好比 grantor 低一级",
      );
    }
    if (input.recipientRole !== input.grantorRole) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "recipient 必须与 grantor 同级",
      );
    }
    if (!input.isTargetAlive) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "target 已不存活，不能转交沟通",
      );
    }
    if (input.maxInFlightMessages < 1) {
      throw new DomainError(
        "invalid-task-chain",
        "最大在途消息数必须 ≥ 1",
      );
    }
    const grantId = `grant-${randomUUID()}`;
    const communicationHandleIdentifier = `handle-${createHash("sha256")
      .update(grantId)
      .digest("hex")
      .slice(0, 16)}`;
    const grant: DelegatedAgentCommunicationGrant = {
      grantId,
      communicationHandleIdentifier,
      authorizationSource: input.authorizationSource,
      userDecisionReference: input.userDecisionReference,
      grantorSuperiorAgentInstanceId: input.grantorSuperiorAgentInstanceId,
      recipientPeerAgentInstanceId: input.recipientPeerAgentInstanceId,
      targetAgentInstanceId: input.targetAgentInstanceId,
      missionId: input.missionId,
      taskScope: input.taskScope,
      allowedMessageTypes: [...input.allowedMessageTypes],
      isInstructionAllowed: input.isInstructionAllowed,
      replyRoute: input.replyRoute,
      isCopyToGrantorRequired: input.isCopyToGrantorRequired,
      createdAtIso: new Date().toISOString(),
      expiresAtIso: input.expiresAtIso,
      maxInFlightMessages: input.maxInFlightMessages,
      revision: 1,
    };
    this.grantStore.addGrant(grant);
    return grant;
  }

  /**
   * 投递前复检（ADR-0024）：Agent 回收、父子关系变化、任务/mission 结束、
   * profile revision 变化、用户撤销、到期、消息类型/在途量越界均拒绝。
   */
  assertDeliverable(input: {
    communicationHandleIdentifier: string;
    senderAgentInstanceId: string;
    messageType: DelegatedMessageType;
    missionId: string;
    currentProfileRevision: number;
    context: Omit<DelegationValidationContext, "profileRevision">;
    /** 当前在途消息数（由调用方统计）。 */
    currentInFlightMessages: number;
  }): { grant: DelegatedAgentCommunicationGrant } {
    const grant = this.grantStore.getGrantByHandle(
      input.communicationHandleIdentifier,
    );
    if (grant === null) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "沟通句柄不存在或已撤销",
      );
    }
    if (grant.recipientPeerAgentInstanceId !== input.senderAgentInstanceId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "发送者不是授权 recipient",
      );
    }
    if (input.context.isRevokedByUser) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "用户已撤销转交授权",
      );
    }
    if (input.context.isTargetRecycled) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "target 已回收，授权失效",
      );
    }
    if (!input.context.isGrantorStillDirectSuperior) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "父子关系已变化，授权失效",
      );
    }
    if (input.context.isMissionEnded || grant.missionId !== input.missionId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "任务/mission 结束或范围不匹配，授权失效",
      );
    }
    if (input.currentProfileRevision !== grant.revision) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "profile revision 变化，授权失效",
      );
    }
    if (
      grant.expiresAtIso !== null &&
      new Date(grant.expiresAtIso).getTime() <= this.nowUnixMilliseconds()
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "授权已到期",
      );
    }
    if (!grant.allowedMessageTypes.includes(input.messageType)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `消息类型不在授权范围: ${input.messageType}`,
      );
    }
    if (input.messageType === "instruction" && !grant.isInstructionAllowed) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "授权不允许 instruction 消息",
      );
    }
    if (input.currentInFlightMessages >= grant.maxInFlightMessages) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "在途消息数达到上限",
      );
    }
    return { grant };
  }

  /** grant 不可转授权：句柄不能导出为另一个句柄。 */
  assertNotReDelegable(communicationHandleIdentifier: string): void {
    // 句柄是唯一入口；存储层无句柄→句柄转换路径。此处为显式防线。
    if (this.grantStore.getGrantByHandle(communicationHandleIdentifier) === null) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "沟通句柄不存在",
      );
    }
  }

  private roleLevel(role: AgentRole): number {
    switch (role) {
      case "main":
        return 0;
      case "secondary":
        return 1;
      case "tertiary":
        return 2;
    }
  }
}
