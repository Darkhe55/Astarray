/**
 * SUM-02-04：人工标注质量评估 CLI（拒绝生成模型自评）。
 *
 * 用法：node scripts/evaluate-summary-quality.mjs --samples <labels.jsonl> --predictions <predictions.jsonl> [--package-dir <dir>]
 * labels.jsonl 每行：{sampleIdentifier, claimIdentifier, label, labelSource:"human", labeledByUserId, labeledAtIso}
 * predictions.jsonl 每行：{claimIdentifier, prediction}
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function readJsonLines(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samplesPath = readArgument("--samples", null);
const predictionsPath = readArgument("--predictions", null);
if (samplesPath === null || predictionsPath === null) {
  console.error("缺少 --samples <labels.jsonl> 或 --predictions <predictions.jsonl>");
  process.exit(2);
}
const packageDirectoryPath = readArgument("--package-dir", repositoryRoot);

const publicSdk = await import(
  pathToFileURL(path.join(packageDirectoryPath, "dist", "public-sdk.js")).href
);
const { evaluateSummaryQuality, QualityEvaluationError } = publicSdk;

try {
  const metrics = evaluateSummaryQuality({
    labeledSamples: readJsonLines(samplesPath),
    predictions: readJsonLines(predictionsPath),
  });
  console.log(JSON.stringify({ status: "ok", metrics }, null, 2));
} catch (error) {
  if (error instanceof QualityEvaluationError) {
    console.log(
      JSON.stringify({ status: "rejected", errorCode: error.errorCode, message: error.message }, null, 2),
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
