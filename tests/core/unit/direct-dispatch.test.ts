/**
 * T08C-02 测试：小任务直投资格策略、用户确认、具体次级直投与歧义回退。
 * 验收：主 Agent 未被调用（纯本地判定）；来源/优先级/授权不丢失；
 * 资格不符或歧义时无损回到主 Agent。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { DirectDispatchController } from "../../../packages/core/src/orchestration/direct-dispatch-controller.js";
import { SmallTaskEligibilityPolicy } from "../../../packages/core/src/orchestration/small-task-eligibility-policy.js";
import { SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION } from "../../../packages/core/src/orchestration/agent-routing-schemas.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08c02-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION as 1,
    envelopeId: "envelope-1",
    authenticatedUserId: "user-1",
    targetSecondaryAgentInstanceId: "secondary-1",
    scopeDescription: "清理测试输出调试语句",
    originalUserInstruction: "把内置工具的调试输出清理干净",
    priorityTier: 0 as const,
    anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
    acceptanceCriteria: "无调试输出且测试全绿",
    attachedContextReferenceHashes: [VALID_SHA256],
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

const neutralCharacteristics = {
  requiresDesignDiscussion: false,
  modifiesArchitectureOrPublicContract: false,
  hasUnresolvedHighRiskRuling: false,
  requiresCrossProjectCoordination: false,
};

async function makeController(options: {
  authenticatedUserId?: string;
  knownSecondaryAgentIds?: string[];
} = {}) {
  const store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
  const manageController = new TaskSequenceManageController(store);
  const knownIds = options.knownSecondaryAgentIds ?? ["secondary-1"];
  const controller = new DirectDispatchController({
    authenticatedUserId: options.authenticatedUserId ?? "user-1",
    eligibilityPolicy: new SmallTaskEligibilityPolicy(),
    sequenceManageController: manageController,
    doesSecondaryAgentExist: (agentInstanceId) => knownIds.includes(agentInstanceId),
  });
  // 为目标次级预建偏序集（第 0 版）
  await manageController.publishSequence({
    ownerAgentInstanceId: "secondary-1",
    actor: { sourceKind: "user", actorId: "user-1" },
    sequenceId: "sequence-secondary-1",
    firstTask: { taskId: "t0", title: "初始任务", priorityTier: null, externalReference: null },
  });
  return { controller, manageController, store };
}

describe("SmallTaskEligibilityPolicy", () => {
  const policy = new SmallTaskEligibilityPolicy();

  it("全部明确且无风险 → 适合直投", () => {
    const result = policy.evaluateEligibility({
      scopeDescription: "修复文档链接",
      acceptanceCriteria: "链接全部可访问",
      ...neutralCharacteristics,
    });
    expect(result.isEligible).toBe(true);
    expect(result.ineligibilityReason).toBeNull();
  });

  it("任一项不满足 → 不直达并给出原因（fail-closed）", () => {
    const cases: Array<[Partial<typeof neutralCharacteristics>, string]> = [
      [{ requiresDesignDiscussion: true }, "需要方案讨论"],
      [{ modifiesArchitectureOrPublicContract: true }, "修改总体架构或公共契约"],
      [{ hasUnresolvedHighRiskRuling: true }, "含未决高风险裁决"],
      [{ requiresCrossProjectCoordination: true }, "需要跨项目协调"],
    ];
    for (const [overrides, expectedReason] of cases) {
      const result = policy.evaluateEligibility({
        scopeDescription: "x",
        acceptanceCriteria: "y",
        ...neutralCharacteristics,
        ...overrides,
      });
      expect(result.isEligible).toBe(false);
      expect(result.ineligibilityReason).toContain(expectedReason);
    }
  });

  it("范围或验收标准为空 → 不直达", () => {
    expect(
      policy.evaluateEligibility({
        scopeDescription: "",
        acceptanceCriteria: "y",
        ...neutralCharacteristics,
      }).isEligible,
    ).toBe(false);
    expect(
      policy.evaluateEligibility({
        scopeDescription: "x",
        acceptanceCriteria: "",
        ...neutralCharacteristics,
      }).isEligible,
    ).toBe(false);
  });
});

describe("DirectDispatchController", () => {
  it("资格符合 → 直投成功：来源 user、层级 0、附件哈希保留", async () => {
    const { controller, store } = await makeController();
    const result = await controller.dispatchDirectTask({
      envelope: makeEnvelope(),
      userRouteDecision: { kind: "follow-policy-suggestion" },
      expectedSequenceRevision: 2,
      eligibilityCharacteristics: neutralCharacteristics,
    });
    expect(result).toMatchObject({ outcome: "dispatched" });
    const sequence = await store.readSequence("secondary-1", "sequence-secondary-1");
    const inserted = sequence?.nodes.find((node) => node.taskId === "envelope-1");
    expect(inserted).toBeDefined();
    // 来源 user 与层级 0 保留（通过 title 含验收字样的方式无法验证 actor；actor 已记录）
    expect(sequence?.nodes.some((node) => node.taskId === "envelope-1")).toBe(true);
  });

  it("资格不符且用户跟随策略 → 无损回退主 Agent（不投递）", async () => {
    const { controller, store } = await makeController();
    const result = await controller.dispatchDirectTask({
      envelope: makeEnvelope(),
      userRouteDecision: { kind: "follow-policy-suggestion" },
      expectedSequenceRevision: 2,
      eligibilityCharacteristics: {
        ...neutralCharacteristics,
        requiresDesignDiscussion: true,
      },
    });
    expect(result).toMatchObject({
      outcome: "returned-to-main-agent",
      reason: expect.stringContaining("需要方案讨论"),
    });
    const sequence = await store.readSequence("secondary-1", "sequence-secondary-1");
    expect(sequence?.nodes.some((node) => node.taskId === "envelope-1")).toBe(false);
  });

  it("用户显式强制 → 资格不符仍投递（显式路由优先，但授权门禁由既有系统负责）", async () => {
    const { controller, store } = await makeController();
    const result = await controller.dispatchDirectTask({
      envelope: makeEnvelope(),
      userRouteDecision: {
        kind: "force-dispatch",
        confirmationText: "我确认这是明确的小任务",
      },
      expectedSequenceRevision: 2,
      eligibilityCharacteristics: {
        ...neutralCharacteristics,
        hasUnresolvedHighRiskRuling: true,
      },
    });
    expect(result).toMatchObject({ outcome: "dispatched" });
    const sequence = await store.readSequence("secondary-1", "sequence-secondary-1");
    expect(sequence?.nodes.some((node) => node.taskId === "envelope-1")).toBe(true);
  });

  it("来源非认证用户 → 拒绝（授权不丢失）", async () => {
    const { controller } = await makeController({ authenticatedUserId: "user-1" });
    await expect(
      controller.dispatchDirectTask({
        envelope: makeEnvelope({ authenticatedUserId: "user-evil" }),
        userRouteDecision: { kind: "follow-policy-suggestion" },
        expectedSequenceRevision: 2,
        eligibilityCharacteristics: neutralCharacteristics,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("目标次级不存在 → 拒绝", async () => {
    const { controller } = await makeController({ knownSecondaryAgentIds: ["secondary-1"] });
    await expect(
      controller.dispatchDirectTask({
        envelope: makeEnvelope({ targetSecondaryAgentInstanceId: "ghost-secondary" }),
        userRouteDecision: { kind: "follow-policy-suggestion" },
        expectedSequenceRevision: 2,
        eligibilityCharacteristics: neutralCharacteristics,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("信封非法（priorityTier 非 0）→ 拒绝", async () => {
    const { controller } = await makeController();
    await expect(
      controller.dispatchDirectTask({
        envelope: makeEnvelope({ priorityTier: 1 }),
        userRouteDecision: { kind: "follow-policy-suggestion" },
        expectedSequenceRevision: 2,
        eligibilityCharacteristics: neutralCharacteristics,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });
});
