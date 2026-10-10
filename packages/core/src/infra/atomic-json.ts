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

export interface WriteAtomicJsonOptions {
  /**
   * 提交前守卫（可选）：在临时文件已写入并 fsync 之后、**rename 提交之前**调用。
   *
   * 用途：乐观并发控制——调用方在此复核目标文件是否仍是自己已知的状态；
   * 若已变化则抛错，本次写入不会提交（临时文件会被清理）。
   * 注意：这消除"先检查后写入"之间的窗口，但不构成分布式共识。
   */
  beforeCommit?: () => Promise<void>;
}

export async function writeAtomicJson(
  filePath: string,
  content: unknown,
  options: WriteAtomicJsonOptions = {},
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
    // 提交前守卫：把"复核磁盘状态"放在 rename 紧前面，最小化检查与提交之间的窗口。
    if (options.beforeCommit !== undefined) {
      await options.beforeCommit();
    }
    await renameWithRetryOnWindowsContention(tempFilePath, filePath);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Windows 下 rename 偶发 EPERM/EBUSY（杀软扫描、索引器或并发读句柄造成的**瞬时锁**），
 * 做**有界指数退避**重试。
 *
 * 2026-10-09 实测教训：原实现只重试 3 次 × 50ms（合计约 150ms），在**默认高并发**
 * （`npm run test:coverage` / `npm run check` / `smoke-install` 内部的 `prepack`）下
 * 重试预算会被耗尽并抛出 EPERM——真实抓到
 * `missions/<id>/summary.json` 的 `.tmp → summary.json` rename EPERM，
 * 表现为整测试套件偶发失败（隔离运行时从不复现）。
 *
 * 现改为 7 次、25→800ms 指数退避（合计约 1.6 秒）：
 * - 仍然**有界**（绝不无限重试，符合仓库"有界重试"纪律）；
 * - 非可重试错误码**立即**抛出，不掩盖真实错误；
 * - 预算耗尽后照旧抛出最后一次错误，不静默吞掉。
 */
async function renameWithRetryOnWindowsContention(
  tempFilePath: string,
  targetFilePath: string,
): Promise<void> {
  const retryableErrorCodes = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
  const maximumAttemptCount = 7;
  const maximumDelayMilliseconds = 800;
  let delayMilliseconds = 25;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maximumAttemptCount; attempt++) {
    try {
      await fs.rename(tempFilePath, targetFilePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableErrorCodes.has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      if (attempt === maximumAttemptCount - 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
      delayMilliseconds = Math.min(delayMilliseconds * 2, maximumDelayMilliseconds);
    }
  }
  throw lastError;
}

/**
 * 删除 JSON 主文件前先备份为 .bak（破坏性操作集中在底层模块，调用方不直接 rm）。
 * 主文件不存在时返回 false；删除失败由调用方处理。
 */
export async function removeJsonFileWithBackup(
  filePath: string,
  backupPath: string,
): Promise<boolean> {
  const hasBackedUp = await backupExistingFile(filePath, backupPath);
  if (!hasBackedUp) {
    return false;
  }
  await fs.rm(filePath, { force: true });
  return true;
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
