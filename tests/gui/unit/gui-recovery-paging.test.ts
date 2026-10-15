/**
 * GUI-02-03/04（2026-11-08）：**恢复中心分页 + 可恢复项优先** 反例（先红后绿）。
 *
 * ## 为什么做（真实人工体验暴露）
 *
 * 用户实测时 `/recovery` 一次返回 **103** 条，其中**只有 1 条可恢复**（102:1），
 * 且它按字典序埋在中间 ⇒ 用户**肉眼找不到**，报"所有项目都暂不可恢复"。
 * 卡片 L60/L77 明文要求「**分页、按需加载**：不得一次读取全部 97 个 mission」。
 *
 * ## 本文件钉住的不变量
 *
 * ① 一页**只给当页条目**（103 条取一页**不得**返回 103 条）；
 * ② **可恢复项排在最前**（否则可恢复项会被上百条禁用项淹没）；
 * ③ 两组**各自保持原有相对顺序**（稳定排序，不制造随机性）；
 * ④ 给出可翻译成界面文案的**计数**（总数／可恢复数）；
 * ⑤ 越界页索引 ⇒ **空页 + 明确标志**，不抛错、不悄悄回到第一页；
 * ⑥ 页大小有**硬上限**（防"用超大 pageSize 绕过按需加载"）；
 * ⑦ 纯函数：**不改动传入的数组**（不得靠 sort 原地改调用方数据）。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GUI_RECOVERY_PAGE_SIZE,
  MAXIMUM_GUI_RECOVERY_PAGE_SIZE,
  buildGuiRecoveryMissionPageView,
} from "../../../packages/gui/src/application/gui-read-model.js";

interface MissionInput {
  missionIdentifier: string;
  status: string | null;
  isCorrupted: boolean;
  hasTrustedCheckpoint: boolean;
  isLeaseActive: boolean;
}

/** 造一个"不可恢复"的 mission（无可信检查点 ⇒ 与实测中那 102 条同形）。 */
function blockedMission(missionIdentifier: string): MissionInput {
  return {
    missionIdentifier,
    status: "done",
    isCorrupted: false,
    hasTrustedCheckpoint: false,
    isLeaseActive: false,
  };
}

/** 造一个"可恢复"的 mission（仍在跑 + 有可信检查点 + 未损坏）。 */
function recoverableMission(missionIdentifier: string): MissionInput {
  return {
    missionIdentifier,
    status: "running",
    isCorrupted: false,
    hasTrustedCheckpoint: true,
    isLeaseActive: false,
  };
}

describe("恢复中心分页：一页只给当页条目", () => {
  it("① 103 条取第一页 ⇒ 只返回一页的条目（不得返回全部）", () => {
    const missions = Array.from({ length: 103 }, (_unused, index) =>
      blockedMission("mission-" + String(index).padStart(4, "0")),
    );
    const page = buildGuiRecoveryMissionPageView({ missions, pageIndex: 0 });

    // 这是本轮的核心断言：曾经这里一次返回 103 条
    expect(page.rows.length).toBeLessThanOrEqual(DEFAULT_GUI_RECOVERY_PAGE_SIZE);
    expect(page.rows.length).toBe(DEFAULT_GUI_RECOVERY_PAGE_SIZE);
    expect(page.totalMissionCount).toBe(103);
    expect(page.isOutOfRange).toBe(false);
  });

  it("② 可恢复项必须排在**最前**（否则会被上百条禁用项淹没）", () => {
    const missions: MissionInput[] = [
      ...Array.from({ length: 40 }, (_unused, index) =>
        blockedMission("blocked-" + String(index).padStart(3, "0")),
      ),
      recoverableMission("recoverable-zzz"),
    ];
    const page = buildGuiRecoveryMissionPageView({ missions, pageIndex: 0 });

    expect(page.rows[0]?.missionIdentifier).toBe("recoverable-zzz");
    expect(page.rows[0]?.isRecoverable).toBe(true);
    expect(page.recoverableMissionCount).toBe(1);
  });

  it("③ 两组**各自保持原有相对顺序**（稳定排序，不制造随机性）", () => {
    const missions: MissionInput[] = [
      blockedMission("b-1"),
      recoverableMission("r-1"),
      blockedMission("b-2"),
      recoverableMission("r-2"),
      blockedMission("b-3"),
    ];
    const page = buildGuiRecoveryMissionPageView({ missions, pageIndex: 0 });

    expect(page.rows.map((row) => row.missionIdentifier)).toEqual([
      "r-1",
      "r-2",
      "b-1",
      "b-2",
      "b-3",
    ]);
  });

  it("④ 给出可翻译成界面文案的计数（总数／可恢复数）", () => {
    const missions: MissionInput[] = [
      recoverableMission("r-a"),
      blockedMission("b-a"),
      blockedMission("b-b"),
    ];
    const page = buildGuiRecoveryMissionPageView({ missions, pageIndex: 0 });

    expect(page.totalMissionCount).toBe(3);
    expect(page.recoverableMissionCount).toBe(1);
  });
});

describe("恢复中心分页：边界与自证", () => {
  it("⑤ 越界页索引 ⇒ 空页 + 明确标志（不抛错、也不悄悄回到第一页）", () => {
    const missions = Array.from({ length: 5 }, (_unused, index) =>
      blockedMission("m-" + String(index)),
    );
    const page = buildGuiRecoveryMissionPageView({
      missions,
      pageIndex: 9,
      pageSize: 2,
    });

    expect(page.rows).toEqual([]);
    expect(page.isOutOfRange).toBe(true);
    // 不得"顺手"返回第一页 —— 那会让用户以为翻到了内容
    expect(page.rows.length).toBe(0);
  });

  it("⑥ 页大小有硬上限（不得用超大 pageSize 绕过按需加载）", () => {
    const missions = Array.from({ length: 150 }, (_unused, index) =>
      blockedMission("m-" + String(index).padStart(4, "0")),
    );
    const page = buildGuiRecoveryMissionPageView({
      missions,
      pageIndex: 0,
      pageSize: 100_000,
    });

    expect(page.effectivePageSize).toBe(MAXIMUM_GUI_RECOVERY_PAGE_SIZE);
    expect(page.rows.length).toBeLessThanOrEqual(MAXIMUM_GUI_RECOVERY_PAGE_SIZE);
  });

  it("⑦ 纯函数：**不得原地改动**传入的数组（否则调用方数据被悄悄重排）", () => {
    const missions: MissionInput[] = [
      blockedMission("b-1"),
      recoverableMission("r-1"),
    ];
    const before = missions.map((mission) => mission.missionIdentifier);
    buildGuiRecoveryMissionPageView({ missions, pageIndex: 0 });

    expect(missions.map((mission) => mission.missionIdentifier)).toEqual(before);
  });

  it("⑧ 非法页大小/页索引 ⇒ 明确拒绝（不静默取默认值）", () => {
    const missions = [blockedMission("m-0")];
    expect(() =>
      buildGuiRecoveryMissionPageView({ missions, pageIndex: 0, pageSize: 0 }),
    ).toThrow();
    expect(() =>
      buildGuiRecoveryMissionPageView({ missions, pageIndex: -1 }),
    ).toThrow();
    expect(() =>
      buildGuiRecoveryMissionPageView({ missions, pageIndex: 1.5 }),
    ).toThrow();
  });

  it("⑨ 每条都带**可恢复性判定与原因**（界面据此禁用按钮并写明原因）", () => {
    const missions: MissionInput[] = [
      {
        missionIdentifier: "corrupted",
        status: "running",
        isCorrupted: true,
        hasTrustedCheckpoint: true,
        isLeaseActive: false,
      },
      {
        missionIdentifier: "no-checkpoint",
        status: "running",
        isCorrupted: false,
        hasTrustedCheckpoint: false,
        isLeaseActive: false,
      },
      {
        missionIdentifier: "lease-active",
        status: "running",
        isCorrupted: false,
        hasTrustedCheckpoint: true,
        isLeaseActive: true,
      },
      {
        missionIdentifier: "terminal",
        status: "done",
        isCorrupted: false,
        hasTrustedCheckpoint: true,
        isLeaseActive: false,
      },
    ];
    const page = buildGuiRecoveryMissionPageView({ missions, pageIndex: 0 });
    const byIdentifier = new Map(
      page.rows.map((row) => [row.missionIdentifier, row]),
    );

    // 四个都不可恢复，但**原因必须各不相同**（不能一律"暂不可恢复"了事）
    expect(byIdentifier.get("corrupted")?.isRecoverable).toBe(false);
    expect(byIdentifier.get("no-checkpoint")?.isRecoverable).toBe(false);
    expect(byIdentifier.get("lease-active")?.isRecoverable).toBe(false);
    expect(byIdentifier.get("terminal")?.isRecoverable).toBe(false);

    const reasons = [
      byIdentifier.get("corrupted")?.blockedReasonText,
      byIdentifier.get("no-checkpoint")?.blockedReasonText,
      byIdentifier.get("lease-active")?.blockedReasonText,
      byIdentifier.get("terminal")?.blockedReasonText,
    ];
    expect(new Set(reasons).size).toBe(4);
    for (const reason of reasons) {
      expect(typeof reason).toBe("string");
      expect((reason ?? "").length).toBeGreaterThan(0);
    }
  });
});
