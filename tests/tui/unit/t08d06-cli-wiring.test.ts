/**
 * T08D-06 测试：CLI 工匠状态/手动披露 + dist 可达性 + tarball 验收前置。
 * 验收：三入口一致（CLI 提供状态与手动披露）；手动披露不创建 Agent；
 * 工匠模块全部进入最终 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeCraftsmanDiscloseCommand,
  executeCraftsmanStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let temporaryDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08d06-"));
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

describe("craftsman 状态命令", () => {
  it("craftsman status 文本：列出内置三模板", async () => {
    const exitCode = await executeCraftsmanStatusCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    const text = stdoutBuffer.join("");
    expect(text).toContain("较早");
    expect(text).toContain("均衡");
    expect(text).toContain("保守");
  });

  it("craftsman status --json：模板结构与规则数可解析", async () => {
    await executeCraftsmanStatusCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: true,
    });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      profiles: Array<{ profileId: string; combinationMode: string; rules: unknown[] }>;
    };
    expect(parsed.profiles).toHaveLength(3);
    expect(parsed.profiles[1]?.profileId).toBe("craftsman-stage-balanced");
    expect(parsed.profiles[1]?.rules.length).toBeGreaterThan(0);
  });
});

describe("craftsman 手动披露命令", () => {
  it("手动披露：向目标次级发送事件（不创建 Agent）", async () => {
    const exitCode = await executeCraftsmanDiscloseCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: true,
      targetSecondaryAgentInstanceId: "secondary-1",
      stageProfileId: "craftsman-stage-balanced",
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      outcome: { outcome: string };
      sentEventCount: number;
    };
    expect(parsed.outcome.outcome).toBe("disclosed");
    expect(parsed.sentEventCount).toBe(1);
  });

  it("手动披露幂等：同一次级重复披露（同分钟窗）去重", async () => {
    await executeCraftsmanDiscloseCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: true,
      targetSecondaryAgentInstanceId: "secondary-1",
      stageProfileId: "craftsman-stage-balanced",
    });
    stdoutBuffer.length = 0;
    await executeCraftsmanDiscloseCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: true,
      targetSecondaryAgentInstanceId: "secondary-1",
      stageProfileId: "craftsman-stage-balanced",
    });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      outcome: { outcome: string };
      sentEventCount: number;
    };
    // 持久化幂等键（同分钟窗）→ 第二次不再发送事件
    expect(parsed.sentEventCount).toBe(0);
  });
});

describe("T08D dist 可达性", () => {
  it("工匠模块全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const moduleNames = [
      "craftsman-schemas",
      "craftsman-stage-controller",
      "craftsman-disclosure-store",
      "craftsman-disclosure-controller",
      "craftsman-disclosure-action-executor",
      "craftsman-workflow-lifecycle-controller",
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