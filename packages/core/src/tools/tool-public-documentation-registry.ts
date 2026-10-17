/**
 * G4（2026-11-08 第 273 轮）：**工具公开用法的生产者**（注册表 + 描述符合并）。
 *
 * ## 为什么不是"从描述符推导"
 *
 * `ToolDescriptor` 只有 5 项能对上 `ToolPublicDocumentation` 的 10 项：
 *
 * | 可推导（5） | 无来源（5） |
 * | --- | --- |
 * | `toolIdentifier` ← `name` | `examples`（示例） |
 * | `purpose` ← `summary` | `failureCodes`（失败码） |
 * | `inputSchemaJson` ← `inputSchema` | `returnSchemaJson`（返回 schema） |
 * | `isIdempotent` ← `isIdempotent` | `requiredCapabilities`（需要能力） |
 * | `sideEffectCategory` ← `mutationKind` | `limitations`（局限） |
 *
 * `AGENTS.md` 要求「**完整**公开用法」⇒ 后 5 项**不能推导、也不能编造** ⇒ 必须**显式登记**。
 *
 * ## 因此本模块的语义
 *
 * 由调用方提供**注册项**（后 5 项）+ 描述符（前 5 项）合并成 `ToolPublicDocumentation`；
 * **注册项缺失或为空 ⇒ 抛错**（fail-closed：宁可不注入，也不注入"半套"说明）。
 */
import type { ToolDescriptor } from "../core/types.js";
import type { ToolPublicDocumentation } from "./tool-documentation-recall.js";

/** 必须由调用方**显式登记**的 5 项（描述符里没有权威来源）。 */
export interface ToolPublicDocumentationRegistryEntry {
  /** 至少一条真实可运行的调用示例（JSON 字符串）。 */
  examples: string[];
  /** 该工具可能返回的失败码（至少一条）。 */
  failureCodes: string[];
  /** 返回值 schema（JSON 字符串）。 */
  returnSchemaJson: string;
  /** 需要的能力（权限能力 ID；无则空数组）。 */
  requiredCapabilities: string[];
  /** 已知局限（如实描述；至少一条，禁止留空"装作没有局限"）。 */
  limitations: string[];
}

/**
 * 合并描述符与注册项，得到**完整**公开用法。
 *
 * @throws 当注册项缺失、`examples` 为空、`failureCodes` 为空、`limitations` 为空、
 *         或 `returnSchemaJson` 为空时抛错（fail-closed）。
 */
export function buildToolPublicDocumentation(input: {
  descriptor: Pick<ToolDescriptor, "name" | "summary" | "mutationKind" | "isIdempotent" | "inputSchema">;
  registryEntry: ToolPublicDocumentationRegistryEntry | null | undefined;
}): ToolPublicDocumentation {
  const { descriptor, registryEntry } = input;
  const missing: string[] = [];
  if (registryEntry === null || registryEntry === undefined) {
    throw new Error(
      "工具 " + descriptor.name + " 缺少公开用法登记（examples/failureCodes/returnSchemaJson/limitations 无权威来源，禁止推导或编造）",
    );
  }
  if (registryEntry.examples.length === 0) missing.push("examples");
  if (registryEntry.failureCodes.length === 0) missing.push("failureCodes");
  if (registryEntry.returnSchemaJson.trim() === "") missing.push("returnSchemaJson");
  if (registryEntry.limitations.length === 0) missing.push("limitations");
  if (missing.length > 0) {
    throw new Error("工具 " + descriptor.name + " 的公开用法登记不完整: " + missing.join("、"));
  }
  return {
    toolIdentifier: descriptor.name,
    purpose: descriptor.summary,
    inputSchemaJson: JSON.stringify(descriptor.inputSchema ?? {}),
    returnSchemaJson: registryEntry.returnSchemaJson,
    examples: [...registryEntry.examples],
    failureCodes: [...registryEntry.failureCodes],
    isIdempotent: descriptor.isIdempotent,
    sideEffectCategory: descriptor.mutationKind,
    requiredCapabilities: [...registryEntry.requiredCapabilities],
    limitations: [...registryEntry.limitations],
  };
}
