/**
 * T07D-R2-04 tarball 验收：判定逻辑的**行为反例**（红 → 绿）。
 *
 * 背景（本次查证到的既有缺陷）：`scripts/verify-t07d-r2-04-tarball-live.mjs` 的
 * 判定段形如 `const rounds = []; if (isDryRun) { ... }`，即**只有干跑会填充 rounds**。
 * 真实（live）模式下 rounds 恒为空 → checks 为空 → failedChecks 为空 →
 * 写出 `verdict: "passed"` 并在终端打印 "验收通过：产物正确 + 任务 done ✓"，
 * 而实际上**一次 Provider 请求都没有发、一个任务都没有跑**。
 *
 * 本文件钉住的核心不变量：**零轮次的运行绝不允许判定为 passed**；
 * 且真实通过必须同时具备五项判据（含"无其他改动"）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const decisionLibraryPath = fileURLToPath(
  new URL("../../../scripts/lib/t07d-r2-04-acceptance-decision.mjs", import.meta.url),
);

interface AcceptanceCheck {
  checkName: string;
  isPassed: boolean;
  detail: string;
}

interface AcceptanceDecision {
  checks: AcceptanceCheck[];
  failedCheckNames: string[];
  verdict: "passed" | "failed";
  executedRoundCount: number;
  isRealAcceptanceEvidence: boolean;
}

interface AcceptanceRound {
  roundName: string;
  roundKind: "success" | "rejection";
  parsedResult: Record<string, unknown> | null;
  fileExists: boolean;
  actualContent: string | null;
  unexpectedEntryList?: string[];
}

interface DecisionLibrary {
  buildAcceptanceChecks: (input: {
    isDryRun: boolean;
    rounds: AcceptanceRound[];
    expectedContent: string;
    outputFileRelativePath: string;
  }) => AcceptanceDecision;
  collectUnexpectedProjectEntries: (input: {
    projectDirectory: string;
    outputFileRelativePath: string;
  }) => string[];
}

/**
 * 动态载入（非字面量说明符）：该库是供脚本直接 `node` 执行的原生 ESM，
 * 不走 TS 构建，因此这里不做静态解析，改用运行时载入并显式声明契约。
 */
async function loadDecisionLibrary(): Promise<DecisionLibrary> {
  const moduleUrl = pathToFileURL(decisionLibraryPath).href;
  const loaded = (await import(moduleUrl)) as DecisionLibrary;
  return loaded;
}

const expectedContent = [
  "# 真实 Provider 受控改动（T07D-R2-04）",
  "- 厂商：unisound",
  "- 端点：maas-api.unisound.com",
  "- 模型：u2-flash",
  "- 协议：anthropic-messages",
  "",
].join("\n");

const outputFileRelativePath = ".tmp/t07d-r2-04-live/LIVE-PROOF.md";

function buildSuccessRound(overrides: Partial<AcceptanceRound> = {}): AcceptanceRound {
  return {
    roundName: "真实运行：成功路径",
    roundKind: "success",
    parsedResult: { status: "done", permissionAsk: "allowed-once" },
    fileExists: true,
    actualContent: expectedContent,
    unexpectedEntryList: [],
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "t07d-r2-04-decision-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("T07D-R2-04 验收判定：零判据绝不通过", () => {
  it("零轮次的真实运行必须判定 failed（既有缺陷：判为 passed 并打印“任务 done”）", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
    expect(decision.isRealAcceptanceEvidence).toBe(false);
    expect(decision.checks.length).toBeGreaterThan(0);
    expect(decision.checks.some((check) => !check.isPassed)).toBe(true);
  });

  it("零轮次的干跑同样不得通过（干跑也不允许空判据）", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: true,
      rounds: [],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
  });

  it("真实成功轮次判定 passed，且标记为真实验收证据（五项判据）", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [buildSuccessRound()],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("passed");
    expect(decision.isRealAcceptanceEvidence).toBe(true);
    expect(decision.executedRoundCount).toBe(1);
    expect(decision.checks).toHaveLength(5);
    expect(decision.checks.every((check) => check.isPassed)).toBe(true);
  });

  it("干跑即使全绿也不算真实验收证据", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: true,
      rounds: [buildSuccessRound({ roundName: "干跑 A：成功路径" })],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("passed");
    expect(decision.isRealAcceptanceEvidence).toBe(false);
  });

  it("产物缺失必须失败（谎报完成不得结案）", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [buildSuccessRound({ fileExists: false, actualContent: null })],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
    expect(decision.failedCheckNames.some((name) => name.includes("产物存在"))).toBe(true);
  });

  it("产物逐行不精确必须失败", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [buildSuccessRound({ actualContent: expectedContent + "- 额外一行\n" })],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
    expect(decision.failedCheckNames.some((name) => name.includes("逐行精确"))).toBe(true);
  });

  it("存在其他改动必须失败（卡内五项判据含“无其他改动”）", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [buildSuccessRound({ unexpectedEntryList: ["src/意外改动.ts"] })],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
    expect(decision.failedCheckNames.some((name) => name.includes("无其他改动"))).toBe(true);
  });

  it("未提供改动清单必须失败（fail-closed：不得静默跳过第五项判据）", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const round = buildSuccessRound();
    delete round.unexpectedEntryList;
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [round],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
    expect(decision.failedCheckNames.some((name) => name.includes("无其他改动"))).toBe(true);
  });

  it("拒绝结案轮次：声称完成但缺产物时必须失败", async () => {
    const { buildAcceptanceChecks } = await loadDecisionLibrary();
    const decision = buildAcceptanceChecks({
      isDryRun: false,
      rounds: [
        {
          roundName: "真实运行：缺产物拒绝结案",
          roundKind: "rejection",
          parsedResult: { status: "done" },
          fileExists: false,
          actualContent: null,
        },
      ],
      expectedContent,
      outputFileRelativePath,
    });

    expect(decision.verdict).toBe("failed");
    expect(decision.failedCheckNames.some((name) => name.includes("不得结案为 done"))).toBe(true);
  });
});

describe("T07D-R2-04 验收判定：改动清单扫描", () => {
  it("忽略 .astarray 状态目录与目标产物，只报告其他改动", async () => {
    const { collectUnexpectedProjectEntries } = await loadDecisionLibrary();
    const projectDirectory = createTemporaryDirectory();

    mkdirSync(path.join(projectDirectory, ".astarray", "usage"), { recursive: true });
    writeFileSync(path.join(projectDirectory, ".astarray", "usage", "entries.json"), "{}\n");
    mkdirSync(path.join(projectDirectory, ".tmp", "t07d-r2-04-live"), { recursive: true });
    writeFileSync(
      path.join(projectDirectory, outputFileRelativePath),
      expectedContent,
      "utf8",
    );
    writeFileSync(path.join(projectDirectory, "意外.txt"), "不应出现\n", "utf8");
    mkdirSync(path.join(projectDirectory, "src"), { recursive: true });
    writeFileSync(path.join(projectDirectory, "src", "改动.ts"), "export {};\n", "utf8");

    const unexpectedEntryList = collectUnexpectedProjectEntries({
      projectDirectory,
      outputFileRelativePath,
    });

    expect(unexpectedEntryList).toEqual(["src/改动.ts", "意外.txt"].sort());
  });

  it("目录不存在时返回空清单（不抛错，且文件系统状态必须真实存在才为空）", async () => {
    const { collectUnexpectedProjectEntries } = await loadDecisionLibrary();
    const projectDirectory = path.join(createTemporaryDirectory(), "不存在");
    expect(existsSync(projectDirectory)).toBe(false);

    const unexpectedEntryList = collectUnexpectedProjectEntries({
      projectDirectory,
      outputFileRelativePath,
    });

    expect(unexpectedEntryList).toEqual([]);
  });
});
