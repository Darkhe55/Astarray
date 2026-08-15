/**
 * 主 Agent 永久只读投影与次级 Agent 会话控制面（T06G / ADR-0021）。
 *
 * MainAgentReadonlyToolProjection：无论当前引用 Assist、Devolve、自定义
 * profile 或存在任何临时提升，主 Agent 模型工具投影始终只包含读取类专用
 * 工具；主 Agent 不获得写入、进程、安装、外部副作用、Agent 管理、权限
 * 管理或配置导出工具。profile、临时覆盖和三级 Agent 分配均不能扩大主
 * Agent 权限。
 *
 * SecondaryAgentSessionController：认证本地控制面接收用户任务，创建不可
 * 复用的次级 agentInstanceId 并绑定会话、基础 profile 引用与权限快照；
 * 该控制器不是主 Agent 模型可调用的工具。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { PermissionProfileReference } from "./permission-profile-store.js";

/** 主 Agent 只读白名单（固定；不随模式/profile/提升变化）。 */
export const MAIN_AGENT_READONLY_TOOL_NAMES = [
  "readFile",
  "listDirectory",
  "searchProjectText",
  "taskSequenceStatus",
  "gitReadonlyView",
  "factVerification",
] as const satisfies readonly string[];

export class MainAgentReadonlyToolProjection {
  /** 主 Agent 可见工具（只读白名单 + 一句话摘要；无 schema 细节外的扩展）。 */
  projectTools(toolNames: string[]): string[] {
    return toolNames.filter((toolName) =>
      (MAIN_AGENT_READONLY_TOOL_NAMES as readonly string[]).includes(toolName),
    );
  }

  /** 任意 profile/提升状态下主 Agent 是否可调用某工具。 */
  isMainAgentToolAllowed(toolName: string): boolean {
    return (MAIN_AGENT_READONLY_TOOL_NAMES as readonly string[]).includes(
      toolName,
    );
  }
}

/** 次级 Agent 会话绑定（不可复用实例 ID + 基础权限引用）。 */
export interface SecondaryAgentSessionBinding {
  sessionId: string;
  agentInstanceId: string;
  baseProfileReference: PermissionProfileReference;
  baseProfileRevision: number;
  catalogVersion: number;
  createdAtIso: string;
  /** 会话权限 revision（提升/撤销/关闭变化时递增）。 */
  sessionPermissionRevision: number;
}

export interface SecondaryAgentSessionControllerOptions {
  /** 生成唯一实例 ID（默认 UUID；测试可注入）。 */
  generateAgentInstanceId?: () => string;
}

export class SecondaryAgentSessionController {
  private readonly generateAgentInstanceId: () => string;

  constructor(options: SecondaryAgentSessionControllerOptions = {}) {
    this.generateAgentInstanceId =
      options.generateAgentInstanceId ?? (() => `secondary-${randomUUID()}`);
  }

  /**
   * 创建次级 Agent 会话绑定。这是可信本地控制面入口；
   * 不接受模型自由填写的授权决定。
   */
  createSecondaryAgentBinding(input: {
    sessionId: string;
    baseProfileReference: PermissionProfileReference;
    baseProfileRevision: number;
    catalogVersion: number;
  }): SecondaryAgentSessionBinding {
    const binding: SecondaryAgentSessionBinding = {
      sessionId: input.sessionId,
      agentInstanceId: this.generateAgentInstanceId(),
      baseProfileReference: input.baseProfileReference,
      baseProfileRevision: input.baseProfileRevision,
      catalogVersion: input.catalogVersion,
      createdAtIso: new Date().toISOString(),
      sessionPermissionRevision: 0,
    };
    if (binding.agentInstanceId === "") {
      throw new DomainError(
        "invalid-task-chain",
        "次级 Agent 实例 ID 不能为空",
      );
    }
    return binding;
  }
}
