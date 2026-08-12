/**
 * 工具策略包装层（T06，冻结决策：权限在工具实际执行前检查）。
 * 执行链路：注册表存在性 → Worker 子集边界 → 权限裁决（allow/ask/deny）→ 实际执行。
 * ask：抛 permission-ask-pending（由上层转用户裁决）；
 * deny：硬拒绝 + 审计事件 + 抛 tool-permission-denied。
 */
import { DomainError } from "../core/errors.js";
import type { PermissionDecider } from "../core/permission-policy.js";
import type { ToolBackupServicePort } from "../core/types.js";
import type {
  PermissionResult,
  ToolCallResult,
  ToolDescriptor,
  ToolPort,
} from "../core/types.js";
import type { ToolRegistry } from "./registry.js";
import type { WorkspaceBoundary } from "./workspace-boundary.js";
import type { BackupDeletionAuthorizationController, BackupVault } from "./backup-vault.js";
import type { ProtectedStoragePolicy } from "./protected-storage-policy.js";
import {
  executeBuiltinTool,
  BUILTIN_TOOL_DESCRIPTORS,
} from "./builtins.js";

export interface ToolAuditEvent {
  recordedAtIso: string;
  toolName: string;
  decision: "allow" | "ask" | "deny";
  reason: string;
  mode: "ponder" | "assist" | "devolve";
}

export interface PolicyWrapperOptions {
  permissionDecider: PermissionDecider;
  registry: ToolRegistry;
  workspaceBoundary: WorkspaceBoundary;
  temporaryDirectoryPath: string;
  /** null 表示不限（Devolve/次级 Agent）；非空表示 Worker 的工具子集。 */
  workerAllowedToolNames: Set<string> | null;
  nowUnixSeconds: () => number;
  getCurrentMode: () => "ponder" | "assist" | "devolve";
  auditSink?: (event: ToolAuditEvent) => void;
  /** 执行破坏性工具时自动备份所需；自动备份过程不经过模型。 */
  backupServicePort?: ToolBackupServicePort | null;
  vault?: BackupVault | null;
  deletionController?: BackupDeletionAuthorizationController | null;
  requestingAgentInstanceId?: string;
  /** AR-01：受保护存储策略（普通工具执行前强制检查，必填）。 */
  protectedStoragePolicy: ProtectedStoragePolicy;
}

export class PolicyWrapper implements ToolPort {
  constructor(private readonly options: PolicyWrapperOptions) {}

  async execute(
    toolName: string,
    argumentsJson: string,
    callId: string,
    cancellationSignal: AbortSignal,
  ): Promise<ToolCallResult> {
    if (cancellationSignal.aborted) {
      return {
        kind: "error",
        callId,
        errorCode: "provider-cancelled",
        errorMessage: "工具调用被取消",
        isIdempotencyConfirmed: true,
      };
    }
    try {
      const descriptor = this.assertRegistered(toolName);
      this.assertWithinWorkerSubset(toolName);
      const decision = this.decidePermission(descriptor, argumentsJson);
      if (decision === "ask") {
        this.recordAudit(descriptor, "ask", "受限工具需用户裁决");
        throw new DomainError(
          "permission-ask-pending",
          `工具 ${toolName} 需要用户裁决`,
        );
      }
      if (decision === "deny") {
        this.recordAudit(descriptor, "deny", "权限策略拒绝（Ponder 或 forbidden）");
        throw new DomainError(
          "tool-permission-denied",
          `权限策略拒绝工具调用: ${toolName}`,
        );
      }
      this.recordAudit(descriptor, "allow", "权限允许");
      return await this.executeWithRetryOnAbort(
        toolName,
        argumentsJson,
        callId,
      );
    } catch (error) {
      if (error instanceof DomainError) {
        return {
          kind: "error",
          callId,
          errorCode: error.errorCode,
          errorMessage: error.message,
          isIdempotencyConfirmed: false,
        };
      }
      return {
        kind: "error",
        callId,
        errorCode: "unknown",
        errorMessage: (error as Error).message,
        isIdempotencyConfirmed: false,
      };
    }
  }

  private assertRegistered(toolName: string): ToolDescriptor {
    const descriptor = this.options.registry.getDescriptor(toolName);
    if (descriptor === undefined) {
      this.recordAudit(
        { name: toolName, summary: "未注册", category: "forbidden" },
        "deny",
        "工具未注册（默认不开放 shell/删除/安装/发布/付款）",
      );
      throw new DomainError("tool-not-found", `工具未注册: ${toolName}`);
    }
    return descriptor;
  }

  private assertWithinWorkerSubset(toolName: string): void {
    if (
      this.options.workerAllowedToolNames !== null &&
      !this.options.workerAllowedToolNames.has(toolName)
    ) {
      throw new DomainError(
        "tool-permission-denied",
        `工具不在本 Worker 授权子集内: ${toolName}`,
      );
    }
  }

  private decidePermission(
    descriptor: ToolDescriptor,
    argumentsJson: string,
  ): PermissionResult {
    return this.options.permissionDecider.decide(
      {
        toolName: descriptor.name,
        category: descriptor.category,
        argumentsJson,
      },
      this.options.nowUnixSeconds(),
    );
  }

  private recordAudit(
    descriptor: Pick<ToolDescriptor, "name" | "summary" | "category">,
    decision: ToolAuditEvent["decision"],
    reason: string,
  ): void {
    this.options.auditSink?.({
      recordedAtIso: new Date().toISOString(),
      toolName: descriptor.name,
      decision,
      reason,
      mode: this.getCurrentModeLabel(),
    });
  }

  private getCurrentModeLabel(): "ponder" | "assist" | "devolve" {
    return this.options.getCurrentMode();
  }

  private async executeWithRetryOnAbort(
    toolName: string,
    argumentsJson: string,
    callId: string,
  ): Promise<ToolCallResult> {
    const builtinDescriptor = BUILTIN_TOOL_DESCRIPTORS.find(
      (descriptor) => descriptor.name === toolName,
    );
    if (builtinDescriptor !== undefined) {
      try {
        const result = await executeBuiltinTool(toolName, argumentsJson, {
          workspaceBoundary: this.options.workspaceBoundary,
          temporaryDirectoryPath: this.options.temporaryDirectoryPath,
          requestingAgentInstanceId:
            this.options.requestingAgentInstanceId ?? "unknown-agent",
          backupServicePort: this.options.backupServicePort ?? null,
          vault: this.options.vault ?? null,
          deletionController: this.options.deletionController ?? null,
          protectedStoragePolicy: this.options.protectedStoragePolicy,
        });
        return {
          kind: "success",
          callId,
          outputText: result.outputText,
          isSideEffectFree: result.isSideEffectFree,
        };
      } catch (error) {
        return {
          kind: "error",
          callId,
          errorCode:
            error instanceof DomainError ? error.errorCode : "tool-execution-failed",
          errorMessage: (error as Error).message,
          isIdempotencyConfirmed: false,
        };
      }
    }
    return {
      kind: "error",
      callId,
      errorCode: "tool-execution-failed",
      errorMessage: `工具 ${toolName} 未提供实现`,
      isIdempotencyConfirmed: false,
    };
  }
}
