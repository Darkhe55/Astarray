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
// 2026-10-13：跨项目通道必须拒绝受保护存储（backup-vault / 删除审计）。
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

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
      sourceProjectRootPath: sourceRootPath,
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
      sourceProjectRootPath: sourceRootPath,
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
      sourceProjectRootPath: sourceRootPath,
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
      sourceProjectRootPath: sourceRootPath,
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
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
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
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
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
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
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
      sourceProjectRootPath: sourceRootPath,
      absoluteTargetPath: targetFilePath,
      targetProjectRootPath: targetRootPath,
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

/**
 * 对抗性反例（2026-10-13，安全修复）：**授权范围必须真正绑定到被读取的那个文件**。
 *
 * 修复前实测缺口：`readResource` 只用**声明的** `resourcePath` 做范围判定
 * （`isWithinScope`，逐字符串前缀匹配），随后真正读取的却是**调用方另给的**
 * `absoluteResourcePath` —— 二者**之间没有任何绑定**（当时实测返回 `read-allowed`
 * 且真的读到了范围外的内容）。这类"检查 A、使用 B"正是 AGENTS.md 要求
 * "权限在工具**实际执行前**检查"所针对的形态。
 */
describe("PROJECT-01-03：授权范围与真实读取对象必须绑定", () => {
  const OUTSIDE_SCOPE_CONTENT = "# 绝不应被读到\n";

  it("⑨ 授权范围是 docs/ 时，传范围之外的绝对路径必须拒绝（否则等于越权读取任意文件）", async () => {
    const authorizedFilePath = path.join(sourceRootPath, "docs/spec.md");
    await fs.writeFile(authorizedFilePath, "# 授权范围内\n", "utf8");
    const outsideFilePath = path.join(sourceRootPath, "secrets.md");
    await fs.writeFile(outsideFilePath, OUTSIDE_SCOPE_CONTENT, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-scope-binding";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      // 声明的是**范围内**路径（因此范围校验会通过）……
      resourcePath: "docs/spec.md",
      // ……但实际要读的是**范围之外**的文件。
      absoluteResourcePath: outsideFilePath,
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
    expect(result.content ?? "").not.toContain("绝不应被读到");
  });

  it("⑩ 绝对路径与「来源项目根 + 声明路径」不一致时必须拒绝（含 .. 穿越）", async () => {
    await fs.writeFile(path.join(sourceRootPath, "docs/spec.md"), "# 授权范围内\n", "utf8");
    const siblingFilePath = path.join(sourceRootPath, "sibling.md");
    await fs.writeFile(siblingFilePath, "# 兄弟目录\n", "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-scope-binding-2";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const traversed = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/../sibling.md",
      absoluteResourcePath: siblingFilePath,
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(traversed.outcome).not.toBe("read-allowed");
    expect(traversed.didRead).toBe(false);
  });

  it("⑪ 缺少项目根时必须 fail-closed（不能证明是同一个文件 ≠ 是同一个文件）", async () => {
    const authorizedFilePath = path.join(sourceRootPath, "docs/spec.md");
    await fs.writeFile(authorizedFilePath, "# 授权范围内\n", "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-scope-binding-3";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: authorizedFilePath,
      // 故意不传 sourceProjectRootPath
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
  });

  it("⑫ 副本导入：目标绝对路径与「目标项目根 + 声明路径」不一致时必须拒绝", async () => {
    const sourceFilePath = path.join(sourceRootPath, "docs/spec.md");
    const content = "# 导入内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    // 目标声明为 docs/copy.md，但实传**同目录下另一个（并不存在的）文件名**：
    // 仍在授权范围 docs/ 内、且父目录相同，因此本用例**只**检验
    // "真实目标与声明目标是否是同一个文件"这一条，不掺入范围判定。
    const unrelatedTargetPath = path.join(targetRootPath, "docs/not-the-declared-target.md");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-import-binding";
    await grantImportAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/copy.md",
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(content),
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      absoluteSourcePath: sourceFilePath,
      absoluteTargetPath: unrelatedTargetPath,
      sourceProjectRootPath: sourceRootPath,
      targetProjectRootPath: targetRootPath,
    });

    expect(result.outcome).not.toBe("imported-copy");
    expect(result.receipt).toBeNull();
    // 绝不能写到未被声明的目标
    expect(await fs.readFile(unrelatedTargetPath, "utf8").catch(() => null)).toBeNull();
  });

  it("⑬ 受保护存储（backup-vault / 删除审计）不得经跨项目通道访问——即使它在授权范围内", async () => {
    /**
     * 缺口（2026-10-13 实测）：当状态目录位于项目根内（常见布局：项目里的 `.astarray/`），
     * 若用户把 `.astarray/` 写进授权范围，跨项目只读就能读到 `backup-vault/` 里的备份内容
     * （实测 `read-allowed` 并返回了保管库内容）。
     *
     * 关键区分：授权范围判定回答"是否在用户授权范围内"，**不回答**"是不是受保护存储"——
     * 二者必须各自校验，且受保护存储**任何范围都不得放行**。
     */
    const projectRootPath = path.join(baseDirectory, "project-a");
    const stateDirectoryPath = path.join(projectRootPath, ".astarray");
    const vaultRootPath = path.join(stateDirectoryPath, "backup-vault");
    await fs.mkdir(vaultRootPath, { recursive: true });
    const vaultSecretPath = path.join(vaultRootPath, "backup-1.json");
    const vaultSecretContent = '{"secret":"vault-content"}\n';
    await fs.writeFile(vaultSecretPath, vaultSecretContent, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectoryPath });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-vault",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: SOURCE_REVISION,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "read",
      // 授权范围**故意**覆盖状态目录（模拟"用户把 .astarray/ 划进范围"）
      resourceScope: {
        pathPrefixes: [".astarray/"],
        realPaths: [],
        isDynamicSharedDirectory: false,
      },
      argumentsHash: "hash-vault",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });

    // 服务接上"受保护存储"禁用判定器（生产入口即如此接线）
    const protectedStoragePolicy = new ProtectedStoragePolicy({
      stateDirectoryPath,
    });
    const service = new CrossProjectTransferService({
      store,
      resourceIo: {
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
      },
      isForbiddenAccessTarget: (canonicalAccessTargetPath: string) =>
        protectedStoragePolicy.isProtectedStorageAccessTarget(canonicalAccessTargetPath),
    });

    const result = await service.readResource({
      authorizationIdentifier: "auth-vault",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: ".astarray/backup-vault/backup-1.json",
      absoluteResourcePath: vaultSecretPath,
      sourceProjectRootPath: projectRootPath,
      argumentsHash: "hash-vault",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
    expect(result.content ?? "").not.toContain("vault-content");
  });

  it("⑭ 副本导入：**来源**是受保护存储时不得被拷出去（目标也不得留下文件/回执）", async () => {
    /**
     * 反例意图：上一轮只钉住了"目标不得是受保护存储"。同一条通道还能把保管库当**来源**
     * 拷到目标项目 —— 那等于把备份内容外泄。本用例钉住来源侧。
     */
    const projectRootPath = path.join(baseDirectory, "project-a");
    const stateDirectoryPath = path.join(projectRootPath, ".astarray");
    const vaultRootPath = path.join(stateDirectoryPath, "backup-vault");
    await fs.mkdir(vaultRootPath, { recursive: true });
    const vaultInsideSourcePath = path.join(vaultRootPath, "backup-1.json");
    const vaultContent = '{"secret":"should-not-leak"}\n';
    await fs.writeFile(vaultInsideSourcePath, vaultContent, "utf8");

    // 目标项目根（正常、非受保护）
    const importTargetRootPath = path.join(baseDirectory, "project-b");
    const targetPath = path.join(importTargetRootPath, "docs", "leaked.json");

    const store = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectoryPath });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-import-vault",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: SOURCE_REVISION,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "import-copy",
      // 授权范围故意覆盖状态目录，使"范围判定"无法成为唯一防线
      resourceScope: {
        pathPrefixes: [".astarray/"],
        realPaths: [],
        isDynamicSharedDirectory: false,
      },
      argumentsHash: "hash-import-vault",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });

    const protectedStoragePolicy = new ProtectedStoragePolicy({ stateDirectoryPath });
    const service = new CrossProjectTransferService({
      store,
      resourceIo: {
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
      },
      isForbiddenAccessTarget: (canonicalAccessTargetPath: string) =>
        protectedStoragePolicy.isProtectedStorageAccessTarget(canonicalAccessTargetPath),
    });

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import-vault",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: ".astarray/backup-vault/backup-1.json",
      targetResourcePath: "docs/leaked.json",
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256(vaultContent),
      argumentsHash: "hash-import-vault",
      nowIso: "2026-10-02T00:00:00.000Z",
      absoluteSourcePath: vaultInsideSourcePath,
      absoluteTargetPath: targetPath,
      sourceProjectRootPath: projectRootPath,
      targetProjectRootPath: importTargetRootPath,
    });

    expect(result.outcome).not.toBe("imported-copy");
    expect(result.receipt).toBeNull();
    // 目标不得留下文件，也不得留下回执（否则"有回执无文件/反面"都会误导重试）
    expect(await fs.readFile(targetPath, "utf8").catch(() => null)).toBeNull();
    expect(await store.countCopyReceipts()).toBe(0);
  });

  it("⑮ 受保护存储之删除审计文件同样不得经跨项目通道读取（文件**存在**时也不得读到内容）", async () => {
    /**
     * 与 ⑬ 同类，但针对 `backup-deletion-audit.jsonl`：它是**文件**而非目录，
     * 走策略里另一条词法分支。
     *
     * 变异验证教训（2026-10-13）：本用例最初**不创建**该文件，结果在"临时禁用判定器"时
     * **仍然通过** —— 因为服务先命中 `resource-not-found` 就拒绝了，根本没走到受保护存储判定，
     * 属**空洞反例**。故这里先真实创建审计文件并写入哨兵内容，确保拒绝只能来自受保护存储判定。
     */
    const projectRootPath = path.join(baseDirectory, "project-a");
    const stateDirectoryPath = path.join(projectRootPath, ".astarray");
    await fs.mkdir(stateDirectoryPath, { recursive: true });
    const auditFilePath = path.join(stateDirectoryPath, "backup-deletion-audit.jsonl");
    const auditSentinelContent = '{"deletedBy":"audit-should-not-leak"}\n';
    await fs.writeFile(auditFilePath, auditSentinelContent, "utf8");
    // 前置条件自检：文件确实存在（否则本用例会退化成 resource-not-found）
    await expect(fs.stat(auditFilePath)).resolves.toBeDefined();

    const store = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectoryPath });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-audit",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: SOURCE_REVISION,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "read",
      resourceScope: {
        pathPrefixes: [".astarray/"],
        realPaths: [],
        isDynamicSharedDirectory: false,
      },
      argumentsHash: "hash-audit",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });

    const protectedStoragePolicy = new ProtectedStoragePolicy({ stateDirectoryPath });
    const service = new CrossProjectTransferService({
      store,
      resourceIo: {
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
      },
      isForbiddenAccessTarget: (canonicalAccessTargetPath: string) =>
        protectedStoragePolicy.isProtectedStorageAccessTarget(canonicalAccessTargetPath),
    });

    const result = await service.readResource({
      authorizationIdentifier: "auth-audit",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: ".astarray/backup-deletion-audit.jsonl",
      absoluteResourcePath: auditFilePath,
      sourceProjectRootPath: projectRootPath,
      argumentsHash: "hash-audit",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
    expect(result.content ?? "").not.toContain("audit-should-not-leak");
  });

  it("⑯ 来源项目根不可解析 ⇒ 拒绝（不得默认放行，零 I/O）", async () => {
    /**
     * 定向反例（2026-10-15）：绑定守卫里"项目根不可解析"一路此前未覆盖。
     * 语义：**无法证明"真实对象 = 被授权对象"就不放行**。
     * 用一个不存在的盘符作为项目根，使"最近存在祖先"回溯也失败。
     */
    const existingFilePath = path.join(sourceRootPath, "docs/spec.md");
    await fs.writeFile(existingFilePath, "# 内容\n", "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-unresolvable-root";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: existingFilePath,
      sourceProjectRootPath: "Z:\\definitely-not-a-volume\\project-a",
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
    // 零 I/O：连"资源是否存在"都不该去问
    expect(result.content).toBeNull();
  });

  it("⑰ 声明路径逃出项目根 ⇒ 拒绝（path-escape-attempt，零 I/O）", async () => {
    /**
     * 定向反例：`!isPathWithinDirectory(canonicalProjectRootPath, expectedAbsolutePath)` 一路。
     * 语义：声明路径本身不得逃出项目根（`..` 上溯）；该判定必须在**任何 I/O 之前**。
     */
    const existingFilePath = path.join(sourceRootPath, "docs/spec.md");
    await fs.writeFile(existingFilePath, "# 内容\n", "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-declared-escape";
    // 授权范围必须命中声明路径，否则会先撞"超出授权范围"，走不到逃逸判定
    await store.grantAuthorization({
      authorizationIdentifier: "auth-escape",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: SOURCE_REVISION,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "read",
      resourceScope: {
        pathPrefixes: ["docs/../"],
        realPaths: [],
        isDynamicSharedDirectory: false,
      },
      argumentsHash,
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-escape",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/../../outside-root.md",
      absoluteResourcePath: existingFilePath,
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
  });

  it("⑱ 真实访问对象不存在 ⇒ 拒绝（access-target-missing，零 I/O）", async () => {
    /**
     * 定向反例：`fs.realpath(canonicalActualPath)` 失败一路。
     * 语义：要读的对象**必须真实存在**；不存在即拒绝（不得先当"范围通过"再失败在读取上）。
     */
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const argumentsHash = "hash-missing-target";
    await grantReadAuthorization(store, argumentsHash);
    const service = buildService(store);

    const result = await service.readResource({
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: path.join(sourceRootPath, "docs", "does-not-exist.md"),
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });

    expect(result.outcome).not.toBe("read-allowed");
    expect(result.didRead).toBe(false);
  });
});
