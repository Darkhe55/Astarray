/**
 * T05D-04 测试：冲突分类与影响范围分析。
 * 验收：不同文件的公共契约冲突可检测；行为冲突进入返修；
 * 未知情况 fail-closed；影响清单生成。
 */
import { describe, expect, it } from "vitest";

import { ConcurrentChangeClassifier } from "../../../packages/core/src/orchestration/concurrent-change-classifier.js";
import type { ClassifyChangeInput } from "../../../packages/core/src/orchestration/concurrent-change-classifier.js";

function makeClassifier() {
  return new ConcurrentChangeClassifier({
    listImpactedNodeIdentifiers: (contractIdentifiers: string[]) =>
      contractIdentifiers.map((contract) => `node:${contract}`),
  });
}

function makeInput(overrides: Partial<ClassifyChangeInput> = {}): ClassifyChangeInput {
  return {
    humanChangedPaths: ["src/human.ts"],
    humanAffectedContractIdentifiers: [],
    agentWritePaths: ["src/agent.ts"],
    agentAffectedContractIdentifiers: [],
    hasGitTextConflict: false,
    behavioralEvidence: { testsPassed: true, acceptancePassed: true },
    ...overrides,
  };
}

describe("ConcurrentChangeClassifier 分类", () => {
  it("无重叠（路径与契约均不相交）→ no-overlap-revalidate", () => {
    const classifier = makeClassifier();
    const result = classifier.classifyChange(makeInput());
    expect(result.decision).toBe("no-overlap-revalidate");
    expect(result.reason).toContain("无重叠");
  });

  it("文本重叠（同一路径）→ text-conflict-reconcile（原实现者不能单独宣布解决）", () => {
    const classifier = makeClassifier();
    const result = classifier.classifyChange(
      makeInput({
        humanChangedPaths: ["src/shared.ts"],
        agentWritePaths: ["src/shared.ts"],
      }),
    );
    expect(result.decision).toBe("text-conflict-reconcile");
    expect(result.reason).toContain("原实现者不能单独宣布解决");
  });

  it("Git 文本冲突标记 → text-conflict-reconcile", () => {
    const classifier = makeClassifier();
    const result = classifier.classifyChange(
      makeInput({ hasGitTextConflict: true }),
    );
    expect(result.decision).toBe("text-conflict-reconcile");
  });

  it("契约重叠（路径不同但共享公共契约）→ contract-conflict-reconcile + 影响清单", () => {
    const classifier = makeClassifier();
    const result = classifier.classifyChange(
      makeInput({
        humanChangedPaths: ["src/api.ts"],
        humanAffectedContractIdentifiers: ["public-schema-v1"],
        agentWritePaths: ["src/impl.ts"],
        agentAffectedContractIdentifiers: ["public-schema-v1"],
      }),
    );
    expect(result.decision).toBe("contract-conflict-reconcile");
    expect(result.impactedNodeIdentifiers).toEqual(["node:public-schema-v1"]);
    classifier.assertImpactAnalysisComplete(result);
  });

  it("行为冲突（测试/验收不一致）→ blocked-human-review 返修", () => {
    const classifier = makeClassifier();
    const result = classifier.classifyChange(
      makeInput({
        behavioralEvidence: { testsPassed: false, acceptancePassed: true },
      }),
    );
    expect(result.decision).toBe("blocked-human-review");
    expect(result.reason).toContain("行为冲突");
    const acceptanceFailure = classifier.classifyChange(
      makeInput({
        behavioralEvidence: { testsPassed: true, acceptancePassed: false },
      }),
    );
    expect(acceptanceFailure.decision).toBe("blocked-human-review");
  });

  it("契约重叠但影响清单为空 → fail-closed（assert 抛错）", () => {
    const classifier = new ConcurrentChangeClassifier({
      listImpactedNodeIdentifiers: () => [],
    });
    const result = classifier.classifyChange(
      makeInput({
        humanChangedPaths: ["src/api.ts"],
        humanAffectedContractIdentifiers: ["unknown-contract"],
        agentWritePaths: ["src/impl.ts"],
        agentAffectedContractIdentifiers: ["unknown-contract"],
      }),
    );
    expect(result.decision).toBe("contract-conflict-reconcile");
    expect(() => classifier.assertImpactAnalysisComplete(result)).toThrowError(
      /fail-closed 人工审查/,
    );
  });

  it("分类输入缺少路径 → 拒绝（模型不能伪造空变化）", () => {
    expect(() =>
      ConcurrentChangeClassifier.assertClassificationInputValid(
        makeInput({ humanChangedPaths: [], agentWritePaths: [] }),
      ),
    ).toThrowError(/缺少路径/);
  });
});