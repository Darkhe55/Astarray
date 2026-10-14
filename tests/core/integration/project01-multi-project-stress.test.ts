/**
 * PROJECT-01-04 多项目压力验收（2026-11-03）：**经公开 SDK 入口**、
 * 用**受控端口**（默认装配）在 A/B/C 三项目上跑交叉借阅。
 *
 * ## 与既有 `cross-project-isolation-multi-project.test.ts` 的区别
 *
 * 那个文件直接驱动 **store** 并注入**裸 `fs`** 端口 ⇒ 证明的是"存储层不串"，且
 * `receivingAgentInstanceId`（多同级个体回执）只在 store 层可用。
 * 本文件走**公开入口** + **默认装配的受控端口**，因此额外覆盖"入口接线是否真的可用"。
 * 两者互补：**个体维度**由 store 层那套负责，本文件负责**入口 + 交叉不串**。
 *
 * ## 压力规模（本地确定性，无网络）
 *
 * 3 个来源项目 × 3 个目标项目 = 6 条有向授权；12 次操作**并发**发出。
 *
 * ## 一处刻意的设计（源自一次真实的自测教训）
 *
 * 每个方向写**各自的**目标文件名（`docs/spec-copy-from-<source>.md`）。
 * 若所有方向共用同一目标路径，那是**同一目标**被多方写入 —— 后写覆盖先写是**正确**行为，
 * 拿它当"串数据"来断言是**测试设计错误**（本文件首版正是如此，实测被自己的断言打回）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;
let workspaceRoot: string;
let stateDirectory: string;

const PROJECTS = ["project-a", "project-b", "project-c"] as const;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-stress-"));
  workspaceRoot = baseDirectory;
  // 状态目录落在**第一个项目根内**的 .astarray（真实产品布局；见 PROJECT-01-03 边界记录）
  stateDirectory = path.join(baseDirectory, "project-a", ".astarray");
  for (const project of PROJECTS) {
    await fs.mkdir(path.join(baseDirectory, project), { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function projectRootOf(projectIdentifier: string): string {
  return path.join(baseDirectory, projectIdentifier);
}

async function writeSource(projectIdentifier: string, content: string): Promise<string> {
  const absolutePath = path.join(projectRootOf(projectIdentifier), "docs", "spec.md");
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

async function createApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    workspaceRootPath: workspaceRoot,
    mode: "assist",
    runtime: "mock",
    concurrency: 4,
    failureThreshold: 3,
  } as never);
}

function authorizationIdentifier(source: string, target: string): string {
  return `auth-${source}-to-${target}`;
}

function argumentsHashOf(source: string, target: string): string {
  return "hash-" + source + "-" + target;
}

/** 每个方向写**各自的**目标文件，避免"同一目标被多方写"这种非隔离场景。 */
function targetRelativePathFor(source: string): string {
  return `docs/spec-copy-from-${source}.md`;
}

describe("PROJECT-01-04：多项目交叉借阅压力验收（公开入口 + 受控端口）", () => {
  it("① 6 条有向授权并发导入 ⇒ 各自落到各自目标、内容不串、来源零写入", async () => {
    const application = await createApplication();
    try {
      const sourceContents = new Map<string, string>();
      for (const source of PROJECTS) {
        const content = `# ${source} 的来源内容\n`;
        sourceContents.set(source, content);
        await writeSource(source, content);
      }

      const directions: Array<{ source: string; target: string }> = [];
      for (const source of PROJECTS) {
        for (const target of PROJECTS) {
          if (source === target) {
            continue;
          }
          directions.push({ source, target });
          await application.grantCrossProjectAuthorizationForAcceptance({
            authorizationIdentifier: authorizationIdentifier(source, target),
            sourceProjectIdentifier: source,
            sourceProjectRevision: 3,
            targetProjectIdentifier: target,
            operationKind: "import-copy",
            resourcePathPrefixes: ["docs/"],
            argumentsHash: argumentsHashOf(source, target),
          });
        }
      }
      expect(directions).toHaveLength(6);

      const imports = await Promise.all(
        directions.map(async ({ source, target }) => {
          const result = await application.importCrossProjectResource({
            authorizationIdentifier: authorizationIdentifier(source, target),
            sourceProjectIdentifier: source,
            targetProjectIdentifier: target,
            sourceResourcePath: "docs/spec.md",
            targetResourcePath: targetRelativePathFor(source),
            absoluteSourcePath: path.join(projectRootOf(source), "docs", "spec.md"),
            sourceProjectRootPath: projectRootOf(source),
            absoluteTargetPath: path.join(
              projectRootOf(target),
              targetRelativePathFor(source),
            ),
            targetProjectRootPath: projectRootOf(target),
            sourceRevision: 3,
            argumentsHash: argumentsHashOf(source, target),
            nowIso: "2026-11-03T00:00:00.000Z",
          });
          return { source, target, result };
        }),
      );

      for (const { source, target, result } of imports) {
        expect(result.outcome, `${source}→${target}: ${String(result.detail)}`).toBe(
          "imported-copy",
        );
        expect(result.didWriteTarget, `${source}→${target}`).toBe(true);
      }

      // **不串数据**：每个目标文件内容必须等于**其来源**的内容
      for (const { source, target } of directions) {
        const written = await fs.readFile(
          path.join(projectRootOf(target), targetRelativePathFor(source)),
          "utf8",
        );
        expect(written, `${source}→${target} 内容必须来自 ${source}`).toBe(
          sourceContents.get(source),
        );
      }

      // **来源零写入**：三份来源文件原样未动
      for (const source of PROJECTS) {
        const current = await fs.readFile(
          path.join(projectRootOf(source), "docs", "spec.md"),
          "utf8",
        );
        expect(current, `${source} 来源不得被修改`).toBe(sourceContents.get(source));
      }
    } finally {
      await application.shutdown();
    }
  });

  it("② 授权列表可逐条追溯来源/目标/种类（6 条不相混）", async () => {
    const application = await createApplication();
    try {
      for (const source of PROJECTS) {
        await writeSource(source, `# ${source}\n`);
      }
      for (const source of PROJECTS) {
        for (const target of PROJECTS) {
          if (source === target) {
            continue;
          }
          await application.grantCrossProjectAuthorizationForAcceptance({
            authorizationIdentifier: authorizationIdentifier(source, target),
            sourceProjectIdentifier: source,
            sourceProjectRevision: 3,
            targetProjectIdentifier: target,
            operationKind: "read",
            resourcePathPrefixes: ["docs/"],
            argumentsHash: argumentsHashOf(source, target),
          });
        }
      }

      // 注意：本方法**直接返回数组**（不是 { authorizations: [...] }）
      const listed = await application.listCrossProjectAuthorizations();
      expect(listed).toHaveLength(6);

      for (const { source, target } of [
        { source: "project-a", target: "project-b" },
        { source: "project-b", target: "project-c" },
        { source: "project-c", target: "project-a" },
      ]) {
        const entry = listed.find(
          (item) => item.authorizationIdentifier === authorizationIdentifier(source, target),
        );
        // **可追溯**：每条授权都能读出自己那一对来源/目标，不与别的条目相混
        expect(entry, `${source}→${target} 必须可查`).toBeDefined();
        expect(entry?.sourceProjectIdentifier).toBe(source);
        expect(entry?.targetProjectIdentifier).toBe(target);
        expect(entry?.operationKind).toBe("read");
      }
    } finally {
      await application.shutdown();
    }
  });

  it("③ 规则外不放行：未授权的方向（C→A）必须被拒，且不触达文件", async () => {
    const application = await createApplication();
    try {
      const content = "# project-c 来源内容\n";
      await writeSource("project-c", content);

      // 只授权 A→B，**不授权** C→A
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-project-a-to-project-b",
        sourceProjectIdentifier: "project-a",
        sourceProjectRevision: 3,
        targetProjectIdentifier: "project-b",
        operationKind: "import-copy",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: argumentsHashOf("project-a", "project-b"),
      });

      const result = await application.importCrossProjectResource({
        authorizationIdentifier: "auth-project-c-to-project-a",
        sourceProjectIdentifier: "project-c",
        targetProjectIdentifier: "project-a",
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "docs/spec-copy.md",
        absoluteSourcePath: path.join(projectRootOf("project-c"), "docs", "spec.md"),
        sourceProjectRootPath: projectRootOf("project-c"),
        absoluteTargetPath: path.join(projectRootOf("project-a"), "docs", "spec-copy.md"),
        targetProjectRootPath: projectRootOf("project-a"),
        sourceRevision: 3,
        argumentsHash: argumentsHashOf("project-c", "project-a"),
        nowIso: "2026-11-03T00:00:00.000Z",
      });

      expect(result.outcome).not.toBe("imported-copy");
      // **不触达**：目标文件不得被创建
      await expect(
        fs.access(path.join(projectRootOf("project-a"), "docs", "spec-copy.md")),
      ).rejects.toThrow();
      // 来源也未被改动
      expect(
        await fs.readFile(path.join(projectRootOf("project-c"), "docs", "spec.md"), "utf8"),
      ).toBe(content);
    } finally {
      await application.shutdown();
    }
  });
});
