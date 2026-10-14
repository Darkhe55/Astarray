/**
 * GUI-02-04（2026-11-08）：**恢复执行入口**反例（先红后绿）。
 *
 * 卡内要求：恢复须**显式** + **先对账** + **重新鉴权**。
 * 上一轮立了可测闸门与界面说明；本轮把**真正调用核心 `resumeMission` 的入口**接上，
 * 并钉住它**不会**在闸门未过时改状态。
 *
 * 关键不变量：
 * ① 未显式确认 ⇒ 返回 `recovery-not-explicitly-confirmed`，**且不调用核心恢复**
 *   （对不存在的 mission 也必须先报"未显式确认"，说明这道门在核心查找之前）；
 * ② 未知 mission ⇒ 明确拒绝（不得对未知 mission 执行恢复）；
 * ③ 门未过时**不得**把 mission 状态改成 running（查询前后状态一致）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

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
      prompt: "恢复入口反例",
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

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui0204-resume-"));
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

describe("GUI-02-04：恢复执行入口必须先过闸门", () => {
  it("① 未显式确认 ⇒ 明确拒绝，且**不触碰状态**", async () => {
    await writeMissionSummary("mission-needs-explicit", "running");
    const statusBefore = await readMissionStatus("mission-needs-explicit");

    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-needs-explicit",
      hasExplicitUserConfirmation: false,
    });

    expect(result.outcome).toBe("recovery-not-explicitly-confirmed");
    // **状态没被动过**：门未过就绝不能改状态
    expect(await readMissionStatus("mission-needs-explicit")).toBe(statusBefore);
  });

  it("② 显式门在核心查找**之前**：对不存在的 mission 也先报「未显式确认」", async () => {
    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-does-not-exist",
      hasExplicitUserConfirmation: false,
    });

    // 若先做核心查找，这里会变成 mission-not-found 类错误 —— 那就说明"显式"这道门形同虚设
    expect(result.outcome).toBe("recovery-not-explicitly-confirmed");
  });

  it("③ 已显式确认但 mission 未知 ⇒ 明确拒绝（不得对未知 mission 恢复）", async () => {
    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-unknown",
      hasExplicitUserConfirmation: true,
    });

    expect(result.outcome).toBe("recovery-blocked-by-core");
    if (result.outcome === "recovery-blocked-by-core") {
      expect(result.detail).toContain("恢复概览里没有该 mission");
      expect(result.blockedDecisionItems).toContain(
        "mission-not-found-in-recovery-overview",
      );
    }
  });

  it("④ 没有可信检查点 ⇒ 核心拒绝，**不得**报成已恢复（原样回报阻塞项）", async () => {
    // 造一条 running 的 mission，但**不**造检查点 ⇒ 核心应因 checkpoint-not-found 拒绝
    await writeMissionSummary("mission-no-checkpoint", "running");

    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-no-checkpoint",
      hasExplicitUserConfirmation: true,
    });

    expect(result.outcome).not.toBe("resumed");
    if (result.outcome === "recovery-blocked-by-core") {
      // 阻塞项**原样回报**（不美化）
      expect(result.blockedDecisionItems.length).toBeGreaterThan(0);
      expect(result.detail.length).toBeGreaterThan(0);
    } else {
      // 若核心给了别的终态（如已恢复），也要能读到详情字段 —— 断言它确实带 detail
      expect("detail" in result || result.outcome === "resumed").toBe(true);
    }
    // 无论如何：状态不得被改成"已恢复"
    const statusAfter = await readMissionStatus("mission-no-checkpoint");
    expect(["running", "blocked", "failed", "cancelled", "done"]).toContain(statusAfter);
  });

  it("⑤ 已终态（done）⇒ 不得被恢复（核心拒绝重复执行）", async () => {
    await writeMissionSummary("mission-done", "done");

    const result = await application.resumeRecoveredMission({
      missionIdentifier: "mission-done",
      hasExplicitUserConfirmation: true,
    });

    expect(result.outcome).not.toBe("resumed");
    // 终态保持不变
    expect(await readMissionStatus("mission-done")).toBe("done");
  });
});
