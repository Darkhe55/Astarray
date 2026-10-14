/**
 * GUI-02-03（2026-11-08）：**三视图**（列表/详情/原始）行为反例。
 *
 * 卡内原文：**历史列表及详情** —— **三视图**；分页按需加载；任务目标/项目/时间/最后状态/结果；
 * **历史状态与运行状态分离**；**查看不恢复、不调模型、不注入上下文**；损坏/无权记录明确处理。
 *
 * 三视图的语义分工（本文件钉住）：
 * - **列表视图**：每条只给"够扫一眼"的字段 + **分页控件**（绝不一次渲染全部）；
 * - **详情视图**：单条完整字段；
 * - **原始视图**：**未归一的原样记录**（供核对），用 `pre` 原样呈现。
 *
 * 贯穿三视图的硬约束：
 * ① **历史状态与运行状态分别呈现**（重启前 `running` 不得显示成运行中）；
 * ② **损坏明确标注**（不抛错、不静默丢弃）；
 * ③ **只读**：渲染过程不触发恢复/模型/上下文注入。
 */
import { describe, expect, it } from "vitest";

import {
  buildGuiMissionHistoryDetailView,
  buildGuiMissionHistoryListView,
  buildGuiMissionHistoryRawView,
} from "../../../packages/gui/src/application/gui-read-model.js";
import type { MissionHistoryEntry } from "../../../packages/core/src/public-sdk.js";

function entry(overrides: Partial<MissionHistoryEntry> = {}): MissionHistoryEntry {
  return {
    missionIdentifier: "mission-1",
    prompt: "把历史列出来",
    mode: "assist",
    projectIdentifier: "project-alpha",
    createdAtIso: "2026-11-01T00:00:00.000Z",
    recordedStatus: "done",
    runtimeState: "finished",
    isActivelyRunning: false,
    isCorrupted: false,
    ...overrides,
  };
}

function page(entries: MissionHistoryEntry[], overrides: Partial<{
  pageIndex: number;
  effectivePageSize: number;
  totalMissionCount: number;
  hasMorePages: boolean;
}> = {}) {
  return {
    entries,
    pageIndex: overrides.pageIndex ?? 0,
    effectivePageSize: overrides.effectivePageSize ?? 20,
    totalMissionCount: overrides.totalMissionCount ?? entries.length,
    hasMorePages: overrides.hasMorePages ?? false,
  };
}

describe("GUI-02-03 三视图：列表视图", () => {
  it("① 列表每行含卡内点名的五项（目标/项目/时间/最后状态/结果）", () => {
    const view = buildGuiMissionHistoryListView(page([entry()]));

    const row = view.rows[0]!;
    expect(row.promptText).toBe("把历史列出来");            // 任务目标
    expect(row.projectText).toBe("project-alpha");          // 项目
    expect(row.createdAtText).toBe("2026-11-01T00:00:00.000Z"); // 时间
    expect(row.recordedStatusText).toBe("已完成");           // 最后状态（历史）
    expect(row.runtimeStateText).toBe("已结束");             // 结果（运行态）
  });

  it("② 分页控件如实反映「本页/总数/还有更多」（且不一次渲染全部）", () => {
    const view = buildGuiMissionHistoryListView(
      page([entry({ missionIdentifier: "a" }), entry({ missionIdentifier: "b" })], {
        totalMissionCount: 97,
        hasMorePages: true,
        effectivePageSize: 2,
      }),
    );

    // 只渲染**本页** 2 行 —— 不是 97 行
    expect(view.rows).toHaveLength(2);
    expect(view.totalMissionCountText).toContain("97");
    expect(view.isMoreAvailable).toBe(true);
    expect(view.pagingLabel).toContain("2");
  });

  it("③ **历史状态与运行状态分列**：重启前 running 不得显示成运行中", () => {
    const view = buildGuiMissionHistoryListView(
      page([
        entry({
          missionIdentifier: "stale",
          recordedStatus: "running",
          runtimeState: "interrupted-needs-reconciliation",
          isActivelyRunning: false,
        }),
      ]),
    );

    const row = view.rows[0]!;
    // 历史那列如实写「运行中（当时记录）」
    expect(row.recordedStatusText).toContain("运行中");
    // 运行那列必须说"已中断/待对账"，**不得**再写「运行中」
    expect(row.runtimeStateText).toBe("已中断，待对账");
    expect(row.runtimeStateText).not.toBe(row.recordedStatusText);
    expect(row.isActivelyRunning).toBe(false);
  });

  it("④ 损坏条目在列表里**明确标注**且不消失", () => {
    const view = buildGuiMissionHistoryListView(
      page([
        entry({
          missionIdentifier: "broken",
          prompt: null,
          projectIdentifier: null,
          recordedStatus: null,
          runtimeState: "corrupted-needs-attention",
          isCorrupted: true,
        }),
        entry({ missionIdentifier: "fine" }),
      ]),
    );

    expect(view.rows).toHaveLength(2);
    const broken = view.rows.find((row) => row.missionIdentifier === "broken")!;
    expect(broken.isCorrupted).toBe(true);
    expect(broken.corruptedText).toBe("记录损坏");
    // 缺失字段要显示为「未知」，而不是空串（空串看起来像「有值但为空」）
    expect(broken.promptText).toBe("（未知）");
    expect(broken.projectText).toBe("（未知）");
  });

  it("⑤ 空历史 ⇒ 明确的空态文案（不是空白一片）", () => {
    const view = buildGuiMissionHistoryListView(page([]));
    expect(view.rows).toHaveLength(0);
    expect(view.emptyStateText.length).toBeGreaterThan(0);
  });
});

describe("GUI-02-03 三视图：详情视图", () => {
  it("⑥ 详情含全部展示字段，且历史/运行状态**分列**", () => {
    const view = buildGuiMissionHistoryDetailView(entry());

    expect(view.missionIdentifier).toBe("mission-1");
    expect(view.promptText).toBe("把历史列出来");
    expect(view.projectText).toBe("project-alpha");
    expect(view.createdAtText).toBe("2026-11-01T00:00:00.000Z");
    expect(view.recordedStatusText).toBe("已完成");
    expect(view.runtimeStateText).toBe("已结束");
  });

  it("⑦ 详情对**运行中**（租约确认）显示「运行中」，且与历史列一致但独立", () => {
    const view = buildGuiMissionHistoryDetailView(
      entry({ recordedStatus: "running", runtimeState: "running", isActivelyRunning: true }),
    );
    expect(view.recordedStatusText).toContain("运行中");
    expect(view.runtimeStateText).toBe("运行中");
    expect(view.isActivelyRunning).toBe(true);
  });

  it("⑧ 详情对**未知状态**如实显示「未知」（不猜测、不伪装）", () => {
    const view = buildGuiMissionHistoryDetailView(
      entry({ recordedStatus: null, runtimeState: "unknown" }),
    );
    expect(view.recordedStatusText).toBe("未知");
    expect(view.runtimeStateText).toBe("未知");
  });

  it("⑨ 详情对损坏条目**明确**说明，且缺失字段为「（未知）」", () => {
    const view = buildGuiMissionHistoryDetailView(
      entry({
        prompt: null,
        mode: null,
        projectIdentifier: null,
        createdAtIso: null,
        recordedStatus: null,
        runtimeState: "corrupted-needs-attention",
        isCorrupted: true,
      }),
    );
    expect(view.isCorrupted).toBe(true);
    expect(view.corruptedText).toBe("记录损坏");
    expect(view.promptText).toBe("（未知）");
    expect(view.projectText).toBe("（未知）");
    expect(view.createdAtText).toBe("（未知）");
  });
});

describe("GUI-02-03 三视图：原始视图", () => {
  it("⑩ 原始视图给出**未归一**的原样记录（供核对），且不改动运行态字段", () => {
    const view = buildGuiMissionHistoryRawView(
      entry({ recordedStatus: "running", runtimeState: "interrupted-needs-reconciliation" }),
    );

    // 原始记录里 recordedStatus 必须仍是磁盘原值
    expect(view.rawRecord["recordedStatus"]).toBe("running");
    // 且**同时**带上运行态（原始视图也不是"只给一半"）
    expect(view.rawRecord["runtimeState"]).toBe("interrupted-needs-reconciliation");
    // 序列化后必须是合法 JSON（原样呈现用）
    expect(() => JSON.parse(view.rawJsonText)).not.toThrow();
    expect(view.rawJsonText).toContain("mission-1");
  });

  it("⑪ 原始视图对损坏条目不抛错（照样能呈现）", () => {
    const view = buildGuiMissionHistoryRawView(
      entry({ recordedStatus: null, runtimeState: "corrupted-needs-attention", isCorrupted: true }),
    );
    expect(view.rawRecord["isCorrupted"]).toBe(true);
    expect(() => JSON.parse(view.rawJsonText)).not.toThrow();
  });

  it("⑫ 三个视图**都是纯函数产物**：同一输入渲染两次结果一致（无隐藏副作用/计时依赖）", () => {
    const target = entry({ recordedStatus: "running", runtimeState: "running", isActivelyRunning: true });

    const listOnce = JSON.stringify(buildGuiMissionHistoryListView(page([target])));
    const listTwice = JSON.stringify(buildGuiMissionHistoryListView(page([target])));
    expect(listTwice).toBe(listOnce);

    const detailOnce = JSON.stringify(buildGuiMissionHistoryDetailView(target));
    const detailTwice = JSON.stringify(buildGuiMissionHistoryDetailView(target));
    expect(detailTwice).toBe(detailOnce);

    const rawOnce = JSON.stringify(buildGuiMissionHistoryRawView(target));
    const rawTwice = JSON.stringify(buildGuiMissionHistoryRawView(target));
    expect(rawTwice).toBe(rawOnce);
  });
});
