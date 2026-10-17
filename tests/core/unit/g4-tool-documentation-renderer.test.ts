/**
 * G4 反例（2026-11-08 第 270 轮）：**完整公开用法必须被渲染出来**。
 *
 * 断言（逐项对照 `AGENTS.md` 的"完整公开用法"）：
 * - 组标识 + revision；
 * - 每个工具的：标识、用途、参数 schema、返回 schema、示例、失败码、幂等性、副作用类别；
 * - **末尾必须附固定提醒**（`buildReminderText()`，即 `ASTARRAY_TOOL_HELP_REQUEST_V1` 相关文案）。
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

import {
  buildReminderText,
  type ToolGroupDocumentation,
  type ToolPublicDocumentation,
} from "../../../packages/core/src/tools/tool-documentation-recall.js";
import {
  renderSingleToolDocumentation,
  renderToolGroupDocumentation,
} from "../../../packages/core/src/tools/tool-documentation-renderer.js";

const sampleTool: ToolPublicDocumentation = {
  toolIdentifier: "factVerification",
  purpose: "本地事实核查与证据包生成",
  inputSchemaJson: '{"type":"object"}',
  returnSchemaJson: '{"type":"object"}',
  examples: ['{"action":"record-reasoning"}'],
  failureCodes: ["invalid-task-chain", "tool-permission-denied"],
  isIdempotent: false,
  sideEffectCategory: "local-record",
  requiredCapabilities: ["network.read"],
  limitations: ["仅本地记录，不联网核查"],
};

const sampleGroup: ToolGroupDocumentation = {
  toolGroupIdentifier: "evidence-tools",
  toolGroupRevision: 3,
  fullDocumentation: [sampleTool],
};

describe("G4 渲染器：完整公开用法", () => {
  it("单个工具：八个字段全部出现", () => {
    const text = renderSingleToolDocumentation(sampleTool);
    expect(text).toContain("## factVerification");
    expect(text).toContain("用途：本地事实核查与证据包生成");
    expect(text).toContain('参数 schema：{"type":"object"}');
    expect(text).toContain('返回 schema：{"type":"object"}');
    expect(text).toContain('- {"action":"record-reasoning"}');
    expect(text).toContain("失败码：invalid-task-chain、tool-permission-denied");
    expect(text).toContain("幂等：否");
    expect(text).toContain("副作用类别：local-record");
    expect(text).toContain("需要能力：network.read");
    expect(text).toContain("局限：仅本地记录，不联网核查");
  });

  it("单个工具：无示例/无失败码时给出明确占位（不留空行歧义）", () => {
    const text = renderSingleToolDocumentation({
      ...sampleTool,
      examples: [],
      failureCodes: [],
    });
    expect(text).toContain("示例：（无）");
    expect(text).toContain("失败码：（无）");
  });

  it("整组：含组标识与 revision", () => {
    const text = renderToolGroupDocumentation(sampleGroup);
    expect(text).toContain("工具组 evidence-tools");
    expect(text).toContain("revision 3");
  });

  it("整组：**末尾必须附固定提醒**（模型据此请求帮助）", () => {
    const text = renderToolGroupDocumentation(sampleGroup);
    expect(text.endsWith(buildReminderText())).toBe(true);
  });

  it("整组：多工具按顺序全部渲染", () => {
    const text = renderToolGroupDocumentation({
      ...sampleGroup,
      fullDocumentation: [
        sampleTool,
        { ...sampleTool, toolIdentifier: "readFile", purpose: "读取文件" },
      ],
    });
    expect(text).toContain("## factVerification");
    expect(text).toContain("## readFile");
    expect(text.indexOf("## factVerification")).toBeLessThan(text.indexOf("## readFile"));
  });
});
