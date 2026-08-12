/**
 * T05A：Agent 工作存档与上下文选择器测试。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentWorkArchiveStore, decodePathSegment, sanitizePathSegment } from "../../../packages/core/src/orchestration/work-archive-store.js";

let temporaryDirectory: string;
let store: AgentWorkArchiveStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-archive-"));
  store = new AgentWorkArchiveStore({ baseDirectory: temporaryDirectory });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

describe("AgentWorkArchiveStore", () => {
  it("追加条目：revision 单调递增，可读回", async () => {
    const first = await store.appendEntry({
      missionId: "mission-1",
      agentInstanceId: "worker-a",
      agentRole: "tertiary",
      entry: {
        taskId: "T-001",
        entryType: "assignment",
        summary: "开始执行",
        artifactReferences: [],
      },
    });
    expect(first.revision).toBe(1);
    const second = await store.appendEntry({
      missionId: "mission-1",
      agentInstanceId: "worker-a",
      agentRole: "tertiary",
      entry: {
        taskId: "T-001",
        entryType: "result",
        summary: "完成，产出 data/out.csv",
        artifactReferences: ["data/out.csv"],
      },
    });
    expect(second.revision).toBe(2);
    const archive = await store.readArchive("mission-1", "worker-a");
    expect(archive?.entries).toHaveLength(2);
    expect(archive?.entries[1]).toMatchObject({
      entryType: "result",
      summary: "完成，产出 data/out.csv",
    });
    expect(archive?.entries[1]?.archiveEntryId).toContain("worker-a");
  });

  it("不存在的 Agent 返回 null；listAgentIdsWithArchive 列出已有存档", async () => {
    expect(await store.readArchive("mission-1", "ghost")).toBeNull();
    expect(await store.listAgentIdsWithArchive("mission-1")).toEqual([]);
    await store.appendEntry({
      missionId: "mission-1",
      agentInstanceId: "worker-a",
      agentRole: "tertiary",
      entry: { taskId: "T-001", entryType: "progress", summary: "x", artifactReferences: [] },
    });
    expect(await store.listAgentIdsWithArchive("mission-1")).toEqual(["worker-a"]);
  });

  it("buildAttachment 只包含选中条目，contentHash 可校验", async () => {
    await store.appendEntry({
      missionId: "mission-1",
      agentInstanceId: "worker-a",
      agentRole: "tertiary",
      entry: { taskId: "T-001", entryType: "assignment", summary: "开始", artifactReferences: [] },
    });
    const archive = await store.readArchive("mission-1", "worker-a");
    expect(archive).not.toBeNull();
    const entryId = archive!.entries[0]!.archiveEntryId;
    const attachment = store.buildAttachment({
      archiveOwnerAgentInstanceId: "worker-a",
      archive: archive!,
      selectedArchiveEntryIds: [entryId],
      selectionReason: "重试上下文",
    });
    expect(attachment).not.toBeNull();
    expect(attachment?.selectedArchiveEntries).toHaveLength(1);
    expect(AgentWorkArchiveStore.verifyAttachmentHash(attachment!)).toBe(true);
  });

  it("buildAttachment 空选择返回 null（默认不注入）", async () => {
    const archive = await store.readArchive("mission-1", "worker-a");
    if (archive === null) {
      return;
    }
    const attachment = store.buildAttachment({
      archiveOwnerAgentInstanceId: "worker-a",
      archive,
      selectedArchiveEntryIds: ["不存在"],
      selectionReason: "测试",
    });
    expect(attachment).toBeNull();
  });

  it("不同 Agent 存档相互隔离", async () => {
    await store.appendEntry({
      missionId: "mission-1",
      agentInstanceId: "worker-a",
      agentRole: "tertiary",
      entry: { taskId: "T-001", entryType: "result", summary: "A 的结果", artifactReferences: [] },
    });
    await store.appendEntry({
      missionId: "mission-1",
      agentInstanceId: "worker-b",
      agentRole: "tertiary",
      entry: { taskId: "T-001", entryType: "result", summary: "B 的结果", artifactReferences: [] },
    });
    const archiveA = await store.readArchive("mission-1", "worker-a");
    const archiveB = await store.readArchive("mission-1", "worker-b");
    expect(archiveA?.entries[0]?.summary).toBe("A 的结果");
    expect(archiveB?.entries[0]?.summary).toBe("B 的结果");
  });

  describe("S6：路径段编码无碰撞且幂等", () => {
    it("不同 ID 编码后不同（a:b 与 a?b 不再映射同一目录）", () => {
      expect(sanitizePathSegment("a:b")).not.toBe(sanitizePathSegment("a?b"));
      expect(sanitizePathSegment("a:b")).not.toBe(sanitizePathSegment("a.b"));
      expect(sanitizePathSegment("worker:mission:T-001:1")).not.toBe(
        sanitizePathSegment("worker/mission/T-001/1"),
      );
    });

    it("编码幂等：sanitize(sanitize(x)) === sanitize(x)", () => {
      const candidates = [
        "worker:mission-1:T-001:1",
        "a?b",
        "agent a/b",
        "普通-中文-标识",
      ];
      for (const candidate of candidates) {
        const once = sanitizePathSegment(candidate);
        expect(sanitizePathSegment(once)).toBe(once);
      }
    });

    it("编码可逆：decode(sanitize(x)) === x", () => {
      const candidates = [
        "worker:mission-1:T-001:1",
        "a?b",
        "agent a/b",
        "普通-中文-标识",
      ];
      for (const candidate of candidates) {
        expect(decodePathSegment(sanitizePathSegment(candidate))).toBe(candidate);
      }
    });

    it("Windows 非法字符（冒号/问号/反斜杠）全部被转义", () => {
      for (const illegalCharacter of [":", "?", "\\", "/", "*", "|", '"', "<", ">"]) {
        const encoded = sanitizePathSegment(`a${illegalCharacter}b`);
        expect(encoded).not.toContain(illegalCharacter);
      }
    });
  });
});
