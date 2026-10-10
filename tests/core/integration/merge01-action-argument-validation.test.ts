/**
 * MERGE-01-02 反例（2026-10-10）：统一读取族内的**逐 action 参数校验**。
 *
 * 卡内 §1.2："不同 action 的必需参数使用可校验 schema 分支，**不认识的 action/参数拒绝**"。
 *
 * 本轮实测缺口：
 *  - `readFile` 只显式校验 `format`/`view`，**其余未知参数被静默忽略**
 *    （例如 `format2`、`recursive`、拼错的 `filepath` 都不会报错）；
 *  - `searchProjectText` 完全不校验参数：传入 `format`/`view` 等**不适用于该 action** 的
 *    参数时**静默忽略**（调用方以为生效了）。
 *
 * 期望语义（本轮钉住）：
 *  - 每个 action 声明**允许的参数集**；
 *  - 出现不属于该 action 的参数 ⇒ **拒绝**并指出参数名（不静默忽略、不透传）；
 *  - 必需参数缺失 ⇒ 拒绝（既有行为保留）；
 *  - 同一族内不同 action 的允许集**互不串用**（read 的参数用于 search 必须被拒）。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { LocalToolPolicyEngine } from "../../../packages/core/src/tools/local-tool-policy-engine.js";

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge01-args-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDirectory, "sample.txt"),
    "目标关键字 出现一次\n",
    "utf8",
  );
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function executionContext() {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    requestingAgentInstanceId: "agent-merge01",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    localToolPolicyEngine: new LocalToolPolicyEngine({
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: temporaryDirectory,
      }),
    }),
  };
}

describe("MERGE-01：逐 action 参数校验（不认识的参数必须拒绝）", () => {
  it("① readFile 遇到未知参数必须拒绝（不得静默忽略）", async () => {
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "sample.txt", format2: "auto" }),
        executionContext(),
      ),
      "未知参数 format2 必须被拒绝",
    ).rejects.toThrowError(/format2|未知参数|非法参数/);
  });

  it("② readFile 的参数拼写错误（filepath）必须拒绝，而不是当成缺 filePath", async () => {
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filepath: "sample.txt" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/filepath|未知参数|非法参数/);
  });

  it("③ searchProjectText 收到不适用于该 action 的 format/view 必须拒绝", async () => {
    await expect(
      executeBuiltinTool(
        "searchProjectText",
        JSON.stringify({ pattern: "目标关键字", format: "auto" }),
        executionContext(),
      ),
      "search action 不支持 format，必须拒绝而非静默忽略",
    ).rejects.toThrowError(/format|未知参数|不适用/);
    await expect(
      executeBuiltinTool(
        "searchProjectText",
        JSON.stringify({ pattern: "目标关键字", view: "summary" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/view|未知参数|不适用/);
  });

  it("④ searchProjectText 遇到完全未知的参数也必须拒绝", async () => {
    await expect(
      executeBuiltinTool(
        "searchProjectText",
        JSON.stringify({ pattern: "目标关键字", caseSensitive: true }),
        executionContext(),
      ),
    ).rejects.toThrowError(/caseSensitive|未知参数|非法参数/);
  });

  it("⑤ 合法调用不得被新校验误拒（各 action 的允许集内正常通过）", async () => {
    const readResult = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "sample.txt", format: "text" }),
      executionContext(),
    );
    expect(readResult.isSideEffectFree).toBe(true);

    const searchResult = await executeBuiltinTool(
      "searchProjectText",
      JSON.stringify({ pattern: "目标关键字" }),
      executionContext(),
    );
    expect(searchResult.outputText).toContain("sample.txt");
  });
});
