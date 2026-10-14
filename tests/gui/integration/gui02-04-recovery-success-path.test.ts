/**
 * GUI-02-04（2026-11-08，第 51 轮）：恢复的**成功路径**端到端（先红后绿）。
 *
 * ## 为什么补这一条
 *
 * 前几轮的反例覆盖的是**各道门的拒绝**与"不得误报已恢复"，
 * 但**没有**一条走到 `resumed: true`。缺了它，就无法证明：
 * - 门全过之后**真的**会恢复；
 * - 恢复后 mission 状态**真的**从"（重启后仍是）running"被正确地重新落定；
 * - 且**同一 mission 在未显式确认时不会被恢复**（对照组，证明这道门确实在起作用）。
 *
 * ## 做法
 *
 * 用与生产同一套 `RecoveryCheckpointStore` 写入一个**可信检查点**
 * （走它的 `writeCheckpoint`，从而带上真实的哈希链），
 * 再用公共门面 `resumeRecoveredMission` 走完整路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { makeRecoveryCheckpoint } from "../../support/recovery-checkpoint-fixture.js";

let stateDirectory: string;
let application: AstarrayApplicationFacade;

async function writeMissionSummary(
  missionIdentifier: string,
  status: string,
): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectory, "summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: missionIdentifier,
      mode: "assist",
      prompt: "恢复成功路径",
      createdAtIso: "2026-11-01T00:00:00.000Z",
      status,
    }),
    "utf8",
  );
}

async function readMissionStatus(missionIdentifier: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(stateDirectory, "missions", missionIdentifier, "summary.json"),
      "utf8",
    );
    return (JSON.parse(raw) as { status?: string }).status ?? null;
  } catch {
    return null;
  }
}

/** 写一个**可信**检查点（走生产 store，带真实哈希链）。 */
async function writeTrustedCheckpoint(missionIdentifier: string): Promise<void> {
  const store = new RecoveryCheckpointStore({ baseDirectory: stateDirectory });
  await store.writeCheckpoint({
    checkpoint: makeRecoveryCheckpoint(missionIdentifier),
    writingProcessInstanceIdentifier: "process-previous",
  });
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui0204-success-"));
  application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
});

afterEach(async () => {
  await application.shutdown();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("GUI-02-04：恢复的**成功路径**（门全过 ⇒ 真的恢复）", () => {
  it("① 有可信检查点 + 显式确认 + 无需对账 ⇒ `resumed: true`，且状态被重新落定为运行中", async () => {
    await writeMissionSummary("mission-resumable", "running");
    await writeTrustedCheckpoint("mission-resumable");

    // 先确认只读概览**看得到**这个可信检查点（否则下面的成功无从谈起）
    const overview = await application.queryRecoveryOverview();
    const missionView = overview.missions.find(
      (mission) => mission.missionIdentifier === "mission-resumable",
    );
    expect(missionView).toBeDefined();
    expect(missionView?.hasTrustedCheckpoint).toBe(true);

    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-resumable",
      hasExplicitUserConfirmation: true,
    });

    expect(result.outcome).toBe("resumed");
    if (result.outcome === "resumed") {
      // 恢复结果要如实带出"需重新鉴权项"（可能是空数组）
      expect(Array.isArray(result.requiredReauthorizationTypes)).toBe(true);
      expect(Array.isArray(result.recoveredSafeNodes)).toBe(true);
    }
    // 状态被重新落定（核心在成功路径上会 updateMissionStatus(..., "running")）
    expect(await readMissionStatus("mission-resumable")).toBe("running");
  });

  it("② 【对照组】同一个可恢复 mission，**未显式确认**时绝不恢复", async () => {
    await writeMissionSummary("mission-control", "running");
    await writeTrustedCheckpoint("mission-control");

    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-control",
      hasExplicitUserConfirmation: false,
    });

    // 门没过 ⇒ 不得是 resumed
    expect(result.outcome).toBe("recovery-not-explicitly-confirmed");
    expect(result.outcome).not.toBe("resumed");
  });

  it("③ 成功后**再查概览**：该 mission 的恢复事实与状态一致（不留「看起来还在待恢复」的假象）", async () => {
    await writeMissionSummary("mission-after", "running");
    await writeTrustedCheckpoint("mission-after");

    const resumeResult = await application.resumeRecoveredMission({
      missionIdentifier: "mission-after",
      hasExplicitUserConfirmation: true,
    });
    expect(resumeResult.outcome).toBe("resumed");

    const overviewAfter = await application.queryRecoveryOverview();
    const viewAfter = overviewAfter.missions.find(
      (mission) => mission.missionIdentifier === "mission-after",
    );
    expect(viewAfter).toBeDefined();
    // 状态如实（running），且仍能看到可信检查点
    expect(viewAfter?.status).toBe("running");
    expect(viewAfter?.hasTrustedCheckpoint).toBe(true);
  });
});
