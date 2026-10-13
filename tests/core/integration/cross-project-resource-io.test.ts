/**
 * PROJECT-01-03 反例（2026-10-10）：跨项目只读与副本导入必须做**真实资源 I/O**。
 *
 * 现状缺口（本文件在实现前必须失败）：`CrossProjectTransferService` 只做授权/回执判定，
 * `readResource()` 直接回 `didRead: true` 却**从未读取资源**，`importCopy()` 只记回执
 * **从不写出副本** ⇒ 回执存在但目标项目里没有文件，属"把回执当借阅/导入完成"。
 *
 * 本文件钉住的语义：
 *  - 只读成功 ⇒ **真的读到内容**，且来源文件字节与哈希**前后一致**（来源零写入）；
 *  - 内容哈希与授权/调用方声明不一致 ⇒ 拒绝（不得把别的版本当成本次许可的内容）；
 *  - 副本导入 ⇒ **真的写出目标文件**，内容等于来源；来源零写入；回执与文件同时成立；
 *  - 源文件不存在 ⇒ 不得假装成功（不得返回 imported-copy）；
 *  - 写入失败 ⇒ 不得留下"已导入"的回执（否则重试会被幂等复用挡住，目标永远没有文件）。
 *
 * 只跑本地临时目录，不联网、不用凭据。
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

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project03-io-"));
  sourceRootPath = path.join(baseDirectory, "project-a");
  targetRootPath = path.join(baseDirectory, "project-b");
  await fs.mkdir(path.join(sourceRootPath, "docs"), { recursive: true });
  await fs.mkdir(path.join(targetRootPath, "docs"), { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
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

/** 带真实 I/O 的传输服务（资源根由调用方给出，与授权范围分离，避免路径混用）。 */
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
  return new CrossProjectTransferService({ store, resourceIo });
}

async function grantReadAuthorization(
  store: CrossProjectAuthorizationStore,
  argumentsHash: string,
): Promise<void> {
  await store.grantAuthorization({
    authorizationIdentifier: "auth-read",
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: SOURCE_REVISION,
    targetProjectIdentifier: TARGET_PROJECT,
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
  });
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

describe("PROJECT-01-03：只读跨项目访问（真实 I/O）", () => {
  it("① 只读成功必须真的读到内容，且来源字节/哈希前后不变（零写入）", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    const content = "# 规格\n正文\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const hashBefore = await fileSha256(sourceFilePath);

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-docs-read";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: sourceFilePath,
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).toBe("read-allowed");
    expect(result.didRead).toBe(true);
    expect(result.didModifySource).toBe(false);
    expect(result.sourceWriteCount).toBe(0);
    // 真实读取：必须拿到来源内容本身
    expect(result.content).toBe(content);
    expect(result.contentHash).toBe(sha256(content));
    // 来源零写入：前后哈希一致
    expect(result.sourceContentHashBefore).toBe(hashBefore);
    expect(result.sourceContentHashAfter).toBe(hashBefore);
    expect(await fileSha256(sourceFilePath)).toBe(hashBefore);
  });

  it("② 资源不存在 ⇒ 不得报 read-allowed（不得假装读到）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-missing";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/missing.md",
      absoluteResourcePath: path.join(sourceRootPath, "docs/missing.md"),
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
    expect(result.content).toBeNull();
  });

  it("③ 声明的内容哈希与实际内容不符 ⇒ 必须拒绝（不得把别的版本当成本次许可内容）", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    await fs.writeFile(sourceFilePath, "实际内容\n", "utf8");
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-hash-mismatch";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: sourceFilePath,
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      expectedContentHash: sha256("声明的是另一份内容\n"),
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
  });

  it("④ 授权被拒绝（参数不匹配）时：不得读取资源（零 I/O）", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    await fs.writeFile(sourceFilePath, "内容\n", "utf8");
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store, "hash-original");
    let readCallCount = 0;
    const resourceIo: CrossProjectResourceIoPort = {
      readTextFile: async (absolutePath: string) => {
        readCallCount += 1;
        return fs.readFile(absolutePath, "utf8");
      },
      writeTextFile: (absolutePath: string, content: string) =>
        fs.writeFile(absolutePath, content, "utf8"),
      ensureDirectory: async (absoluteDirectory: string) => {
        await fs.mkdir(absoluteDirectory, { recursive: true });
      },
      fileExists: async () => true,
    };
    const service = new CrossProjectTransferService({ store, resourceIo });

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: sourceFilePath,
      argumentsHash: "hash-different",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).toBe("authorization-parameter-mismatch");
    expect(readCallCount).toBe(0); // 未授权 ⇒ 绝不触达资源
  });
});

describe("PROJECT-01-03：副本导入（真实 I/O）", () => {
  it("⑤ 导入成功必须真的写出目标文件，来源零写入，且回执与文件同时成立", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    const targetFilePath = path.join(targetRootPath, "docs/spec-copy.md");
    const content = "# 规格\n副本内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const hashBefore = await fileSha256(sourceFilePath);

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-import";
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceFilePath,
      absoluteTargetPath: targetFilePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(content),
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
    });

    expect(result.outcome).toBe("imported-copy");
    expect(result.receipt).not.toBeNull();
    // 真实写入：目标文件必须存在且内容等于来源
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
    expect(result.didWriteTarget).toBe(true);
    // 来源零写入
    expect(await fileSha256(sourceFilePath)).toBe(hashBefore);
    expect(result.sourceContentHashBefore).toBe(hashBefore);
    expect(result.sourceContentHashAfter).toBe(hashBefore);
  });

  it("⑥ 源文件不存在 ⇒ 不得返回 imported-copy，且不得创建目标文件", async () => {
    const targetFilePath = path.join(targetRootPath, "docs/absent-copy.md");
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-absent";
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/absent.md",
      targetResourcePath: "docs/absent-copy.md",
      absoluteSourcePath: path.join(sourceRootPath, "docs/absent.md"),
      absoluteTargetPath: targetFilePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256("whatever"),
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(result.outcome).not.toBe("imported-copy");
    expect(result.receipt).toBeNull();
    await expect(fs.stat(targetFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("⑦ 重复导入同一内容 ⇒ 幂等复用回执，目标内容不变（无重复副作用）", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    const targetFilePath = path.join(targetRootPath, "docs/spec-copy.md");
    const content = "幂等内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-idem";
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    const importInput = {
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceFilePath,
      absoluteTargetPath: targetFilePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(content),
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
    };
    const first = await service.importCopy(importInput);
    expect(first.outcome).toBe("imported-copy");
    const second = await service.importCopy(importInput);
    expect(second.outcome).toBe("reused-existing-copy");
    expect(second.receipt?.receiptIdentifier).toBe(first.receipt?.receiptIdentifier);
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
  });

  it("⑧ 写入失败 ⇒ 不得留下「已导入」回执（否则重试被幂等挡住而目标永远没有文件）", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    const targetFilePath = path.join(targetRootPath, "docs/spec-copy.md");
    const content = "写入会失败\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-write-fail";
    await grantImportAuthorization(store, argumentsHash);

    let shouldFailWrite = true;
    const resourceIo: CrossProjectResourceIoPort = {
      readTextFile: (absolutePath: string) => fs.readFile(absolutePath, "utf8"),
      writeTextFile: async (absolutePath: string, text: string) => {
        if (shouldFailWrite) {
          throw new Error("模拟磁盘写入失败");
        }
        await fs.writeFile(absolutePath, text, "utf8");
      },
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
    const service = new CrossProjectTransferService({ store, resourceIo });

    const importInput = {
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceFilePath,
      absoluteTargetPath: targetFilePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(content),
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
    };

    const failed = await service.importCopy(importInput);
    expect(failed.outcome).not.toBe("imported-copy");
    expect(failed.receipt).toBeNull();
    // 回执不得被留下（否则重试会被"幂等复用"挡住）
    expect(await store.countCopyReceipts()).toBe(0);

    // 修复写入后重试必须真的落盘
    shouldFailWrite = false;
    const retried = await service.importCopy(importInput);
    expect(retried.outcome).toBe("imported-copy");
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
  });
});
