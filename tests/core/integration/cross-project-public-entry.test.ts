/**
 * PROJECT-01-04 行为反例（有效授权交叉、公开入口、多项目隔离、副本可分辨）。
 *
 * 卡内验收："A/B/C 项目及多个同级个体可追溯、不串数据；放权规则内无需人等，
 * 规则外不放行；人工能分辨副本与原件"。
 * 卡内 §4 判定规则：有效授权 = **来源可导出范围 ∩ 目标可接收范围 ∩ 接收 Agent 当前有效权限**，
 * **deny 优先**；放权模式在用户预设共享范围内可自动通过，超范围仍询问或拒绝；
 * "可配置权限默认 allow"不自动创建项目间共享关系。
 *
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CrossProjectAuthorizationStore,
  evaluateEffectiveCrossProjectPermission,
  summarizeCopyReceipts,
} from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PROJECT-01-04：有效授权交叉判定", () => {
  it("① 三集合交集：只有同时落在来源可导出、目标可接收、Agent 权限内才放行", () => {
    const allowed = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/", "shared/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/", "shared/"] },
      requestedResourcePath: "docs/spec.md",
      mode: "assist",
      // 交集成立的放行场景：用户已预委托（协同模式下未预委托仍需人工裁决）
      hasUserPresetDelegation: true,
    });
    expect(allowed.isAllowed).toBe(true);
    expect(allowed.decision).toBe("allow-by-preset-shared-scope");

    const outsideSource = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/", "shared/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/", "shared/"] },
      requestedResourcePath: "src/secret.ts",
      mode: "assist",
      hasUserPresetDelegation: true,
    });
    // 落在来源可导出范围之外 → 不得放行
    expect(outsideSource.isAllowed).toBe(false);
  });

  it("② deny 优先：任一侧显式拒绝即整体拒绝，即使其它侧允许", () => {
    const result = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "docs/spec.md",
      mode: "assist",
      explicitDenyScopes: [{ pathPrefixes: ["docs/secret/"] }],
      requestedResourceIsDenied: true,
    });
    expect(result.isAllowed).toBe(false);
    expect(result.decision).toBe("deny-wins");
  });

  it("③ 放权模式：预设共享范围内自动通过；超范围仍不放行", () => {
    const inScope = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "docs/spec.md",
      mode: "devolve",
    });
    expect(inScope.isAllowed).toBe(true);
    expect(inScope.isHumanDecisionRequired).toBe(false);

    const outOfScope = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "outside/spec.md",
      mode: "devolve",
    });
    expect(outOfScope.isAllowed).toBe(false);
    expect(outOfScope.isHumanDecisionRequired).toBe(false);
    expect(outOfScope.decision).toBe("deny-out-of-preset-shared-scope");
  });

  it("④ 协同模式超范围：需要人裁决，不得自动放行", () => {
    const result = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "outside/spec.md",
      mode: "assist",
      hasUserPresetDelegation: false,
    });
    expect(result.isAllowed).toBe(false);
    expect(result.isHumanDecisionRequired).toBe(true);
    expect(result.decision).toBe("ask-user");
  });

  it("⑤ 可配置权限默认 allow 不自动创建项目间共享关系", () => {
    const result = evaluateEffectiveCrossProjectPermission({
      // 目标侧未声明可接收范围（默认 allow 不等于同意接收）
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: [] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "docs/spec.md",
      mode: "devolve",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.decision).toBe("deny-target-does-not-receive");
  });

  it("⑥ 思索模式：跨项目 grant 不得授予写/执行能力（只读不变）", () => {
    const result = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: ["docs/"] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "docs/spec.md",
      mode: "ponder",
      requestedOperationKind: "import-copy",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.decision).toBe("deny-ponder-readonly-only");
  });
});

describe("PROJECT-01-04：公开入口与多项目隔离", () => {
  it("⑦ 授权列表可追溯且不串数据：A/B/C 多项目各自可查，互不包含", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const projects = ["project-a", "project-b", "project-c"];
    for (const [index, sourceProject] of projects.entries()) {
      await store.grantAuthorization({
        authorizationIdentifier: "auth-" + String(index),
        sourceProjectIdentifier: sourceProject,
        sourceProjectRevision: 1,
        targetProjectIdentifier: "project-target",
        targetProjectRevision: 1,
        operationKind: "read",
        resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
        argumentsHash: "hash-" + String(index),
        expiresAtIso: "2030-01-01T00:00:00.000Z",
        grantedByUserId: "user-1",
        taskIdentifier: "T-00" + String(index),
      });
    }
    const all = await store.listAuthorizations();
    expect(all).toHaveLength(3);
    const onlyB = await store.listAuthorizations({ sourceProjectIdentifier: "project-b" });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0]?.sourceProjectIdentifier).toBe("project-b");
    // 不串数据：查询 B 的结果不得含 A/C
    const serialized = JSON.stringify(onlyB);
    expect(serialized).not.toContain("project-a");
    expect(serialized).not.toContain("project-c");
  });

  it("⑧ 多个同级个体：按具体 agentInstanceId 过滤，互不可见", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    for (const identifier of ["peer-1", "peer-2"]) {
      await store.grantAuthorization({
        authorizationIdentifier: "auth-" + identifier,
        sourceProjectIdentifier: "project-a",
        sourceProjectRevision: 1,
        targetProjectIdentifier: "project-b",
        targetProjectRevision: 1,
        operationKind: "read",
        resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
        argumentsHash: "hash-" + identifier,
        expiresAtIso: "2030-01-01T00:00:00.000Z",
        grantedByUserId: "user-1",
        taskIdentifier: "T-" + identifier,
        receivingAgentInstanceId: "worker:" + identifier,
      });
    }
    const peerOne = await store.listAuthorizations({ receivingAgentInstanceId: "worker:peer-1" });
    expect(peerOne).toHaveLength(1);
    expect(JSON.stringify(peerOne)).not.toContain("peer-2");
  });

  it("⑨ 人工可分辨副本与原件：副本摘要显式标记且给出来源引用", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: "project-a",
      sourceProjectRevision: 7,
      targetProjectIdentifier: "project-b",
      targetProjectRevision: 2,
      operationKind: "import-copy",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: "hash-import",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });
    await store.recordCopyReceipt({
      receiptIdentifier: "copy-1",
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: "project-a",
      sourceRevision: 7,
      targetProjectIdentifier: "project-b",
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "imported/spec.md",
      contentHash: "sha256:abc",
      isCopyOfExternalSource: true,
      createdAtIso: "2026-10-02T00:00:00.000Z",
    });

    const summary = await summarizeCopyReceipts({ store });
    expect(summary.receipts).toHaveLength(1);
    const entry = summary.receipts[0];
    expect(entry?.displayLabel).toContain("副本");
    expect(entry?.displayLabel).toContain("project-a");
    expect(entry?.displayLabel).toContain("sha256:abc");
    expect(entry?.isCopyOfExternalSource).toBe(true);
    expect(entry?.isOriginal).toBe(false);
  });

  it("⑩ 公开入口只读：查询授权列表不得联网、不得执行进程、不得写文件", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: "project-a",
      sourceProjectRevision: 1,
      targetProjectIdentifier: "project-b",
      targetProjectRevision: 1,
      operationKind: "read",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: "hash-1",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const filesBefore = (await fs.readdir(baseDirectory, { recursive: true })).length;
    await store.listAuthorizations();
    await summarizeCopyReceipts({ store });
    expect(fetchSpy).not.toHaveBeenCalled();
    const filesAfter = (await fs.readdir(baseDirectory, { recursive: true })).length;
    expect(filesAfter).toBe(filesBefore);
  });
});
