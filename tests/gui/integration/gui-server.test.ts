/**
 * GUI-01-R-02 集成测试：本地宿主 loopback/Host/Origin/CSRF、SSE revision、
 * 输入清洗、退出收口，以及"按钮触发真实任务"走公共应用服务。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import type { PublicAstarrayEvent } from "../../../packages/core/src/public-sdk.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

interface RecordedSubmission {
  taskIdentifier: string;
  prompt: string;
  idempotencyKey?: string;
}

let submissions: RecordedSubmission[];
let cancelledTaskIdentifiers: string[];
let eventListeners: Set<(event: PublicAstarrayEvent) => void>;
let stateDirectory: string;
let servers: Array<{ close(): Promise<void> }>;

function createFakeApplicationPort() {
  return {
    subscribe(listener: (event: PublicAstarrayEvent) => void) {
      eventListeners.add(listener);
      return {
        unsubscribe: () => {
          eventListeners.delete(listener);
        },
      };
    },
    async submitTask(input: {
      sessionId: string;
      taskIdentifier: string;
      prompt: string;
      idempotencyKey?: string;
    }) {
      submissions.push({
        taskIdentifier: input.taskIdentifier,
        prompt: input.prompt,
        ...(input.idempotencyKey !== undefined
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      });
      return {
        taskIdentifier: input.taskIdentifier,
        missionIdentifier: `mission-for-${input.taskIdentifier}`,
        status: "accepted",
      };
    },
    async cancelTask(input: { sessionId: string; taskIdentifier: string }) {
      cancelledTaskIdentifiers.push(input.taskIdentifier);
    },
  };
}

beforeEach(async () => {
  submissions = [];
  cancelledTaskIdentifiers = [];
  eventListeners = new Set();
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => {});
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function startServer(overrides: Record<string, unknown> = {}) {
  const handle = await startGuiServer({
    applicationService: createFakeApplicationPort(),
    sessionId: "session-gui-1",
    mode: "assist",
    csrfTokenFactory: () => "csrf-token-for-test",
    ...overrides,
  });
  servers.push(handle);
  return handle;
}

function request(input: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers: input.headers ?? {},
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () =>
          resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body }),
        );
      },
    );
    outgoing.on("error", reject);
    if (input.body !== undefined) {
      outgoing.write(input.body);
    }
    outgoing.end();
  });
}

describe("GUI-01-R-02 loopback/Host/Origin/CSRF", () => {
  it("合法 Host 返回页面（含转义内容与 CSRF cookie）", async () => {
    const handle = await startServer({ sessionId: "session-<script>" });
    const response = await request({
      port: handle.port,
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).toContain("session-&lt;script&gt;");
    expect(response.body).not.toContain("session-<script>");
    expect(String(response.headers["set-cookie"])).toContain("gui_csrf=");
    expect(String(response.headers["set-cookie"])).toContain("SameSite=Strict");
  });

  it("异常 Host 或跨 Origin 一律 403", async () => {
    const handle = await startServer();
    const badHost = await request({
      port: handle.port,
      method: "GET",
      path: "/",
      headers: { host: "evil.example" },
    });
    expect(badHost.statusCode).toBe(403);
    expect(badHost.body).toContain("loopback-host-origin-required");
    const crossOrigin = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        origin: "http://evil.example",
        "content-type": "application/json",
        "x-csrf-token": "csrf-token-for-test",
      },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(submissions).toHaveLength(0);
  });

  it("非 loopback 绑定在启动前即被拒绝", async () => {
    await expect(
      startGuiServer({
        applicationService: createFakeApplicationPort(),
        sessionId: "session-gui-1",
        mode: "assist",
        host: "0.0.0.0",
      }),
    ).rejects.toThrow(/loopback/);
    await expect(
      startGuiServer({
        applicationService: createFakeApplicationPort(),
        sessionId: "session-gui-1",
        mode: "assist",
        host: "192.168.1.10",
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("状态变更缺少/错误 CSRF 一律 403", async () => {
    const handle = await startServer();
    const missing = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.body).toContain("csrf-required");
    const wrong = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "x-csrf-token": "wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(submissions).toHaveLength(0);
  });
});

describe("GUI-01-R-02 命令与事件", () => {
  it("提交命令清洗输入并返回受理回执（受理≠完成）", async () => {
    const handle = await startServer();
    const response = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "x-csrf-token": "csrf-token-for-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "  生成\u0007报告 <b>x</b>  ", idempotencyKey: "gui-key-1" }),
    });
    expect(response.statusCode).toBe(202);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload["status"]).toBe("accepted");
    expect(payload["isCompleted"]).toBe(false);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.prompt).toBe("生成报告 <b>x</b>");
    expect(submissions[0]?.idempotencyKey).toBe("gui-key-1");
  });

  it("空提示词 400；取消命令调用应用服务", async () => {
    const handle = await startServer();
    const empty = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "x-csrf-token": "csrf-token-for-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "   " }),
    });
    expect(empty.statusCode).toBe(400);
    const cancelled = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/cancel",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "x-csrf-token": "csrf-token-for-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ taskIdentifier: "task-1" }),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelledTaskIdentifiers).toEqual(["task-1"]);
  });

  it("SSE 首帧为快照（带 id 与 revision），后续事件带幂等 ID", async () => {
    const handle = await startServer();
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const streamRequest = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          method: "GET",
          path: "/events",
          headers: {
            host: `127.0.0.1:${handle.port}`,
            accept: "text/event-stream",
            "last-event-id": "previous-event",
          },
        },
        (incoming) => {
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            chunks.push(chunk);
            if (chunks.join("").includes("event-sse-1")) {
              incoming.destroy();
              resolve();
            }
          });
        },
      );
      streamRequest.on("error", (error) => {
        if (chunks.length > 0) {
          resolve();
          return;
        }
        reject(error);
      });
      streamRequest.end();
      // 等首个订阅者注册后再推送事件（服务端在 /events 处理时订阅）
      setTimeout(() => {
        for (const listener of eventListeners) {
          listener({
            eventType: "task-status",
            taskIdentifier: "task-sse-1",
            status: "accepted",
            revision: 7,
            idempotencyId: "event-sse-1",
          });
        }
      }, 60);
      setTimeout(() => resolve(), 2_000);
    });
    const streamText = chunks.join("");
    expect(streamText).toContain("eventType");
    expect(streamText).toContain("snapshot");
    expect(streamText).toContain("id: ");
    expect(streamText).toContain("\"revision\":7");
    expect(streamText).toContain("event-sse-1");
  });

  it("重连（Last-Event-ID）先收到含离线期间任务的完整快照", async () => {
    const handle = await startServer();
    const submitted = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "content-type": "application/json",
        "x-csrf-token": "csrf-token-for-test",
      },
      body: JSON.stringify({ prompt: "离线期间提交的任务" }),
    });
    expect(submitted.statusCode).toBe(202);
    const acceptedTaskIdentifier = JSON.parse(submitted.body).taskIdentifier as string;

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const streamRequest = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          method: "GET",
          path: "/events",
          headers: {
            host: `127.0.0.1:${handle.port}`,
            accept: "text/event-stream",
            "last-event-id": "event-before-disconnect",
          },
        },
        (incoming) => {
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            chunks.push(chunk);
            if (chunks.join("").includes(acceptedTaskIdentifier)) {
              incoming.destroy();
              resolve();
            }
          });
        },
      );
      streamRequest.on("error", reject);
      streamRequest.end();
      setTimeout(() => resolve(), 2_000);
    });
    const frames = chunks.join("");
    expect(frames).toContain("\"isReconnect\":true");
    expect(frames).toContain(acceptedTaskIdentifier);
    expect(frames).toContain("mission-for-");
  });

  it("端口被占用时监听失败并拒绝（不悬挂）", async () => {
    const handle = await startServer();
    await expect(
      startGuiServer({
        applicationService: createFakeApplicationPort(),
        sessionId: "session-gui-1",
        mode: "assist",
        port: handle.port,
      }),
    ).rejects.toThrow();
  });

  it("关闭后端口释放（同端口可再次绑定）", async () => {
    const handle = await startServer();
    const releasedPort = handle.port;
    await handle.close();
    const restarted = await startGuiServer({
      applicationService: createFakeApplicationPort(),
      sessionId: "session-gui-1",
      mode: "assist",
      port: releasedPort,
    });
    servers.push(restarted);
    expect(restarted.port).toBe(releasedPort);
  });
});

describe("SMART-01-04：GUI 暴露指令窗口（只读，不冒充成果完成）", () => {
  it("/state 必须携带指令窗口：已派发/排队可分辨，仅 completed 为成果完成", async () => {
    const handle = await startServer({
      applicationService: {
        ...createFakeApplicationPort(),
        async queryInstructionWindow(_input: { sessionId: string }) {
          return {
            windowCapacity: 3,
            activeInstructions: [
              {
                instructionIdentifier: "i-1",
                instructionText: "窗口内指令",
                state: "dispatched",
                admittedAtIso: "2026-10-10T00:00:00.000Z",
              },
              {
                instructionIdentifier: "i-2",
                instructionText: "已完成指令",
                state: "completed",
                admittedAtIso: "2026-10-10T00:00:00.000Z",
              },
            ],
            queuedInstructions: [
              {
                instructionIdentifier: "i-4",
                instructionText: "排队指令",
                state: "accepted",
                admittedAtIso: "2026-10-10T00:00:00.000Z",
              },
            ],
          };
        },
      },
    });
    const response = await request({ port: handle.port, method: "GET", path: "/state" });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      instructions?: {
        capacity: number;
        activeCount: number;
        queuedCount: number;
        rows: Array<{ instructionIdentifier: string; stateLabel: string; isWorkCompleted: boolean; isQueued: boolean }>;
      };
    };
    expect(payload.instructions?.capacity).toBe(3);
    expect(payload.instructions?.queuedCount).toBe(1);
    const byIdentifier = new Map(
      (payload.instructions?.rows ?? []).map((row) => [row.instructionIdentifier, row]),
    );
    expect(byIdentifier.get("i-1")?.stateLabel).toBe("已派发");
    expect(byIdentifier.get("i-1")?.isWorkCompleted).toBe(false);
    expect(byIdentifier.get("i-4")?.stateLabel).toBe("排队");
    expect(byIdentifier.get("i-4")?.isQueued).toBe(true);
    expect(byIdentifier.get("i-4")?.isWorkCompleted).toBe(false);
    expect(byIdentifier.get("i-2")?.isWorkCompleted).toBe(true);
  });

  it("应用服务未提供窗口能力时 /state 仍可用（空窗口，不伪造指令、不 500）", async () => {
    const handle = await startServer();
    const response = await request({ port: handle.port, method: "GET", path: "/state" });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      instructions?: { capacity: number; rows: unknown[] };
    };
    expect(payload.instructions?.capacity).toBe(0);
    expect(payload.instructions?.rows).toHaveLength(0);
  });

  /**
   * PROJECT-01-04：跨项目授权必须进入 /state 只读快照（可追溯），
   * 且能力缺失时返回空列表而非 500。
   */
  it("/state 必须携带跨项目授权列表（可追溯），能力缺失时空列表不 500", async () => {
    const handle = await startServer({
      applicationService: {
        ...createFakeApplicationPort(),
        async listCrossProjectAuthorizations() {
          return [
            {
              authorizationIdentifier: "auth-1",
              sourceProjectIdentifier: "project-a",
              targetProjectIdentifier: "project-b",
              operationKind: "read" as const,
              state: "active",
              taskIdentifier: "T-001",
            },
          ];
        },
      },
    });
    const response = await request({ port: handle.port, method: "GET", path: "/state" });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      crossProject?: { authorizations: Array<{ sourceProjectIdentifier: string; taskIdentifier: string }> };
    };
    expect(payload.crossProject?.authorizations).toHaveLength(1);
    expect(payload.crossProject?.authorizations[0]?.sourceProjectIdentifier).toBe("project-a");
    expect(payload.crossProject?.authorizations[0]?.taskIdentifier).toBe("T-001");

    // 能力缺失 ⇒ 空列表且不 500
    const bareHandle = await startServer();
    const bareResponse = await request({ port: bareHandle.port, method: "GET", path: "/state" });
    expect(bareResponse.statusCode).toBe(200);
    const barePayload = JSON.parse(bareResponse.body) as {
      crossProject?: { authorizations: unknown[]; copyReceipts: unknown[] };
    };
    expect(barePayload.crossProject?.authorizations).toHaveLength(0);
    expect(barePayload.crossProject?.copyReceipts).toHaveLength(0);
  });
});

describe("GUI-01-R-02 按钮触发真实任务（公共应用服务）", () => {
  it("经 GUI 命令提交真实任务并由公共应用服务完成", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      statusPollIntervalMilliseconds: 20,
    });
    application.createSession({ sessionId: "session-gui-real", mode: "assist" });
    const handle = await startServer({
      applicationService: application,
      sessionId: "session-gui-real",
    });
    try {
      const response = await request({
        port: handle.port,
        method: "POST",
        path: "/commands/submit",
        headers: {
          host: `127.0.0.1:${handle.port}`,
          "x-csrf-token": "csrf-token-for-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "GUI 真实任务" }),
      });
      expect(response.statusCode).toBe(202);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      const taskIdentifier = String(payload["taskIdentifier"]);
      expect(payload["status"]).toBe("accepted");

      let status = "accepted";
      const deadline = Date.now() + 30_000;
      while (!["done", "failed", "blocked", "cancelled"].includes(status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = (
          await application.queryTask({ sessionId: "session-gui-real", taskIdentifier })
        ).status;
      }
      expect(status).toBe("done");
    } finally {
      await application.shutdown();
    }
  });

  /**
   * TOOLKIT-01-04：工具包版本与升级差异必须进入 `/state` 只读快照。
   *
   * 卡内 §11 要求用户"能看懂升级权限差异并拒绝"——若该视图只在 CLI 可见，
   * 界面上就无法做出"拒绝"的决定。能力缺失时必须回落为空视图且**不 500**。
   */
  it("/state 必须携带工具包版本与升级差异（含是否需重新授权），缺失时空视图不 500", async () => {
    const handle = await startServer({
      applicationService: {
        ...createFakeApplicationPort(),
        async listToolPackages() {
          return {
            versions: [
              {
                toolPackageId: "report-formatter",
                version: 2,
                contentHash: "sha256:" + "b".repeat(64),
                revision: 3,
                scope: "project",
                status: "enabled",
                readableName: "测试报告格式化",
                sourceProjectIdentifier: "project-alpha",
                enabledProjectIdentifiers: ["project-alpha"],
              },
            ],
            upgradeDifferences: [
              {
                toolPackageId: "report-formatter",
                fromVersion: 1,
                toVersion: 2,
                addedSideEffects: ["file-write"],
                removedSideEffects: [],
                dependencyDifferences: ["jsdom>=20"],
                permissionDifferences: ["write-file"],
                requiresReauthorization: true,
              },
            ],
          };
        },
      },
    });
    const response = await request({ port: handle.port, method: "GET", path: "/state" });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      toolPackages?: {
        versions: Array<{
          toolPackageId: string;
          version: number;
          statusDisplayLabel: string;
          scopeDisplayLabel: string;
        }>;
        upgradeDifferences: Array<{
          requiresReauthorization: boolean;
          displaySummary: string;
        }>;
      };
    };
    expect(payload.toolPackages?.versions).toHaveLength(1);
    expect(payload.toolPackages?.versions[0]?.version).toBe(2);
    // 人工可读标签必须随快照下发（用户据此区分状态与作用域）
    expect(payload.toolPackages?.versions[0]?.statusDisplayLabel).toContain("已启用");
    expect(payload.toolPackages?.versions[0]?.scopeDisplayLabel).toContain("项目专用");
    // 升级差异必须带"是否需要重新授权"与可读摘要
    expect(payload.toolPackages?.upgradeDifferences[0]?.requiresReauthorization).toBe(true);
    expect(String(payload.toolPackages?.upgradeDifferences[0]?.displaySummary)).toContain(
      "需要重新授权",
    );

    // 能力缺失 ⇒ 空视图且不 500
    const bareHandle = await startServer();
    const bareResponse = await request({ port: bareHandle.port, method: "GET", path: "/state" });
    expect(bareResponse.statusCode).toBe(200);
    const barePayload = JSON.parse(bareResponse.body) as {
      toolPackages?: { versions: unknown[]; upgradeDifferences: unknown[] };
    };
    expect(barePayload.toolPackages?.versions).toHaveLength(0);
    expect(barePayload.toolPackages?.upgradeDifferences).toHaveLength(0);
  });
});