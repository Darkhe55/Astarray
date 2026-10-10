/**
 * 原子写 rename 重试的**确定性**回归测试（E2E-01-04 抖动修复，2026-10-09）。
 *
 * 背景（真实抓到的证据）：默认高并发跑 `npm run test:coverage` 时出现过
 * `EPERM: operation not permitted, rename '…\.summary.json.<pid>.<uuid>.tmp' -> '…\summary.json'`
 * ——即 Windows 上目标文件被瞬时占用（杀软/索引器/并发读句柄）导致 rename 失败。
 * 原实现只重试 3 次 × 50ms（约 150ms），预算被耗尽后抛出，表现为整测试套件偶发失败。
 *
 * 本测试**不靠"再跑一遍看看"**，而是直接 mock `fs.rename` 断言三条契约：
 *  1. 瞬时 EPERM → 必须重试并在随后成功（写入最终成功）；
 *  2. EPERM 持续 → 必须**有界**失败（次数恰好为上限，不得无限重试）；
 *  3. 非可重试错误码（ENOENT）→ **立即**抛出，不得重试。
 */
import { promises as fsPromises } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeAtomicJson } from "../../../packages/core/src/infra/atomic-json.js";

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "astarray-atomic-json-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function buildRenameError(code: string): NodeJS.ErrnoException {
  const error = new Error(code + ": simulated rename failure") as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("原子写：Windows rename 瞬时锁的有界重试", () => {
  it("瞬时 EPERM：必须重试并在随后成功完成写入", async () => {
    const realRename = fsPromises.rename.bind(fsPromises);
    let renameCallCount = 0;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      renameCallCount += 1;
      if (renameCallCount <= 3) {
        throw buildRenameError("EPERM");
      }
      return await realRename(from as string, to as string);
    });

    const targetPath = path.join(temporaryDirectory, "summary.json");
    await writeAtomicJson(targetPath, { isOk: true });

    // 3 次失败 + 第 4 次成功
    expect(renameCallCount).toBe(4);
    const writtenContent = JSON.parse(await readFile(targetPath, "utf8")) as { isOk: boolean };
    expect(writtenContent.isOk).toBe(true);
  });

  it("EPERM 持续存在：必须**有界**失败（次数恰好为上限 7，不得无限重试）", async () => {
    let renameCallCount = 0;
    vi.spyOn(fsPromises, "rename").mockImplementation(async () => {
      renameCallCount += 1;
      throw buildRenameError("EPERM");
    });

    await expect(
      writeAtomicJson(path.join(temporaryDirectory, "stuck.json"), { isOk: true }),
    ).rejects.toThrow(/EPERM/);
    expect(renameCallCount).toBe(7);
  });

  it("非可重试错误码（ENOENT）：立即抛出，只尝试一次", async () => {
    let renameCallCount = 0;
    vi.spyOn(fsPromises, "rename").mockImplementation(async () => {
      renameCallCount += 1;
      throw buildRenameError("ENOENT");
    });

    await expect(
      writeAtomicJson(path.join(temporaryDirectory, "missing.json"), { isOk: true }),
    ).rejects.toThrow(/ENOENT/);
    expect(renameCallCount).toBe(1);
  });
});
