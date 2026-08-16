/**
 * T08B 单测：工具说明回访、无产品数量配额与受权通信转交（ADR-0024）。
 * 覆盖：回执（首次完整/同 revision 固定提醒/revision 变化 delta/新个体不继承）、
 * 帮助请求（schema/语义/幂等/预算/直接回复/known-but-not-usable/missing-tool/
 * 不泄露 schema/不授权）、无配额注册表（历史总数不拒绝/排队暂停/回收）、
 * 通信转交（层级校验/句柄不透明/投递前失效全条件/不可转授）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ToolDocumentationReceiptStore,
  ToolDocumentationRecallInjector,
  buildFullDocumentation,
  buildReminderText,
} from "../../../packages/core/src/tools/tool-documentation-recall.js";
import type { ToolPublicDocumentation } from "../../../packages/core/src/tools/tool-documentation-recall.js";
import {
  ToolDocumentationRecallController,
  validateToolHelpRequest,
} from "../../../packages/core/src/tools/tool-help-recall-controller.js";
import type { ToolHelpRequestV1 } from "../../../packages/core/src/tools/tool-help-recall-controller.js";
import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";
import {
  AgentCommunicationDelegationController,
  DelegatedAgentCommunicationGrantStore,
} from "../../../packages/core/src/orchestration/agent-communication-delegation.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08b-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeTool(toolIdentifier: string): ToolPublicDocumentation {
  return {
    toolIdentifier,
    purpose: `${toolIdentifier} 的用途`,
    inputSchemaJson: '{"type":"object"}',
    returnSchemaJson: '{"type":"string"}',
    examples: [`调用 ${toolIdentifier}`],
    failureCodes: ["tool-execution-failed"],
    isIdempotent: true,
    sideEffectCategory: "none",
    requiredCapabilities: ["project.read"],
    limitations: ["仅工作区"],
  };
}

function makeHelpRequest(
  overrides: Partial<ToolHelpRequestV1> = {},
): ToolHelpRequestV1 {
  return {
    controlEventType: "ASTARRAY_TOOL_HELP_REQUEST_V1",
    requestIdentifier: "req-1",
    taskExecutionIdentifier: "task-exec-1",
    requestKind: "usage-help",
    toolIdentifier: "readFile",
    capabilityIntent: "读取文件",
    blockingReason: "forgot-usage",
    knownToolGroupRevision: 1,
    ...overrides,
  };
}

describe("ToolDocumentationReceiptStore / Injector", () => {
  it("首次完整注入；同 revision 连续激活只发固定提醒", async () => {
    const store = new ToolDocumentationReceiptStore({ baseDirectory: temporaryDirectory });
    const injector = new ToolDocumentationRecallInjector(store);
    const documentation = buildFullDocumentation({
      toolGroupIdentifier: "group-1",
      toolGroupRevision: 1,
      assignedTools: [makeTool("readFile"), makeTool("listDirectory")],
    });
    const first = await injector.planInjection({
      agentInstanceId: "tertiary-a",
      documentation,
      isDeltaProvenComplete: true,
    });
    expect(first.kind).toBe("initial-full");
    await injector.recordDelivery({
      agentInstanceId: "tertiary-a",
      documentation,
    });
    // 同 revision 100 次 → 只发提醒
    for (let index = 0; index < 100; index++) {
      const next = await injector.planInjection({
        agentInstanceId: "tertiary-a",
        documentation,
        isDeltaProvenComplete: true,
      });
      expect(next.kind).toBe("subsequent-reminder");
    }
    expect(buildReminderText()).toContain("ASTARRAY_TOOL_HELP_REQUEST_V1");
  });

  it("新个体不继承回执（同级不共享）；revision 变化走 delta 或完整重发", async () => {
    const store = new ToolDocumentationReceiptStore({ baseDirectory: temporaryDirectory });
    const injector = new ToolDocumentationRecallInjector(store);
    const documentationV1 = buildFullDocumentation({
      toolGroupIdentifier: "group-1",
      toolGroupRevision: 1,
      assignedTools: [makeTool("readFile")],
    });
    await injector.recordDelivery({
      agentInstanceId: "tertiary-a",
      documentation: documentationV1,
    });
    // 新个体（同级）→ 首次完整
    const newAgent = await injector.planInjection({
      agentInstanceId: "tertiary-b",
      documentation: documentationV1,
      isDeltaProvenComplete: true,
    });
    expect(newAgent.kind).toBe("initial-full");
    // revision 变化 + delta 可证明完整 → delta
    const documentationV2 = buildFullDocumentation({
      toolGroupIdentifier: "group-1",
      toolGroupRevision: 2,
      assignedTools: [makeTool("readFile"), makeTool("searchProjectText")],
    });
    const delta = await injector.planInjection({
      agentInstanceId: "tertiary-a",
      documentation: documentationV2,
      deltaDocumentation: [makeTool("searchProjectText")],
      isDeltaProvenComplete: true,
    });
    expect(delta.kind).toBe("delta");
    // delta 无法证明完整 → 完整重发
    const fullResend = await injector.planInjection({
      agentInstanceId: "tertiary-a",
      documentation: documentationV2,
      deltaDocumentation: [makeTool("searchProjectText")],
      isDeltaProvenComplete: false,
    });
    expect(fullResend.kind).toBe("initial-full");
    // 登记 v2 送达后回执记录组 revision 与完整哈希
    await injector.recordDelivery({
      agentInstanceId: "tertiary-a",
      documentation: documentationV2,
    });
    const receipt = await store.readReceipt("tertiary-a", "group-1");
    expect(receipt?.toolGroupRevision).toBe(2);
    expect(receipt?.fullDocumentationHash).toMatch(/^sha256:/);
  });
});

describe("ToolDocumentationRecallController", () => {
  function makeController(overrides: {
    assignedToolIdentifiers?: Set<string>;
    escalationSink?: (escalation: unknown) => void;
    maxRequestsPerAgent?: number;
    currentToolGroupRevision?: number;
  } = {}) {
    const documentation = new Map<string, ToolPublicDocumentation>();
    documentation.set("readFile", makeTool("readFile"));
    return new ToolDocumentationRecallController({
      assignedToolDocumentation: documentation,
      assignedToolIdentifiers:
        overrides.assignedToolIdentifiers ?? new Set(["readFile"]),
      currentToolGroupRevision: overrides.currentToolGroupRevision ?? 1,
      escalationSink: overrides.escalationSink,
      maxRequestsPerAgent: overrides.maxRequestsPerAgent,
    });
  }

  it("usage-help 语义校验：缺 toolIdentifier / 非法阻塞原因拒绝", () => {
    expect(
      validateToolHelpRequest(
        makeHelpRequest({ requestKind: "usage-help", toolIdentifier: null }),
      ),
    ).toContain("toolIdentifier");
    expect(
      validateToolHelpRequest(
        makeHelpRequest({ blockingReason: "no-known-match" }),
      ),
    ).toContain("blockingReason");
    expect(validateToolHelpRequest(makeHelpRequest())).toBeNull();
  });

  it("已分配工具 → 直接返回单工具用法（不泄露其他工具 schema）", () => {
    const controller = makeController();
    const response = controller.handleRequest({
      request: makeHelpRequest(),
      requesterAgentInstanceId: "tertiary-a",
      defaultSuperiorAgentInstanceId: "secondary-1",
      missionId: "mission-1",
    });
    expect(response.resolution).toBe("usage-provided");
    expect(response.usageDocumentation?.toolIdentifier).toBe("readFile");
    expect(response.isAuthorizationGranted).toBe(false);
    // 请求 listDirectory（注册表有但未分配）→ known-but-not-usable + 不携带 schema
    const notUsable = controller.handleRequest({
      request: makeHelpRequest({
        requestIdentifier: "req-2",
        toolIdentifier: "listDirectory",
        blockingReason: "forgot-usage",
      }),
      requesterAgentInstanceId: "tertiary-a",
      defaultSuperiorAgentInstanceId: "secondary-1",
      missionId: "mission-1",
    });
    expect(notUsable.resolution).toBe("known-but-not-usable");
    expect(notUsable.usageDocumentation).toBeNull();
  });

  it("missing-capability → escalation（missing-tool）；重复请求幂等；陈旧 revision 拒绝", () => {
    const escalations: unknown[] = [];
    const controller = makeController({
      escalationSink: (escalation) => {
        escalations.push(escalation);
      },
    });
    const missing = controller.handleRequest({
      request: makeHelpRequest({
        requestIdentifier: "req-missing",
        requestKind: "missing-capability",
        toolIdentifier: null,
        blockingReason: "no-known-match",
        capabilityIntent: "需要访问远端仓库",
      }),
      requesterAgentInstanceId: "tertiary-a",
      defaultSuperiorAgentInstanceId: "secondary-1",
      missionId: "mission-1",
    });
    expect(missing.resolution).toBe("escalated-missing-tool");
    expect(missing.usageDocumentation).toBeNull();
    expect(escalations).toHaveLength(1);
    // 幂等：同 request ID 不重复上报
    const duplicate = controller.handleRequest({
      request: makeHelpRequest({
        requestIdentifier: "req-missing",
        requestKind: "missing-capability",
        toolIdentifier: null,
        blockingReason: "no-known-match",
        capabilityIntent: "需要访问远端仓库",
      }),
      requesterAgentInstanceId: "tertiary-a",
      defaultSuperiorAgentInstanceId: "secondary-1",
      missionId: "mission-1",
    });
    expect(duplicate.requestIdentifier).toBe("req-missing");
    expect(escalations).toHaveLength(1);
    // 陈旧 revision
    const stale = controller.handleRequest({
      request: makeHelpRequest({
        requestIdentifier: "req-stale",
        knownToolGroupRevision: 0,
      }),
      requesterAgentInstanceId: "tertiary-a",
      defaultSuperiorAgentInstanceId: "secondary-1",
      missionId: "mission-1",
    });
    expect(stale.resolution).toBe("stale-request");
  });

  it("换词循环预算：超限拒绝", () => {
    const controller = makeController({ maxRequestsPerAgent: 2 });
    for (let index = 0; index < 2; index++) {
      controller.handleRequest({
        request: makeHelpRequest({
          requestIdentifier: `req-${index}`,
          toolIdentifier: "listDirectory",
          blockingReason: "not-in-assigned-tool-set",
        }),
        requesterAgentInstanceId: "tertiary-a",
        defaultSuperiorAgentInstanceId: "secondary-1",
        missionId: "mission-1",
      });
    }
    const blocked = controller.handleRequest({
      request: makeHelpRequest({
        requestIdentifier: "req-over",
        toolIdentifier: "listDirectory",
        blockingReason: "not-in-assigned-tool-set",
      }),
      requesterAgentInstanceId: "tertiary-a",
      defaultSuperiorAgentInstanceId: "secondary-1",
      missionId: "mission-1",
    });
    expect(blocked.resolution).toBe("rejected");
  });
});

describe("UnboundedAgentInstanceRegistry", () => {
  it("历史实例总数不产生拒绝（大量创建/回收仍可新建）", () => {
    let occupied = 0;
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 2,
      maxQueueLength: 2,
      currentOccupiedSlots: () => occupied,
      canRecycle: () => true,
    });
    const instances = [];
    for (let index = 0; index < 10_000; index++) {
      instances.push(
        registry.createInstance({
          agentRole: "tertiary",
          missionId: `mission-${index % 5}`,
        }),
      );
    }
    expect(registry.getHistoricalInstanceCount()).toBe(10_000);
    // 并发槽满 → 排队/暂停（资源限制，非数量拒绝）
    occupied = 2;
    const admitted = registry.requestAdmission(instances[0]!.agentInstanceId);
    expect(admitted.state).toBe("queued");
    const admitted2 = registry.requestAdmission(instances[1]!.agentInstanceId);
    expect(admitted2.state).toBe("queued");
    const paused = registry.requestAdmission(instances[2]!.agentInstanceId);
    expect(paused.state).toBe("paused");
    // 回收后可再次创建（历史数量不影响）
    registry.recycleInstance(instances[0]!.agentInstanceId);
    const newInstance = registry.createInstance({
      agentRole: "tertiary",
      missionId: "mission-new",
    });
    expect(registry.getState(newInstance.agentInstanceId)).toBe("created");
  });

  it("回收需允许；已回收实例不可再准入", () => {
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 2,
      maxQueueLength: 2,
      canRecycle: () => false,
    });
    const instance = registry.createInstance({
      agentRole: "secondary",
      missionId: "mission-1",
    });
    expect(() => registry.recycleInstance(instance.agentInstanceId)).toThrowError(
      /不允许受控回收/,
    );
    registry["records"].get(instance.agentInstanceId)!.state = "recycled";
    registry["records"].get(instance.agentInstanceId)!.recycledAtIso =
      new Date().toISOString();
    const admission = registry.requestAdmission(instance.agentInstanceId);
    expect(admission.admitted).toBe(false);
    expect(admission.state).toBe("recycled");
  });
});

describe("AgentCommunicationDelegation", () => {
  let clockMilliseconds: number;

  beforeEach(() => {
    clockMilliseconds = 1_000_000;
  });

  function makeController() {
    const store = new DelegatedAgentCommunicationGrantStore({
      nowUnixMilliseconds: () => clockMilliseconds,
    });
    return {
      store,
      controller: new AgentCommunicationDelegationController(
        store,
        () => clockMilliseconds,
      ),
    };
  }

  it("层级校验：target 必须低一级、recipient 必须同级、target 存活", () => {
    const { controller } = makeController();
    expect(() =>
      controller.createGrant({
        authorizationSource: "user",
        userDecisionReference: "u1",
        grantorSuperiorAgentInstanceId: "secondary-1",
        recipientPeerAgentInstanceId: "secondary-2",
        targetAgentInstanceId: "tertiary-1",
        grantorRole: "secondary",
        recipientRole: "tertiary",
        targetRole: "tertiary",
        isTargetAlive: true,
        missionId: "mission-1",
        taskScope: null,
        allowedMessageTypes: ["information"],
        isInstructionAllowed: false,
        replyRoute: "to-recipient",
        isCopyToGrantorRequired: false,
        expiresAtIso: null,
        maxInFlightMessages: 5,
      }),
    ).toThrowError(/同级/);
    expect(() =>
      controller.createGrant({
        authorizationSource: "user",
        userDecisionReference: "u1",
        grantorSuperiorAgentInstanceId: "secondary-1",
        recipientPeerAgentInstanceId: "secondary-2",
        targetAgentInstanceId: "tertiary-1",
        grantorRole: "secondary",
        recipientRole: "secondary",
        targetRole: "tertiary",
        isTargetAlive: false,
        missionId: "mission-1",
        taskScope: null,
        allowedMessageTypes: ["information"],
        isInstructionAllowed: false,
        replyRoute: "to-recipient",
        isCopyToGrantorRequired: false,
        expiresAtIso: null,
        maxInFlightMessages: 5,
      }),
    ).toThrowError(/不存活/);
  });

  it("创建成功：句柄不透明；投递前失效检查全条件", () => {
    const { store, controller } = makeController();
    const grant = controller.createGrant({
      authorizationSource: "user",
      userDecisionReference: "u1",
      grantorSuperiorAgentInstanceId: "secondary-1",
      recipientPeerAgentInstanceId: "secondary-2",
      targetAgentInstanceId: "tertiary-1",
      grantorRole: "secondary",
      recipientRole: "secondary",
      targetRole: "tertiary",
      isTargetAlive: true,
      missionId: "mission-1",
      taskScope: null,
      allowedMessageTypes: ["information"],
      isInstructionAllowed: false,
      replyRoute: "to-recipient",
      isCopyToGrantorRequired: false,
      expiresAtIso: null,
      maxInFlightMessages: 5,
    });
    expect(grant.communicationHandleIdentifier).toMatch(/^handle-/);
    expect(grant.communicationHandleIdentifier).not.toContain("ipc");
    const baseContext = {
      isRevokedByUser: false,
      isTargetRecycled: false,
      isGrantorStillDirectSuperior: true,
      isMissionEnded: false,
    };
    // 正常投递
    const delivered = controller.assertDeliverable({
      communicationHandleIdentifier: grant.communicationHandleIdentifier,
      senderAgentInstanceId: "secondary-2",
      messageType: "information",
      missionId: "mission-1",
      currentProfileRevision: 1,
      context: baseContext,
      currentInFlightMessages: 0,
    });
    expect(delivered.grant.grantId).toBe(grant.grantId);
    // instruction 未授权 → 拒绝
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "instruction",
        missionId: "mission-1",
        currentProfileRevision: 1,
        context: baseContext,
        currentInFlightMessages: 0,
      }),
    ).toThrowError(/instruction/);
    // 发送者非 recipient → 拒绝
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-3",
        messageType: "information",
        missionId: "mission-1",
        currentProfileRevision: 1,
        context: baseContext,
        currentInFlightMessages: 0,
      }),
    ).toThrowError(/recipient/);
    // 用户撤销 / target 回收 / 父子变化 / mission 结束 / 到期 / 在途超限
    const rejectionCases: Array<{
      label: string;
      overrides: Partial<Parameters<typeof controller.assertDeliverable>[0]>;
    }> = [
      {
        label: "用户撤销",
        overrides: { context: { ...baseContext, isRevokedByUser: true } },
      },
      {
        label: "target 回收",
        overrides: { context: { ...baseContext, isTargetRecycled: true } },
      },
      {
        label: "父子变化",
        overrides: {
          context: { ...baseContext, isGrantorStillDirectSuperior: false },
        },
      },
      {
        label: "mission 结束",
        overrides: { context: { ...baseContext, isMissionEnded: true } },
      },
      {
        label: "在途超限",
        overrides: { currentInFlightMessages: 5 },
      },
    ];
    for (const rejectionCase of rejectionCases) {
      expect(
        () =>
          controller.assertDeliverable({
            communicationHandleIdentifier:
              grant.communicationHandleIdentifier,
            senderAgentInstanceId: "secondary-2",
            messageType: "information",
            missionId: "mission-1",
            currentProfileRevision: 1,
            context: rejectionCase.overrides.context ?? baseContext,
            currentInFlightMessages:
              rejectionCase.overrides.currentInFlightMessages ?? 0,
          }),
        rejectionCase.label,
      ).toThrowError(/task-sequence-permission-denied|授权失效|上限|instruction|已撤销/);
    }
    // 到期
    clockMilliseconds += 1_000_000;
    const expiredGrant = controller.createGrant({
      authorizationSource: "user",
      userDecisionReference: "u2",
      grantorSuperiorAgentInstanceId: "secondary-1",
      recipientPeerAgentInstanceId: "secondary-2",
      targetAgentInstanceId: "tertiary-2",
      grantorRole: "secondary",
      recipientRole: "secondary",
      targetRole: "tertiary",
      isTargetAlive: true,
      missionId: "mission-1",
      taskScope: null,
      allowedMessageTypes: ["information"],
      isInstructionAllowed: false,
      replyRoute: "to-recipient",
      isCopyToGrantorRequired: false,
      expiresAtIso: new Date(clockMilliseconds - 1).toISOString(),
      maxInFlightMessages: 5,
    });
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier:
          expiredGrant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "information",
        missionId: "mission-1",
        currentProfileRevision: 1,
        context: baseContext,
        currentInFlightMessages: 0,
      }),
    ).toThrowError(/到期/);
    // 句柄不存在
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: "handle-ghost",
        senderAgentInstanceId: "secondary-2",
        messageType: "information",
        missionId: "mission-1",
        currentProfileRevision: 1,
        context: baseContext,
        currentInFlightMessages: 0,
      }),
    ).toThrowError(/不存在或已撤销/);
    void store;
  });

  it("grant 不可转授（句柄不可导出为另一句柄）；Agent 相关撤销批量生效", () => {
    const { store, controller } = makeController();
    const grant = controller.createGrant({
      authorizationSource: "user",
      userDecisionReference: "u1",
      grantorSuperiorAgentInstanceId: "secondary-1",
      recipientPeerAgentInstanceId: "secondary-2",
      targetAgentInstanceId: "tertiary-1",
      grantorRole: "secondary",
      recipientRole: "secondary",
      targetRole: "tertiary",
      isTargetAlive: true,
      missionId: "mission-1",
      taskScope: null,
      allowedMessageTypes: ["information"],
      isInstructionAllowed: false,
      replyRoute: "to-recipient",
      isCopyToGrantorRequired: false,
      expiresAtIso: null,
      maxInFlightMessages: 5,
    });
    controller.assertNotReDelegable(grant.communicationHandleIdentifier);
    expect(() =>
      controller.assertNotReDelegable("handle-ghost"),
    ).toThrowError(/不存在/);
    // target 回收 → 相关 grant 全部撤销
    store.revokeAllForAgent("tertiary-1");
    expect(
      store.getGrantByHandle(grant.communicationHandleIdentifier),
    ).toBeNull();
  });
});
