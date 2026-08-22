/**
 * T07C-03 测试：每 Agent 独立模型分配、安全检查点切换与 AGENT_MODEL_SWITCH_V1。
 * 验收：并发隔离（任一 Agent 切换不影响其他）；未决调用/副作用/并行请求拒绝；
 * 用户固定锁定拒绝；事件不含凭据；失败切换有界预算防活锁。
 */
import { describe, expect, it } from "vitest";

import { AgentModelAssignmentController } from "../../../packages/core/src/orchestration/agent-model-assignment-controller.js";
import type { AgentModelSwitchEvent } from "../../../packages/core/src/orchestration/agent-model-assignment-controller.js";

const cleanCheckpoint = {
  hasPendingToolCall: false,
  hasUnconfirmedSideEffect: false,
  hasParallelProviderRequest: false,
};

function makeHarness() {
  const sentEvents: AgentModelSwitchEvent[] = [];
  const controller = new AgentModelAssignmentController({
    maxFailedSwitchesPerTask: 2,
    sendSwitchEvent: async (event) => {
      sentEvents.push(event);
    },
  });
  return { controller, sentEvents };
}

describe("AgentModelAssignmentController 独立分配", () => {
  it("多个 Agent 独立分配；切换一个不影响其他", async () => {
    const { controller } = makeHarness();
    await controller.assignModel({
      agentInstanceId: "main-agent-1",
      modelProfileId: "openai/gpt-4o",
      isUserFixedLocked: false,
      policyRevision: 1,
    });
    await controller.assignModel({
      agentInstanceId: "secondary-1",
      modelProfileId: "anthropic/claude-3",
      isUserFixedLocked: false,
      policyRevision: 1,
    });
    await controller.switchModelAtCheckpoint({
      agentInstanceId: "secondary-1",
      boundTaskIdentifier: "task-1",
      nextModelProfileId: "openai/gpt-4o-mini",
      switchReason: "限流降级",
      policyRevision: 2,
      contextFingerprint: "fingerprint-1",
      checkpointState: cleanCheckpoint,
      previousSwitchFailed: false,
    });
    // main-agent-1 不受影响
    expect(controller.getAssignment("main-agent-1")?.currentModelProfileId).toBe(
      "openai/gpt-4o",
    );
    expect(controller.getAssignment("secondary-1")?.currentModelProfileId).toBe(
      "openai/gpt-4o-mini",
    );
  });

  it("分配不存在 → 切换拒绝", async () => {
    const { controller } = makeHarness();
    await expect(
      controller.switchModelAtCheckpoint({
        agentInstanceId: "ghost-agent",
        boundTaskIdentifier: "task-1",
        nextModelProfileId: "openai/gpt-4o",
        switchReason: "x",
        policyRevision: 1,
        contextFingerprint: "fp",
        checkpointState: cleanCheckpoint,
        previousSwitchFailed: false,
      }),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
  });
});

describe("AgentModelAssignmentController 安全检查点", () => {
  it("未决工具调用/未确认副作用/并行请求 → 拒绝切换", async () => {
    const { controller } = makeHarness();
    await controller.assignModel({
      agentInstanceId: "secondary-1",
      modelProfileId: "openai/gpt-4o",
      isUserFixedLocked: false,
      policyRevision: 1,
    });
    for (const checkpointState of [
      { hasPendingToolCall: true, hasUnconfirmedSideEffect: false, hasParallelProviderRequest: false },
      { hasPendingToolCall: false, hasUnconfirmedSideEffect: true, hasParallelProviderRequest: false },
      { hasPendingToolCall: false, hasUnconfirmedSideEffect: false, hasParallelProviderRequest: true },
    ]) {
      await expect(
        controller.switchModelAtCheckpoint({
          agentInstanceId: "secondary-1",
          boundTaskIdentifier: "task-1",
          nextModelProfileId: "openai/gpt-4o-mini",
          switchReason: "x",
          policyRevision: 2,
          contextFingerprint: "fp",
          checkpointState,
          previousSwitchFailed: false,
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    }
  });

  it("用户固定锁定 → Agent 不能自行切换", async () => {
    const { controller, sentEvents } = makeHarness();
    await controller.assignModel({
      agentInstanceId: "main-agent-1",
      modelProfileId: "openai/gpt-4o",
      isUserFixedLocked: true,
      policyRevision: 1,
    });
    await expect(
      controller.switchModelAtCheckpoint({
        agentInstanceId: "main-agent-1",
        boundTaskIdentifier: "task-1",
        nextModelProfileId: "anthropic/claude-3",
        switchReason: "x",
        policyRevision: 2,
        contextFingerprint: "fp",
        checkpointState: cleanCheckpoint,
        previousSwitchFailed: false,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(sentEvents).toHaveLength(0);
  });

  it("成功切换：生成 AGENT_MODEL_SWITCH_V1 事件（不含凭据）", async () => {
    const { controller, sentEvents } = makeHarness();
    await controller.assignModel({
      agentInstanceId: "secondary-1",
      modelProfileId: "openai/gpt-4o",
      isUserFixedLocked: false,
      policyRevision: 1,
    });
    const event = await controller.switchModelAtCheckpoint({
      agentInstanceId: "secondary-1",
      boundTaskIdentifier: "task-1",
      nextModelProfileId: "openai/gpt-4o-mini",
      switchReason: "能力不匹配降级",
      policyRevision: 2,
      contextFingerprint: "context-fingerprint-1",
      checkpointState: cleanCheckpoint,
      previousSwitchFailed: false,
    });
    expect(sentEvents).toHaveLength(1);
    expect(event).toMatchObject({
      agentInstanceId: "secondary-1",
      boundTaskIdentifier: "task-1",
      previousModelProfileId: "openai/gpt-4o",
      nextModelProfileId: "openai/gpt-4o-mini",
      switchReason: "能力不匹配降级",
      policyRevision: 2,
    });
    // 事件不含凭据/完整 prompt
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("prompt");
  });
});

describe("AgentModelAssignmentController 失败切换预算", () => {
  it("同任务失败切换超过预算 → 阻塞（防 Provider 间活锁）", async () => {
    const { controller } = makeHarness();
    await controller.assignModel({
      agentInstanceId: "secondary-1",
      modelProfileId: "openai/gpt-4o",
      isUserFixedLocked: false,
      policyRevision: 1,
    });
    // 预算 2：两次失败切换成功执行（计入预算），第三次超出 → 阻塞
    for (let index = 0; index < 2; index++) {
      await controller.switchModelAtCheckpoint({
        agentInstanceId: "secondary-1",
        boundTaskIdentifier: "task-1",
        nextModelProfileId: index === 0 ? "anthropic/claude-3" : "openai/gpt-4o",
        switchReason: `失败切换 ${index}`,
        policyRevision: 1,
        contextFingerprint: `fp-${index}`,
        checkpointState: cleanCheckpoint,
        previousSwitchFailed: true,
      });
    }
    await expect(
      controller.switchModelAtCheckpoint({
        agentInstanceId: "secondary-1",
        boundTaskIdentifier: "task-1",
        nextModelProfileId: "anthropic/claude-3",
        switchReason: "第三次失败切换",
        policyRevision: 1,
        contextFingerprint: "fp-3",
        checkpointState: cleanCheckpoint,
        previousSwitchFailed: true,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("任务完成重置预算后允许再次切换", async () => {
    const { controller } = makeHarness();
    await controller.assignModel({
      agentInstanceId: "secondary-1",
      modelProfileId: "openai/gpt-4o",
      isUserFixedLocked: false,
      policyRevision: 1,
    });
    for (let index = 0; index < 2; index++) {
      await controller.switchModelAtCheckpoint({
        agentInstanceId: "secondary-1",
        boundTaskIdentifier: "task-1",
        nextModelProfileId: index === 0 ? "anthropic/claude-3" : "openai/gpt-4o",
        switchReason: "x",
        policyRevision: 1,
        contextFingerprint: `fp-${index}`,
        checkpointState: cleanCheckpoint,
        previousSwitchFailed: true,
      });
    }
    controller.resetFailedSwitchBudget("secondary-1");
    await expect(
      controller.switchModelAtCheckpoint({
        agentInstanceId: "secondary-1",
        boundTaskIdentifier: "task-2",
        nextModelProfileId: "anthropic/claude-3",
        switchReason: "新任务",
        policyRevision: 1,
        contextFingerprint: "fp-new",
        checkpointState: cleanCheckpoint,
        previousSwitchFailed: true,
      }),
    ).resolves.toMatchObject({ nextModelProfileId: "anthropic/claude-3" });
  });
});