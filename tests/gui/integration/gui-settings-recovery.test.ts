/**
 * GUI-01-R-03 集成测试：设置（上下文预算/权限组）与恢复中心经公共门面接真实控制器，
 * 并锁定"界面修改后下一模型请求真实生效"与"敏感字段不进入前端"。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

const CSRF_TOKEN = "csrf-token-settings";
let stateDirectory: string;
let servers: Array<{ close(): Promise<void> }>;
let applications: AstarrayApplicationFacade[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-gui-settings-"),
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
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
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
  application.createSession({ sessionId: "session-gui-settings", mode: "assist" });
  const handle = await startGuiServer({
    applicationService: application,
    sessionId: "session-gui-settings",
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
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: string }> {
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
          resolve({ statusCode: incoming.statusCode ?? 0, body }),
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

async function submitTaskAndWait(application: AstarrayApplicationFacade): Promise<void> {
  const submitted = await application.submitTask({
    sessionId: "session-gui-settings",
    taskIdentifier: "gui-settings-task-" + Date.now().toString(36),
    prompt: "生成一份设置联测用的小结",
  });
  const deadline = Date.now() + 30_000;
  let status = submitted.status;
  while (!["done", "failed", "blocked", "cancelled"].includes(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = (
      await application.queryTask({
        sessionId: "session-gui-settings",
        taskIdentifier: submitted.taskIdentifier,
      })
    ).status;
  }
  expect(status).toBe("done");
}

describe("GUI-01-R-03 设置：预算修改后下一模型请求按新 revision 生效", () => {
  it("预算写入经权威存储，真实装配事件反映新 revision", async () => {
    const { application, port } = await startRealGui();
    await submitTaskAndWait(application);

    const before = await request({ port, method: "GET", path: "/settings" });
    expect(before.statusCode).toBe(200);
    const beforePayload = JSON.parse(before.body) as {
      context: {
        configuredMaximumGlobalContextTokenCount: number;
        budgetPolicyRevision: number;
        assemblySampleSize: number;
        lastAssemblyBudgetPolicyRevision: number | null;
      };
      permissionProfiles: { current: { profileId: string } | null; total: number };
    };
    expect(beforePayload.context.budgetPolicyRevision).toBe(1);
    expect(beforePayload.context.assemblySampleSize).toBeGreaterThan(0);
    expect(beforePayload.context.lastAssemblyBudgetPolicyRevision).toBe(1);
    expect(beforePayload.permissionProfiles.total).toBe(3);
    expect(beforePayload.permissionProfiles.current?.profileId).toBe("assist");

    const updated = await request({
      port,
      method: "POST",
      path: "/commands/set-context-budget",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "x-csrf-token": CSRF_TOKEN,
      },
      body: JSON.stringify({
        expectedRevision: beforePayload.context.budgetPolicyRevision,
        configuredMaximumGlobalContextTokenCount: 2048,
      }),
    });
    expect(updated.statusCode).toBe(200);
    const updatedPayload = JSON.parse(updated.body).context;
    expect(updatedPayload.configuredMaximumGlobalContextTokenCount).toBe(2048);
    expect(updatedPayload.budgetPolicyRevision).toBe(2);

    // 下一次真实任务请求按新预算 revision 装配（证明不是只改 DTO）。
    await submitTaskAndWait(application);

    const after = await request({ port, method: "GET", path: "/settings" });
    const afterPayload = JSON.parse(after.body) as {
      context: {
        configuredMaximumGlobalContextTokenCount: number;
        budgetPolicyRevision: number;
        assemblySampleSize: number;
        lastAssemblyBudgetPolicyRevision: number | null;
      };
    };
    expect(afterPayload.context.budgetPolicyRevision).toBe(2);
    expect(afterPayload.context.lastAssemblyBudgetPolicyRevision).toBe(2);
    expect(afterPayload.context.assemblySampleSize).toBeGreaterThan(
      beforePayload.context.assemblySampleSize,
    );
    expect(await application.queryContextSettings()).toMatchObject({
      configuredMaximumGlobalContextTokenCount: 2048,
      budgetPolicyRevision: 2,
      lastAssemblyBudgetPolicyRevision: 2,
    });
    // 敏感/内部字段不进入前端 DTO。
    expect(after.body).not.toContain(stateDirectory);
    expect(after.body).not.toContain("protectedCredentialReferenceId");
    expect(after.body).not.toContain(".env");
  });

  it("revision 过期 409、参数非法 400、缺少 CSRF 403 且不改状态", async () => {
    const { port } = await startRealGui();
    const stale = await request({
      port,
      method: "POST",
      path: "/commands/set-context-budget",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "x-csrf-token": CSRF_TOKEN,
      },
      body: JSON.stringify({
        expectedRevision: 99,
        configuredMaximumGlobalContextTokenCount: 1024,
      }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain("stale-revision");

    const invalid = await request({
      port,
      method: "POST",
      path: "/commands/set-context-budget",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "x-csrf-token": CSRF_TOKEN,
      },
      body: JSON.stringify({ expectedRevision: 1, configuredMaximumGlobalContextTokenCount: -5 }),
    });
    expect(invalid.statusCode).toBe(400);

    const noCsrf = await request({
      port,
      method: "POST",
      path: "/commands/set-context-budget",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 1, configuredMaximumGlobalContextTokenCount: 1024 }),
    });
    expect(noCsrf.statusCode).toBe(403);

    const settings = await request({ port, method: "GET", path: "/settings" });
    expect(JSON.parse(settings.body).context.budgetPolicyRevision).toBe(1);
  });

  it("权限组切换经公共门面持久化，多界面读取一致", async () => {
    const { application, port } = await startRealGui();
    const switched = await request({
      port,
      method: "POST",
      path: "/commands/switch-permission-profile",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "x-csrf-token": CSRF_TOKEN,
      },
      body: JSON.stringify({ kind: "builtin", profileId: "ponder" }),
    });
    expect(switched.statusCode).toBe(200);
    // 另一个界面（SDK）读到同一权威选择。
    expect(await application.getCurrentPermissionProfileReference()).toEqual({
      kind: "builtin",
      profileId: "ponder",
    });
    const settings = await request({ port, method: "GET", path: "/settings" });
    expect(JSON.parse(settings.body).permissionProfiles.current).toEqual({
      kind: "builtin",
      profileId: "ponder",
    });

    const invalid = await request({
      port,
      method: "POST",
      path: "/commands/switch-permission-profile",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "x-csrf-token": CSRF_TOKEN,
      },
      body: JSON.stringify({ kind: "builtin", profileId: "not-a-builtin" }),
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("GUI-01-R-03 恢复中心：只读状态与差异", () => {
  it("列出真实 mission 状态并隐藏内部租约/路径字段", async () => {
    const { application, port } = await startRealGui();
    await submitTaskAndWait(application);

    const overview = await request({ port, method: "GET", path: "/recovery" });
    expect(overview.statusCode).toBe(200);
    const payload = JSON.parse(overview.body) as {
      missions: Array<{
        missionIdentifier: string;
        status: string | null;
        isCorrupted: boolean;
        hasTrustedCheckpoint: boolean;
        isLeaseActive: boolean;
      }>;
      requiresDecisionMissions: string[];
    };
    expect(payload.missions.length).toBeGreaterThan(0);
    const mission = payload.missions[0];
    expect(mission).toBeDefined();
    expect(mission?.missionIdentifier).toBeTruthy();
    expect(mission?.isCorrupted).toBe(false);
    expect(typeof mission?.isLeaseActive).toBe("boolean");
    expect(Array.isArray(payload.requiresDecisionMissions)).toBe(true);
    expect(overview.body).not.toContain("leaseProcessInstanceId");
    expect(overview.body).not.toContain(stateDirectory);

    const inspected = await application.inspectRecoveryMission(
      mission?.missionIdentifier ?? "",
    );
    expect(inspected?.missionIdentifier).toBe(mission?.missionIdentifier);
    expect(inspected).not.toHaveProperty("leaseProcessInstanceId");
  });

  it("缺少能力时显式 501，不静默降级", async () => {
    const handle = await startGuiServer({
      applicationService: {
        subscribe: () => ({ unsubscribe: () => {} }),
        submitTask: async (input) => ({
          taskIdentifier: input.taskIdentifier,
          missionIdentifier: null,
          status: "accepted",
        }),
        cancelTask: async () => {},
      },
      sessionId: "session-gui-minimal",
      mode: "assist",
      csrfTokenFactory: () => "minimal-csrf-token",
    });
    servers.push(handle);
    const recovery = await request({
      port: handle.port,
      method: "GET",
      path: "/recovery",
    });
    expect(recovery.statusCode).toBe(501);
    expect(recovery.body).toContain("capability-unavailable");
    const budget = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/set-context-budget",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        "content-type": "application/json",
        "x-csrf-token": "minimal-csrf-token",
      },
      body: JSON.stringify({
        expectedRevision: 1,
        configuredMaximumGlobalContextTokenCount: 1024,
      }),
    });
    expect(budget.statusCode).toBe(501);
    const settings = await request({
      port: handle.port,
      method: "GET",
      path: "/settings",
    });
    expect(settings.statusCode).toBe(200);
    expect(JSON.parse(settings.body).context).toBeNull();
  });
});
