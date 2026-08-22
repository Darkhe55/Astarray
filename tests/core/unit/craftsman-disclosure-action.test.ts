/**
 * T08D-04 测试：披露动作执行器（suggest-only / suggest-with-prompt /
 * auto-enqueue-proposal）。
 * 验收：自动节点只能 priority tier 1+；提示词不构成授权；
 * 自动节点来源是本地策略（不能伪装用户来源）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { CraftsmanDisclosureActionExecutor } from "../../../packages/core/src/orchestration/craftsman-disclosure-action-executor.js";
import type { CraftsmanPresetAvailableEvent } from "../../../packages/core/src/orchestration/craftsman-schemas.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08d04-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeEvent(
  overrides: Partial<CraftsmanPresetAvailableEvent> = {},
): CraftsmanPresetAvailableEvent {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    presetId: "tertiary-preset:craftsman-v1",
    targetSecondaryAgentInstanceId: "secondary-1",
    projectOrSessionIdentifier: "session-1",
    stageProfileId: "custom-1",
    stageProfileRevision: 1,
    hitSignalSummary: "活跃 90 分钟",
    disclosureAction: "suggest-only",
    promptTemplateReference: null,
    idempotencyKey: "idem-1",
    source: "local-stage-controller",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

async function makeHarness() {
  const store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
  const manageController = new TaskSequenceManageController(store);
  const executor = new CraftsmanDisclosureActionExecutor({
    sequenceManageController: manageController,
    doesSecondaryAgentExist: (agentInstanceId) =>
      agentInstanceId === "secondary-1",
  });
  // 预建偏序集（publish 后 revision=2）
  await manageController.publishSequence({
    ownerAgentInstanceId: "secondary-1",
    actor: { sourceKind: "user", actorId: "user-1" },
    sequenceId: "sequence-secondary-1",
    firstTask: { taskId: "t0", title: "初始任务", priorityTier: null, externalReference: null },
  });
  return { store, manageController, executor };
}

describe("CraftsmanDisclosureActionExecutor", () => {
  it("suggest-only：无额外动作（事件已发送）", async () => {
    const { executor } = await makeHarness();
    const result = await executor.executeDisclosureAction({
      event: makeEvent({ disclosureAction: "suggest-only" }),
      promptTemplate: null,
      expectedSequenceRevision: 2,
      anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
    });
    expect(result).toEqual({ action: "suggest-only" });
  });

  it("suggest-with-prompt：校验模板存在并返回模板引用（不插入节点）", async () => {
    const { executor, store } = await makeHarness();
    const result = await executor.executeDisclosureAction({
      event: makeEvent({
        disclosureAction: "suggest-with-prompt",
        promptTemplateReference: "template-ref-1",
      }),
      promptTemplate: "结合 ready set 与权限边界评估是否安排工匠",
      expectedSequenceRevision: 2,
      anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
    });
    expect(result).toMatchObject({
      action: "suggest-with-prompt",
      promptTemplateReference: "结合 ready set 与权限边界评估是否安排工匠",
    });
    // 未插入任何任务节点
    const sequence = await store.readSequence("secondary-1", "sequence-secondary-1");
    expect(sequence?.nodes).toHaveLength(1);
  });

  it("suggest-with-prompt：模板缺失 → 拒绝", async () => {
    const { executor } = await makeHarness();
    await expect(
      executor.executeDisclosureAction({
        event: makeEvent({ disclosureAction: "suggest-with-prompt" }),
        promptTemplate: null,
        expectedSequenceRevision: 2,
      anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("auto-enqueue-proposal：插入自动节点，priorityTier 固定 1（不抢占用户层级 0）", async () => {
    const { executor, store } = await makeHarness();
    const result = await executor.executeDisclosureAction({
      event: makeEvent({
        disclosureAction: "auto-enqueue-proposal",
        idempotencyKey: "idem-proposal-1",
      }),
      promptTemplate: "评估并安排工匠",
      expectedSequenceRevision: 2,
      anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
    });
    expect(result).toMatchObject({
      action: "auto-enqueue-proposal",
      priorityTier: 1,
    });
    const sequence = await store.readSequence("secondary-1", "sequence-secondary-1");
    const inserted = sequence?.nodes.find(
      (node) => node.taskId === (result as { insertedTaskId: string }).insertedTaskId,
    );
    expect(inserted).toBeDefined();
    // 自动节点来源是本地策略（agent 来源；不允许伪装用户来源层级 0）
    expect(sequence?.nodes.some((node) => node.taskId.startsWith("craftsman-proposal-"))).toBe(
      true,
    );
  });

  it("目标次级不存在 → 拒绝（自动节点不注入未知次级）", async () => {
    const { executor } = await makeHarness();
    await expect(
      executor.executeDisclosureAction({
        event: makeEvent({ targetSecondaryAgentInstanceId: "ghost-secondary" }),
        promptTemplate: null,
        expectedSequenceRevision: 2,
      anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("提示词不构成授权：执行器只插入任务节点，无任何权限授予路径", async () => {
    const { executor, store } = await makeHarness();
    await executor.executeDisclosureAction({
      event: makeEvent({
        disclosureAction: "auto-enqueue-proposal",
        idempotencyKey: "idem-proposal-2",
      }),
      promptTemplate: "任意提示词内容",
      expectedSequenceRevision: 2,
      anchor: { predecessorTaskIds: ["t0"], successorTaskIds: [] },
    });
    // 执行器原型只有 executeDisclosureAction；无授权/安装/合并方法
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(executor)),
    ).toEqual(["constructor", "executeDisclosureAction"]);
    const sequence = await store.readSequence("secondary-1", "sequence-secondary-1");
    const insertedNode = sequence?.nodes.find((node) =>
      node.taskId.startsWith("craftsman-proposal-"),
    );
    expect(insertedNode?.priorityTier).toBe(1);
  });
});
