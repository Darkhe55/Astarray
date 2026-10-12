/**
 * GUI-02-01 行为反例：**裁决入口公共服务**（先红后绿）。
 *
 * 用户 2026-10-11 的原文边界：
 * > 裁决入口校验 **CSRF、认证主体、项目/会话可见性和裁决权限**。
 * > 裁决入口接收**请求 ID、决定及预期 revision／指纹**；服务器从**本地权威记录**
 * > 取原始参数，重新校验主体、权限、期限和当前状态。
 * > **不得接受前端提交的新参数替换原请求**，也不得**把知道请求 ID 或指纹当作有权批准**。
 * > **重复点击不重复执行**；**多个页面并发裁决只能有一个有效结果**。
 * > **执行前仍重新鉴权**。**关闭页面或重启不等于批准**；旧一次性批准不自动恢复。
 * > CLI 保留终端输入输出适配，**GUI 使用同一服务，不复制授权规则**。
 *
 * 本文件钉住（实现前必须红）：
 *  ① 缺 CSRF ⇒ 拒绝（`permission-ask-csrf-required`）；
 *  ② **认证主体**缺失/为空 ⇒ 拒绝；
 *  ③ **项目与会话可见性**不足 ⇒ 拒绝（跨项目/跨会话）；
 *  ④ **无裁决权** ⇒ 拒绝（**即便 ID 与指纹都正确**）；
 *  ⑤ 入参**只有** 请求 ID / 决定 / 预期 revision / 预期指纹 / 认证上下文 —— **没有参数位**；
 *  ⑥ 成功路径：状态迁移 + revision 递增 + 返回事件（供 SSE 广播，多页面同步）；
 *  ⑦ **并发裁决只有一个有效结果**（第二个拿到 `already-decided`）；
 *  ⑧ **执行前重新鉴权**：鉴权在裁决时点仍为否 ⇒ 拒绝（不因先前授权而放行）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PermissionAskDecisionEntryService } from "../../../packages/core/src/orchestration/permission-ask-decision-entry.js";
import { PermissionAskRequestStore } from "../../../packages/core/src/orchestration/permission-ask-request-store.js";

let baseDirectory: string;
let store: PermissionAskRequestStore;
let service: PermissionAskDecisionEntryService;
let visibleProjects: Set<string>;
let visibleSessions: Set<string>;
let visibleAgents: Set<string>;
let adjudicationAuthorities: Set<string>;

const PROJECT = "astarray";
const SESSION = "gui-session-local";
const DECIDER = "main-agent-1";
const OWNER = "worker:mission-1:T-001:1";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ask-entry-"));
  store = new PermissionAskRequestStore({ baseDirectory });
  visibleProjects = new Set([PROJECT]);
  visibleSessions = new Set([SESSION]);
  visibleAgents = new Set([DECIDER]);
  // 可见性与裁决权**分开**维护：才能分别验证"不可见"与"无裁决权"两种拒绝
  adjudicationAuthorities = new Set([DECIDER]);
  service = new PermissionAskDecisionEntryService({
    requestStore: store,
    projectRootPath: process.cwd(),
    authorityPort: {
      isProjectVisibleTo: async (agentInstanceId, projectIdentifier) =>
        visibleAgents.has(agentInstanceId) && visibleProjects.has(projectIdentifier),
      isSessionVisibleTo: async (agentInstanceId, sessionIdentifier) =>
        visibleAgents.has(agentInstanceId) && visibleSessions.has(sessionIdentifier),
      hasAdjudicationAuthority: async (agentInstanceId, projectIdentifier) =>
        adjudicationAuthorities.has(agentInstanceId) &&
        visibleProjects.has(projectIdentifier),
    },
  });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function register() {
  return store.registerRequest({
    ownerAgentInstanceId: OWNER,
    taskIdentifier: "T-001",
    toolName: "createProjectFile",
    argumentsJson: '{"filePath":"src/a.ts","content":"const a = 1;"}',
    explanation: "需要写入项目文件",
  });
}

function decideInput(record: { askIdentifier: string; requestRevision: number; operationFingerprint: string }, overrides: Record<string, unknown> = {}) {
  return {
    csrfToken: "valid-csrf",
    expectedCsrfToken: "valid-csrf",
    authenticatedAgentInstanceId: DECIDER,
    projectIdentifier: PROJECT,
    sessionIdentifier: SESSION,
    askIdentifier: record.askIdentifier,
    decision: "allowed-once" as const,
    expectedRequestRevision: record.requestRevision,
    expectedOperationFingerprint: record.operationFingerprint,
    ...overrides,
  };
}

describe("GUI-02-01 裁决入口：CSRF / 主体 / 可见性 / 裁决权", () => {
  it("① 缺 CSRF 或 CSRF 不匹配 ⇒ 拒绝", async () => {
    const record = await register();
    await expect(
      service.decidePermissionAsk(decideInput(record, { csrfToken: "wrong" })),
    ).rejects.toMatchObject({ errorCode: "permission-ask-csrf-required" });
    await expect(
      service.decidePermissionAsk(decideInput(record, { csrfToken: "" })),
    ).rejects.toMatchObject({ errorCode: "permission-ask-csrf-required" });
  });

  it("② 认证主体缺失或为空 ⇒ 拒绝", async () => {
    const record = await register();
    await expect(
      service.decidePermissionAsk(decideInput(record, { authenticatedAgentInstanceId: "" })),
    ).rejects.toMatchObject({ errorCode: "permission-ask-unauthenticated" });
    await expect(
      service.decidePermissionAsk(decideInput(record, { authenticatedAgentInstanceId: "  " })),
    ).rejects.toMatchObject({ errorCode: "permission-ask-unauthenticated" });
  });

  it("③ 项目或会话对该主体不可见 ⇒ 拒绝（跨项目/跨会话）", async () => {
    const record = await register();
    await expect(
      service.decidePermissionAsk(decideInput(record, { projectIdentifier: "other-project" })),
    ).rejects.toMatchObject({ errorCode: "permission-ask-not-visible" });
    await expect(
      service.decidePermissionAsk(decideInput(record, { sessionIdentifier: "other-session" })),
    ).rejects.toMatchObject({ errorCode: "permission-ask-not-visible" });
  });

  it("④ 无裁决权 ⇒ 拒绝（**即便请求 ID 与指纹都正确**）", async () => {
    const record = await register();
    // 该主体**可见**（能拿到 ID 与指纹）但**无裁决权** —— 正是要验证的情形
    visibleAgents.add("some-other-agent");
    await expect(
      service.decidePermissionAsk(
        decideInput(record, { authenticatedAgentInstanceId: "some-other-agent" }),
      ),
    ).rejects.toMatchObject({ errorCode: "permission-ask-not-authorized" });
    const readBack = await store.readRequest(record.askIdentifier);
    expect(readBack?.status, "被拒的裁决不得改变状态").toBe("pending");
  });

  it("⑤ 入参没有参数位（不得接受前端提交的新参数替换原请求）", () => {
    const allowedKeys = [
      "askIdentifier",
      "authenticatedAgentInstanceId",
      "csrfToken",
      "decision",
      "expectedCsrfToken",
      "expectedOperationFingerprint",
      "expectedRequestRevision",
      "projectIdentifier",
      "sessionIdentifier",
    ].sort();
    const exampleInput = decideInput({
      askIdentifier: "ask-1",
      requestRevision: 1,
      operationFingerprint: "sha256:" + "a".repeat(64),
    });
    expect(
      Object.keys(exampleInput).sort(),
      "裁决入参不得出现 argumentsJson 等参数位",
    ).toEqual(allowedKeys);
    expect(allowedKeys).not.toContain("argumentsJson");
  });
});

describe("GUI-02-01 裁决入口：成功路径、并发与重新鉴权", () => {
  it("⑥ 成功裁决 ⇒ 状态迁移 + revision 递增 + 返回可供 SSE 广播的事件", async () => {
    const record = await register();
    const outcome = await service.decidePermissionAsk(decideInput(record));
    expect(outcome.record.status).toBe("allowed");
    expect(outcome.record.requestRevision).toBe(record.requestRevision + 1);
    // 事件：多页面同步的依据
    expect(outcome.event.eventType).toBe("permission-ask");
    expect(outcome.event.status).toBe("allowed");
    expect(outcome.event.requestRevision).toBe(record.requestRevision + 1);
    expect(
      JSON.stringify(outcome.event).includes("argumentsJson"),
      "事件不得携带原始参数",
    ).toBe(false);
  });

  it("⑦ 并发裁决（两个页面同时点）⇒ **只有一个有效结果**，另一个拿到 already-decided", async () => {
    const record = await register();
    const results = await Promise.allSettled([
      service.decidePermissionAsk(decideInput(record, { decision: "allowed-once" })),
      service.decidePermissionAsk(decideInput(record, { decision: "denied" })),
    ]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(fulfilled.length, "并发裁决只能有一个有效结果").toBe(1);
    expect(rejected.length).toBe(1);
    const finalRecord = await store.readRequest(record.askIdentifier);
    expect(["allowed", "denied"]).toContain(finalRecord?.status);
    expect(finalRecord?.requestRevision).toBe(2);
  });

  it("⑧ 执行前重新鉴权：鉴权在裁决时点变为否 ⇒ 拒绝（不因先前授权放行）", async () => {
    const record = await register();
    adjudicationAuthorities.delete(DECIDER);
    await expect(service.decidePermissionAsk(decideInput(record))).rejects.toMatchObject({
      errorCode: "permission-ask-not-authorized",
    });
    const readBack = await store.readRequest(record.askIdentifier);
    expect(readBack?.status).toBe("pending");
  });

  it("⑨ 未知请求 ID ⇒ 明确拒绝（不猜、不静默）", async () => {
    await expect(
      service.decidePermissionAsk({
        csrfToken: "valid-csrf",
        expectedCsrfToken: "valid-csrf",
        authenticatedAgentInstanceId: DECIDER,
        projectIdentifier: PROJECT,
        sessionIdentifier: SESSION,
        askIdentifier: "ask-not-exist",
        decision: "denied",
        expectedRequestRevision: 1,
        expectedOperationFingerprint: "sha256:" + "1".repeat(64),
      }),
    ).rejects.toMatchObject({ errorCode: "permission-ask-not-found" });
  });
});
