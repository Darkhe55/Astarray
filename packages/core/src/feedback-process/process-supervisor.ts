/**
 * 反馈进程生命周期监管器（主进程侧，T04）。
 * 负责启动（fork）、健康检查、异常重启、优雅关闭与孤儿清理。
 * 崩溃重启后重放未确认消息；连续崩溃达到上限后停止并报告不可用。
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import type { FeedbackIpcMessage } from "./ipc-protocol.js";
import type { FeedbackMessage } from "../core/types.js";
import { ForkFeedbackClient } from "./transport.js";

export interface FeedbackProcessSupervisorOptions {
  modulePath?: string;
  baseDirectory: string;
  heartbeatTimeoutMilliseconds?: number;
  healthCheckIntervalMilliseconds?: number;
  restartBackoffMilliseconds?: number;
  maximumRestartAttempts?: number;
  shutdownGracePeriodMilliseconds?: number;
}

export const MAXIMUM_RESTART_ATTEMPTS_DEFAULT = 5;
export const HEALTH_CHECK_INTERVAL_MILLISECONDS_DEFAULT = 2_000;
export const RESTART_BACKOFF_MILLISECONDS_DEFAULT = 1_000;
export const SHUTDOWN_GRACE_PERIOD_MILLISECONDS_DEFAULT = 5_000;
export const HEARTBEAT_TIMEOUT_MILLISECONDS_DEFAULT = 30_000;

export class FeedbackProcessSupervisor {
  private childProcess: ChildProcess | null = null;
  private client: ForkFeedbackClient | null = null;
  private isShuttingDown = false;
  private restartAttemptCount = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly modulePath: string;
  private readonly shutdownGracePeriodMilliseconds: number;
  private readonly healthCheckIntervalMilliseconds: number;
  private readonly restartBackoffMilliseconds: number;
  private readonly maximumRestartAttempts: number;
  private readonly heartbeatTimeoutMilliseconds: number;

  constructor(private readonly options: FeedbackProcessSupervisorOptions) {
    this.modulePath =
      options.modulePath ?? defaultFeedbackProcessModulePath();
    this.shutdownGracePeriodMilliseconds =
      options.shutdownGracePeriodMilliseconds ??
      SHUTDOWN_GRACE_PERIOD_MILLISECONDS_DEFAULT;
    this.healthCheckIntervalMilliseconds =
      options.healthCheckIntervalMilliseconds ??
      HEALTH_CHECK_INTERVAL_MILLISECONDS_DEFAULT;
    this.restartBackoffMilliseconds =
      options.restartBackoffMilliseconds ??
      RESTART_BACKOFF_MILLISECONDS_DEFAULT;
    this.maximumRestartAttempts =
      options.maximumRestartAttempts ?? MAXIMUM_RESTART_ATTEMPTS_DEFAULT;
    this.heartbeatTimeoutMilliseconds =
      options.heartbeatTimeoutMilliseconds ??
      HEARTBEAT_TIMEOUT_MILLISECONDS_DEFAULT;
  }

  async start(): Promise<ForkFeedbackClient> {
    this.spawnChildProcess();
    const startedClient = this.client;
    if (startedClient === null) {
      throw new DomainError(
        "feedback-process-unavailable",
        "反馈进程启动失败：客户端未创建",
      );
    }
    await startedClient.waitUntilReady();
    this.startHealthCheckLoop();
    return startedClient;
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHealthCheckLoop();
    const activeClient = this.client;
    const activeChild = this.childProcess;
    if (activeClient !== null) {
      await activeClient.shutdown();
    }
    if (activeChild !== null) {
      await waitForProcessExit(activeChild, this.shutdownGracePeriodMilliseconds);
    }
    this.childProcess = null;
    this.client = null;
  }

  getClient(): ForkFeedbackClient | null {
    return this.client;
  }

  getChildProcess(): ChildProcess | null {
    return this.childProcess;
  }

  getRestartAttemptCount(): number {
    return this.restartAttemptCount;
  }

  private readonly messageHandlers: Array<
    (message: FeedbackMessage) => Promise<void> | void
  > = [];

  /**
   * 注册投递处理器。处理器在每次（重）启动的客户端上自动重注册，
   * 保证反馈进程崩溃重启后投递仍可达消费者。
   */
  onMessage(handler: (message: FeedbackMessage) => Promise<void> | void): void {
    this.messageHandlers.push(handler);
    this.client?.onMessage(handler);
  }

  private spawnChildProcess(): void {
    const childProcess = fork(this.modulePath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, ASTARRAY_FEEDBACK_CHILD: "1" },
    });
    this.childProcess = childProcess;
    const client = new ForkFeedbackClient(childProcess);
    this.client = client;
    for (const handler of this.messageHandlers) {
      client.onMessage(handler);
    }

    childProcess.on("message", (message: FeedbackIpcMessage) => {
      client.handleInboundMessage(message);
    });
    childProcess.on("error", (error) => {
      if (this.childProcess === childProcess) {
        this.handleChildProcessFailure(error);
      }
    });
    childProcess.on("exit", (exitCode, exitSignal) => {
      if (this.childProcess === childProcess) {
        this.handleChildProcessExit(exitCode, exitSignal);
      }
    });

    client.sendHello(
      this.options.baseDirectory,
      this.heartbeatTimeoutMilliseconds,
    );
  }

  private handleChildProcessExit(
    exitCode: number | null,
    exitSignal: string | null,
  ): void {
    if (this.isShuttingDown) {
      return;
    }
    this.handleChildProcessFailure(
      new Error(
        `反馈进程异常退出（code=${exitCode ?? "null"}, signal=${exitSignal ?? "null"}）`,
      ),
    );
  }

  private handleChildProcessFailure(error: Error): void {
    if (this.isShuttingDown) {
      return;
    }
    process.stderr.write(`astarray: 反馈进程故障 - ${error.message}\n`);
    const failedChild = this.childProcess;
    this.childProcess = null;
    this.client = null;
    if (failedChild !== null && failedChild.exitCode === null) {
      failedChild.kill("SIGKILL");
    }
    this.restartAttemptCount += 1;
    if (this.restartAttemptCount > this.maximumRestartAttempts) {
      this.stopHealthCheckLoop();
      return;
    }
    const backoffMilliseconds =
      this.restartBackoffMilliseconds * this.restartAttemptCount;
    setTimeout(() => {
      if (this.isShuttingDown) {
        return;
      }
      this.spawnChildProcess();
      void this.client?.waitUntilReady().then(() => {
        void this.client?.requestReplay("*").catch(() => {});
      });
    }, backoffMilliseconds);
  }

  private startHealthCheckLoop(): void {
    this.stopHealthCheckLoop();
    this.healthCheckInterval = setInterval(() => {
      const activeClient = this.client;
      if (activeClient === null) {
        return;
      }
      if (activeClient.isDisconnected()) {
        this.handleChildProcessFailure(
          new Error("反馈进程健康检查失败：IPC 断开"),
        );
        return;
      }
      void activeClient.queryHealth().catch(() => {
        this.handleChildProcessFailure(
          new Error("反馈进程健康检查失败：请求超时"),
        );
      });
    }, this.healthCheckIntervalMilliseconds);
  }

  private stopHealthCheckLoop(): void {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}

async function waitForProcessExit(
  childProcess: ChildProcess,
  gracePeriodMilliseconds: number,
): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      childProcess.kill("SIGKILL");
      resolve();
    }, gracePeriodMilliseconds);
    childProcess.once("exit", () => {
      clearTimeout(timeoutHandle);
      resolve();
    });
  });
}

function defaultFeedbackProcessModulePath(): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  return path.join(
    path.dirname(currentModulePath),
    "feedback-process-entry.js",
  );
}
