/**
 * SUM-01-04 反例（2026-10-10）：卡内要求摘要覆盖"**会话历史、工作存档、报告和延后文件**"，
 * 而实测**只有工作存档适配器**（`buildWorkArchiveSummaryEntries`）——
 * `SummarySourceKind` 虽已含 `conversation`/`report`/`deferred-file`，
 * 但这三类**没有任何适配器**，即类型写了、能力没实现。
 *
 * 本轮钉住另外三类的适配器语义（与工作存档适配器保持同一纪律）：
 *  - **确定性排序**（时间优先，同刻按稳定键），**确定性内容哈希**；
 *  - **重复条目不得双计**（重读/重放不得灌水）；
 *  - `sourceRevision` 从 1 起**单调重排**；
 *  - `sourceIdentifier` **可回溯到原始来源**（不得退化成不透明序号）；
 *  - **不改写来源内容**（text 保持原文；本层不做摘要）；
 *  - 空输入 ⇒ 空结果且**不得伪造**任何条目；
 *  - 结构非法的输入项**跳过**（不猜测、不抛出并中断整批）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  buildConversationSummaryEntries,
  buildDeferredFileSummaryEntries,
  buildReportSummaryEntries,
} from "../../../packages/core/src/summarization/summary-source-adapters.js";

describe("SUM-01-04：会话历史适配器", () => {
  it("① 确定性排序 + revision 单调重排 + 可回溯来源标识", () => {
    const entries = buildConversationSummaryEntries({
      sessionIdentifier: "session-1",
      turns: [
        {
          turnIdentifier: "turn-2",
          speaker: "assistant",
          text: "第二条",
          recordedAtIso: "2026-10-10T00:00:02.000Z",
        },
        {
          turnIdentifier: "turn-1",
          speaker: "user",
          text: "第一条",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
      ],
    });
    expect(entries.map((entry) => entry.text)).toEqual(["第一条", "第二条"]);
    expect(entries.map((entry) => entry.sourceRevision)).toEqual([1, 2]);
    expect(entries.every((entry) => entry.sourceKind === "conversation")).toBe(true);
    // 可回溯：来源标识必须含会话与轮次标识
    expect(entries[0]?.sourceIdentifier).toContain("session-1");
    expect(entries[0]?.sourceIdentifier).toContain("turn-1");
    // 不重写正文
    expect(entries[0]?.text).toBe("第一条");
  });

  it("② 重复的 turnIdentifier 不得双计（重读/重放不灌水）", () => {
    const entries = buildConversationSummaryEntries({
      sessionIdentifier: "session-1",
      turns: [
        {
          turnIdentifier: "turn-1",
          speaker: "user",
          text: "只有一次",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
        {
          turnIdentifier: "turn-1",
          speaker: "user",
          text: "只有一次",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
      ],
    });
    expect(entries).toHaveLength(1);
  });

  it("③ 内容不同则哈希不同；相同内容哈希相同（确定性）", () => {
    const buildOnce = (text: string) =>
      buildConversationSummaryEntries({
        sessionIdentifier: "session-1",
        turns: [
          {
            turnIdentifier: "turn-1",
            speaker: "user",
            text,
            recordedAtIso: "2026-10-10T00:00:01.000Z",
          },
        ],
      })[0]?.contentHash;
    expect(buildOnce("甲")).toBe(buildOnce("甲"));
    expect(buildOnce("甲")).not.toBe(buildOnce("乙"));
  });

  it("④ 空输入 ⇒ 空结果（不得伪造条目）；结构非法项跳过且不中断整批", () => {
    expect(
      buildConversationSummaryEntries({ sessionIdentifier: "session-1", turns: [] }),
    ).toEqual([]);
    const entries = buildConversationSummaryEntries({
      sessionIdentifier: "session-1",
      turns: [
        { turnIdentifier: "bad", speaker: "user", text: 42, recordedAtIso: "not-a-time" },
        {
          turnIdentifier: "turn-1",
          speaker: "user",
          text: "合法",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
      ] as never,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("合法");
  });
});

describe("SUM-01-04：报告来源适配器", () => {
  it("⑤ 报告条目可回溯到报告与任务，且 revision 单调", () => {
    const entries = buildReportSummaryEntries({
      reports: [
        {
          reportIdentifier: "report-1",
          taskIdentifier: "T-001",
          summaryText: "任务一完成",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
        {
          reportIdentifier: "report-2",
          taskIdentifier: "T-002",
          summaryText: "任务二完成",
          recordedAtIso: "2026-10-10T00:00:02.000Z",
        },
      ],
    });
    expect(entries.map((entry) => entry.sourceKind)).toEqual(["report", "report"]);
    expect(entries.map((entry) => entry.sourceRevision)).toEqual([1, 2]);
    expect(entries[0]?.sourceIdentifier).toContain("report-1");
    expect(entries[0]?.text).toBe("任务一完成");
  });

  it("⑥ 重复 reportIdentifier 不得双计；空输入 ⇒ 空结果", () => {
    const duplicated = buildReportSummaryEntries({
      reports: [
        {
          reportIdentifier: "report-1",
          taskIdentifier: "T-001",
          summaryText: "重复",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
        {
          reportIdentifier: "report-1",
          taskIdentifier: "T-001",
          summaryText: "重复",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
      ],
    });
    expect(duplicated).toHaveLength(1);
    expect(buildReportSummaryEntries({ reports: [] })).toEqual([]);
  });
});

describe("SUM-01-04：延后文件来源适配器", () => {
  it("⑦ 延后文件条目可回溯到文件与行区间，且不改写正文", () => {
    const entries = buildDeferredFileSummaryEntries({
      deferredFiles: [
        {
          fileIdentifier: "file-1",
          filePath: "docs/deferred.md",
          lineRangeStart: 1,
          lineRangeEnd: 10,
          excerptText: "延后内容片段",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sourceKind).toBe("deferred-file");
    expect(entries[0]?.sourceRevision).toBe(1);
    expect(entries[0]?.sourceIdentifier).toContain("file-1");
    expect(entries[0]?.text).toBe("延后内容片段");
  });

  it("⑧ 同文件不同行区间是**不同**条目（不得因文件相同就合并）", () => {
    const entries = buildDeferredFileSummaryEntries({
      deferredFiles: [
        {
          fileIdentifier: "file-1",
          filePath: "docs/deferred.md",
          lineRangeStart: 1,
          lineRangeEnd: 10,
          excerptText: "第一段",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
        {
          fileIdentifier: "file-1",
          filePath: "docs/deferred.md",
          lineRangeStart: 11,
          lineRangeEnd: 20,
          excerptText: "第二段",
          recordedAtIso: "2026-10-10T00:00:02.000Z",
        },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.sourceRevision)).toEqual([1, 2]);
  });

  it("⑨ 完全相同的延后条目重复出现不得双计；空输入 ⇒ 空结果", () => {
    const duplicated = buildDeferredFileSummaryEntries({
      deferredFiles: [
        {
          fileIdentifier: "file-1",
          filePath: "docs/deferred.md",
          lineRangeStart: 1,
          lineRangeEnd: 10,
          excerptText: "同一段",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
        {
          fileIdentifier: "file-1",
          filePath: "docs/deferred.md",
          lineRangeStart: 1,
          lineRangeEnd: 10,
          excerptText: "同一段",
          recordedAtIso: "2026-10-10T00:00:01.000Z",
        },
      ],
    });
    expect(duplicated).toHaveLength(1);
    expect(buildDeferredFileSummaryEntries({ deferredFiles: [] })).toEqual([]);
  });
});
