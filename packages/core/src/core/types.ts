/**
 * 核心领域类型（T00 冻结契约）。
 * 命名遵循 IMPLEMENTATION_PLAN.md §3：含义完整、布尔加前缀、时间量带单位。
 * 本文件只定义契约，不包含行为实现（状态机、权限策略、DAG 等见后续任务）。
 */
import type { AgentEvent } from "./events.js";

/** 三种运行模式，信任梯度：ponder < assist < devolve。 */
export type AgentMode = "ponder" | "assist" | "devolve";

/** Agent 运行状态。idle 是反馈工具唯一允许投递普通消息的状态。 */
export type AgentStatus =
  | "idle"
  | "busy"
  | "blocked"
  | "awaiting-user-authorization";

/** 任务状态迁移：pending → running → done | failed；blocked 用于等待人工裁决或非幂等不确定。 */
export type TaskStatus = "pending" | "running" | "blocked" | "done" | "failed";

/** 权限判定结果。ask 表示需要用户裁决（Assist 门禁）。 */
export type PermissionResult = "allow" | "ask" | "deny";

/** 工具风险类别，决定门禁行为。 */
export type ToolCategory = "readonly" | "restricted" | "forbidden";

/** 工具对目标内容的变更类型；除 none/create-only 外均属于破坏性变更。 */
export type ToolMutationKind =
  | "none"
  | "create-only"
  | "delete-resource"
  | "delete-content"
  | "overwrite"
  | "replace"
  | "truncate"
  | "delete-protected-backup";

/** 工具处理变更前备份的方式。删除受保护备份是唯一无 pre-image 的特权例外。 */
export type ToolBackupPolicy =
  | "not-required"
  | "automatic-preimage"
  | "protected-vault-deletion";

/** 标准门禁之外的参数级授权策略。 */
export type ToolAuthorizationPolicy =
  | "standard"
  | "backup-vault-action"
  | "backup-deletion";

export const DESTRUCTIVE_TOOL_MUTATION_KINDS = [
  "delete-resource",
  "delete-content",
  "overwrite",
  "replace",
  "truncate",
  "delete-protected-backup",
] as const satisfies readonly ToolMutationKind[];

export const TOOL_MUTATION_KINDS_REQUIRING_AUTOMATIC_BACKUP = [
  "delete-resource",
  "delete-content",
  "overwrite",
  "replace",
  "truncate",
] as const satisfies readonly ToolMutationKind[];

/**
 * 消息优先级，跨类型比较用（高 → 低）。
 * 同优先级内严格 FIFO（ADR-0003）；permission-ask 由 ADR-0007 增补。
 */
export const MESSAGE_PRIORITY_ORDER = [
  "instruction",
  "backup-deletion-warning",
  "failure",
  "permission-ask",
  "ambiguous",
  "success",
] as const;
export type MessagePriority = (typeof MESSAGE_PRIORITY_ORDER)[number];

/** Agent 层级。agentInstanceId 用于标识该层级中的具体 Agent 个体。 */
export type AgentRole = "main" | "secondary" | "tertiary";

/** 反馈进程 IPC 协议版本。版本不兼容时必须拒绝通信（T04）。 */
export const FEEDBACK_PROTOCOL_VERSION = 1;

/** 冻结决策常数（对应 IMPLEMENTATION_PLAN.md §2）。 */
export const DEFAULT_TOOL_FAILURE_THRESHOLD = 3;
export const DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS = 10_800;
export const DEFAULT_BACKOFF_RESET_SECONDS = 2;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 32;
export const ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES = 10;
export const TASK_CHAIN_SCHEMA_VERSION = 1;
export const AGENT_WORK_ARCHIVE_SCHEMA_VERSION = 1;
export const DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION = 1;
export const AGENT_TASK_SEQUENCE_SCHEMA_VERSION = 1;
export const GIT_RECOVERY_POINT_SCHEMA_VERSION = 1;

export const AGENT_MODE_DISPLAY_NAMES = {
  ponder: "思索模式",
  assist: "协同模式",
  devolve: "放权模式",
} as const satisfies Record<AgentMode, string>;

export const BACKUP_DELETION_AUDIT_PRIORITY = "high" as const;

/**
 * 工具描述。主 Agent 只获得 name + summary（预览）；
 * 次级 Agent 获得完整描述；三级 Agent 只获得任务所需子集。
 */
export interface ToolDescriptor {
  name: string;
  summary: string;
  category: ToolCategory;
  mutationKind: ToolMutationKind;
  backupPolicy: ToolBackupPolicy;
  authorizationPolicy: ToolAuthorizationPolicy;
  supportedTaskTypes: string[];
  /** 工具入参 schema（zod/JSON schema 形态），由 runtime 注入给执行层。 */
  inputSchema: unknown;
}

/**
 * 工具内部的备份凭证。该结构只能在工具/恢复子系统内部流转，
 * 不得放入 AgentRunInput、工具 outputText、提示词、TUI 对话或反馈消息。
 */
export interface ToolBackupReceipt {
  backupIdentifier: string;
  createdAtIso: string;
  mutationKind: (typeof TOOL_MUTATION_KINDS_REQUIRING_AUTOMATIC_BACKUP)[number];
  targetFingerprintBeforeMutation: string;
  backupContentHash: string;
  restoreCapabilityIdentifier: string;
}

/** 受控备份库工具支持的操作；删除由独立特权入口处理。 */
export type BackupVaultAction = "list" | "read" | "restore";

/**
 * 备份公开摘要（AR-01 DTO）。
 * 只包含逻辑元数据；不得包含对象哈希、恢复能力标识或物理存储路径。
 */
export interface BackupSummary {
  backupIdentifier: string;
  createdAtIso: string;
  toolName: string;
  /** 备份所保护的逻辑目标路径（工作区语义，非保管库物理路径）。 */
  targetPath: string;
  mutationKind: (typeof TOOL_MUTATION_KINDS_REQUIRING_AUTOMATIC_BACKUP)[number];
  status: "active" | "quarantined" | "purged";
  quarantinedAtIso: string | null;
  purgedAtIso: string | null;
}

/**
 * 受控读取结果（AR-01）：显式编码与媒体类型。
 * 文本内容以 utf-8 原文返回；二进制内容以 base64 返回，不做无条件 UTF-8 解码损坏。
 */
export interface ReadBackupResult {
  encoding: "utf-8" | "base64";
  mediaType: string;
  content: string;
}

/** 协同模式删除备份时发给用户的单次、精确授权请求。 */
export interface BackupDeletionAuthorizationRequest {
  authorizationRequestId: string;
  requestingAgentInstanceId: string;
  toolCallId: string;
  backupIdentifiers: string[];
  warningText: string;
  createdAtIso: string;
  /** 必须为 false：删除备份授权禁止会话级记忆。 */
  canRememberForSession: false;
}

/** 用户通过专用控制通道作出的单次授权决定。 */
export interface BackupDeletionAuthorizationDecision {
  authorizationRequestId: string;
  requestingAgentInstanceId: string;
  decision: "allow-once" | "deny";
  authorizedBackupIdentifiers: string[];
  expectedVaultRevision: number;
  expiresAtIso: string;
}

/** 删除备份的不可删除审计记录；high 表示在审计视图中优先展示。 */
export interface BackupDeletionAuditRecord {
  auditRecordId: string;
  recordedAtIso: string;
  requestingAgentInstanceId: string;
  mode: AgentMode;
  backupIdentifiers: string[];
  outcome: "authorized" | "rejected" | "quarantined" | "purged" | "failed";
  reviewPriority: typeof BACKUP_DELETION_AUDIT_PRIORITY;
  previousRecordHash: string | null;
  recordHash: string;
}

/** 专门传递删除备份授权，不走只向 idle Agent 投递的普通消息队列。 */
export interface BackupDeletionAuthorizationControlPort {
  requestAuthorization(
    request: BackupDeletionAuthorizationRequest,
  ): Promise<BackupDeletionAuthorizationDecision>;
}

/** 工具在执行破坏性变更前调用的本地备份端口，不对模型暴露。 */
export interface ToolBackupServicePort {
  createPreMutationBackup(input: {
    toolName: string;
    targetPath: string;
    mutationKind: (typeof TOOL_MUTATION_KINDS_REQUIRING_AUTOMATIC_BACKUP)[number];
  }): Promise<ToolBackupReceipt>;
  /**
   * TOCTOU 闭环校验：确认目标在备份后未被第三方修改。
   * 变更工具写入前必须调用；不一致时中止写入。
   */
  verifyTargetUnchanged(
    targetPath: string,
    expectedFingerprint: string,
  ): Promise<boolean>;
}

/** 主 Agent 得到的工具预览：只有名称和一句话摘要，不含用法。 */
export interface ToolDescriptorPreview {
  name: string;
  summary: string;
}

export type TaskDependencyNodeStatus = TaskStatus;

export interface TaskDependencyNode {
  id: string;
  description: string;
  dependsOn: string[];
  taskType: string;
  toolNames: string[];
  assignedAgentId: string | null;
  status: TaskDependencyNodeStatus;
  resultLocation: string | null;
}

/**
 * 版本化任务链文档（T03 持久化）。
 * 存放于 .astarray/missions/<missionId>/task-chain.json（ADR-0004）。
 */
export interface TaskChainDocument {
  schemaVersion: number;
  missionId: string;
  revision: number;
  updatedAtIso: string;
  tasks: TaskDependencyNode[];
}

/** 反馈消息载荷（payload.kind 与 envelope.priority 必须一致，见 schema 校验）。 */
export type FeedbackMessagePayload =
  | { kind: "success"; summary: string }
  | { kind: "failure"; failureReason: string; currentStateSummary: string }
  | {
      kind: "permission-ask";
      toolName: string;
      argumentsJson: string;
      explanation: string;
    }
  | {
      kind: "backup-deletion-warning";
      authorizationRequestId: string;
      requestingAgentInstanceId: string;
      backupIdentifiers: string[];
      warningText: string;
      canRememberForSession: false;
    }
  | { kind: "ambiguous"; unclearPoints: string[]; requestedInformation: string }
  | { kind: "instruction"; instructionText: string };

/**
 * 反馈消息的原始信息来源。
 * 转发消息必须保留原始来源，不能把路由或转发 Agent 记录为原始来源。
 */
export type FeedbackMessageSource =
  | {
      sourceType: "user";
      sourceIdentifier: string;
    }
  | {
      sourceType: "agent";
      /** 单次 Agent 生命周期内稳定、全局唯一且不得复用的个体标识。 */
      agentInstanceId: string;
      agentRole: AgentRole;
    }
  | {
      sourceType: "system";
      sourceIdentifier: string;
      componentName: string;
    };

/** 次级与三级 Agent 工作存档中的条目类别。 */
export type AgentWorkArchiveEntryType =
  | "assignment"
  | "progress"
  | "decision"
  | "result"
  | "failure"
  | "handoff";

/**
 * 单条工作存档。存档保存可恢复、可复用的工作摘要与产物引用，
 * 不默认保存完整模型上下文、原始大输出或敏感值。
 */
export interface AgentWorkArchiveEntry {
  archiveEntryId: string;
  recordedAtIso: string;
  taskId: string | null;
  entryType: AgentWorkArchiveEntryType;
  summary: string;
  artifactReferences: string[];
}

/**
 * 每个次级/三级 Agent 个体拥有一个独立工作存档文件。
 * 路径：.astarray/missions/<missionId>/agents/<agentInstanceId>/work-archive.json
 */
export interface AgentWorkArchiveDocument {
  schemaVersion: number;
  missionId: string;
  agentInstanceId: string;
  agentRole: "secondary" | "tertiary";
  revision: number;
  updatedAtIso: string;
  entries: AgentWorkArchiveEntry[];
}

/** 上级 Agent 选择性附加到新任务或重新调用中的存档快照引用。 */
export interface AgentWorkArchiveAttachment {
  archiveOwnerAgentInstanceId: string;
  archiveRevision: number;
  selectedArchiveEntries: AgentWorkArchiveEntry[];
  selectionReason: string;
  /** 所选条目规范化序列化后的 SHA-256，格式为 sha256:<64 位十六进制>。 */
  contentHash: string;
}

/**
 * 反馈消息信封。进程间消息必须携带：协议版本、消息 ID、原始来源、接收者、优先级、创建时间和幂等键。
 */
export interface FeedbackMessage {
  protocolVersion: number;
  messageId: string;
  source: FeedbackMessageSource;
  recipientId: string;
  priority: MessagePriority;
  createdAtIso: string;
  idempotencyKey: string;
  payload: FeedbackMessagePayload;
}

export interface FeedbackAck {
  messageId: string;
  deliveredAtIso: string;
}

/** 单次 Agent 运行输入（Runtime 契约）。 */
export interface AgentRunInput {
  missionId: string | null;
  agentId: string;
  systemPrompt: string;
  userPrompt: string;
  availableToolDescriptors: ToolDescriptor[];
  maxLoopIterations: number;
  /**
   * 前序迭代的工具结果消息（ToolLoop 回填）。
   * 格式由 Runtime 定义（OpenAI 兼容：role=function 消息）。
   */
  toolResultMessages?: unknown[];
}

/**
 * Agent Runtime 契约（T07）：
 * 单次 run = 一次 provider/脚本迭代，产出事件流；
 * 多次迭代与工具结果回填由 ToolLoop 编排。
 */
export interface AgentRuntime {
  run(
    agentRunInput: AgentRunInput,
    cancellationSignal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
}

export type ToolCallResult =
  | {
      kind: "success";
      callId: string;
      outputText: string;
      isSideEffectFree: boolean;
    }
  | {
      kind: "error";
      callId: string;
      errorCode: string;
      errorMessage: string;
      /** 是否可确认幂等（不确定时必须进入 blocked，不得盲目重试，见 §9.4）。 */
      isIdempotencyConfirmed: boolean;
    };

/** 工具端口：权限检查必须先于实际执行（策略包装层在 T06）。 */
export interface ToolPort {
  execute(
    toolName: string,
    argumentsJson: string,
    callId: string,
    cancellationSignal: AbortSignal,
  ): Promise<ToolCallResult>;
}

export interface TaskStorePort {
  readTaskChain(missionId: string): Promise<TaskChainDocument | null>;
  writeTaskChain(document: TaskChainDocument): Promise<void>;
  /**
   * 锁内"读当前 → 构造新文档 → 校验写入"的原子更新（T03）。
   * updater 返回的文档 revision 必须大于当前，否则抛 stale-revision。
   */
  updateTaskChain(
    missionId: string,
    updater: (current: TaskChainDocument | null) => TaskChainDocument,
  ): Promise<TaskChainDocument>;
}

export interface TransportHealth {
  isHealthy: boolean;
  processPid: number | null;
  protocolVersion: number;
  queuedMessageCount: number;
}

/** Agent 侧可用的反馈传输端口（完整协议实现见 T04 独立进程）。 */
export interface FeedbackTransportPort {
  enqueue(message: FeedbackMessage): Promise<void>;
  queryHealth(): Promise<TransportHealth>;
  shutdown(): Promise<void>;
  /** 上报本 Agent 的空闲/忙碌状态（决定反馈进程是否投递普通消息）。 */
  setAgentStatus(recipientId: string, status: AgentStatus): void;
  /** 注册投递消息处理器（仅接收本 Agent 的消息）。 */
  onMessage(handler: (message: FeedbackMessage) => void | Promise<void>): void;
}

/** 独立反馈进程完整的进程内 API（enqueue/peek/deliver/ack/replay/health/shutdown）。 */
export interface FeedbackProcessApi {
  enqueue(message: FeedbackMessage): Promise<{ accepted: boolean }>;
  peek(recipientId: string, limit: number): Promise<FeedbackMessage[]>;
  deliver(messageId: string): Promise<FeedbackAck>;
  ack(messageId: string): Promise<void>;
  replayPending(recipientId: string): Promise<number>;
  health(): Promise<TransportHealth>;
  shutdown(): Promise<void>;
}

// ─── T05C：Agent 待办任务偏序集（ADR-0013） ──────────────────────────────

/** 任务发布者来源类型；工具来源只能由内部能力接口注入。 */
export type TaskSourceKind = "user" | "agent" | "system" | "tool";

/** 待办节点状态。cancelled 表示发布者显式取消；保留在历史中。 */
export type AgentTaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

/**
 * 待办偏序集节点。只保存调度信息、来源、优先级、状态、阻塞原因和可选外部引用；
 * 项目任务文档、产出内容与产物追踪由项目自己的存储负责。
 */
export interface AgentTaskNode {
  taskId: string;
  title: string;
  dependsOn: string[];
  sourceKind: TaskSourceKind;
  /** 具体发布者：用户标识 / agentInstanceId / 系统组件名 / 工具名。 */
  publisherId: string;
  /** 优先级层级，数值越小越优先；用户默认 0，Agent/system/工具只能 1 或以下。 */
  priorityTier: number;
  status: AgentTaskStatus;
  blockReason: string | null;
  /** 可选外部引用（如项目 mission/task id），不承载产出内容。 */
  externalReference: string | null;
  /** 创建序号（同层稳定排序，单调递增）。 */
  sequenceOrdinal: number;
  createdAtIso: string;
}

/** 任务包：绑定具体三级 Agent 与创建时序列 revision 的链式派发单位。 */
export interface TaskBundleRecord {
  bundleId: string;
  boundAgentInstanceId: string;
  /** 创建任务包时的序列 revision；序列变更后包仍可读但需重新验证。 */
  sequenceRevision: number;
  /** 必须构成链（相邻节点直接前驱关系）。 */
  taskIds: string[];
  status: "prepared" | "active" | "completed" | "failed";
  createdAtIso: string;
}

/** 序列变更类型；删除、覆盖、改序、取消和压缩属于破坏性变更。 */
export type TaskSequenceMutationKind =
  | "publish"
  | "insert"
  | "reorder"
  | "status-change"
  | "cancel"
  | "bundle-create"
  | "bundle-status";

/** 认证来源审计条目；发布、插入、状态迁移、打包和取消均记录。 */
export interface TaskSequenceAuditEntry {
  auditEntryId: string;
  recordedAtIso: string;
  mutationKind: TaskSequenceMutationKind;
  actorSourceKind: TaskSourceKind;
  actorId: string;
  summary: string;
}

/**
 * 版本化待办偏序集文档（T05C / ADR-0013）。
 * 路径：.astarray/agent-memory/<agentInstanceId>/task-sequences/<taskSequenceId>.json
 */
export interface AgentTaskSequenceDocument {
  schemaVersion: number;
  sequenceId: string;
  ownerAgentInstanceId: string;
  revision: number;
  updatedAtIso: string;
  nodes: AgentTaskNode[];
  bundles: TaskBundleRecord[];
  auditEntries: TaskSequenceAuditEntry[];
}

/** 序列状态快照（taskSequenceStatus 只读工具返回，不改变任何状态）。 */
export interface AgentTaskSequenceSnapshot {
  sequenceId: string;
  ownerAgentInstanceId: string;
  revision: number;
  nodes: AgentTaskNode[];
  readyTaskIds: string[];
  bundles: TaskBundleRecord[];
  /** 每个节点的顺序解释（可执行原因 / 阻塞原因 / 必要前驱提升）。 */
  orderExplanations: Array<{ taskId: string; explanation: string }>;
}

// ─── T05B：次级 Agent Git 分流、审查与合并（ADR-0012） ───────────────────

/** 破坏性 Git 操作前自动创建的受保护恢复点文档。 */
export interface GitRecoveryPointDocument {
  schemaVersion: number;
  recoveryPointId: string;
  missionId: string;
  createdAtIso: string;
  operationDescription: string;
  repositoryPath: string;
  affectedReferenceNames: string[];
  referenceBackups: Array<{
    referenceName: string;
    /** 受保护备份 ref（refs/astarray-recovery/<mission>/<id>/b<i>，简短以避免 Windows 路径超限）。 */
    backupReferenceName: string;
    committedOid: string;
  }>;
  hasWorktreePreimage: boolean;
  untrackedFileEntries: Array<{ relativePath: string }>;
  restoredAtIso: string | null;
}

/** worker 分支/worktree 分配记录（绑定 mission、任务、Agent、基线与允许路径）。 */
export interface GitWorkerAllocation {
  allocationId: string;
  missionId: string;
  taskId: string;
  tertiaryAgentInstanceId: string;
  integrationBranchName: string;
  workerBranchName: string;
  worktreePath: string;
  targetBaseCommit: string;
  allowedPaths: string[];
  createdAtIso: string;
}

/** 审查执行过的检查项（测试命令与退出码）。 */
export interface GitCheckExecutionRecord {
  command: string;
  exitCode: number;
}

/** 单个 worker 贡献的审查记录。 */
export interface GitContributionReviewRecord {
  taskId: string;
  contributingAgentInstanceId: string;
  workerBranchName: string;
  baseCommit: string;
  headCommit: string;
  changedPaths: string[];
  reviewDecision: "accepted" | "rejected" | "needs-rework";
  rejectionReason: string | null;
  executedChecks: GitCheckExecutionRecord[];
}

/** 结构化集成报告；与次级 Agent 工作存档关联。 */
export interface GitIntegrationReport {
  missionId: string;
  integratingAgentInstanceId: string;
  targetBranchName: string;
  integrationBranchName: string;
  targetBaseCommit: string;
  reviewedContributions: GitContributionReviewRecord[];
  integrationCommit: string | null;
  unresolvedRisks: string[];
  createdAtIso: string;
}
