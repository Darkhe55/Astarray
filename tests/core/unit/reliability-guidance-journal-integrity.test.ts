/**
 * RELIABILITY-01 反例（2026-10-10）：**回执丢失**的真实形态 —— 指导日志损坏导致静默丢用户指导。
 *
 * 排查过程（如实记录）：卡内点名的时点是"回执写入但**确认丢失**"。我先按
 * "提交与派发分离" 的假设写了跨进程注入，实测发现本仓架构里指导的**记录与应用在同一个
 * 同步块内完成**（`submitRuntimeGuidance` 内部即完成回执回写）⇒ "回执已写、确认未到"
 * 这个**间隙并不存在**，原假设被证伪。
 *
 * 于是转向**该时点真正会出现的形态**：回执写入过程**被打断**（崩溃/断电），
 * 磁盘上留下**不完整 JSON**。实测缺陷：
 *   `GuidanceSubmissionJournal.readDocument()` 对解析失败**静默返回空日志**，
 *   于是 `queryGuidanceStatus()` 报告 **0 条** —— 用户指导**静默消失**，
 *   且调用方无法区分"从未提交"与"日志损坏"。
 *   （与已返修的幂等账目损坏属**同一类缺陷**。）
 *
 * 期望：损坏必须**显式暴露**（`isCorrupted` + 原因 + 丢失条目不可用），
 * 默认 **fail-closed**（拒绝把损坏当成"没有记录"），同时保留宽容读取以便诊断。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GuidanceSubmissionJournal } from "../../../packages/core/src/runtime-guidance/guidance-submission-journal.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guidance-journal-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function writeJournalRaw(rawContent: string): Promise<void> {
  const journalDirectory = path.join(stateDirectory, "guidance");
  await fs.mkdir(journalDirectory, { recursive: true });
  await fs.writeFile(path.join(journalDirectory, "submissions.json"), rawContent, "utf8");
}

function buildEntry(guidanceIdentifier: string, revision: number) {
  return {
    guidanceIdentifier,
    guidanceRevision: revision,
    behaviorTier: "record-only" as const,
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    status: "applied" as const,
    submittedAtIso: "2026-10-10T00:00:00.000Z",
    appliedAtIso: "2026-10-10T00:00:00.000Z",
    latencyMilliseconds: 0,
    dropReason: null,
    isApplicationStatusKnown: true,
  };
}

describe("RELIABILITY-01：指导日志损坏必须显式暴露（不得静默丢用户指导）", () => {
  it("① 不完整 JSON ⇒ 必须报告损坏与原因，而不是静默返回空日志", async () => {
    await writeJournalRaw('{ "schemaVersion": 1, "entries": [ {"guidanceId');
    const journal = new GuidanceSubmissionJournal({ baseDirectory: stateDirectory });
    const integrity = await journal.readAllWithIntegrity();
    expect(integrity.isCorrupted).toBe(true);
    expect(String(integrity.corruptionReason)).toMatch(/解析|损坏|JSON/);
    expect(integrity.entries).toEqual([]);
  });

  it("② schemaVersion 不符 / entries 非数组 ⇒ 同样报告损坏", async () => {
    await writeJournalRaw(JSON.stringify({ schemaVersion: 999, entries: [] }));
    const wrongVersion = await new GuidanceSubmissionJournal({
      baseDirectory: stateDirectory,
    }).readAllWithIntegrity();
    expect(wrongVersion.isCorrupted).toBe(true);

    await writeJournalRaw(JSON.stringify({ schemaVersion: 1, entries: "not-an-array" }));
    const wrongShape = await new GuidanceSubmissionJournal({
      baseDirectory: stateDirectory,
    }).readAllWithIntegrity();
    expect(wrongShape.isCorrupted).toBe(true);
  });

  it("③ 单条结构非法必须计入损坏（合法条目仍保留，供诊断）", async () => {
    await writeJournalRaw(
      JSON.stringify({
        schemaVersion: 1,
        entries: [buildEntry("guide-1", 1), { guidanceIdentifier: "" }],
      }),
    );
    const integrity = await new GuidanceSubmissionJournal({
      baseDirectory: stateDirectory,
    }).readAllWithIntegrity();
    expect(integrity.isCorrupted).toBe(true);
    expect(integrity.usableEntryCount).toBe(1);
    expect(integrity.unusableEntryCount).toBe(1);
  });

  it("④ 默认读取遇到损坏必须 **fail-closed**（拒绝把损坏当成没有记录）", async () => {
    await writeJournalRaw("{ 坏 JSON");
    const journal = new GuidanceSubmissionJournal({ baseDirectory: stateDirectory });
    // 宽容读取仍可用（用于诊断），但**默认**路径必须拒绝
    await expect(journal.readAllStrict()).rejects.toThrowError(/损坏|corrupt/i);
    // 宽容读取本身仍返回可解析条目（此处为空）
    expect(await journal.readAll()).toEqual([]);
  });

  it("⑤ 无文件 ⇒ 属正常全新安装，**不得**误判为损坏", async () => {
    const integrity = await new GuidanceSubmissionJournal({
      baseDirectory: stateDirectory,
    }).readAllWithIntegrity();
    expect(integrity.isCorrupted).toBe(false);
    expect(integrity.entries).toEqual([]);
  });

  it("⑥ 健康日志必须原样可读且不报损坏", async () => {
    await writeJournalRaw(
      JSON.stringify({
        schemaVersion: 1,
        entries: [buildEntry("guide-1", 1), buildEntry("guide-2", 3)],
      }),
    );
    const integrity = await new GuidanceSubmissionJournal({
      baseDirectory: stateDirectory,
    }).readAllWithIntegrity();
    expect(integrity.isCorrupted).toBe(false);
    expect(integrity.entries).toHaveLength(2);
    expect(await new GuidanceSubmissionJournal({ baseDirectory: stateDirectory }).readAllStrict())
      .toHaveLength(2);
  });
});
