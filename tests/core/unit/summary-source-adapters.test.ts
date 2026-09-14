/**
 * SUM-01-04a：真实来源适配器（排序/重编号/去重/类型映射/抽取式叙述）。
 */
import { describe, expect, it } from "vitest";

import {
  buildLocalExtractiveNarrative,
  buildWorkArchiveSummaryEntries,
} from "../../../packages/core/src/summarization/summary-source-adapters.js";
import { extractSummaryFacts } from "../../../packages/core/src/summarization/summary-fact-extractor.js";

function entry(
  archiveEntryId: string,
  entryType:
    | "assignment"
    | "progress"
    | "decision"
    | "result"
    | "failure"
    | "handoff",
  summary: string,
  recordedAtIso: string,
) {
  return {
    archiveEntryId,
    recordedAtIso,
    taskId: "T-1",
    entryType,
    summary,
    artifactReferences: [],
  };
}

describe("SUM-01-04a 工作存档 → 摘要来源条目", () => {
  it("跨 Agent 合并后按时间稳定排序并重排 sourceRevision", () => {
    const entries = buildWorkArchiveSummaryEntries([
      {
        missionId: "mission-1",
        agentInstanceId: "agent-b",
        entries: [
          entry("e2", "result", "B 的第二个结果", "2026-01-01T00:00:02.000Z"),
          entry("e1", "assignment", "B 的派工", "2026-01-01T00:00:01.000Z"),
        ],
      },
      {
        missionId: "mission-1",
        agentInstanceId: "agent-a",
        entries: [
          entry("e1", "decision", "A 的裁决", "2026-01-01T00:00:00.000Z"),
          entry("e2", "progress", "A 的进展", "2026-01-01T00:00:03.000Z"),
        ],
      },
    ]);
    expect(entries.map((item) => item.sourceRevision)).toEqual([1, 2, 3, 4]);
    expect(entries.map((item) => item.text)).toEqual([
      "A 的裁决",
      "B 的派工",
      "B 的第二个结果",
      "A 的进展",
    ]);
    // 证据可回溯到具体个体存档条目。
    expect(entries[0]?.sourceIdentifier).toBe("agent-a#e1");
    expect(entries[1]?.sourceIdentifier).toBe("agent-b#e1");
    expect(entries[0]?.sourceKind).toBe("work-archive");
  });

  it("同一条存档条目重复投递不双计，条目类型做确定性映射", () => {
    const entries = buildWorkArchiveSummaryEntries([
      {
        missionId: "mission-1",
        agentInstanceId: "agent-a",
        entries: [
          entry("e1", "decision", "裁决", "2026-01-01T00:00:00.000Z"),
          entry("e1", "decision", "裁决", "2026-01-01T00:00:00.000Z"),
          entry("e2", "failure", "失败", "2026-01-01T00:00:01.000Z"),
          entry("e3", "handoff", "交接", "2026-01-01T00:00:02.000Z"),
        ],
      },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.map((item) => item.entryType)).toEqual([
      "decision",
      "note",
      "note",
    ]);
    // 内容哈希确定性：同输入同输出。
    expect(entries[0]?.contentHash).toBe(
      buildWorkArchiveSummaryEntries([
        {
          missionId: "mission-1",
          agentInstanceId: "agent-a",
          entries: [entry("e1", "decision", "裁决", "2026-01-01T00:00:00.000Z")],
        },
      ])[0]?.contentHash,
    );
  });

  it("本地抽取式叙述是确定性统计，不含模型推断", () => {
    const entries = buildWorkArchiveSummaryEntries([
      {
        missionId: "mission-1",
        agentInstanceId: "agent-a",
        entries: [
          entry("e1", "decision", "裁决", "2026-01-01T00:00:00.000Z"),
          entry("e2", "result", "结果", "2026-01-01T00:00:01.000Z"),
        ],
      },
    ]);
    const narrative = buildLocalExtractiveNarrative(extractSummaryFacts(entries));
    expect(narrative).toContain("共 2 条工作记录");
    expect(narrative).toContain("decision=1");
    expect(narrative).toContain("result=1");
    expect(narrative).toContain("2026-01-01T00:00:00.000Z");
    expect(buildLocalExtractiveNarrative([])).toBe("（无工作记录）");
  });
});
