/**
 * SUM-02-04：摘要质量评估只接受人工标注（拒绝生成模型自评）。
 */
import { describe, expect, it } from "vitest";

import {
  QualityEvaluationError,
  evaluateSummaryQuality,
  type QualityLabeledSample,
} from "../../../packages/core/src/measurement/quality-evaluation.js";

function humanSample(
  sampleIdentifier: string,
  claimIdentifier: string,
  label: "supported" | "unsupported" | "omitted",
  labeledByUserId = "user-1",
): QualityLabeledSample {
  return {
    sampleIdentifier,
    claimIdentifier,
    label,
    labelSource: "human",
    labeledByUserId,
    labeledAtIso: "2026-09-15T00:00:00.000Z",
  };
}

describe("SUM-02-04 摘要质量评估", () => {
  it("人类标注样本给出可复算指标", () => {
    const metrics = evaluateSummaryQuality({
      labeledSamples: [
        humanSample("s1", "claim-1", "supported", "user-1"),
        humanSample("s2", "claim-2", "unsupported", "user-1"),
        humanSample("s3", "claim-3", "omitted", "user-2"),
        humanSample("s4", "claim-4", "supported", "user-2"),
      ],
      predictions: [
        { claimIdentifier: "claim-1", prediction: "supported" },
        { claimIdentifier: "claim-2", prediction: "supported" },
        { claimIdentifier: "claim-3", prediction: "omitted" },
        { claimIdentifier: "claim-4", prediction: "unsupported" },
      ],
    });
    expect(metrics.sampleCount).toBe(4);
    expect(metrics.truePositiveCount).toBe(1);
    expect(metrics.falsePositiveCount).toBe(1);
    expect(metrics.falseNegativeCount).toBe(1);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.f1).toBe(0.5);
    // 2 个非支持标注中 1 个被错判为支持。
    expect(metrics.falseSupportRate).toBe(0.5);
    expect(metrics.labelSourceSummary).toEqual({
      humanLabelCount: 4,
      distinctHumanLabelerCount: 2,
    });
  });

  it("生成模型自评一律拒绝", () => {
    expect(() =>
      evaluateSummaryQuality({
        labeledSamples: [
          {
            ...humanSample("s1", "claim-1", "supported"),
            labelSource: "model",
            labeledByUserId: null,
          },
        ],
        predictions: [{ claimIdentifier: "claim-1", prediction: "supported" }],
      }),
    ).toThrow(/生成模型自评|人类/);
    try {
      evaluateSummaryQuality({
        labeledSamples: [
          {
            ...humanSample("s1", "claim-1", "supported"),
            labelSource: "model",
            labeledByUserId: null,
          },
        ],
        predictions: [{ claimIdentifier: "claim-1", prediction: "supported" }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(QualityEvaluationError);
      expect((error as QualityEvaluationError).errorCode).toBe(
        "model-self-evaluation-rejected",
      );
    }
  });

  it("人类标注必须绑定标注者；缺预测样本集不匹配即失败", () => {
    expect(() =>
      evaluateSummaryQuality({
        labeledSamples: [
          { ...humanSample("s1", "claim-1", "supported"), labeledByUserId: null },
        ],
        predictions: [{ claimIdentifier: "claim-1", prediction: "supported" }],
      }),
    ).toThrow(/标注者/);
    expect(() =>
      evaluateSummaryQuality({
        labeledSamples: [humanSample("s1", "claim-1", "supported")],
        predictions: [],
      }),
    ).toThrow(/预测/);
  });

  it("没有负样本时 falseSupportRate 为 null（不虚报比率）", () => {
    const metrics = evaluateSummaryQuality({
      labeledSamples: [humanSample("s1", "claim-1", "supported")],
      predictions: [{ claimIdentifier: "claim-1", prediction: "supported" }],
    });
    expect(metrics.falseSupportRate).toBeNull();
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.f1).toBe(1);
  });
});
