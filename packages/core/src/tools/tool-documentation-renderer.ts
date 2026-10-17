/**
 * G4（2026-11-08 第 270 轮）：**工具组完整公开用法的文本渲染器**。
 *
 * 背景：仓库里已有
 * - `buildFullDocumentation({...})` ⇒ 构造**结构化**的 `ToolGroupDocumentation`，
 * - `buildReminderText()` ⇒ 固定提醒文本，
 * 但**没有**把结构化说明渲染成提示词文本的函数（§27.5）。
 *
 * 本模块补上这一环：纯函数、无副作用、输出确定（便于断言与变异）。
 *
 * ⚠️ 依据 `AGENTS.md`：「第一次接收某工具组时获得**完整公开用法**；同一工具组 revision
 * 后续只注入固定的 `ASTARRAY_TOOL_HELP_REQUEST_V1` 提醒」——本模块只负责**完整用法**的渲染，
 * "首次 vs 后续"的选择由 `ToolDocumentationRecallInjector.planInjection` 决定。
 */
import {
  buildReminderText,
  type ToolGroupDocumentation,
  type ToolPublicDocumentation,
} from "../tools/tool-documentation-recall.js";

/** 单个工具的渲染（导出以便单测逐字段断言）。 */
export function renderSingleToolDocumentation(tool: ToolPublicDocumentation): string {
  const lines: string[] = [
    "## " + tool.toolIdentifier,
    "用途：" + tool.purpose,
    "参数 schema：" + tool.inputSchemaJson,
    "返回 schema：" + tool.returnSchemaJson,
    "示例：" + (tool.examples.length === 0 ? "（无）" : ""),
    ...tool.examples.map((example) => "- " + example),
    "失败码：" + (tool.failureCodes.length === 0 ? "（无）" : tool.failureCodes.join("、")),
    "幂等：" + (tool.isIdempotent ? "是" : "否"),
    "副作用类别：" + tool.sideEffectCategory,
    "需要能力：" + (tool.requiredCapabilities.length === 0 ? "（无）" : tool.requiredCapabilities.join("、")),
    "局限：" + (tool.limitations.length === 0 ? "（无）" : tool.limitations.join("；")),
  ];
  return lines.join("\n");
}

/**
 * 渲染整个工具组的**完整公开用法**（末尾附固定提醒）。
 *
 * 顺序：组标识与 revision → 每个工具的完整字段 → 固定提醒。
 */
export function renderToolGroupDocumentation(documentation: ToolGroupDocumentation): string {
  const sections: string[] = [
    "【工具说明】工具组 " +
      documentation.toolGroupIdentifier +
      "（revision " +
      String(documentation.toolGroupRevision) +
      "）",
    "以下为已分配工具的完整公开用法。请按 schema 传参；失败时先读失败码，不要重复试错。",
    "",
  ];
  for (const tool of documentation.fullDocumentation) {
    sections.push(renderSingleToolDocumentation(tool), "");
  }
  sections.push(buildReminderText());
  return sections.join("\n");
}
