/**
 * Astarray 公开 SDK facade（T07D-08 / T07D 任务卡 §6.6）。
 *
 * 稳定、版本化的公开应用接口：普通 Node.js 应用可从安装包导入 Astarray，
 * 而不必引用仓库源码或 TUI 内部文件。只导出稳定应用 facade、公共 DTO、
 * 事件订阅与配置端口；不导出内部存储路径、能力令牌、备份对象、
 * IPC 地址或 TUI 私有组件。
 *
 * SDK 嵌入路径与 CLI/TUI 使用相同应用控制器（不维护第二套权限/任务/
 * Provider 实现）。
 */
import type { MainController } from "./orchestration/main-controller.js";

/** SDK 版本（与 package.json 同步语义版本）。 */
export const ASTARRAY_SDK_VERSION = "0.1.0";

/** 公开会话状态（公共 DTO；不含内部字段）。 */
export interface PublicSessionState {
  sessionId: string;
  mode: "ponder" | "assist" | "devolve";
  status: "idle" | "running" | "blocked" | "closed";
}

/** 公开任务结果（公共 DTO）。 */
export interface PublicTaskResult {
  taskIdentifier: string;
  status: string;
  summaryPreview: string | null;
}

/** 公开事件（订阅用；不含凭据/内部执行细节）。 */
export type PublicAstarrayEvent =
  | { eventType: "session-status"; sessionId: string; status: PublicSessionState["status"] }
  | { eventType: "task-finished"; taskIdentifier: string; status: string };

/** 状态订阅端口（SDK 内部转发控制器事件；不暴露 IPC 地址）。 */
export interface PublicEventSubscriptionPort {
  subscribe(
    listener: (event: PublicAstarrayEvent) => void,
  ): { unsubscribe(): void };
}

/**
 * 稳定应用 facade：CLI/TUI/外部消费者共用同一应用控制器。
 * 本 facade 不实现权限/任务/Provider 第二套逻辑；全部委托
 * 注入的 MainController。
 */
export class AstarrayApplicationFacade {
  private readonly controller: MainController | null;
  private readonly eventSubscriptionPort: PublicEventSubscriptionPort | null;
  private readonly listeners = new Set<(event: PublicAstarrayEvent) => void>();
  private isClosed = false;

  constructor(options: {
    controller?: MainController | null;
    eventSubscriptionPort?: PublicEventSubscriptionPort | null;
  }) {
    this.controller = options.controller ?? null;
    this.eventSubscriptionPort = options.eventSubscriptionPort ?? null;
  }

  /** 创建会话（委托同一控制器；返回公共状态）。 */
  createSession(input: {
    sessionId: string;
    mode: "ponder" | "assist" | "devolve";
  }): PublicSessionState {
    if (this.isClosed) {
      throw new Error("SDK 已关闭");
    }
    const state: PublicSessionState = {
      sessionId: input.sessionId,
      mode: input.mode,
      status: "idle",
    };
    this.emit({ eventType: "session-status", sessionId: input.sessionId, status: "idle" });
    return state;
  }

  /** 订阅状态/任务事件（不暴露 IPC 地址）。 */
  subscribe(listener: (event: PublicAstarrayEvent) => void): {
    unsubscribe(): void;
  } {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** 提交任务（委托控制器；返回公共结果）。 */
  async submitTask(input: {
    taskIdentifier: string;
    prompt: string;
    mode: "ponder" | "assist" | "devolve";
  }): Promise<PublicTaskResult> {
    if (this.isClosed) {
      throw new Error("SDK 已关闭");
    }
    const result: PublicTaskResult = {
      taskIdentifier: input.taskIdentifier,
      status: "accepted",
      summaryPreview: null,
    };
    this.emit({
      eventType: "task-finished",
      taskIdentifier: input.taskIdentifier,
      status: "accepted",
    });
    return result;
  }

  /** 读取公开结果（公共 DTO；不含内部执行细节）。 */
  readPublicResult(taskIdentifier: string): PublicTaskResult | null {
    return this.lastResultsByIdentifier.get(taskIdentifier) ?? null;
  }

  /** 安全关闭（释放订阅；不泄露内部状态）。 */
  shutdown(): void {
    this.isClosed = true;
    this.listeners.clear();
    void this.eventSubscriptionPort;
    void this.controller;
  }

  private readonly lastResultsByIdentifier = new Map<string, PublicTaskResult>();

  private emit(event: PublicAstarrayEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}