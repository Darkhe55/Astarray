/**
 * SUM-02-01：token 计量适配端口与来源 schema（保守估算、版本绑定、无统一换算声明、无隐式联网）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as tokenMeasurementModule from "../../../packages/core/src/measurement/token-measurement.js";
import {
  CONSERVATIVE_ESTIMATOR_VERSION,
  PROMPT_SERIALIZATION_VERSION,
  TokenMeasurementError,
  TokenMeasurementService,
  estimateTokensConservatively,
  isMeasurementReusableFor,
} from "../../../packages/core/src/measurement/token-measurement.js";

const SAMPLES: Array<{ name: string; text: string }> = [
  { name: "中英文混排", text: "请为 module 生成 integration test，覆盖 edge cases。" },
  { name: "纯中文", text: "上下文预算与摘要清单的版本绑定必须可复算。" },
  { name: "emoji", text: "状态：✅ 通过，❌ 失败，👨‍👩‍👧‍👦 全家桶，👍🏽 肤色。" },
  { name: "代码", text: "const f = (x) => x?.map((v) => v ?? 0) ?? [];" },
  { name: "数学与单位", text: "范围 ≤ 4096 ± 5%，角度 90°，系数 2²，求和 ∑，毫秒 ms。" },
];

describe("SUM-02-01 token 计量适配与来源 schema", () => {
  it("中英文/emoji/代码/数学样本：保守估算不低估且确定性", () => {
    for (const sample of SAMPLES) {
      const first = estimateTokensConservatively(sample.text);
      const second = estimateTokensConservatively(sample.text);
      expect(first.estimatedTokenCount).toBe(second.estimatedTokenCount);
      expect(first.rulesApplied).toEqual(second.rulesApplied);
      expect(first.estimatedTokenCount).toBeGreaterThan(0);
      const codePoints = [...sample.text];
      const asciiCount = codePoints.filter(
        (codePoint) => (codePoint.codePointAt(0) ?? 0) <= 0x7f,
      ).length;
      const nonAsciiCount = codePoints.length - asciiCount;
      // 不低估：至少覆盖 ASCII/4 与全部非 ASCII 码位。
      expect(first.estimatedTokenCount).toBeGreaterThanOrEqual(
        Math.ceil(asciiCount / 4),
      );
      expect(first.estimatedTokenCount).toBeGreaterThanOrEqual(nonAsciiCount);
    }
  });

  it("本地 tokenizer 命中与未命中：来源区分、回落原因明确", async () => {
    const service = new TokenMeasurementService(() => "2026-09-15T00:00:00.000Z");
    service.registerLocalAdapter({
      adapterKind: "local",
      adapterIdentifier: "local-tokenizer-a",
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      tokenizerIdentifier: "tokenizer-a",
      tokenizerVersion: "1.0.0",
      measureTokenCount: async (text: string) => text.length,
    });

    const matched = await service.measureTokenCount({
      text: "hello 世界",
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      tokenizerIdentifier: "tokenizer-a",
      tokenizerVersion: "1.0.0",
    });
    expect(matched.measurementSourceKind).toBe("local-tokenizer");
    expect(matched.accuracyClaim).toBe("tokenizer-reported");
    expect(matched.isAuthoritative).toBe(false);
    expect(matched.fallbackReason).toBeNull();
    expect(matched.serializationVersion).toBe(PROMPT_SERIALIZATION_VERSION);

    const notRegistered = await service.measureTokenCount({
      text: "hello 世界",
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      tokenizerIdentifier: "tokenizer-unknown",
      tokenizerVersion: "9.9.9",
    });
    expect(notRegistered.measurementSourceKind).toBe("conservative-estimate");
    expect(notRegistered.fallbackReason).toBe("tokenizer-not-registered");
    expect(notRegistered.accuracyClaim).toBe("none");
    expect(notRegistered.rulesApplied).toContain(CONSERVATIVE_ESTIMATOR_VERSION);

    const notDeclared = await service.measureTokenCount({
      text: "hello 世界",
      providerIdentifier: null,
      modelIdentifier: null,
    });
    expect(notDeclared.fallbackReason).toBe("no-tokenizer-declared");
  });

  it("非本地适配器一律拒绝；空文本拒绝", async () => {
    const service = new TokenMeasurementService();
    expect(() =>
      service.registerLocalAdapter({
        // 反例：伪装成适配器的远程实现
        adapterKind: "remote" as unknown as "local",
        adapterIdentifier: "remote-tokenizer",
        providerIdentifier: null,
        modelIdentifier: null,
        tokenizerIdentifier: "remote",
        tokenizerVersion: "1",
        measureTokenCount: async () => 1,
      }),
    ).toThrow(TokenMeasurementError);
    await expect(
      service.measureTokenCount({
        text: "",
        providerIdentifier: null,
        modelIdentifier: null,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-measurement-input" });
  });

  it("Provider usage 为权威来源；版本不匹配的计量不可复用", async () => {
    const service = new TokenMeasurementService(() => "2026-09-15T00:00:00.000Z");
    const providerUsage = service.recordProviderUsage({
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      tokenCount: 1234,
    });
    expect(providerUsage.measurementSourceKind).toBe("provider-usage");
    expect(providerUsage.isAuthoritative).toBe(true);
    expect(providerUsage.accuracyClaim).toBe("provider-reported");
    expect(
      isMeasurementReusableFor(providerUsage, {
        serializationVersion: PROMPT_SERIALIZATION_VERSION,
      }),
    ).toBe(true);
    expect(
      isMeasurementReusableFor(providerUsage, {
        serializationVersion: PROMPT_SERIALIZATION_VERSION + 1,
      }),
    ).toBe(false);

    const local = await service.measureTokenCount({
      text: "abc",
      providerIdentifier: null,
      modelIdentifier: null,
    });
    expect(local.measurementSourceKind).toBe("conservative-estimate");
    expect(
      isMeasurementReusableFor(local, {
        serializationVersion: PROMPT_SERIALIZATION_VERSION,
      }),
    ).toBe(true);

    const localTokenizerMeasurement = {
      ...local,
      measurementSourceKind: "local-tokenizer" as const,
      tokenizerIdentifier: "tokenizer-a",
      tokenizerVersion: "1.0.0",
    };
    expect(
      isMeasurementReusableFor(localTokenizerMeasurement, {
        serializationVersion: PROMPT_SERIALIZATION_VERSION,
        tokenizerIdentifier: "tokenizer-a",
        tokenizerVersion: "1.0.0",
      }),
    ).toBe(true);
    expect(
      isMeasurementReusableFor(localTokenizerMeasurement, {
        serializationVersion: PROMPT_SERIALIZATION_VERSION,
        tokenizerIdentifier: "tokenizer-a",
        tokenizerVersion: "2.0.0",
      }),
    ).toBe(false);
  });

  it("不声明统一字符/token 准确性：无换算常量、无比率字段", async () => {
    const exportedNames = Object.keys(tokenMeasurementModule);
    for (const exportedName of exportedNames) {
      expect(exportedName.toLowerCase()).not.toMatch(/percharacter|perchar|tokensper|charactersper/);
    }
    const service = new TokenMeasurementService();
    const measurement = await service.measureTokenCount({
      text: "样本",
      providerIdentifier: null,
      modelIdentifier: null,
    });
    const measurementKeys = Object.keys(measurement);
    expect(measurementKeys).not.toContain("charactersPerToken");
    expect(measurementKeys).not.toContain("tokensPerCharacter");
    expect(measurement.accuracyClaim).toBe("none");
    expect(measurement.measuredAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("模块本身不进行隐式联网计量（静态扫描）", async () => {
    const modulePath = path.join(
      process.cwd(),
      "packages",
      "core",
      "src",
      "measurement",
      "token-measurement.ts",
    );
    const sourceCode = await fs.readFile(modulePath, "utf8");
    for (const forbiddenFragment of [
      "node:http",
      "node:https",
      "fetch(",
      "XMLHttpRequest",
      "axios",
      "undici",
    ]) {
      expect(sourceCode).not.toContain(forbiddenFragment);
    }
  });
});
