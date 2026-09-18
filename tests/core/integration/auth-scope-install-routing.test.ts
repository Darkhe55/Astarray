/**
 * GOV-02b：安装类范围细分与门禁分流（项目内受控安装 → S1 上级批准；其余仍 S5 → 人工）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decideScopeAuthorization,
  resolveOperationScope,
  type OperationDescriptor,
  type RegisteredProjectRoot,
} from "../../../packages/core/src/tools/scope-resolution.js";
import { ScopeAuthorizationGate } from "../../../packages/core/src/tools/scope-authorization-gate.js";

let baseDirectory: string;
let projectRoot: RegisteredProjectRoot;
let externalDirectoryPath: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-install-routing-"));
  const projectDirectoryPath = path.join(baseDirectory, "project");
  await fs.mkdir(path.join(projectDirectoryPath, "node_modules"), { recursive: true });
  externalDirectoryPath = path.join(baseDirectory, "external");
  await fs.mkdir(externalDirectoryPath, { recursive: true });
  projectRoot = { projectIdentifier: "P", rootPath: projectDirectoryPath };
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function installOperation(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return { operationKind: "dependency-install", ...overrides };
}

describe("GOV-02b 安装范围细分", () => {
  it("无证据或声明不完整 → S5（fail-closed）", async () => {
    const withoutEvidence = await resolveOperationScope({
      operation: installOperation(),
      registeredProjectRoots: [projectRoot],
    });
    expect(withoutEvidence.scopeClass).toBe("S5-installation");

    const partialEvidence = await resolveOperationScope({
      operation: installOperation({
        installScopeEvidence: {
          isProjectInternalControlled: false,
          controlledRootPath: projectRoot.rootPath,
        },
      }),
      registeredProjectRoots: [projectRoot],
    });
    expect(partialEvidence.scopeClass).toBe("S5-installation");
  }, 30_000);

  it("项目内受控证据 + 注册根命中 → S1 子类；根在注册根外仍 S5", async () => {
    const controlled = await resolveOperationScope({
      operation: installOperation({
        installScopeEvidence: {
          isProjectInternalControlled: true,
          controlledRootPath: path.join(projectRoot.rootPath, "node_modules"),
        },
      }),
      registeredProjectRoots: [projectRoot],
    });
    expect(controlled.scopeClass).toBe("S1-project-internal");
    expect(controlled.projectIdentifier).toBe("P");
    expect(controlled.reasons.join(" ")).toContain("项目内受控安装");

    const outsideRoot = await resolveOperationScope({
      operation: installOperation({
        installScopeEvidence: {
          isProjectInternalControlled: true,
          controlledRootPath: externalDirectoryPath,
        },
      }),
      registeredProjectRoots: [projectRoot],
    });
    expect(outsideRoot.scopeClass).toBe("S5-installation");
  }, 30_000);

  it("声明有全局/外部副作用或未知安装脚本 → S5", async () => {
    for (const evidence of [
      {
        isProjectInternalControlled: true,
        controlledRootPath: path.join(projectRoot.rootPath, "node_modules"),
        hasGlobalOrExternalEffects: true,
      },
      {
        isProjectInternalControlled: true,
        controlledRootPath: path.join(projectRoot.rootPath, "node_modules"),
        hasUnknownInstallScripts: true,
      },
    ]) {
      const resolution = await resolveOperationScope({
        operation: installOperation({ installScopeEvidence: evidence }),
        registeredProjectRoots: [projectRoot],
      });
      expect(resolution.scopeClass).toBe("S5-installation");
    }
  }, 30_000);

  it("S5 未受控安装：开关关闭拒绝；开启后协同模式仍需认证用户", () => {
    const closed = decideScopeAuthorization({
      scopeClass: "S5-installation",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: false,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(closed.decision).toBe("deny");

    const opened = decideScopeAuthorization({
      scopeClass: "S5-installation",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(opened.decision).toBe("ask-user");
    expect(opened.adjudicator).toBe("authenticated-user");
    expect(opened.requiresInstallationSwitch).toBe(true);
  }, 30_000);

  it("S1 受控安装：开关关闭一律拒绝；开启后按设置由上级批准且仍要求开关", () => {
    const closed = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: false,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(closed.decision).toBe("deny");
    expect(closed.requiresInstallationSwitch).toBe(true);

    const allowed = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(allowed.decision).toBe("allow");
    expect(allowed.adjudicator).toBe("superior-agent");
    expect(allowed.requiresInstallationSwitch).toBe(true);

    const askSuperior = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "assist",
      configuredDecision: "ask",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(askSuperior.decision).toBe("ask-superior");

    const devolveAllow = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "devolve",
      configuredDecision: "allow",
      isInstallationEnabled: true,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(devolveAllow.decision).toBe("allow");
    expect(devolveAllow.requiresInstallationSwitch).toBe(true);

    const devolveClosed = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "devolve",
      configuredDecision: "allow",
      isInstallationEnabled: false,
      isReadOnlyOperation: false,
      operationKind: "dependency-install",
    });
    expect(devolveClosed.decision).toBe("deny");
  }, 30_000);

  it("非安装 S1 操作不受开关影响（回归）", () => {
    const decision = decideScopeAuthorization({
      scopeClass: "S1-project-internal",
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: false,
      isReadOnlyOperation: false,
      operationKind: "project-file-write",
    });
    expect(decision.decision).toBe("allow");
    expect(decision.requiresInstallationSwitch).toBe(false);
  }, 30_000);
});
describe("GOV-02b 公共入口（ScopeAuthorizationGate）", () => {
  function createGate(options: {
    configuredDecision: "deny" | "ask" | "allow";
    isInstallationEnabled: boolean;
  }): ScopeAuthorizationGate {
    return new ScopeAuthorizationGate({
      getMode: () => "assist",
      getRegisteredProjectRoots: () => [projectRoot],
      getConfiguredDecision: () => options.configuredDecision,
      isInstallationEnabled: () => options.isInstallationEnabled,
      getAuthorizationRevision: () => 1,
      nowIso: () => "2026-09-17T00:00:00.000Z",
      superiorApprovalPort: {
        approve: async () => ({
          isApproved: true,
          approvedByAgentInstanceId: "secondary-1",
        }),
      },
    });
  }

  it("项目内受控安装：开关开启按设置由上级批准并留回执", async () => {
    const gate = createGate({ configuredDecision: "allow", isInstallationEnabled: true });
    const outcome = await gate.authorizeForExecution({
      operationKind: "dependency-install",
      installScopeEvidence: {
        isProjectInternalControlled: true,
        controlledRootPath: path.join(projectRoot.rootPath, "node_modules"),
      },
    });
    expect(outcome.isAllowed).toBe(true);
    expect(outcome.resolution.scopeClass).toBe("S1-project-internal");
    expect(outcome.record?.adjudicator).toBe("superior-agent");
  }, 30_000);

  it("项目内受控安装但开关关闭：拒绝且不发放授权", async () => {
    const gate = createGate({ configuredDecision: "allow", isInstallationEnabled: false });
    const outcome = await gate.authorizeForExecution({
      operationKind: "dependency-install",
      installScopeEvidence: {
        isProjectInternalControlled: true,
        controlledRootPath: path.join(projectRoot.rootPath, "node_modules"),
      },
    });
    expect(outcome.isAllowed).toBe(false);
    expect(outcome.errorCode).toBe("auth-scope-denied");
    expect(outcome.reasons.join(" ")).toContain("开关关闭");
    expect(gate.listDecisionRecords()).toEqual([]);
  }, 30_000);

  it("未受控安装（无证据 → S5）：开关开启仍需认证用户", async () => {
    const gate = createGate({ configuredDecision: "allow", isInstallationEnabled: true });
    const outcome = await gate.authorizeForExecution({
      operationKind: "dependency-install",
    });
    expect(outcome.isAllowed).toBe(false);
    expect(outcome.errorCode).toBe("auth-scope-awaiting-user-authorization");
    expect(outcome.resolution.scopeClass).toBe("S5-installation");
  }, 30_000);
});
