/**
 * SUM-02-01：token 计量适配端口与来源 schema（保守估算优先，绝不隐式联网）。
 *
 * 原则（见 docs/adr/0035-token-measurement-adapters.md）：
 * - 计量结果必须携带来源（Provider usage / 本地 tokenizer / 保守估算）与版本，
 *   区分 provider、模型、tokenizer 与本地序列化版本；
 * - 未知组合一律回落到**保守估算**（宁可高估，不低估），并标注 `fallbackReason`；
 * - **不声明统一字符/token 准确率**：DTO 无 `charactersPerToken` 之类字段；
 * - 本模块不进行任何网络访问；适配器注册时强制 `adapterKind === "local"`。
 */
import { z } from "zod";

export const TOKEN_MEASUREMENT_SCHEMA_VERSION = 1;
/** 本地提示/上下文序列化版本（版本变化使既有计量不可复用）。 */
export const PROMPT_SERIALIZATION_VERSION = 1;
export const CONSERVATIVE_ESTIMATOR_VERSION = "conservative-estimate-v1";

export const TOKEN_MEASUREMENT_SOURCE_KINDS = [
  "provider-usage",
  "local-tokenizer",
  "conservative-estimate",
] as const;
export type TokenMeasurementSourceKind =
  (typeof TOKEN_MEASUREMENT_SOURCE_KINDS)[number];

export type TokenMeasurementErrorCode =
  | "non-local-adapter-rejected"
  | "invalid-measurement-input";

export class TokenMeasurementError extends Error {
  constructor(
    readonly errorCode: TokenMeasurementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TokenMeasurementError";
  }
}

export const tokenMeasurementSchema = z
  .object({
    schemaVersion: z.literal(TOKEN_MEASUREMENT_SCHEMA_VERSION),
    measurementSourceKind: z.enum(TOKEN_MEASUREMENT_SOURCE_KINDS),
    providerIdentifier: z.string().min(1).nullable(),
    modelIdentifier: z.string().min(1).nullable(),
    tokenizerIdentifier: z.string().min(1).nullable(),
    tokenizerVersion: z.string().min(1).nullable(),
    /** 本次计量对应的本地序列化版本；与请求序列化版本不一致时不可复用。 */
    serializationVersion: z.number().int().positive(),
    estimatedTokenCount: z.number().int().nonnegative(),
    /** 仅 Provider 返回的 usage 为 true；本地 tokenizer 与估算均为 false。 */
    isAuthoritative: z.boolean(),
    /** 明确不声明统一字符/token 准确性。 */
    accuracyClaim: z.enum(["none", "provider-reported", "tokenizer-reported"]),
    rulesApplied: z.array(z.string().min(1)),
    fallbackReason: z.string().min(1).nullable(),
    measuredAtIso: z.iso.datetime(),
  })
  .strict();
export type TokenMeasurement = z.infer<typeof tokenMeasurementSchema>;

export interface ConservativeEstimate {
  estimatedTokenCount: number;
  rulesApplied: string[];
}

/**
 * 保守估算（确定性、可复算）：取下列上界规则的最大值再加 5%+1 的余量。
 * 规则只声明"不低估"，不声明与任何具体 tokenizer 的准确率一致。
 */
export function estimateTokensConservatively(text: string): ConservativeEstimate {
  const codePoints = [...text];
  let asciiCharacterCount = 0;
  let nonAsciiCodePointCount = 0;
  for (const codePoint of codePoints) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      asciiCharacterCount += 1;
    } else {
      nonAsciiCodePointCount += 1;
    }
  }
  const utf8ByteLength = Buffer.byteLength(text, "utf8");
  const rulesApplied: string[] = [];
  let upperBound = 0;
  const byteRule = Math.ceil(utf8ByteLength / 3);
  rulesApplied.push("utf8-bytes/3=" + String(byteRule));
  upperBound = Math.max(upperBound, byteRule);
  const asciiRule = Math.ceil(asciiCharacterCount / 3);
  rulesApplied.push("ascii-characters/3=" + String(asciiRule));
  upperBound = Math.max(upperBound, asciiRule);
  const nonAsciiRule = nonAsciiCodePointCount;
  rulesApplied.push("non-ascii-code-points=" + String(nonAsciiRule));
  upperBound = Math.max(upperBound, nonAsciiRule);
  const padding = Math.max(1, Math.ceil(upperBound * 0.05));
  rulesApplied.push("padding-5%-plus-1=" + String(padding));
  return {
    estimatedTokenCount: upperBound + padding,
    rulesApplied,
  };
}

/** 本地计量适配器（禁止远程/联网实现；注册时强制校验）。 */
export interface LocalTokenMeasurementAdapterPort {
  adapterKind: "local";
  adapterIdentifier: string;
  providerIdentifier: string | null;
  modelIdentifier: string | null;
  tokenizerIdentifier: string;
  tokenizerVersion: string;
  measureTokenCount(text: string): Promise<number>;
}

export interface MeasureTokenCountInput {
  text: string;
  providerIdentifier: string | null;
  modelIdentifier: string | null;
  tokenizerIdentifier?: string | null;
  tokenizerVersion?: string | null;
  serializationVersion?: number;
  nowIso?: string;
}

export function isMeasurementReusableFor(
  measurement: TokenMeasurement,
  input: {
    serializationVersion: number;
    tokenizerIdentifier?: string | null;
    tokenizerVersion?: string | null;
  },
): boolean {
  if (measurement.serializationVersion !== input.serializationVersion) {
    return false;
  }
  if (measurement.measurementSourceKind !== "local-tokenizer") {
    return true;
  }
  return (
    (input.tokenizerIdentifier ?? null) === measurement.tokenizerIdentifier &&
    (input.tokenizerVersion ?? null) === measurement.tokenizerVersion
  );
}

export class TokenMeasurementService {
  private readonly localAdapters: LocalTokenMeasurementAdapterPort[] = [];

  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  /** 注册本地适配器；任何非 local 实现一律拒绝（无隐式联网计量）。 */
  registerLocalAdapter(adapter: LocalTokenMeasurementAdapterPort): void {
    if (adapter.adapterKind !== "local") {
      throw new TokenMeasurementError(
        "non-local-adapter-rejected",
        "只允许本地计量适配器，拒绝远程/联网实现: " + String(adapter.adapterIdentifier),
      );
    }
    this.localAdapters.push(adapter);
  }

  private selectAdapter(input: MeasureTokenCountInput): LocalTokenMeasurementAdapterPort | null {
    const tokenizerIdentifier = input.tokenizerIdentifier ?? null;
    const tokenizerVersion = input.tokenizerVersion ?? null;
    if (tokenizerIdentifier === null || tokenizerVersion === null) {
      return null;
    }
    return (
      this.localAdapters.find(
        (adapter) =>
          adapter.tokenizerIdentifier === tokenizerIdentifier &&
          adapter.tokenizerVersion === tokenizerVersion &&
          adapter.providerIdentifier === input.providerIdentifier &&
          adapter.modelIdentifier === input.modelIdentifier,
      ) ?? null
    );
  }

  async measureTokenCount(input: MeasureTokenCountInput): Promise<TokenMeasurement> {
    if (input.text.length === 0) {
      throw new TokenMeasurementError(
        "invalid-measurement-input",
        "计量文本为空，拒绝产生无意义计量",
      );
    }
    const serializationVersion =
      input.serializationVersion ?? PROMPT_SERIALIZATION_VERSION;
    const measuredAtIso = input.nowIso ?? this.nowIso();
    const adapter = this.selectAdapter(input);
    if (adapter !== null) {
      const tokenCount = await adapter.measureTokenCount(input.text);
      return tokenMeasurementSchema.parse({
        schemaVersion: TOKEN_MEASUREMENT_SCHEMA_VERSION,
        measurementSourceKind: "local-tokenizer",
        providerIdentifier: input.providerIdentifier,
        modelIdentifier: input.modelIdentifier,
        tokenizerIdentifier: adapter.tokenizerIdentifier,
        tokenizerVersion: adapter.tokenizerVersion,
        serializationVersion,
        estimatedTokenCount: Math.max(0, Math.trunc(tokenCount)),
        isAuthoritative: false,
        accuracyClaim: "tokenizer-reported",
        rulesApplied: ["local-tokenizer:" + adapter.adapterIdentifier],
        fallbackReason: null,
        measuredAtIso,
      });
    }
    const estimate = estimateTokensConservatively(input.text);
    return tokenMeasurementSchema.parse({
      schemaVersion: TOKEN_MEASUREMENT_SCHEMA_VERSION,
      measurementSourceKind: "conservative-estimate",
      providerIdentifier: input.providerIdentifier,
      modelIdentifier: input.modelIdentifier,
      tokenizerIdentifier: input.tokenizerIdentifier ?? null,
      tokenizerVersion: input.tokenizerVersion ?? null,
      serializationVersion,
      estimatedTokenCount: estimate.estimatedTokenCount,
      isAuthoritative: false,
      accuracyClaim: "none",
      rulesApplied: [CONSERVATIVE_ESTIMATOR_VERSION, ...estimate.rulesApplied],
      fallbackReason:
        input.tokenizerIdentifier === undefined || input.tokenizerIdentifier === null
          ? "no-tokenizer-declared"
          : "tokenizer-not-registered",
      measuredAtIso,
    });
  }

  /** 记录 Provider 返回的权威 usage（SUM-02-04 接入；此处只做来源 schema 与版本绑定）。 */
  recordProviderUsage(input: {
    providerIdentifier: string;
    modelIdentifier: string;
    tokenCount: number;
    serializationVersion?: number;
    nowIso?: string;
  }): TokenMeasurement {
    return tokenMeasurementSchema.parse({
      schemaVersion: TOKEN_MEASUREMENT_SCHEMA_VERSION,
      measurementSourceKind: "provider-usage",
      providerIdentifier: input.providerIdentifier,
      modelIdentifier: input.modelIdentifier,
      tokenizerIdentifier: null,
      tokenizerVersion: null,
      serializationVersion:
        input.serializationVersion ?? PROMPT_SERIALIZATION_VERSION,
      estimatedTokenCount: Math.max(0, Math.trunc(input.tokenCount)),
      isAuthoritative: true,
      accuracyClaim: "provider-reported",
      rulesApplied: ["provider-usage"],
      fallbackReason: null,
      measuredAtIso: input.nowIso ?? this.nowIso(),
    });
  }
}
