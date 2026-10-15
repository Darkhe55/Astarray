/**
 * GUI-02-03/04（2026-11-08）：`GET /recovery` **分页 + 可恢复项优先** 的路由级反例。
 *
 * 纯函数反例在 `tests/gui/unit/gui-recovery-paging.test.ts`；
 * 本文件钉住**路由真的接上了**（否则纯函数再对，界面也拿不到）：
 * ① 默认一页**不超过 20 条**（用户实测当时一次 103 条）；
 * ② **可恢复项排在最前**（否则可恢复项被上百条禁用项淹没）；
 * ③ 超大 `pageSize` **被硬上限收敛**（不得用参数绕过按需加载）；
 * ④ 非法分页参数 ⇒ **400**（不静默取默认值）；
 * ⑤ 越界页 ⇒ `isOutOfRange` + 空 `rows`（不悄悄回第一页）；
 * ⑥ 每条都带 `isRecoverable` 与 `blockedReasonText`（界面据此禁用并写明原因）。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 覆盖率插桩下真实任务链路会变慢：沿用整文件超时，不放宽任何断言。
vi.setConfig({ testTimeout: 90_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

const CSRF_TOKEN = "csrf-token-recovery-paging";
let stateDirectory: string;
let servers: Array<{ close(): Promise<void> }>;
let applications: AstarrayApplicationFacade[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-gui-recovery-paging-"),
  );
  servers = [];
  applications = [];
});

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => {});
  }
  for (const application of applications) {
    await application.shutdown().catch(() => {});
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function startRealGui(): Promise<{
  application: AstarrayApplicationFacade;
  port: number;
}> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 20,
  });
  applications.push(application);
  application.createSession({ sessionId: "session-recovery-paging", mode: "assist" });
  const handle = await startGuiServer({
    applicationService: application,
    sessionId: "session-recovery-paging",
    mode: "assist",
    csrfTokenFactory: () => CSRF_TOKEN,
  });
  servers.push(handle);
  return { application, port: handle.port };
}

function request(input: {
  port: number;
  method: string;
  path: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers: { host: "127.0.0.1:" + String(input.port) },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () =>
          resolve({ statusCode: incoming.statusCode ?? 0, body }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

interface RecoveryPagePayload {
  rows: Array<{
    missionIdentifier: string;
    isRecoverable: boolean;
    blockedReasonText: string | null;
  }>;
  pageIndex: number;
  effectivePageSize: number;
  totalMissionCount: number;
  recoverableMissionCount: number;
  isOutOfRange: boolean;
}

/** 造若干 mission（只写 summary.json，走真实的目录枚举路径）。 */
async function seedMissions(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const missionIdentifier = "mission-seed-" + String(index).padStart(3, "0");
    const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
    await fs.mkdir(missionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(missionDirectory, "summary.json"),
      JSON.stringify({
        schemaVersion: 1,
        missionId: missionIdentifier,
        mode: "assist",
        prompt: "分页反例",
        createdAtIso: "2026-11-01T00:00:00.000Z",
        status: "done",
      }),
      "utf8",
    );
  }
}

describe("GET /recovery：分页按需加载", () => {
  it("① 默认一页不超过 20 条（用户实测当时一次返回 103 条）", async () => {
    await seedMissions(45);
    const { port } = await startRealGui();
    const response = await request({ port, method: "GET", path: "/recovery" });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as RecoveryPagePayload;
    expect(payload.effectivePageSize).toBe(20);
    expect(payload.rows.length).toBe(20);
    expect(payload.totalMissionCount).toBeGreaterThanOrEqual(45);
  });

  it("② 可恢复项必须排在**最前**（服务端排序，界面不自己算）", async () => {
    await seedMissions(30);
    const { application, port } = await startRealGui();
    // 真实提交一个 mission（会落可信检查点路径 ⇒ 成为"可恢复"候选）
    await application.submitTask({
      sessionId: "session-recovery-paging",
      taskIdentifier: "task-recoverable",
      prompt: "可恢复项优先",
    });
    // 等它到终态（mock 毫秒级；给有界等待）
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const stateText = await request({ port, method: "GET", path: "/state" });
      const state = JSON.parse(stateText.body) as {
        tasks: Array<{ status: string }>;
      };
      if (state.tasks.every((task) => task.status === "done" || task.status === "failed")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const response = await request({
      port,
      method: "GET",
      path: "/recovery?pageSize=100",
    });
    const payload = JSON.parse(response.body) as RecoveryPagePayload;

    // 关键不变量：**只要存在可恢复项（或至少不是全部可恢复），
    // 排序必须满足"可恢复在前"** —— 用逐位检查而不是只看第一个，
    // 否则"只有一条可恢复且恰好排第一"会造成假绿。
    let hasSeenBlocked = false;
    for (const row of payload.rows) {
      if (!row.isRecoverable) {
        hasSeenBlocked = true;
        continue;
      }
      expect(hasSeenBlocked, "可恢复项出现在不可恢复项之后：" + row.missionIdentifier).toBe(false);
    }
    // 且每条都带原因字段（可恢复的为 null，不可恢复的必须非空）
    for (const row of payload.rows) {
      if (row.isRecoverable) {
        expect(row.blockedReasonText).toBeNull();
      } else {
        expect(typeof row.blockedReasonText).toBe("string");
        expect((row.blockedReasonText ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("③ 超大 pageSize 被硬上限收敛（不得用参数绕过按需加载）", async () => {
    await seedMissions(5);
    const { port } = await startRealGui();
    const response = await request({
      port,
      method: "GET",
      path: "/recovery?pageSize=100000",
    });

    const payload = JSON.parse(response.body) as RecoveryPagePayload;
    expect(payload.effectivePageSize).toBe(100);
    expect(payload.rows.length).toBeLessThanOrEqual(100);
  });

  it("④ 非法分页参数 ⇒ 400（不静默取默认值）", async () => {
    await seedMissions(2);
    const { port } = await startRealGui();
    const badSize = await request({
      port,
      method: "GET",
      path: "/recovery?pageSize=0",
    });
    expect(badSize.statusCode).toBe(400);
    expect(badSize.body).toContain("recovery-page-size-invalid");

    const badIndex = await request({
      port,
      method: "GET",
      path: "/recovery?pageIndex=-1",
    });
    expect(badIndex.statusCode).toBe(400);
    expect(badIndex.body).toContain("recovery-page-index-invalid");
  });

  it("⑤ 越界页 ⇒ isOutOfRange + 空 rows（不悄悄回第一页）", async () => {
    await seedMissions(3);
    const { port } = await startRealGui();
    const response = await request({
      port,
      method: "GET",
      path: "/recovery?pageSize=2&pageIndex=99",
    });

    const payload = JSON.parse(response.body) as RecoveryPagePayload;
    expect(payload.isOutOfRange).toBe(true);
    expect(payload.rows).toEqual([]);
  });
});
