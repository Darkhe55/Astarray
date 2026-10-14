/**
 * COMM-01-02（2026-10-28）：**协作请求经唯一直属上级代理转达**。
 *
 * ## 依据（本卡 §2.2，逐条对应）
 *
 * - "最低级执行者**不接收上层全网目录，不选择收件人，不承担转发规划**"；
 * - "涉及三级/四级目标的跨上级句柄改为向**其直属上级的协作收件箱**递交请求，**由上级转达**；
 *   **不允许第二上级直接下令**"；
 * - "转达**保留原始来源、转达者与任务关联，不冒充直属上级原创**"；
 * - "原上级不可用时**暂停并存档**，不让执行者自行找新上级"。
 *
 * ## 本模块做什么（纯本地确定性，不联网、不调用模型）
 *
 * 把"执行者想跟某个三级/四级协作"这件事，翻译成一次**经其唯一直属上级**的转达请求：
 * 收件人由**本地**按已登记归属算出（执行者不选收件人），并携带
 * `originalSourceAgentInstanceId` / `relayedByAgentInstanceId` / `taskIdentifier`，
 * 且**显式标注为转达**（`isRelayedRequest: true`，不得冒充实属上级原创指令）。
 */
import type { AgentCreationRegistry } from "./agent-parent-binding-store.js";

export interface RelayedCollaborationRequest {
  /** 本请求**最终去哪**：目标执行者的**唯一直属上级**的协作收件箱。 */
  relayRecipientAgentInstanceId: string;
  /** 原始来源（发起协作的执行者）—— 转达不得抹掉。 */
  originalSourceAgentInstanceId: string;
  /** 转达者（即目标的唯一直属上级）。 */
  relayedByAgentInstanceId: string;
  /** 被协作的目标执行者。 */
  targetAgentInstanceId: string;
  taskIdentifier: string;
  /** **恒定 true**：这是转达请求，不是直属上级的原创指令。 */
  isRelayedRequest: true;
}

export type RelayedCollaborationOutcome =
  | { isRoutable: true; request: RelayedCollaborationRequest }
  | {
      isRoutable: false;
      /** 可读理由（供如实回报，不静默）。 */
      reason: string;
      /** 需要**暂停并存档**（原上级不可用）时为 true —— 执行者不得自行找新上级。 */
      isPausedForRecovery: boolean;
    };

/**
 * 把一次协作意图解析为**经唯一上级转达**的路由。
 *
 * 判定顺序（fail-closed，每一步都可读回报）：
 * 1. 目标未登记 ⇒ 拒绝（地址完整性：不存在的主体不得被协作）；
 * 2. 目标没有生效归属 ⇒ 拒绝（无唯一上级 ⇒ 无从转达）；
 * 3. 目标自己就是发起者 ⇒ 拒绝（不能"请求与自己协作"而绕开路由）；
 * 4. 有生效归属但其上级**已不可用（已回收）** ⇒ **暂停并存档**
 *    （`isPausedForRecovery: true`），**不得**由执行者另找上级；
 * 5. 否则 ⇒ 收件人 = 该目标的**唯一直属上级**，并带上来源/转达者/任务关联。
 */
export async function routeCollaborationViaUniqueParent(input: {
  registry: AgentCreationRegistry;
  /** 发起协作的执行者（原始来源）。 */
  originalSourceAgentInstanceId: string;
  /** 想协作的目标执行者。 */
  targetAgentInstanceId: string;
  taskIdentifier: string;
}): Promise<RelayedCollaborationOutcome> {
  const targetRecord = await input.registry.getRecord(input.targetAgentInstanceId);
  if (targetRecord === null) {
    return {
      isRoutable: false,
      reason:
        "协作目标 `" + input.targetAgentInstanceId + "` 不是已登记主体（无绑定记录）",
      isPausedForRecovery: false,
    };
  }
  if (targetRecord.recycledAtIso !== null) {
    return {
      isRoutable: false,
      reason: "协作目标 `" + input.targetAgentInstanceId + "` 已被回收，不再是活跃主体",
      isPausedForRecovery: false,
    };
  }
  if (input.targetAgentInstanceId === input.originalSourceAgentInstanceId) {
    return {
      isRoutable: false,
      reason: "协作目标与发起者是同一主体：不得借'自我协作'绕开唯一上级路由",
      isPausedForRecovery: false,
    };
  }
  const directParentAgentInstanceId = targetRecord.createdByAgentInstanceId;
  if (directParentAgentInstanceId === null) {
    return {
      isRoutable: false,
      reason:
        "协作目标 `" + input.targetAgentInstanceId +
        "` 没有唯一直属上级（由用户/控制面直接创建）⇒ 无从转达",
      isPausedForRecovery: false,
    };
  }
  const parentRecord = await input.registry.getRecord(directParentAgentInstanceId);
  if (parentRecord !== null && parentRecord.recycledAtIso !== null) {
    return {
      isRoutable: false,
      isPausedForRecovery: true,
      reason:
        "协作目标的直属上级 `" + directParentAgentInstanceId +
        "` 已不可用 ⇒ **暂停并存档**，等待控制面在安全检查点对账接管；" +
        "执行者**不得自行另找上级**",
    };
  }
  return {
    isRoutable: true,
    request: {
      relayRecipientAgentInstanceId: directParentAgentInstanceId,
      originalSourceAgentInstanceId: input.originalSourceAgentInstanceId,
      relayedByAgentInstanceId: directParentAgentInstanceId,
      targetAgentInstanceId: input.targetAgentInstanceId,
      taskIdentifier: input.taskIdentifier,
      isRelayedRequest: true,
    },
  };
}
