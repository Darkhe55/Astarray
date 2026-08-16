/**
 * B6R-11：InteractiveInstallationGatePort 全分支单测
 * （非 TTY fail-closed、no/null/空输入、has-resource、allow-once yes/deny/null）。
 */
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { InteractiveInstallationGatePort } from "../../../packages/tui/src/cli/install-decision-port.js";

function makePort(options: { interactive: boolean; answers: (string | null)[] }) {
  const outputChunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(chunk.toString());
      callback();
    },
  });
  let index = 0;
  const port = new InteractiveInstallationGatePort({
    interactOutput: output,
    isInteractive: () => options.interactive,
    readLine: async () => options.answers[index++] ?? null,
  });
  return { port, outputChunks };
}

const inquiry = {
  inquiryId: "inquiry-1",
  requiredCapabilitySummary: "安装 npm 包",
  intendedUse: "运行测试",
  compatibleCandidateTypes: ["registry-package"],
  createdAtIso: "2026-08-16T00:00:00.000Z",
};

const request = {
  authorizationRequestId: "auth-1",
  nonce: "nonce-1",
  requestingAgentInstanceId: "tertiary-1",
  taskExecutionId: "task-1",
  inquiryReceiptId: "inquiry-1",
  userDecisionReference: "user-1",
  sourceUrlOrRegistry: "https://registry.npmjs.org",
  packageOrRepositoryIdentifier: "lodash",
  pinnedVersionOrCommit: "4.17.21",
  integrityInformation: null,
  targetPathOrScope: "project",
  packageManager: "npm",
  parametersJson: "{}",
  requiresNetwork: true,
  hasInstallScripts: false,
  expectedChangesSummary: "添加依赖",
  createdAtIso: "2026-08-16T00:00:00.000Z",
  canRememberForSession: false as const,
};

describe("InteractiveInstallationGatePort", () => {
  it("非 TTY：已有资源询问与 allow-once 均 fail-closed（null）", async () => {
    const { port, outputChunks } = makePort({ interactive: false, answers: [] });
    expect(await port.askExistingResource(inquiry)).toBeNull();
    expect(await port.askAllowOnce(request)).toBeNull();
    expect(outputChunks).toEqual([]);
  });

  it("TTY：回答 no → no-resource；回答资源引用 → has-resource（trim）", async () => {
    const { port, outputChunks } = makePort({
      interactive: true,
      answers: ["no", "  https://example.com/pkg  "],
    });
    expect(await port.askExistingResource(inquiry)).toEqual({ answer: "no-resource" });
    expect(await port.askExistingResource(inquiry)).toEqual({
      answer: "has-resource",
      resourceReference: "https://example.com/pkg",
      providedResourceType: "user-provided",
    });
    expect(outputChunks.join("").length).toBeGreaterThan(0);
  });

  it("TTY：null 回答/空输入 → null（fail-closed）", async () => {
    const { port } = makePort({ interactive: true, answers: [null, ""] });
    expect(await port.askExistingResource(inquiry)).toBeNull();
    expect(await port.askExistingResource(inquiry)).toBeNull();
  });

  it("TTY：allow-once yes/deny/null；输出精确安装计划", async () => {
    const { port, outputChunks } = makePort({
      interactive: true,
      answers: ["yes", "n", null],
    });
    expect(await port.askAllowOnce(request)).toBe("allow-once");
    expect(await port.askAllowOnce(request)).toBe("deny");
    expect(await port.askAllowOnce(request)).toBeNull();
    const text = outputChunks.join("");
    expect(text).toContain("lodash");
    expect(text).toContain("4.17.21");
    expect(text).toContain("project");
    expect(text).toContain("npm");
  });
});
