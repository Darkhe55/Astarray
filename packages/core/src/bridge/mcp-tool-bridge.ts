/**
 * MCP 工具桥接（BRIDGE-01-02 / ADR-0032）。
 *
 * 只做协议适配：把外部客户端的最小工具面（submit/query/cancel/read-result）
 * 映射到本地公共应用服务，并强制执行三条本地规则：
 * 1) 认证主体与来源由**本地 harness 注入**，绝不从工具参数读取——
 *    字符串 user 前缀、schema 校验通过或模型声明都不构成认证；
 * 2) 外部 Agent 提交一律记录为 agent 来源，不得占用用户优先级层级 0
 *    （客户端传 priorityTier/sourceKind 一类字段直接拒绝，而不是静默忽略）；
 * 3) `submit_task` 返回的是**受理回执**：受理 ≠ 完成，完成/失败/取消只能由
 *    query/read-result 读取本地权威状态。
 */
export const MCP_BRIDGE_TOOL_NAMES = [
  "submit_task",
  "query_task",
  "cancel_task",
  "read_result",
] as const;
export type McpBridgeToolName = (typeof MCP_BRIDGE_TOOL_NAMES)[number];

/** 本地 harness 注入的调用主体（不可由消息内容或模型填写）。 */
export interface McpBridgePrincipal {
  authenticatedPrincipalIdentifier: string;
  /** 外部调用一律 agent 来源。 */
  sourceKind: "agent";
  agentInstanceId: string;
  sessionId: string;
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

export interface McpBridgeCallOutcome {
  isError: boolean;
  /** 稳定错误码（成功时为 null；不透出内部细节/凭据）。 */
  errorCode: string | null;
  structuredContent: Record<string, unknown>;
  textContent: string;
}

export interface McpToolBridgeOptions {
  applicationPort: McpBridgeApplicationPort;
  /** 幂等回执保留上限（超出后淘汰最旧条目）。 */
  maximumTrackedReceipts?: number;
}

interface TaskReceipt {
  taskIdentifier: string;
  missionIdentifier: string | null;
  idempotencyKey: string;
  principalIdentifier: string;
  agentInstanceId: string;
  acceptedStatus: string;
}

const IDENTITY_ARGUMENT_NAMES = [
  "authenticatedPrincipal",
  "authenticatedPrincipalIdentifier",
  "principal",
  "sourceKind",
  "sourceActorId",
  "agentInstanceId",
  "sessionId",
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
    description:
      "提交任务（返回受理回执；受理不等于完成，完成状态需查询）",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述" },
        idempotencyKey: { type: "string", description: "幂等键（同键重复提交返回同一任务）" },
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

export class McpToolBridge {
  private readonly applicationPort: McpBridgeApplicationPort;
  private readonly maximumTrackedReceipts: number;
  private readonly receiptsByPrincipalAndKey = new Map<string, TaskReceipt>();
  private readonly receiptByTaskIdentifier = new Map<string, TaskReceipt>();

  constructor(options: McpToolBridgeOptions) {
    this.applicationPort = options.applicationPort;
    this.maximumTrackedReceipts = options.maximumTrackedReceipts ?? 1000;
  }

  listTools(): McpBridgeToolDefinition[] {
    return MCP_BRIDGE_TOOL_DEFINITIONS;
  }

  /** 调用工具：主体由调用方（本地 harness）注入，参数中的身份/优先级字段一律拒绝。 */
  async callTool(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    principal: McpBridgePrincipal;
  }): Promise<McpBridgeCallOutcome> {
    if (!MCP_BRIDGE_TOOL_NAMES.includes(input.toolName as McpBridgeToolName)) {
      return this.buildError("unknown-tool", `未知工具: ${input.toolName}`);
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
    switch (input.toolName as McpBridgeToolName) {
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
    const receiptKey = `${principal.agentInstanceId}:${idempotencyKey}`;
    const existingReceipt = this.receiptsByPrincipalAndKey.get(receiptKey);
    if (existingReceipt !== undefined) {
      // 幂等重放：返回同一任务，不重复提交。
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
      // 受理回执：状态固定为 accepted，绝不在受理时报告完成。
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
      summaryPreview: status.summaryPreview ?? null,
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
      // 未完成时不得返回结果（不伪造、不预填）
      result: isCompleted ? (status.summaryPreview ?? null) : null,
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
    if (
      receipt === undefined ||
      receipt.agentInstanceId !== principal.agentInstanceId
    ) {
      // 跨主体访问一律拒绝（不区分"不存在"与"不属于你"，避免探测）。
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

  private buildSuccess(
    structuredContent: Record<string, unknown>,
  ): McpBridgeCallOutcome {
    return {
      isError: false,
      errorCode: null,
      structuredContent,
      textContent: JSON.stringify(structuredContent),
    };
  }

  private buildError(
    errorCode: string,
    message: string,
  ): McpBridgeCallOutcome {
    const structuredContent = { errorCode, message };
    return {
      isError: true,
      errorCode,
      structuredContent,
      textContent: JSON.stringify(structuredContent),
    };
  }
}
