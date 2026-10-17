/**
 * G4 反例（2026-11-08 第 273 轮）：**公开用法不得"半套"**。
 *
 * 依据 `AGENTS.md`：「第一次接收某工具组时获得**完整公开用法**」。
 * 描述符只能提供 5 项；后 5 项必须**显式登记** ⇒ 本文件断言：
 * - 合并后 10 项齐全；
 * - 登记缺失/为空 ⇒ **抛错**（fail-closed，不注入半套说明）。
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

import { buildToolPublicDocumentation } from "../../../packages/core/src/tools/tool-public-documentation-registry.js";

const descriptor = {
  name: "factVerification",
  summary: "本地事实核查与证据包生成",
  mutationKind: "none" as const,
  isIdempotent: false,
  inputSchema: { type: "object" },
};

const registryEntry = {
  examples: ['{"action":"record-reasoning"}'],
  failureCodes: ["invalid-task-chain"],
  returnSchemaJson: '{"type":"object"}',
  requiredCapabilities: ["network.read"],
  limitations: ["仅本地记录，不联网核查"],
};

describe("G4 公开用法生产者：完整且 fail-closed", () => {
  it("合并后 10 项齐全，且来自正确来源", () => {
    const doc = buildToolPublicDocumentation({ descriptor, registryEntry });
    expect(doc.toolIdentifier).toBe("factVerification");
    expect(doc.purpose).toBe("本地事实核查与证据包生成");
    expect(doc.inputSchemaJson).toBe('{"type":"object"}');
    expect(doc.sideEffectCategory).toBe("none");
    expect(doc.isIdempotent).toBe(false);
    expect(doc.examples).toEqual(['{"action":"record-reasoning"}']);
    expect(doc.failureCodes).toEqual(["invalid-task-chain"]);
    expect(doc.returnSchemaJson).toBe('{"type":"object"}');
    expect(doc.requiredCapabilities).toEqual(["network.read"]);
    expect(doc.limitations).toEqual(["仅本地记录，不联网核查"]);
  });

  it("**未登记** ⇒ 抛错（禁止推导或编造）", () => {
    expect(() => buildToolPublicDocumentation({ descriptor, registryEntry: null })).toThrow(
      /缺少公开用法登记/,
    );
  });

  it("示例为空 ⇒ 抛错", () => {
    expect(() =>
      buildToolPublicDocumentation({
        descriptor,
        registryEntry: { ...registryEntry, examples: [] },
      }),
    ).toThrow(/examples/);
  });

  it("失败码为空 ⇒ 抛错", () => {
    expect(() =>
      buildToolPublicDocumentation({
        descriptor,
        registryEntry: { ...registryEntry, failureCodes: [] },
      }),
    ).toThrow(/failureCodes/);
  });

  it("**局限为空 ⇒ 抛错**（不得装作没有局限）", () => {
    expect(() =>
      buildToolPublicDocumentation({
        descriptor,
        registryEntry: { ...registryEntry, limitations: [] },
      }),
    ).toThrow(/limitations/);
  });

  it("返回 schema 为空白 ⇒ 抛错", () => {
    expect(() =>
      buildToolPublicDocumentation({
        descriptor,
        registryEntry: { ...registryEntry, returnSchemaJson: "   " },
      }),
    ).toThrow(/returnSchemaJson/);
  });
});
