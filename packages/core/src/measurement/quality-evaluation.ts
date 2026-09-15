/**
 * SUM-02-04：摘要质量评估（人工标注样本；**拒绝生成模型自评**）。
 */
export const QUALITY_LABELS = ["supported", "unsupported", "omitted"] as const;
export type QualityLabel = (typeof QUALITY_LABELS)[number];

export interface QualityLabeledSample {
  sampleIdentifier: string;
  claimIdentifier: string;
  /** 人工判定该权威字段在叙述中的状态。 */
  label: QualityLabel;
  /** 判定者：必须是人类个体；`model` 一律拒绝（不能自评通过）。 */
  labelSource: "human" | "model";
  labeledByUserId: string | null;
  labeledAtIso: string;
}

export interface PredictedSample {
  claimIdentifier: string;
  prediction: QualityLabel;
}

export type QualityEvaluationErrorCode =
  | "model-self-evaluation-rejected"
  | "human-labeler-required"
  | "sample-set-mismatch";

export class QualityEvaluationError extends Error {
  constructor(
    readonly errorCode: QualityEvaluationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QualityEvaluationError";
  }
}

export interface QualityEvaluationMetrics {
  sampleCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  precision: number | null;
  recall: number | null
  f1: number | null;
  /** 把"不支持/遗漏"错判为"支持"的比例（最危险的错误）。 */
  falseSupportRate: number | null;
  labelSourceSummary: { humanLabelCount: number; distinctHumanLabelerCount: number };
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 计算质量指标：仅接受人类标注（`labelSource === "human"` 且带 `labeledByUserId`）。
 * 任何 model 标注、缺少标注者、样本集合不匹配都会显式失败。
 */
export function evaluateSummaryQuality(input: {
  labeledSamples: QualityLabeledSample[];
  predictions: PredictedSample[];
}): QualityEvaluationMetrics {
  if (input.labeledSamples.some((sample) => sample.labelSource === "model")) {
    throw new QualityEvaluationError(
      "model-self-evaluation-rejected",
      "拒绝生成模型自评：标注必须由人类完成",
    );
  }
  for (const sample of input.labeledSamples) {
    if (sample.labeledByUserId === null || sample.labeledByUserId.trim() === "") {
      throw new QualityEvaluationError(
        "human-labeler-required",
        "人类标注必须绑定标注者标识: " + sample.sampleIdentifier,
      );
    }
  }
  const predictionByClaim = new Map(
    input.predictions.map((prediction) => [prediction.claimIdentifier, prediction.prediction]),
  );
  if (
    input.labeledSamples.some(
      (sample) => !predictionByClaim.has(sample.claimIdentifier),
    )
  ) {
    throw new QualityEvaluationError(
      "sample-set-mismatch",
      "存在没有对应预测的标注样本",
    );
  }

  let truePositiveCount = 0;
  let falsePositiveCount = 0;
  let falseNegativeCount = 0;
  let negativeLabelCount = 0;
  let falseSupportCount = 0;
  for (const sample of input.labeledSamples) {
    const prediction = predictionByClaim.get(sample.claimIdentifier);
    if (prediction === "supported" && sample.label === "supported") {
      truePositiveCount += 1;
    } else if (prediction === "supported" && sample.label !== "supported") {
      falsePositiveCount += 1;
      falseSupportCount += 1;
    } else if (prediction !== "supported" && sample.label === "supported") {
      falseNegativeCount += 1;
    }
    if (sample.label !== "supported") {
      negativeLabelCount += 1;
    }
  }
  const precision = safeRatio(truePositiveCount, truePositiveCount + falsePositiveCount);
  const recall = safeRatio(truePositiveCount, truePositiveCount + falseNegativeCount);
  return {
    sampleCount: input.labeledSamples.length,
    truePositiveCount,
    falsePositiveCount,
    falseNegativeCount,
    precision,
    recall,
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
    falseSupportRate: safeRatio(falseSupportCount, negativeLabelCount),
    labelSourceSummary: {
      humanLabelCount: input.labeledSamples.length,
      distinctHumanLabelerCount: new Set(
        input.labeledSamples.map((sample) => sample.labeledByUserId ?? ""),
      ).size,
    },
  };
}
