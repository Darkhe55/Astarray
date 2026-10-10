/**
 * PROJECT-01-04 反例（2026-10-10）：多项目 / 多同级个体的**隔离与可追溯**。
 *
 * 卡内验收："A/B/C 项目及多个**同级个体**可追溯、**不串数据**；
 * 放权规则内无需人等，规则外不放行"。
 *
 * 现状缺口：既有测试只覆盖 A→B 单条授权与单目录，**没有**验证：
 *  - 同一目标项目下多个来源项目（A/B/C）的授权/副本互不串（按来源隔离）；
 *  - 多个**同级接收个体**（secondary agent instance）各自的副本回执与读取
 *    不互相可见/互相冒充（`receivingAgentInstanceId` 维度）；
 *  - 并发导入同一内容**跨个体**不产生重复副作用；
 *  - 授权只覆盖 A，用 B 发起必须被拒（规则外不放行）。
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

const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_C = "project-c";
const PROJECT_X = "project-x";
const RECEIVER_ONE = "secondary-agent-1";
const RECEIVER_TWO = "secondary-agent-2";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-isolation-"));
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

async function writeResource(projectId: string, relativePath: string, content: string) {
  const absolutePath = path.join(baseDirectory, projectId, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

async function grant(input: {
  store: CrossProjectAuthorizationStore;
  authorizationIdentifier: string;
  sourceProjectIdentifier: string;
  operationKind: "read" | "import-copy";
  argumentsHash: string;
  receivingAgentInstanceId?: string;
}) {
  await input.store.grantAuthorization({
    authorizationIdentifier: input.authorizationIdentifier,
    sourceProjectIdentifier: input.sourceProjectIdentifier,
    sourceProjectRevision: 3,
    targetProjectIdentifier: PROJECT_C,
    targetProjectRevision: 1,
    operationKind: input.operationKind,
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: input.argumentsHash,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-" + input.authorizationIdentifier,
    ...(input.receivingAgentInstanceId === undefined
      ? {}
      : { receivingAgentInstanceId: input.receivingAgentInstanceId }),
  });
}

describe("PROJECT-01-04：多项目隔离与可追溯", () => {
  it("① 仅授权 A 时：用 B 发起读取必须被拒（规则外不放行）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grant({
      store,
      authorizationIdentifier: "auth-a-read",
      sourceProjectIdentifier: PROJECT_A,
      operationKind: "read",
      argumentsHash: "hash-a",
    });
    const absoluteA = await writeResource(PROJECT_A, "docs/spec.md", "# A 内容\n");
    const absoluteB = await writeResource(PROJECT_B, "docs/spec.md", "# B 内容\n");
    const service = new CrossProjectTransferService({ store, resourceIo: buildResourceIo() });

    const allowed = await service.readResource({
      authorizationIdentifier: "auth-a-read",
      sourceProjectIdentifier: PROJECT_A,
      targetProjectIdentifier: PROJECT_C,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: absoluteA,
      argumentsHash: "hash-a",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(allowed.outcome).toBe("read-allowed");

    // 用同一授权但换来源项目 B：必须 project-mismatch 被拒，且不读取 B
    const denied = await service.readResource({
      authorizationIdentifier: "auth-a-read",
      sourceProjectIdentifier: PROJECT_B,
      targetProjectIdentifier: PROJECT_C,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: absoluteB,
      argumentsHash: "hash-a",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(denied.outcome).toBe("project-mismatch");
    expect(denied.didRead).toBe(false);
  });

  it("② A/B 两条授权与副本互不串：各自回执保留各自来源（可追溯）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grant({
      store,
      authorizationIdentifier: "auth-a-import",
      sourceProjectIdentifier: PROJECT_A,
      operationKind: "import-copy",
      argumentsHash: "hash-a-import",
    });
    await grant({
      store,
      authorizationIdentifier: "auth-b-import",
      sourceProjectIdentifier: PROJECT_B,
      operationKind: "import-copy",
      argumentsHash: "hash-b-import",
    });
    const absoluteA = await writeResource(PROJECT_A, "docs/spec.md", "# A 内容\n");
    const absoluteB = await writeResource(PROJECT_B, "docs/spec.md", "# B 内容\n");
    const targetA = path.join(baseDirectory, PROJECT_C, "docs", "from-a.md");
    const targetB = path.join(baseDirectory, PROJECT_C, "docs", "from-b.md");
    const service = new CrossProjectTransferService({ store, resourceIo: buildResourceIo() });

    const importedA = await service.importCopy({
      authorizationIdentifier: "auth-a-import",
      sourceProjectIdentifier: PROJECT_A,
      targetProjectIdentifier: PROJECT_C,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/from-a.md",
      absoluteSourcePath: absoluteA,
      absoluteTargetPath: targetA,
      sourceRevision: 3,
      contentHash: sha256Text("# A 内容\n"),
      argumentsHash: "hash-a-import",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    const importedB = await service.importCopy({
      authorizationIdentifier: "auth-b-import",
      sourceProjectIdentifier: PROJECT_B,
      targetProjectIdentifier: PROJECT_C,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/from-b.md",
      absoluteSourcePath: absoluteB,
      absoluteTargetPath: targetB,
      sourceRevision: 3,
      contentHash: sha256Text("# B 内容\n"),
      argumentsHash: "hash-b-import",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(importedA.outcome).toBe("imported-copy");
    expect(importedB.outcome).toBe("imported-copy");
    // 不串数据：各自回执指向各自来源；两个副本内容各自正确
    expect(importedA.receipt?.sourceProjectIdentifier).toBe(PROJECT_A);
    expect(importedB.receipt?.sourceProjectIdentifier).toBe(PROJECT_B);
    expect(await fs.readFile(targetA, "utf8")).toBe("# A 内容\n");
    expect(await fs.readFile(targetB, "utf8")).toBe("# B 内容\n");
    // 两份回执独立存在（可追溯），不是同一条
    expect(importedA.receipt?.receiptIdentifier).not.toBe(importedB.receipt?.receiptIdentifier);
    expect(await store.countCopyReceipts()).toBe(2);
  });

  it("③ 授权缺失的来源（C→C 之外的未授权来源 X）必须被拒", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grant({
      store,
      authorizationIdentifier: "auth-a-read",
      sourceProjectIdentifier: PROJECT_A,
      operationKind: "read",
      argumentsHash: "hash-a",
    });
    const absoluteX = await writeResource(PROJECT_X, "docs/spec.md", "# X 内容\n");
    const service = new CrossProjectTransferService({ store, resourceIo: buildResourceIo() });

    const denied = await service.readResource({
      authorizationIdentifier: "auth-a-read",
      sourceProjectIdentifier: PROJECT_X,
      targetProjectIdentifier: PROJECT_C,
      resourcePath: "docs/spec.md",
      absoluteResourcePath: absoluteX,
      argumentsHash: "hash-a",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(denied.outcome).toBe("project-mismatch");
    expect(denied.didRead).toBe(false);
  });
});

describe("PROJECT-01-04：多同级个体不串数据", () => {
  it("④ 不同接收个体各自的副本回执必须可区分（按 receivingAgentInstanceId 追溯）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grant({
      store,
      authorizationIdentifier: "auth-recv-1",
      sourceProjectIdentifier: PROJECT_A,
      operationKind: "import-copy",
      argumentsHash: "hash-recv-1",
      receivingAgentInstanceId: RECEIVER_ONE,
    });
    await grant({
      store,
      authorizationIdentifier: "auth-recv-2",
      sourceProjectIdentifier: PROJECT_A,
      operationKind: "import-copy",
      argumentsHash: "hash-recv-2",
      receivingAgentInstanceId: RECEIVER_TWO,
    });
    const absoluteA = await writeResource(PROJECT_A, "docs/spec.md", "# 同级个体内容\n");
    const service = new CrossProjectTransferService({ store, resourceIo: buildResourceIo() });

    const receiverOneResult = await service.importCopy({
      authorizationIdentifier: "auth-recv-1",
      sourceProjectIdentifier: PROJECT_A,
      targetProjectIdentifier: PROJECT_C,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/one.md",
      absoluteSourcePath: absoluteA,
      absoluteTargetPath: path.join(baseDirectory, PROJECT_C, "docs", "one.md"),
      sourceRevision: 3,
      contentHash: sha256Text("# 同级个体内容\n"),
      argumentsHash: "hash-recv-1",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    const receiverTwoResult = await service.importCopy({
      authorizationIdentifier: "auth-recv-2",
      sourceProjectIdentifier: PROJECT_A,
      targetProjectIdentifier: PROJECT_C,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/two.md",
      absoluteSourcePath: absoluteA,
      absoluteTargetPath: path.join(baseDirectory, PROJECT_C, "docs", "two.md"),
      sourceRevision: 3,
      contentHash: sha256Text("# 同级个体内容\n"),
      argumentsHash: "hash-recv-2",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(receiverOneResult.outcome).toBe("imported-copy");
    expect(receiverTwoResult.outcome).toBe("imported-copy");
    // 各自回执绑定各自授权（因此可追溯到具体接收个体），不是同一条
    expect(receiverOneResult.receipt?.authorizationIdentifier).toBe("auth-recv-1");
    expect(receiverTwoResult.receipt?.authorizationIdentifier).toBe("auth-recv-2");
    expect(receiverOneResult.receipt?.receiptIdentifier).not.toBe(
      receiverTwoResult.receipt?.receiptIdentifier,
    );

    // 接收个体维度**真实落库**：按 receivingAgentInstanceId 过滤必须只看到自己那条（不串数据）
    const receiverOneAuthorizations = await store.listAuthorizations({
      receivingAgentInstanceId: RECEIVER_ONE,
    });
    const receiverTwoAuthorizations = await store.listAuthorizations({
      receivingAgentInstanceId: RECEIVER_TWO,
    });
    expect(receiverOneAuthorizations.map((record) => record.authorizationIdentifier)).toEqual([
      "auth-recv-1",
    ]);
    expect(receiverTwoAuthorizations.map((record) => record.authorizationIdentifier)).toEqual([
      "auth-recv-2",
    ]);
    expect(receiverOneAuthorizations[0]?.receivingAgentInstanceId).toBe(RECEIVER_ONE);
  });

  it("⑤ 并发导入同一内容（同一授权）只产生一个副本，其余幂等复用", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grant({
      store,
      authorizationIdentifier: "auth-concurrent",
      sourceProjectIdentifier: PROJECT_A,
      operationKind: "import-copy",
      argumentsHash: "hash-concurrent",
    });
    const content = "# 并发内容\n";
    const absoluteA = await writeResource(PROJECT_A, "docs/spec.md", content);
    const targetAbsolutePath = path.join(baseDirectory, PROJECT_C, "docs", "concurrent.md");
    const service = new CrossProjectTransferService({ store, resourceIo: buildResourceIo() });

    const importInput = {
      authorizationIdentifier: "auth-concurrent",
      sourceProjectIdentifier: PROJECT_A,
      targetProjectIdentifier: PROJECT_C,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/concurrent.md",
      absoluteSourcePath: absoluteA,
      absoluteTargetPath: targetAbsolutePath,
      sourceRevision: 3,
      contentHash: sha256Text(content),
      argumentsHash: "hash-concurrent",
      nowIso: "2026-10-02T00:00:00.000Z",
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.importCopy(importInput)),
    );
    const createdCount = results.filter((result) => result.outcome === "imported-copy").length;
    const reusedCount = results.filter(
      (result) => result.outcome === "reused-existing-copy",
    ).length;
    expect(createdCount).toBe(1);
    expect(reusedCount).toBe(7);
    expect(await store.countCopyReceipts()).toBe(1);
    expect(await fs.readFile(targetAbsolutePath, "utf8")).toBe(content);
  });
});
