/**
 * AR-07 批次2：小缺口关键模块分支补测。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import {
  CompletionControlParser,
  TASK_BLOCKED_MARKER,
} from "../../../packages/core/src/core/completion-protocol.js";
import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { AgentWorkArchiveStore } from "../../../packages/core/src/orchestration/work-archive-store.js";
import { EvidenceQueryGuard } from "../../../packages/core/src/tools/evidence-search-agent-port.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07b-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

async function findFileByName(rootPath: string, fileName: string): Promise<string | null> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileByName(entryPath, fileName);
      if (found !== null) {
        return found;
      }
    } else if (entry.name === fileName) {
      return entryPath;
    }
  }
  return null;
}

describe("AR-07 批次2：ProtectedStoragePolicy", () => {
  it("受保护根/审计文件路径可读；不存在盘符路径安全解析", async () => {
    const policy = new ProtectedStoragePolicy({ stateDirectoryPath: temporaryDirectory });
    expect(policy.getBackupVaultRootPath()).toContain("backup-vault");
    expect(policy.getBackupDeletionAuditFilePath()).toContain("backup-deletion-audit.jsonl");
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "Z:\\nowhere\\x.txt",
        operation: "read",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("AR-07 批次2：CompletionControlParser", () => {
  it("blocked 标记 JSON 非法或 schema 不符时返回 null", () => {
    const parser = new CompletionControlParser();
    expect(parser.tryParseMarkerLine(TASK_BLOCKED_MARKER + " {not-json}")).toBeNull();
    expect(parser.tryParseMarkerLine(TASK_BLOCKED_MARKER + ' {"schemaVersion":1}')).toBeNull();
    expect(parser.parseStructuredControl("not-a-control-frame")).toEqual({ kind: "none" });
  });
});

describe("AR-07 批次2：MailboxJournal 边界", () => {
  it("目录缺失列空；ack 不存在接收者安全返回；非对象/非法消息文档 fail-closed", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    expect(await journal.listRecipientIds()).toEqual([]);
    await expect(journal.ack("recipient-missing", "message-missing")).resolves.toBeUndefined();

    const journalDirectory = path.join(temporaryDirectory, "feedback", "mailboxes");
    await fs.mkdir(journalDirectory, { recursive: true });
    await fs.writeFile(path.join(journalDirectory, "bad-number.json"), "123", "utf8");
    await expect(journal.loadDocument("bad-number")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });

    await fs.writeFile(
      path.join(journalDirectory, "bad-message.json"),
      JSON.stringify({
        schemaVersion: 1,
        recipientId: "bad-message",
        nextSequence: 1,
        messages: [null],
      }),
      "utf8",
    );
    await expect(journal.loadDocument("bad-message")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });
});

describe("AR-07 批次2：AgentWorkArchiveStore 反例", () => {
  it("非法 agentRole 拒绝；损坏文档读出 null；未选中条目返回 null", async () => {
    const store = new AgentWorkArchiveStore({ baseDirectory: temporaryDirectory });
    await expect(
      store.appendEntry({
        missionId: "mission-1",
        agentInstanceId: "agent-a",
        agentRole: "bogus" as never,
        entry: {
          taskId: null,
          entryType: "result",
          summary: "非法角色",
          artifactReferences: [],
        },
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });

    const archive = await store.appendEntry({
      missionId: "mission-2",
      agentInstanceId: "agent-b",
      agentRole: "tertiary",
      entry: {
        taskId: "T-001",
        entryType: "result",
        summary: "有效条目",
        artifactReferences: ["commit:abc"],
      },
    });
    expect(archive.entries).toHaveLength(1);
    expect(
      store.buildAttachment({
        archiveOwnerAgentInstanceId: "agent-b",
        archive,
        selectedArchiveEntryIds: ["not-selected"],
        selectionReason: "未选中",
      }),
    ).toBeNull();

    const archiveFilePath = await findFileByName(temporaryDirectory, "work-archive.json");
    expect(archiveFilePath).not.toBeNull();
    await fs.writeFile(
      archiveFilePath!,
      JSON.stringify({
        schemaVersion: 1,
        missionId: "mission-2",
        agentInstanceId: "agent-b",
        agentRole: "tertiary",
        revision: 1,
        updatedAtIso: new Date().toISOString(),
        entries: "not-an-array",
      }),
      "utf8",
    );
    expect(await store.readArchive("mission-2", "agent-b")).toBeNull();
  });
});

describe("AR-07 批次2：EvidenceQueryGuard 预算", () => {
  it("未登记主张预算为 0；查询后累计为 1", async () => {
    const guard = new EvidenceQueryGuard(2, 10);
    expect(guard.getBudgetForClaim("claim-unknown")).toBe(0);
    await guard.searchSafely({
      structuredQuery: "结构化查询",
      claimIdentifier: "claim-1",
      agent: { searchSources: async () => [] } as never,
    });
    expect(guard.getBudgetForClaim("claim-1")).toBe(1);
    expect(guard.getCacheSize()).toBe(1);

    const evictingGuard = new EvidenceQueryGuard(5, 0);
    await evictingGuard.searchSafely({
      structuredQuery: "查询一",
      claimIdentifier: "claim-evict",
      agent: { searchSources: async () => [] } as never,
    });
    await evictingGuard.searchSafely({
      structuredQuery: "查询二",
      claimIdentifier: "claim-evict",
      agent: { searchSources: async () => [] } as never,
    });
    expect(evictingGuard.getCacheSize()).toBeLessThanOrEqual(1);
  });
});
