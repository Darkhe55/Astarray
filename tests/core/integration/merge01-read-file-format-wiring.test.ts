/**
 * MERGE-01-02 反例（2026-10-10）：读取视图参数必须**真的影响行为或被拒绝**。
 *
 * 本轮实测发现的诚实性问题：`ReadFormatStrategyRegistry.resolve()` 只按
 * `fileName/extension/contentSample` 选策略，**不读 `format`**；
 * `buildReadView()` 也只接受 `shouldIncludeComments`/`shouldIncludeImports`，
 * **无法产出 summary/outline**。因此若工具"接受" `format: "code"` 或 `view: "summary"`，
 * 那就是**静默无效参数**——调用方会以为视图语义生效了，实际逐字节返回原文。
 *
 * 卡内 §1.2 纪律："不认识的 action/参数拒绝"、"工具描述符按 action 和参数判定副作用"，
 * 且本仓一贯要求"不静默声称成功"。
 *
 * 期望语义（本轮钉住）：
 *  - `readFile` 接受 **确有实现** 的 `format` 取值（`auto` = 按扩展名选策略的既有行为；
 *    `text` = 强制原文视图）；
 *  - **尚无实现**的取值（如 `code`/`markup`/`data`）与 `view`（summary/outline）
 *    ⇒ 必须**拒绝并给出明确原因**，不得静默忽略；
 *  - 拒绝发生在**读取之前**（不产生无谓 I/O、不登记读取抑制），且不留部分副作用。
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

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge01-read-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDirectory, "sample.ts"),
    "// 注释\nimport x from 'y';\nexport const value = 1;\n",
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
  };
}

describe("MERGE-01：readFile 的 format 必须真的影响行为或被拒绝", () => {
  it("① format 缺省与 format=auto 行为一致：按扩展名解析策略（既有行为不变）", async () => {
    const withoutFormat = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "sample.ts" }),
      executionContext(),
    );
    const withAuto = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "sample.ts", format: "auto" }),
      executionContext(),
    );
    expect(withAuto.outputText).toBe(withoutFormat.outputText);
  });

  it("② format=text 必须**真的**返回原文视图（不含视图过滤回执行）", async () => {
    const result = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "sample.ts", format: "text" }),
      executionContext(),
    );
    // 强制原文视图：逐字节等于源文件内容，且不得出现"已过滤"回执行
    expect(result.outputText).toBe(
      await fs.readFile(path.join(workspaceDirectory, "sample.ts"), "utf8"),
    );
    expect(result.outputText).not.toContain("[astarray-read-view");
  });

  it("③ 尚未实现的 format 取值（code/markup/data）必须被拒绝，不得静默忽略", async () => {
    for (const format of ["code", "markup", "data"]) {
      await expect(
        executeBuiltinTool(
          "readFile",
          JSON.stringify({ filePath: "sample.ts", format }),
          executionContext(),
        ),
        "format=" + format + " 应被拒绝（当前无实现，接受即为静默无效参数）",
      ).rejects.toThrowError(/format/);
    }
  });

  it("④ 尚无实现的 view（summary/outline）必须被拒绝，不得静默忽略", async () => {
    for (const view of ["summary", "outline"]) {
      await expect(
        executeBuiltinTool(
          "readFile",
          JSON.stringify({ filePath: "sample.ts", view }),
          executionContext(),
        ),
        "view=" + view + " 应被拒绝（当前无实现）",
      ).rejects.toThrowError(/view/);
    }
  });

  it("⑤ 拒绝必须发生在读取之前（文件不存在时也报参数错误，而不是读取错误）", async () => {
    // 参数非法与文件不存在同时成立：应报参数错误（说明未触达 I/O）
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "does-not-exist.ts", format: "code" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/format/);
  });
});
