/**
 * T12A-06 测试：CLI 恢复中心。
 * 验收：list 只读脱敏；resume 无"全部越过"（需裁决项 blocked 且非交互
 * 返回失败退出码）；abandon 保留存档；恢复模块全部进入 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeRecoverAbandonCommand,
  executeRecoverListCommand,
  executeRecoverResumeCommand,
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

describe("recover list 命令", () => {
  it("只读列出恢复中心状态（脱敏；无内部细节）", async () => {
    const exitCode = await executeRecoverListCommand({ isJsonOutput: true });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      recoveryCenterReady: boolean;
      note: string;
    };
    expect(parsed.recoveryCenterReady).toBe(true);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("apiKey");
  });
});

describe("recover resume 命令", () => {
  it("无可信检查点 → 需裁决项 blocked，非交互返回失败退出码（不默认允许）", async () => {
    const exitCode = await executeRecoverResumeCommand({
      isJsonOutput: true,
      missionIdentifier: "mission-1",
    });
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      blockedDecisionItems: Array<{ decision: string }>;
      requiresUserDecision: boolean;
    };
    expect(parsed.requiresUserDecision).toBe(true);
    expect(parsed.blockedDecisionItems[0]?.decision).toBe(
      "blocked-uncertain-side-effect",
    );
  });
});

describe("recover abandon 命令", () => {
  it("关闭调度并保留存档（不删除数据）", async () => {
    const exitCode = await executeRecoverAbandonCommand({
      isJsonOutput: true,
      missionIdentifier: "mission-1",
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      schedulingClosed: boolean;
      dataPreserved: boolean;
    };
    expect(parsed.schedulingClosed).toBe(true);
    expect(parsed.dataPreserved).toBe(true);
  });
});

describe("T12A dist 可达性", () => {
  it("恢复模块全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const moduleNames = [
      "recovery-checkpoint-schemas",
      "recovery-checkpoint-store",
      "readonly-reconciliation-service",
      "recovery-classification-service",
      "recovery-identity-budget-service",
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