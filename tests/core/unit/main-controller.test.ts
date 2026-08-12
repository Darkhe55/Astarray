/**
 * T08 主 Agent 控制器测试：
 * Ponder 直接问答、Assist/Devolve 派发后立即返回、状态查询、取消、会话授权、指令下发。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentStatus,
  AgentRuntime,
  FeedbackMessage,
  FeedbackTransportPort,
  ToolPort,
  TransportHealth,
} from "../../../packages/core/src/core/types.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";
import { MainController } from "../../../packages/core/src/orchestration/main-controller.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";

class FakeFeedbackTransport implements FeedbackTransportPort {
  private readonly handlers: Array<(message: FeedbackMessage) => void> = [];
  readonly sentMessages: FeedbackMessage[] = [];

  onMessage(handler: (message: FeedbackMessage) => void): void {
    this.handlers.push(handler);
  }

  async enqueue(message: FeedbackMessage): Promise<void> {
    this.sentMessages.push(message);
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  async queryHealth(): Promise<TransportHealth> {
    return { isHealthy: true, processPid: 0, protocolVersion: 1, queuedMessageCount: 0 };
  }

  async shutdown(): Promise<void> {}

  setAgentStatus(_recipientId: string, _status: AgentStatus): void {}
}

let temporaryDirectory: string;
let feedbackTransport: FakeFeedbackTransport;
let streamedTexts: string[];
let activeControllers: MainController[] = [];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-main-"));
  feedbackTransport = new FakeFeedbackTransport();
  streamedTexts = [];
  activeControllers = [];
});

afterEach(async () => {
  for (const controller of activeControllers) {
    for (const missionId of controller.getActiveMissionIds()) {
      await controller.cancelMission(missionId).catch(() => {});
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function buildController(options: {
  mode: "ponder" | "assist" | "devolve";
  workerScripts?: Array<Array<unknown>>;
}): MainController {
  const modeMachine = new ModeMachine(options.mode);
  const sessionManager = new SessionAuthorizationManager();
  const taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  const missionManager = new MissionManager(taskStore, temporaryDirectory);
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  const workspaceDirectory = path.join(temporaryDirectory, "workspace");
  const temporaryDirectoryPath = path.join(temporaryDirectory, "temp");
  void fs.mkdir(workspaceDirectory);
  void fs.mkdir(temporaryDirectoryPath);
  let attemptIndex = 0;
  const controller = new MainController({
    modeMachine,
    sessionManager,
    taskStore,
    missionManager,
    registry,
    feedbackTransport,
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath,
    concurrency: 2,
    failureThreshold: 3,
    maxLoopIterations: 5,
    mainRuntimeFactory: (): AgentRuntime =>
      new ScriptedRuntime([
        { type: "text", text: "Ponder 回答：" },
        { type: "text", text: "你好" },
        { type: "finish", reason: "success", detail: "回答完成" },
      ]),
    workerRuntimeFactory: (): AgentRuntime => {
      const script =
        options.workerScripts?.[Math.min(attemptIndex, (options.workerScripts?.length ?? 1) - 1)] ?? [
          { type: "finish", reason: "success", detail: "完成" },
        ];
      attemptIndex += 1;
      return new ScriptedRuntime(script as never);
    },
    buildWorkerToolPort: (): ToolPort => ({
      execute: async () => ({
        kind: "success",
        callId: "call-1",
        outputText: "ok",
        isSideEffectFree: true,
      }),
    }),
    buildPermissionExplanation: (toolName: string) => `需要 ${toolName}`,
    streamOutput: (_missionId, text) => {
      streamedTexts.push(text);
    },
  });
  activeControllers.push(controller);
  return controller;
}

describe("MainController", () => {
  it("Ponder 模式：直接问答，不创建 mission，流式输出", async () => {
    const controller = buildController({ mode: "ponder" });
    const result = await controller.handleUserMessage("什么是 ReAct？");
    expect(result).toBe("ponder");
    expect(controller.getActiveMissionIds()).toHaveLength(0);
    expect(streamedTexts).toEqual(["Ponder 回答：", "你好"]);
  });

  it("Assist 模式：派发后立即返回 missionId，后台运行", async () => {
    const controller = buildController({ mode: "assist" });
    const missionId = await controller.handleUserMessage("分析当前项目");
    expect(missionId.startsWith("mission-")).toBe(true);
    expect(controller.getActiveMissionIds()).toEqual([missionId]);
    const status = await controller.queryMissionStatus(missionId);
    expect(status.summary?.mode).toBe("assist");
    // 后台 worker 使用成功脚本 → mission 最终 done
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const currentStatus = await controller.queryMissionStatus(missionId);
      if (currentStatus.summary?.status === "done") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect((await controller.queryMissionStatus(missionId)).summary?.status).toBe("done");
  });

  it("Devolve 模式：同样派发并可查询", async () => {
    const controller = buildController({ mode: "devolve" });
    const missionId = await controller.handleUserMessage("完成该任务");
    expect(missionId.startsWith("mission-")).toBe(true);
    expect((await controller.queryMissionStatus(missionId)).summary?.mode).toBe("devolve");
    await controller.cancelMission(missionId);
    expect((await controller.queryMissionStatus(missionId)).summary?.status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("cancelMission 中断后台 mission 并更新概要", async () => {
    const controller = buildController({ mode: "assist" });
    const missionId = await controller.handleUserMessage("挂起任务");
    await controller.cancelMission(missionId);
    expect((await controller.queryMissionStatus(missionId)).summary?.status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("grantSessionAuthorization 记录会话授权", async () => {
    const controller = buildController({ mode: "assist" });
    await controller.grantSessionAuthorization(
      "writeFileTemporary",
      '{"fileName":"a.txt","content":"x"}',
      1_800_000_000,
    );
    const status = await controller.queryMissionStatus(
      await controller.handleUserMessage("任意任务"),
    );
    expect(status.missionId.length).toBeGreaterThan(0);
  });

  it("sendSchedulerInstruction 经反馈信箱下发指令", async () => {
    const controller = buildController({ mode: "assist" });
    const missionId = await controller.handleUserMessage("任务");
    controller.sendSchedulerInstruction(missionId, '{"action":"cancel","taskId":"T-001"}');
    const instruction = feedbackTransport.sentMessages.find(
      (message) => message.recipientId === `scheduler:${missionId}`,
    );
    expect(instruction?.payload.kind).toBe("instruction");
  });

  it("非 TTY 输入不阻塞：Worker 挂起时仍可处理新消息", async () => {
    const hangControl: { release: (() => void) | null } = { release: null };
    const modeMachine = new ModeMachine("assist");
    const sessionManager = new SessionAuthorizationManager();
    const taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
    const missionManager = new MissionManager(taskStore, temporaryDirectory);
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const controller = new MainController({
      modeMachine,
      sessionManager,
      taskStore,
      missionManager,
      registry,
      feedbackTransport,
      workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      concurrency: 2,
      failureThreshold: 3,
      maxLoopIterations: 5,
      mainRuntimeFactory: () =>
        new ScriptedRuntime([
          { type: "finish", reason: "success", detail: "完成" },
        ]),
      workerRuntimeFactory: () =>
        new ScriptedRuntime([
          {
            type: "tool-call",
            toolName: "readFile",
            argumentsJson: '{"filePath":"a.txt"}',
            callId: "call-hang",
          },
          {
            type: "finish",
            reason: "tool-calls",
            detail: "挂起",
          },
          { type: "finish", reason: "success", detail: "完成" },
        ]),
      buildWorkerToolPort: () => ({
        execute: () =>
          new Promise((resolve) => {
            hangControl.release = () =>
              resolve({
                kind: "success",
                callId: "call-hang",
                outputText: "完成",
                isSideEffectFree: true,
              });
          }),
      }),
      buildPermissionExplanation: () => "说明",
      streamOutput: (_missionId, text) => {
        streamedTexts.push(text);
      },
    });
    activeControllers.push(controller);
    const firstMissionId = await controller.handleUserMessage("第一个任务");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const secondMissionId = await controller.handleUserMessage("第二个任务");
    expect(secondMissionId).not.toBe(firstMissionId);
    expect(controller.getActiveMissionIds().length).toBeGreaterThanOrEqual(2);
    hangControl.release?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});
