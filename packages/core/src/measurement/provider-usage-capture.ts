/**
 * SUM-02-04：Provider usage 捕获端口（本地 JSONL 记录；真实 Provider 凭据缺失时保持离线）。
 *
 * 捕获值只作为**权威来源**记录，并绑定序列化版本；版本不一致的 usage 不得复用。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { PROMPT_SERIALIZATION_VERSION } from "./token-measurement.js";
import type {
  TokenMeasurement,
  TokenMeasurementService,
} from "./token-measurement.js";

export const CAPTURED_PROVIDER_USAGE_SCHEMA_VERSION = 1;

export const capturedProviderUsageSchema = z
  .object({
    schemaVersion: z.literal(CAPTURED_PROVIDER_USAGE_SCHEMA_VERSION),
    captureIdentifier: z.string().min(1),
    requestIdentifier: z.string().min(1),
    providerIdentifier: z.string().min(1),
    modelIdentifier: z.string().min(1),
    serializationVersion: z.number().int().positive(),
    inputTokenCount: z.number().int().nonnegative(),
    outputTokenCount: z.number().int().nonnegative(),
    cachedInputTokenCount: z.number().int().nonnegative().nullable(),
    observedAtIso: z.iso.datetime(),
  })
  .strict();
export type CapturedProviderUsage = z.infer<typeof capturedProviderUsageSchema>;

export interface ProviderUsageCapturePort {
  recordUsage(usage: CapturedProviderUsage): Promise<void>;
  readAll(): Promise<CapturedProviderUsage[]>;
}

/** 本地 JSONL 捕获实现（追加写；损坏行显式失败，不静默跳过）。 */
export function createJsonlProviderUsageCapture(input: {
  filePath: string;
}): ProviderUsageCapturePort {
  return {
    async recordUsage(usage: CapturedProviderUsage): Promise<void> {
      const parsed = capturedProviderUsageSchema.parse(usage);
      await fs.mkdir(path.dirname(input.filePath), { recursive: true });
      await fs.appendFile(input.filePath, JSON.stringify(parsed) + "\n", "utf8");
    },
    async readAll(): Promise<CapturedProviderUsage[]> {
      let rawContent: string;
      try {
        rawContent = await fs.readFile(input.filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      const usages: CapturedProviderUsage[] = [];
      for (const line of rawContent.split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        const parsed = capturedProviderUsageSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          throw new Error("捕获的 usage 记录非法: " + parsed.error.message);
        }
        usages.push(parsed.data);
      }
      return usages;
    },
  };
}

/** usage 仅在与本次请求序列化版本一致时可复用。 */
export function isCapturedUsageReusableForRequest(
  usage: CapturedProviderUsage,
  input: { serializationVersion: number },
): boolean {
  return usage.serializationVersion === input.serializationVersion;
}

/** 把捕获的 usage 转为权威 TokenMeasurement（Provider 来源）。 */
export function attachProviderUsageToMeasurement(input: {
  usage: CapturedProviderUsage;
  measurementService: TokenMeasurementService;
}): TokenMeasurement {
  return input.measurementService.recordProviderUsage({
    providerIdentifier: input.usage.providerIdentifier,
    modelIdentifier: input.usage.modelIdentifier,
    tokenCount: input.usage.inputTokenCount + input.usage.outputTokenCount,
    serializationVersion: input.usage.serializationVersion,
    nowIso: input.usage.observedAtIso,
  });
}

export function describeOfflineCaptureStatus(): {
  isRealProviderCaptureAvailable: boolean;
  reason: string;
  defaultSerializationVersion: number;
} {
  return {
    isRealProviderCaptureAvailable: false,
    reason:
      "真实 Provider usage 捕获需要有效凭据与费用授权；离线环境只提供本地 JSONL 捕获端口",
    defaultSerializationVersion: PROMPT_SERIALIZATION_VERSION,
  };
}
