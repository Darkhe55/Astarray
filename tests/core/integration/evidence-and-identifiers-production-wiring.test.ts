/**
 * 生产接线：factVerification 证据包构建器与任务标识必须真实注入（T06D / ADR-0016）。
 * 修复前：evidenceBundleBuilder 未装配 → build-evidence-bundle 恒报"证据包构建器未装配"；
 * 且 builtins 上下文拿不到 taskExecutionId（读取账本键退化为 null）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { PermissionDecider, SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { EvidenceBundleBuilder } from "../../../packages/core/src/tools/evidence-bundle-builder.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import type { ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let stateDirectory: string;
let fixtureDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-evidence-wiring-"));
  fixtureDirectory = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "evidence-wiring-"));
  await fs.writeFile(path.join(fixtureDirectory, "data.txt"), "EVIDENCE-WIRING-FIXTURE\n", "utf8");
});

afterEach(async () => {
  await fs.rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 5 });
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildWrapper(options: {
  evidenceBundleBuilder?: EvidenceBundleBuilder | null;
  factVerificationClaimIdentifier?: string | null;
  readSuppressionLedger?: ReadSuppressionLedger | null;
  taskExecutionId?: string | null;
}): PolicyWrapper {
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  const workspaceBoundary = new WorkspaceBoundary(process.cwd());
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(
      new ModeMachine("devolve"),
      new SessionAuthorizationManager(),
    ),
    registry,
    workspaceBoundary,
    temporaryDirectoryPath: path.join(stateDirectory, "temp"),
    workerAllowedToolNames: null,
    nowUnixSeconds: () => Math.floor(Date.now() / 1000),
    getCurrentMode: () => "devolve",
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: stateDirectory,
    }),
    ...options,
  });
}

const reasoningEntry = (claimIdentifier: string) => ({
  entryType: "reasoning" as const,
  claimIdentifier,
  premises: ["本地已验证前提"],
  uncertainty: "未做外部复现",
});

describe("生产装配：factVerification 证据包与任务标识", () => {
  it("装配构建器后 build-evidence-bundle 返回证据包（含主张标识）", async () => {
    const wrapper = buildWrapper({
      evidenceBundleBuilder: new EvidenceBundleBuilder(),
      factVerificationClaimIdentifier: "claim-wiring-1",
    });
    const result = await wrapper.execute(
      "factVerification",
      JSON.stringify({
        action: "build-evidence-bundle",
        entries: [reasoningEntry("claim-wiring-1")],
      }),
      "call-evidence-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
    const bundle = JSON.parse(String((result as { outputText?: string }).outputText));
    expect(bundle.claimIdentifier).toBe("claim-wiring-1");
    expect(bundle.entries).toHaveLength(1);
  });

  it("未装配构建器时明确失败（证明上一条依赖真实注入）", async () => {
    const wrapper = buildWrapper({});
    const result = await wrapper.execute(
      "factVerification",
      JSON.stringify({
        action: "build-evidence-bundle",
        entries: [reasoningEntry("claim-wiring-2")],
      }),
      "call-evidence-2",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect(String((result as { errorMessage?: string }).errorMessage)).toContain(
      "证据包构建器未装配",
    );
  });

  it("读取账本拿得到任务执行标识（键不再退化为 null）", async () => {
    const seenInputs: Array<{ taskExecutionId?: string | null }> = [];
    const ledgerStub = {
      querySuppression: async (input: { taskExecutionId?: string | null }) => {
        seenInputs.push(input);
        return {
          isSuppressed: false,
          readReceiptId: null,
          firstReadAtUnixMilliseconds: null,
          retryAfterMilliseconds: 0,
        };
      },
      registerRead: async (input: { taskExecutionId?: string | null }) => {
        seenInputs.push(input);
        return "receipt-wiring-1";
      },
    } as unknown as ReadSuppressionLedger;
    const relativePath = path
      .relative(process.cwd(), path.join(fixtureDirectory, "data.txt"))
      .split(path.sep)
      .join("/");
    const wrapper = buildWrapper({
      readSuppressionLedger: ledgerStub,
      taskExecutionId: "task-exec:wiring-test",
    });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: relativePath }),
      "call-read-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
    expect(seenInputs.length).toBeGreaterThan(0);
    expect(
      seenInputs.every((input) => input.taskExecutionId === "task-exec:wiring-test"),
    ).toBe(true);
  });
});
