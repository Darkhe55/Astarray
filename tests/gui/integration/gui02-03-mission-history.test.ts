/**
 * GUI-02-03（2026-11-08）：历史列表与详情 —— **行为反例先行**。
 *
 * ## 卡内检查点原文
 *
 * | **GUI-02-03** | **历史列表及详情** —— 三视图；分页按需加载（**不得全量读 97 mission**）；
 * 任务目标/项目/时间/最后状态/结果；**历史状态与运行状态分离**；
 * **查看不恢复、不调模型、不注入上下文**；损坏/无权记录明确处理
 * | 反例：**不得全量加载**；**重启前 `running` 不得显示为运行中**；查看历史后**无模型调用与无恢复** |
 *
 * ## 本文件钉住的不变量
 *
 * ① **分页按需**：取一页只读**该页**的 `summary.json`，绝不把全部 mission 读进内存；
 * ② **历史状态 ≠ 运行状态**：磁盘上写着 `running` 只说明"**当时**在跑"，
 *    重启后不得显示为"正在运行" ⇒ 必须与运行态字段分开呈现；
 * ③ **查看不恢复、不调模型、不注入上下文**：只读路径不得触发恢复、不得调用 Provider；
 * ④ **损坏记录明确处理**：坏 JSON / 越界 missionId 必须被**标注**，而不是抛错或静默丢弃。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MISSION_HISTORY_PAGE_SIZE,
  MAXIMUM_MISSION_HISTORY_PAGE_SIZE,
  queryMissionHistory,
} from "../../../packages/core/src/gui/mission-history-reader.js";

let stateDirectory: string;

/** 写一个合法的 mission 目录（`missions/<id>/summary.json`）。 */
async function writeMissionSummary(
  missionIdentifier: string,
  summary: {
    mode?: string;
    prompt?: string;
    createdAtIso?: string;
    status?: string;
  } = {},
): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectory, "summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: missionIdentifier,
      mode: summary.mode ?? "assist",
      prompt: summary.prompt ?? "任务目标 " + missionIdentifier,
      createdAtIso: summary.createdAtIso ?? "2026-11-01T00:00:00.000Z",
      status: summary.status ?? "done",
    }),
    "utf8",
  );
}

/** 写一个损坏的 mission 目录（summary.json 不是合法 JSON）。 */
async function writeCorruptedMission(missionIdentifier: string): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(path.join(missionDirectory, "summary.json"), "{ 坏掉的 JSON", "utf8");
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui0203-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("GUI-02-03：分页按需加载（**不得全量读 97 mission**）", () => {
  it("① 有 97 个 mission 时，取一页**只读该页**的 summary.json（绝不读全部）", async () => {
    const missionIdentifiers: string[] = [];
    for (let index = 0; index < 97; index += 1) {
      const identifier = "mission-" + String(index).padStart(3, "0");
      missionIdentifiers.push(identifier);
      await writeMissionSummary(identifier, {
        // 让排序可预测：编号越大越新
        createdAtIso: "2026-11-01T00:00:" + String(index % 60).padStart(2, "0") + ".000Z",
      });
    }

    const readPaths: string[] = [];
    const page = await queryMissionHistory({
      stateDirectory,
      pageSize: 10,
      pageIndex: 0,
      onSummaryRead: (summaryPath) => readPaths.push(summaryPath),
    });

    expect(page.entries).toHaveLength(10);
    // **核心断言：只读了本页 10 条**，而不是 97 条
    expect(readPaths).toHaveLength(10);
    expect(page.totalMissionCount).toBe(97);
    expect(page.hasMorePages).toBe(true);
  });

  it("② 页大小有上限；越界/非法请求必须拒绝（不静默返回全部）", async () => {
    await writeMissionSummary("mission-only");

    // 超过上限 ⇒ 夹到上限（不是按请求量返回）
    const clamped = await queryMissionHistory({
      stateDirectory,
      pageSize: MAXIMUM_MISSION_HISTORY_PAGE_SIZE + 500,
      pageIndex: 0,
    });
    expect(clamped.effectivePageSize).toBe(MAXIMUM_MISSION_HISTORY_PAGE_SIZE);

    // 非法页大小 / 页号 ⇒ 明确拒绝
    await expect(
      queryMissionHistory({ stateDirectory, pageSize: 0, pageIndex: 0 }),
    ).rejects.toThrow();
    await expect(
      queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: -1 }),
    ).rejects.toThrow();
    await expect(
      queryMissionHistory({ stateDirectory, pageSize: 2.5, pageIndex: 0 }),
    ).rejects.toThrow();
  });

  it("③ 翻页不重不漏：第 0/1/2 页拼起来恰好是全部（且每页仍需按需读取）", async () => {
    for (let index = 0; index < 25; index += 1) {
      await writeMissionSummary("mission-" + String(index).padStart(3, "0"));
    }

    const collected: string[] = [];
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex });
      expect(page.entries.length).toBeLessThanOrEqual(10);
      collected.push(...page.entries.map((entry) => entry.missionIdentifier));
    }

    expect(collected).toHaveLength(25);
    expect(new Set(collected).size).toBe(25);
  });

  it("④ 空目录 ⇒ 空页且不报错（不是异常）", async () => {
    await fs.mkdir(path.join(stateDirectory, "missions"), { recursive: true });

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    expect(page.entries).toEqual([]);
    expect(page.totalMissionCount).toBe(0);
    expect(page.hasMorePages).toBe(false);
  });
});

describe("GUI-02-03：**历史状态与运行状态分离**（重启前 running 不得显示为运行中）", () => {
  it("⑤ 磁盘 summary 写 running、但**没有活跃租约** ⇒ 必须呈现为「已中断/待对账」，而不是运行中", async () => {
    await writeMissionSummary("mission-stale", { status: "running" });

    const page = await queryMissionHistory({
      stateDirectory,
      pageSize: 10,
      pageIndex: 0,
      // 运行态来源：本进程不认识任何活跃 mission（等价于"重启后"）
      isMissionActivelyRunning: () => false,
    });

    const entry = page.entries[0]!;
    // ① 历史状态**如实保留**磁盘上的 running（不篡改历史）
    expect(entry.recordedStatus).toBe("running");
    // ② 但运行态字段必须说明"它现在没有在跑"
    expect(entry.isActivelyRunning).toBe(false);
    // ③ 且给出便于人读的判定
    expect(entry.runtimeState).toBe("interrupted-needs-reconciliation");
  });

  it("⑥ 磁盘 running **且有活跃租约** ⇒ 才可呈现为运行中", async () => {
    await writeMissionSummary("mission-live", { status: "running" });

    const page = await queryMissionHistory({
      stateDirectory,
      pageSize: 10,
      pageIndex: 0,
      isMissionActivelyRunning: (missionIdentifier) => missionIdentifier === "mission-live",
    });

    const entry = page.entries[0]!;
    expect(entry.recordedStatus).toBe("running");
    expect(entry.isActivelyRunning).toBe(true);
    expect(entry.runtimeState).toBe("running");
  });

  it("⑦ 已终态（done/blocked/cancelled）不受运行态影响，且不会自称运行中", async () => {
    await writeMissionSummary("mission-done", { status: "done" });
    await writeMissionSummary("mission-blocked", { status: "blocked" });

    const page = await queryMissionHistory({
      stateDirectory,
      pageSize: 10,
      pageIndex: 0,
      // 即便运行态查询说"在跑"，已终态也不得翻回运行中
      isMissionActivelyRunning: () => true,
    });

    for (const entry of page.entries) {
      expect(entry.isActivelyRunning).toBe(false);
      expect(entry.runtimeState).not.toBe("running");
    }
  });
});

describe("GUI-02-03：只读查看**不恢复、不调模型、不注入上下文**", () => {
  it("⑧ 查看历史全程**不触碰运行态之外的东西**：不调恢复、不调模型（用探针接口断言零调用）", async () => {
    await writeMissionSummary("mission-a", { status: "running" });
    await writeMissionSummary("mission-b", { status: "done" });

    const recoveryCalls: string[] = [];
    const modelCalls: string[] = [];
    const contextInjectionCalls: string[] = [];

    await queryMissionHistory({
      stateDirectory,
      pageSize: 10,
      pageIndex: 0,
      isMissionActivelyRunning: () => false,
      // 这三个端口**故意**做成"一被调用就记录"：
      // 只读查看不允许触发它们
      requestRecovery: (missionIdentifier) => recoveryCalls.push(missionIdentifier),
      invokeModel: (purpose) => modelCalls.push(purpose),
      injectContext: (missionIdentifier) => contextInjectionCalls.push(missionIdentifier),
    });

    expect(recoveryCalls).toEqual([]);
    expect(modelCalls).toEqual([]);
    expect(contextInjectionCalls).toEqual([]);
  });

  it("⑨ 返回条目只含**展示所需字段**，不得携带可注入上下文的正文", async () => {
    await writeMissionSummary("mission-min", { prompt: "只读展示用目标" });

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });
    const entry = page.entries[0]!;

    // 必须有的展示字段
    expect(entry.missionIdentifier).toBe("mission-min");
    expect(entry.prompt).toBe("只读展示用目标");
    expect(typeof entry.createdAtIso).toBe("string");
    expect(entry.recordedStatus).toBe("done");
    // **不得**夹带会话/上下文正文类字段
    const keys = Object.keys(entry);
    expect(keys).not.toContain("contextPayload");
    expect(keys).not.toContain("conversationTranscript");
    expect(keys).not.toContain("injectedContext");
  });

  it("⑩ 默认页大小是保守值（不是「全都要」）", async () => {
    expect(DEFAULT_MISSION_HISTORY_PAGE_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_MISSION_HISTORY_PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});

describe("GUI-02-03：损坏/**无权**记录必须明确处理（不抛错、不静默丢弃）", () => {
  it("⑪ summary.json 损坏 ⇒ 该条被**标注**为损坏并保留在列表中（不抛错、不消失）", async () => {
    await writeMissionSummary("mission-good", { status: "done" });
    await writeCorruptedMission("mission-corrupted");

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    // 两条都要在（损坏不等于删除）
    expect(page.totalMissionCount).toBe(2);
    const corrupted = page.entries.find(
      (entry) => entry.missionIdentifier === "mission-corrupted",
    );
    expect(corrupted).toBeDefined();
    expect(corrupted?.isCorrupted).toBe(true);
    expect(corrupted?.runtimeState).toBe("corrupted-needs-attention");
    // 损坏时不得伪造状态
    expect(corrupted?.recordedStatus).toBeNull();
    // 正常那条不受影响
    const good = page.entries.find((entry) => entry.missionIdentifier === "mission-good");
    expect(good?.isCorrupted).toBe(false);
  });

  it("⑫ 缺少 summary.json 的 mission 目录同样被标注（不是静默跳过）", async () => {
    await fs.mkdir(path.join(stateDirectory, "missions", "mission-no-summary"), {
      recursive: true,
    });

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    expect(page.totalMissionCount).toBe(1);
    const entry = page.entries[0]!;
    expect(entry.isCorrupted).toBe(true);
    expect(entry.recordedStatus).toBeNull();
  });

  it("⑬ 越界 missionId（含路径穿越）必须被拒绝，不得读到 missions 目录之外", async () => {
    await writeMissionSummary("mission-safe");

    // 目录名里带路径穿越 ⇒ 必须被拒绝（而不是去读别处）
    const page = await queryMissionHistory({
      stateDirectory,
      pageSize: 10,
      pageIndex: 0,
      afterMissionIdentifier: "../../etc",
    });
    // 游标指向不存在的 mission ⇒ 返回空页（绝不越界读取）
    expect(page.entries).toEqual([]);
  });

  it("⑭ 目录名含 `.`／`..`／`:` 时必须**不被当作 mission**（防穿越）", async () => {
    await writeMissionSummary("mission-real");

    const missionsDirectory = path.join(stateDirectory, "missions");
    // 这些名字若被当成 missionId 拼进路径，就可能越界读；必须被过滤掉
    for (const unsafeName of [".", "..", "has:colon"]) {
      await fs.mkdir(path.join(missionsDirectory, unsafeName), { recursive: true }).catch(
        () => undefined,
      );
    }

    const page = await queryMissionHistory({ stateDirectory, pageSize: 50, pageIndex: 0 });

    // 只有真实那一条；历史里不得出现任何可疑目录名
    expect(page.totalMissionCount).toBe(1);
    expect(page.entries.map((entry) => entry.missionIdentifier)).toEqual(["mission-real"]);
  });

  it("⑭-b 名字带**路径分隔符**的目录绝不能被当作 mission（否则 os.tmpdir 下会多出目录）", async () => {
    /**
     * 实测教训：在 Windows 上 `fs.mkdir(path.join(base, "with\\backslash"))` 里
     * `\` 是**路径分隔符** ⇒ 实际建出的是 `base/with/backslash`（子目录），
     * 于是 `readdir(base)` 只会看到安全的 `with`。
     * 本用例因此改为直接断言**真实后果**：不该因为过滤不当而在临时目录里凭空建出/认领目录。
     */
    await writeMissionSummary("mission-only-real");
    const siblingOutsideMissions = path.join(stateDirectory, "not-a-mission");
    await fs.mkdir(siblingOutsideMissions, { recursive: true });

    const page = await queryMissionHistory({ stateDirectory, pageSize: 50, pageIndex: 0 });

    // `missions/` **之外**的目录绝不能被算作 mission（这正是路径穿越会造成的后果）
    expect(page.entries.map((entry) => entry.missionIdentifier)).toEqual(["mission-only-real"]);
    expect(await fs.readdir(path.join(stateDirectory, "missions"))).toEqual(["mission-only-real"]);
  });

  it("⑮ missions 目录不存在 ⇒ 空页（视为「还没有任何 mission」，不是错误）", async () => {
    // 注意：**不创建** missions 目录
    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    expect(page.entries).toEqual([]);
    expect(page.totalMissionCount).toBe(0);
  });

  it("⑯ summary.json **不可读**（存在但不是文件）⇒ 同样标注损坏（不抛错）", async () => {
    const missionDirectory = path.join(stateDirectory, "missions", "mission-unreadable");
    await fs.mkdir(path.join(missionDirectory, "summary.json"), { recursive: true });

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    const entry = page.entries[0]!;
    expect(entry.isCorrupted).toBe(true);
    expect(entry.recordedStatus).toBeNull();
    expect(entry.runtimeState).toBe("corrupted-needs-attention");
  });

  it("⑰ summary.json 是**合法 JSON 但不是对象**（数组）⇒ 标注损坏，不抛错", async () => {
    const missionDirectory = path.join(stateDirectory, "missions", "mission-array-summary");
    await fs.mkdir(missionDirectory, { recursive: true });
    await fs.writeFile(path.join(missionDirectory, "summary.json"), "[1,2,3]", "utf8");

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    const entry = page.entries[0]!;
    // 数组是合法 JSON，但形状不对 ⇒ 必须判为损坏，而不是当成合法 summary
    expect(entry.isCorrupted).toBe(true);
    expect(entry.prompt).toBeNull();
  });

  it("⑱ **不认识的** status 值 ⇒ 历史保留为 null 且运行态为 unknown（不猜测、不伪装）", async () => {
    await writeMissionSummary("mission-unknown-status", { status: "some-future-status" });

    const page = await queryMissionHistory({ stateDirectory, pageSize: 10, pageIndex: 0 });

    const entry = page.entries[0]!;
    expect(entry.recordedStatus).toBeNull();
    expect(entry.runtimeState).toBe("unknown");
    // 记录本身是好的，只是状态不认识 ⇒ 不标损坏、也不谎称在跑
    expect(entry.isCorrupted).toBe(false);
    expect(entry.isActivelyRunning).toBe(false);
  });
});
