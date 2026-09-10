/**
 * T09A-07：context status CLI（JSON/文本共用视图）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeContextStatusCommand } from "../../../packages/tui/src/cli/commands.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

const HASH = "sha256:" + "a".repeat(64);
let stateDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ctx-cli-"));
  stdoutBuffer = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  afterEach(() => {
    process.stdout.write = originalWrite;
  });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
});

async function seedGraph() {
  const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
  await graphStore.createGraph({
    graphIdentifier: "graph-1",
    ownerAgentInstanceId: "agent-a",
    missionId: "mission-1",
  });
  await graphStore.addNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 1,
    contextNodeIdentifier: "node-1",
    missionId: "mission-1",
    contentFingerprint: HASH,
  });
}

describe("context status 命令（T09A-07）", () => {
  it("--json 输出共用 DTO（含分组、预算与脱敏标记）", async () => {
    await seedGraph();
    const exitCode = await executeContextStatusCommand({
      stateDirectory,
      agentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      isJsonOutput: true,
      configuredMaximumGlobalContextTokenCount: 4096,
      effectiveMaximumGlobalContextTokenCount: 4096,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      nodeGroups: { active: Array<{ contextNodeIdentifier: string }> };
      disclosure: { includesOtherAgentContext: boolean };
      humanVerificationPolicy: string;
    };
    expect(parsed.nodeGroups.active[0]?.contextNodeIdentifier).toBe("node-1");
    expect(parsed.disclosure.includesOtherAgentContext).toBe(false);
    expect(parsed.humanVerificationPolicy).toBe("block-until-verified");
  });

  it("文本模式显示待追认与配置/实际上限", async () => {
    await seedGraph();
    const exitCode = await executeContextStatusCommand({
      stateDirectory,
      agentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      isJsonOutput: false,
      configuredMaximumGlobalContextTokenCount: 4096,
      effectiveMaximumGlobalContextTokenCount: 1024,
      budgetReductionReason: "Provider 空间不足",
    });
    expect(exitCode).toBe(0);
    const text = stdoutBuffer.join("");
    expect(text).toContain("待人工追认关闭");
    expect(text).toContain("配置上限: 4096 token");
    expect(text).toContain("实际上限: 1024 token");
    expect(text).toContain("缩减原因: Provider 空间不足");
  });
});
