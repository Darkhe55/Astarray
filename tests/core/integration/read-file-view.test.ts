/**
 * READ-FORMAT-05：readFile 视图参数、公共回执、视图感知时间锁与跨 Agent 隔离。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let temporaryDirectoryPath: string;

const SAMPLE_C_SOURCE = [
  "#include <stdio.h>",
  "// 注释",
  'const char *marker = "// not a comment";',
  "",
].join("\n");

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-read-view-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  temporaryDirectoryPath = path.join(temporaryDirectory, "temp");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(temporaryDirectoryPath);
  await fs.writeFile(path.join(workspaceDirectory, "sample.c"), SAMPLE_C_SOURCE, "utf8");
  await fs.writeFile(path.join(workspaceDirectory, "notes.xyz"), "// not filtered\n", "utf8");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function executionContext(
  agentInstanceId: string,
  ledger: ReadSuppressionLedger | null = null,
) {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath,
    requestingAgentInstanceId: agentInstanceId,
    taskExecutionId: "task-1",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    readSuppressionLedger: ledger,
  };
}

async function readFileWithArguments(
  argumentsObject: Record<string, unknown>,
  agentInstanceId = "agent-a",
  ledger: ReadSuppressionLedger | null = null,
) {
  return await executeBuiltinTool(
    "readFile",
    JSON.stringify(argumentsObject),
    executionContext(agentInstanceId, ledger),
  );
}

describe("READ-FORMAT-05 readFile 视图产品入口", () => {
  it("默认参数逐字节返回原文（兼容既有行为）", async () => {
    const result = await readFileWithArguments({ filePath: "sample.c" });
    expect(result).toEqual({ outputText: SAMPLE_C_SOURCE, isSideEffectFree: true });
  }, 30_000);

  it("过滤视图前置公共回执，注释省略、字符串保留", async () => {
    const result = await readFileWithArguments({
      filePath: "sample.c",
      shouldIncludeComments: false,
    });
    expect(result.outputText.startsWith("[astarray-read-view")).toBe(true);
    expect(result.outputText).toContain("status=filtered");
    expect(result.outputText).toContain("strategy=c-family");
    expect(result.outputText).toContain("isViewComplete=false");
    expect(result.outputText).not.toContain("// 注释");
    expect(result.outputText).toContain('"// not a comment"');
  }, 30_000);

  it("未支持格式不虚报：回执 status=unsupported 且原文保留", async () => {
    const result = await readFileWithArguments({
      filePath: "notes.xyz",
      shouldIncludeComments: false,
    });
    expect(result.outputText).toContain("status=unsupported");
    expect(result.outputText).toContain("format-unsupported");
    expect(result.outputText).toContain("// not filtered");
  }, 30_000);

  it("过滤后可按需补读全文；视图参数进入时间锁键而内容指纹用原文", async () => {
    const ledger = new ReadSuppressionLedger({ nowUnixMilliseconds: () => 1_000 });
    await readFileWithArguments(
      { filePath: "sample.c", shouldIncludeComments: false },
      "agent-a",
      ledger,
    );
    // 不同视图是不同键：补读全文不被抑制
    const fullRead = await readFileWithArguments(
      { filePath: "sample.c" },
      "agent-a",
      ledger,
    );
    expect(fullRead.outputText).toBe(SAMPLE_C_SOURCE);
  }, 30_000);

  it("同一视图窗口内重复读取被抑制（resource-already-read）", async () => {
    const ledger = new ReadSuppressionLedger({ nowUnixMilliseconds: () => 1_000 });
    await readFileWithArguments(
      { filePath: "sample.c", shouldIncludeComments: false },
      "agent-a",
      ledger,
    );
    await expect(
      readFileWithArguments(
        { filePath: "sample.c", shouldIncludeComments: false },
        "agent-a",
        ledger,
      ),
    ).rejects.toMatchObject({ errorCode: "resource-already-read" });
  }, 30_000);

  it("跨 Agent 隔离：不同 agentInstanceId 各自可读同一视图", async () => {
    const ledger = new ReadSuppressionLedger({ nowUnixMilliseconds: () => 1_000 });
    const agentARead = await readFileWithArguments(
      { filePath: "sample.c", shouldIncludeComments: false },
      "agent-a",
      ledger,
    );
    expect(agentARead.outputText).toContain("[astarray-read-view");
    const agentBRead = await readFileWithArguments(
      { filePath: "sample.c", shouldIncludeComments: false },
      "agent-b",
      ledger,
    );
    expect(agentBRead.outputText).toContain("[astarray-read-view");
  }, 30_000);

  it("视图参数类型非法时报错，不静默按默认处理", async () => {
    await expect(
      readFileWithArguments({ filePath: "sample.c", shouldIncludeImports: "no" }),
    ).rejects.toThrow("必须为布尔值");
  }, 30_000);
});
