/**
 * GUI-02-02 专用流程反例：**安装不可被普通授权卡绕过**（用户 2026-10-11 明确要求）。
 *
 * 审计结论（2026-10-12）：`InstallationGateGuard` **自己**完成完整判定
 * （询问已有资源 → 独立安装开关 → `askAllowOnce` → `authorizeAllowOnce` → **执行前复检**）；
 * 普通 `permission-ask` 的批准**不参与**该判定。本文件把这条性质**钉住**，防止回归。
 *
 * 断言的是**结构性事实**（可核对、不依赖猜测）：
 *  ① 安装询问有**独立入口**（`/installation-inquiries`）与**独立裁决端点**
 *     （`/commands/installation-inquiry-decision`），**不是**权限询问的两个端点；
 *  ② 权限询问的裁决端点**不能**回答安装询问（拿安装锚点去 `/commands/permission-ask-decision`
 *     必失败）—— 反向亦然；
 *  ③ 页面上两个区块**并列且独立**，安装区块明示"不走上方普通授权卡"；
 *  ④ 安装区块**无默认选中**、且明示"未回答即视为拒绝"。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

const CSRF_TOKEN = "csrf-token-installation";
let stateDirectory: string;
let application: AstarrayApplicationFacade;
let handle: { close(): Promise<void> };
let port: number;

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

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-install-ui-"));
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
    // GUI-02-02 专用流程：由界面承载安装询问（生产接线同此）
    installationInquiryRegistry: undefined,
  });
  application.createSession({ sessionId: "session-install", mode: "assist" });
  application.configurePermissionAskAdjudication({
    authorityPort: {
      isProjectVisibleTo: async (agentInstanceId) => agentInstanceId !== "",
      isSessionVisibleTo: async (agentInstanceId) => agentInstanceId !== "",
      hasAdjudicationAuthority: async (agentInstanceId) => agentInstanceId !== "",
    },
    csrfToken: CSRF_TOKEN,
    projectRootPath: stateDirectory,
  });
  /**
   * **必须先把原方法捕获为局部引用**：`Object.assign` 会**先**把新方法装到 `application`
   * 上，若方法体内再调 `application.listPendingInstallationInquiries()` 就是**调用自己**
   * ⇒ 无限递归（`RangeError: Maximum call stack size exceeded`）。
   * 这与产品无关，是**测试/接线写法**的陷阱。
   */
  const decidePermissionAskRequestFromFacade = application
    .decidePermissionAskRequest.bind(application);
  const listPendingPermissionAskRequestsFromFacade = application
    .listPendingPermissionAskRequests.bind(application);
  const listPendingInstallationInquiriesFromFacade = application
    .listPendingInstallationInquiries.bind(application);
  const answerInstallationInquiryFromFacade = application
    .answerInstallationInquiry.bind(application);
  const decideInstallationAllowOnceFromFacade = application
    .decideInstallationAllowOnce.bind(application);
  handle = await startGuiServer({
    applicationService: Object.assign(application, {
      /**
       * **改为委托真实方法**（与 `commands.ts` 生产接线一致）。
       * 起初我把它写成"总是返回成功"的桩 ⇒ 用例② 测到的是**桩**而不是产品，
       * 得出"未知锚点返回 200"的**假结论**（已用独立探针证实门面实为**抛错**）。
       */
      listPendingPermissionAsks: async () =>
        (await listPendingPermissionAskRequestsFromFacade()).map((entry) => ({
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
        const decided = await decidePermissionAskRequestFromFacade({
          ...input,
          csrfToken: CSRF_TOKEN,
          authenticatedAgentInstanceId: "gui-session:session-install",
          projectIdentifier: "astarray",
          sessionIdentifier: "session-install",
        });
        return {
          askIdentifier: decided.record.askIdentifier,
          status: decided.record.status,
          requestRevision: decided.record.requestRevision,
        };
      },
      listPendingInstallationInquiries: async () =>
        (await listPendingInstallationInquiriesFromFacade()).map((entry) => ({
          inquiryIdentifier: entry.inquiryIdentifier,
          stage: entry.stage,
          summary: entry.summary,
          revision: entry.revision,
          createdAtIso: entry.createdAtIso,
          installationPlan:
            entry.installationPlan === null
              ? null
              : {
                  packageOrRepositoryIdentifier:
                    entry.installationPlan.packageOrRepositoryIdentifier,
                  pinnedVersionOrCommit: entry.installationPlan.pinnedVersionOrCommit,
                  targetPathOrScope: entry.installationPlan.targetPathOrScope,
                  packageManager: entry.installationPlan.packageManager,
                  expectedChangesSummary:
                    entry.installationPlan.expectedChangesSummary,
                  requiresNetwork: entry.installationPlan.requiresNetwork,
                  hasInstallScripts: entry.installationPlan.hasInstallScripts,
                },
        })),
      decideInstallationInquiry: async (input: {
        inquiryIdentifier: string;
        expectedRevision: number;
        stage: "existing-resource" | "allow-once";
        answerKind?: "has-resource" | "no-resource";
        resourceReference?: string;
        allowOnceDecision?: "allow-once" | "deny";
      }) => {
        const record =
          input.stage === "existing-resource"
            ? await answerInstallationInquiryFromFacade({
                inquiryIdentifier: input.inquiryIdentifier,
                expectedRevision: input.expectedRevision,
                answer:
                  input.answerKind === "has-resource"
                    ? {
                        answer: "has-resource",
                        resourceReference: input.resourceReference ?? "",
                        providedResourceType: "user-provided",
                      }
                    : { answer: "no-resource" },
              })
            : await decideInstallationAllowOnceFromFacade({
                inquiryIdentifier: input.inquiryIdentifier,
                expectedRevision: input.expectedRevision,
                decision: input.allowOnceDecision ?? "deny",
              });
        return {
          inquiryIdentifier: record.inquiryIdentifier,
          status: record.status,
          revision: record.revision,
        };
      },
    }),
    sessionId: "session-install",
    mode: "assist",
    csrfTokenFactory: () => CSRF_TOKEN,
  });
  port = (handle as unknown as { port: number }).port;
});

afterEach(async () => {
  await handle.close().catch(() => {});
  await application.shutdown().catch(() => {});
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("GUI-02-02 专用流程：安装不可被普通授权卡绕过", () => {
  it("① 安装询问有**独立**入口与**独立**裁决端点（与权限询问并列）", async () => {
    const listResponse = await request({ method: "GET", path: "/installation-inquiries" });
    expect(listResponse.statusCode).toBe(200);
    expect(JSON.parse(listResponse.body)).toEqual({ entries: [] });

    // 权限询问的端点**仍然**只服务权限询问（两者并存，不合并）
    const permissionList = await request({ method: "GET", path: "/permission-asks" });
    expect(permissionList.statusCode).toBe(200);
  });

  it("② 用**安装锚点**打权限询问裁决端点 ⇒ 必失败（不得互相代替）", async () => {
    const response = await request({
      method: "POST",
      path: "/commands/permission-ask-decision",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      body: JSON.stringify({
        ownerAgentInstanceId: "interface-session",
        askIdentifier: "install-inquiry-1-abc",
        decision: "allowed-once",
        expectedRequestRevision: 1,
        expectedOperationFingerprint: "sha256:" + "0".repeat(64),
      }),
    });
    // 不存在该权限询问 ⇒ 404（**不会**因为锚点格式像就通过）
    expect(response.statusCode).toBe(404);
  });

  it("③ 用**权限询问锚点**打安装裁决端点 ⇒ 必失败（反向同样不成立）", async () => {
    const response = await request({
      method: "POST",
      path: "/commands/installation-inquiry-decision",
      headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
      body: JSON.stringify({
        inquiryIdentifier: "ask-not-an-installation-inquiry",
        expectedRevision: 1,
        stage: "allow-once",
        allowOnceDecision: "allow-once",
      }),
    });
    expect(response.statusCode).toBe(404);
  });

  it("④ 安装裁决**仍需 CSRF**（无头 ⇒ 403，不因专用而放宽）", async () => {
    const response = await request({
      method: "POST",
      path: "/commands/installation-inquiry-decision",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inquiryIdentifier: "install-inquiry-1-abc",
        expectedRevision: 1,
        stage: "allow-once",
        allowOnceDecision: "allow-once",
      }),
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "csrf-required" });
  });

  it("⑤ 安装裁决的**参数校验**：阶段/回答不合法 ⇒ 400（含声称已有资源却不给引用）", async () => {
    const cases: Array<Record<string, unknown>> = [
      { inquiryIdentifier: "", expectedRevision: 1, stage: "allow-once" },
      { inquiryIdentifier: "x", expectedRevision: 1.5, stage: "allow-once" },
      { inquiryIdentifier: "x", expectedRevision: 1, stage: "unknown-stage" },
      // 阶段 1 声称已有资源却**不给引用** ⇒ 拒绝（避免形成空授权凭据）
      {
        inquiryIdentifier: "x",
        expectedRevision: 1,
        stage: "existing-resource",
        answerKind: "has-resource",
      },
      // 阶段 2 回答值非法
      { inquiryIdentifier: "x", expectedRevision: 1, stage: "allow-once", allowOnceDecision: "yes" },
    ];
    for (const body of cases) {
      const response = await request({
        method: "POST",
        path: "/commands/installation-inquiry-decision",
        headers: { "content-type": "application/json", "x-csrf-token": CSRF_TOKEN },
        body: JSON.stringify(body),
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("⑥ 页面：安装区块**并列且独立**，明示不走普通授权卡、无默认选中", async () => {
    const page = await new Promise<string>((resolve, reject) => {
      const outgoing = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "/" },
        (incoming) => {
          let text = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            text += chunk;
          });
          incoming.on("end", () => resolve(text));
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    const start = page.indexOf('id="installation-inquiries-heading"');
    expect(start, "页面必须有『待安装询问』区块").toBeGreaterThan(-1);
    const end = page.indexOf("</section>", start);
    const section = page.slice(start, end === -1 ? page.length : end);
    expect(section).toContain("待安装询问");
    expect(section).toContain("不走上方的普通授权卡");
    expect(section).toContain("未回答即视为拒绝");
    // 两个区块**并列**：权限询问区在安装区之前，且都在 main 内
    const permissionStart = page.indexOf('id="permission-asks-heading"');
    expect(permissionStart).toBeGreaterThan(-1);
    expect(permissionStart).toBeLessThan(start);
    // **无默认选中**
    expect(section).not.toMatch(/checked\s*=/i);
    expect(section).not.toMatch(/<select/i);
    // 渲染函数存在（客户端脚本）
    expect(page).toContain("function renderInstallationInquiries");
    expect(page).toContain("function decideInstallationInquiry");
  });
});
