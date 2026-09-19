/**
 * LINUX-PORT-01 单测：跨平台路径前缀、策略比较用规范路径、文件系统大小写能力探测，
 * 以及"策略判定与实际访问使用同一规范路径"的一致性反例。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import {
  canonicalizePathForPolicyComparison,
  classifyFileSystemCaseSensitivity,
  defaultCaseSensitivityProbeOperations,
  detectFileSystemCaseSensitivity,
  hasWindowsStyleAbsolutePathPrefix,
  isAbsoluteOnAllPlatforms,
  isCanonicalPathWithin,
  platformDefaultCaseSensitivity,
  unifyPathSeparators,
} from "../../../packages/core/src/tools/cross-platform-path-canonicalization.js";

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-linux-port-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

async function measureCaseSensitivity(
  directoryPath: string,
): Promise<"case-sensitive" | "case-insensitive"> {
  await fs.writeFile(path.join(directoryPath, "CaseProbeAa.tmp"), "", "utf8");
  try {
    await fs.stat(path.join(directoryPath, "caseprobeaa.TMP"));
    return "case-insensitive";
  } catch {
    return "case-sensitive";
  }
}

describe("跨平台路径前缀判定", () => {
  it.each([
    ["C:\\Windows\\system.ini", true],
    ["C:/Windows/system.ini", true],
    ["C:relative-notes.txt", true],
    ["\\\\server\\share\\file", true],
    ["//server/share/file", true],
    ["./C:/inside.txt", false],
    ["notes.txt", false],
    ["sub/C:file.txt", false],
    ["", false],
  ])("hasWindowsStyleAbsolutePathPrefix(%s) → %s", (requestedPath, expected) => {
    expect(hasWindowsStyleAbsolutePathPrefix(requestedPath)).toBe(expected);
  });

  it("跨平台绝对路径判定覆盖盘符、UNC 与本机绝对路径", () => {
    expect(isAbsoluteOnAllPlatforms("C:/Windows/system.ini")).toBe(true);
    expect(isAbsoluteOnAllPlatforms("\\\\server\\share\\file")).toBe(true);
    expect(isAbsoluteOnAllPlatforms(path.resolve("."))).toBe(true);
    expect(isAbsoluteOnAllPlatforms("sub/notes.txt")).toBe(false);
  });

  it("分隔符统一只影响比较语义", () => {
    expect(unifyPathSeparators("a\\b/c\\d")).toBe("a/b/c/d");
  });
});

describe("策略比较用规范路径", () => {
  it("反斜杠与 . / .. 段按词法规范化（不依赖宿主 path.resolve）", () => {
    expect(
      canonicalizePathForPolicyComparison(
        "C:\\data\\app\\backup-vault\\..\\backup-vault\\x",
        "case-sensitive",
      ),
    ).toBe("C:/data/app/backup-vault/x");
    expect(canonicalizePathForPolicyComparison("./a/./b/", "case-sensitive")).toBe("a/b");
    expect(canonicalizePathForPolicyComparison("/a/b/", "case-sensitive")).toBe("/a/b");
    expect(canonicalizePathForPolicyComparison("/", "case-sensitive")).toBe("/");
    expect(canonicalizePathForPolicyComparison("//server/share/file", "case-sensitive")).toBe(
      "//server/share/file",
    );
    expect(canonicalizePathForPolicyComparison("a/../../b", "case-sensitive")).toBe("../b");
  });

  it("大小写折叠只在明确不敏感时生效", () => {
    expect(canonicalizePathForPolicyComparison("C:\\Data\\App", "case-sensitive")).toBe(
      "C:/Data/App",
    );
    expect(canonicalizePathForPolicyComparison("C:\\Data\\App", "case-insensitive")).toBe(
      "c:/data/app",
    );
  });

  it("包含关系按段边界判定，避免前缀误判", () => {
    expect(isCanonicalPathWithin("/a/b", "/a/b")).toBe(true);
    expect(isCanonicalPathWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isCanonicalPathWithin("/a/b", "/a/bc")).toBe(false);
    expect(isCanonicalPathWithin("/a/b", "/a")).toBe(false);
    expect(isCanonicalPathWithin("C:/data/app", "c:/data/app/x")).toBe(false);
  });
});

describe("文件系统大小写能力探测", () => {
  it("按探测结果分类，不猜测平台", () => {
    expect(classifyFileSystemCaseSensitivity(true)).toBe("case-insensitive");
    expect(classifyFileSystemCaseSensitivity(false)).toBe("case-sensitive");
  });

  it("注入操作：大小写变体可解析 → case-insensitive，并清理探测目录", async () => {
    const removeProbeDirectory = vi.fn(async () => {});
    const caseSensitivity = await detectFileSystemCaseSensitivity(temporaryDirectory, {
      createProbeDirectory: async () =>
        path.join(temporaryDirectory, "astarray-CaseProbe-abc123"),
      doesCaseSwappedPathExist: async () => true,
      removeProbeDirectory,
    });
    expect(caseSensitivity).toBe("case-insensitive");
    expect(removeProbeDirectory).toHaveBeenCalledTimes(1);
  });

  it("注入操作：大小写变体不可解析 → case-sensitive", async () => {
    const removeProbeDirectory = vi.fn(async () => {});
    const caseSensitivity = await detectFileSystemCaseSensitivity(temporaryDirectory, {
      createProbeDirectory: async () =>
        path.join(temporaryDirectory, "astarray-CaseProbe-abc123"),
      doesCaseSwappedPathExist: async () => false,
      removeProbeDirectory,
    });
    expect(caseSensitivity).toBe("case-sensitive");
    expect(removeProbeDirectory).toHaveBeenCalledTimes(1);
  });

  it("探测目录创建失败 → 回退平台默认（不假设不敏感）", async () => {
    const caseSensitivity = await detectFileSystemCaseSensitivity(temporaryDirectory, {
      ...defaultCaseSensitivityProbeOperations,
      createProbeDirectory: async () => {
        throw new Error("只读文件系统");
      },
    });
    expect(caseSensitivity).toBe(platformDefaultCaseSensitivity());
    expect(platformDefaultCaseSensitivity()).toBe(
      process.platform === "win32" ? "case-insensitive" : "case-sensitive",
    );
  });

  it("探测路径判定失败 → 回退平台默认并清理探测目录", async () => {
    const removeProbeDirectory = vi.fn(async () => {});
    const caseSensitivity = await detectFileSystemCaseSensitivity(temporaryDirectory, {
      createProbeDirectory: async () =>
        path.join(temporaryDirectory, "astarray-CaseProbe-abc123"),
      doesCaseSwappedPathExist: async () => {
        throw new Error("目录不可读");
      },
      removeProbeDirectory,
    });
    expect(caseSensitivity).toBe(platformDefaultCaseSensitivity());
    expect(removeProbeDirectory).toHaveBeenCalledTimes(1);
  });

  it("真实文件系统探测结果与直接测量一致", async () => {
    const measuredCaseSensitivity = await measureCaseSensitivity(temporaryDirectory);
    await expect(detectFileSystemCaseSensitivity(temporaryDirectory)).resolves.toBe(
      measuredCaseSensitivity,
    );
  });

  it("真实探测不留残留探测目录（非破坏性清理）", async () => {
    await detectFileSystemCaseSensitivity(temporaryDirectory);
    const remainingEntries = await fs.readdir(temporaryDirectory);
    expect(
      remainingEntries.filter((entryName) => entryName.startsWith("astarray-CaseProbe-")),
    ).toEqual([]);
  });
});

describe("工作区边界拒绝跨平台绝对路径", () => {
  it.each([
    "C:/Windows/system.ini",
    "C:relative-notes.txt",
    "\\\\server\\share\\file",
    "../outside.txt",
  ])("resolveWithinWorkspace(%s) → path-escape-attempt", async (requestedPath) => {
    const boundary = new WorkspaceBoundary(workspaceDirectory);
    await expect(boundary.resolveWithinWorkspace(requestedPath)).rejects.toMatchObject({
      errorCode: "path-escape-attempt",
    });
  });

  it("工作区内规范化路径仍解析到实际文件", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "a.txt"), "内容", "utf8");
    const boundary = new WorkspaceBoundary(workspaceDirectory);
    await expect(boundary.resolveWithinWorkspace("sub/../a.txt")).resolves.toBe(
      path.join(workspaceDirectory, "a.txt"),
    );
  });
});

describe("策略判定与实际访问路径一致性", () => {
  it("公共入口用边界返回的规范路径做策略判定与实际读取", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "requested.txt"), "请求路径内容", "utf8");
    const markerPath = path.join(workspaceDirectory, "marker.txt");
    await fs.writeFile(markerPath, "边界返回内容", "utf8");
    const observedPolicyPaths: string[] = [];
    const result = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "requested.txt" }),
      {
        workspaceBoundary: {
          resolveWithinWorkspace: async () => markerPath,
        },
        temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
        requestingAgentInstanceId: "agent-consistency",
        taskExecutionId: "task-consistency",
        backupServicePort: null,
        vault: null,
        deletionController: null,
        protectedStoragePolicy: {
          assertGenericToolAccessAllowed: async (input: {
            canonicalTargetPath: string;
            operation: string;
          }) => {
            observedPolicyPaths.push(input.canonicalTargetPath);
          },
          filterProtectedEntries: (_directoryPath: string, directoryEntries: string[]) =>
            directoryEntries,
        },
      } as never,
    );
    expect(result.outputText).toBe("边界返回内容");
    expect(observedPolicyPaths).toEqual([markerPath, markerPath]);
  });
});

describe("规范路径边界值", () => {
  it("盘符根、UNC 根与相对父段保持稳定形式", () => {
    expect(canonicalizePathForPolicyComparison("C:/", "case-sensitive")).toBe("C:/");
    expect(canonicalizePathForPolicyComparison("C:", "case-sensitive")).toBe("C:");
    expect(canonicalizePathForPolicyComparison("//", "case-sensitive")).toBe("//");
    expect(canonicalizePathForPolicyComparison("../../x", "case-sensitive")).toBe("../../x");
    expect(canonicalizePathForPolicyComparison("a/b/../c", "case-sensitive")).toBe("a/c");
  });

  it("探测目录清理失败不影响探测结论", async () => {
    const caseSensitivity = await detectFileSystemCaseSensitivity(temporaryDirectory, {
      createProbeDirectory: async () =>
        path.join(temporaryDirectory, "astarray-CaseProbe-abc123"),
      doesCaseSwappedPathExist: async () => true,
      removeProbeDirectory: async () => {
        throw new Error("清理失败");
      },
    });
    expect(caseSensitivity).toBe("case-insensitive");
  });
});

describe("受保护存储策略的跨平台输入", () => {
  it("Windows 风格受保护路径在 POSIX 上同样命中保护区", async () => {
    const policy = new ProtectedStoragePolicy({
      stateDirectoryPath: "C:\\data\\app",
      fileSystemCaseSensitivity: "case-sensitive",
    });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "C:\\data\\app\\backup-vault\\data\\x",
        operation: "read",
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
  });
});
