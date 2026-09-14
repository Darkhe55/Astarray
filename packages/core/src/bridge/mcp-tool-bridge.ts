/**
 * MCP 工具桥接（BRIDGE-01-02/03 / ADR-0032）。
 *
 * 只做协议适配：把外部客户端的最小工具面（submit/query/cancel/read-result）
 * 映射到本地公共应用服务，并强制执行本地规则：
 * 1) 认证主体与来源由**本地 harness 注入**，绝不从工具参数读取——
 *    字符串 user 前缀、schema 校验通过或模型声明都不构成认证；
 * 2) 外部 Agent 提交一律记录为 agent 来源，不得占用用户优先级层级 0；
 * 3) `submit_task` 返回的是**受理回执**：受理 ≠ 完成；
 * 4) 会话隔离：任务归属按**认证主体**判定（同一主体重连后仍可读取自己的任务，
 *    不同主体一律 `task-not-accessible`）；会话关闭后调用一律拒绝；
 * 5) 逐次权限复检：每次工具调用先经本地权限端口复检（默认允许，由装配方注入真实策略）；
 * 6) 结果脱敏：返回文本与错误消息都经脱敏端口（默认 `Redactor`）；
 * 7) 协议层不直接执行底层写工具：本地写/执行类工具名一律显式拒绝。
 */
import { Redactor } from "../infra/redaction.js";

export const MCP_BRIDGE_TOOL_NAMES = [
  "submit_task",
  "query_task",
  "cancel_task",
  "read_result",
] as const;
export type McpBridgeToolName = (typeof MCP_BRIDGE_TOOL_NAMES)[number];

/** 协议层禁止直接触达的本地写/执行类工具（桥接只走应用服务）。 */
export const MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES = [
  "replaceFileContent",
  "createProjectFile",
  "writeFileTemporary",
  "backupVault",
  "deleteBackup",
  "gitCommit",
  "runCommand",
  "shell",
] as const;

/** 本地 harness 注入的调用主体（不可由消息内容或模型填写）。 */
export interface McpBridgePrincipal {
  authenticatedPrincipalIdentifier: string;
  /** 外部调用一律 agent 来源。 */
  sourceKind: "agent";
  /** 每次连接分配的不可复用实例标识（诊断/审计用途）。 */
  agentInstanceId: string;
  sessionId: string;
  /** 桥接会话标识（openSession 返回值；关闭后不可再用）。 */
  sessionIdentifier: string;
}

export interface McpBridgeToolDefinition {
  name: McpBridgeToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** 桥接复用的公共应用服务子集（AstarrayApplicationFacade 结构兼容）。 */
export interface McpBridgeApplicationPort {
  submitTask(input: {
    sessionId: string;
    taskIdentifier: string;
    prompt: string;
  }): Promise<{ missionIdentifier: string | null }>;
  queryTask(input: {
    sessionId: string;
    taskIdentifier: string;
  }): Promise<{ status: string; summaryPreview?: string | null }>;
  cancelTask(input: { sessionId: string; taskIdentifier: string }): Promise<void>;
}

/** 逐次权限复检端口（本地确定性策略；模型声明不构成授权依据）。 */
export interface McpBridgePermissionRecheckPort {
  recheckToolPermission(input: {
    toolName: McpBridgeToolName;
    requestingPrincipal: string;
  }): Promise<{
    isAllowed: boolean;
    deniedReason: string | null;
    recheckedAgainstProfile?: string;
  }>;
}

/** 结果脱敏端口。 */
export interface McpBridgeResultRedactionPort {
  redact(text: string): string;
}

export interface McpBridgeCallOutcome {
  isError: boolean;
  errorCode: string | null;
  structuredContent: Record<string, unknown>;
  textContent: string;
}

export interface McpToolBridgeOptions {
  applicationPort: McpBridgeApplicationPort;
  permissionRecheckPort?: McpBridgePermissionRecheckPort;
  resultRedactionPort?: McpBridgeResultRedactionPort;
  maximumTrackedReceipts?: number;
  nowMilliseconds?: () => number;
  identifierFactory?: () => string;
}

export interface McpBridgeSession {
  sessionIdentifier: string;
  agentInstanceId: string;
  principal: McpBridgePrincipal;
}

interface TaskReceipt {
  taskIdentifier: string;
  missionIdentifier: string | null;
  idempotencyKey: string;
  principalIdentifier: string;
  agentInstanceId: string;
  acceptedStatus: string;
}

interface BridgeSessionRecord {
  sessionIdentifier: string;
  agentInstanceId: string;
  authenticatedPrincipalIdentifier: string;
  sessionId: string;
  isClosed: boolean;
}

const IDENTITY_ARGUMENT_NAMES = [
  "authenticatedPrincipal",
  "authenticatedPrincipalIdentifier",
  "principal",
  "sourceKind",
  "sourceActorId",
  "agentInstanceId",
  "sessionId",
  "sessionIdentifier",
] as const;

const PRIORITY_ARGUMENT_NAMES = [
  "priorityTier",
  "priority",
  "tier",
  "isUserTask",
  "isUserPriority",
] as const;

export const MCP_BRIDGE_TOOL_DEFINITIONS: McpBridgeToolDefinition[] = [
  {
    name: "submit_task",
    description: "提交任务（返回受理回执；受理不等于完成，完成状态需查询）",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述" },
        idempotencyKey: {
          type: "string",
          description: "幂等键（同主体同键重复提交返回同一任务）",
        },
      },
      required: ["prompt", "idempotencyKey"],
    },
  },
  {
    name: "query_task",
    description: "查询任务本地权威状态",
    inputSchema: {
      type: "object",
      properties: { taskIdentifier: { type: "string" } },
      required: ["taskIdentifier"],
    },
  },
  {
    name: "cancel_task",
    description: "取消任务（取消后返回本地权威状态）",
    inputSchema: {
      type: "object",
      properties: { taskIdentifier: { type: "string" } },
      required: ["taskIdentifier"],
    },
  },
  {
    name: "read_result",
    description: "读取任务结果（未完成时返回 isCompleted=false，不伪造结果）",
    inputSchema: {
      type: "object",
      properties: { taskIdentifier: { type: "string" } },
      required: ["taskIdentifier"],
    },
  },
];

/** 默认脱敏端口：复用 T02 的 `Redactor`（API key/Authorization/凭据字段）。 */
const defaultRedactionPort: McpBridgeResultRedactionPort = new Redactor();

export class McpToolBridge {
  private readonly applicationPort: McpBridgeApplicationPort;
  private readonly permissionRecheckPort: McpBridgePermissionRecheckPort;
  private readonly resultRedactionPort: McpBridgeResultRedactionPort;
  private readonly maximumTrackedReceipts: number;
  private readonly nowMilliseconds: () => number;
  private readonly identifierFactory: () => string;
  private readonly sessionsByIdentifier = new Map<string, BridgeSessionRecord>();
  private readonly receiptsByPrincipalAndKey = new Map<string, TaskReceipt>();
  private readonly receiptByTaskIdentifier = new Map<string, TaskReceipt>();
  private sessionCounter = 0;

  constructor(options: McpToolBridgeOptions) {
    this.applicationPort = options.applicationPort;
    this.permissionRecheckPort = options.permissionRecheckPort ?? {
      recheckToolPermission: async () => ({
        isAllowed: true,
        deniedReason: null,
        recheckedAgainstProfile: "bridge-default-allow",
      }),
    };
    this.resultRedactionPort = options.resultRedactionPort ?? defaultRedactionPort;
    this.maximumTrackedReceipts = options.maximumTrackedReceipts ?? 1000;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.identifierFactory =
      options.identifierFactory ??
      (() => {
        this.sessionCounter += 1;
        return `${this.nowMilliseconds().toString(36)}-${this.sessionCounter.toString(36)}`;
      });
  }

  listTools(): McpBridgeToolDefinition[] {
    return MCP_BRIDGE_TOOL_DEFINITIONS;
  }

  /** 打开会话：为每次连接分配不可复用实例标识；归属按认证主体判定。 */
  openSession(input: {
    authenticatedPrincipalIdentifier: string;
    sessionId: string;
  }): McpBridgeSession {
    const sessionIdentifier = `mcp-session-${this.identifierFactory()}`;
    const agentInstanceId = `mcp-client-${this.identifierFactory()}`;
    this.sessionsByIdentifier.set(sessionIdentifier, {
      sessionIdentifier,
      agentInstanceId,
      authenticatedPrincipalIdentifier: input.authenticatedPrincipalIdentifier,
      sessionId: input.sessionId,
      isClosed: false,
    });
    return {
      sessionIdentifier,
      agentInstanceId,
      principal: {
        authenticatedPrincipalIdentifier: input.authenticatedPrincipalIdentifier,
        sourceKind: "agent",
        agentInstanceId,
        sessionId: input.sessionId,
        sessionIdentifier,
      },
    };
  }

  /** 关闭会话（服务关闭/断连）：之后的调用一律拒绝。 */
  closeSession(sessionIdentifier: string): void {
    const record = this.sessionsByIdentifier.get(sessionIdentifier);
    if (record !== undefined) {
      record.isClosed = true;
    }
  }

  isSessionOpen(sessionIdentifier: string): boolean {
    const record = this.sessionsByIdentifier.get(sessionIdentifier);
    return record !== undefined && !record.isClosed;
  }

  /** 调用工具：主体由本地 harness 注入；逐次权限复检 + 结果脱敏。 */
  async callTool(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    principal: McpBridgePrincipal;
  }): Promise<McpBridgeCallOutcome> {
    const sessionRecord = this.sessionsByIdentifier.get(
      input.principal.sessionIdentifier,
    );
    if (sessionRecord === undefined || sessionRecord.isClosed) {
      return this.buildError(
        "bridge-session-closed",
        "桥接会话不存在或已关闭，拒绝调用",
      );
    }
    if (
      sessionRecord.agentInstanceId !== input.principal.agentInstanceId ||
      sessionRecord.authenticatedPrincipalIdentifier !==
        input.principal.authenticatedPrincipalIdentifier
    ) {
      return this.buildError(
        "bridge-session-mismatch",
        "调用主体与会话归属不一致，拒绝调用",
      );
    }
    const toolName = input.toolName;
    if (
      MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES.includes(
        toolName as (typeof MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES)[number],
      )
    ) {
      return this.buildError(
        "bridge-local-write-tool-rejected",
        `协议层不得直接执行本地写/执行工具: ${toolName}`,
      );
    }
    if (!MCP_BRIDGE_TOOL_NAMES.includes(toolName as McpBridgeToolName)) {
      return this.buildError("unknown-tool", `未知工具: ${toolName}`);
    }
    const identityField = IDENTITY_ARGUMENT_NAMES.find(
      (field) => input.arguments[field] !== undefined,
    );
    if (identityField !== undefined) {
      return this.buildError(
        "bridge-identity-injection-rejected",
        `工具参数不得携带身份字段（${identityField}）：认证主体只由本地 harness 注入`,
      );
    }
    const priorityField = PRIORITY_ARGUMENT_NAMES.find(
      (field) => input.arguments[field] !== undefined,
    );
    if (priorityField !== undefined) {
      return this.buildError(
        "bridge-priority-injection-rejected",
        `外部 Agent 不得指定 ${priorityField}：优先级由本地控制面决定`,
      );
    }
    // 逐次权限复检（本地确定性策略；不在首次派发时缓存结论）
    const permission = await this.permissionRecheckPort.recheckToolPermission({
      toolName: toolName as McpBridgeToolName,
      requestingPrincipal: input.principal.authenticatedPrincipalIdentifier,
    });
    if (!permission.isAllowed) {
      return this.buildError(
        "bridge-permission-denied",
        `本地权限复检拒绝 ${toolName}${permission.deniedReason === null ? "" : ": " + permission.deniedReason}`,
      );
    }
    switch (toolName as McpBridgeToolName) {
      case "submit_task":
        return this.submitTask(input.arguments, input.principal);
      case "query_task":
        return this.queryTask(input.arguments, input.principal);
      case "cancel_task":
        return this.cancelTask(input.arguments, input.principal);
      case "read_result":
        return this.readResult(input.arguments, input.principal);
    }
  }

  private async submitTask(
    argumentsList: Record<string, unknown>,
    principal: McpBridgePrincipal,
  ): Promise<McpBridgeCallOutcome> {
    const prompt = argumentsList["prompt"];
    const idempotencyKey = argumentsList["idempotencyKey"];
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return this.buildError("invalid-arguments", "prompt 必须是非空字符串");
    }
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim() === "" ||
      idempotencyKey.length > 200
    ) {
      return this.buildError(
        "invalid-arguments",
        "idempotencyKey 必须是非空字符串（长度 ≤200）",
      );
    }
    const receiptKey = `${principal.authenticatedPrincipalIdentifier}:${idempotencyKey}`;
    const existingReceipt = this.receiptsByPrincipalAndKey.get(receiptKey);
    if (existingReceipt !== undefined) {
      return this.buildSuccess({
        taskIdentifier: existingReceipt.taskIdentifier,
        missionIdentifier: existingReceipt.missionIdentifier,
        status: existingReceipt.acceptedStatus,
        isCompleted: false,
        isIdempotentReplay: true,
        provenance: this.buildProvenance(principal),
      });
    }
    const taskIdentifier = `bridge-${principal.agentInstanceId}-${idempotencyKey}`;
    const submitted = await this.applicationPort.submitTask({
      sessionId: principal.sessionId,
      taskIdentifier,
      prompt,
    });
    const receipt: TaskReceipt = {
      taskIdentifier,
      missionIdentifier: submitted.missionIdentifier,
      idempotencyKey,
      principalIdentifier: principal.authenticatedPrincipalIdentifier,
      agentInstanceId: principal.agentInstanceId,
      acceptedStatus: "accepted",
    };
    this.recordReceipt(receiptKey, receipt);
    return this.buildSuccess({
      taskIdentifier,
      missionIdentifier: submitted.missionIdentifier,
      status: "accepted",
      isCompleted: false,
      isIdempotentReplay: false,
      provenance: this.buildProvenance(principal),
    });
  }

  private async queryTask(
    argumentsList: Record<string, unknown>,
    principal: McpBridgePrincipal,
  ): Promise<McpBridgeCallOutcome> {
    const owned = this.requireOwnedTask(argumentsList, principal);
    if ("error" in owned) {
      return owned.error;
    }
    const status = await this.applicationPort.queryTask({
      sessionId: principal.sessionId,
      taskIdentifier: owned.receipt.taskIdentifier,
    });
    return this.buildSuccess({
      taskIdentifier: owned.receipt.taskIdentifier,
      status: status.status,
      isCompleted: this.isTerminalStatus(status.status),
      summaryPreview: this.redactText(status.summaryPreview ?? null),
    });
  }

  private async cancelTask(
    argumentsList: Record<string, unknown>,
    principal: McpBridgePrincipal,
  ): Promise<McpBridgeCallOutcome> {
    const owned = this.requireOwnedTask(argumentsList, principal);
    if ("error" in owned) {
      return owned.error;
    }
    await this.applicationPort.cancelTask({
      sessionId: principal.sessionId,
      taskIdentifier: owned.receipt.taskIdentifier,
    });
    const status = await this.applicationPort.queryTask({
      sessionId: principal.sessionId,
      taskIdentifier: owned.receipt.taskIdentifier,
    });
    return this.buildSuccess({
      taskIdentifier: owned.receipt.taskIdentifier,
      status: status.status,
      isCompleted: this.isTerminalStatus(status.status),
      cancellationRequested: true,
      // 取消后不再返回可写/可续结果（只返回权威状态与脱敏摘要）
      result: null,
    });
  }

  private async readResult(
    argumentsList: Record<string, unknown>,
    principal: McpBridgePrincipal,
  ): Promise<McpBridgeCallOutcome> {
    const owned = this.requireOwnedTask(argumentsList, principal);
    if ("error" in owned) {
      return owned.error;
    }
    const status = await this.applicationPort.queryTask({
      sessionId: principal.sessionId,
      taskIdentifier: owned.receipt.taskIdentifier,
    });
    const isCompleted = this.isTerminalStatus(status.status);
    return this.buildSuccess({
      taskIdentifier: owned.receipt.taskIdentifier,
      status: status.status,
      isCompleted,
      result: isCompleted ? this.redactText(status.summaryPreview ?? null) : null,
    });
  }

  private requireOwnedTask(
    argumentsList: Record<string, unknown>,
    principal: McpBridgePrincipal,
  ): { receipt: TaskReceipt } | { error: McpBridgeCallOutcome } {
    const taskIdentifier = argumentsList["taskIdentifier"];
    if (typeof taskIdentifier !== "string" || taskIdentifier === "") {
      return {
        error: this.buildError("invalid-arguments", "taskIdentifier 必须是非空字符串"),
      };
    }
    const receipt = this.receiptByTaskIdentifier.get(taskIdentifier);
    // 归属按认证主体判定：同一主体重连（新会话/新实例 ID）后仍可读取自己的任务。
    if (
      receipt === undefined ||
      receipt.principalIdentifier !== principal.authenticatedPrincipalIdentifier
    ) {
      return {
        error: this.buildError(
          "task-not-accessible",
          "任务不存在或不属于当前调用主体",
        ),
      };
    }
    return { receipt };
  }

  private recordReceipt(receiptKey: string, receipt: TaskReceipt): void {
    this.receiptsByPrincipalAndKey.set(receiptKey, receipt);
    this.receiptByTaskIdentifier.set(receipt.taskIdentifier, receipt);
    if (this.receiptsByPrincipalAndKey.size > this.maximumTrackedReceipts) {
      const oldestKey = this.receiptsByPrincipalAndKey.keys().next().value;
      if (typeof oldestKey === "string") {
        const oldestReceipt = this.receiptsByPrincipalAndKey.get(oldestKey);
        this.receiptsByPrincipalAndKey.delete(oldestKey);
        if (oldestReceipt !== undefined) {
          this.receiptByTaskIdentifier.delete(oldestReceipt.taskIdentifier);
        }
      }
    }
  }

  private buildProvenance(principal: McpBridgePrincipal): Record<string, unknown> {
    return {
      sourceKind: principal.sourceKind,
      actorId: principal.authenticatedPrincipalIdentifier,
      agentInstanceId: principal.agentInstanceId,
    };
  }

  private isTerminalStatus(status: string): boolean {
    return status === "done" || status === "failed" || status === "cancelled";
  }

  private redactText(value: string | null): string | null {
    return value === null ? null : this.resultRedactionPort.redact(value);
  }

  private buildSuccess(
    structuredContent: Record<string, unknown>,
  ): McpBridgeCallOutcome {
    const redactedContent: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(structuredContent)) {
      redactedContent[key] =
        typeof value === "string" ? this.resultRedactionPort.redact(value) : value;
    }
    return {
      isError: false,
      errorCode: null,
      structuredContent: redactedContent,
      textContent: JSON.stringify(redactedContent),
    };
  }

  private buildError(errorCode: string, message: string): McpBridgeCallOutcome {
    // 错误消息同样脱敏（防秘密回显）
    const structuredContent = {
      errorCode,
      message: this.resultRedactionPort.redact(message),
    };
    return {
      isError: true,
      errorCode,
      structuredContent,
      textContent: JSON.stringify(structuredContent),
    };
  }
}
