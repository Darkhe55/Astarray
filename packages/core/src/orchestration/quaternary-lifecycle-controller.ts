/**
 * 四级 Agent 生命周期控制器（T08C-06 / ADR-0025 §5）。
 *
 * 三级 Agent 经本地控制面创建四级 Agent：
 * - 四级绑定具体上级三级 agentInstanceId，一次激活只执行上级任务链中
 *   的一个严格子链；
 * - 四级使用新的不可复用 agentInstanceId，独立记忆/缓存/mailbox/
 *   工作存档/worktree；
 * - 四级不能创建第五级；
 * - 四级不能修改上级偏序集、访问兄弟记忆、操作远端项目、写入 mission
 *   集成/目标分支或直接向用户请求权限。
 */
import { DomainError } from "../core/errors.js";
import { quaternaryDelegationSchema } from "./agent-routing-schemas.js";
import type { z } from "zod";

export type QuaternaryLifecycleState =
  | { status: "active"; expiresAtIso: string }
  | { status: "closed"; closedAtIso: string };

export interface QuaternaryLifecycleRecord {
  delegation: z.infer<typeof quaternaryDelegationSchema>;
  lifecycle: QuaternaryLifecycleState;
}

export interface QuaternaryLifecycleControllerOptions {
  /** 创建四级时的身份生成端口（不可复用；默认 UUID 前缀）。 */
  generateQuaternaryAgentInstanceId?: () => string;
  /** 上级三级是否仍活跃（已回收的三级不能再创建四级）。 */
  isTertiaryAgentActive: (tertiaryAgentInstanceId: string) => boolean;
}

export class QuaternaryLifecycleController {
  private readonly recordsById = new Map<string, QuaternaryLifecycleRecord>();
  private readonly generateQuaternaryAgentInstanceId: () => string;
  private readonly isTertiaryAgentActive: (
    tertiaryAgentInstanceId: string,
  ) => boolean;

  constructor(options: QuaternaryLifecycleControllerOptions) {
    this.generateQuaternaryAgentInstanceId =
      options.generateQuaternaryAgentInstanceId ??
      (() => `quaternary-${crypto.randomUUID()}`);
    this.isTertiaryAgentActive = options.isTertiaryAgentActive;
  }

  /**
   * 三级创建四级：校验委派 schema、上级三级必须活跃、四级身份不可复用、
   * 不得创建第五级（本控制器没有创建第五级入口）。
   */
  createQuaternaryAgent(input: {
    delegation: z.input<typeof quaternaryDelegationSchema>;
  }): QuaternaryLifecycleRecord {
    const parsedDelegation = quaternaryDelegationSchema.safeParse(
      input.delegation,
    );
    if (!parsedDelegation.success) {
      throw new DomainError(
        "invalid-task-chain",
        `四级委派声明非法: ${parsedDelegation.error.message}`,
      );
    }
    const delegation = parsedDelegation.data;
    if (!this.isTertiaryAgentActive(delegation.delegatingTertiaryAgentInstanceId)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `上级三级 Agent 不活跃，不能创建四级: ${delegation.delegatingTertiaryAgentInstanceId}`,
      );
    }
    if (this.recordsById.has(delegation.quaternaryAgentInstanceId)) {
      throw new DomainError(
        "invalid-task-chain",
        `四级 Agent 身份不可复用: ${delegation.quaternaryAgentInstanceId}`,
      );
    }
    const record: QuaternaryLifecycleRecord = {
      delegation,
      lifecycle: { status: "active", expiresAtIso: delegation.expiresAtIso },
    };
    this.recordsById.set(delegation.quaternaryAgentInstanceId, record);
    return record;
  }

  /** 读取四级生命周期记录（不存在返回 null）。 */
  getQuaternaryLifecycle(
    quaternaryAgentInstanceId: string,
  ): QuaternaryLifecycleRecord | null {
    return this.recordsById.get(quaternaryAgentInstanceId) ?? null;
  }

  /** 三级收口四级（任务链完成/中断后）；重复收口幂等。 */
  closeQuaternaryAgent(quaternaryAgentInstanceId: string): boolean {
    const record = this.recordsById.get(quaternaryAgentInstanceId);
    if (record === undefined) {
      return false;
    }
    if (record.lifecycle.status === "closed") {
      return false;
    }
    this.recordsById.set(quaternaryAgentInstanceId, {
      ...record,
      lifecycle: { status: "closed", closedAtIso: new Date().toISOString() },
    });
    return true;
  }

  /** 四级是否仍活跃（未关闭且未到期）。 */
  isQuaternaryAgentActive(
    quaternaryAgentInstanceId: string,
    nowUnixMilliseconds: number,
  ): boolean {
    const record = this.recordsById.get(quaternaryAgentInstanceId);
    if (record === undefined) {
      return false;
    }
    if (record.lifecycle.status === "closed") {
      return false;
    }
    return (
      new Date(record.lifecycle.expiresAtIso).getTime() > nowUnixMilliseconds
    );
  }
}