import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import {
  cleanStaleTempFiles,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../../../packages/core/src/infra/atomic-json.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-test-"),
  );
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeTaskChainDocument(
  missionId: string,
  revision: number,
): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId,
    revision,
    updatedAtIso: "2026-08-12T10:00:00.000Z",
    tasks: [
      {
        id: "T-001",
        description: "收集数据",
        dependsOn: [],
        taskType: "data",
        toolNames: ["read"],
        assignedAgentId: "L3-A",
        status: "done",
        resultLocation: "data/raw.csv",
      },
    ],
  };
}

describe("writeAtomicJson / readJsonWithBackupRecovery", () => {
  it("写入后可读回，且替换已存在目标文件（Windows rename 覆盖场景）", async () => {
    const filePath = path.join(temporaryDirectory, "target.json");
    const backupPath = path.join(temporaryDirectory, "target.json.bak");
    await writeAtomicJson(filePath, { version: 1 });
    await writeAtomicJson(filePath, { version: 2 });

    const result = await readJsonWithBackupRecovery(filePath, backupPath);
    expect(result).toEqual({
      content: { version: 2 },
      recoveredFromBackup: false,
    });
  });

  it("主文件损坏时从备份恢复并回写主文件", async () => {
    const filePath = path.join(temporaryDirectory, "target.json");
    const backupPath = path.join(temporaryDirectory, "target.json.bak");
    await writeAtomicJson(filePath, { version: 1 });
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, "{ 损坏的 JSON", "utf8");

    const result = await readJsonWithBackupRecovery(filePath, backupPath);
    expect(result).toEqual({
      content: { version: 1 },
      recoveredFromBackup: true,
    });
    const recoveredMain = JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as unknown;
    expect(recoveredMain).toEqual({ version: 1 });
  });

  it("主文件与备份均损坏时抛 DomainError journal-corrupted", async () => {
    const filePath = path.join(temporaryDirectory, "target.json");
    const backupPath = path.join(temporaryDirectory, "target.json.bak");
    await fs.writeFile(filePath, "损坏", "utf8");
    await fs.writeFile(backupPath, "也损坏", "utf8");
    await expect(
      readJsonWithBackupRecovery(filePath, backupPath),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("主文件不存在返回 null", async () => {
    const result = await readJsonWithBackupRecovery(
      path.join(temporaryDirectory, "missing.json"),
      path.join(temporaryDirectory, "missing.json.bak"),
    );
    expect(result).toBeNull();
  });

  it("cleanStaleTempFiles 清理崩溃残留的临时文件", async () => {
    const targetPath = path.join(temporaryDirectory, "target.json");
    const stalePath = path.join(temporaryDirectory, ".target.json.1234.uuid.tmp");
    const otherPath = path.join(temporaryDirectory, "other.txt");
    await fs.writeFile(stalePath, "残留", "utf8");
    await fs.writeFile(otherPath, "无关", "utf8");
    await writeAtomicJson(targetPath, { ok: true });

    await cleanStaleTempFiles(temporaryDirectory, "target.json");
    await expect(fs.access(stalePath)).rejects.toThrow();
    await expect(fs.access(otherPath)).resolves.toBeUndefined();
    await expect(fs.access(targetPath)).resolves.toBeUndefined();
  });
});

describe("TaskStore", () => {
  it("写入后读回相同文档", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    const document = makeTaskChainDocument("mission-001", 1);
    await store.writeTaskChain(document);
    expect(await store.readTaskChain("mission-001")).toEqual(document);
  });

  it("不存在的 mission 返回 null", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    expect(await store.readTaskChain("mission-missing")).toBeNull();
  });

  it("拒绝非法 schema 文档", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    const invalid = makeTaskChainDocument("mission-001", 1);
    invalid.schemaVersion = 0;
    await expect(store.writeTaskChain(invalid)).rejects.toMatchObject({
      errorCode: "invalid-task-chain",
    });
  });

  it("拒绝旧 revision 覆盖新 revision", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    await store.writeTaskChain(makeTaskChainDocument("mission-001", 1));
    await store.writeTaskChain(makeTaskChainDocument("mission-001", 2));
    await expect(
      store.writeTaskChain(makeTaskChainDocument("mission-001", 2)),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    await expect(
      store.writeTaskChain(makeTaskChainDocument("mission-001", 1)),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("主文件损坏时从备份恢复（模拟崩溃后可恢复旧版本）", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    await store.writeTaskChain(makeTaskChainDocument("mission-001", 1));

    const chainPath = path.join(
      temporaryDirectory,
      "missions",
      "mission-001",
      "task-chain.json",
    );
    await fs.writeFile(chainPath, "{ 损坏", "utf8");

    const recovered = await store.readTaskChain("mission-001");
    expect(recovered?.revision).toBe(1);
  });

  it("并发更新不会丢失 revision：N 个写入者 × M 次原子更新", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    const writerCount = 8;
    const iterationsPerWriter = 5;

    await Promise.all(
      Array.from({ length: writerCount }, async () => {
        for (let iteration = 0; iteration < iterationsPerWriter; iteration++) {
          await store.updateTaskChain("mission-concurrent", (current) =>
            makeTaskChainDocument(
              "mission-concurrent",
              (current?.revision ?? 0) + 1,
            ),
          );
        }
      }),
    );

    const finalDocument = await store.readTaskChain("mission-concurrent");
    expect(finalDocument?.revision).toBe(writerCount * iterationsPerWriter);
  });

  it("updateTaskChain 在锁内串行化读-改-写", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    const document = await store.updateTaskChain("mission-001", () =>
      makeTaskChainDocument("mission-001", 1),
    );
    expect(document.revision).toBe(1);
    const updated = await store.updateTaskChain("mission-001", (current) =>
      makeTaskChainDocument("mission-001", (current?.revision ?? 0) + 1),
    );
    expect(updated.revision).toBe(2);
  });

  it("cleanStaleTempFiles 对不存在的目录安全返回", async () => {
    await cleanStaleTempFiles(
      path.join(temporaryDirectory, "missing-directory"),
      "target.json",
    );
  });

  it("backupExistingFile 源为目录时抛错", async () => {
    const { backupExistingFile } = await import("../../../packages/core/src/infra/atomic-json.js");
    const sourcePath = path.join(temporaryDirectory, "source-dir");
    const backupPath = path.join(temporaryDirectory, "backup.json");
    await fs.mkdir(sourcePath);
    await expect(
      backupExistingFile(sourcePath, backupPath),
    ).rejects.toThrow();
  });

  it("rename 失败时清理临时文件并抛错（目标为目录）", async () => {
    const filePath = path.join(temporaryDirectory, "target.json");
    await fs.mkdir(filePath);
    await expect(writeAtomicJson(filePath, { ok: true })).rejects.toThrow();
    const entries = await fs.readdir(temporaryDirectory);
    const leftoverTempFiles = entries.filter(
      (entry) => entry.startsWith(".target.json.") && entry.endsWith(".tmp"),
    );
    expect(leftoverTempFiles).toHaveLength(0);
  });

  it("备份路径为目录时写入失败向上传播", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    await store.writeTaskChain(makeTaskChainDocument("mission-001", 1));
    const backupPath = path.join(
      temporaryDirectory,
      "missions",
      "mission-001",
      "task-chain.json.bak",
    );
    await fs.rm(backupPath);
    await fs.mkdir(backupPath);
    await expect(
      store.writeTaskChain(makeTaskChainDocument("mission-001", 2)),
    ).rejects.toThrow();
  });

  it("JSON 合法但结构非法的内容进入 recovery 并抛 journal-corrupted", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    const chainPath = path.join(
      temporaryDirectory,
      "missions",
      "mission-001",
      "task-chain.json",
    );
    await fs.mkdir(path.dirname(chainPath), { recursive: true });
    await fs.writeFile(
      chainPath,
      JSON.stringify({ schemaVersion: 1, tasks: "不是数组" }),
      "utf8",
    );
    await expect(store.readTaskChain("mission-001")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("损坏且无法恢复时抛 DomainError，不静默覆盖", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    const chainPath = path.join(
      temporaryDirectory,
      "missions",
      "mission-001",
      "task-chain.json",
    );
    const backupPath = path.join(
      temporaryDirectory,
      "missions",
      "mission-001",
      "task-chain.json.bak",
    );
    await fs.mkdir(path.dirname(chainPath), { recursive: true });
    await fs.writeFile(chainPath, "损坏", "utf8");
    await fs.writeFile(backupPath, "也损坏", "utf8");

    await expect(
      store.readTaskChain("mission-001"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });
});
