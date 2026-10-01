/**
 * 反例（产物/验收对账，2026-10-02 用户指定第三条语义）：
 *
 * **未解决的必需操作失败或验收缺失不得结案** ——
 *  - 写类工具调用成功过 → 其目标路径必须真实存在，否则不得结案；
 *  - 完成事件显式声明 `declaredArtifacts` → 逐条核对存在性；
 *  - 模型文字里出现的路径**不得**成为产物依据（自述不是本地事实）；
 *  - 明确无写入动作的纯只读任务：不得凭空要求产物（避免误拦正常完成）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractArtifactPathFromToolCall,
  verifyArtifactExistence,
} from "../../../packages/core/src/orchestration/artifact-verification.js";

let workspaceRootPath: string;

beforeEach(async () => {
  workspaceRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-artifact-"));
});

afterEach(async () => {
  await fs.rm(workspaceRootPath, { recursive: true, force: true, maxRetries: 5 });
});

describe("产物路径提取（只认本地工具参数）", () => {
  it("写类工具：从参数中取出目标路径（filePath/path/fileName/targetPath）", () => {
    expect(
      extractArtifactPathFromToolCall({
        toolName: "createProjectFile",
        argumentsJson: JSON.stringify({ filePath: "docs/A.md", content: "x" }),
      }),
    ).toBe("docs/A.md");
    expect(
      extractArtifactPathFromToolCall({
        toolName: "replaceFileContent",
        argumentsJson: JSON.stringify({ path: "src/b.ts", content: "y" }),
      }),
    ).toBe("src/b.ts");
    expect(
      extractArtifactPathFromToolCall({
        toolName: "writeFileTemporary",
        argumentsJson: JSON.stringify({ fileName: "tmp-c.md", content: "z" }),
      }),
    ).toBe("tmp-c.md");
  });

  it("只读工具或参数不可解析 → 不产生产物要求", () => {
    expect(
      extractArtifactPathFromToolCall({
        toolName: "readFile",
        argumentsJson: JSON.stringify({ filePath: "docs/A.md" }),
      }),
    ).toBeNull();
    expect(
      extractArtifactPathFromToolCall({ toolName: "createProjectFile", argumentsJson: "{ 非法" }),
    ).toBeNull();
  });
});

describe("产物存在性对账", () => {
  it("① 产物存在 → 通过", async () => {
    await fs.mkdir(path.join(workspaceRootPath, "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRootPath, "docs", "A.md"), "# A\n", "utf8");
    const evidence = verifyArtifactExistence({
      artifactPaths: ["docs/A.md"],
      workspaceRootPath,
    });
    expect(evidence).toEqual([{ gateName: "产物存在性: docs/A.md", passed: true }]);
  });

  it("② 产物缺失 → 未通过（验收缺失不得结案）", () => {
    const evidence = verifyArtifactExistence({
      artifactPaths: ["docs/MISSING.md"],
      workspaceRootPath,
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.passed).toBe(false);
  });

  it("③ 目录不算产物（必须是文件）", async () => {
    await fs.mkdir(path.join(workspaceRootPath, "docs"), { recursive: true });
    const evidence = verifyArtifactExistence({
      artifactPaths: ["docs"],
      workspaceRootPath,
    });
    expect(evidence[0]?.passed).toBe(false);
  });

  it("④ 拒绝工作区外路径（绝对路径与向上越界），且不因越界而放行", () => {
    const evidence = verifyArtifactExistence({
      artifactPaths: ["../outside.md", "C:\\Windows\\system.ini", "/etc/passwd"],
      workspaceRootPath,
    });
    expect(evidence).toHaveLength(3);
    expect(evidence.every((entry) => entry.passed === false)).toBe(true);
  });

  it("⑤ 重复路径去重（同一次对账只出一条证据）", () => {
    const evidence = verifyArtifactExistence({
      artifactPaths: ["docs/A.md", "docs/A.md"],
      workspaceRootPath,
    });
    expect(evidence).toHaveLength(1);
  });
});
