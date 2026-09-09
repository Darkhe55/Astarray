/**
 * T12/T14 覆盖率冲刺：atomic-json 分支边缘（Windows rename 有界重试、
 * 重试耗尽清理临时文件、备份源缺失返回 false）。
 */
import { promises as nodeFsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backupExistingFile,
  writeAtomicJson,
} from "../../../packages/core/src/infra/atomic-json.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await nodeFsPromises.mkdtemp(
    path.join(os.tmpdir(), "astarray-atomic-edge-"),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await nodeFsPromises
    .rm(temporaryDirectory, { recursive: true, force: true })
    .catch(() => {});
});

function epermError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM 瞬时占用"), { code: "EPERM" });
}

describe("atomic-json 分支边缘（覆盖率冲刺）", () => {
  it("rename 首试 EPERM 后重试成功（Windows 瞬时占用）", async () => {
    const targetPath = path.join(temporaryDirectory, "target.json");
    const originalRename = nodeFsPromises.rename.bind(nodeFsPromises);
    let renameCallCount = 0;
    vi.spyOn(nodeFsPromises, "rename").mockImplementation(
      async (from: string, to: string) => {
        renameCallCount += 1;
        if (renameCallCount === 1) {
          throw epermError();
        }
        return originalRename(from, to) as Promise<void>;
      },
    );
    await writeAtomicJson(targetPath, { ok: true });
    expect(renameCallCount).toBeGreaterThanOrEqual(2);
    const content = JSON.parse(
      await nodeFsPromises.readFile(targetPath, "utf8"),
    ) as { ok: boolean };
    expect(content.ok).toBe(true);
  });

  it("rename 持续 EPERM：重试耗尽后抛错并清理临时文件", async () => {
    const targetPath = path.join(temporaryDirectory, "target.json");
    vi.spyOn(nodeFsPromises, "rename").mockImplementation(async () => {
      throw epermError();
    });
    await expect(writeAtomicJson(targetPath, { ok: true })).rejects.toMatchObject({
      code: "EPERM",
    });
    const directoryEntries = await nodeFsPromises.readdir(temporaryDirectory);
    expect(directoryEntries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("备份源不存在时 backupExistingFile 返回 false（不抛错）", async () => {
    const result = await backupExistingFile(
      path.join(temporaryDirectory, "missing.json"),
      path.join(temporaryDirectory, "missing.json.bak"),
    );
    expect(result).toBe(false);
  });
});
