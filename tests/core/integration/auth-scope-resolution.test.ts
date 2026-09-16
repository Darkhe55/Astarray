/**
 * AUTH-SCOPE-02：范围判定、裁决者矩阵、批准回执与执行前复检反例。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeOperationFingerprint,
  decideScopeAuthorization,
  isValidEscalationPath,
  recheckBeforeExecution,
  resolveEscalationTarget,
  resolveOperationScope,
  verifyScopeApprovalReceipt,
  type OperationDescriptor,
  type RegisteredProjectRoot,
  type ScopeApprovalReceipt,
} from "../../../packages/core/src/tools/scope-resolution.js";

const NOW = "2026-09-16T00:00:00.000Z";
let baseDirectory: string;
let rootA: RegisteredProjectRoot;
let rootB: RegisteredProjectRoot;
let outsideDirectoryPath: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-auth-scope-"));
  outsideDirectoryPath = path.join(baseDirectory, "outside");
  await fs.mkdir(path.join(baseDirectory, "proj"), { recursive: true });
  await fs.mkdir(path.join(baseDirectory, "proj-other"), { recursive: true });
  await fs.mkdir(outsideDirectoryPath, { recursive: true });
  rootA = { projectIdentifier: "A", rootPath: path.join(baseDirectory, "proj") };
  rootB = {
    projectIdentifier: "B",
    rootPath: path.join(baseDirectory, "proj-other"),
  };
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function writeOperation(targetPath: string): OperationDescriptor {
  return { operationKind: "project-file-write", targetPath };
}

describe("AUTH-SCOPE-02 范围判定与裁决", () => {
  it("项目内写入判为 S1；自述范围与 cwd 都不影响判定", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        ...writeOperation(path.join(rootA.rootPath, "src", "a.ts")),
        claimedScopeDescription: "这个操作只在项目内，无需授权",
      },
      registeredProjectRoots: [rootA, rootB],
    });
    expect(resolution.scopeClass).toBe("S1-project-internal");
    expect(resolution.projectIdentifier).toBe("A");
    expect(resolution.reasons.join(" ")).toContain("自述范围不参与判定");
  });

  it("链接逃逸：符号链接指向项目根外被判为项目外", async () => {
    const linkPath = path.join(rootA.rootPath, "link");
    const resolveRealPath = async (inputPath: string): Promise<string | null> =>
      inputPath === linkPath
        ? path.join(outsideDirectoryPath, "real")
        : inputPath;
    const resolution = await resolveOperationScope({
      operation: writeOperation(linkPath),
      registeredProjectRoots: [rootA],
      resolveRealPath,
    });
    expect(resolution.scopeClass).toBe("S3-project-external");
  });

  it("路径前缀碰撞：proj-other 不会被当成 proj 的子路径", async () => {
    const resolution = await resolveOperationScope({
      operation: writeOperation(path.join(rootB.rootPath, "file.txt")),
      registeredProjectRoots: [rootA, rootB],
    });
    expect(resolution.scopeClass).toBe("S1-project-internal");
    expect(resolution.projectIdentifier).toBe("B");
  });

  it("跨项目根与不可解析目标分别判为 S2 / S4", async () => {
    const crossRoot = await resolveOperationScope({
      operation: {
        ...writeOperation(path.join(rootA.rootPath, "a.txt")),
        touchesAdditionalProjectRoots: true,
      },
      registeredProjectRoots: [rootA, rootB],
    });
    expect(crossRoot.scopeClass).toBe("S2-cross-project-root");

    const unresolvable = await resolveOperationScope({
      operation: writeOperation(path.join(rootA.rootPath, "*.txt")),
      registeredProjectRoots: [rootA],
    });
    expect(unresolvable.scopeClass).toBe("S4-unknown");

    const unknownKind = await resolveOperationScope({
      operation: { operationKind: "process-execution", hasExternalSideEffects: true },
      registeredProjectRoots: [rootA],
    });
    expect(unknownKind.scopeClass).toBe("S4-unknown");
  });

  it("安装类：开关关闭一律拒绝（协同/放权相同），协同开启需人工授权", () => {
    const assistOff = decideScopeAuthorization({
      scopeClass: "S5-installation",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: false,
      isReadOnlyOperation: false,
    });
    expect(assistOff.decision).toBe("deny");
    expect(assistOff.requiresInstallationSwitch).toBe(true);
    expect(assistOff.reasons[0]).toContain("开关关闭");

    const devolveOff = decideScopeAuthorization({
      scopeClass: "S5-installation",
      mode: "devolve",
      configuredDecision: "allow",
      isInstallationEnabled: false,
      isReadOnlyOperation: false,
    });
    expect(devolveOff.decision).toBe("deny");

    const assistOn = decideScopeAuthorization({
      scopeClass: "S5-installation",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
    });
    expect(assistOn.decision).toBe("ask-user");
  });

  it("矩阵：协同项目内上级批准、项目外/未知人工、放权未知上级、思索只读", () => {
    expect(
      decideScopeAuthorization({
        scopeClass: "S1-project-internal",
        mode: "assist",
        configuredDecision: "ask",
        isInstallationEnabled: true,
        isReadOnlyOperation: false,
      }),
    ).toMatchObject({ decision: "ask-superior", adjudicator: "superior-agent" });

    expect(
      decideScopeAuthorization({
        scopeClass: "S1-project-internal",
        mode: "assist",
        configuredDecision: "allow",
        isInstallationEnabled: true,
        isReadOnlyOperation: false,
      }),
    ).toMatchObject({ decision: "allow", adjudicator: "superior-agent" });

    expect(
      decideScopeAuthorization({
        scopeClass: "S3-project-external",
        mode: "assist",
        configuredDecision: "allow",
        isInstallationEnabled: true,
        isReadOnlyOperation: false,
      }).decision,
    ).toBe("ask-user");

    expect(
      decideScopeAuthorization({
        scopeClass: "S4-unknown",
        mode: "devolve",
        configuredDecision: "allow",
        isInstallationEnabled: true,
        isReadOnlyOperation: false,
      }),
    ).toMatchObject({ decision: "ask-superior" });

    expect(
      decideScopeAuthorization({
        scopeClass: "S1-project-internal",
        mode: "devolve",
        configuredDecision: "allow",
        isInstallationEnabled: true,
        isReadOnlyOperation: false,
      }).decision,
    ).toBe("allow");

    const ponderRead = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "ponder",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: true,
    });
    expect(ponderRead.decision).toBe("allow");
    const ponderWrite = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "ponder",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
    });
    expect(ponderWrite.decision).toBe("deny");

    const special = decideScopeAuthorization({
      scopeClass: "S7-special-flow",
      mode: "devolve",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
    });
    expect(special).toMatchObject({
      decision: "ask-user",
      adjudicator: "dedicated-flow",
    });
  });

  it("deny 优先于模式与范围", () => {
    for (const mode of ["ponder", "assist", "devolve"] as const) {
      const decision = decideScopeAuthorization({
        scopeClass: "S1-project-internal",
        mode,
        configuredDecision: "deny",
        isInstallationEnabled: true,
        isReadOnlyOperation: true,
      });
      expect(decision.decision).toBe("deny");
    }
  });

  it("回执绑定指纹/revision/有效期；执行前复检能发现范围变化", async () => {
    const operation = writeOperation(path.join(rootA.rootPath, "src", "b.ts"));
    const resolution = await resolveOperationScope({
      operation,
      registeredProjectRoots: [rootA],
    });
    const receipt: ScopeApprovalReceipt = {
      receiptIdentifier: "receipt-1",
      scopeClass: resolution.scopeClass,
      adjudicator: "superior-agent",
      approvedByAgentInstanceId: "secondary-1",
      approvedByUserId: null,
      operationFingerprint: computeOperationFingerprint({ operation, resolution }),
      authorizationRevision: 7,
      approvedAtIso: NOW,
      expiresAtIso: "2026-09-16T01:00:00.000Z",
    };
    expect(
      verifyScopeApprovalReceipt({
        receipt,
        operation,
        resolution,
        currentAuthorizationRevision: 7,
        nowIso: NOW,
      }),
    ).toEqual({ isValid: true, reason: "valid" });

    expect(
      verifyScopeApprovalReceipt({
        receipt,
        operation,
        resolution,
        currentAuthorizationRevision: 8,
        nowIso: NOW,
      }).reason,
    ).toBe("stale-revision");

    expect(
      verifyScopeApprovalReceipt({
        receipt,
        operation,
        resolution,
        currentAuthorizationRevision: 7,
        nowIso: "2026-09-16T02:00:00.000Z",
      }).reason,
    ).toBe("expired");

    const changedOperation = writeOperation(path.join(rootA.rootPath, "src", "c.ts"));
    expect(
      verifyScopeApprovalReceipt({
        receipt,
        operation: changedOperation,
        resolution: await resolveOperationScope({
          operation: changedOperation,
          registeredProjectRoots: [rootA],
        }),
        currentAuthorizationRevision: 7,
        nowIso: NOW,
      }).reason,
    ).toBe("fingerprint-mismatch");

    // 执行前复检：解析器改变后目标落到项目外 → scope-mismatch，回执失效。
    const recheck = await recheckBeforeExecution({
      operation,
      registeredProjectRoots: [rootA],
      receipt,
      currentAuthorizationRevision: 7,
      nowIso: NOW,
      resolveRealPath: async (inputPath: string) =>
        path.join(outsideDirectoryPath, path.basename(inputPath)),
    });
    expect(recheck.resolution.scopeClass).toBe("S3-project-external");
    expect(recheck.receiptVerification).toEqual({
      isValid: false,
      reason: "scope-mismatch",
    });
  });

  it("升级路径有界且不得循环回派", () => {
    expect(
      resolveEscalationTarget({ requesterLevel: "quaternary", scopeClass: "S1-project-internal" }),
    ).toMatchObject({ targetLevel: "tertiary" });
    expect(
      resolveEscalationTarget({ requesterLevel: "tertiary", scopeClass: "S3-project-external" }),
    ).toMatchObject({ targetLevel: "secondary" });
    expect(isValidEscalationPath(["quaternary", "tertiary", "secondary"])).toBe(true);
    expect(isValidEscalationPath(["tertiary", "quaternary"])).toBe(false);
    expect(isValidEscalationPath(["secondary", "tertiary", "secondary"])).toBe(false);
    expect(isValidEscalationPath([])).toBe(false);
  });
});
