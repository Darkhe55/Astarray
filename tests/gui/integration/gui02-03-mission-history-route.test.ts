/**
 * GUI-02-03（2026-11-08）：**历史只读路由**反例（先红后绿）。
 *
 * 卡内要点落到路由层的可证伪断言：
 * - **只读**：只接受 `GET`（查看历史不产生副作用）；
 * - **分页按需**：`pageSize`/`pageIndex` 透传，且**页大小上限由核心层强制**；
 * - **非法分页参数 ⇒ 400**（不静默夹成"全部"）；
 * - **能力缺失 ⇒ 501**（不静默降级成空列表）；
 * - **历史状态与运行状态分离**：重启后磁盘写着 `running` 的 mission
 *   在路由返回里必须是 `isActivelyRunning=false` 且
 *   `runtimeState="interrupted-needs-reconciliation"`。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

let stateDirectory: string;
let application: AstarrayApplicationFacade;
let port: number;
let handle: { close(): Promise<void> } | null;

function request(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
        headers: input.headers ?? {},
      },
      (incoming) => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          text += chunk;
        });
        incoming.on("end", () => resolve({ statusCode: incoming.statusCode ?? 0, body: text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** 直接按磁盘布局写一个 mission 摘要（模拟"进程曾跑过这些任务"）。 */
async function writeMissionSummary(
  missionIdentifier: string,
  summary: { status?: string; prompt?: string; projectIdentifier?: string } = {},
): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectory, "summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: missionIdentifier,
      mode: "assist",
      prompt: summary.prompt ?? "历史任务 " + missionIdentifier,
      createdAtIso: "2026-11-01T00:00:00.000Z",
      status: summary.status ?? "done",
      ...(summary.projectIdentifier === undefined
        ? {}
        : { projectIdentifier: summary.projectIdentifier }),
    }),
    "utf8",
  );
}

async function startServerWithHistory(): Promise<void> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  application = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory,
  });
  application.createSession({ sessionId: "session-gui02-03", mode: "assist" });
  /**
   * ⚠️ 必须**先取出原始方法**再包装。
   *
   * 首版写成 `Object.assign(application, { queryMissionHistory: (i) => application.queryMissionHistory(i) })`
   * —— 那是**把方法指向它自己**（`Object.assign` 立刻覆盖了同名方法），
   * 造成**无限递归** ⇒ 路由侧被 catch 成 **500**。
   * 实测现象：`expected 500 to be 200`。这是我的测试写法错误，不是路由缺陷。
   */
  const originalQueryMissionHistory = application.queryMissionHistory.bind(application);
  const created = await startGuiServer({
    applicationService: Object.assign(application, {
      queryMissionHistory: (historyInput: {
        pageSize?: number;
        pageIndex?: number;
        afterMissionIdentifier?: string;
      }) => originalQueryMissionHistory(historyInput),
    }),
    // 与既有 GUI 路由用例同口径：`GuiApplicationPort` 只声明界面需要的能力子集，
    // 真实门面比它更宽，故此处按既有约定断言。
  } as never);
  handle = created;
  port = created.port;
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui0203-route-"));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("GUI-02-03：历史只读路由", () => {
  it("① GET /mission-history ⇒ 200，返回分页视图（含 totalMissionCount/hasMorePages）", async () => {
    await writeMissionSummary("mission-1", { projectIdentifier: "project-alpha" });
    await writeMissionSummary("mission-2");
    await startServerWithHistory();

    const response = await request({ method: "GET", path: "/mission-history?pageSize=1&pageIndex=0" });

    expect(response.statusCode).toBe(200);
    /**
     * 注意：路由返回的是**已归一的视图**（`rows`，含 `*Text` 展示字段）——
     * 视图在**服务端**构建，客户端不自己拼状态标签（单一事实来源）。
     */
    const parsed = JSON.parse(response.body) as {
      rows: Array<Record<string, unknown>>;
      pageIndex: number;
      effectivePageSize: number;
      totalMissionCount: number;
      isMoreAvailable: boolean;
    };
    // **分页按需**：只要 1 条
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.effectivePageSize).toBe(1);
    expect(parsed.totalMissionCount).toBe(2);
    expect(parsed.isMoreAvailable).toBe(true);
  });

  it("② 页大小请求超过上限 ⇒ 被**夹到上限**（不得按请求量返回全部）", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeMissionSummary("mission-" + String(index));
    }
    await startServerWithHistory();

    const response = await request({
      method: "GET",
      path: "/mission-history?pageSize=100000&pageIndex=0",
    });

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body) as { effectivePageSize: number };
    // 上限由核心层强制（见 MAXIMUM_MISSION_HISTORY_PAGE_SIZE）
    expect(parsed.effectivePageSize).toBe(100);
  });

  it("③ 非法分页参数 ⇒ **400**（不静默夹成'全部'、不 200 糊过去）", async () => {
    await startServerWithHistory();

    for (const badPath of [
      "/mission-history?pageSize=0",
      "/mission-history?pageSize=-3",
      "/mission-history?pageSize=abc",
      "/mission-history?pageIndex=-1",
      "/mission-history?pageIndex=xyz",
    ]) {
      const response = await request({ method: "GET", path: badPath });
      expect(response.statusCode, badPath).toBe(400);
      const parsed = JSON.parse(response.body) as { errorCode?: string };
      expect(parsed.errorCode, badPath).toMatch(/^mission-history-page-/);
    }
  });

  it("④ 能力缺失 ⇒ **501**（不静默降级成空列表）", async () => {
    /**
     * 注意：**不能**用真实 facade 来演"能力缺失" —— 它现在**有** `queryMissionHistory`
     * （这正是本片新增的能力）。故这里用一个**最小桩**：只提供 `GuiApplicationPort`
     * 必需的两个方法，**故意不提供** `queryMissionHistory`。
     */
    const minimalApplicationService = {
      subscribe: () => ({ unsubscribe: () => {} }),
      submitTask: async () => ({
        taskIdentifier: "t",
        missionIdentifier: null,
        status: "accepted",
      }),
      cancelTask: async () => {},
    };
    const created = await startGuiServer({
      applicationService: minimalApplicationService,
    } as never);
    handle = created;
    port = created.port;

    const response = await request({ method: "GET", path: "/mission-history" });

    expect(response.statusCode).toBe(501);
  });

  it("⑤ **历史状态与运行状态分离**：重启后磁盘写着 running 的 mission，路由不得报成运行中", async () => {
    // 模拟"上次进程留下的记录"：外部清理已释放租约，但 summary 仍写着 running
    await writeMissionSummary("mission-stale-running", { status: "running" });
    await startServerWithHistory();

    const response = await request({ method: "GET", path: "/mission-history?pageSize=10&pageIndex=0" });

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body) as {
      rows: Array<{
        missionIdentifier: string;
        recordedStatusText: string;
        runtimeStateText: string;
        isActivelyRunning: boolean;
      }>;
    };
    const row = parsed.rows.find(
      (item) => item.missionIdentifier === "mission-stale-running",
    )!;
    // 历史列**如实**写「运行中（当时记录）」—— 不篡改历史
    expect(row.recordedStatusText).toContain("运行中");
    // 运行列必须说明"现在没在跑"
    expect(row.isActivelyRunning).toBe(false);
    expect(row.runtimeStateText).toBe("已中断，待对账");
    // 两列**必须不同**（否则就是把历史当成了运行态）
    expect(row.runtimeStateText).not.toBe(row.recordedStatusText);
  });

  it("⑥ 只读：**非 GET** 不得改动任何东西（查看历史没有写路径）", async () => {
    await writeMissionSummary("mission-readonly");
    await startServerWithHistory();

    // 对同一路径发 POST：路由只注册了 GET ⇒ 不应产生成功写路径
    const response = await request({ method: "POST", path: "/mission-history" });

    // 不得是 200/201；且不应有写副作用
    expect([200, 201]).not.toContain(response.statusCode);
    // 摘要文件保持原样
    const raw = await fs.readFile(
      path.join(stateDirectory, "missions", "mission-readonly", "summary.json"),
      "utf8",
    );
    expect(JSON.parse(raw).status).toBe("done");
  });

  it("⑦ 返回字段含「任务目标/项目/时间/最后状态/结果」五项", async () => {
    await writeMissionSummary("mission-fields", {
      prompt: "五个字段都要有",
      projectIdentifier: "project-beta",
      status: "blocked",
    });
    await startServerWithHistory();

    const response = await request({ method: "GET", path: "/mission-history?pageSize=10" });
    const parsed = JSON.parse(response.body) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = parsed.rows[0]!;

    expect(row["promptText"]).toBe("五个字段都要有");          // 任务目标
    expect(row["projectText"]).toBe("project-beta");           // 项目
    expect(row["createdAtText"]).toBe("2026-11-01T00:00:00.000Z"); // 时间
    expect(row["recordedStatusText"]).toBe("已阻塞");           // 最后状态（历史）
    expect(row["runtimeStateText"]).toBe("已结束");             // 结果（运行态归一）
  });

  it("⑧ 翻页不重不漏：第 0/1 页拼起来恰好覆盖全部 4 条", async () => {
    for (let index = 0; index < 4; index += 1) {
      await writeMissionSummary("mission-" + String(index));
    }
    await startServerWithHistory();

    const firstPage = JSON.parse(
      (await request({ method: "GET", path: "/mission-history?pageSize=2&pageIndex=0" })).body,
    ) as { rows: Array<{ missionIdentifier: string }>; isMoreAvailable: boolean };
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.isMoreAvailable).toBe(true);

    const secondPage = JSON.parse(
      (await request({ method: "GET", path: "/mission-history?pageSize=2&pageIndex=1" })).body,
    ) as { rows: Array<{ missionIdentifier: string }>; isMoreAvailable: boolean };
    expect(secondPage.rows).toHaveLength(2);
    expect(secondPage.isMoreAvailable).toBe(false);

    const collected = [
      ...firstPage.rows.map((row) => row.missionIdentifier),
      ...secondPage.rows.map((row) => row.missionIdentifier),
    ];
    // **不重**且**不漏**：恰好 4 条、互不相同
    expect(collected).toHaveLength(4);
    expect(new Set(collected).size).toBe(4);
  });
});
