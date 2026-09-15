/**
 * SUM-02-04：Provider usage 本地捕获端口（版本绑定；离线如实说明）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachProviderUsageToMeasurement,
  createJsonlProviderUsageCapture,
  describeOfflineCaptureStatus,
  isCapturedUsageReusableForRequest,
  type CapturedProviderUsage,
} from "../../../packages/core/src/measurement/provider-usage-capture.js";
import { TokenMeasurementService } from "../../../packages/core/src/measurement/token-measurement.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-usage-capture-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function usage(
  captureIdentifier: string,
  serializationVersion: number,
): CapturedProviderUsage {
  return {
    schemaVersion: 1,
    captureIdentifier,
    requestIdentifier: "request-" + captureIdentifier,
    providerIdentifier: "provider-a",
    modelIdentifier: "model-a",
    serializationVersion,
    inputTokenCount: 1000,
    outputTokenCount: 250,
    cachedInputTokenCount: 128,
    observedAtIso: "2026-09-15T00:00:00.000Z",
  };
}

describe("SUM-02-04 Provider usage 捕获", () => {
  it("JSONL 追加与读回；损坏行显式失败", async () => {
    const filePath = path.join(stateDirectory, "usage", "provider-usage.jsonl");
    const capture = createJsonlProviderUsageCapture({ filePath });
    await capture.recordUsage(usage("c1", 1));
    await capture.recordUsage(usage("c2", 2));
    const all = await capture.readAll();
    expect(all.map((item) => item.captureIdentifier)).toEqual(["c1", "c2"]);
    expect(all[0]?.cachedInputTokenCount).toBe(128);

    await fs.appendFile(filePath, "{ not json }\n", "utf8");
    await expect(capture.readAll()).rejects.toThrow();
  });

  it("捕获的 usage 转为权威计量，并绑定序列化版本", async () => {
    const service = new TokenMeasurementService(() => "2026-09-15T00:00:00.000Z");
    const measurement = attachProviderUsageToMeasurement({
      usage: usage("c1", 1),
      measurementService: service,
    });
    expect(measurement.measurementSourceKind).toBe("provider-usage");
    expect(measurement.isAuthoritative).toBe(true);
    expect(measurement.accuracyClaim).toBe("provider-reported");
    expect(measurement.estimatedTokenCount).toBe(1250);
    expect(measurement.serializationVersion).toBe(1);
    expect(isCapturedUsageReusableForRequest(usage("c1", 1), { serializationVersion: 1 })).toBe(true);
    expect(isCapturedUsageReusableForRequest(usage("c1", 1), { serializationVersion: 2 })).toBe(false);
  });

  it("真实 Provider 捕获缺失时如实说明，不假装可用", () => {
    const status = describeOfflineCaptureStatus();
    expect(status.isRealProviderCaptureAvailable).toBe(false);
    expect(status.reason).toContain("凭据");
    expect(status.defaultSerializationVersion).toBe(1);
  });
});
