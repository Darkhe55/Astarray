/**
 * PROJECT-01-03 反例（2026-10-10）：**写成功但回执未落盘**时崩溃后的恢复对账。
 *
 * 卡内 PROJECT-01-03 验收点："**并发导入/崩溃无重复副作用**"。
 * 既有套件已覆盖**并发导入**（`cross-project-isolation-multi-project` ⑤）与
 * "**写入失败**不得留已导入回执"（`cross-project-resource-io` ⑧），
 * 但**"写成功之后、回执落盘之前崩溃"**这一时点**没有反例** ——
 * 而它正是"重复副作用"最容易发生的位置。
 *
 * 本片钉住的语义：
 *  - 崩溃现场重放时**不得重复写出**（内容必须仍是同一份）；
 *  - **来源项目零写入**（sha256 前后一致，可核对）；
 *  - 目标已存在且**可能有人工改动** ⇒ 无守卫时 **fail-closed 拒绝覆盖**，
 *    人工字节必须被保留；
 *  - 无论哪种结果，**回执与目标文件不得只成立一边**。
 *
 * 只跑本地临时目录与真实文件 I/O；不联网、不用凭据。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CrossProjectAuthorizationStore,
  CrossProjectTransferService,
  type CrossProjectResourceIoPort,
} from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let baseDirectory: string;
let sourceRootPath: string;
let targetRootPath: string;

const SOURCE_PROJECT = "project-a";
const TARGET_PROJECT = "project-b";
const SOURCE_REVISION = 3;
/** 固定时间戳：回执与过期判定都与本机时间无关（可复现）。 */
const NOW_ISO = "2026-10-10T00:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project03-crash-"));
  sourceRootPath = path.join(baseDirectory, "project-a");
  targetRootPath = path.join(baseDirectory, "project-b");
  await fs.mkdir(path.join(sourceRootPath, "docs"), { recursive: true });
  await fs.mkdir(path.join(targetRootPath, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function buildService(store: CrossProjectAuthorizationStore): CrossProjectTransferService {
  const resourceIo: CrossProjectResourceIoPort = {
    readTextFile: (absolutePath: string) => fs.readFile(absolutePath, "utf8"),
    writeTextFile: (absolutePath: string, content: string) =>
      fs.writeFile(absolutePath, content, "utf8"),
    ensureDirectory: async (absoluteDirectory: string) => {
      await fs.mkdir(absoluteDirectory, { recursive: true });
    },
    fileExists: async (absolutePath: string) => {
      try {
        await fs.stat(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
  };
  // **刻意不注入** humanEditGuard：目标已存在时必须是 fail-closed（见卡内要求）。
  return new CrossProjectTransferService({ store, resourceIo });
}

async function grantImportAuthorization(
  store: CrossProjectAuthorizationStore,
  argumentsHash: string,
): Promise<void> {
  await store.grantAuthorization({
    authorizationIdentifier: "auth-import",
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: SOURCE_REVISION,
    targetProjectIdentifier: TARGET_PROJECT,
    targetProjectRevision: 1,
    operationKind: "import-copy",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
  });
}

describe("PROJECT-01-03：写成功但回执未落盘 → 崩溃后恢复不得重复副作用", () => {
  it("① 目标已存在（崩溃现场）⇒ **拒绝覆盖**，内容与来源字节都保持不变", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs", "a.md");
    const targetFilePath = path.join(targetRootPath, "docs", "a.md");
    const sourceContent = "# 来源正文\n";
    await fs.writeFile(sourceFilePath, sourceContent, "utf8");
    const sourceHashBefore = await fileSha256(sourceFilePath);

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "sha256:" + "c".repeat(64);
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    /**
     * **模拟崩溃现场**：目标文件已经被写出（内容与来源一致），
     * 但回执**从未落盘**。
     */
    await fs.writeFile(targetFilePath, sourceContent, "utf8");

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/a.md",
      targetResourcePath: "docs/a.md",
      absoluteSourcePath: sourceFilePath,
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(sourceContent),
      argumentsHash,
      nowIso: NOW_ISO,
    });

    /** 无守卫且目标已存在 ⇒ fail-closed：**不得**重复写、**不得**静默覆盖。 */
    expect(result.outcome).toBe("target-stale-rejected");
    expect(result.didWriteTarget).toBe(false);
    // 不得留下"已导入"回执（否则重试会被幂等挡住而目标状态不明）
    expect(result.receipt).toBeNull();
    // 目标内容**未被改写**（仍是同一份字节）
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(sourceContent);
    // 来源零写入
    expect(await fileSha256(sourceFilePath)).toBe(sourceHashBefore);
  });

  it("② 目标已存在且内容**是人工改过的** ⇒ 人工字节必须被保留", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs", "a.md");
    const targetFilePath = path.join(targetRootPath, "docs", "a.md");
    const sourceContent = "# 来源正文\n";
    const humanEditedContent = "# 人工改过的目标\n";
    await fs.writeFile(sourceFilePath, sourceContent, "utf8");
    await fs.writeFile(targetFilePath, humanEditedContent, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "sha256:" + "d".repeat(64);
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/a.md",
      targetResourcePath: "docs/a.md",
      absoluteSourcePath: sourceFilePath,
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(sourceContent),
      argumentsHash,
      nowIso: NOW_ISO,
    });

    expect(result.outcome).toBe("target-stale-rejected");
    // 关键不变量：**人工字节被保留**（不得被来源覆盖）
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(humanEditedContent);
  });

  it("③ 目标不存在（真正首次导入）⇒ 正常写出，且**回执与文件同时成立**", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs", "fresh.md");
    const targetFilePath = path.join(targetRootPath, "docs", "fresh.md");
    const sourceContent = "# 首次导入\n";
    await fs.writeFile(sourceFilePath, sourceContent, "utf8");
    const sourceHashBefore = await fileSha256(sourceFilePath);

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "sha256:" + "e".repeat(64);
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/fresh.md",
      targetResourcePath: "docs/fresh.md",
      absoluteSourcePath: sourceFilePath,
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(sourceContent),
      argumentsHash,
      nowIso: NOW_ISO,
    });

    expect(result.outcome).toBe("imported-copy");
    expect(result.receipt).not.toBeNull();
    expect(result.didWriteTarget).toBe(true);
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(sourceContent);
    expect(await fileSha256(sourceFilePath)).toBe(sourceHashBefore);
    expect(result.sourceContentHashBefore).toBe(sourceHashBefore);
    expect(result.sourceContentHashAfter).toBe(sourceHashBefore);
  });
});
