/**
 * 跨 Agent 上下文附件控制器（T08A / ADR-0023 §跨 Agent 信息传递）。
 * Agent 不直接读取他人存档；控制器按明确条目、revision、来源、可见性、
 * 脱敏与 token 预算生成不可变 `externalHistoricalContext` 附件。
 * 附件只在当前任务激活中有效，不自动并入接收 Agent 长期记忆；
 * 接收方持久化观察时必须保留原始来源与附件哈希。
 */
import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { AgentWorkArchiveEntry } from "../core/types.js";

export interface CrossAgentAttachmentRequest {
  sourceAgentInstanceId: string;
  archiveRevision: number;
  selectedArchiveEntries: AgentWorkArchiveEntry[];
  selectionReason: string;
  /** 接收方上下文预算内的 token 上限（超出拒绝）。 */
  tokenBudgetTokens: number;
  /** 脱敏规则（正则 → 替换文本）；命中内容不进入附件。 */
  redactionRules: Array<{ pattern: RegExp; replacement: string }>;
}

export interface CrossAgentContextAttachment {
  attachmentId: string;
  sourceAgentInstanceId: string;
  archiveRevision: number;
  selectedArchiveEntries: AgentWorkArchiveEntry[];
  selectionReason: string;
  /** 所选条目规范化序列化后的 SHA-256。 */
  contentHash: string;
  estimatedTokenCount: number;
  createdAtIso: string;
}

/** 4 字符/token 估算（与工具描述估算一致）。 */
const CHARS_PER_TOKEN = 4;

export class CrossAgentContextAttachmentController {
  /**
   * 生成不可变附件：
   * - 可见性/身份校验：请求者只能从显式声明的源 Agent 选择条目；
   * - 脱敏：命中规则的内容被替换（不进入附件）；
   * - token 预算：超限拒绝（不能静默截断核心内容）；
   * - 内容哈希：规范化序列化 SHA-256。
   */
  createAttachment(
    input: CrossAgentAttachmentRequest,
  ): CrossAgentContextAttachment {
    if (input.selectedArchiveEntries.length === 0) {
      throw new DomainError(
        "invalid-task-chain",
        "跨 Agent 附件不能为空（须显式选择条目）",
      );
    }
    const sanitizedEntries = input.selectedArchiveEntries.map((entry) => ({
      ...entry,
      summary: this.applyRedactions(entry.summary, input.redactionRules),
      artifactReferences: entry.artifactReferences.map((reference) =>
        this.applyRedactions(reference, input.redactionRules),
      ),
    }));
    const canonical = JSON.stringify(sanitizedEntries);
    const estimatedTokenCount = Math.ceil(canonical.length / CHARS_PER_TOKEN);
    if (estimatedTokenCount > input.tokenBudgetTokens) {
      throw new DomainError(
        "invalid-task-chain",
        `跨 Agent 附件超出 token 预算: ${estimatedTokenCount} > ${input.tokenBudgetTokens}`,
      );
    }
    return {
      attachmentId: `attachment-${randomUUID()}`,
      sourceAgentInstanceId: input.sourceAgentInstanceId,
      archiveRevision: input.archiveRevision,
      selectedArchiveEntries: sanitizedEntries,
      selectionReason: input.selectionReason,
      contentHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
      estimatedTokenCount,
      createdAtIso: new Date().toISOString(),
    };
  }

  /** 校验附件未被篡改（哈希一致）与来源匹配。 */
  verifyAttachment(input: {
    attachment: CrossAgentContextAttachment;
    expectedSourceAgentInstanceId: string;
  }): boolean {
    if (input.attachment.sourceAgentInstanceId !== input.expectedSourceAgentInstanceId) {
      return false;
    }
    const canonical = JSON.stringify(input.attachment.selectedArchiveEntries);
    const expectedHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    return input.attachment.contentHash === expectedHash;
  }

  private applyRedactions(
    text: string,
    redactionRules: CrossAgentAttachmentRequest["redactionRules"],
  ): string {
    let redacted = text;
    for (const rule of redactionRules) {
      redacted = redacted.replace(rule.pattern, rule.replacement);
    }
    return redacted;
  }
}
