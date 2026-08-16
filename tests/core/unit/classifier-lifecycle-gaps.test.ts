/**
 * B6R-11：classifier / completion-gate / tertiary-lifecycle 剩余缺口单测
 * （classifier:95 yarn 白名单、pwsh 空段 fail-closed；
 * completion-gate:38 空证据包；lifecycle:315-336 resume 分支）。
 */
import { describe, expect, it } from "vitest";

import { InstallationOperationClassifier } from "../../../packages/core/src/tools/installation-operation-classifier.js";
import { EvidenceCompletionGate } from "../../../packages/core/src/tools/evidence-completion-gate.js";
import { TertiaryAgentLifecycleController } from "../../../packages/core/src/orchestration/tertiary-lifecycle.js";
import type { TertiaryLifecyclePhaseStore } from "../../../packages/core/src/orchestration/tertiary-lifecycle.js";
import type { TertiaryLifecyclePhase } from "../../../packages/core/src/orchestration/tertiary-lifecycle.js";

describe("InstallationOperationClassifier 补缺", () => {
  const classifier = new InstallationOperationClassifier();

  it("yarn 普通命令（run/test）不是安装（白名单 95）", () => {
    expect(
      classifier.classifyCommand({
        commandName: "yarn",
        arguments: ["run", "build"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({ isInstallationAttempt: false, effectKind: "not-installation" });
    // yarn 安装仍识别
    expect(
      classifier.classifyCommand({
        commandName: "yarn",
        arguments: ["add", "lodash"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({ isInstallationAttempt: true });
  });

  it("pwsh 空脚本段 → 无有效段 → fail-closed（安装尝试）", () => {
    expect(
      classifier.classifyCommand({
        commandName: "pwsh",
        arguments: ["-Command", ";;;"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({ isInstallationAttempt: true, effectKind: "dependency-resolution-change" });
  });

  it("cmd /c 空脚本 → fail-closed", () => {
    expect(
      classifier.classifyCommand({
        commandName: "cmd",
        arguments: ["/c", ""],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({ isInstallationAttempt: true });
  });
});

describe("EvidenceCompletionGate 补缺", () => {
  const gate = new EvidenceCompletionGate();

  it("空证据包：关键主张未被覆盖（38）", () => {
    const result = gate.evaluateEvidenceBundle(
      {
        schemaVersion: 1,
        claimIdentifier: "claim-1",
        builderAgentInstanceId: "tertiary-1",
        createdAtIso: "2026-08-16T00:00:00.000Z",
        relation: "supported",
        entries: [],
        coverageNotes: [],
        limitations: [],
      },
      { requiredClaimIdentifier: "claim-1", requireSourceText: true },
    );
    expect(result.isPassable).toBe(false);
    expect(result.unmetRequirements.join(";")).toContain("证据包为空");
  });

  it("全部满足 → 通过；claim 不匹配 + unavailable 组合未满足", () => {
    const pass = gate.evaluateEvidenceBundle(
      {
        schemaVersion: 1,
        claimIdentifier: "claim-1",
        builderAgentInstanceId: "tertiary-1",
        createdAtIso: "2026-08-16T00:00:00.000Z",
        relation: "supported",
        entries: [
          {
            entryType: "source",
            claimIdentifier: "claim-1",
            title: "文档",
            publisherOrAuthor: "作者",
            directLinkOrDocumentId: "doc-1",
            publishedAtIso: null,
            retrievedAtIso: "2026-08-16T00:00:00.000Z",
            relevantExcerptSummary: "摘要",
            contentHash: "hash-1",
            sourceType: "official",
          },
        ],
        coverageNotes: [],
        limitations: [],
      },
      { requiredClaimIdentifier: "claim-1", requireSourceText: true },
    );
    expect(pass.isPassable).toBe(true);
    const fail = gate.evaluateEvidenceBundle(
      {
        schemaVersion: 1,
        claimIdentifier: "claim-2",
        builderAgentInstanceId: "tertiary-1",
        createdAtIso: "2026-08-16T00:00:00.000Z",
        relation: "unavailable",
        entries: [
          {
            entryType: "local-experiment",
            claimIdentifier: "claim-2",
            environmentSummary: "win32",
            stepsOrCommands: ["npm test"],
            inputSummary: "输入",
            exitStatus: "success",
            observation: "观察",
            artifactHash: null,
            replayableLimitation: null,
          },
        ],
        coverageNotes: [],
        limitations: [],
      },
      { requiredClaimIdentifier: "claim-1", requireSourceText: true },
    );
    expect(fail.unmetRequirements.length).toBeGreaterThanOrEqual(3);
  });
});

describe("TertiaryAgentLifecycleController resume 补缺", () => {
  it("无 phaseStore → resume 返回 null（315）", async () => {
    const controller = new TertiaryAgentLifecycleController({});
    expect(await controller.resume({ agentInstanceId: "tertiary-1" })).toBeNull();
  });

  it("resume 已关闭状态 → closed；全部阶段完成 → null（322-336）", async () => {
    const allPhasesDone: TertiaryLifecyclePhase[] = [
      "stopping-dispatch",
      "draining-unconfirmed-calls",
      "persisting-checkpoint",
      "writing-handoff",
      "confirming-feedback",
      "revoking-permission-lease",
      "unregistering-mailbox",
      "handling-git-resources",
      "terminating-process",
      "closed",
    ];
    const store: TertiaryLifecyclePhaseStore = {
      readState: async (agentInstanceId) => {
        if (agentInstanceId === "tertiary-closed") {
          return {
            agentInstanceId: "tertiary-closed",
            schemaVersion: 1,
            currentPhase: "closed",
            completedPhases: allPhasesDone,
            checkpointId: "cp-1",
            handoffReference: null,
            unconfirmedCallKeys: [],
            closedAtIso: "2026-08-16T00:00:00.000Z",
          };
        }
        return {
          agentInstanceId,
          schemaVersion: 1,
          currentPhase: "terminating-process",
          completedPhases: allPhasesDone,
          checkpointId: "cp-2",
          handoffReference: null,
          unconfirmedCallKeys: [],
          closedAtIso: null,
        };
      },
      writeState: async () => undefined,
    };
    const controller = new TertiaryAgentLifecycleController({}, { phaseStore: store });
    const closed = await controller.resume({ agentInstanceId: "tertiary-closed" });
    expect(closed).toMatchObject({ phase: "closed", closedAtIso: expect.any(String) });
    // 全部阶段完成且未 closed → 无下一阶段 → null
    expect(await controller.resume({ agentInstanceId: "tertiary-done" })).toBeNull();
  });

  it("resume 中途阶段 → 从第一个未完成阶段继续", async () => {
    const store: TertiaryLifecyclePhaseStore = {
      readState: async () => ({
        agentInstanceId: "tertiary-1",
        schemaVersion: 1,
        currentPhase: "stopping-dispatch",
        completedPhases: ["stopping-dispatch", "draining-unconfirmed-calls"] as TertiaryLifecyclePhase[],
        checkpointId: "cp-3",
        handoffReference: null,
        unconfirmedCallKeys: [],
        closedAtIso: null,
      }),
      writeState: async () => undefined,
    };
    const controller = new TertiaryAgentLifecycleController({}, { phaseStore: store });
    const resumed = await controller.resume({ agentInstanceId: "tertiary-1" });
    expect(resumed).toMatchObject({ phase: "persisting-checkpoint", checkpointId: "cp-3" });
  });
});
