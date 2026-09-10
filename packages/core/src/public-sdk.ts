/**
 * Astarray 公开 SDK facade（T07D-08 / T07D-R1-01）。
 *
 * 应用服务从安装包公开 exports 创建：运行时资源由应用层装配与回收，
 * 消费者不导入 MainController、TUI bootstrap 或内部存储路径。
 * 会话/任务状态迁移在此冻结；提交/查询/取消委托给同一主控制器。
 */
import type { AgentMode, AgentRuntime, TaskDependencyNode } from "./core/types.js";
import type { MainController } from "./orchestration/main-controller.js";
import type { PermissionProfileReference } from "./tools/permission-profile-store.js";
import { ProviderConfigurationError } from "./runtime/provider-runtime-registry.js";
import type {
  ProviderRuntimeCapability,
  ProviderRuntimeRegistry,
} from "./runtime/provider-runtime-registry.js";
import type { ApplicationRuntime } from "./application/application-runtime.js";
import { createApplicationRuntime } from "./application/application-runtime.js";

/** SDK 版本（与 package.json 同步语义版本）。 */
export const ASTARRAY_SDK_VERSION = "0.1.0";

export type PublicTaskStatus =
  | "accepted"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

/** 公开会话状态（公共 DTO；不含内部字段）。 */
export interface PublicSessionState {
  sessionId: string;
  mode: AgentMode;
  status: "idle" | "running" | "blocked" | "closed";
}

/** 公开任务结果（公共 DTO）。 */
export interface PublicTaskResult {
  taskIdentifier: string;
  status: PublicTaskStatus;
  /** 本地 mission 标识；accepted 后必填，用于 query/cancel。 */
  missionIdentifier: string | null;
  summaryPreview: string | null;
}

/** 公开事件（订阅用；不含凭据/内部执行细节）。 */
export type PublicAstarrayEvent =
  | { eventType: "session-status"; sessionId: string; status: PublicSessionState["status"] }
  | { eventType: "task-status"; taskIdentifier: string; status: PublicTaskStatus }
  | { eventType: "task-finished"; taskIdentifier: string; status: PublicTaskStatus };

/** 状态订阅端口（不暴露 IPC 地址）。 */
export interface PublicEventSubscriptionPort {
  subscribe(
    listener: (event: PublicAstarrayEvent) => void,
  ): { unsubscribe(): void };
}

/**
 * 公共应用服务端口：CLI/TUI/外部消费者共用的应用能力视图。
 * 只暴露公共能力（任务状态、模式、权限组控制面），不暴露内部装配与存储。
 */
export type PublicApplicationService = Pick<
  MainController,
  | "getActiveMissionIds"
  | "queryMissionStatus"
  | "getMetricsSnapshot"
  | "handleUserMessage"
  | "cancelMission"
  | "sendSchedulerInstruction"
  | "grantSessionAuthorization"
  | "transitionMode"
  | "getCurrentPermissionProfileReference"
  | "listPermissionProfiles"
  | "switchPermissionProfile"
>;

/** 公开 mission 状态（SDK/CLI 共用视图）。 */
export interface PublicMissionState {
  missionIdentifier: string;
  status: PublicTaskStatus;
}

/** 应用创建选项：由消费者从公开 exports 传入，不接触内部控制器。 */
export interface PublicApplicationOptions {
  stateDirectory: string;
  mode: AgentMode;
  /** 运行时选择：mock（离线）或 provider（真实 Provider，T07D-R2）。 */
  runtime?: "mock" | "provider";
  /** Provider 配置（runtime=provider 时必填；只含受保护凭据引用）。 */
  provider?: PublicProviderConfiguration;
  /** Provider 运行时注册表（嵌入方注入；runtime=provider 且未提供则稳定失败）。 */
  providerRuntimeRegistry?: ProviderRuntimeRegistry;
  /** 可选流式输出钩子（headless 写 stderr；不暴露内部字段）。 */
  streamOutput?: (missionIdentifier: string | null, text: string) => void;
  concurrency?: number;
  failureThreshold?: number;
  maximumLoopIterations?: number;
  /** 权威状态轮询间隔（毫秒）；测试可注入更小值。 */
  statusPollIntervalMilliseconds?: number;
}

/** 公开 Provider 配置：只含受保护凭据引用与允许列表，不含秘密内容。 */
export interface PublicProviderConfiguration {
  providerId: string;
  modelIdentifier: string;
  allowedModelIdentifiers: string[];
  requiredCapabilities?: ProviderRuntimeCapability[];
  baseUrl?: string | null;
  protectedCredentialReferenceId?: string | null;
  requestTimeoutMilliseconds?: number;
}

/** 公开应用错误：稳定 errorCode，便于消费者分支处理。 */
export class PublicApplicationError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicApplicationError";
  }
}

interface TaskRecord {
  sessionId: string;
  missionIdentifier: string | null;
  status: PublicTaskStatus;
  summaryPreview: string | null;
}

/**
 * 稳定应用 facade：CLI/TUI/外部消费者共用同一主控制器。
 * 本 facade 不实现第二套权限/任务/Provider 逻辑。
 */
export class AstarrayApplicationFacade implements PublicApplicationService {
  /** 从公开 exports 创建应用；运行资源由应用层创建。 */
  static async create(
    options: PublicApplicationOptions,
  ): Promise<AstarrayApplicationFacade> {
    const runtimeKind = options.runtime ?? "mock";
    let mainRuntimeFactory:
      | ((agentInstanceId: string) => AgentRuntime)
      | undefined;
    let workerRuntimeFactory:
      | ((agentInstanceId: string, task: TaskDependencyNode) => AgentRuntime)
      | undefined;
    if (runtimeKind === "provider") {
      const registry = options.providerRuntimeRegistry;
      if (registry === undefined) {
        throw new PublicApplicationError(
          "runtime-unsupported",
          "选择 provider 运行时需要已注册的 Provider 运行时（不静默回退 mock）",
        );
      }
      const provider = options.provider;
      if (provider === undefined) {
        throw new PublicApplicationError(
          "provider-config-missing",
          "缺少 Provider 配置（providerId/modelIdentifier）",
        );
      }
      try {
        const resolved = await registry.resolveRuntime({
          providerId: provider.providerId,
          modelIdentifier: provider.modelIdentifier,
          allowedModelIdentifiers: provider.allowedModelIdentifiers,
          requiredCapabilities: provider.requiredCapabilities,
          baseUrl: provider.baseUrl ?? null,
          protectedCredentialReferenceId:
            provider.protectedCredentialReferenceId ?? null,
          requestTimeoutMilliseconds: provider.requestTimeoutMilliseconds,
        });
        mainRuntimeFactory = () => resolved.createRuntime();
        workerRuntimeFactory = () => resolved.createRuntime();
      } catch (error) {
        if (error instanceof ProviderConfigurationError) {
          throw new PublicApplicationError(error.errorCode, error.message);
        }
        throw error;
      }
    } else if (runtimeKind !== "mock") {
      throw new PublicApplicationError(
        "runtime-unsupported",
        "不支持的运行时: " + String(runtimeKind),
      );
    }
    const runtime = await createApplicationRuntime({
      mode: options.mode,
      stateDirectory: options.stateDirectory,
      concurrency: options.concurrency ?? 1,
      failureThreshold: options.failureThreshold ?? 1,
      maxLoopIterations: options.maximumLoopIterations ?? 8,
      useFeedbackProcess: false,
      streamOutput: options.streamOutput ?? (() => {}),
      backupDeletionControlPort: null,
      installationUserPort: null,
      authenticatedUserId: "sdk-user",
      mainAgentInstanceId: "main-agent-sdk",
      feedbackProcessModulePath: null,
      mainRuntimeFactory,
      workerRuntimeFactory,
    });
    return new AstarrayApplicationFacade(runtime, {
      statusPollIntervalMilliseconds: options.statusPollIntervalMilliseconds ?? 25,
    });
  }

  constructor(
    private readonly runtime: ApplicationRuntime,
    options: { statusPollIntervalMilliseconds?: number } = {},
  ) {
    this.statusPollIntervalMilliseconds =
      options.statusPollIntervalMilliseconds ?? 25;
  }

  private readonly sessionStates = new Map<string, PublicSessionState>();
  private readonly tasksByTaskIdentifier = new Map<string, TaskRecord>();
  private readonly taskIdentifierByIdempotencyKey = new Map<string, string>();
  private readonly taskMonitors = new Map<string, NodeJS.Timeout>();
  private readonly inFlightPolls = new Set<Promise<void>>();
  private readonly listeners = new Set<(event: PublicAstarrayEvent) => void>();
  private readonly statusPollIntervalMilliseconds: number;
  private isClosedFlag = false;

  get isClosed(): boolean {
    return this.isClosedFlag;
  }

  /** 创建会话（冻结状态迁移：idle → closed）。 */
  createSession(input: { sessionId: string; mode: AgentMode }): PublicSessionState {
    this.assertOpen();
    if (this.sessionStates.has(input.sessionId)) {
      throw new PublicApplicationError(
        "session-already-exists",
        "会话已存在: " + input.sessionId,
      );
    }
    if (input.mode !== this.runtime.controller.getCurrentMode()) {
      throw new PublicApplicationError(
        "mode-mismatch",
        "会话模式与应用模式不一致: " + input.mode,
      );
    }
    const state: PublicSessionState = {
      sessionId: input.sessionId,
      mode: input.mode,
      status: "idle",
    };
    this.sessionStates.set(input.sessionId, state);
    this.emit({ eventType: "session-status", sessionId: input.sessionId, status: "idle" });
    return { ...state };
  }

  /** 打开既有会话；不存在或应用已关闭时抛出公开错误。 */
  openSession(sessionId: string): PublicSessionState {
    this.assertOpen();
    const state = this.sessionStates.get(sessionId);
    if (state === undefined) {
      throw new PublicApplicationError("session-not-found", "会话不存在: " + sessionId);
    }
    return { ...state };
  }

  listSessions(): PublicSessionState[] {
    return [...this.sessionStates.values()].map((state) => ({ ...state }));
  }

  /** 公共应用服务端口：CLI/TUI 通过本 facade 访问应用能力（不接触内部装配）。 */
  getActiveMissionIds(): string[] {
    return this.runtime.controller.getActiveMissionIds();
  }

  async queryMissionStatus(missionId: string) {
    return this.runtime.controller.queryMissionStatus(missionId);
  }

  getMetricsSnapshot() {
    return this.runtime.controller.getMetricsSnapshot();
  }

  async handleUserMessage(message: string): Promise<string> {
    return this.runtime.controller.handleUserMessage(message);
  }

  async cancelMission(missionId: string): Promise<void> {
    return this.runtime.controller.cancelMission(missionId);
  }

  sendSchedulerInstruction(missionId: string, instructionText: string): void {
    this.runtime.controller.sendSchedulerInstruction(missionId, instructionText);
  }

  async grantSessionAuthorization(
    toolName: string,
    argumentsJson: string,
    nowUnixSeconds: number,
  ): Promise<void> {
    return this.runtime.controller.grantSessionAuthorization(
      toolName,
      argumentsJson,
      nowUnixSeconds,
    );
  }

  transitionMode(mode: AgentMode): void {
    this.runtime.controller.transitionMode(mode);
  }

  async getCurrentPermissionProfileReference() {
    return this.runtime.controller.getCurrentPermissionProfileReference();
  }

  async listPermissionProfiles(input: { page: number; pageSize: number }) {
    return this.runtime.controller.listPermissionProfiles(input);
  }

  async switchPermissionProfile(reference: PermissionProfileReference): Promise<void> {
    return this.runtime.controller.switchPermissionProfile(reference);
  }

  /** 按 mission 标识查询权威状态（CLI 与 SDK 共用同一状态源）。 */
  async queryMission(missionIdentifier: string): Promise<PublicMissionState> {
    this.assertOpen();
    const missionStatus = (await this.runtime.controller.queryMissionStatus(
      missionIdentifier,
    )) as {
      summary?: { status?: string } | null;
      taskChain?: { tasks: Array<{ status: string }> } | null;
    };
    return {
      missionIdentifier,
      status: this.mapMissionStatus(missionStatus),
    };
  }

  /**
   * 提交任务：委托调度并返回 accepted + mission 标识；不提前发 task-finished。
   * 同一会话内相同 idempotencyKey 不重复执行；不同会话相互隔离。
   */
  async submitTask(input: {
    sessionId: string;
    taskIdentifier: string;
    prompt: string;
    idempotencyKey?: string;
  }): Promise<PublicTaskResult> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    if (input.idempotencyKey !== undefined) {
      const existingTaskIdentifier = this.taskIdentifierByIdempotencyKey.get(
        input.sessionId + "|" + input.idempotencyKey,
      );
      if (existingTaskIdentifier !== undefined) {
        const existingRecord = this.tasksByTaskIdentifier.get(existingTaskIdentifier);
        if (existingRecord !== undefined) {
          return this.toTaskResult(existingTaskIdentifier, existingRecord);
        }
      }
    }
    const existing = this.tasksByTaskIdentifier.get(input.taskIdentifier);
    if (existing !== undefined) {
      if (existing.sessionId !== input.sessionId) {
        throw new PublicApplicationError(
          "session-mismatch",
          "任务不属于该会话: " + input.taskIdentifier,
        );
      }
      return this.toTaskResult(input.taskIdentifier, existing);
    }
    let missionIdentifier: string;
    try {
      missionIdentifier = await this.runtime.controller.handleUserMessage(input.prompt);
    } catch (error) {
      throw new PublicApplicationError(
        "submit-failed",
        "任务提交失败: " + (error as Error).message,
      );
    }
    this.assertOpen();
    const record: TaskRecord = {
      sessionId: input.sessionId,
      missionIdentifier,
      status: "accepted",
      summaryPreview: null,
    };
    this.tasksByTaskIdentifier.set(input.taskIdentifier, record);
    if (input.idempotencyKey !== undefined) {
      this.taskIdentifierByIdempotencyKey.set(
        input.sessionId + "|" + input.idempotencyKey,
        input.taskIdentifier,
      );
    }
    this.emit({
      eventType: "task-status",
      taskIdentifier: input.taskIdentifier,
      status: "accepted",
    });
    this.startTaskMonitor(input.taskIdentifier);
    return this.toTaskResult(input.taskIdentifier, record);
  }

  /** 查询任务：以本地权威 mission 状态为准（非字符串占位）。 */
  async queryTask(input: {
    sessionId: string;
    taskIdentifier: string;
  }): Promise<PublicTaskResult> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    const record = this.requireTask(input.taskIdentifier, input.sessionId);
    if (this.isTerminalStatus(record.status) || record.missionIdentifier === null) {
      return this.toTaskResult(input.taskIdentifier, record);
    }
    const missionStatus = (await this.runtime.controller.queryMissionStatus(
      record.missionIdentifier,
    )) as {
      summary?: { status?: string } | null;
      taskChain?: { tasks: Array<{ status: string }> } | null;
    };
    record.status = this.mapMissionStatus(missionStatus);
    if (this.isTerminalStatus(record.status) && record.summaryPreview === null) {
      await this.captureAuthoritativeResult(record);
    }
    return this.toTaskResult(input.taskIdentifier, record);
  }

  /** 取消任务：委托控制器取消并记录终态。 */
  async cancelTask(input: { sessionId: string; taskIdentifier: string }): Promise<void> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    const record = this.requireTask(input.taskIdentifier, input.sessionId);
    if (this.isTerminalStatus(record.status)) {
      return;
    }
    this.stopTaskMonitor(input.taskIdentifier);
    if (record.missionIdentifier !== null) {
      await this.runtime.controller.cancelMission(record.missionIdentifier);
    }
    record.status = "cancelled";
    this.emit({
      eventType: "task-finished",
      taskIdentifier: input.taskIdentifier,
      status: "cancelled",
    });
  }

  subscribe(listener: (event: PublicAstarrayEvent) => void): { unsubscribe(): void } {
    this.assertOpen();
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** 安全关闭：会话转 closed、订阅释放、运行资源回收。 */
  async shutdown(): Promise<void> {
    if (this.isClosedFlag) {
      return;
    }
    this.isClosedFlag = true;
    for (const [sessionId, state] of this.sessionStates) {
      state.status = "closed";
      this.emit({ eventType: "session-status", sessionId, status: "closed" });
    }
    for (const taskIdentifier of [...this.taskMonitors.keys()]) {
      this.stopTaskMonitor(taskIdentifier);
    }
    await Promise.allSettled([...this.inFlightPolls]);
    this.sessionStates.clear();
    this.tasksByTaskIdentifier.clear();
    this.taskIdentifierByIdempotencyKey.clear();
    this.listeners.clear();
    await this.runtime.shutdown();
  }

  /** 权威状态监视器：只有终态发 task-finished，其余状态发 task-status。 */
  private startTaskMonitor(taskIdentifier: string): void {
    if (this.taskMonitors.has(taskIdentifier)) {
      return;
    }
    const timer = setInterval(() => {
      this.trackPoll(this.pollTaskStatus(taskIdentifier));
    }, this.statusPollIntervalMilliseconds);
    timer.unref?.();
    this.taskMonitors.set(taskIdentifier, timer);
    this.trackPoll(this.pollTaskStatus(taskIdentifier));
  }

  private stopTaskMonitor(taskIdentifier: string): void {
    const timer = this.taskMonitors.get(taskIdentifier);
    if (timer !== undefined) {
      clearInterval(timer);
      this.taskMonitors.delete(taskIdentifier);
    }
  }

  private trackPoll(promise: Promise<void>): void {
    this.inFlightPolls.add(promise);
    void promise.finally(() => {
      this.inFlightPolls.delete(promise);
    });
  }

  private isTerminalStatus(status: PublicTaskStatus): boolean {
    return status === "done" || status === "failed" || status === "cancelled";
  }

  /** 权威结果存储：终态时从 Agent 工作存档读取 result 条目摘要。 */
  private async captureAuthoritativeResult(record: TaskRecord): Promise<void> {
    if (record.missionIdentifier === null) {
      return;
    }
    try {
      // mission 终态可能先于 Worker 存档写入到达：有界重试，避免结果预览偶发为空。
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const summaries = await this.runtime.readMissionResultSummaries(
          record.missionIdentifier,
        );
        const lastSummary = summaries.at(-1);
        if (lastSummary !== undefined && lastSummary.summary.length > 0) {
          record.summaryPreview = lastSummary.summary;
          return;
        }
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } catch {
      // 结果读取失败不改变已确认的权威状态
    }
  }

  private async pollTaskStatus(taskIdentifier: string): Promise<void> {
    const record = this.tasksByTaskIdentifier.get(taskIdentifier);
    if (record === undefined || record.missionIdentifier === null || this.isClosedFlag) {
      return;
    }
    if (this.isTerminalStatus(record.status)) {
      return;
    }
    let status: PublicTaskStatus;
    try {
      status = this.mapMissionStatus(
        (await this.runtime.controller.queryMissionStatus(record.missionIdentifier)) as {
          summary?: { status?: string } | null;
          taskChain?: { tasks: Array<{ status: string }> } | null;
        },
      );
    } catch {
      status = "blocked";
    }
    if (this.isClosedFlag || status === record.status) {
      return;
    }
    record.status = status;
    if (this.isTerminalStatus(status)) {
      this.stopTaskMonitor(taskIdentifier);
      await this.captureAuthoritativeResult(record);
      if (this.isClosedFlag) {
        return;
      }
      this.emit({ eventType: "task-finished", taskIdentifier, status });
      return;
    }
    this.emit({ eventType: "task-status", taskIdentifier, status });
  }

  private assertOpen(): void {
    if (this.isClosedFlag) {
      throw new PublicApplicationError("application-closed", "应用已关闭");
    }
  }

  private requireSession(sessionId: string): PublicSessionState {
    const state = this.sessionStates.get(sessionId);
    if (state === undefined) {
      throw new PublicApplicationError("session-not-found", "会话不存在: " + sessionId);
    }
    return state;
  }

  private requireTask(taskIdentifier: string, sessionId: string): TaskRecord {
    const record = this.tasksByTaskIdentifier.get(taskIdentifier);
    if (record === undefined) {
      throw new PublicApplicationError("task-not-found", "任务不存在: " + taskIdentifier);
    }
    if (record.sessionId !== sessionId) {
      throw new PublicApplicationError(
        "session-mismatch",
        "任务不属于该会话: " + taskIdentifier,
      );
    }
    return record;
  }

  private mapMissionStatus(missionStatus: {
    summary?: { status?: string } | null;
    taskChain?: { tasks: Array<{ status: string }> } | null;
  }): PublicTaskStatus {
    const summaryStatus = missionStatus.summary?.status ?? "running";
    if (summaryStatus === "done") {
      return "done";
    }
    if (summaryStatus === "cancelled") {
      return "cancelled";
    }
    if (summaryStatus === "failed") {
      return "failed";
    }
    const tasks = missionStatus.taskChain?.tasks ?? [];
    if (tasks.some((task) => task.status === "blocked" || task.status === "failed")) {
      return "blocked";
    }
    return "running";
  }

  private toTaskResult(taskIdentifier: string, record: TaskRecord): PublicTaskResult {
    return {
      taskIdentifier,
      status: record.status,
      missionIdentifier: record.missionIdentifier,
      summaryPreview: record.summaryPreview,
    };
  }

  private emit(event: PublicAstarrayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不得影响其他订阅者
      }
    }
  }
}
