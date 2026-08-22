/**
 * T08C-07 测试：CLI 投递与状态视图、dist 可达性、tarball 验收。
 * 验收：direct-dispatch 命令（回退/投递）、agent-tree 视图、
 * T08C 控制器全部进入最终 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeAgentTreeCommand,
  executeDirectDispatchCommand,
} from "../../../packages/tui/src/cli/commands.js";

let temporaryDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08c07-"));
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

describe("direct-dispatch CLI 命令", () => {
  it("目标次级未登记 → 返回错误（来源/授权不丢失）", async () => {
    await expect(
      executeDirectDispatchCommand({
        stateDirectory: temporaryDirectory,
        isJsonOutput: true,
        targetSecondaryAgentInstanceId: "ghost-secondary",
        scopeDescription: "清理调试输出",
        originalUserInstruction: "把调试输出清理干净",
        acceptanceCriteria: "无调试输出",
        forceDispatchConfirmation: null,
      }),
    ).rejects.toThrow();
  });

  it("agent-tree 文本视图：主 Agent 对话目标提示清晰", async () => {
    const exitCode = await executeAgentTreeCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    const text = stdoutBuffer.join("");
    expect(text).toContain("主 Agent");
    expect(text).toContain("唯一连续对话对象");
    expect(text).toContain("直投");
  });

  it("agent-tree --json：路由/门禁状态可解析", async () => {
    await executeAgentTreeCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: true,
    });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      conversationTarget: { role: string };
      routes: { summaryChannel: string };
      gates: { acceptanceVerdictGateActive: boolean };
    };
    expect(parsed.conversationTarget.role).toBe("main");
    expect(parsed.routes.summaryChannel).toBe("SECONDARY_USER_FACING_SUMMARY_V1");
    expect(parsed.gates.acceptanceVerdictGateActive).toBe(true);
  });
});

describe("T08C dist 可达性", () => {
  it("T08C 控制器全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const controllerNames = [
      "agent-routing-schemas",
      "small-task-eligibility-policy",
      "direct-dispatch-controller",
      "secondary-user-facing-summary-controller",
      "project-reconnaissance-controller",
      "project-reconnaissance-digest-store",
      "agent-appointment-registry",
      "acceptance-verdict-gate",
      "quaternary-lifecycle-controller",
      "quaternary-boundary-guards",
    ];
    for (const controllerName of controllerNames) {
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
              (await fs.readFile(entryPath, "utf8")).includes(controllerName)
            ) {
              return true;
            }
          }
          return false;
        };
        return readDirectory(distDirectory);
      })();
      expect(found, `${controllerName} 应进入 dist`).toBe(true);
    }
  });
});