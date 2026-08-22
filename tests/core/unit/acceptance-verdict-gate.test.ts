/**
 * T08C-05 测试：实现/测试/验收任命与合并门禁。
 * 验收：作者自验被拒；高风险三身份独立；提交变化使旧裁决失效；
 * 高风险缺人工验收 → blocked-human-review。
 */
import { describe, expect, it } from "vitest";

import { AgentAppointmentRegistry } from "../../../packages/core/src/orchestration/agent-appointment-registry.js";
import { AcceptanceVerdictGate } from "../../../packages/core/src/orchestration/acceptance-verdict-gate.js";

function makeAppointmentInput(overrides: Record<string, unknown> = {}) {
  return {
    appointmentId: "appointment-1",
    boundTaskIdentifier: "task-1",
    boundTaskRevision: 3,
    appointingSecondaryAgentInstanceId: "secondary-1",
    riskLevel: "high" as const,
    implementationAgentInstanceId: "tertiary-impl-1",
    testingAgentInstanceId: "tertiary-test-1",
    acceptanceAgentInstanceId: "tertiary-accept-1",
    ...overrides,
  };
}

describe("AgentAppointmentRegistry", () => {
  const registry = new AgentAppointmentRegistry();

  it("高风险任务三身份独立 → 通过", () => {
    const appointment = registry.createAppointment(makeAppointmentInput());
    expect(appointment.boundTaskIdentifier).toBe("task-1");
  });

  it("实现者兼任验收 → 拒绝（作者自验被拒）", () => {
    expect(() =>
      registry.createAppointment(
        makeAppointmentInput({
          acceptanceAgentInstanceId: "tertiary-impl-1",
        }),
      ),
    ).toThrowError(/作者自验被拒/);
    expect(() =>
      registry.createAppointment(
        makeAppointmentInput({
          testingAgentInstanceId: "tertiary-impl-1",
        }),
      ),
    ).toThrowError(/作者自验被拒/);
  });

  it("高风险任务测试/验收同人 → 拒绝（三者必须互异）", () => {
    expect(() =>
      registry.createAppointment(
        makeAppointmentInput({
          testingAgentInstanceId: "tertiary-accept-1",
        }),
      ),
    ).toThrowError(/三个不同 Agent 身份/);
  });

  it("低风险 + 用户策略允许 → 测试/验收可同人（仍不得为实现者）", () => {
    const allowedRegistry = new AgentAppointmentRegistry({
      allowsSharedTestAndAcceptanceByDefault: true,
    });
    const appointment = allowedRegistry.createAppointment(
      makeAppointmentInput({
        riskLevel: "low",
        testingAgentInstanceId: "tertiary-accept-1",
      }),
    );
    expect(appointment.testingAgentInstanceId).toBe("tertiary-accept-1");
    // 低风险但策略不允许 → 拒绝
    const strictRegistry = new AgentAppointmentRegistry();
    expect(() =>
      strictRegistry.createAppointment(
        makeAppointmentInput({
          riskLevel: "low",
          testingAgentInstanceId: "tertiary-accept-1",
        }),
      ),
    ).toThrowError(/未获用户策略允许/);
  });

  it("未被任命的验收者 → 拒绝", () => {
    const appointment = registry.createAppointment(makeAppointmentInput());
    expect(() =>
      registry.assertIsAppointedAcceptor({
        appointmentId: appointment.appointmentId,
        agentInstanceId: "tertiary-impl-1",
      }),
    ).toThrowError(/未被任命/);
  });
});

describe("AcceptanceVerdictGate", () => {
  function makeGate() {
    const registry = new AgentAppointmentRegistry();
    const appointment = registry.createAppointment(makeAppointmentInput());
    const gate = new AcceptanceVerdictGate({ appointmentRegistry: registry });
    return { registry, appointment, gate };
  }

  function makeVerdict(overrides: Record<string, unknown> = {}) {
    return {
      verdict: "merge-ready" as const,
      boundTaskIdentifier: "task-1",
      boundTaskRevision: 3,
      boundCommitHash: "abc123",
      acceptingAgentInstanceId: "tertiary-accept-1",
      reason: "测试证据齐备",
      evidenceReferences: ["test-evidence-1"],
      createdAtIso: "2026-08-19T00:00:00.000Z",
      ...overrides,
    };
  }

  it("记录裁决：验收人必须是任命的验收 Agent", async () => {
    const { appointment, gate } = makeGate();
    await expect(
      gate.recordVerdict({
        appointmentId: appointment.appointmentId,
        verdict: makeVerdict({
          acceptingAgentInstanceId: "tertiary-test-1",
        }),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    await expect(
      gate.recordVerdict({
        appointmentId: appointment.appointmentId,
        verdict: makeVerdict(),
      }),
    ).resolves.toMatchObject({ verdict: "merge-ready" });
  });

  it("裁决绑定任务/revision 与任命不一致 → 拒绝", async () => {
    const { appointment, gate } = makeGate();
    await expect(
      gate.recordVerdict({
        appointmentId: appointment.appointmentId,
        verdict: makeVerdict({ boundTaskRevision: 4 }),
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("合并就绪：merge-ready + 人工验收完成（高风险）→ 可合并", async () => {
    const { appointment, gate } = makeGate();
    await gate.recordVerdict({
      appointmentId: appointment.appointmentId,
      verdict: makeVerdict(),
    });
    const result = await gate.evaluateMergeReadiness({
      appointmentId: appointment.appointmentId,
      currentTaskRevision: 3,
      currentCommitHash: "abc123",
      isHumanReviewComplete: true,
    });
    expect(result.isMergeReady).toBe(true);
    expect(result.blockedReasons).toEqual([]);
  });

  it("高风险缺人工验收 → 降级 blocked-human-review（冻结）", async () => {
    const { appointment, gate } = makeGate();
    await gate.recordVerdict({
      appointmentId: appointment.appointmentId,
      verdict: makeVerdict(),
    });
    const result = await gate.evaluateMergeReadiness({
      appointmentId: appointment.appointmentId,
      currentTaskRevision: 3,
      currentCommitHash: "abc123",
      isHumanReviewComplete: false,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.effectiveVerdict).toBe("blocked-human-review");
  });

  it("提交哈希变化 → 旧裁决失效，需重新验收", async () => {
    const { appointment, gate } = makeGate();
    await gate.recordVerdict({
      appointmentId: appointment.appointmentId,
      verdict: makeVerdict(),
    });
    const result = await gate.evaluateMergeReadiness({
      appointmentId: appointment.appointmentId,
      currentTaskRevision: 3,
      currentCommitHash: "def456",
      isHumanReviewComplete: true,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.blockedReasons.join(";")).toContain("提交哈希变化");
  });

  it("任务 revision 变化 → 旧裁决失效", async () => {
    const { appointment, gate } = makeGate();
    await gate.recordVerdict({
      appointmentId: appointment.appointmentId,
      verdict: makeVerdict(),
    });
    const result = await gate.evaluateMergeReadiness({
      appointmentId: appointment.appointmentId,
      currentTaskRevision: 4,
      currentCommitHash: "abc123",
      isHumanReviewComplete: true,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.blockedReasons.join(";")).toContain("revision 变化");
  });

  it("rework 裁决 → 未就绪；无裁决 → 未就绪", async () => {
    const { appointment, gate } = makeGate();
    await gate.recordVerdict({
      appointmentId: appointment.appointmentId,
      verdict: makeVerdict({ verdict: "rework", reason: "接口契约不符" }),
    });
    const reworkResult = await gate.evaluateMergeReadiness({
      appointmentId: appointment.appointmentId,
      currentTaskRevision: 3,
      currentCommitHash: "abc123",
      isHumanReviewComplete: true,
    });
    expect(reworkResult.isMergeReady).toBe(false);
    expect(reworkResult.effectiveVerdict).toBe("rework");

    const { gate: freshGate } = makeGate();
    const freshAppointment = freshGate["appointmentRegistry"].getAppointment("appointment-1")!;
    const noVerdictResult = await freshGate.evaluateMergeReadiness({
      appointmentId: freshAppointment.appointmentId,
      currentTaskRevision: 3,
      currentCommitHash: "abc123",
      isHumanReviewComplete: true,
    });
    expect(noVerdictResult.isMergeReady).toBe(false);
    expect(noVerdictResult.blockedReasons.join(";")).toContain("尚未收到验收裁决");
  });
});