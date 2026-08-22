/**
 * T07C-06 测试：CLI 模型目录/解析/预设 + dist 可达性 + tarball 验收前置。
 * 验收：公开 DTO 无凭据；解析确定性/fail-closed；预设数量不限；模型模块进 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeModelCatalogCommand,
  executeModelResolveCommand,
  executePresetListCommand,
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

describe("model catalog 命令", () => {
  it("登记演示条目并列出公开 DTO（无凭据引用/密钥）", async () => {
    const exitCode = await executeModelCatalogCommand({
      isJsonOutput: true,
      seedDemoEntries: true,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.entries.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("protectedCredentialReferenceId");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("cred-ref");
  });

  it("文本模式：列出模型 ID 与健康状态", async () => {
    await executeModelCatalogCommand({
      isJsonOutput: false,
      seedDemoEntries: true,
    });
    const text = stdoutBuffer.join("");
    expect(text).toContain("openai/gpt-4o");
    expect(text).toContain("healthy");
  });
});

describe("model resolve 命令", () => {
  it("六级解析确定性：ordered-fallback 选首个健康模型", async () => {
    await executeModelCatalogCommand({
      isJsonOutput: true,
      seedDemoEntries: true,
    });
    stdoutBuffer.length = 0;
    await executeModelResolveCommand({ isJsonOutput: true });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      outcome: string;
      selectedModelProfileId: string | null;
    };
    expect(parsed.outcome).toBe("selected");
    expect(parsed.selectedModelProfileId).toBe("openai/gpt-4o");
  });
});

describe("preset list 命令", () => {
  it("列出 9 类内置预设（JSON 含总数）", async () => {
    await executePresetListCommand({ isJsonOutput: true });
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      presets: Array<{ presetId: string }>;
      totalCount: number;
    };
    expect(parsed.totalCount).toBe(9);
    expect(parsed.presets.some((preset) => preset.presetId === "preset:drawing-visual")).toBe(
      true,
    );
  });

  it("文本模式：含工匠预设行", async () => {
    await executePresetListCommand({ isJsonOutput: false });
    expect(stdoutBuffer.join("")).toContain("preset:craftsman-workflow");
  });
});

describe("T07C dist 可达性", () => {
  it("模型模块全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const moduleNames = [
      "model-provider-catalog",
      "model-selection-policy-resolver",
      "agent-model-assignment-controller",
      "bounded-provider-fallback-guard",
      "task-agent-preset-controller",
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