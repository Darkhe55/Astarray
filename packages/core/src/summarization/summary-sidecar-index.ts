/**
 * SUM-01-03：源码/媒体旁置索引（只存指针，不改原格式、不复制正文）。
 *
 * 旁置索引只记录文件名/标识、revision、内容哈希、字节数与媒体类型；
 * 任何试图把原文粘进索引的写法都会被 `assertSidecarIndexIsPointerOnly` 拒绝。
 */
import { DomainError } from "../core/errors.js";

export const SIDECAR_SOURCE_KINDS = ["source-file", "media-file"] as const;
export type SidecarSourceKind = (typeof SIDECAR_SOURCE_KINDS)[number];

/** 构建旁置索引所需的最小元数据（不含任何正文内容）。 */
export interface SummarySidecarFileMetadata {
  sourceKind: SidecarSourceKind;
  /** 相对路径或稳定标识（不展开绝对路径，避免泄漏本地目录结构）。 */
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
  byteLength: number;
  mediaType: string | null;
  recordedAtIso: string;
}

export interface SummarySidecarIndexEntry extends SummarySidecarFileMetadata {
  /** 恒为 true：该索引只保存指针。 */
  pointerOnly: true;
}

/** 索引中允许出现的键（出现其他键即有携带正文的风险）。 */
const ALLOWED_POINTER_KEYS = new Set([
  "sourceKind",
  "sourceIdentifier",
  "sourceRevision",
  "contentHash",
  "byteLength",
  "mediaType",
  "recordedAtIso",
  "pointerOnly",
]);

/** 明确禁止的正文承载键（即使出现在扩展字段中也要拒绝）。 */
const FORBIDDEN_CONTENT_KEYS = new Set([
  "content",
  "text",
  "body",
  "base64",
  "bytes",
  "buffer",
  "preview",
]);

export function buildSidecarIndexEntries(
  files: SummarySidecarFileMetadata[],
): SummarySidecarIndexEntry[] {
  return [...files]
    .map((file) => ({ ...file, pointerOnly: true as const }))
    .sort((left, right) => {
      if (left.sourceKind !== right.sourceKind) {
        return left.sourceKind.localeCompare(right.sourceKind);
      }
      return left.sourceIdentifier.localeCompare(right.sourceIdentifier);
    });
}

export function assertSidecarIndexIsPointerOnly(entries: unknown[]): void {
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      throw new DomainError("journal-corrupted", "旁置索引条目非法（非对象）");
    }
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_CONTENT_KEYS.has(key)) {
        throw new DomainError(
          "journal-corrupted",
          "旁置索引禁止携带正文内容字段: " + key,
        );
      }
      if (!ALLOWED_POINTER_KEYS.has(key)) {
        throw new DomainError(
          "journal-corrupted",
          "旁置索引出现未声明字段（可能携带正文）: " + key,
        );
      }
    }
    const candidate = entry as { pointerOnly?: unknown; contentHash?: unknown };
    if (candidate.pointerOnly !== true || typeof candidate.contentHash !== "string") {
      throw new DomainError(
        "journal-corrupted",
        "旁置索引条目必须声明 pointerOnly 与 contentHash",
      );
    }
  }
}
