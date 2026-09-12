/**
 * E2E-01-01 测试：验收 fixture 与证据协议。
 * 验收：fixture 可重复运行、成功/失败标准明确；证据绑定 tarball 哈希、commit、
 * 配置、Provider/模型与运行 ID；自动与人工检查分开且人工项不得自动置为已通过。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const acceptanceModuleUrl = new URL(
  "../../../scripts/e2e01-acceptance.mjs",
  import.meta.url,
).href;

interface FixtureRunResult {
  exitCode: number;
  output: string;
}

interface SolutionRunResult extends FixtureRunResult {
  expectedSummaryMatched: boolean;
  artifactHashes: Record<string, string>;
}

interface AcceptanceModule {
  E2E01_FIXTURE_FAILURE_MARKER: string;
  E2E01_FIXTURE_SUCCESS_MARKER: string;
  scaffoldFixture: (
    targetDirectory: string,
  ) => Promise<{ fingerprint: string; fileCount: number }>;
  computeFixtureFingerprint: (directory: string) => Promise<string>;
  runFixtureBaseline: (targetDirectory: string) => FixtureRunResult;
  runFixtureSolution: (targetDirectory: string) => SolutionRunResult;
  createEvidenceBundle: (input: {
    runIdentifier: string;
    tarballPath: string;
    configurationPath: string;
    outPath: string;
    provider: {
      providerProfileId: string;
      modelProfileId: string;
      kind: string;
      credentialsAuthorized: boolean;
    };
  }) => Promise<Record<string, unknown>>;
  validateEvidenceBundle: (bundle: unknown) => string[];
}

async function loadAcceptance(): Promise<AcceptanceModule> {
  const imported = (await import(
    /* @vite-ignore */ acceptanceModuleUrl
  )) as unknown;
  return imported as AcceptanceModule;
}

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-e2e01-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function scaffold(
  acceptance: AcceptanceModule,
  name: string,
): Promise<string> {
  const targetDirectory = path.join(temporaryDirectory, name);
  await acceptance.scaffoldFixture(targetDirectory);
  return targetDirectory;
}

describe("E2E-01-01 fixture 可重复运行与冻结标准", () => {
  it("两次 scaffold 指纹一致，且包含冻结的失败测试与目标模块", async () => {
    const acceptance = await loadAcceptance();
    const first = await scaffold(acceptance, "first");
    const second = await scaffold(acceptance, "second");

    const firstFingerprint = await acceptance.computeFixtureFingerprint(first);
    const secondFingerprint = await acceptance.computeFixtureFingerprint(second);
    expect(firstFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstFingerprint).toBe(secondFingerprint);

    await expect(
      fs.access(path.join(first, "project", "test", "run-tests.mjs")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(first, "project", "src", "summarize-tasks.mjs")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(first, "project", "solution", "summarize-tasks.mjs")),
    ).resolves.toBeUndefined();
  });

  it("冻结场景/权限/预算/资源盘点齐全，且实现-测试-验收身份必须不同", async () => {
    const acceptance = await loadAcceptance();
    const targetDirectory = await scaffold(acceptance, "frozen");

    const scenario = JSON.parse(
      await fs.readFile(path.join(targetDirectory, "scenario.json"), "utf8"),
    ) as {
      steps: Array<{
        step: string;
        identityMustDifferFrom?: string[];
        forceOneTestFailure?: boolean;
      }>;
    };
    const implementation = scenario.steps.find(
      (step) => step.step === "implementation",
    );
    const testing = scenario.steps.find((step) => step.step === "testing");
    const acceptanceStep = scenario.steps.find(
      (step) => step.step === "independent-acceptance",
    );
    expect(testing?.identityMustDifferFrom).toContain("implementation");
    expect(acceptanceStep?.identityMustDifferFrom).toEqual(
      expect.arrayContaining(["implementation", "testing"]),
    );
    expect(implementation).toBeDefined();
    expect(
      scenario.steps.some(
        (step) => step.step === "rework-once" && step.forceOneTestFailure === true,
      ),
    ).toBe(true);

    const runConfig = JSON.parse(
      await fs.readFile(path.join(targetDirectory, "run-config.json"), "utf8"),
    ) as {
      installationAllowed: boolean;
      contextBudgetTokens: number;
      runtime: string;
      modelProfileId: string;
      humanVerificationPolicy: string;
    };
    expect(runConfig.installationAllowed).toBe(false);
    expect(runConfig.runtime).toBe("mock");
    expect(runConfig.contextBudgetTokens).toBeGreaterThan(0);
    expect(runConfig.modelProfileId.length).toBeGreaterThan(0);
    expect(runConfig.humanVerificationPolicy).toBe("block-until-verified");

    const resourceRecon = JSON.parse(
      await fs.readFile(path.join(targetDirectory, "resource-recon.json"), "utf8"),
    ) as { fixtureDependencies: string[]; requiresNetwork: boolean };
    expect(resourceRecon.fixtureDependencies).toEqual([]);
    expect(resourceRecon.requiresNetwork).toBe(false);
  });
});

describe("E2E-01-01 成功/失败标准可复现", () => {
  it("基线（未实现）稳定失败并打印冻结失败标记", async () => {
    const acceptance = await loadAcceptance();
    const targetDirectory = await scaffold(acceptance, "baseline");

    const baseline = acceptance.runFixtureBaseline(targetDirectory);
    expect(baseline.exitCode).not.toBe(0);
    expect(baseline.output).toContain(acceptance.E2E01_FIXTURE_FAILURE_MARKER);
  });

  it("参考实现使 fixture 通过并产出与冻结预期一致的产物", async () => {
    const acceptance = await loadAcceptance();
    const targetDirectory = await scaffold(acceptance, "solution");

    const solution = acceptance.runFixtureSolution(targetDirectory);
    expect(solution.exitCode).toBe(0);
    expect(solution.output).toContain(acceptance.E2E01_FIXTURE_SUCCESS_MARKER);
    expect(solution.expectedSummaryMatched).toBe(true);
    expect(Object.keys(solution.artifactHashes)).toContain("out/summary.json");
    expect(solution.artifactHashes["out/summary.json"]).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("E2E-01-01 证据协议绑定与人工项分离", () => {
  async function buildValidContext(): Promise<{
    acceptance: AcceptanceModule;
    bundle: Record<string, unknown>;
    tarballPath: string;
    configurationPath: string;
  }> {
    const acceptance = await loadAcceptance();
    const tarballPath = path.join(temporaryDirectory, "astarray-0.1.0.tgz");
    await fs.writeFile(tarballPath, Buffer.from("fake-tarball-content"));
    const configurationPath = path.join(temporaryDirectory, "run-config.json");
    await fs.writeFile(configurationPath, JSON.stringify({ runtime: "mock" }));
    const bundle = await acceptance.createEvidenceBundle({
      runIdentifier: "e2e01-run-1",
      tarballPath,
      configurationPath,
      outPath: path.join(temporaryDirectory, "evidence.json"),
      provider: {
        providerProfileId: "local-scripted",
        modelProfileId: "scripted-mock-v1",
        kind: "mock",
        credentialsAuthorized: false,
      },
    });
    return { acceptance, bundle, tarballPath, configurationPath };
  }

  it("完整证据包通过校验，并绑定 tarball 哈希/commit/配置/Provider/运行 ID", async () => {
    const { acceptance, bundle, tarballPath } = await buildValidContext();
    expect(acceptance.validateEvidenceBundle(bundle)).toEqual([]);

    const tarballHash = createHash("sha256")
      .update(await fs.readFile(tarballPath))
      .digest("hex");
    const tarball = bundle.tarball as { sha256: string };
    const commit = bundle.commit as { hash: string };
    const configuration = bundle.configuration as { sha256: string };
    const provider = bundle.provider as { modelProfileId: string };
    expect(tarball.sha256).toBe(tarballHash);
    expect(commit.hash.length).toBeGreaterThan(0);
    expect(configuration.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.modelProfileId).toBe("scripted-mock-v1");
    expect(bundle.runIdentifier).toBe("e2e01-run-1");
    const manualChecks = bundle.manualChecks as Array<{ status: string }>;
    expect(manualChecks.length).toBeGreaterThan(0);
    expect(manualChecks.every((check) => check.status === "pending-manual")).toBe(
      true,
    );

    // 本地假服务器不联网、无费用：不需要真实凭据授权
    const localFakeProvider = structuredClone(bundle) as Record<string, unknown>;
    (localFakeProvider.provider as Record<string, unknown>).kind = "local-fake";
    expect(acceptance.validateEvidenceBundle(localFakeProvider)).toEqual([]);
  });

  it("缺失绑定、真实 Provider 未授权、人工项无签署、自动项退出码不一致均被拒绝", async () => {
    const { acceptance, bundle } = await buildValidContext();

    const missingBinding = structuredClone(bundle) as Record<string, unknown>;
    delete (missingBinding.tarball as Record<string, unknown>).sha256;
    expect(
      acceptance
        .validateEvidenceBundle(missingBinding)
        .some((problem) => problem.includes("tarball.sha256")),
    ).toBe(true);

    const unauthorizedRealProvider = structuredClone(bundle) as Record<string, unknown>;
    (unauthorizedRealProvider.provider as Record<string, unknown>).kind = "real";
    expect(
      acceptance
        .validateEvidenceBundle(unauthorizedRealProvider)
        .some((problem) =>
          problem.includes("real-provider-requires-authorization"),
        ),
    ).toBe(true);

    const unsignedManualCheck = structuredClone(bundle) as Record<string, unknown>;
    unsignedManualCheck.manualChecks = [{ checkIdentifier: "manual-1", status: "verified" }];
    expect(
      acceptance
        .validateEvidenceBundle(unsignedManualCheck)
        .some((problem) => problem.includes("manualChecks[0].verifiedByUserId")),
    ).toBe(true);

    const inconsistentAutomatedCheck = structuredClone(bundle) as Record<string, unknown>;
    inconsistentAutomatedCheck.automatedChecks = [
      { checkIdentifier: "auto-1", command: "npm run check", exitCode: 1, status: "passed" },
    ];
    expect(
      acceptance
        .validateEvidenceBundle(inconsistentAutomatedCheck)
        .some((problem) => problem.includes("automatedChecks[0].exitCode")),
    ).toBe(true);

    const credentialLeak = structuredClone(bundle) as Record<string, unknown>;
    credentialLeak.apiKey = "should-not-be-here";
    expect(
      acceptance
        .validateEvidenceBundle(credentialLeak)
        .some((problem) => problem.toLowerCase().includes("credential")),
    ).toBe(true);
  });
});
