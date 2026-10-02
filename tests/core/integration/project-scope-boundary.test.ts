/**
 * 行为反例（PROJECT-01-02，2026-10-02）：
 *
 * 验收要求（卡内 §8）：项目外读写、**链接逃逸**、**重叠根**、伪造主 Agent 批准、
 * 超委托/过期/deny 等反例；且"命令与子进程缺隔离时明确不支持，不只检查 readFile"。
 *
 * 本文件覆盖可确定性地验证的三类边界（重叠根 / 链接逃逸 / 项目外读写），
 * 并固化"自述范围不参与判定"。
 */
import { promises as fs, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveOperationScope,
} from "../../../packages/core/src/tools/scope-resolution.js";
import type { RegisteredProjectRoot } from "../../../packages/core/src/tools/scope-resolution.js";

let workspaceRootPath: string;
let secondRootPath: string;
let outsideRootPath: string;

beforeEach(async () => {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project01-"));
  workspaceRootPath = path.join(basePath, "project-a");
  secondRootPath = path.join(basePath, "project-b");
  outsideRootPath = path.join(basePath, "outside");
  await fs.mkdir(path.join(workspaceRootPath, "sub"), { recursive: true });
  await fs.mkdir(secondRootPath, { recursive: true });
  await fs.mkdir(outsideRootPath, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(path.dirname(workspaceRootPath), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function roots(...registeredRoots: Array<[string, string]>): RegisteredProjectRoot[] {
  return registeredRoots.map(([projectIdentifier, rootPath]) => ({
    projectIdentifier,
    rootPath,
    registeredAtIso: "2026-10-02T00:00:00.000Z",
  }));
}

describe("PROJECT-01-02：范围边界反例", () => {
  it("① 项目内写 → S1-project-internal（基线，不得误报）", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        targetPath: path.join(workspaceRootPath, "sub", "A.md"),
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(resolution.scopeClass).toBe("S1-project-internal");
    expect(resolution.projectIdentifier).toBe("project-a");
  });

  it("② 项目外写 → 不得判为项目内（S3 或 S4）", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        targetPath: path.join(outsideRootPath, "A.md"),
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(["S3-project-external", "S4-unknown"]).toContain(resolution.scopeClass);
    expect(resolution.projectIdentifier).not.toBe("project-a");
  });

  it("③ 链接逃逸：根内链接指向项目外 → 真实路径判定必须归项目外", async () => {
    const linkPath = path.join(workspaceRootPath, "escape-link");
    try {
      symlinkSync(outsideRootPath, linkPath, "junction");
    } catch {
      // 无权限创建链接（含开发者模式未开启）：改用相对路径逃逸用例 ③b 覆盖，
      // 此处不得伪造"已通过"。
      return;
    }
    // 先确认链接确实指向根外（否则本用例无判定力）。
    const resolvedLinkPath = await fs.realpath(linkPath);
    expect(resolvedLinkPath).not.toBe(linkPath);
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        // 字面路径在根内，但真实路径在项目外。
        targetPath: path.join(linkPath, "A.md"),
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(resolution.scopeClass).not.toBe("S1-project-internal");
    expect(["S3-project-external", "S4-unknown"]).toContain(resolution.scopeClass);
  });

  it("③b 相对路径逃逸（.. 穿越）→ 必须归项目外且不得被判为项目内", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        targetPath: path.join(workspaceRootPath, "..", "outside", "A.md"),
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(resolution.scopeClass).not.toBe("S1-project-internal");
    expect(["S3-project-external", "S4-unknown"]).toContain(resolution.scopeClass);
  });

  it("④ 重叠根：同一目标命中两个登记根 → S2 跨项目根（不静默选边）", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-read",
        targetPath: path.join(workspaceRootPath, "sub", "A.md"),
      },
      // 第二个根是第一个根的父目录 → 目标同时落在两个根内。
      registeredProjectRoots: roots(
        ["project-a", workspaceRootPath],
        ["project-parent", path.dirname(workspaceRootPath)],
      ),
    });
    expect(resolution.scopeClass).toBe("S2-cross-project-root");
  });

  it("⑤ 模型自述范围不参与判定（claimedScopeDescription 仅记录）", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        targetPath: path.join(outsideRootPath, "A.md"),
        // 模型声称"这是项目内文件"——必须被忽略。
        claimedScopeDescription: "项目内文件（模型自述）",
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(resolution.scopeClass).not.toBe("S1-project-internal");
    expect(resolution.reasons.join("；")).toContain("自述范围不参与判定");
  });

  it("⑥ 动态/通配目标路径 → S4 未知（不得猜测为项目内）", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        targetPath: path.join(workspaceRootPath, "*.md"),
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(resolution.scopeClass).toBe("S4-unknown");
  });

  it("⑦ 跨根显式声明（touchesAdditionalProjectRoots）→ S2，不得按单根放行", async () => {
    const resolution = await resolveOperationScope({
      operation: {
        operationKind: "project-file-write",
        targetPath: path.join(workspaceRootPath, "sub", "A.md"),
        touchesAdditionalProjectRoots: true,
      },
      registeredProjectRoots: roots(["project-a", workspaceRootPath]),
    });
    expect(resolution.scopeClass).toBe("S2-cross-project-root");
  });
});
