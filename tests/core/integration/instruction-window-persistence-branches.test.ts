/**
 * 指令窗口存储的**持久化容错与并发守卫**分支补测
 * （E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 先逐行读了实现（`instruction-window-store.ts` L140-264）再写用例，目标分支：
 *  - L152：构造时**不给** `windowCapacity` → 必须落到默认容量（右侧分支）；
 *  - L177：落盘文档 `schemaVersion !== 1` 或 `instructions` 不是数组 → 按空窗口继续，不得抛错；
 *  - L188-189：文档缺 `queuedOrder` / `processedReceiptKeys` 字段 → 用空值兜底（`??` 右侧）；
 *  - L220-224：磁盘指纹读取时同样缺字段 → 不得抛错（由"缺字段文档 + 再次提交"触发）；
 *  - L256：**我方提交过之后磁盘文件消失** → 必须响亮失败（拒绝覆盖以规避静默丢指令）。
 *
 * 断言均为行为断言（准入结果、快照内容、是否抛错及错误文本）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstructionWindowStore } from "../../../packages/core/src/orchestration/instruction-window-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-window-branch-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function buildInstruction(index: number) {
  return {
    instructionIdentifier: "ins-" + String(index),
    instructionRevision: 1,
    sourceKind: "user" as const,
    instructionText: "指令 " + String(index),
    idempotencyKey: "key-" + String(index),
  };
}

async function resolveWindowFilePath(): Promise<string> {
  const windowDirectory = path.join(baseDirectory, "instruction-window");
  const entries = await fs.readdir(windowDirectory);
  const windowFileName = entries.find((entryName) => entryName.endsWith(".json"));
  if (windowFileName === undefined) {
    throw new Error("未找到指令窗口持久文件");
  }
  return path.join(windowDirectory, windowFileName);
}

describe("指令窗口：缺省容量分支", () => {
  it("不传 windowCapacity 时使用默认容量（第 4 条必须排队）", async () => {
    const store = new InstructionWindowStore({ baseDirectory });
    for (let index = 1; index <= 4; index += 1) {
      const result = await store.admitInstruction(buildInstruction(index));
      expect(result.outcome).toBe(index <= 3 ? "admitted" : "queued");
    }
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(3);
    expect(snapshot.queuedInstructions).toHaveLength(1);
  });
});

describe("指令窗口：损坏/异版本文档的容错", () => {
  it("schemaVersion 不为 1 的文档：按空窗口继续，不得抛错", async () => {
    const seedStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await seedStore.admitInstruction(buildInstruction(1));
    const windowFilePath = await resolveWindowFilePath();
    await fs.writeFile(
      windowFilePath,
      JSON.stringify({ schemaVersion: 2, windowCapacity: 3, instructions: [] }),
      "utf8",
    );

    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(0);
    expect(snapshot.queuedInstructions).toHaveLength(0);
  });

  it("instructions 不是数组的文档：按空窗口继续，不得抛错", async () => {
    const seedStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await seedStore.admitInstruction(buildInstruction(1));
    const windowFilePath = await resolveWindowFilePath();
    await fs.writeFile(
      windowFilePath,
      JSON.stringify({ schemaVersion: 1, windowCapacity: 3, instructions: "不是数组" }),
      "utf8",
    );

    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(0);
  });

  it("文档缺少 queuedOrder/processedReceiptKeys 字段：必须兜底为空并正常加载", async () => {
    const seedStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await seedStore.admitInstruction(buildInstruction(1));
    const windowFilePath = await resolveWindowFilePath();
    const persistedDocument = JSON.parse(await fs.readFile(windowFilePath, "utf8")) as {
      instructions: unknown[];
      windowCapacity: number;
    };
    // 只保留必要字段，删掉两个可选数组 → 触发 ?? 右侧分支（加载与磁盘指纹两处）
    await fs.writeFile(
      windowFilePath,
      JSON.stringify({
        schemaVersion: 1,
        windowCapacity: persistedDocument.windowCapacity,
        instructions: persistedDocument.instructions,
      }),
      "utf8",
    );

    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(1);
    expect(snapshot.activeInstructions[0]?.instructionIdentifier).toBe("ins-1");
    // 再准入一条：提交前会读磁盘指纹（缺字段路径）→ 不得抛错
    const admitted = await store.admitInstruction(buildInstruction(2));
    expect(admitted.outcome).toBe("admitted");
  });
});

describe("指令窗口：提交后磁盘文件消失的并发守卫", () => {
  it("我方提交过之后文件消失：再次准入必须响亮失败（拒绝覆盖）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await store.admitInstruction(buildInstruction(1));
    const windowFilePath = await resolveWindowFilePath();
    await fs.rm(windowFilePath, { force: true });

    await expect(store.admitInstruction(buildInstruction(2))).rejects.toThrow(/并发冲突/);
  });

  it("对照：从未读过也从未提交过时，首次落盘允许（不得误报冲突）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    const admitted = await store.admitInstruction(buildInstruction(1));
    expect(admitted.outcome).toBe("admitted");
  });
});
