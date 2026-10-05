/**
 * PROJECT-01-03 行为反例（跨项目只读与副本导入、缩权派生、版本/撤销/恢复）。
 *
 * 卡内验收："来源零写入；同路径参数变化不沿用许可；跨项目再转交拒绝；
 * 并发导入/崩溃无重复副作用"。
 *
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CrossProjectAuthorizationStore,
  CrossProjectTransferService,
} from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project03-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

const SOURCE_PROJECT = "project-a";
const TARGET_PROJECT = "project-b";

async function grantReadAuthorization(store: CrossProjectAuthorizationStore) {
  return store.grantAuthorization({
    authorizationIdentifier: "auth-1",
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: 3,
    targetProjectIdentifier: TARGET_PROJECT,
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: "hash-docs-read",
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
  });
}

describe("PROJECT-01-03：只读跨项目访问", () => {
  it("① 有有效授权：只读成功，且**来源零写入**", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const service = new CrossProjectTransferService({ store });

    const result = await service.readResource({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      argumentsHash: "hash-docs-read",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).toBe("read-allowed");
    expect(result.sourceWriteCount).toBe(0);
    expect(result.didModifySource).toBe(false);
  });

  it("② 同路径但参数变化：不得沿用许可（必须重新授权）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const service = new CrossProjectTransferService({ store });

    const result = await service.readResource({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      // 路径相同，但参数哈希不同（例如内容/范围变化）
      argumentsHash: "hash-docs-read-changed",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).toBe("authorization-parameter-mismatch");
    expect(result.didRead).toBe(false);
  });

  it("③ 超出资源范围：拒绝（新增文件不得无条件进入）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const service = new CrossProjectTransferService({ store });

    const result = await service.readResource({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "src/secret.ts",
      argumentsHash: "hash-docs-read",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).toBe("resource-out-of-scope");
  });

  it("④ 过期 / 已撤销：拒绝，且给出明确原因", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const service = new CrossProjectTransferService({ store });

    const expired = await service.readResource({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      argumentsHash: "hash-docs-read",
      nowIso: "2031-01-01T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(expired.outcome).toBe("authorization-expired");

    await store.revokeAuthorization("auth-1", "用户撤销");
    const revoked = await service.readResource({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      argumentsHash: "hash-docs-read",
      nowIso: "2026-10-02T00:00:00.000Z",
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(revoked.outcome).toBe("authorization-revoked");
  });

  it("⑤ 来源项目 revision 变化：授权失效（版本绑定，须重新核对）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const service = new CrossProjectTransferService({ store });

    const result = await service.readResource({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      resourcePath: "docs/spec.md",
      argumentsHash: "hash-docs-read",
      nowIso: "2026-10-02T00:00:00.000Z",
      currentSourceProjectRevision: 4,
      sourceWriteProbe: { writeAttemptCount: 0 },
    });
    expect(result.outcome).toBe("source-revision-changed");
  });

  it("⑥ 非用户授权（Agent 自行授予）不得生效", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const result = await store.grantAuthorization({
      authorizationIdentifier: "auth-agent",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: 3,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "read",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: "hash-docs-read",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      // Agent 不是认证用户：不得作为授权来源
      grantedByUserId: null,
      taskIdentifier: "T-001",
    });
    expect(result.outcome).toBe("rejected-not-authenticated-user");
  });
});

describe("PROJECT-01-03：副本导入", () => {
  it("⑦ 并发导入同一内容：不得产生重复副作用（幂等回执）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: 3,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "import-copy",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: "hash-import",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });
    const service = new CrossProjectTransferService({ store });

    const importInput = {
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "imported/spec.md",
      sourceRevision: 3,
      contentHash: "sha256:abc",
      argumentsHash: "hash-import",
      nowIso: "2026-10-02T00:00:00.000Z",
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.importCopy(importInput)),
    );
    const createdCount = results.filter((result) => result.outcome === "imported-copy").length;
    const reusedCount = results.filter((result) => result.outcome === "reused-existing-copy").length;
    expect(createdCount).toBe(1);
    expect(reusedCount).toBe(4);
    // 副本数量守恒：不得重复写入
    expect(await service.countCopyReceipts()).toBe(1);
  });

  it("⑧ 副本须保留来源项目/revision/哈希，且标记为副本（人工可分辨）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: 3,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "import-copy",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: "hash-import",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });
    const service = new CrossProjectTransferService({ store });
    const result = await service.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "imported/spec.md",
      sourceRevision: 3,
      contentHash: "sha256:abc",
      argumentsHash: "hash-import",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(result.outcome).toBe("imported-copy");
    expect(result.receipt?.sourceProjectIdentifier).toBe(SOURCE_PROJECT);
    expect(result.receipt?.sourceRevision).toBe(3);
    expect(result.receipt?.contentHash).toBe("sha256:abc");
    expect(result.receipt?.isCopyOfExternalSource).toBe(true);
  });

  it("⑨ 崩溃恢复：已有回执时重放不得重复副作用", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      sourceProjectRevision: 3,
      targetProjectIdentifier: TARGET_PROJECT,
      targetProjectRevision: 1,
      operationKind: "import-copy",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: "hash-import",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });
    const firstService = new CrossProjectTransferService({ store });
    await firstService.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "imported/spec.md",
      sourceRevision: 3,
      contentHash: "sha256:abc",
      argumentsHash: "hash-import",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    // 模拟进程重启：新 store 实例读同一目录
    const restartedStore = new CrossProjectAuthorizationStore({ baseDirectory });
    const restartedService = new CrossProjectTransferService({ store: restartedStore });
    const replay = await restartedService.importCopy({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "imported/spec.md",
      sourceRevision: 3,
      contentHash: "sha256:abc",
      argumentsHash: "hash-import",
      nowIso: "2026-10-02T00:10:00.000Z",
    });
    expect(replay.outcome).toBe("reused-existing-copy");
    expect(await restartedService.countCopyReceipts()).toBe(1);
  });
});

describe("PROJECT-01-03：缩权派生与再转交拒绝", () => {
  it("⑩ 任务内缩权派生：派生授权范围必须**不宽于**来源授权", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const narrower = await store.deriveNarrowedAuthorization({
      parentAuthorizationIdentifier: "auth-1",
      authorizationIdentifier: "auth-1-child",
      resourceScope: { pathPrefixes: ["docs/sub/"], realPaths: [], isDynamicSharedDirectory: false },
      taskIdentifier: "T-001-child",
    });
    expect(narrower.outcome).toBe("derived-narrowed");

    const wider = await store.deriveNarrowedAuthorization({
      parentAuthorizationIdentifier: "auth-1",
      authorizationIdentifier: "auth-1-wider",
      // 试图扩大范围
      resourceScope: { pathPrefixes: ["docs/", "src/"], realPaths: [], isDynamicSharedDirectory: false },
      taskIdentifier: "T-001-wider",
    });
    expect(wider.outcome).toBe("rejected-not-narrower");
  });

  it("⑪ 跨项目再转交必须拒绝（禁止转授）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const redelegation = await store.attemptRedelegation({
      parentAuthorizationIdentifier: "auth-1",
      authorizationIdentifier: "auth-redelegate",
      targetProjectIdentifier: "project-c",
      targetAgentInstanceId: "worker:project-c:T-009:1",
    });
    expect(redelegation).toBe("rejected-no-redelegation");
  });

  it("⑫ 授权列表可追溯：来源/目标/操作/任务/状态齐备", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await grantReadAuthorization(store);
    const list = await store.listAuthorizations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      operationKind: "read",
      taskIdentifier: "T-001",
      state: "active",
    });
  });
});
