/**
 * T09A-01：全局决策/预算/延后片段/上下文图/关闭胶囊/回访请求 schema 反例测试。
 * 依据 ADR-0031 与 T09A 任务卡：秘密字段/多余键拒绝、预算非负、跨 Agent
 * 所有权拒绝、未知锚点/自环拒绝、waived 豁免绑定、陈旧签字不可伪造。
 */
import { describe, expect, it } from "vitest";

import {
  contextClosureCapsuleSchema,
  contextRecallRequestSchema,
  deferredGlobalContextFragmentSchema,
  deferredHumanVerificationTaskSchema,
  globalContextBudgetPolicySchema,
  globalDecisionRecordSchema,
  humanVerificationPolicySchema,
  localContextGraphSchema,
} from "../../../packages/core/src/orchestration/context-closure-schemas.js";

const HASH = "sha256:" + "a".repeat(64);
const ISO = "2026-09-09T10:00:00.000Z";

function baseGlobalDecision(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    globalDecisionIdentifier: "gd-001",
    globalContextRevision: 1,
    decisionSummary: "采用本地版本化上下文生命周期",
    keyRationale: "降低长期模型可见 token 并保留来源",
    rejectedAlternatives: [],
    appliesToScope: "core/orchestration",
    relatedContextNodeIdentifiers: ["node-1"],
    artifactOrCommitReferences: [],
    informationSource: { sourceType: "user", userId: "u-1" },
    sourceRevision: 1,
    contentHash: HASH,
    createdAtIso: ISO,
    status: "active",
    invalidationCondition: "依赖架构修订",
  };
}

function baseGraph(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    graphIdentifier: "graph-1",
    ownerAgentInstanceId: "agent-a",
    missionId: "mission-1",
    revision: 1,
    updatedAtIso: ISO,
    nodes: [
      {
        contextNodeIdentifier: "node-1",
        agentInstanceId: "agent-a",
        missionId: "mission-1",
        state: "active",
        openRequiredChildCount: 0,
        contentFingerprint: HASH,
        updatedAtIso: ISO,
      },
    ],
    edges: [],
  };
}

describe("全局决策记录 schema（T09A-01）", () => {
  it("合法记录可解析", () => {
    const parsed = globalDecisionRecordSchema.safeParse(baseGlobalDecision());
    expect(parsed.success).toBe(true);
  });

  it("记录不能替代自身；未知字段/非 sha256 指纹被拒绝", () => {
    expect(
      globalDecisionRecordSchema.safeParse({
        ...baseGlobalDecision(),
        supersedesGlobalDecisionIdentifier: "gd-001",
      }).success,
    ).toBe(false);
    expect(
      globalDecisionRecordSchema.safeParse({
        ...baseGlobalDecision(),
        contentHash: "not-a-sha",
      }).success,
    ).toBe(false);
    expect(
      globalDecisionRecordSchema.safeParse({
        ...baseGlobalDecision(),
        leakedSecret: "should-reject",
      }).success,
    ).toBe(false);
  });

  it("agent 来源必须带具体 agentInstanceId；非法状态被拒绝", () => {
    expect(
      globalDecisionRecordSchema.safeParse({
        ...baseGlobalDecision(),
        informationSource: { sourceType: "agent" },
      }).success,
    ).toBe(false);
    expect(
      globalDecisionRecordSchema.safeParse({
        ...baseGlobalDecision(),
        status: "confirmed-by-agent",
      }).success,
    ).toBe(false);
  });
});

describe("全局上下文预算设置 schema（T09A-01）", () => {
  it("非负整数上限 + 单调 revision", () => {
    const base = {
      schemaVersion: 1,
      configuredMaximumGlobalContextTokenCount: 4096,
      globalContextBudgetPolicyRevision: 1,
      updatedByUserId: "u-1",
      updatedAtIso: ISO,
    };
    expect(globalContextBudgetPolicySchema.safeParse(base).success).toBe(true);
    expect(
      globalContextBudgetPolicySchema.safeParse({
        ...base,
        configuredMaximumGlobalContextTokenCount: -1,
      }).success,
    ).toBe(false);
    expect(
      globalContextBudgetPolicySchema.safeParse({
        ...base,
        globalContextBudgetPolicyRevision: 0,
      }).success,
    ).toBe(false);
  });
});

describe("延后上下文片段 schema（T09A-01）", () => {
  it("必需字段完整；token 估算非负", () => {
    const base = {
      schemaVersion: 1,
      fragmentIdentifier: "frag-1",
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
      sourceContextNodeIdentifier: "node-1",
      sourceNodeRevision: 1,
      contentHash: HASH,
      topics: ["架构"],
      explicitRelationKeys: ["gd-001"],
      estimatedTokenCount: 120,
      invalidationCondition: "node-1 重开",
      createdAtIso: ISO,
    };
    expect(deferredGlobalContextFragmentSchema.safeParse(base).success).toBe(true);
    expect(
      deferredGlobalContextFragmentSchema.safeParse({
        ...base,
        estimatedTokenCount: -5,
      }).success,
    ).toBe(false);
    expect(
      deferredGlobalContextFragmentSchema.safeParse({
        ...base,
        ownerAgentInstanceId: "",
      }).success,
    ).toBe(false);
  });
});

describe("局部上下文图 schema（T09A-01）", () => {
  it("合法单节点图可解析", () => {
    expect(localContextGraphSchema.safeParse(baseGraph()).success).toBe(true);
  });

  it("跨 Agent 直接所有权被拒绝（节点属主 ≠ 图属主）", () => {
    const graph = baseGraph() as {
      nodes: Array<Record<string, unknown>>;
    };
    graph.nodes[0] = { ...(graph.nodes[0] as object), agentInstanceId: "agent-b" };
    expect(localContextGraphSchema.safeParse(graph).success).toBe(false);
  });

  it("边引用未知锚点或自环被拒绝；waived 边必须带认证豁免", () => {
    const twoNodeGraph = () => ({
      ...baseGraph(),
      nodes: [
        ...((baseGraph() as { nodes: unknown[] }).nodes),
        {
          contextNodeIdentifier: "node-2",
          agentInstanceId: "agent-a",
          missionId: "mission-1",
          state: "active" as const,
          openRequiredChildCount: 0,
          contentFingerprint: HASH,
          updatedAtIso: ISO,
        },
      ],
    });
    const withEdge = (graphFactory: () => Record<string, unknown>, edge: Record<string, unknown>) =>
      localContextGraphSchema.safeParse({
        ...graphFactory(),
        edges: [edge],
      });
    expect(
      withEdge(baseGraph, {
        edgeIdentifier: "e-1",
        fromContextNodeIdentifier: "node-1",
        toContextNodeIdentifier: "node-missing",
        edgeType: "required",
      }).success,
    ).toBe(false);
    expect(
      withEdge(twoNodeGraph, {
        edgeIdentifier: "e-2",
        fromContextNodeIdentifier: "node-1",
        toContextNodeIdentifier: "node-1",
        edgeType: "required",
      }).success,
    ).toBe(false);
    expect(
      withEdge(twoNodeGraph, {
        edgeIdentifier: "e-3",
        fromContextNodeIdentifier: "node-1",
        toContextNodeIdentifier: "node-2",
        edgeType: "waived",
      }).success,
    ).toBe(false);
    expect(
      withEdge(twoNodeGraph, {
        edgeIdentifier: "e-4",
        fromContextNodeIdentifier: "node-1",
        toContextNodeIdentifier: "node-2",
        edgeType: "waived",
        waiver: {
          userId: "u-1",
          contextGraphRevision: 1,
          waivedAtIso: ISO,
        },
      }).success,
    ).toBe(true);
  });
});

describe("关闭胶囊与延迟人工核验任务 schema（T09A-01）", () => {
  it("关闭胶囊要求完整验收信息与重开条件", () => {
    const capsule = {
      schemaVersion: 1,
      capsuleIdentifier: "cap-1",
      contextNodeIdentifier: "node-1",
      agentInstanceId: "agent-a",
      missionId: "mission-1",
      contextGraphRevision: 1,
      finalDecisionSummary: "完成",
      promotedGlobalDecisionIdentifiers: ["gd-001"],
      inputSummary: "输入摘要",
      outputSummary: "输出摘要",
      verificationState: "awaiting-user-acceptance",
      artifactOrCommitReferences: [],
      testEvidenceReferences: [],
      informationSource: { sourceType: "user", userId: "u-1" },
      contentHash: HASH,
      unresolvedItems: [],
      reopenCondition: "人工否决",
      createdAtIso: ISO,
    };
    expect(contextClosureCapsuleSchema.safeParse(capsule).success).toBe(true);
    expect(
      contextClosureCapsuleSchema.safeParse({
        ...capsule,
        reopenCondition: "",
      }).success,
    ).toBe(false);
    expect(
      contextClosureCapsuleSchema.safeParse({
        ...capsule,
        verificationState: "accepted-by-agent",
      }).success,
    ).toBe(false);
  });

  it("延迟人工核验任务优先级只能为 1 或以下", () => {
    const task = {
      schemaVersion: 1,
      taskIdentifier: "deferred-1",
      contextNodeIdentifier: "node-1",
      contextGraphRevision: 1,
      closureCapsuleHash: HASH,
      artifactOrCommitReferences: [],
      automaticTestReferences: [],
      risks: [],
      humanSteps: "核对产物与提交",
      priorityTier: 1,
      createdAtIso: ISO,
    };
    expect(deferredHumanVerificationTaskSchema.safeParse(task).success).toBe(true);
    expect(
      deferredHumanVerificationTaskSchema.safeParse({
        ...task,
        priorityTier: 0,
      }).success,
    ).toBe(true);
    expect(
      deferredHumanVerificationTaskSchema.safeParse({
        ...task,
        priorityTier: 2,
      }).success,
    ).toBe(false);
  });
});

describe("回访请求与人工验收策略 schema（T09A-01）", () => {
  it("回访请求不得携带 agentInstanceId（身份由 harness 注入）", () => {
    const request = {
      schemaVersion: 1,
      requestId: "req-1",
      taskExecutionId: "task-exec-1",
      contextNodeIdentifier: "node-1",
      nodeRevision: 1,
      reasonCode: "global-decision-missing",
      requiredInformation: "当时接口约束",
      maximumTokenCount: 500,
    };
    expect(contextRecallRequestSchema.safeParse(request).success).toBe(true);
    expect(
      contextRecallRequestSchema.safeParse({
        ...request,
        agentInstanceId: "agent-a",
      }).success,
    ).toBe(false);
    expect(
      contextRecallRequestSchema.safeParse({
        ...request,
        maximumTokenCount: 0,
      }).success,
    ).toBe(false);
    expect(
      contextRecallRequestSchema.safeParse({
        ...request,
        reasonCode: "give-me-everything",
      }).success,
    ).toBe(false);
  });

  it("人工验收策略枚举固定为两态", () => {
    const base = {
      schemaVersion: 1,
      policy: "block-until-verified",
      humanVerificationPolicyRevision: 1,
      updatedByUserId: "u-1",
      updatedAtIso: ISO,
    };
    expect(humanVerificationPolicySchema.safeParse(base).success).toBe(true);
    expect(
      humanVerificationPolicySchema.safeParse({
        ...base,
        policy: "auto-pass",
      }).success,
    ).toBe(false);
  });
});
