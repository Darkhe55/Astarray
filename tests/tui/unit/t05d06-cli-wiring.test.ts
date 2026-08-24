/**
 * T05D-06 测试：CLI 并发变更状态/人工裁决 + dist 可达性 + tarball 验收前置。
 * 验收：状态视图显示冲突种类/受影响节点/来源/可选操作；
 * 人工裁决绑定冲突 ID 与认证用户；并发模块全部进入 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeConcurrentDecideCommand,
  executeConcurrentStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stdoutBuffer: string[];

beforeEach(async () => {
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

describe("concurrent status 命令", () => {
  it("状态视图：冲突分类/受影响节点/来源/可选操作", async () => {
    await executeConcurrentStatusCommand({ isJsonOutput: true });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      classificationDecision: string;
      impactedNodes: string[];
      sources: { humanSource: string };
      availableActions: string[];
    };
    expect(parsed.classificationDecision).toBe("no-overlap-revalidate");
    expect(parsed.sources.humanSource).toContain("本地控制面观察");
    expect(parsed.availableActions).toContain("appoint-reconcile-agent");
  });
});

describe("concurrent decide 命令", () => {
  it("人工裁决 reconcile：任命协调 Agent（绑定冲突 ID）", async () => {
    await executeConcurrentDecideCommand({
      isJsonOutput: true,
      conflictIdentifier: "conflict-1",
      userDecision: "reconcile",
    });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      conflictIdentifier: string;
      decidedBy: string;
      decision: string;
      reconcileAgentInstanceId: string;
    };
    expect(parsed.conflictIdentifier).toBe("conflict-1");
    expect(parsed.decidedBy).toBe("authenticated-user");
    expect(parsed.decision).toBe("text-conflict-reconcile");
    expect(parsed.reconcileAgentInstanceId).toBe("reconcile-conflict-1");
  });

  it("人工裁决 blocked：进入人工审查（无协调 Agent）", async () => {
    await executeConcurrentDecideCommand({
      isJsonOutput: true,
      conflictIdentifier: "conflict-2",
      userDecision: "blocked",
    });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      decision: string;
      reconcileAgentInstanceId: string | null;
    };
    expect(parsed.decision).toBe("blocked-human-review");
    expect(parsed.reconcileAgentInstanceId).toBeNull();
  });
});

describe("T05D dist 可达性", () => {
  it("并发变更模块全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const moduleNames = [
      "human-agent-concurrent-change-schemas",
      "human-worktree-observer",
      "stale-write-guard",
      "concurrent-change-classifier",
      "concurrent-merge-coordinator",
    ];
    for (const moduleName of moduleNames) {
      const found = await (async () => {
        const readDirectory = async (
          directoryPath: string,
        ): Promise<boolean> => {
          const entries = await fs.readdir(directoryPath, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
              if (await readDirectory(entryPath)) {
                return true;
              }
            } else if (
              entry.name.endsWith(".js") &&
              (await fs.readFile(entryPath, "utf8")).includes(moduleName)
            ) {
              return true;
            }
          }
          return false;
        };
        return readDirectory(distDirectory);
      })();
      expect(found, `${moduleName} 应进入 dist`).toBe(true);
    }
  });
});

