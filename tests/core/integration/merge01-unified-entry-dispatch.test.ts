/**
 * MERGE-01 反例（2026-10-10）：两个纵向样本必须**在派发路径上可达**。
 *
 * 卡内 §1.2："以能力族和 action 枚举复用现有工具""先适配**两个现有相近入口**作纵向样本，
 * **保留旧名称兼容别名并路由同一实现**；**不得为了统一变成任意 shell/任意方法调用入口**"。
 *
 * 现状缺口（本轮实测）：两个族（`projectFileRead` / `projectFileWrite`）**只存在于注册表**，
 * `executeBuiltinTool` 的 switch **只认旧工具名** ⇒ 统一入口 `族名 + action`
 * 在**真实派发路径上不可达**，"路由同一实现"没有落地。
 *
 * 本片钉住的语义：
 *  - **族名 + 合法 action** ⇒ 路由到与旧名**同一个实现**（结果逐字节一致）；
 *  - **旧名** 行为完全不变（兼容别名）；
 *  - **未知 action / 未知族名** ⇒ 拒绝（不得变成任意方法调用入口）；
 *  - **别名 + 不匹配的 action** ⇒ 拒绝（不得跨 action 套用）；
 *  - 版本不一致调用前校验：统一入口仍走同一套参数校验（含未知参数拒绝）。
 *
 * 只跑本地临时目录；不联网、不用凭据。
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
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge01-unified-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await fs.writeFile(path.join(workspaceDirectory, "sample.txt"), "第一行\n第二行\n", "utf8");
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
    // 检索工具需要本地策略引擎（与既有 searchProjectText 测试同口径）。
    localToolPolicyEngine: new LocalToolPolicyEngine({
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: temporaryDirectory,
      }),
    }),
  };
}

describe("MERGE-01：统一入口（族名 + action）必须路由到同一实现", () => {
  it("① projectFileRead + read 与旧名 readFile 结果**逐字节一致**", async () => {
    const legacy = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "sample.txt", format: "text" }),
      executionContext(),
    );
    const unified = await executeBuiltinTool(
      "projectFileRead",
      JSON.stringify({ action: "read", filePath: "sample.txt", format: "text" }),
      executionContext(),
    );
    expect(unified.outputText).toBe(legacy.outputText);
    expect(unified.isSideEffectFree).toBe(legacy.isSideEffectFree);
  });

  it("② projectFileRead + search 与旧名 searchProjectText 结果一致", async () => {
    const argumentsJson = JSON.stringify({ pattern: "第一行" });
    const legacy = await executeBuiltinTool(
      "searchProjectText",
      argumentsJson,
      executionContext(),
    );
    const unified = await executeBuiltinTool(
      "projectFileRead",
      JSON.stringify({ action: "search", pattern: "第一行" }),
      executionContext(),
    );
    expect(unified.outputText).toBe(legacy.outputText);
  });

  it("③ projectFileWrite + create 与旧名 createProjectFile 结果一致（并真的落盘）", async () => {
    const legacy = await executeBuiltinTool(
      "createProjectFile",
      JSON.stringify({ filePath: ".tmp/legacy.md", content: "# legacy\n" }),
      executionContext(),
    );
    const unified = await executeBuiltinTool(
      "projectFileWrite",
      JSON.stringify({
        action: "create",
        filePath: ".tmp/unified.md",
        content: "# unified\n",
      }),
      executionContext(),
    );
    expect(typeof unified.outputText).toBe("string");
    expect(typeof legacy.outputText).toBe("string");
    // 两条路径都要真的落盘（不是只返回字符串）
    expect(await fs.readFile(path.join(workspaceDirectory, ".tmp/legacy.md"), "utf8")).toBe(
      "# legacy\n",
    );
    expect(await fs.readFile(path.join(workspaceDirectory, ".tmp/unified.md"), "utf8")).toBe(
      "# unified\n",
    );
  });

  it("④ 未知 action / 未知族名 / 别名+不匹配 action 一律拒绝（不得成为任意调用入口）", async () => {
    await expect(
      executeBuiltinTool(
        "projectFileRead",
        JSON.stringify({ action: "not-an-action", filePath: "sample.txt" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/action|未知|不支持/);

    await expect(
      executeBuiltinTool(
        "someArbitraryTool",
        JSON.stringify({ action: "read", filePath: "sample.txt" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/未知|不支持|未注册/);

    // 旧名 + 不匹配 action：不得跨 action 套用
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ action: "overwrite", filePath: "sample.txt", content: "x" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/action|未知|不支持/);
  });

  it("⑤ 统一入口仍走同一套参数校验（未知参数被拒，不得绕过）", async () => {
    await expect(
      executeBuiltinTool(
        "projectFileRead",
        JSON.stringify({ action: "read", filePath: "sample.txt", format2: "auto" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/format2|参数|未知/);
  });
});
