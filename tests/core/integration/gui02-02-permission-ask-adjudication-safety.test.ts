/**
 * GUI-02-02 安全反例：**待授权列表 + 裁决入口**（先红后绿）。
 *
 * 用户明确要求（2026-10-11）：
 * - 待授权列表能列出**当前待裁决**的权限询问；
 * - 裁决入口**只接受请求锚点与裁决**，**不接受任何新参数**；
 * - 服务器从**本地权威记录**取原始参数，并重新校验**主体、权限、期限、当前状态**；
 * - **不得把"知道请求 ID 或指纹"当作有权批准**；
 * - 重复点击/重复裁决**不得重复执行**；过期/参数变化**不得复用**批准；
 * - **CSRF 必须校验**；未注入本地权威事实时 **fail-closed**（不允许"未配置即放行"）。
 *
 * 本文件在实现前必须失败（门面尚无 list/decide 或行为不符）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

let baseDirectory: string;
let facade: AstarrayApplicationFacade;

const OWNER = "worker:mission-gui02:T-001:1";
const ARGUMENTS = JSON.stringify({ filePath: "src/gui02.ts", content: "export const a = 1;\n" });

async function buildFacade(): Promise<AstarrayApplicationFacade> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory: baseDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  const created = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory: baseDirectory,
  });
  created.createSession({ sessionId: "gui-session-local", mode: "assist" });
  return created;
}

/** 登记一条待裁决请求并返回其锚点。 */
async function registerPending(): Promise<{
  askIdentifier: string;
  requestRevision: number;
  operationFingerprint: string;
}> {
  const record = await facade.registerPermissionAskRequest({
    ownerAgentInstanceId: OWNER,
    taskIdentifier: "T-001",
    toolName: "createProjectFile",
    argumentsJson: ARGUMENTS,
    explanation: "需要写入项目文件",
    projectIdentifier: "astarray",
    sessionIdentifier: "gui-session-local",
    projectRootPath: baseDirectory,
  });
  return {
    askIdentifier: record.askIdentifier,
    requestRevision: record.requestRevision,
    operationFingerprint: record.operationFingerprint,
  };
}

/** 放开全部本地权威校验（供"正向路径"用例使用）。 */
function configurePermissive(): void {
  facade.configurePermissionAskAdjudication({
    authorityPort: {
      isProjectVisibleTo: async () => true,
      isSessionVisibleTo: async () => true,
      hasAdjudicationAuthority: async () => true,
    },
    csrfToken: "csrf-local-token",
    projectRootPath: baseDirectory,
  });
}

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-02-"));
  facade = await buildFacade();
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("GUI-02-02：待授权列表", () => {
  it("① 列出待裁决请求（含锚点、指纹、状态），且**不改动任何状态**", async () => {
    const anchor = await registerPending();

    const pending = await facade.listPendingPermissionAskRequests();
    expect(pending.length).toBe(1);
    expect(pending[0]!.askIdentifier).toBe(anchor.askIdentifier);
    expect(pending[0]!.operationFingerprint).toBe(anchor.operationFingerprint);
    expect(pending[0]!.status).toBe("pending");
    expect(pending[0]!.ownerAgentInstanceId).toBe(OWNER);

    // 只读：再次列出仍是 pending（查看不等于裁决）
    const again = await facade.listPendingPermissionAskRequests();
    expect(again[0]!.status).toBe("pending");
    expect(again[0]!.requestRevision).toBe(anchor.requestRevision);
  });

  it("② 列表**不含已裁决**的请求（历史与待办分离）", async () => {
    configurePermissive();
    const anchor = await registerPending();
    await facade.decidePermissionAskRequest({
      ownerAgentInstanceId: OWNER,
      askIdentifier: anchor.askIdentifier,
      decision: "denied",
      expectedRequestRevision: anchor.requestRevision,
      expectedOperationFingerprint: anchor.operationFingerprint,
      csrfToken: "csrf-local-token",
      authenticatedAgentInstanceId: OWNER,
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
    });

    const pending = await facade.listPendingPermissionAskRequests();
    expect(pending.length, "已裁决的请求不得再出现在待授权列表").toBe(0);
  });
});

describe("GUI-02-02：裁决入口的安全约束", () => {
  it("③ 未注入本地权威事实 ⇒ **fail-closed**（不允许未配置即放行）", async () => {
    const anchor = await registerPending();
    // 刻意**不**调用 configurePermissionAskAdjudication
    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
        csrfToken: "anything",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();

    // 且状态**未被改动**
    const pending = await facade.listPendingPermissionAskRequests();
    expect(pending[0]!.status).toBe("pending");
  });

  it("④ CSRF 不匹配 ⇒ 拒绝，且状态不变", async () => {
    configurePermissive();
    const anchor = await registerPending();
    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
        csrfToken: "WRONG-CSRF",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();
    expect((await facade.listPendingPermissionAskRequests())[0]!.status).toBe("pending");
  });

  it("⑤ **知道 askIdentifier 与指纹不等于有权批准**（可见性/裁决权仍被校验）", async () => {
    // 权威端口：项目不可见、且无裁决权
    facade.configurePermissionAskAdjudication({
      authorityPort: {
        isProjectVisibleTo: async () => false,
        isSessionVisibleTo: async () => true,
        hasAdjudicationAuthority: async () => true,
      },
      csrfToken: "csrf-local-token",
      projectRootPath: baseDirectory,
    });
    const anchor = await registerPending();
    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
        csrfToken: "csrf-local-token",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();

    facade.configurePermissionAskAdjudication({
      authorityPort: {
        isProjectVisibleTo: async () => true,
        isSessionVisibleTo: async () => true,
        hasAdjudicationAuthority: async () => false,
      },
      csrfToken: "csrf-local-token",
      projectRootPath: baseDirectory,
    });
    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
        csrfToken: "csrf-local-token",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();
    expect((await facade.listPendingPermissionAskRequests())[0]!.status).toBe("pending");
  });

  it("⑥ 重复裁决 ⇒ 第二次被拒（不重复执行），状态仍为首次结果", async () => {
    configurePermissive();
    const anchor = await registerPending();
    const first = await facade.decidePermissionAskRequest({
      ownerAgentInstanceId: OWNER,
      askIdentifier: anchor.askIdentifier,
      decision: "allowed-once",
      expectedRequestRevision: anchor.requestRevision,
      expectedOperationFingerprint: anchor.operationFingerprint,
      csrfToken: "csrf-local-token",
      authenticatedAgentInstanceId: OWNER,
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
    });
    expect(first.record.status).toBe("allowed");

    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "denied",
        expectedRequestRevision: first.record.requestRevision,
        expectedOperationFingerprint: anchor.operationFingerprint,
        csrfToken: "csrf-local-token",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();
  });

  it("⑦ 陈旧 revision 与**指纹不符**均被拒（过期/参数变化不得复用批准）", async () => {
    configurePermissive();
    const anchor = await registerPending();

    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision + 5,
        expectedOperationFingerprint: anchor.operationFingerprint,
        csrfToken: "csrf-local-token",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();

    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: anchor.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: anchor.requestRevision,
        expectedOperationFingerprint: "sha256:" + "0".repeat(64),
        csrfToken: "csrf-local-token",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();

    expect((await facade.listPendingPermissionAskRequests())[0]!.status).toBe("pending");
  });

  it("⑧ 未知 askIdentifier ⇒ 拒绝（不得凭猜测批准）", async () => {
    configurePermissive();
    await registerPending();
    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: OWNER,
        askIdentifier: "ask-not-exists",
        decision: "allowed-once",
        expectedRequestRevision: 1,
        expectedOperationFingerprint: "sha256:" + "1".repeat(64),
        csrfToken: "csrf-local-token",
        authenticatedAgentInstanceId: OWNER,
        projectIdentifier: "astarray",
        sessionIdentifier: "gui-session-local",
      }),
    ).rejects.toThrow();
  });
});
