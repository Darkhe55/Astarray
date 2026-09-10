/**
 * T09A/AR-07：MainController 控制面门面装配分支覆盖。
 * 以最小 fake 依赖构造控制器，覆盖"未装配→抛错/空值"与"已装配→委托"两条路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentStatus, FeedbackTransportPort, ToolPort, TransportHealth } from "../../../packages/core/src/core/types.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { MainController } from "../../../packages/core/src/orchestration/main-controller.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mc-facade-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function buildController(extraOptions: Record<string, unknown> = {}): MainController {
  const modeMachine = new ModeMachine("assist");
  const sessionManager = new SessionAuthorizationManager();
  const taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  const missionManager = new MissionManager(taskStore, temporaryDirectory);
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  const feedbackTransport: FeedbackTransportPort = {
    onMessage: () => {},
    enqueue: async () => {},
    queryHealth: async (): Promise<TransportHealth> => ({
      isHealthy: true,
      processPid: 0,
      protocolVersion: 1,
      queuedMessageCount: 0,
    }),
    shutdown: async () => {},
    setAgentStatus: (_recipientId: string, _status: AgentStatus) => {},
  };
  return new MainController({
    modeMachine,
    sessionManager,
    taskStore,
    missionManager,
    registry,
    feedbackTransport,
    workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    concurrency: 1,
    failureThreshold: 3,
    maxLoopIterations: 3,
    mainRuntimeFactory: () => ({ run: async function* () {} }) as never,
    workerRuntimeFactory: () => ({ run: async function* () {} }) as never,
    buildWorkerToolPort: (): ToolPort => ({ execute: async () => ({ kind: "success", callId: "c", outputText: "ok", isSideEffectFree: true }) }),
    buildPermissionExplanation: () => "说明",
    streamOutput: () => {},
    ...extraOptions,
  });
}

describe("MainController 门面装配分支（AR-07）", () => {
  it("未装配的门面返回空值或抛出明确错误", async () => {
    const controller = buildController();
    expect(controller.getMainAgentToolProjection()).toEqual([]);
    expect(controller.getSecondaryDispatchLoop()).toBeNull();
    expect(controller.getTertiaryLifecycleController()).toBeNull();
    expect(controller.getTertiaryRuntimeComponents()).toBeNull();
    expect(controller.getT08cRoutingFacade()).toBeNull();
    expect(await controller.listReportIndex("mission-x")).toEqual([]);
    expect(await controller.listSessionElevations("session-x")).toEqual([]);
    expect(await controller.getCurrentPermissionProfileReference()).toBeNull();
    await expect(
      controller.switchPermissionProfile({
        permissionProfileId: "p",
        displayName: "p",
        isBuiltin: false,
        revision: 1,
        catalogVersion: 1,
      } as never),
    ).rejects.toThrow("当前权限组选择存储未装配");
    await expect(
      controller.createSessionElevation({
        sessionId: "s",
        agentInstanceId: null,
        capabilityId: "project.read",
        resourceScope: null,
        elevatedDecision: "allow",
        expiresAtIso: "2026-09-10T00:00:00.000Z",
        userDecisionReference: "d",
        currentSessionPermissionRevision: 1,
      } as never),
    ).rejects.toThrow("会话提升控制面未装配");
    await expect(
      controller.revokeSessionElevation({ sessionId: "s", elevationId: "e" }),
    ).rejects.toThrow("会话提升控制面未装配");
    await expect(controller.shutdownSession({ sessionId: "s", exportPath: null })).rejects.toThrow(
      "会话关闭协调器未装配",
    );
    await expect(
      controller.submitTaskInsertionProposal({} as never),
    ).rejects.toThrow("对话任务插入控制面未装配");
    expect(() =>
      controller.registerAgent({
        agentInstanceId: "a",
        agentRole: "tertiary",
        missionId: "m",
        owningSecondaryAgentInstanceId: null,
        boundTaskBundleId: null,
      }),
    ).toThrow("Agent 注册目录未装配");
    await expect(controller.ingestTertiaryTerminalReport({} as never)).rejects.toThrow(
      "报告索引未装配",
    );
  });

  it("已装配门面委托到具体组件（投影/循环/生命周期/路由/报告/注册）", async () => {
    const projection = { projectTools: vi.fn(() => ["readFile"]) };
    const dispatchLoop = { identifier: "loop" };
    const lifecycle = { identifier: "lifecycle" };
    const runtimeComponents = { identifier: "runtime" };
    const routingFacade = { identifier: "routing" };
    const directory = { registerAgent: vi.fn() };
    const ingestor = {
      ingestReport: vi.fn(async () => {}),
      readIndex: vi.fn(() => [{ reportIdentifier: "r1" }]),
    };
    const controller = buildController({
      mainAgentReadonlyProjection: projection,
      secondaryDispatchLoop: dispatchLoop,
      tertiaryLifecycleController: lifecycle,
      tertiaryRuntimeComponents: runtimeComponents,
      t08cRoutingFacade: routingFacade,
      registeredAgentDirectory: directory,
      reportArchiveIngestor: ingestor,
    });
    expect(controller.getMainAgentToolProjection()).toEqual(["readFile"]);
    expect(controller.getSecondaryDispatchLoop()).toBe(dispatchLoop);
    expect(controller.getTertiaryLifecycleController()).toBe(lifecycle);
    expect(controller.getTertiaryRuntimeComponents()).toBe(runtimeComponents);
    expect(controller.getT08cRoutingFacade()).toBe(routingFacade);
    expect(await controller.listReportIndex("mission-x")).toEqual([{ reportIdentifier: "r1" }]);
    controller.registerAgent({
      agentInstanceId: "a-1",
      agentRole: "tertiary",
      missionId: "m-1",
      owningSecondaryAgentInstanceId: null,
      boundTaskBundleId: null,
    });
    expect(directory.registerAgent).toHaveBeenCalledTimes(1);
    await controller.ingestTertiaryTerminalReport({ reportIdentifier: "r2" } as never);
    expect(ingestor.ingestReport).toHaveBeenCalledTimes(1);
  });

  it("模式与指标门面：当前模式可读、非法迁移抛错、指标未配置返回 null", () => {
    const controller = buildController();
    expect(controller.getCurrentMode()).toBe("assist");
    expect(controller.getMetricsSnapshot()).toBeNull();
    expect(() => controller.transitionMode("assist")).not.toThrow();
  });

  it("权限组选择：存储为空回退注入默认；有选择返回其引用；切换携带当前 revision", async () => {
    const fallbackReference = {
      permissionProfileId: "custom:fallback",
      displayName: "fallback",
      isBuiltin: false,
      revision: 1,
      catalogVersion: 1,
    };
    const controllerWithFallback = buildController({
      currentPermissionProfileReference: fallbackReference,
    });
    expect(await controllerWithFallback.getCurrentPermissionProfileReference()).toBe(
      fallbackReference,
    );

    const switchSelection = vi.fn(async () => {});
    const selectionReference = {
      permissionProfileId: "builtin:assist",
      displayName: "assist",
      isBuiltin: true,
      revision: 3,
      catalogVersion: 1,
    };
    const controllerWithSelection = buildController({
      currentPermissionSelectionStore: {
        readSelection: async () => ({ selectedReference: selectionReference, revision: 3 }),
        switchSelection,
      },
    });
    expect(await controllerWithSelection.getCurrentPermissionProfileReference()).toBe(
      selectionReference,
    );
    await controllerWithSelection.switchPermissionProfile(selectionReference as never);
    expect(switchSelection).toHaveBeenCalledWith({
      selectedReference: selectionReference,
      expectedRevision: 3,
    });
  });

  it("会话提升：方向错误拒绝；成功路径按个体/会话作用域创建", async () => {
    const profileStore = {
      readProfile: async () => ({
        capabilityDecisions: { "project.read": "allow" },
        fallbackDecision: "deny",
        revision: 5,
        catalogVersion: 1,
      }),
    };
    const createElevation = vi.fn(async (input: Record<string, unknown>) => ({
      elevationId: "elev-1",
      originalDecision: input.originalDecision,
      elevatedDecision: input.elevatedDecision,
    }));
    const base = {
      sessionId: "s-1",
      agentInstanceId: null,
      capabilityId: "project.read",
      resourceScope: null as unknown as string,
      elevatedDecision: "allow",
      expiresAtIso: "2026-09-10T00:00:00.000Z",
      userDecisionReference: "d-1",
      currentSessionPermissionRevision: 1,
    };
    const controller = buildController({
      currentPermissionProfileReference: {
        permissionProfileId: "builtin:assist",
        displayName: "assist",
        isBuiltin: true,
        revision: 5,
        catalogVersion: 1,
      },
      permissionProfileStore: profileStore,
      sessionElevationController: { createElevation },
    });
    await expect(
      controller.createSessionElevation({ ...base, elevatedDecision: "ask" } as never),
    ).rejects.toThrow("提升方向必须更宽");

    const sessionScoped = await controller.createSessionElevation({
      ...base,
      capabilityId: "project.modify",
    } as never);
    expect(sessionScoped.elevationId).toBe("elev-1");
    expect(createElevation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: { scope: "all-secondary-agents-in-session" },
        originalDecision: "deny",
      }),
    );

    const individualScoped = await controller.createSessionElevation({
      ...base,
      agentInstanceId: "agent-9",
      capabilityId: "project.modify",
    } as never);
    expect(individualScoped.elevationId).toBe("elev-1");
    expect(createElevation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: { scope: "specific-secondary-agent", agentInstanceId: "agent-9" },
      }),
    );
  });
});
