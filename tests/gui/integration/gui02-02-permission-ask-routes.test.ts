/**
 * GUI-02-02 片2 反例：**待授权列表与裁决路由**（先红后绿）。
 *
 * 用户明确要求：
 * - GUI 必须能完成"提交任务 → 收到权限询问 → 批准或拒绝 → 任务继续或保持阻塞"；
 * - 待授权列表 + 独立详情卡；**不默认选中批准、不提供一键批准全部**；
 * - 裁决入口只接受**请求锚点与裁决**，不接受前端提交的新参数；
 * - CSRF、认证主体、项目/会话可见性、裁决权限都要校验；
 * - 重复点击不重复执行；多页面并发裁决只能有一个有效结果。
 *
 * 本片覆盖**传输层**：路由存在性、CSRF 门禁、参数校验、错误码映射、
 * 以及"视图不含原始参数"。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

const CSRF_TOKEN = "csrf-token-permission-ask";
const OWNER = "worker:mission-gui02-02:T-001:1";
const ARGUMENTS = JSON.stringify({ filePath: "src/gui02-02.ts", content: "export const b = 2;\n" });

let stateDirectory: string;
let application: AstarrayApplicationFacade;
let port: number;
let handle: { close(): Promise<void> } | null;

function request(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
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
        incoming.on("end", () =>
          resolve({ statusCode: incoming.statusCode ?? 0, body: text }),
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

/** 登记一条待裁决请求，返回其锚点。 */
async function registerPending(): Promise<{
  askIdentifier: string;
  requestRevision: number;
  operationFingerprint: string;
}> {
  const record = await application.registerPermissionAskRequest({
    ownerAgentInstanceId: OWNER,
    taskIdentifier: "T-001",
    toolName: "createProjectFile",
    argumentsJson: ARGUMENTS,
    explanation: "需要写入项目文件",
    projectIdentifier: "astarray",
    sessionIdentifier: "session-gui02-02",
    projectRootPath: stateDirectory,
  });
  return {
    askIdentifier: record.askIdentifier,
    requestRevision: record.requestRevision,
    operationFingerprint: record.operationFingerprint,
  };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-02-route-"));
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
  application.createSession({ sessionId: "session-gui02-02", mode: "assist" });
  application.configurePermissionAskAdjudication({
    authorityPort: {
      isProjectVisibleTo: async (agentInstanceId) => agentInstanceId !== "",
      isSessionVisibleTo: async (agentInstanceId) => agentInstanceId !== "",
      hasAdjudicationAuthority: async (agentInstanceId) => agentInstanceId !== "",
    },
    csrfToken: CSRF_TOKEN,
    projectRootPath: stateDirectory,
  });
  const created = await startGuiServer({
    applicationService: Object.assign(application, {
      listPendingPermissionAsks: async () =>
        (await application.listPendingPermissionAskRequests()).map((entry) => ({
          ownerAgentInstanceId: entry.ownerAgentInstanceId,
          askIdentifier: entry.askIdentifier,
          taskIdentifier: entry.taskIdentifier,
          toolName: entry.toolName,
          action: entry.action,
          operationFingerprint: entry.operationFingerprint,
          requestRevision: entry.requestRevision,
          status: entry.status,
          createdAtIso: entry.createdAtIso,
          expiresAtIso: entry.expiresAtIso,
          preview: entry.preview,
        })),
      decidePermissionAsk: async (input: {
        ownerAgentInstanceId: string;
        askIdentifier: string;
        decision: "allowed-once" | "denied";
        expectedRequestRevision: number;
        expectedOperationFingerprint: string;
      }) => {
        const decided = await application.decidePermissionAskRequest({
          ...input,
          csrfToken: CSRF_TOKEN,
          authenticatedAgentInstanceId: "gui-session:session-gui02-02",
          projectIdentifier: "astarray",
          sessionIdentifier: "session-gui02-02",
        });
        return {
          askIdentifier: decided.record.askIdentifier,
          status: decided.record.status,
          requestRevision: decided.record.requestRevision,
        };
      },
    }),
    sessionId: "session-gui02-02",
    mode: "assist",
    csrfTokenFactory: () => CSRF_TOKEN,
  });
  handle = created;
  port = created.port;
});

afterEach(async () => {
  await handle?.close().catch(() => {});
  await application.shutdown().catch(() => {});
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("GUI-02-02 片2：待授权列表路由", () => {
  it("① GET /permission-asks 列出待授权条目，且**不含原始 argumentsJson**", async () => {
    const anchor = await registerPending();
    const response = await request({ method: "GET", path: "/permission-asks" });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(payload.entries.length).toBe(1);
    const entry = payload.entries[0]!;
    expect(entry["askIdentifier"]).toBe(anchor.askIdentifier);
    expect(entry["operationFingerprint"]).toBe(anchor.operationFingerprint);
    expect(entry["action"]).toBe("create");
    expect(entry["preview"]).toBeTruthy();
    expect(
      JSON.stringify(entry).includes("argumentsJson"),
      "界面视图不得携带原始参数字段",
    ).toBe(false);
  });

  it("② 列表为**只读**：查看不改变请求状态（查看不等于裁决）", async () => {
    const anchor = await registerPending();
    await request({ method: "GET", path: "/permission-asks" });
    const after = await application.listPendingPermissionAskRequests();
    expect(after.length).toBe(1);
    expect(after[0]!.askIdentifier).toBe(anchor.askIdentifier);
    expect(after[0]!.status).toBe("pending");
    expect(after[0]!.requestRevision).toBe(anchor.requestRevision);
  });
});

describe("GUI-02-02 片2：裁决路由", () => {
  it("③ 无 CSRF 头 ⇒ 403 csrf-required（状态不变）", async () => {
    const anchor = await registerPending();
    const response = await request({
      method: "POST",
      path: "/commands/permission-ask-decision",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
      }),
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "csrf-required" });
    expect((await application.listPendingPermissionAskRequests())[0]!.status).toBe("pending");
  });

  it("④ 带 CSRF 的**拒绝**裁决生效，条目从待授权列表消失", async () => {
    const anchor = await registerPending();
    const response = await request({
      method: "POST",
      path: "/commands/permission-ask-decision",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      body: JSON.stringify({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "denied",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
      }),
    });
    expect(response.statusCode).toBe(200);
    const decided = JSON.parse(response.body) as Record<string, unknown>;
    expect(decided["status"]).toBe("denied");
    expect(Number(decided["requestRevision"])).toBeGreaterThanOrEqual(2);
    expect((await application.listPendingPermissionAskRequests()).length).toBe(0);
  });

  it("⑤ 参数非法（缺锚点／裁决值非法／revision 非整数）⇒ 400 invalid-arguments", async () => {
    const anchor = await registerPending();
    const cases: Array<Record<string, unknown>> = [
      { ownerAgentInstanceId: OWNER, askIdentifier: "", decision: "denied" },
      { ownerAgentInstanceId: OWNER, askIdentifier: anchor.askIdentifier, decision: "maybe" },
      {
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "denied",
        expectedRequestRevision: 1.5,
        expectedOperationFingerprint: anchor.operationFingerprint,
      },
    ];
    for (const body of cases) {
      const response = await request({
        method: "POST",
        path: "/commands/permission-ask-decision",
        headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
        body: JSON.stringify(body),
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-arguments" });
    }
  });

  it("⑥ **陈旧 revision／指纹不符／已裁决** ⇒ 409（供界面提示刷新）", async () => {
    const anchor = await registerPending();
    const stale = await request({
      method: "POST",
      path: "/commands/permission-ask-decision",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      body: JSON.stringify({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "denied",
        expectedRequestRevision: anchor.requestRevision + 3,
        expectedOperationFingerprint: anchor.operationFingerprint,
      }),
    });
    expect(stale.statusCode).toBe(409);

    const mismatched = await request({
      method: "POST",
      path: "/commands/permission-ask-decision",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      body: JSON.stringify({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "denied",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: "sha256:" + "0".repeat(64),
      }),
    });
    expect(mismatched.statusCode).toBe(409);
  });

  it("⑦ 未知 askIdentifier ⇒ 404（知道 ID 不等于有权批准）", async () => {
    await registerPending();
    const response = await request({
      method: "POST",
      path: "/commands/permission-ask-decision",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      body: JSON.stringify({
        ownerAgentInstanceId: OWNER,
        askIdentifier: "ask-does-not-exist",
        decision: "allowed-once",
        expectedRequestRevision: 1,
        expectedOperationFingerprint: "sha256:" + "1".repeat(64),
      }),
    });
    expect(response.statusCode).toBe(404);
  });
});
