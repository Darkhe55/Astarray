/**
 * T08C-03 测试：次级面向用户摘要（SECONDARY_USER_FACING_SUMMARY_V1）
 * 与主 Agent 细节查询。
 * 验收：摘要发布只写索引不唤醒主 Agent；来源认证；可追溯且不漏风险；
 * 主 Agent 查询绑定任务/revision，未知不伪造。
 */
import { describe, expect, it } from "vitest";

import { SecondaryUserFacingSummaryController } from "../../../packages/core/src/orchestration/secondary-user-facing-summary-controller.js";
import type {
  MainAgentReportIndexWritePort,
  SecondaryDetailQueryPort,
  SecondarySourceAuthenticationPort,
} from "../../../packages/core/src/orchestration/secondary-user-facing-summary-controller.js";
import { SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION } from "../../../packages/core/src/orchestration/agent-routing-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION as 1,
    summaryId: "summary-1",
    secondaryAgentInstanceId: "secondary-1",
    boundTaskIdentifier: "sequence-secondary-1",
    boundTaskRevision: 3,
    goal: "完成 B6R-11",
    currentProgress: "覆盖率达标",
    keyResults: [
      { resultSummary: "branches 85.05%", evidenceReference: VALID_SHA256 },
    ],
    risksAndFailures: ["平台矩阵未决"],
    pendingUserDecisions: ["是否配置 CI"],
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

interface TestHarness {
  controller: SecondaryUserFacingSummaryController;
  insertedEntries: Array<Record<string, unknown>>;
  queriedDetails: Array<{ taskIdentifier: string; taskRevision: number }>;
}

function makeHarness(options: {
  registeredSecondaries?: string[];
  detailResponse?: Awaited<ReturnType<SecondaryDetailQueryPort["requestDetail"]>>;
  mainAgentInstanceId?: string;
} = {}): TestHarness {
  const insertedEntries: Array<Record<string, unknown>> = [];
  const queriedDetails: Array<{ taskIdentifier: string; taskRevision: number }> = [];
  const registeredSet = new Set(options.registeredSecondaries ?? ["secondary-1"]);
  const sourceAuthenticationPort: SecondarySourceAuthenticationPort = {
    isRegisteredSecondary: async (agentInstanceId) => registeredSet.has(agentInstanceId),
  };
  const reportIndexPort: MainAgentReportIndexWritePort = {
    insertSummaryEntry: async (entry) => {
      insertedEntries.push(entry as unknown as Record<string, unknown>);
    },
  };
  const detailQueryPort: SecondaryDetailQueryPort = {
    requestDetail: async (input) => {
      queriedDetails.push(input);
      return (
        options.detailResponse ?? {
          kind: "detail" as const,
          detail: "细节说明",
          evidenceReferences: [VALID_SHA256],
          revision: input.taskRevision,
        }
      );
    },
  };
  const controller = new SecondaryUserFacingSummaryController({
    authenticatedMainAgentInstanceId:
      options.mainAgentInstanceId ?? "main-agent-1",
    reportIndexPort,
    sourceAuthenticationPort,
    detailQueryPort,
  });
  return { controller, insertedEntries, queriedDetails };
}

describe("SecondaryUserFacingSummaryController 摘要发布", () => {
  it("合法摘要 → 只写索引条目（无模型调用/不唤醒主 Agent 路径）", async () => {
    const { controller, insertedEntries } = makeHarness();
    await controller.publishUserFacingSummary({ summary: makeSummary() });
    expect(insertedEntries).toHaveLength(1);
    const entry = insertedEntries[0];
    expect(entry).toMatchObject({
      summaryId: "summary-1",
      secondaryAgentInstanceId: "secondary-1",
      boundTaskIdentifier: "sequence-secondary-1",
      boundTaskRevision: 3,
      riskCount: 1,
      pendingUserDecisionCount: 1,
    });
  });

  it("风险与待用户裁决数量被保留（不漏风险）", async () => {
    const { controller, insertedEntries } = makeHarness();
    await controller.publishUserFacingSummary({
      summary: makeSummary({
        risksAndFailures: ["风险一", "风险二"],
        pendingUserDecisions: ["决策一", "决策二", "决策三"],
      }),
    });
    expect(insertedEntries[0]?.riskCount).toBe(2);
    expect(insertedEntries[0]?.pendingUserDecisionCount).toBe(3);
  });

  it("摘要 schema 非法（风险空数组）→ 拒绝", async () => {
    const { controller, insertedEntries } = makeHarness();
    await expect(
      controller.publishUserFacingSummary({
        summary: makeSummary({ risksAndFailures: [] }),
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    expect(insertedEntries).toHaveLength(0);
  });

  it("来源次级未登记 → 拒绝（非空字符串不是认证）", async () => {
    const { controller, insertedEntries } = makeHarness({
      registeredSecondaries: ["secondary-1"],
    });
    await expect(
      controller.publishUserFacingSummary({
        summary: makeSummary({ secondaryAgentInstanceId: "attacker-secondary" }),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(insertedEntries).toHaveLength(0);
  });
});

describe("SecondaryUserFacingSummaryController 主 Agent 细节查询", () => {
  it("认证主 Agent 查询绑定任务/revision → 返回针对性细节", async () => {
    const { controller, queriedDetails } = makeHarness();
    const result = await controller.querySecondaryDetail({
      callingAgentInstanceId: "main-agent-1",
      taskIdentifier: "sequence-secondary-1",
      taskRevision: 3,
    });
    expect(result).toMatchObject({
      kind: "detail",
      detail: "细节说明",
      revision: 3,
    });
    expect(queriedDetails).toEqual([
      { taskIdentifier: "sequence-secondary-1", taskRevision: 3 },
    ]);
  });

  it("非主 Agent 调用 → 拒绝", async () => {
    const { controller } = makeHarness();
    await expect(
      controller.querySecondaryDetail({
        callingAgentInstanceId: "some-other-agent",
        taskIdentifier: "x",
        taskRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("查询参数非法（空标识 / revision<1）→ 拒绝", async () => {
    const { controller } = makeHarness();
    await expect(
      controller.querySecondaryDetail({
        callingAgentInstanceId: "main-agent-1",
        taskIdentifier: "",
        taskRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    await expect(
      controller.querySecondaryDetail({
        callingAgentInstanceId: "main-agent-1",
        taskIdentifier: "x",
        taskRevision: 0,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("次级未知 → 明确返回 unknown，不伪造答案", async () => {
    const { controller } = makeHarness({
      detailResponse: { kind: "unknown", reason: "该任务超出本次级范围" },
    });
    const result = await controller.querySecondaryDetail({
      callingAgentInstanceId: "main-agent-1",
      taskIdentifier: "sequence-secondary-1",
      taskRevision: 9,
    });
    expect(result).toEqual({
      kind: "unknown",
      reason: "该任务超出本次级范围",
    });
  });
});
