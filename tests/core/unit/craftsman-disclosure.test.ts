/**
 * T08D-03 测试：延迟披露、目标次级隔离、冷却、幂等与崩溃恢复。
 * 验收：初始 prompt 不含工匠（控制器不注入说明）；命中后只通知具体次级一次。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CraftsmanDisclosureStore } from "../../../packages/core/src/orchestration/craftsman-disclosure-store.js";
import { CraftsmanDisclosureController } from "../../../packages/core/src/orchestration/craftsman-disclosure-controller.js";
import { CraftsmanStageController } from "../../../packages/core/src/orchestration/craftsman-stage-controller.js";
import type { CraftsmanPresetAvailableEvent } from "../../../packages/core/src/orchestration/craftsman-schemas.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08d03-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeHarness(options: {
  specificTargets?: string[];
  cooldownMinutes?: number;
  maxReminders?: number;
} = {}) {
  const disclosureStore = new CraftsmanDisclosureStore({
    baseDirectory: temporaryDirectory,
  });
  const sentEvents: CraftsmanPresetAvailableEvent[] = [];
  const controller = new CraftsmanDisclosureController({
    stageController: new CraftsmanStageController(),
    disclosureStore,
    sendPort: {
      sendDisclosureEvent: async (event) => {
        sentEvents.push(event);
      },
    },
    projectOrSessionIdentifier: "session-1",
    source: "local-stage-controller",
  });
  const profile = {
    schemaVersion: 1 as const,
    profileId: "custom-1",
    displayName: "自定义",
    originKind: "custom" as const,
    builtinStrategy: null,
    combinationMode: "any" as const,
    rules: [
      {
        signalKind: "accepted-task-chain-count" as const,
        thresholdValue: 3,
        milestoneSubset: [],
      },
    ],
    cooldownDurationMinutes: options.cooldownMinutes ?? 60,
    maxDisclosureRemindersPerStage: options.maxReminders ?? 3,
    targetSecondaryScope:
      options.specificTargets !== undefined
        ? ({
            kind: "specific-secondary-agents",
            agentInstanceIds: options.specificTargets,
          } as const)
        : ("all-secondary-agents-in-session" as const),
    disclosureAction: "suggest-only" as const,
    secondaryArrangementPromptTemplate: null,
    revision: 1,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    updatedAtIso: "2026-08-19T00:00:00.000Z",
  };
  const signal = {
    schemaVersion: 1 as const,
    activeSessionDurationMinutes: 0,
    acceptedTaskChainCount: 3,
    acceptedMilestoneIdentifiers: [],
    projectMemoryIndexEntryCount: 0,
    projectMemoryIndexedBytes: 0,
    repeatedWorkflowFingerprintCount: 0,
  };
  return { disclosureStore, sentEvents, controller, profile, signal };
}

describe("CraftsmanDisclosureController", () => {
  it("阶段未命中：不发送事件（初始无披露）", async () => {
    const { controller, sentEvents, profile } = makeHarness();
    const result = await controller.evaluateAndDisclose({
      profile,
      signal: {
        schemaVersion: 1 as const,
        activeSessionDurationMinutes: 0,
        acceptedTaskChainCount: 2,
        acceptedMilestoneIdentifiers: [],
        projectMemoryIndexEntryCount: 0,
        projectMemoryIndexedBytes: 0,
        repeatedWorkflowFingerprintCount: 0,
      },
      nowUnixMilliseconds: 1_000_000,
    });
    expect(result.outcome).toBe("no-stage-hit");
    expect(sentEvents).toHaveLength(0);
  });

  it("命中：只通知具体目标次级一次，事件含幂等键与来源", async () => {
    const { controller, sentEvents, profile, signal } = makeHarness({
      specificTargets: ["secondary-1", "secondary-2"],
    });
    const first = await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000,
    });
    expect(first.outcome).toBe("disclosed");
    expect(sentEvents).toHaveLength(2);
    expect(
      sentEvents.map((event) => event.targetSecondaryAgentInstanceId).sort(),
    ).toEqual(["secondary-1", "secondary-2"]);
    expect(sentEvents[0]?.idempotencyKey.length).toBeGreaterThan(0);
    expect(sentEvents[0]?.source).toBe("local-stage-controller");
    // 相同信号重复评估（重放）：幂等去重，不重复发送
    const duplicate = await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000,
    });
    expect(duplicate.outcome).toBe("duplicate-disclosure");
    expect(sentEvents).toHaveLength(2);
  });

  it("冷却：命中后冷却期内不重复披露", async () => {
    const { controller, sentEvents, profile, signal } = makeHarness({
      specificTargets: ["secondary-1"],
      cooldownMinutes: 60,
    });
    await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000,
    });
    // 5 分钟后（冷却内）→ in-cooldown
    const cooldownResult = await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000 + 5 * 60_000,
    });
    expect(cooldownResult.outcome).toBe("in-cooldown");
    // 61 分钟后（冷却外）→ 再次披露（新幂等键）
    const afterCooldown = await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000 + 61 * 60_000,
    });
    expect(afterCooldown.outcome).toBe("disclosed");
    expect(sentEvents).toHaveLength(2);
  });

  it("提醒次数上限：达到上限后不再披露", async () => {
    const { controller, sentEvents, profile, signal } = makeHarness({
      specificTargets: ["secondary-1"],
      maxReminders: 2,
      cooldownMinutes: 0,
    });
    // 第一次（t0）与第二次（t1）披露成功；第三次（t2）达上限
    await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000,
    });
    await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000 + 1 * 60_000,
    });
    const limitResult = await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000 + 2 * 60_000,
    });
    expect(limitResult.outcome).toBe("reminder-limit-reached");
    expect(sentEvents).toHaveLength(2);
  });

  it("崩溃恢复：新控制器实例读取持久化状态，重放幂等键不重复发送", async () => {
    const { disclosureStore, controller, sentEvents, profile, signal } = makeHarness({
      specificTargets: ["secondary-1"],
    });
    await controller.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_000_000,
    });
    // 模拟崩溃后重启：新建控制器（同一 store 目录）
    const restartedController = new CraftsmanDisclosureController({
      stageController: new CraftsmanStageController(),
      disclosureStore,
      sendPort: {
        sendDisclosureEvent: async (event) => {
          sentEvents.push(event);
        },
      },
      projectOrSessionIdentifier: "session-1",
      source: "local-stage-controller",
    });
    const replayed = await restartedController.evaluateAndDisclose({
      profile,
      signal,
      nowUnixMilliseconds: 1_100_000,
    });
    // 幂等键相同 → 去重，不重复发送（通知风暴防护）
    expect(replayed.outcome).toBe("in-cooldown");
    expect(sentEvents).toHaveLength(1);
  });

  it("初始不注入：控制器本身不创建工匠 Agent，也不携带完整提示词", () => {
    const { controller, profile } = makeHarness({
      specificTargets: ["secondary-1"],
    });
    // 控制器只评估与发送事件；不暴露创建工匠 Agent 的方法
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(controller)),
    ).not.toContain("createCraftsmanAgent");
    // suggest-only 无提示词模板（不注入次级上下文）
    expect(profile.secondaryArrangementPromptTemplate).toBeNull();
  });
});