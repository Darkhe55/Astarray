/**
 * 确定性缓存（T09，ADR-0005）。
 * 仅缓存确定性且无副作用的调用；写操作、时间敏感调用和失败默认 bypass。
 * 缓存键包含 Provider、模型、模式、输入、系统提示词哈希、工具子集哈希、
 * 上下文摘要哈希和相关文件指纹。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "./atomic-json.js";

export type CacheStatus = "hit" | "miss" | "bypass" | "stale-reject";

export interface CacheKeyParts {
  provider: string;
  model: string;
  mode: "ponder" | "assist" | "devolve";
  systemPromptHash: string;
  inputText: string;
  toolSubsetHash: string;
  contextSummaryHash: string;
  /** 相关文件指纹（内容哈希），缺失时为空字符串。 */
  fileFingerprint: string;
}

export interface CacheEntry {
  key: string;
  cachedAtIso: string;
  resultText: string;
  estimatedTokenCount: number;
  fileFingerprint: string;
}

export interface CacheBypassCriteria {
  isWriteOperation: boolean;
  isTimeSensitive: boolean;
  isFailedResult: boolean;
}

export class CacheKeyBuilder {
  static buildKey(parts: CacheKeyParts): string {
    const canonical = JSON.stringify({
      provider: parts.provider,
      model: parts.model,
      mode: parts.mode,
      systemPromptHash: parts.systemPromptHash,
      inputText: parts.inputText,
      toolSubsetHash: parts.toolSubsetHash,
      contextSummaryHash: parts.contextSummaryHash,
      fileFingerprint: parts.fileFingerprint,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  static shouldBypass(criteria: CacheBypassCriteria): boolean {
    return (
      criteria.isWriteOperation ||
      criteria.isTimeSensitive ||
      criteria.isFailedResult
    );
  }
}

export class DiskCache {
  private readonly cacheDirectoryPath: string;

  constructor(baseDirectory: string) {
    this.cacheDirectoryPath = path.join(baseDirectory, "cache");
  }

  /**
   * 读取缓存：返回 null 表示 miss；
   * 命中但记录的文件指纹与当前不符时返回 stale-reject 标记。
   */
  async get(
    key: string,
    currentFileFingerprint: string,
  ): Promise<{ status: "hit" | "miss" | "stale-reject"; entry: CacheEntry | null }> {
    const entry = await this.readEntry(key);
    if (entry === null) {
      return { status: "miss", entry: null };
    }
    if (entry.fileFingerprint !== currentFileFingerprint) {
      return { status: "stale-reject", entry: null };
    }
    return { status: "hit", entry };
  }

  async put(entry: CacheEntry): Promise<void> {
    const entryPath = this.entryFilePath(entry.key);
    await writeAtomicJson(entryPath, entry);
  }

  private async readEntry(key: string): Promise<CacheEntry | null> {
    const entryPath = this.entryFilePath(key);
    try {
      const rawContent = await fs.readFile(entryPath, "utf8");
      const parsed = JSON.parse(rawContent) as CacheEntry;
      if (typeof parsed.key !== "string" || typeof parsed.resultText !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private entryFilePath(key: string): string {
    return path.join(this.cacheDirectoryPath, `${key}.json`);
  }
}

/** 计算文件内容指纹（sha256 前缀 16 位）。 */
export async function computeFileFingerprint(
  filePath: string,
): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}
