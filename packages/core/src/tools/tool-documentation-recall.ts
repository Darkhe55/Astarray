/**
 * 工具说明回访（T08B / ADR-0024 §每个 Agent 个体的工具说明回执）。
 *
 * ToolDocumentationReceiptStore：按具体 agentInstanceId + toolGroupIdentifier
 * + revision 保存首次/差异说明送达回执；个体命名空间、原子 revision、
 * 内容哈希；新 Agent 不继承，同级不共享。
 *
 * InitialToolGroupDocumentationBuilder：首次分配时只为当前已分配工具生成
 * 完整公开说明（不含未分配工具 schema、内部执行层、凭据或其他 Agent 回执）。
 *
 * SubsequentToolGroupReminderBuilder：相同 revision 后续只生成固定提醒，
 * 不重复整组 schema；工具定义变化时生成可验证 delta，无法证明完整则重发
 * 完整说明。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import { sanitizePathSegment } from "../orchestration/work-archive-store.js";

/** 固定提醒文本（ADR-0024 §决策）。 */
export const TOOL_HELP_REMINDER_TEXT =
  "如果忘记工具用法，或者缺少可用工具，请返回 `ASTARRAY_TOOL_HELP_REQUEST_V1` 标准请求；不要猜测参数、伪造工具名或重复试错。";

/** 工具公开说明（稳定 ID/用途/schema/示例/失败码/幂等性/副作用/所需权限/限制）。 */
export interface ToolPublicDocumentation {
  toolIdentifier: string;
  purpose: string;
  inputSchemaJson: string;
  returnSchemaJson: string;
  examples: string[];
  failureCodes: string[];
  isIdempotent: boolean;
  sideEffectCategory: string;
  requiredCapabilities: string[];
  limitations: string[];
}

export interface ToolGroupDocumentation {
  toolGroupIdentifier: string;
  toolGroupRevision: number;
  /** 该组全部已分配工具的完整公开说明（首次/完整重发）。 */
  fullDocumentation: ToolPublicDocumentation[];
}

export interface ToolDocumentationReceipt {
  agentInstanceId: string;
  toolGroupIdentifier: string;
  toolGroupRevision: number;
  /** 完整说明内容哈希（差异送达时仍记录组 revision 与哈希）。 */
  fullDocumentationHash: string;
  recordedAtIso: string;
}

export interface ToolDocumentationReceiptStoreOptions {
  baseDirectory: string;
}

export class ToolDocumentationReceiptStore {
  private readonly receiptsRootDirectory: string;

  constructor(options: ToolDocumentationReceiptStoreOptions) {
    this.receiptsRootDirectory = path.join(
      options.baseDirectory,
      "tool-documentation-receipts",
    );
  }

  private receiptFilePath(
    agentInstanceId: string,
    toolGroupIdentifier: string,
  ): string {
    return path.join(
      this.receiptsRootDirectory,
      sanitizePathSegment(agentInstanceId),
      `${sanitizePathSegment(toolGroupIdentifier)}.json`,
    );
  }

  /** 读取某 Agent 某工具组的回执；无回执（新个体）返回 null。 */
  async readReceipt(
    agentInstanceId: string,
    toolGroupIdentifier: string,
  ): Promise<ToolDocumentationReceipt | null> {
    try {
      const rawContent = await fs.readFile(
        this.receiptFilePath(agentInstanceId, toolGroupIdentifier),
        "utf8",
      );
      return JSON.parse(rawContent) as ToolDocumentationReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /** 保存回执（原子写入 + 内容哈希）。 */
  async saveReceipt(
    receipt: ToolDocumentationReceipt,
  ): Promise<ToolDocumentationReceipt> {
    const filePath = this.receiptFilePath(
      receipt.agentInstanceId,
      receipt.toolGroupIdentifier,
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  }
}

/** 说明注入结果（供 harness 决定发送内容）。 */
export type ToolDocumentationInjection =
  | {
      kind: "initial-full";
      documentation: ToolGroupDocumentation;
    }
  | {
      kind: "subsequent-reminder";
      toolGroupRevision: number;
    }
  | {
      kind: "delta";
      toolGroupRevision: number;
      /** 已校验的差异说明（新增/变更工具）。 */
      deltaDocumentation: ToolPublicDocumentation[];
      /** delta 是否被证明完整（否则必须完整重发）。 */
      isDeltaProvenComplete: boolean;
    };

export class ToolDocumentationRecallInjector {
  constructor(private readonly receiptStore: ToolDocumentationReceiptStore) {}

  /**
   * 决定本次任务激活的工具说明注入：
   * - 无回执 → initial-full；
   * - 回执 revision 与当前一致 → subsequent-reminder；
   * - revision 变化 → delta（可证明完整时 delta，否则 initial-full）。
   */
  async planInjection(input: {
    agentInstanceId: string;
    documentation: ToolGroupDocumentation;
    /** 差异说明（仅 revision 变化时提供；完整时该参数为 full）。 */
    deltaDocumentation?: ToolPublicDocumentation[];
    isDeltaProvenComplete: boolean;
  }): Promise<ToolDocumentationInjection> {
    const existingReceipt = await this.receiptStore.readReceipt(
      input.agentInstanceId,
      input.documentation.toolGroupIdentifier,
    );
    if (existingReceipt === null) {
      return {
        kind: "initial-full",
        documentation: input.documentation,
      };
    }
    if (existingReceipt.toolGroupRevision === input.documentation.toolGroupRevision) {
      return {
        kind: "subsequent-reminder",
        toolGroupRevision: input.documentation.toolGroupRevision,
      };
    }
    if (input.deltaDocumentation !== undefined && input.isDeltaProvenComplete) {
      return {
        kind: "delta",
        toolGroupRevision: input.documentation.toolGroupRevision,
        deltaDocumentation: input.deltaDocumentation,
        isDeltaProvenComplete: true,
      };
    }
    return {
      kind: "initial-full",
      documentation: input.documentation,
    };
  }

  /** 注入后更新回执（完整或差异送达都记录组 revision 与完整哈希）。 */
  async recordDelivery(input: {
    agentInstanceId: string;
    documentation: ToolGroupDocumentation;
  }): Promise<ToolDocumentationReceipt> {
    const fullDocumentationHash = `sha256:${createHash("sha256")
      .update(JSON.stringify(input.documentation.fullDocumentation))
      .digest("hex")}`;
    return this.receiptStore.saveReceipt({
      agentInstanceId: input.agentInstanceId,
      toolGroupIdentifier: input.documentation.toolGroupIdentifier,
      toolGroupRevision: input.documentation.toolGroupRevision,
      fullDocumentationHash,
      recordedAtIso: new Date().toISOString(),
    });
  }
}

export function buildReminderText(): string {
  return TOOL_HELP_REMINDER_TEXT;
}

/** 构建完整说明（仅已分配工具）。 */
export function buildFullDocumentation(input: {
  toolGroupIdentifier: string;
  toolGroupRevision: number;
  assignedTools: ToolPublicDocumentation[];
}): ToolGroupDocumentation {
  if (input.assignedTools.length === 0) {
    throw new DomainError(
      "invalid-task-chain",
      "工具组说明不能为空（至少包含一个已分配工具）",
    );
  }
  return {
    toolGroupIdentifier: input.toolGroupIdentifier,
    toolGroupRevision: input.toolGroupRevision,
    fullDocumentation: input.assignedTools.map((tool) => ({ ...tool })),
  };
}

export { randomUUID };
