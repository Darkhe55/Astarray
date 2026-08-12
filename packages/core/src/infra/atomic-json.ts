/**
 * 原子 JSON 读写（T03）。
 * 策略：临时文件 → flush(sync) → 同目录 rename 原子替换。
 * 备份：写入前将现有主文件复制为备份，主文件损坏时由调用方恢复。
 * Windows 下 rename 以 MoveFileEx(MOVEFILE_REPLACE_EXISTING) 替换已存在目标文件。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";

export interface JsonReadRecoveryResult {
  content: unknown;
  recoveredFromBackup: boolean;
}

export async function writeAtomicJson(
  filePath: string,
  content: unknown,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const tempFilePath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  const fileHandle = await fs.open(tempFilePath, "w");
  try {
    await fileHandle.writeFile(serialized, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  try {
    await renameWithRetryOnWindowsContention(tempFilePath, filePath);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Windows 下 rename 偶发 EPERM/EBUSY（杀软扫描临时文件等瞬时锁），
 * 做有界重试（2 次 × 50ms），避免瞬时抖动导致任务写入失败。
 */
async function renameWithRetryOnWindowsContention(
  tempFilePath: string,
  targetFilePath: string,
): Promise<void> {
  const retryableErrorCodes = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.rename(tempFilePath, targetFilePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableErrorCodes.has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

/** 将现有主文件复制为备份；主文件不存在时返回 false。 */
export async function backupExistingFile(
  filePath: string,
  backupPath: string,
): Promise<boolean> {
  try {
    await fs.copyFile(filePath, backupPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * 读取 JSON：主文件损坏时尝试备份恢复（恢复后回写主文件），
 * 主文件与备份均损坏时抛 DomainError（journal-corrupted），绝不静默覆盖。
 * 主文件不存在返回 null。
 */
export async function readJsonWithBackupRecovery(
  filePath: string,
  backupPath: string,
): Promise<JsonReadRecoveryResult | null> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return { content: JSON.parse(rawContent), recoveredFromBackup: false };
  } catch {
    try {
      const backupRawContent = await fs.readFile(backupPath, "utf8");
      const content = JSON.parse(backupRawContent) as unknown;
      await writeAtomicJson(filePath, content);
      return { content, recoveredFromBackup: true };
    } catch {
      throw new DomainError(
        "journal-corrupted",
        `文件与备份均损坏，无法恢复: ${filePath}`,
      );
    }
  }
}

/** 清理目录中与本文件同名的陈旧临时文件（崩溃残留）。 */
export async function cleanStaleTempFiles(
  directoryPath: string,
  baseFileName: string,
): Promise<void> {
  const prefix = `.${baseFileName}.`;
  let directoryEntries: string[];
  try {
    directoryEntries = await fs.readdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(
    directoryEntries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
      .map((entry) =>
        fs.rm(path.join(directoryPath, entry), { force: true }).catch(() => {}),
      ),
  );
}
