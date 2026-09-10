/**
 * AR-07 批次 5：关键模块剩余分支补测（免审批 threads 通道可复现）。
 * 覆盖：读取抑制账本、活锁守卫、可配置权限引擎、权限组存储、安装门禁、
 * Ponder 本地工具策略引擎、会话提升解析、备份库清单/快照/审计链。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION } from "../../../packages/core/src/core/types.js";
import { BackupDeletionAuditLog, BackupVault } from "../../../packages/core/src/tools/backup-vault.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { InstallationGateGuard } from "../../../packages/core/src/tools/installation-gate-guard.js";
import { LocalProgressAndCycleGuard } from "../../../packages/core/src/tools/local-progress-and-cycle-guard.js";
import { LocalToolPolicyEngine } from "../../../packages/core/src/tools/local-tool-policy-engine.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { CanonicalResourceIdentityResolver, ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
  TertiaryPermissionDelegationGuard,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07-b5-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

const ISO = "2026-01-01T00:00:00.000Z";

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    permissionProfileId: "profile-a",
    displayName: "Profile A",
    isBuiltin: false,
    revision: 1,
    catalogVersion: 1,
    capabilityDecisions: {},
    fallbackDecision: "deny",
    frozenSignature: null,
    createdAtIso: ISO,
    updatedAtIso: ISO,
    ...overrides,
  };
}

describe("AR-07 批次5：读取抑制账本", () => {
  it("默认时钟与 null taskExecutionId 覆盖键构造分支", async () => {
    const ledger = new ReadSuppressionLedger();
    const missingPath = path.join(temporaryDirectory, "missing.txt");
    const query = {
      agentInstanceId: "agent-a",
      taskExecutionId: null,
      canonicalPath: missingPath,
      operationKind: "read",
      normalizedRange: "full",
      parameterHash: "hash-1",
    } as never;
    const decision = await ledger.querySuppression(query);
    expect(decision.isSuppressed).toBe(false);
    const receipt = await ledger.registerRead({
      ...(query as object),
      contentFingerprint: null,
    } as never);
    expect(receipt.startsWith("receipt-")).toBe(true);
  });

  it("非 ENOENT 的 stat 失败 → fail-closed 抛出", async () => {
    const resolver = new CanonicalResourceIdentityResolver();
    await expect(resolver.currentFingerprint("C:\\bad\u0000name")).rejects.toThrow();
  });
});

describe("AR-07 批次5：活锁与循环守卫", () => {
  it("默认选项可用，图节点上限触发结构化违规", async () => {
    const defaultGuard = new LocalProgressAndCycleGuard();
    const noViolation = await defaultGuard.recordCallAndDetectViolation({
      callerKey: "a",
      calleeKey: "b",
      nodeKind: "tool",
      taskExecutionId: "task-1",
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(noViolation).toBeNull();

    const guard = new LocalProgressAndCycleGuard({ maxGraphNodes: 1 });
    await guard.recordCallAndDetectViolation({
      callerKey: "a",
      calleeKey: "b",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: null,
      isNewProgress: false,
    });
    const violation = await guard.recordCallAndDetectViolation({
      callerKey: "c",
      calleeKey: "d",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(violation?.kind).toBe("graph-node-limit");
  });

  it("有进展时重置路径计数", async () => {
    const guard = new LocalProgressAndCycleGuard();
    await guard.recordCallAndDetectViolation({
      callerKey: "a",
      calleeKey: "b",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: "sig",
      isNewProgress: false,
    });
    const result = await guard.recordCallAndDetectViolation({
      callerKey: "a",
      calleeKey: "b",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: "sig",
      isNewProgress: true,
    });
    expect(result).toBeNull();
  });
});

describe("AR-07 批次5：可配置权限引擎", () => {
  const askCatalog = {
    isToolMapped: () => true,
    evaluateToolPermission: () => "ask",
  } as never;

  it("默认时钟、custom→builtin 不匹配、参数哈希失效", async () => {
    const profile = makeProfile();
    const profileStore = { readProfile: async () => profile } as never;
    const builtinReference = { kind: "builtin", profileId: "assist" } as const;
    const customReference = { kind: "custom", profileId: "profile-a" } as const;

    const engine = new ConfigurablePermissionPolicyEngine({
      catalog: askCatalog,
      profileStore,
    });
    await engine.grantSessionAuthorization({
      toolName: "project.read",
      profileReference: customReference,
      argumentsJson: "{}",
    });
    const mismatch = await engine.decide({
      toolName: "project.read",
      profileReference: builtinReference,
      argumentsJson: "{}",
    });
    expect(mismatch.decision).toBe("ask");

    const argumentHash = createHash("sha256").update("{}").digest("hex");
    const authorizations = new Map([
      [
        `project.read:${argumentHash}`,
        {
          profileReference: builtinReference,
          profileRevision: profile.revision,
          catalogVersion: profile.catalogVersion,
          argumentHash: "different-hash",
          expiresAtUnixSeconds: 9_999_999_999,
        },
      ],
    ]);
    const staleEngine = new ConfigurablePermissionPolicyEngine({
      catalog: askCatalog,
      profileStore,
      authorizations: authorizations as never,
    });
    const stale = await staleEngine.decide({
      toolName: "project.read",
      profileReference: builtinReference,
      argumentsJson: "{}",
    });
    expect(stale.decision).toBe("ask");
  });
});

describe("AR-07 批次5：权限组存储", () => {
  it("缺省 catalog、损坏文档、缺失组、旧 revision 与非法文档", async () => {
    const store = new PermissionProfileStore({ baseDirectory: temporaryDirectory });
    const builtin = await store.readProfile({ kind: "builtin", profileId: "assist" });
    expect(builtin.isBuiltin).toBe(true);

    await expect(
      store.readProfile({ kind: "custom", profileId: "profile-missing" }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });

    const profilesDirectory = path.join(temporaryDirectory, "permission-profiles");
    await fs.mkdir(profilesDirectory, { recursive: true });
    await fs.writeFile(
      path.join(profilesDirectory, "profile-corrupt.json"),
      "{not-json",
      "utf8",
    );
    await expect(store.readCustomProfile("profile-corrupt")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });

    const document = makeProfile({ permissionProfileId: "profile-1" });
    await store.saveCustomProfile({
      document: document as never,
      expectedRevision: 0,
    });
    await expect(
      store.saveCustomProfile({
        document: makeProfile({ permissionProfileId: "profile-1" }) as never,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });

    await expect(
      store.saveCustomProfile({
        document: makeProfile({
          permissionProfileId: "profile-1",
          revision: 2,
          capabilityDecisions: { "project.read": "bogus" },
        }) as never,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });
});

describe("AR-07 批次5：安装门禁防御分支", () => {
  const noTargetClassification = {
    classifyCommand: () => ({
      isInstallationAttempt: true,
      detectedTarget: undefined,
      pinnedVersionOrCommit: null,
    }),
  } as never;

  function makeStubs(overrides: {
    authorizationOutcome?: "created" | "denied-invalid-inquiry-receipt";
    authorizeResult?: unknown;
    verification?: unknown;
  } = {}) {
    const inquiryController = {
      createInquiry: () => ({ inquiryId: "inquiry-1" }),
      handleAnswer: async () => ({ outcome: "no-resource" }),
      readReceipt: () => ({ receiptId: "receipt-1" }),
    } as never;
    const request = { requestId: "request-1" };
    const authorizationController = {
      createAuthorizationRequest: async () => ({
        outcome: overrides.authorizationOutcome ?? "created",
        request,
      }),
      authorizeAllowOnce: async () =>
        overrides.authorizeResult === undefined
          ? { authorizationId: "authorization-1" }
          : overrides.authorizeResult,
      verifyAndConsumeAuthorization: async () =>
        overrides.verification ?? { allowed: true },
    } as never;
    return { inquiryController, authorizationController };
  }

  function makeGuard(stubs: ReturnType<typeof makeStubs>, userPort: unknown) {
    return new InstallationGateGuard({
      classifier: noTargetClassification,
      inquiryController: stubs.inquiryController,
      authorizationController: stubs.authorizationController,
      userPort: userPort as never,
      authenticatedUserId: "user-1",
      getCurrentMode: () => "assist",
    });
  }

  const callInput = {
    commandName: "npm",
    arguments: ["install", "lodash"],
    requestingAgentInstanceId: "agent-a",
    taskExecutionId: "task-1",
  };

  it("无回答 → fail-closed（detectedTarget 缺省文本回退）", async () => {
    const stubs = makeStubs();
    const guard = makeGuard(stubs, {
      askExistingResource: async () => null,
      askAllowOnce: async () => "allow-once",
    });
    const decision = await guard.assertInstallationAllowed(callInput);
    expect(decision).toEqual({
      allowed: false,
      reason: expect.stringContaining("未回答"),
    });
  });

  it("no-resource + allow-once 成功 → 放行（detectedTarget 缺省）", async () => {
    const stubs = makeStubs();
    const guard = makeGuard(stubs, {
      askExistingResource: async () => ({ answer: "no-resource" }),
      askAllowOnce: async () => "allow-once",
    });
    const decision = await guard.assertInstallationAllowed(callInput);
    expect(decision).toEqual({ allowed: true });
  });

  it("询问回执无效 / 授权失败 / 执行前复检失败 → 分别拒绝", async () => {
    const invalidReceipt = makeGuard(
      makeStubs({ authorizationOutcome: "denied-invalid-inquiry-receipt" }),
      { askExistingResource: async () => ({ answer: "no-resource" }), askAllowOnce: async () => "allow-once" },
    );
    expect(await invalidReceipt.assertInstallationAllowed(callInput)).toEqual({
      allowed: false,
      reason: expect.stringContaining("回执无效"),
    });

    const noAuthorization = makeGuard(makeStubs({ authorizeResult: null }), {
      askExistingResource: async () => ({ answer: "no-resource" }),
      askAllowOnce: async () => "allow-once",
    });
    expect(await noAuthorization.assertInstallationAllowed(callInput)).toEqual({
      allowed: false,
      reason: expect.stringContaining("授权失败"),
    });

    const failedVerification = makeGuard(
      makeStubs({ verification: { allowed: false, reason: "模式已变更" } }),
      { askExistingResource: async () => ({ answer: "no-resource" }), askAllowOnce: async () => "allow-once" },
    );
    expect(await failedVerification.assertInstallationAllowed(callInput)).toEqual({
      allowed: false,
      reason: expect.stringContaining("执行前复检失败"),
    });
  });
});

describe("AR-07 批次5：Ponder 本地工具策略引擎", () => {
  const readonlyDescriptor = {
    name: "searchProjectText",
    summary: "检索",
    category: "readonly",
    backupPolicy: "not-required",
    mutationKind: "none",
  } as never;

  function makeEngine() {
    return new LocalToolPolicyEngine({
      workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: path.join(temporaryDirectory, "state"),
      }),
    });
  }

  it("非只读分类、git 视图参数构造与 searchProjectText 参数校验", async () => {
    const engine = makeEngine();
    expect(engine.buildPonderGitReadonlyArguments("diff", null)).toEqual([
      "diff",
      "--stat",
      "HEAD",
    ]);
    expect(engine.buildPonderGitReadonlyArguments("unknown-view", null)).toEqual([]);
    expect(engine.buildPonderGitReadonlyArguments("log", null)).toEqual([
      "log",
      "--oneline",
      "-n",
      "10",
    ]);

    const missingPattern = await engine.evaluatePonderAccess({
      toolName: "searchProjectText",
      descriptor: readonlyDescriptor,
      argumentsJson: JSON.stringify({ pattern: 123 }),
    });
    expect(missingPattern).toContain("pattern 缺失或非法");

    const notWhitelisted = await engine.evaluatePonderAccess({
      toolName: "writeFile",
      descriptor: readonlyDescriptor,
      argumentsJson: "{}",
    });
    expect(notWhitelisted).toContain("白名单");

    const longPattern = await engine.evaluatePonderAccess({
      toolName: "searchProjectText",
      descriptor: readonlyDescriptor,
      argumentsJson: JSON.stringify({ pattern: "x".repeat(201) }),
    });
    expect(longPattern).toContain("过长");
  });
});

describe("AR-07 批次5：会话提升解析与期限求交", () => {
  it("custom profile 不匹配失效、更宽覆盖生效、期限取更早", async () => {
    const store = new SessionPermissionElevationStore();
    const controller = new SessionPermissionElevationController(store);
    await controller.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "project.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "custom", profileId: "profile-a" },
      baseProfileRevision: 1,
      catalogVersion: 1,
      originalDecision: "deny",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "decision-1",
      sessionPermissionRevision: 1,
    });

    const resolver = new EffectiveSecondaryPermissionResolver();
    const baseProfile = makeProfile();
    const baseInput = {
      agentInstanceId: "agent-a",
      sessionId: "session-1",
      capabilityId: "project.read",
      baseProfile: baseProfile as never,
      elevationStore: store,
      nowUnixMilliseconds: Date.now(),
      isAgentRetired: false,
      currentSessionPermissionRevision: 1,
      requestedResourceScope: "workspace",
    };
    const mismatched = await resolver.resolveEffectiveDecision({
      ...baseInput,
      currentProfileReference: { kind: "custom", profileId: "profile-b" },
    });
    expect(mismatched).toBe("deny");

    const elevated = await resolver.resolveEffectiveDecision({
      ...baseInput,
      currentProfileReference: { kind: "custom", profileId: "profile-a" },
    });
    expect(elevated).toBe("allow");

    const delegationGuard = new TertiaryPermissionDelegationGuard();
    expect(
      delegationGuard.computeDelegatedExpiry({
        secondaryExpiresAtIso: "2026-01-02T00:00:00.000Z",
        requestedExpiresAtIso: "2026-01-01T12:00:00.000Z",
      }),
    ).toBe("2026-01-01T12:00:00.000Z");
    expect(
      delegationGuard.computeDelegatedExpiry({
        secondaryExpiresAtIso: "2026-01-01T12:00:00.000Z",
        requestedExpiresAtIso: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe("2026-01-01T12:00:00.000Z");
  });
});

describe("AR-07 批次5：备份库清单/快照/审计链", () => {
  it("schema 版本匹配但 entries 非数组 → 重建空清单", async () => {
    const baseDirectory = path.join(temporaryDirectory, "vault-manifest");
    const vaultDirectory = path.join(baseDirectory, "backup-vault");
    await fs.mkdir(vaultDirectory, { recursive: true });
    await fs.writeFile(
      path.join(vaultDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION,
        revision: 0,
        updatedAtIso: ISO,
        entries: null,
      }),
      "utf8",
    );
    const vault = new BackupVault({ baseDirectory });
    await vault.initialize();
    const manifest = JSON.parse(
      await fs.readFile(path.join(vaultDirectory, "manifest.json"), "utf8"),
    ) as { entries: unknown };
    expect(manifest.entries).toEqual([]);
  });

  it("目录快照含子目录与文件；NUL 目标路径 fail-closed", async () => {
    const vault = new BackupVault({
      baseDirectory: path.join(temporaryDirectory, "vault-snapshot"),
    });
    await vault.initialize();
    const snapshotDirectory = path.join(temporaryDirectory, "snapshot-source");
    await fs.mkdir(path.join(snapshotDirectory, "nested"), { recursive: true });
    await fs.writeFile(path.join(snapshotDirectory, "a.txt"), "hello", "utf8");
    await fs.writeFile(
      path.join(snapshotDirectory, "nested", "b.txt"),
      "world",
      "utf8",
    );
    const receipt = await vault.createPreMutationBackup({
      toolName: "writeFile",
      targetPath: snapshotDirectory,
      mutationKind: "overwrite",
    });
    const readResult = await vault.readBackup(receipt.backupIdentifier);
    expect(readResult.content).toContain("a.txt");
    expect(readResult.content).toContain("nested");

    await expect(
      vault.createPreMutationBackup({
        toolName: "writeFile",
        targetPath: "C:\\bad\u0000name",
        mutationKind: "overwrite",
      }),
    ).rejects.toThrow();
  });

  it("审计链读取空白文件与缺 recordHash 记录", async () => {
    const baseDirectory = path.join(temporaryDirectory, "audit-log");
    await fs.mkdir(baseDirectory, { recursive: true });
    const auditLog = new BackupDeletionAuditLog(baseDirectory);
    const auditPath = path.join(baseDirectory, "backup-deletion-audit.jsonl");
    await fs.writeFile(auditPath, "   \n", "utf8");
    const first = await auditLog.appendRecord({
      requestingAgentInstanceId: "agent-a",
      mode: "assist",
      backupIdentifiers: ["backup-1"],
      outcome: "purged",
    });
    expect(first.previousRecordHash).toBeNull();

    await fs.writeFile(auditPath, `${JSON.stringify({ auditRecordId: "legacy" })}\n`, "utf8");
    const second = await auditLog.appendRecord({
      requestingAgentInstanceId: "agent-a",
      mode: "assist",
      backupIdentifiers: ["backup-2"],
      outcome: "purged",
    });
    expect(second.previousRecordHash).toBeNull();
  });
});
