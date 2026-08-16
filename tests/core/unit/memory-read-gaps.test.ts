/**
 * B6R-11：AgentIndividualMemoryStore readMemoryArchive 缺口分支单测
 * （非法命名空间 131、非 ENOENT 错误抛出 144、损坏存档 150）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentIndividualMemoryStore } from "../../../packages/core/src/orchestration/agent-individual-memory.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mem-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("AgentIndividualMemoryStore readMemoryArchive 缺口", () => {
  it("保留角色命名空间读取 → 拒绝（131）", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    await expect(
      store.readMemoryArchive("all-agents"),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    await expect(
      store.readMemoryArchive("shared"),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("非 ENOENT 读取错误向上抛出（144）：文件路径是目录", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    const agentDirectory = store.memoryDirectoryPath("tertiary-1");
    await fs.mkdir(agentDirectory, { recursive: true });
    // memory-archive.json 位置放一个目录 → readFile 抛 EISDIR（非 ENOENT）
    await fs.mkdir(path.join(agentDirectory, "memory-archive.json"), { recursive: true });
    await expect(store.readMemoryArchive("tertiary-1")).rejects.toThrow();
  });

  it("损坏 JSON 存档抛错；schema 非法 → journal-corrupted（150）", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    const agentDirectory = store.memoryDirectoryPath("tertiary-1");
    await fs.mkdir(agentDirectory, { recursive: true });
    // 非法 JSON：JSON.parse 原生错误冒泡（既有行为；未包 DomainError）
    await fs.writeFile(
      path.join(agentDirectory, "memory-archive.json"),
      "{not-json{{",
      "utf8",
    );
    await expect(store.readMemoryArchive("tertiary-1")).rejects.toThrow(SyntaxError);
    // 合法 JSON 但 schema 非法（缺必填字段）→ journal-corrupted
    await fs.writeFile(
      path.join(agentDirectory, "memory-archive.json"),
      '{"schemaVersion":1}',
      "utf8",
    );
    await expect(
      store.readMemoryArchive("tertiary-1"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("存档不存在返回 null（ENOENT）；追加后 owner 一致读取成功", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    expect(await store.readMemoryArchive("tertiary-1")).toBeNull();
    await store.appendObservation({
      runtimeAgentInstanceId: "tertiary-1",
      summary: "一条观察",
      sourceAgentInstanceId: "secondary-1",
      sourceAttachmentHash: VALID_SHA256,
    });
    await expect(store.readMemoryArchive("tertiary-1")).resolves.toMatchObject({
      ownerAgentInstanceId: "tertiary-1",
      revision: 1,
    });
  });
});
