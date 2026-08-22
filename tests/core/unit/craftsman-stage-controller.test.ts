/**
 * T08D-02 测试：工匠本地阶段控制器与内置模板。
 * 覆盖：确定性计时/计数/里程碑/记忆规模/重复指纹命中；
 * any/all 组合；内置较早/均衡/保守模板默认值。
 */
import { describe, expect, it } from "vitest";

import { CraftsmanStageController } from "../../../packages/core/src/orchestration/craftsman-stage-controller.js";
import { CRAFTSMAN_MILESTONE_IDENTIFIERS } from "../../../packages/core/src/orchestration/craftsman-stage-controller.js";
import type { CraftsmanStageSignal } from "../../../packages/core/src/orchestration/craftsman-schemas.js";

const controller = new CraftsmanStageController();

function makeSignal(overrides: Partial<CraftsmanStageSignal> = {}): CraftsmanStageSignal {
  return {
    schemaVersion: 1,
    activeSessionDurationMinutes: 0,
    acceptedTaskChainCount: 0,
    acceptedMilestoneIdentifiers: [],
    projectMemoryIndexEntryCount: 0,
    projectMemoryIndexedBytes: 0,
    repeatedWorkflowFingerprintCount: 0,
    ...overrides,
  };
}

describe("内置模板默认值（ADR-0027 §4）", () => {
  it("较早模板：30 分钟 / 首集成里程碑 / 64 条或 512KiB / 指纹 2 次", () => {
    const early = controller.buildBuiltinProfile("early");
    expect(early.displayName).toBe("较早");
    expect(early.combinationMode).toBe("any");
    expect(early.rules).toHaveLength(5);
    expect(
      early.rules.find((rule) => rule.signalKind === "active-session-duration-minutes")
        ?.thresholdValue,
    ).toBe(30);
    expect(
      early.rules.find((rule) => rule.signalKind === "project-memory-index-entry-count")
        ?.thresholdValue,
    ).toBe(64);
    expect(
      early.rules.find((rule) => rule.signalKind === "project-memory-indexed-bytes")
        ?.thresholdValue,
    ).toBe(512 * 1024);
    expect(
      early.rules.find((rule) => rule.signalKind === "repeated-workflow-fingerprint-count")
        ?.thresholdValue,
    ).toBe(2);
  });

  it("均衡模板：90 分钟 / 3 任务链 / 256 条或 2MiB / 指纹 3 次", () => {
    const balanced = controller.buildBuiltinProfile("balanced");
    expect(balanced.displayName).toBe("均衡");
    expect(
      balanced.rules.find((rule) => rule.signalKind === "active-session-duration-minutes")
        ?.thresholdValue,
    ).toBe(90);
    expect(
      balanced.rules.find((rule) => rule.signalKind === "accepted-task-chain-count")
        ?.thresholdValue,
    ).toBe(3);
    expect(
      balanced.rules.find((rule) => rule.signalKind === "project-memory-indexed-bytes")
        ?.thresholdValue,
    ).toBe(2 * 1024 * 1024);
  });

  it("保守模板：180 分钟 / 8 任务链或稳定化 / 1024 条或 8MiB / 指纹 5 次", () => {
    const conservative = controller.buildBuiltinProfile("conservative");
    expect(conservative.displayName).toBe("保守");
    expect(
      conservative.rules.find((rule) => rule.signalKind === "active-session-duration-minutes")
        ?.thresholdValue,
    ).toBe(180);
    expect(
      conservative.rules.find((rule) => rule.signalKind === "accepted-task-chain-count")
        ?.thresholdValue,
    ).toBe(8);
    expect(
      conservative.rules.find((rule) => rule.signalKind === "accepted-milestone-identifiers")
        ?.milestoneSubset,
    ).toContain(CRAFTSMAN_MILESTONE_IDENTIFIERS.stabilizationAccepted);
    expect(
      conservative.rules.find((rule) => rule.signalKind === "project-memory-indexed-bytes")
        ?.thresholdValue,
    ).toBe(8 * 1024 * 1024);
  });
});

describe("阶段命中（any 组合；内置模板）", () => {
  it("较早模板：活跃时长达标即命中（首条规则）", () => {
    const profile = controller.buildBuiltinProfile("early");
    const result = controller.evaluateStage({
      profile,
      signal: makeSignal({ activeSessionDurationMinutes: 30 }),
    });
    expect(result.isHit).toBe(true);
    expect(result.hitSignalSummary).toContain("活跃 30 分钟");
  });

  it("较早模板：里程碑命中（首个集成里程碑）", () => {
    const profile = controller.buildBuiltinProfile("early");
    const result = controller.evaluateStage({
      profile,
      signal: makeSignal({
        acceptedMilestoneIdentifiers: [
          CRAFTSMAN_MILESTONE_IDENTIFIERS.firstIntegrationAccepted,
        ],
      }),
    });
    expect(result.isHit).toBe(true);
    expect(result.hitSignalSummary).toContain("里程碑命中");
  });

  it("均衡模板：任务链计数 3 条命中；2 条不命中", () => {
    const profile = controller.buildBuiltinProfile("balanced");
    expect(
      controller.evaluateStage({
        profile,
        signal: makeSignal({ acceptedTaskChainCount: 2 }),
      }).isHit,
    ).toBe(false);
    expect(
      controller.evaluateStage({
        profile,
        signal: makeSignal({ acceptedTaskChainCount: 3 }),
      }).isHit,
    ).toBe(true);
  });

  it("记忆规模：字节阈值命中（2MiB 均衡）", () => {
    const profile = controller.buildBuiltinProfile("balanced");
    expect(
      controller.evaluateStage({
        profile,
        signal: makeSignal({ projectMemoryIndexedBytes: 2 * 1024 * 1024 }),
      }).isHit,
    ).toBe(true);
  });

  it("重复工作流指纹：均衡 3 次命中；保守 5 次命中", () => {
    const balanced = controller.buildBuiltinProfile("balanced");
    const conservative = controller.buildBuiltinProfile("conservative");
    expect(
      controller.evaluateStage({
        profile: balanced,
        signal: makeSignal({ repeatedWorkflowFingerprintCount: 3 }),
      }).isHit,
    ).toBe(true);
    expect(
      controller.evaluateStage({
        profile: conservative,
        signal: makeSignal({ repeatedWorkflowFingerprintCount: 4 }),
      }).isHit,
    ).toBe(false);
    expect(
      controller.evaluateStage({
        profile: conservative,
        signal: makeSignal({ repeatedWorkflowFingerprintCount: 5 }),
      }).isHit,
    ).toBe(true);
  });

  it("全部信号为零：不命中（新会话无阶段命中）", () => {
    const balanced = controller.buildBuiltinProfile("balanced");
    const result = controller.evaluateStage({
      profile: balanced,
      signal: makeSignal(),
    });
    expect(result.isHit).toBe(false);
    expect(result.hitSignalSummary).toBe("无信号命中");
  });
});

describe("自定义 any/all 规则", () => {
  const customProfile = {
    schemaVersion: 1 as const,
    profileId: "custom-1",
    displayName: "自定义",
    originKind: "custom" as const,
    builtinStrategy: null,
    combinationMode: "all" as const,
    rules: [
      {
        signalKind: "accepted-task-chain-count" as const,
        thresholdValue: 5,
        milestoneSubset: [],
      },
      {
        signalKind: "repeated-workflow-fingerprint-count" as const,
        thresholdValue: 2,
        milestoneSubset: [],
      },
    ],
    cooldownDurationMinutes: 10,
    maxDisclosureRemindersPerStage: 1,
    targetSecondaryScope: {
      kind: "specific-secondary-agents" as const,
      agentInstanceIds: ["secondary-1"],
    },
    disclosureAction: "auto-enqueue-proposal" as const,
    secondaryArrangementPromptTemplate: "评估并安排工匠任务",
    revision: 1,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    updatedAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("all 模式：全部规则命中才命中；单条命中不命中", () => {
    expect(
      controller.evaluateStage({
        profile: customProfile,
        signal: makeSignal({ acceptedTaskChainCount: 5 }),
      }).isHit,
    ).toBe(false);
    expect(
      controller.evaluateStage({
        profile: customProfile,
        signal: makeSignal({
          acceptedTaskChainCount: 5,
          repeatedWorkflowFingerprintCount: 2,
        }),
      }).isHit,
    ).toBe(true);
  });

  it("禁用单项信号：只启用计数规则（any）", () => {
    const anyProfile = {
      ...customProfile,
      combinationMode: "any" as const,
      rules: [
        {
          signalKind: "accepted-task-chain-count" as const,
          thresholdValue: 5,
          milestoneSubset: [],
        },
      ],
    };
    expect(
      controller.evaluateStage({
        profile: anyProfile,
        signal: makeSignal({ acceptedTaskChainCount: 5 }),
      }).isHit,
    ).toBe(true);
    expect(
      controller.evaluateStage({
        profile: anyProfile,
        signal: makeSignal({ acceptedTaskChainCount: 4 }),
      }).isHit,
    ).toBe(false);
  });

  it("非法信号（负活跃时长）→ 拒绝（时钟回拨不提前命中）", () => {
    expect(() =>
      controller.evaluateStage({
        profile: customProfile,
        signal: makeSignal({ activeSessionDurationMinutes: -1 }),
      }),
    ).toThrowError(/阶段信号非法/);
  });
});