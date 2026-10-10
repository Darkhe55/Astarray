/**
 * PROJECT-01-04 反例（2026-10-10）：副本导入**不得陈旧覆盖人工修改**。
 *
 * 卡内校验点（PROJECT-01-04 必测场景 2）："**目标有人工修改时拒绝陈旧覆盖**"。
 *
 * 现状缺口（本文件在实现前必须失败）：`importCopy` 接入真实 I/O 后只做
 * "建父目录 → 覆盖写目标 → 复核存在"，因此**会静默覆盖人工刚改过的目标文件**，
 * 且不留下任何"被拒"证据。
 *
 * 本轮钉住的语义：
 *  - 目标已存在且**人工在其后修改过** ⇒ 拒绝写入（`target-stale-rejected`），
 *    目标字节保持人工版本不变；且**不得落定副本回执**（否则重试被幂等挡住）；
 *  - 目标已存在但**无人工改动**（与预期一致）⇒ 允许写入（幂等/重试不被误拒）；
 *  - 目标不存在 ⇒ 正常写入（不受本守卫影响）；
 *  - 未注入守卫且目标已存在 ⇒ **fail-closed 拒绝**（不静默覆盖），
 *    并以可分辨的错误码说明"缺少人工改动基线"。
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
const ARGUMENTS_HASH = "hash-import-stale";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-stale-"));
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

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildResourceIo(): CrossProjectResourceIoPort {
  return {
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
}

async function grantImportAuthorization(
  store: CrossProjectAuthorizationStore,
): Promise<void> {
  await store.grantAuthorization({
    authorizationIdentifier: "auth-import",
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: SOURCE_REVISION,
    targetProjectIdentifier: TARGET_PROJECT,
    targetProjectRevision: 1,
    operationKind: "import-copy",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: ARGUMENTS_HASH,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
  });
}

describe("PROJECT-01-04：副本导入不得陈旧覆盖人工修改", () => {
  it("① 目标已被人工修改 ⇒ 拒绝写入，保留人工字节，且不得落定副本回执", async () => {
    const sourceAbsolutePath = path.join(sourceRootPath, "docs", "spec.md");
    const targetAbsolutePath = path.join(targetRootPath, "docs", "spec-copy.md");
    const sourceContent = "# 来源内容\n";
    const humanContent = "# 人工刚改过的内容\n";
    await fs.writeFile(sourceAbsolutePath, sourceContent, "utf8");
    // 目标已存在，且内容不是"来源的副本"（模拟人工修改/独有内容）
    await fs.writeFile(targetAbsolutePath, humanContent, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantImportAuthorization(store);
    const service = new CrossProjectTransferService({
      store,
      resourceIo: buildResourceIo(),
      // 守卫如实报告：目标存在且与预期（来源副本）不一致 ⇒ 存在人工改动
      humanEditGuard: {
        hasUnexpectedHumanChange: async (input: { absoluteTargetPath: string }) => {
          const existing = await fs.readFile(input.absoluteTargetPath, "utf8").catch(() => null);
          if (existing === null) {
            return { hasHumanChange: false };
          }
          return existing === sourceContent
            ? { hasHumanChange: false }
            : { hasHumanChange: true, reason: "目标内容与预期副本不一致（人工修改）" };
        },
      },
    });

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceAbsolutePath,
      absoluteTargetPath: targetAbsolutePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256Text(sourceContent),
      argumentsHash: ARGUMENTS_HASH,
      nowIso: "2026-10-02T00:00:00.000Z",
    });

    expect(result.outcome).toBe("target-stale-rejected");
    expect(result.receipt).toBeNull();
    expect(result.didWriteTarget).toBe(false);
    // 人工字节必须原样保留
    expect(await fs.readFile(targetAbsolutePath, "utf8")).toBe(humanContent);
    // 不得落定回执（否则重试会被"幂等复用"挡住）
    expect(await store.countCopyReceipts()).toBe(0);
  });

  it("② 目标已存在但与预期一致（无人工改动）⇒ 允许写入，不误拒", async () => {
    const sourceAbsolutePath = path.join(sourceRootPath, "docs", "spec.md");
    const targetAbsolutePath = path.join(targetRootPath, "docs", "spec-copy.md");
    const sourceContent = "# 一致内容\n";
    await fs.writeFile(sourceAbsolutePath, sourceContent, "utf8");
    await fs.writeFile(targetAbsolutePath, sourceContent, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantImportAuthorization(store);
    const service = new CrossProjectTransferService({
      store,
      resourceIo: buildResourceIo(),
      humanEditGuard: {
        hasUnexpectedHumanChange: async () => ({ hasHumanChange: false }),
      },
    });

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceAbsolutePath,
      absoluteTargetPath: targetAbsolutePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256Text(sourceContent),
      argumentsHash: ARGUMENTS_HASH,
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(result.outcome).toBe("imported-copy");
    expect(result.didWriteTarget).toBe(true);
  });

  it("③ 目标不存在 ⇒ 正常写入（不受守卫影响）", async () => {
    const sourceAbsolutePath = path.join(sourceRootPath, "docs", "spec.md");
    const targetAbsolutePath = path.join(targetRootPath, "docs", "brand-new-copy.md");
    const sourceContent = "# 全新目标\n";
    await fs.writeFile(sourceAbsolutePath, sourceContent, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantImportAuthorization(store);
    let guardCallCount = 0;
    const service = new CrossProjectTransferService({
      store,
      resourceIo: buildResourceIo(),
      humanEditGuard: {
        hasUnexpectedHumanChange: async () => {
          guardCallCount += 1;
          return { hasHumanChange: false };
        },
      },
    });

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/brand-new-copy.md",
      absoluteSourcePath: sourceAbsolutePath,
      absoluteTargetPath: targetAbsolutePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256Text(sourceContent),
      argumentsHash: ARGUMENTS_HASH,
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(result.outcome).toBe("imported-copy");
    expect(await fs.readFile(targetAbsolutePath, "utf8")).toBe(sourceContent);
    // 目标不存在时无需询问守卫（避免无谓 I/O）
    expect(guardCallCount).toBe(0);
  });

  it("④ 未注入守卫但目标已存在 ⇒ fail-closed 拒绝覆盖，且回执不落定", async () => {
    const sourceAbsolutePath = path.join(sourceRootPath, "docs", "spec.md");
    const targetAbsolutePath = path.join(targetRootPath, "docs", "occupied.md");
    const sourceContent = "# 来源\n";
    const occupantContent = "# 已有内容（不得被静默覆盖）\n";
    await fs.writeFile(sourceAbsolutePath, sourceContent, "utf8");
    await fs.writeFile(targetAbsolutePath, occupantContent, "utf8");

    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantImportAuthorization(store);
    const service = new CrossProjectTransferService({
      store,
      resourceIo: buildResourceIo(),
    });

    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/occupied.md",
      absoluteSourcePath: sourceAbsolutePath,
      absoluteTargetPath: targetAbsolutePath,
      sourceRevision: SOURCE_REVISION,
      contentHash: sha256Text(sourceContent),
      argumentsHash: ARGUMENTS_HASH,
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(result.outcome).toBe("target-stale-rejected");
    expect(result.receipt).toBeNull();
    expect(await fs.readFile(targetAbsolutePath, "utf8")).toBe(occupantContent);
    expect(await store.countCopyReceipts()).toBe(0);
  });
});
