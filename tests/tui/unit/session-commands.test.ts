/**
 * B6R-11：session 命令组（B6R-06）覆盖补缺。
 * elevation-list / elevate / revoke-elevation / shutdown 的 JSON/文本/空态分支。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeSessionElevateCommand,
  executeSessionElevationListCommand,
  executeSessionRevokeElevationCommand,
  executeSessionShutdownCommand,
} from "../../../packages/tui/src/cli/commands.js";

let temporaryDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sesscmd-"));
  stdoutBuffer = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  afterEach(() => {
    process.stdout.write = originalWrite;
  });
});

async function prepareElevation(): Promise<string> {
  const createResult = await executeSessionElevateCommand({
    stateDirectory: temporaryDirectory,
    sessionId: "session-1",
    capabilityId: "filesystem-read",
    elevatedDecision: "allow",
    agentInstanceId: null,
    expiresAtIso: null,
    isJsonOutput: true,
  });
  expect(createResult).toBe(0);
  const line = stdoutBuffer.find((chunk) => chunk.includes("elevated ")) ?? "";
  return line.replace("elevated ", "").split("\t")[0] ?? "";
}

describe("session 命令组", () => {
  it("elevation-list：文本列出提升与空态", async () => {
    const elevationId = await prepareElevation();
    stdoutBuffer.length = 0;
    const exitCode = await executeSessionElevationListCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-1",
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutBuffer.join("")).toContain(elevationId);
    expect(stdoutBuffer.join("")).toContain("filesystem-read");
    stdoutBuffer.length = 0;
    await executeSessionElevationListCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-empty",
      isJsonOutput: false,
    });
    expect(stdoutBuffer.join("")).toContain("无提升");
  });

  it("elevation-list --json：JSON 数组", async () => {
    const elevationId = await prepareElevation();
    stdoutBuffer.length = 0;
    await executeSessionElevationListCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-1",
      isJsonOutput: true,
    });
    const parsed = JSON.parse(stdoutBuffer.join("")) as { elevationId: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.elevationId).toBe(elevationId);
  });

  it("revoke-elevation：成功 revoke 与未找到", async () => {
    const elevationId = await prepareElevation();
    stdoutBuffer.length = 0;
    await executeSessionRevokeElevationCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-1",
      elevationId,
    });
    expect(stdoutBuffer.join("")).toContain("revoked");
    stdoutBuffer.length = 0;
    await executeSessionRevokeElevationCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-1",
      elevationId: "ghost-elevation",
    });
    expect(stdoutBuffer.join("")).toContain("未找到");
  });

  it("session shutdown：文本（含导出失败原因）与 JSON", async () => {
    const elevationId = await prepareElevation();
    stdoutBuffer.length = 0;
    const textResult = await executeSessionShutdownCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-1",
      exportPath: temporaryDirectory, // 指向目录 → 导出失败路径
      isJsonOutput: false,
    });
    expect(textResult).toBe(0);
    expect(stdoutBuffer.join("")).toContain("closed=true");
    expect(stdoutBuffer.join("")).toContain("revoked=1");
    expect(stdoutBuffer.join("")).toContain("exportFailed=");
    void elevationId;
  });

  it("session shutdown：正常导出 + JSON 输出", async () => {
    await prepareElevation();
    stdoutBuffer.length = 0;
    const exportPath = path.join(temporaryDirectory, "exported", "permissions.json");
    const exitCode = await executeSessionShutdownCommand({
      stateDirectory: temporaryDirectory,
      sessionId: "session-1",
      exportPath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      closed: boolean;
      revokedElevationCount: number;
      exportWrote: boolean;
    };
    expect(parsed).toMatchObject({ closed: true, revokedElevationCount: 1, exportWrote: true });
    expect(await fs.readFile(exportPath, "utf8")).toContain("capabilityDecisions");
  });
});
