/**
 * 领域文档 zod schema（T00 契约）。
 * 提供 task chain、feedback message、run config 的校验。
 * 结构校验在此层；DAG 环/缺失依赖等图不变量在 T05 TaskGraph。
 */
import { z } from "zod";

import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  MESSAGE_PRIORITY_ORDER,
} from "./types.js";

export const agentModeSchema = z.enum(["ponder", "assist", "devolve"]);

export const taskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
]);

export const toolCategorySchema = z.enum([
  "readonly",
  "restricted",
  "forbidden",
]);

export const toolMutationKindSchema = z.enum([
  "none",
  "create-only",
  "delete-resource",
  "delete-content",
  "overwrite",
  "replace",
  "truncate",
  "delete-protected-backup",
]);

export const toolBackupPolicySchema = z.enum([
  "not-required",
  "automatic-preimage",
  "protected-vault-deletion",
]);

export const toolAuthorizationPolicySchema = z.enum([
  "standard",
  "backup-vault-action",
  "backup-deletion",
]);

const destructiveToolMutationKinds = new Set([
  "delete-resource",
  "delete-content",
  "overwrite",
  "replace",
  "truncate",
]);

export const toolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    category: toolCategorySchema,
    mutationKind: toolMutationKindSchema,
    backupPolicy: toolBackupPolicySchema,
    authorizationPolicy: toolAuthorizationPolicySchema,
    supportedTaskTypes: z.array(z.string().min(1)).min(1),
    inputSchema: z.unknown(),
  })
  .superRefine((descriptor, context) => {
    if (
      destructiveToolMutationKinds.has(descriptor.mutationKind) &&
      descriptor.backupPolicy !== "automatic-preimage"
    ) {
      context.addIssue({
        code: "custom",
        path: ["backupPolicy"],
        message: "破坏性工具必须声明由工具自身提供自动备份",
      });
    }
    if (
      descriptor.mutationKind === "delete-protected-backup" &&
      descriptor.backupPolicy !== "protected-vault-deletion"
    ) {
      context.addIssue({
        code: "custom",
        path: ["backupPolicy"],
        message: "删除受保护备份必须使用独立特权删除策略",
      });
    }
    if (
      descriptor.mutationKind === "delete-protected-backup" &&
      descriptor.authorizationPolicy !== "backup-deletion"
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorizationPolicy"],
        message: "删除受保护备份必须使用专用授权策略",
      });
    }
  });

export const backupVaultActionSchema = z.enum(["list", "read", "restore"]);

export const backupDeletionAuthorizationRequestSchema = z.object({
  authorizationRequestId: z.uuid(),
  requestingAgentInstanceId: z.string().min(1),
  toolCallId: z.string().min(1),
  backupIdentifiers: z.array(z.string().min(1)).min(1),
  warningText: z.string().min(1),
  createdAtIso: z.iso.datetime(),
  canRememberForSession: z.literal(false),
});

export const backupDeletionAuthorizationDecisionSchema = z.object({
  authorizationRequestId: z.uuid(),
  requestingAgentInstanceId: z.string().min(1),
  decision: z.enum(["allow-once", "deny"]),
  authorizedBackupIdentifiers: z.array(z.string().min(1)).min(1),
  expectedVaultRevision: z.number().int().min(1),
  expiresAtIso: z.iso.datetime(),
});

export const taskDependencyNodeSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  taskType: z.string().min(1),
  toolNames: z.array(z.string().min(1)),
  assignedAgentId: z.string().min(1).nullable(),
  status: taskStatusSchema,
  resultLocation: z.string().min(1).nullable(),
});

export const taskChainSchema = z.object({
  schemaVersion: z.number().int().min(1),
  missionId: z.string().min(1),
  revision: z.number().int().min(1),
  updatedAtIso: z.iso.datetime(),
  tasks: z.array(taskDependencyNodeSchema).min(1),
});

export type TaskChainDocumentSchemaInput = z.input<typeof taskChainSchema>;

export const messagePrioritySchema = z.enum(MESSAGE_PRIORITY_ORDER);

const successPayloadSchema = z.object({
  kind: z.literal("success"),
  summary: z.string().min(1),
});

const failurePayloadSchema = z.object({
  kind: z.literal("failure"),
  failureReason: z.string().min(1),
  currentStateSummary: z.string().min(1),
});

const permissionAskPayloadSchema = z.object({
  kind: z.literal("permission-ask"),
  toolName: z.string().min(1),
  argumentsJson: z.string().min(1),
  explanation: z.string().min(1),
});

const backupDeletionWarningPayloadSchema = z.object({
  kind: z.literal("backup-deletion-warning"),
  authorizationRequestId: z.uuid(),
  requestingAgentInstanceId: z.string().min(1),
  backupIdentifiers: z.array(z.string().min(1)).min(1),
  warningText: z.string().min(1),
  canRememberForSession: z.literal(false),
});

const ambiguousPayloadSchema = z.object({
  kind: z.literal("ambiguous"),
  unclearPoints: z.array(z.string().min(1)).min(1),
  requestedInformation: z.string().min(1),
});

const instructionPayloadSchema = z.object({
  kind: z.literal("instruction"),
  instructionText: z.string().min(1),
});

export const feedbackMessagePayloadSchema = z.discriminatedUnion("kind", [
  successPayloadSchema,
  failurePayloadSchema,
  permissionAskPayloadSchema,
  backupDeletionWarningPayloadSchema,
  ambiguousPayloadSchema,
  instructionPayloadSchema,
]);

export const feedbackMessageSourceSchema = z.discriminatedUnion(
  "sourceType",
  [
    z.object({
      sourceType: z.literal("user"),
      sourceIdentifier: z.string().min(1),
    }),
    z.object({
      sourceType: z.literal("agent"),
      agentInstanceId: z.string().min(1),
      agentRole: z.enum(["main", "secondary", "tertiary"]),
    }),
    z.object({
      sourceType: z.literal("system"),
      sourceIdentifier: z.string().min(1),
      componentName: z.string().min(1),
    }),
  ],
);

export const agentWorkArchiveEntrySchema = z.object({
  archiveEntryId: z.string().min(1),
  recordedAtIso: z.iso.datetime(),
  taskId: z.string().min(1).nullable(),
  entryType: z.enum([
    "assignment",
    "progress",
    "decision",
    "result",
    "failure",
    "handoff",
  ]),
  summary: z.string().min(1),
  artifactReferences: z.array(z.string().min(1)),
});

export const agentWorkArchiveDocumentSchema = z.object({
  schemaVersion: z.number().int().min(1),
  missionId: z.string().min(1),
  agentInstanceId: z.string().min(1),
  agentRole: z.enum(["secondary", "tertiary"]),
  revision: z.number().int().min(1),
  updatedAtIso: z.iso.datetime(),
  entries: z.array(agentWorkArchiveEntrySchema),
});

export const agentWorkArchiveAttachmentSchema = z.object({
  archiveOwnerAgentInstanceId: z.string().min(1),
  archiveRevision: z.number().int().min(1),
  selectedArchiveEntries: z.array(agentWorkArchiveEntrySchema).min(1),
  selectionReason: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const PRIORITY_OF_KIND: Record<string, string> = {
  success: "success",
  failure: "failure",
  "permission-ask": "permission-ask",
  "backup-deletion-warning": "backup-deletion-warning",
  ambiguous: "ambiguous",
  instruction: "instruction",
};

export const feedbackMessageSchema = z
  .object({
    protocolVersion: z.number().int().min(1),
    messageId: z.uuid(),
    source: feedbackMessageSourceSchema,
    recipientId: z.string().min(1),
    priority: messagePrioritySchema,
    createdAtIso: z.iso.datetime(),
    idempotencyKey: z.string().min(1),
    payload: feedbackMessagePayloadSchema,
  })
  .superRefine((message, context) => {
    const expectedPriority = PRIORITY_OF_KIND[message.payload.kind];
    if (message.priority !== expectedPriority) {
      context.addIssue({
        code: "custom",
        message: `priority ${message.priority} 与 payload kind ${message.payload.kind} 不一致，应为 ${expectedPriority}`,
      });
    }
  });

export const feedbackAckSchema = z.object({
  messageId: z.uuid(),
  deliveredAtIso: z.iso.datetime(),
});

export const runConfigSchema = z.object({
  mode: agentModeSchema.default("assist"),
  concurrency: z
    .number()
    .int()
    .min(MIN_CONCURRENCY)
    .max(MAX_CONCURRENCY)
    .default(4),
  toolFailureThreshold: z.number().int().min(1).default(3),
  runtime: z.enum(["mock", "openai-compatible"]).default("mock"),
  missionId: z.string().min(1).nullable().default(null),
});

export type RunConfig = z.infer<typeof runConfigSchema>;
export type FeedbackMessageSchemaOutput = z.infer<
  typeof feedbackMessageSchema
>;
