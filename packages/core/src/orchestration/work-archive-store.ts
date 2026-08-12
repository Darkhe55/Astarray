/**
 * Agent 工作存档（T05A）。
 * 每个次级/三级 Agent 个体拥有独立工作存档文件：
 * .astarray/missions/<missionId>/agents/<agentInstanceId>/work-archive.json
 *
 * 规则：
 * - 存档只保存可恢复、可复用的摘要与产物引用，不默认保存完整模型上下文或敏感值。
 * - 上级发布任务或重新调用前，只选择具体条目附加（AgentWorkArchiveAttachment），
 *   默认不注入完整存档。
 */
import path from "node:path";

import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";
import { agentWorkArchiveDocumentSchema } from "../core/schemas.js";
import { AGENT_WORK_ARCHIVE_SCHEMA_VERSION } from "../core/types.js";
import type {
  AgentRole,
  AgentWorkArchiveAttachment,
  AgentWorkArchiveDocument,
  AgentWorkArchiveEntry,
} from "../core/types.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { writeAtomicJson } from "../infra/atomic-json.js";

export interface AgentWorkArchiveStoreOptions {
  baseDirectory: string;
}

export class AgentWorkArchiveStore {
  private readonly stateDirectory: string;
  private readonly agentMutexes = new Map<string, AsyncMutex>();

  constructor(options: AgentWorkArchiveStoreOptions) {
    this.stateDirectory = options.baseDirectory;
  }

  private archiveDirectoryPath(
    missionId: string,
    agentInstanceId: string,
  ): string {
    return path.join(
      this.stateDirectory,
      "missions",
      sanitizePathSegment(missionId),
      "agents",
      sanitizePathSegment(agentInstanceId),
    );
  }

  private archiveFilePath(missionId: string, agentInstanceId: string): string {
    return path.join(
      this.archiveDirectoryPath(missionId, agentInstanceId),
      "work-archive.json",
    );
  }

  private getAgentMutex(agentInstanceId: string): AsyncMutex {
    let mutex = this.agentMutexes.get(agentInstanceId);
    if (mutex === undefined) {
      mutex = new AsyncMutex();
      this.agentMutexes.set(agentInstanceId, mutex);
    }
    return mutex;
  }

  /** 追加一条存档条目；revision 单调递增，写入原子替换。 */
  async appendEntry(input: {
    missionId: string;
    agentInstanceId: string;
    agentRole: "secondary" | "tertiary";
    entry: Omit<AgentWorkArchiveEntry, "archiveEntryId" | "recordedAtIso">;
  }): Promise<AgentWorkArchiveDocument> {
    return this.getAgentMutex(input.agentInstanceId).runExclusive(async () => {
      const current = await this.readArchiveInternal(
        input.missionId,
        input.agentInstanceId,
      );
      const nextRevision = (current?.revision ?? 0) + 1;
      const newEntry: AgentWorkArchiveEntry = {
        ...input.entry,
        archiveEntryId: `archive-entry-${input.agentInstanceId}-${nextRevision}`,
        recordedAtIso: new Date().toISOString(),
      };
      const document: AgentWorkArchiveDocument = {
        schemaVersion: AGENT_WORK_ARCHIVE_SCHEMA_VERSION,
        missionId: input.missionId,
        agentInstanceId: input.agentInstanceId,
        agentRole: input.agentRole,
        revision: nextRevision,
        updatedAtIso: new Date().toISOString(),
        entries: [...(current?.entries ?? []), newEntry],
      };
      const parsed = agentWorkArchiveDocumentSchema.safeParse(document);
      if (!parsed.success) {
        throw new DomainError(
          "invalid-task-chain",
          `工作存档文档非法: ${parsed.error.message}`,
        );
      }
      await writeAtomicJson(
        this.archiveFilePath(input.missionId, input.agentInstanceId),
        parsed.data,
      );
      return parsed.data;
    });
  }

  /** 读取完整存档；不存在返回 null。 */
  async readArchive(
    missionId: string,
    agentInstanceId: string,
  ): Promise<AgentWorkArchiveDocument | null> {
    return this.readArchiveInternal(missionId, agentInstanceId);
  }

  /** 列出某 mission 下已有存档的 Agent（目录名即安全编码后的 ID，可回传 readArchive）。 */
  async listAgentIdsWithArchive(missionId: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const agentsDirectory = path.join(
      this.stateDirectory,
      "missions",
      sanitizePathSegment(missionId),
      "agents",
    );
    try {
      return await readdir(agentsDirectory);
    } catch {
      return [];
    }
  }

  private async readArchiveInternal(
    missionId: string,
    agentInstanceId: string,
  ): Promise<AgentWorkArchiveDocument | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const rawContent = await readFile(
        this.archiveFilePath(missionId, agentInstanceId),
        "utf8",
      );      const parsed = agentWorkArchiveDocumentSchema.safeParse(
        JSON.parse(rawContent),
      );
      if (!parsed.success) {
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  /**
   * 构造"选择性附加"快照：只包含指定条目，绝不包含完整存档。
   * contentHash 为所选条目规范化序列化后的 SHA-256。
   */
  buildAttachment(input: {
    archiveOwnerAgentInstanceId: string;
    archive: AgentWorkArchiveDocument;
    selectedArchiveEntryIds: string[];
    selectionReason: string;
  }): AgentWorkArchiveAttachment | null {
    const selectedEntries = input.archive.entries.filter((entry) =>
      input.selectedArchiveEntryIds.includes(entry.archiveEntryId),
    );
    if (selectedEntries.length === 0) {
      return null;
    }
    const canonical = JSON.stringify(selectedEntries);
    const contentHash = `sha256:${createHash("sha256")
      .update(canonical)
      .digest("hex")}`;
    return {
      archiveOwnerAgentInstanceId: input.archiveOwnerAgentInstanceId,
      archiveRevision: input.archive.revision,
      selectedArchiveEntries: selectedEntries,
      selectionReason: input.selectionReason,
      contentHash,
    };
  }

  /** 供测试：校验附件 contentHash 与所选条目一致。 */
  static verifyAttachmentHash(
    attachment: AgentWorkArchiveAttachment,
  ): boolean {
    const canonical = JSON.stringify(attachment.selectedArchiveEntries);
    const expectedHash = `sha256:${createHash("sha256")
      .update(canonical)
      .digest("hex")}`;
    return attachment.contentHash === expectedHash;
  }
}

export type { AgentRole };

/**
 * 将 Agent/任务标识编码为文件系统安全路径段（审计 S6 无碰撞编码）。
 * - 安全字符集含转义符 `~`；其余字符按 UTF-16 码元转义为 `~XXXX`（4 位十六进制，
 *   代理对拆分为两个转义，解码时自然还原）。
 * - 编码是单射且幂等：sanitize(sanitize(x)) === sanitize(x)，不同 ID 不会映射到同一目录。
 */
export function sanitizePathSegment(identifier: string): string {
  let encoded = "";
  for (const character of identifier) {
    if (/[A-Za-z0-9._~-]/.test(character)) {
      encoded += character;
    } else {
      encoded += `~${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
  return encoded;
}

/** 解码路径段回原始标识（供审计/调试与测试验证单射性）。 */
export function decodePathSegment(encodedIdentifier: string): string {
  let decoded = "";
  let index = 0;
  while (index < encodedIdentifier.length) {
    const character = encodedIdentifier[index]!;
    if (character === "~") {
      const hex = encodedIdentifier.slice(index + 1, index + 5);
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
    } else {
      decoded += character;
      index += 1;
    }
  }
  return decoded;
}
