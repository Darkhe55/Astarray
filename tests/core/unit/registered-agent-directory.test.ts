/**
 * B6R-11：RegisteredAgentDirectory 单测（补 B6R-10 未覆盖分支 31/62/72）。
 * 只测目录自身契约，不经过编排层。
 */
import { describe, expect, it } from "vitest";

import { RegisteredAgentDirectory } from "../../../packages/core/src/orchestration/registered-agent-directory.js";
import type { RegisteredAgentEntry } from "../../../packages/core/src/orchestration/registered-agent-directory.js";

function secondaryEntry(overrides: Partial<RegisteredAgentEntry> = {}): RegisteredAgentEntry {
  return {
    agentInstanceId: "secondary-1",
    agentRole: "secondary",
    missionId: "mission-1",
    owningSecondaryAgentInstanceId: null,
    boundTaskBundleId: null,
    registeredAtIso: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("RegisteredAgentDirectory", () => {
  it("三级 Agent 未绑定所属次级 → 拒绝登记", () => {
    const directory = new RegisteredAgentDirectory();
    expect(() =>
      directory.registerAgent({
        agentInstanceId: "tertiary-loose",
        agentRole: "tertiary",
        missionId: "mission-1",
        owningSecondaryAgentInstanceId: null,
        boundTaskBundleId: "bundle-1",
        registeredAtIso: "2026-08-16T00:00:00.000Z",
      }),
    ).toThrowError(/必须绑定所属次级/);
  });

  it("任务包不匹配拒绝；绑定任务包为 null 时接受任意任务包", () => {
    const directory = new RegisteredAgentDirectory();
    directory.registerAgent(secondaryEntry({ boundTaskBundleId: "bundle-1" }));
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "secondary-1",
        missionId: "mission-1",
        taskBundleId: "other-bundle",
      }),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("任务包") });
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "secondary-1",
        missionId: "mission-1",
        taskBundleId: "bundle-1",
      }),
    ).toEqual({ valid: true, reason: null });
    // 未绑定任务包（null）→ 接受任意任务包
    directory.registerAgent(secondaryEntry({ agentInstanceId: "secondary-2" }));
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "secondary-2",
        missionId: "mission-1",
        taskBundleId: "anything",
      }),
    ).toEqual({ valid: true, reason: null });
  });

  it("撤销登记后：报告来源拒绝；同 ID 可重新登记", () => {
    const directory = new RegisteredAgentDirectory();
    directory.registerAgent(secondaryEntry());
    directory.unregisterAgent("secondary-1");
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "secondary-1",
        missionId: "mission-1",
        taskBundleId: "bundle-1",
      }),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("未登记") });
    directory.registerAgent(secondaryEntry());
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "secondary-1",
        missionId: "mission-1",
        taskBundleId: "bundle-1",
      }),
    ).toEqual({ valid: true, reason: null });
    // 撤销不存在的 ID 不抛错
    expect(() => directory.unregisterAgent("ghost")).not.toThrow();
  });

  it("mission 不匹配拒绝；未登记拒绝（非空字符串不是认证）", () => {
    const directory = new RegisteredAgentDirectory();
    directory.registerAgent(secondaryEntry());
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "secondary-1",
        missionId: "mission-2",
        taskBundleId: "bundle-1",
      }),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("mission") });
    expect(
      directory.verifyReportSource({
        reportingAgentInstanceId: "unknown",
        missionId: "mission-1",
        taskBundleId: "bundle-1",
      }),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("未登记") });
  });
});
