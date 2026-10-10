/**
 * RELIABILITY-01-02 · R4 反例（2026-10-10）：SDK 幂等账目损坏必须**响亮且 fail-closed**。
 *
 * 卡内/对账登记的缺口："**R4 SDK 幂等账目损坏处理**需返修"。
 *
 * 现状缺陷（本文件在实现前必须失败）：`loadTaskIdempotencyLedger()` 与
 * `parseTaskIdempotencyLedger()` 在**文件存在但损坏/结构非法**时一律返回 `[]`，
 * 与"账目不存在"**无法区分**。后果：重启后系统表现得像"从未受理过任何请求"，
 * 于是同一 `(sessionId, idempotencyKey)` 会被**再执行一次**并可能产生**重复副作用**
 * ——这正是幂等账目要防止的事。当前实现把"损坏"静默降级成"全新开始"。
 *
 * 期望语义（本轮要求）：
 *  - 账目文件**不存在** ⇒ 正常空账目，不报损坏；
 *  - 账目文件**存在但不可解析**（非法 JSON / schemaVersion 不符 / entries 非数组）⇒
 *    必须**响亮报告损坏**（携带原因与不可用条目数），且**不得**让调用方以为"没有历史"；
 *  - 单条**结构非法**的条目 ⇒ 必须计入"不可用条目数"（不得静默丢弃后当作干净账目）；
 *  - 解析函数对合法账目仍必须逐字段保真。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AstarrayApplicationFacade,
  loadTaskIdempotencyLedger,
  loadTaskIdempotencyLedgerWithIntegrity,
  parseTaskIdempotencyLedgerWithIntegrity,
} from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-r4-ledger-"));
});

afterEach(async () => {
  try {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

const ledgerFilePath = (): string =>
  path.join(stateDirectory, "task-idempotency-ledger.json");

const validLedgerText = (): string =>
  JSON.stringify({
    schemaVersion: 1,
    entries: [
      {
        sessionIdentifier: "session-1",
        idempotencyKey: "key-1",
        inputHash: "hash-1",
        taskIdentifier: "task-1",
        missionIdentifier: "mission-1",
        claimedAtIso: "2026-10-01T00:00:00.000Z",
        settledAtIso: "2026-10-01T00:00:05.000Z",
      },
    ],
  });

describe("RELIABILITY-01-02：幂等账目损坏集成", () => {
  it("① 账目文件不存在 ⇒ 正常空账目，不报损坏", async () => {
    const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
    expect(integrity.entries).toEqual([]);
    expect(integrity.isCorrupted).toBe(false);
    expect(integrity.corruptionReason).toBeNull();
    expect(integrity.unusableEntryCount).toBe(0);
    // 既有入口行为不变（仍然返回空账目）
    expect(await loadTaskIdempotencyLedger(stateDirectory)).toEqual([]);
  });

  it("② 非法 JSON ⇒ 必须响亮报告损坏（不得静默当作'没有历史'）", async () => {
    await fs.writeFile(ledgerFilePath(), "{ 这不是合法 JSON", "utf8");
    const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
    expect(integrity.isCorrupted).toBe(true);
    expect(integrity.corruptionReason).not.toBeNull();
    expect(integrity.entries).toEqual([]);
  });

  it("③ schemaVersion 不符 / entries 非数组 ⇒ 必须报告损坏", async () => {
    await fs.writeFile(
      ledgerFilePath(),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
      "utf8",
    );
    const schemaMismatch = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
    expect(schemaMismatch.isCorrupted).toBe(true);

    await fs.writeFile(
      ledgerFilePath(),
      JSON.stringify({ schemaVersion: 1, entries: "not-an-array" }),
      "utf8",
    );
    const entriesNotArray = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
    expect(entriesNotArray.isCorrupted).toBe(true);
  });

  it("④ 单条结构非法 ⇒ 计入不可用条目数（不得静默当成干净账目）", async () => {
    await fs.writeFile(
      ledgerFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            sessionIdentifier: "session-1",
            idempotencyKey: "key-1",
            inputHash: "hash-1",
            taskIdentifier: "task-1",
            missionIdentifier: null,
            claimedAtIso: "2026-10-01T00:00:00.000Z",
            settledAtIso: null,
          },
          { idempotencyKey: "missing-required-fields" },
          null,
        ],
      }),
      "utf8",
    );
    const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
    // 合法条目仍必须被保留（不能因为脏条目就丢弃好数据）
    expect(integrity.entries).toHaveLength(1);
    expect(integrity.entries[0]?.idempotencyKey).toBe("key-1");
    expect(integrity.unusableEntryCount).toBe(2);
    expect(integrity.isCorrupted).toBe(true);
  });

  it("⑤ 合法账目 ⇒ 逐字段保真且不报损坏", async () => {
    await fs.writeFile(ledgerFilePath(), validLedgerText(), "utf8");
    const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
    expect(integrity.isCorrupted).toBe(false);
    expect(integrity.unusableEntryCount).toBe(0);
    expect(integrity.entries).toEqual([
      {
        sessionIdentifier: "session-1",
        idempotencyKey: "key-1",
        inputHash: "hash-1",
        taskIdentifier: "task-1",
        missionIdentifier: "mission-1",
        claimedAtIso: "2026-10-01T00:00:00.000Z",
        settledAtIso: "2026-10-01T00:00:05.000Z",
      },
    ]);
  });

  it("⑥ 纯函数：损坏输入必须可判定，合法输入不报损坏", () => {
    const corrupted = parseTaskIdempotencyLedgerWithIntegrity("{ 坏");
    expect(corrupted.isCorrupted).toBe(true);
    expect(corrupted.entries).toEqual([]);

    const clean = parseTaskIdempotencyLedgerWithIntegrity(validLedgerText());
    expect(clean.isCorrupted).toBe(false);
    expect(clean.entries).toHaveLength(1);
    expect(clean.unusableEntryCount).toBe(0);
  });
});

describe("RELIABILITY-01-02：R4 损坏账目下的 create() 必须 fail-closed", () => {
  it("⑦ 损坏账目 ⇒ create 默认拒绝启动（idempotency-ledger-corrupted），不静默重复执行", async () => {
    await fs.writeFile(ledgerFilePath(), "{ 损坏的账目", "utf8");
    await expect(
      AstarrayApplicationFacade.create({
        stateDirectory,
        mode: "assist",
        runtime: "mock",
        concurrency: 1,
        failureThreshold: 3,
      }),
    ).rejects.toMatchObject({ errorCode: "idempotency-ledger-corrupted" });
  });

  it("⑧ 显式 allowCorruptedIdempotencyLedger=true ⇒ 允许启动（可解析条目保留）", async () => {
    await fs.writeFile(
      ledgerFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            sessionIdentifier: "session-1",
            idempotencyKey: "key-1",
            inputHash: "hash-1",
            taskIdentifier: "task-1",
            missionIdentifier: null,
            claimedAtIso: "2026-10-01T00:00:00.000Z",
            settledAtIso: null,
          },
          { idempotencyKey: "脏条目" },
        ],
      }),
      "utf8",
    );
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      concurrency: 1,
      failureThreshold: 3,
      allowCorruptedIdempotencyLedger: true,
    });
    await application.shutdown();
  });

  it("⑨ 账目不存在 ⇒ create 正常启动（全新安装不得被拒）", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      concurrency: 1,
      failureThreshold: 3,
    });
    await application.shutdown();
  });
});
