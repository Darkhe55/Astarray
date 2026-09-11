/**
 * T12A-06 / T12A-R1-01 测试：CLI 恢复中心。
 * 验收：list 只读脱敏并反映磁盘状态；resume 按可信检查点判定（无可信检查点或
 * 状态损坏 → 需裁决项 blocked 且非交互返回失败退出码）；abandon 保留存档；
 * 恢复模块全部进入 bundle。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeRecoverAbandonCommand,
  executeRecoverListCommand,
  executeRecoverResumeCommand,
  executeRecoverShowCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stdoutBuffer: string[];
let stateDirectory: string;

beforeEach(async () => {
  stdoutBuffer = [];
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12a06-"));
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  afterEach(() => {
    process.stdout.write = originalWrite;
  });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true });
});

describe("recover list 命令", () => {
  it("只读列出恢复中心状态（脱敏；无内部细节）", async () => {
    const exitCode = await executeRecoverListCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      recoveryCenterReady: boolean;
      missions: unknown[];
      note: string;
    };
    expect(parsed.recoveryCenterReady).toBe(true);
    expect(parsed.missions).toEqual([]);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("apiKey");
  });

  it("文本模式输出恢复中心摘要（覆盖文本分支）", async () => {
    const exitCode = await executeRecoverListCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    const text = stdoutBuffer.join("");
    expect(text).toContain("恢复中心:");
    expect(text).toContain("可恢复 mission:");
    expect(text).toContain("需裁决 mission:");
  });
});

describe("recover show 命令", () => {
  it("mission 不存在 → 失败退出码且明确 exists=false", async () => {
    const exitCode = await executeRecoverShowCommand({
      stateDirectory,
      missionIdentifier: "mission-missing",
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as { exists: boolean };
    expect(parsed.exists).toBe(false);
  });

  it("文本模式输出 mission 不存在（覆盖文本分支）", async () => {
    const exitCode = await executeRecoverShowCommand({
      stateDirectory,
      missionIdentifier: "mission-missing",
      isJsonOutput: false,
    });
    expect(exitCode).not.toBe(0);
    expect(stdoutBuffer.join("")).toContain("不存在");
  });
});

describe("recover resume 命令", () => {
  it("无可信检查点 → 需裁决项 blocked，非交互返回失败退出码（不默认允许）", async () => {
    const exitCode = await executeRecoverResumeCommand({
      stateDirectory,
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
      "checkpoint-not-found",
    );
  });

  it("文本模式输出需裁决说明（覆盖文本分支）", async () => {
    const exitCode = await executeRecoverResumeCommand({
      stateDirectory,
      isJsonOutput: false,
      missionIdentifier: "mission-1",
    });
    expect(exitCode).not.toBe(0);
    const text = stdoutBuffer.join("");
    expect(text).toContain("未恢复");
    expect(text).toContain("需裁决");
  });
});

describe("recover abandon 命令", () => {
  it("关闭调度并保留存档（不删除数据）", async () => {
    const exitCode = await executeRecoverAbandonCommand({
      stateDirectory,
      isJsonOutput: true,
      missionIdentifier: "mission-1",
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      schedulingClosed: boolean;
      dataPreserved: boolean;
      artifactsRetained: boolean;
      abandoned: boolean;
    };
    expect(parsed.schedulingClosed).toBe(true);
    expect(parsed.dataPreserved).toBe(true);
    expect(parsed.artifactsRetained).toBe(true);
    expect(parsed.abandoned).toBe(true);
  });

  it("文本模式输出调度已关闭（覆盖文本分支）", async () => {
    const exitCode = await executeRecoverAbandonCommand({
      stateDirectory,
      isJsonOutput: false,
      missionIdentifier: "mission-1",
    });
    expect(exitCode).toBe(0);
    expect(stdoutBuffer.join("")).toContain("调度已关闭");
  });
});

describe("T12A dist 可达性", () => {
  it("恢复模块全部进入最终 bundle（tarball 验收前置）", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    // T12A-R1-02（副作用与权限对账）接线后把 readonly-reconciliation-service
    // 加回本清单；-01 只要求恢复中心真实使用的模块可达。
    const moduleNames = [
      "recovery-checkpoint-schemas",
      "recovery-checkpoint-store",
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
