/**
 * 项目侦察摘要存储（T08C-04 / ADR-0025 §3）。
 *
 * 持久化 PROJECT_CONTEXT_DIGEST_V1：版本化、revision 单调、
 * 同 digestId 旧 revision 拒绝（幂等）；项目指纹变化后旧摘要标记
 * stale，可请求增量复查而非重新注入全部历史。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import { projectContextDigestSchema } from "./agent-routing-schemas.js";
import type { z } from "zod";

export type ProjectContextDigestDocument = z.infer<
  typeof projectContextDigestSchema
>;

export interface ProjectReconnaissanceDigestStoreOptions {
  baseDirectory: string;
}

export class ProjectReconnaissanceDigestStore {
  private readonly digestRootDirectory: string;

  constructor(options: ProjectReconnaissanceDigestStoreOptions) {
    this.digestRootDirectory = path.join(
      options.baseDirectory,
      "project-reconnaissance-digests",
    );
  }

  private digestFilePath(digestId: string): string {
    return path.join(
      this.digestRootDirectory,
      `${sanitizePathSegment(digestId)}.json`,
    );
  }

  private backupFilePath(digestId: string): string {
    return `${this.digestFilePath(digestId)}.bak`;
  }

  async readDigest(
    digestId: string,
  ): Promise<ProjectContextDigestDocument | null> {
    try {
      const rawContent = await fs.readFile(this.digestFilePath(digestId), "utf8");
      const parsed = projectContextDigestSchema.safeParse(
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

  async listDigests(): Promise<ProjectContextDigestDocument[]> {
    try {
      const fileNames = await fs.readdir(this.digestRootDirectory);
      const digests: ProjectContextDigestDocument[] = [];
      for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
        const digest = await this.readDigest(fileName.slice(0, -".json".length));
        if (digest !== null) {
          digests.push(digest);
        }
      }
      return digests;
    } catch {
      return [];
    }
  }

  /**
   * 保存摘要：revision 必须比现有单调递增；写入前自动备份。
   */
  async saveDigest(
    digest: ProjectContextDigestDocument,
  ): Promise<void> {
    const existing = await this.readDigest(digest.digestId);
    if (existing !== null && digest.revision <= existing.revision) {
      throw new DomainError(
        "stale-revision",
        `侦察摘要 revision 不单调: ${digest.digestId}（现有 ${existing.revision}，期望 ${digest.revision}）`,
      );
    }
    await fs.mkdir(this.digestRootDirectory, { recursive: true });
    const filePath = this.digestFilePath(digest.digestId);
    try {
      await fs.copyFile(filePath, this.backupFilePath(digest.digestId));
    } catch {
      // 首次写入无既有文件
    }
    await fs.writeFile(
      filePath,
      `${JSON.stringify(digest, null, 2)}\n`,
      "utf8",
    );
  }

  /** 项目指纹变化后标记旧摘要为 stale（不删除历史）。 */
  async markStale(digestId: string): Promise<boolean> {
    const existing = await this.readDigest(digestId);
    if (existing === null) {
      return false;
    }
    const updated: ProjectContextDigestDocument = {
      ...existing,
      isStale: true,
      revision: existing.revision + 1,
    };
    await this.saveDigest(updated);
    return true;
  }
}
