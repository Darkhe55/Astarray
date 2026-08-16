/**
 * Agent 个体记忆域与命名空间策略（T08A / ADR-0023）。
 * 主、次级、三级每个具体 Agent 都绑定唯一且不可复用的 agentInstanceId，
 * 存档以个体为最小且唯一的所有权单位。每个个体拥有独立的：
 * - 模型会话上下文与上下文预算；
 * - memory-archive.json；
 * - mission 内 work-archive.json；
 * - 读取回执、循环预算、缓存命名空间和未决消息视图。
 *
 * AgentMemoryNamespacePolicy：拒绝角色级、同级或显示名共享路径；
 * 规范路径必须包含无碰撞编码的完整 agentInstanceId，文件内 owner 字段、
 * 目录身份与运行时身份三者一致。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { z } from "zod";
import { sanitizePathSegment } from "./work-archive-store.js";

export const AGENT_MEMORY_ARCHIVE_SCHEMA_VERSION = 1;

export const agentMemoryArchiveDocumentSchema = z.object({
  schemaVersion: z.literal(AGENT_MEMORY_ARCHIVE_SCHEMA_VERSION),
  ownerAgentInstanceId: z.string().min(1),
  revision: z.number().int().min(0),
  updatedAtIso: z.iso.datetime(),
  /** 长期观察记录（带原始来源与附件哈希；不含跨 Agent 原始内容）。 */
  observations: z.array(
    z.object({
      observationId: z.string().min(1),
      recordedAtIso: z.iso.datetime(),
      summary: z.string().min(1),
      sourceAgentInstanceId: z.string().min(1).nullable(),
      sourceAttachmentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    }),
  ),
});

export type AgentMemoryArchiveDocument = z.infer<
  typeof agentMemoryArchiveDocumentSchema
>;

export interface AgentIndividualMemoryStoreOptions {
  baseDirectory: string;
}

/** 角色级共享路径（契约测试拒绝）。 */
const FORBIDDEN_SHARED_PATH_SEGMENTS = [
  "main",
  "secondary",
  "tertiary",
  "all-agents",
  "shared",
] as const;

export class AgentMemoryNamespacePolicy {
  /** 目录名是否属于合法的个体记忆命名空间（完整无碰撞编码的 agentInstanceId）。 */
  isIndividualNamespaceDirectory(directoryName: string): boolean {
    if (FORBIDDEN_SHARED_PATH_SEGMENTS.includes(
      directoryName as (typeof FORBIDDEN_SHARED_PATH_SEGMENTS)[number],
    )) {
      return false;
    }
    // 合法命名空间必须能解码回非空原始 ID（sanitize 是单射的）
    const decoded = decodeSanitizedSegment(directoryName);
    return decoded.length > 0 && sanitizePathSegment(decoded) === directoryName;
  }

  /** 校验运行时身份与目录/文件 owner 一致（三处一致）。 */
  assertOwnerConsistency(input: {
    runtimeAgentInstanceId: string;
    directoryName: string;
    documentOwnerAgentInstanceId: string;
  }): void {
    const directoryOwner = decodeSanitizedSegment(input.directoryName);
    if (
      input.runtimeAgentInstanceId !== input.documentOwnerAgentInstanceId ||
      input.runtimeAgentInstanceId !== directoryOwner
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `Agent 记忆所有权不一致（运行时/目录/文档三者必须一致）`,
      );
    }
  }
}

export class AgentIndividualMemoryStore {
  private readonly agentMemoryRootDirectory: string;
  private readonly namespacePolicy = new AgentMemoryNamespacePolicy();
  /** B6R-07：个体级进程内互斥（并发追加不丢更新/不重复 ID）。 */
  private readonly memoryMutexes = new Map<string, AsyncMutex>();

  constructor(options: AgentIndividualMemoryStoreOptions) {
    this.agentMemoryRootDirectory = path.join(
      options.baseDirectory,
      "agent-memory",
    );
  }

  private getMemoryMutex(agentInstanceId: string): AsyncMutex {
    let mutex = this.memoryMutexes.get(agentInstanceId);
    if (mutex === undefined) {
      mutex = new AsyncMutex();
      this.memoryMutexes.set(agentInstanceId, mutex);
    }
    return mutex;
  }

  /** 个体记忆目录（完整无碰撞编码的 agentInstanceId）。 */
  memoryDirectoryPath(agentInstanceId: string): string {
    return path.join(
      this.agentMemoryRootDirectory,
      sanitizePathSegment(agentInstanceId),
    );
  }

  private memoryArchiveFilePath(agentInstanceId: string): string {
    return path.join(this.memoryDirectoryPath(agentInstanceId), "memory-archive.json");
  }

  /** 读取个体记忆存档；不存在返回 null；owner 不一致拒绝。 */
  async readMemoryArchive(
    runtimeAgentInstanceId: string,
  ): Promise<AgentMemoryArchiveDocument | null> {
    const directoryName = sanitizePathSegment(runtimeAgentInstanceId);
    if (!this.namespacePolicy.isIndividualNamespaceDirectory(directoryName)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `非法的个体记忆命名空间: ${runtimeAgentInstanceId}`,
      );
    }
    const filePath = this.memoryArchiveFilePath(runtimeAgentInstanceId);
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const parsed = agentMemoryArchiveDocumentSchema.safeParse(
      JSON.parse(rawContent),
    );
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `记忆存档非法: ${parsed.error.message}`,
      );
    }
    this.namespacePolicy.assertOwnerConsistency({
      runtimeAgentInstanceId,
      directoryName,
      documentOwnerAgentInstanceId: parsed.data.ownerAgentInstanceId,
    });
    return parsed.data;
  }

  /** 追加观察记录（接收方保留原始来源与附件哈希；不得去除来源冒充自身记忆）。 */
  async appendObservation(input: {
    runtimeAgentInstanceId: string;
    summary: string;
    sourceAgentInstanceId: string | null;
    sourceAttachmentHash: string | null;
    /** B6R-07：expected revision（并发写者陈旧 revision 拒绝；缺省跳过校验）。 */
    expectedRevision?: number;
  }): Promise<AgentMemoryArchiveDocument> {
    return this.getMemoryMutex(input.runtimeAgentInstanceId).runExclusive(async () => {
      const directoryName = sanitizePathSegment(input.runtimeAgentInstanceId);
      if (!this.namespacePolicy.isIndividualNamespaceDirectory(directoryName)) {
        throw new DomainError(
          "task-sequence-permission-denied",
          `非法的个体记忆命名空间: ${input.runtimeAgentInstanceId}`,
        );
      }
      const current = await this.readMemoryArchive(input.runtimeAgentInstanceId);
      if (
        input.expectedRevision !== undefined &&
        (current?.revision ?? 0) !== input.expectedRevision
      ) {
        throw new DomainError(
          "stale-revision",
          `记忆 revision 不匹配: 现有 ${current?.revision ?? 0}，期望 ${input.expectedRevision}`,
        );
      }
      const nextRevision = (current?.revision ?? 0) + 1;
      const nextDocument: AgentMemoryArchiveDocument = {
        schemaVersion: AGENT_MEMORY_ARCHIVE_SCHEMA_VERSION,
        ownerAgentInstanceId: input.runtimeAgentInstanceId,
        revision: nextRevision,
        updatedAtIso: new Date().toISOString(),
        observations: [
          ...(current?.observations ?? []),
          {
            // B6R-07：不可复用 observation ID（随机 UUID，删除/并发不重用）
            observationId: `observation-${randomUUID()}`,
            recordedAtIso: new Date().toISOString(),
            summary: input.summary,
            sourceAgentInstanceId: input.sourceAgentInstanceId,
            sourceAttachmentHash: input.sourceAttachmentHash,
          },
        ],
      };
      const memoryDirectory = this.memoryDirectoryPath(input.runtimeAgentInstanceId);
      await fs.mkdir(memoryDirectory, { recursive: true });
      const archiveFilePath = this.memoryArchiveFilePath(input.runtimeAgentInstanceId);
      // B6R-07：写前受控备份（备份路径不进入 Agent 上下文）
      try {
        await fs.copyFile(archiveFilePath, `${archiveFilePath}.bak`);
      } catch {
        // 首次写入无既有文件
      }
      await fs.writeFile(
        archiveFilePath,
        `${JSON.stringify(nextDocument, null, 2)}\n`,
        "utf8",
      );
      return nextDocument;
    });
  }

  /** 列出现有个体记忆命名空间目录（供契约测试断言无角色级共享路径）。 */
  async listMemoryNamespaceDirectories(): Promise<string[]> {
    try {
      return await fs.readdir(this.agentMemoryRootDirectory);
    } catch {
      return [];
    }
  }
}

/** 解码 sanitize 段（isIndividualNamespaceDirectory 用）。 */
function decodeSanitizedSegment(encodedSegment: string): string {
  let decoded = "";
  let index = 0;
  while (index < encodedSegment.length) {
    const character = encodedSegment[index]!;
    if (character === "~") {
      const hex = encodedSegment.slice(index + 1, index + 5);
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
    } else {
      decoded += character;
      index += 1;
    }
  }
  return decoded;
}
