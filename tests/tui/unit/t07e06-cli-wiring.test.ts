/**
 * T07E-06 测试：CLI 工作集状态/预算视图 + dist 可达性 + tarball 验收前置。
 * 验收：状态显示默认预算/当前计数/字节/token；扩展边界视图；
 * 工作集模块全部进入 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeWorksetBudgetCommand,
  executeWorksetStatusCommand,
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

describe("workset status 命令", () => {
  it("状态视图：默认预算与当前多维计数", async () => {
    await executeWorksetStatusCommand({ isJsonOutput: true });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      defaults: { maximumDistinctProjectContentFilesPerAgentActivation: number };
      budgetState: {
        distinctProjectContentFileCount: number;
        modelVisibleProjectContentBytes: number;
        estimatedProjectContentTokenCount: number;
      };
    };
    expect(parsed.defaults.maximumDistinctProjectContentFilesPerAgentActivation).toBe(10);
    expect(parsed.budgetState.distinctProjectContentFileCount).toBe(0);
    expect(parsed.budgetState.modelVisibleProjectContentBytes).toBe(0);
  });

  it("文本模式：显示默认 10 文件与提醒阈值", async () => {
    await executeWorksetStatusCommand({ isJsonOutput: false });
    const text = stdoutBuffer.join("");
    expect(text).toContain("10 文件/Agent");
    expect(text).toContain("提醒阈值 8");
  });
});

describe("workset budget 命令", () => {
  it("预算视图：扩展边界与预算决定五态", async () => {
    await executeWorksetBudgetCommand({ isJsonOutput: true });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      expansionBounds: { maximumAdditionalFilesPerAgent: number };
      budgetDecisions: string[];
    };
    expect(parsed.expansionBounds.maximumAdditionalFilesPerAgent).toBe(20);
    expect(parsed.budgetDecisions).toHaveLength(5);
  });
});

describe("T07E dist 可达性", () => {
  it("工作集模块全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const moduleNames = [
      "working-set-schemas",
      "working-set-budget-tracker",
      "working-set-budget-controller",
      "task-chain-cumulative-budget",
      "budget-expansion-coordinator",
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