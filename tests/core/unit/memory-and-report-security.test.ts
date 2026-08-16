/**
 * B6R-07 测试：T08A 个体记忆与报告存储安全（先红后绿）。
 * - 失败反例：并发/连续追加产生重复 observation ID；同一 report ID 不同
 *   内容覆盖既有报告；报告来源伪造（非空字符串即可）。
 * - 接入后：不可复用 observation ID + 并发互斥 + revision 校验 + 受控备份；
 *   报告幂等重放哈希校验、来源认证端口、读取路径隔离。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentIndividualMemoryStore } from "../../../packages/core/src/orchestration/agent-individual-memory.js";
import {
  MainAgentReportArchiveIngestor,
} from "../../../packages/core/src/orchestration/main-agent-report-archive.js";
import type { TertiaryTerminalReport } from "../../../packages/core/src/orchestration/main-agent-report-archive.js";
import { CrossAgentContextAttachmentController } from "../../../packages/core/src/orchestration/cross-agent-attachment-controller.js";
import type { AgentWorkArchiveEntry } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r07-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeReport(overrides: Partial<TertiaryTerminalReport> = {}): TertiaryTerminalReport {
  return {
    reportId: "report-1",
    missionId: "mission-1",
    taskBundleId: "bundle-1",
    reportingAgentInstanceId: "tertiary-1",
    reportKind: "completed",
    summary: "任务完成",
    executedChecks: [{ command: "npm test", exitCode: 0 }],
    createdAtIso: new Date().toISOString(),
    contentHash: "",
    ...overrides,
  };
}

describe("B6R-07 失败反例（先红）", () => {
  it("并发追加记忆观察：最终文档无重复 ID 且不丢更新", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        store.appendObservation({
          runtimeAgentInstanceId: "tertiary-a",
          summary: `观察 ${index}`,
          sourceAgentInstanceId: null,
          sourceAttachmentHash: null,
        }),
      ),
    );
    const finalDocument = await store.readMemoryArchive("tertiary-a");
    const observationIds =
      finalDocument?.observations.map((observation) => observation.observationId) ?? [];
    // 失败反例：并发追加应 10 条且 ID 全部不可复用（旧实现可能重复/丢失）
    expect(observationIds.length).toBe(10);
    expect(new Set(observationIds).size).toBe(10);
  });

  it("同一 report ID 不同内容覆盖既有报告（应拒绝）", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
    });
    await ingestor.ingestReport(makeReport());
    // 同一 reportId 不同内容 → 幂等重放哈希不一致 → 不得覆盖
    await expect(
      ingestor.ingestReport(makeReport({ summary: "被篡改的不同内容" })),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    const report = await ingestor.readReport("mission-1", "report-1");
    expect(report?.summary).toBe("任务完成");
  });

  it("来源认证端口未注入时伪造来源被接受（缺陷基线：产品路径必须注入端口）", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
    });
    await ingestor.ingestReport(
      makeReport({ reportingAgentInstanceId: "attacker-999" }),
    );
    const report = await ingestor.readReport("mission-1", "report-1");
    // 缺陷基线：无端口时接受；认证端口注入后拒绝（见接入后测试）
    expect(report).not.toBeNull();
  });
});

describe("B6R-07 接入后（先红后绿）", () => {
  it("并发/连续追加：不可复用 observation ID + 无丢失更新", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    // 连续追加
    for (let index = 0; index < 5; index++) {
      await store.appendObservation({
        runtimeAgentInstanceId: "tertiary-a",
        summary: `连续 ${index}`,
        sourceAgentInstanceId: null,
        sourceAttachmentHash: null,
      });
    }
    // 并发追加
    await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        store.appendObservation({
          runtimeAgentInstanceId: "tertiary-a",
          summary: `并发 ${index}`,
          sourceAgentInstanceId: null,
          sourceAttachmentHash: null,
        }),
      ),
    );
    const finalDocument = await store.readMemoryArchive("tertiary-a");
    const observationIds =
      finalDocument?.observations.map((observation) => observation.observationId) ?? [];
    expect(observationIds.length).toBe(15);
    expect(new Set(observationIds).size).toBe(15);
    expect(finalDocument?.revision).toBe(15);
    // 备份存在（受控备份层）
    const backupPath = path.join(
      temporaryDirectory,
      "agent-memory",
      "tertiary-a",
      "memory-archive.json.bak",
    );
    await expect(fs.access(backupPath)).resolves.toBeUndefined();
  });

  it("陈旧 revision 追加拒绝（expectedRevision 校验）", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    await store.appendObservation({
      runtimeAgentInstanceId: "tertiary-a",
      summary: "第一",
      sourceAgentInstanceId: null,
      sourceAttachmentHash: null,
    });
    await store.appendObservation({
      runtimeAgentInstanceId: "tertiary-a",
      summary: "第二",
      sourceAgentInstanceId: null,
      sourceAttachmentHash: null,
    });
    // 并发写者用旧 revision → 拒绝
    await expect(
      store.appendObservation({
        runtimeAgentInstanceId: "tertiary-a",
        summary: "陈旧",
        sourceAgentInstanceId: null,
        sourceAttachmentHash: null,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("报告幂等重放：内容哈希一致可重复入档；不一致拒绝覆盖", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
    });
    const fixedTimestamp = "2026-08-16T00:00:00.000Z";
    const first = makeReport({ createdAtIso: fixedTimestamp });
    await ingestor.ingestReport(first);
    // 同一内容重放（幂等，createdAtIso 相同）→ 接受且不改变
    await ingestor.ingestReport(
      makeReport({ createdAtIso: fixedTimestamp }),
    );
    // 不同内容同 ID → 拒绝覆盖（journal-corrupted）
    await expect(
      ingestor.ingestReport(
        makeReport({ createdAtIso: fixedTimestamp, summary: "不同内容" }),
      ),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    const report = await ingestor.readReport("mission-1", "report-1");
    expect(report?.summary).toBe("任务完成");
  });

  it("报告来源认证端口：与 Agent 注册表/所属次级/mission/任务包匹配才接受", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
      sourceAuthenticationPort: {
        verifySource: async (input) => {
          if (input.reportingAgentInstanceId === "tertiary-1" && input.missionId === "mission-1") {
            return { valid: true, reason: null };
          }
          return { valid: false, reason: "Agent 未注册或所属关系不匹配" };
        },
      },
    });
    await expect(
      ingestor.ingestReport(makeReport({ reportingAgentInstanceId: "attacker-999" })),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    // 合法来源（认证通过）→ 接受
    await ingestor.ingestReport(makeReport());
    expect(await ingestor.readReport("mission-1", "report-1")).not.toBeNull();
  });

  it("附件读取保持个体隔离：空选择/哈希校验/来源不匹配拒绝", () => {
    const controller = new CrossAgentContextAttachmentController();
    const entry: AgentWorkArchiveEntry = {
      archiveEntryId: "e1",
      recordedAtIso: new Date().toISOString(),
      taskId: "T-1",
      entryType: "result",
      summary: "摘要",
      artifactReferences: [],
    };
    const attachment = controller.createAttachment({
      sourceAgentInstanceId: "tertiary-a",
      archiveRevision: 1,
      selectedArchiveEntries: [entry],
      selectionReason: "接手",
      tokenBudgetTokens: 1_000,
      redactionRules: [],
    });
    expect(
      controller.verifyAttachment({
        attachment,
        expectedSourceAgentInstanceId: "tertiary-a",
      }),
    ).toBe(true);
    expect(
      controller.verifyAttachment({
        attachment,
        expectedSourceAgentInstanceId: "tertiary-b",
      }),
    ).toBe(false);
    // 篡改条目 → 哈希不匹配
    const tampered = {
      ...attachment,
      selectedArchiveEntries: [{ ...entry, summary: "被篡改" }],
    };
    expect(
      controller.verifyAttachment({
        attachment: tampered,
        expectedSourceAgentInstanceId: "tertiary-a",
      }),
    ).toBe(false);
  });
});
