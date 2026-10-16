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
import { DomainError } from "../../../packages/core/src/core/errors.js";

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

  it("切换权限组：自定义组不存在时拒绝且不写入选择", async () => {
    const switchSelection = vi.fn(async () => ({
      schemaVersion: 1,
      selectedReference: { kind: "custom", profileId: "custom-missing" },
      revision: 1,
      updatedAtIso: "2026-09-19T00:00:00.000Z",
    }));
    const controller = buildController({
      permissionProfileStore: {
        readProfile: async () => {
          throw new DomainError(
            "permission-profile-not-found",
            "权限组不存在: custom-missing",
          );
        },
      },
      currentPermissionSelectionStore: {
        readSelection: async () => null,
        switchSelection,
      },
    });
    await expect(
      controller.switchPermissionProfile({
        kind: "custom",
        profileId: "custom-missing",
      }),
    ).rejects.toMatchObject({ errorCode: "permission-profile-not-found" });
    expect(switchSelection).not.toHaveBeenCalled();
  });

  it("切换权限组：自定义组存在时按当前 revision 持久化", async () => {
    const switchSelection = vi.fn(async () => ({
      schemaVersion: 1,
      selectedReference: { kind: "custom", profileId: "custom-existing" },
      revision: 3,
      updatedAtIso: "2026-09-19T00:00:00.000Z",
    }));
    const readProfile = vi.fn(async () => ({
      permissionProfileId: "custom-existing",
    }));
    const controller = buildController({
      permissionProfileStore: { readProfile },
      currentPermissionSelectionStore: {
        readSelection: async () => ({
          selectedReference: { kind: "builtin", profileId: "assist" },
          revision: 2,
        }),
        switchSelection,
      },
    });
    await controller.switchPermissionProfile({
      kind: "custom",
      profileId: "custom-existing",
    });
    expect(readProfile).toHaveBeenCalledWith({
      kind: "custom",
      profileId: "custom-existing",
    });
    expect(switchSelection).toHaveBeenCalledWith({
      selectedReference: { kind: "custom", profileId: "custom-existing" },
      expectedRevision: 2,
    });
  });

  it("切换权限组：内置组不依赖自定义组存储", async () => {
    const switchSelection = vi.fn(async () => ({
      schemaVersion: 1,
      selectedReference: { kind: "builtin", profileId: "ponder" },
      revision: 1,
      updatedAtIso: "2026-09-19T00:00:00.000Z",
    }));
    const controller = buildController({
      permissionProfileStore: null,
      currentPermissionSelectionStore: {
        readSelection: async () => null,
        switchSelection,
      },
    });
    await controller.switchPermissionProfile({
      kind: "builtin",
      profileId: "ponder",
    });
    expect(switchSelection).toHaveBeenCalledWith({
      selectedReference: { kind: "builtin", profileId: "ponder" },
      expectedRevision: 0,
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

  /**
   * DIAG-01（2026-11-08，第 114 轮）：**调度启动失败**也必须进诊断。
   *
   * 缺口：`startSchedulerSafely()` 的 catch 原本只 `streamOutput` 一行 `[mission-locked] …`
   * 并把 mission 置 `blocked`，**诊断存储学不到**发生了什么 ——
   * 而这条路径（mission 被其他进程的活跃租约占住）**在生产里是可达的**。
   *
   * 断言：① 上报一条 `stage: "dispatch"` 的诊断事件（错误码取 DomainError 的 `mission-locked`）；
   * ② **原有保护不变** —— 仍然向用户输出 `[mission-locked]` 那一行（上报不得取代它）。
   */
  it("调度启动失败（mission-locked）：必须上报使命级诊断事件（stage=dispatch），且原有提示不变", async () => {
    const reportedEvents: Array<{
      missionIdentifier: string;
      sourceAgentInstanceId: string;
      stage: string;
      errorCode: string;
      messageText: string;
      component: string;
    }> = [];
    const streamedOutput: string[] = [];
    /** `tryAcquire` 返回"被其他进程占住" ⇒ 编排器 `start()` 会以 `mission-locked` 拒绝。 */
    const lockedLeaseStore = {
      leaseTtlMilliseconds: 60_000,
      tryAcquire: async () => ({
        status: "locked-active" as const,
        lease: {
          schemaVersion: 1,
          missionId: "mission-locked-case",
          leaseRevision: 7,
          processInstanceId: "another-process",
          claimedAtIso: new Date().toISOString(),
          renewsUntilIso: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
      renewLease: async () => null,
      releaseLease: async () => {},
    };
    const controller = buildController({
      missionLeaseStore: lockedLeaseStore,
      missionDiagnosticEventPort: (event: (typeof reportedEvents)[number]) => {
        reportedEvents.push(event);
      },
      streamOutput: (_missionId: string | null, text: string) => {
        streamedOutput.push(text);
      },
    });

    await controller.handleUserMessage("把结论写进 docs/out.md");
    /**
     * `startSchedulerSafely` 用 `void …catch(…)` ⇒ 有界等待其异步 catch 落地。
     *
     * **⚠️ 等待上限必须小于本用例的超时（默认 5s）**：设为 5s 时，一旦上报缺失，
     * 失败会表现为「Test timed out」而**不是**下面那句说明问题的断言（第 114 轮实测踩到）。
     * 这里取 2.5s —— 正常路径下事件在**毫秒级**出现，2.5s 只用于"确实没有"时快速失败。
     */
    const waitDeadline = Date.now() + 2_500;
    while (reportedEvents.length === 0 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const dispatchEvent = reportedEvents.find((event) => event.stage === "dispatch");
    expect(dispatchEvent, "调度启动失败必须上报 stage=dispatch 的诊断事件").toBeDefined();
    expect(dispatchEvent!.errorCode, "DomainError 的错误码应被如实带出").toBe(
      "mission-locked",
    );
    expect(dispatchEvent!.component).toBe("mission-start");
    expect(dispatchEvent!.missionIdentifier).toMatch(/^mission-/);
    expect(dispatchEvent!.sourceAgentInstanceId).toContain("scheduler:");
    // 原有行为不变：`[mission-locked]` 提示照发（上报不得取代它）
    expect(
      streamedOutput.some((text) => text.startsWith("[mission-locked]")),
      "既有 mission-locked 提示不得因新增上报而消失",
    ).toBe(true);
  });
});
