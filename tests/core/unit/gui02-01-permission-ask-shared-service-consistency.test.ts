/**
 * GUI-02-01 行为反例：**N1 / N2** —— 同一请求经不同调用方（CLI / GUI）裁决结果一致，
 * 且**重复裁决不重复执行**（用户 2026-10-11 指定）。
 *
 * 用户原文：
 * > 补"**同一请求经 CLI／GUI 裁决结果一致**"和"**重复／过期裁决**"的反例。
 * > 重复点击不重复执行；多个页面并发裁决只能有一个有效结果。
 * > CLI 保留终端输入输出适配，**GUI 使用同一服务，不复制授权规则**。
 *
 * 本文件钉住（实现前必须红 —— 依赖"同一服务可被多个调用方共用"这一契约）：
 *  ① **N1 一致性**：同一请求、同一决定，经两个**独立调用方**（模拟 CLI 与 GUI 各自的
 *     认证适配）裁决 ⇒ 得到的**结果与事件字段一致**；且**只有一次状态迁移**。
 *  ② **N1 反向**：两个调用方给出**不同**决定 ⇒ 只有**先到者生效**，后者拿到
 *     `permission-ask-already-decided`（不得出现"两个都生效"）。
 *  ③ **N2 重复裁决**：同一调用方重复提交同一裁决 ⇒ 幂等失败，
 *     **revision 不重复前进**、`decidedByAgentInstanceId` 不被改写。
 *  ④ **N2 过期**：请求已过期 ⇒ 两个调用方**都**被拒（`permission-ask-expired`），
 *     不得出现"一边成功一边失败"。
 *  ⑤ **共用同一服务**：两个调用方**不各自持有授权规则** —— 它们只是同一服务的
 *     不同认证适配（本用例通过"同一 service 实例、不同 authorityPort 事实"表达）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionAskDecisionEntryService,
  type PermissionAskAuthorityPort,
} from "../../../packages/core/src/orchestration/permission-ask-decision-entry.js";
import { PermissionAskRequestStore } from "../../../packages/core/src/orchestration/permission-ask-request-store.js";

let baseDirectory: string;
let store: PermissionAskRequestStore;
let service: PermissionAskDecisionEntryService;

const PROJECT = "astarray";
const SESSION = "gui-session-local";
const OWNER = "worker:mission-1:T-001:1";
const CLI_DECIDER = "main-agent-cli";
const GUI_DECIDER = "main-agent-gui";
const CSRF = "shared-csrf";

/** 两个调用方共享同一套客观事实（同一权限引擎），只是**适配层不同**。 */
const sharedAuthorityPort: PermissionAskAuthorityPort = {
  isProjectVisibleTo: async (agentInstanceId, projectIdentifier) =>
    agentInstanceId.length > 0 && projectIdentifier === PROJECT,
  isSessionVisibleTo: async (agentInstanceId, sessionIdentifier) =>
    agentInstanceId.length > 0 && sessionIdentifier === SESSION,
  hasAdjudicationAuthority: async (agentInstanceId) =>
    agentInstanceId === CLI_DECIDER || agentInstanceId === GUI_DECIDER,
};

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ask-n1-"));
  store = new PermissionAskRequestStore({ baseDirectory });
  service = new PermissionAskDecisionEntryService({
    requestStore: store,
    projectRootPath: process.cwd(),
    authorityPort: sharedAuthorityPort,
  });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function register(lifetimeSeconds?: number) {
  return store.registerRequest({
    ownerAgentInstanceId: OWNER,
    taskIdentifier: "T-001",
    toolName: "createProjectFile",
    argumentsJson: '{"filePath":"src/a.ts","content":"const a = 1;"}',
    explanation: "需要写入项目文件",
    ...(lifetimeSeconds === undefined ? {} : { lifetimeSeconds }),
  });
}

/** 某个调用方（CLI 或 GUI）的认证适配：同一服务、不同主体。 */
function callerOf(decider: string, decision: "allowed-once" | "denied") {
  return async (record: {
    askIdentifier: string;
    requestRevision: number;
    operationFingerprint: string;
  }) =>
    service.decidePermissionAsk({
      askIdentifier: record.askIdentifier,
      decision,
      expectedRequestRevision: record.requestRevision,
      expectedOperationFingerprint: record.operationFingerprint,
      csrfToken: CSRF,
      expectedCsrfToken: CSRF,
      authenticatedAgentInstanceId: decider,
      projectIdentifier: PROJECT,
      sessionIdentifier: SESSION,
    });
}

describe("GUI-02-01 N1：同一请求经 CLI／GUI 裁决结果一致", () => {
  it("① 同一请求同一决定：两个调用方的**拒绝结果一致**，且只有一次状态迁移", async () => {
    const record = await register();
    const viaCli = callerOf(CLI_DECIDER, "denied");
    const viaGui = callerOf(GUI_DECIDER, "denied");

    // 调用方 A（模拟 CLI）先裁决
    const first = await viaCli(record);
    expect(first.record.status).toBe("denied");
    expect(first.record.requestRevision).toBe(2);

    // 调用方 B（模拟 GUI）对**同一请求**再裁决 ⇒ 必须拿到已裁决
    await expect(viaGui(record)).rejects.toMatchObject({
      errorCode: "permission-ask-already-decided",
    });

    const finalRecord = await store.readRequest(record.askIdentifier);
    expect(finalRecord?.status).toBe("denied");
    expect(
      finalRecord?.requestRevision,
      "只有一次状态迁移（revision 不得重复前进）",
    ).toBe(2);
    expect(finalRecord?.decidedByAgentInstanceId).toBe(CLI_DECIDER);
  });

  it("② 两个调用方给出**不同**决定 ⇒ 只有先到者生效，后者 already-decided", async () => {
    const record = await register();
    const allowViaCli = callerOf(CLI_DECIDER, "allowed-once");
    const denyViaGui = callerOf(GUI_DECIDER, "denied");

    const first = await allowViaCli(record);
    expect(first.record.status).toBe("allowed");
    await expect(denyViaGui(record)).rejects.toMatchObject({
      errorCode: "permission-ask-already-decided",
    });
    const finalRecord = await store.readRequest(record.askIdentifier);
    expect(
      finalRecord?.status,
      "不得出现『两个都生效』或状态被后者覆盖",
    ).toBe("allowed");
    expect(finalRecord?.requestRevision).toBe(2);
  });

  it("③ 并发给出不同决定 ⇒ 恰好一个生效（两个调用方同时点）", async () => {
    const record = await register();
    const results = await Promise.allSettled([
      callerOf(CLI_DECIDER, "allowed-once")(record),
      callerOf(GUI_DECIDER, "denied")(record),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const finalRecord = await store.readRequest(record.askIdentifier);
    expect(["allowed", "denied"]).toContain(finalRecord?.status);
    expect(finalRecord?.requestRevision).toBe(2);
  });
});

describe("GUI-02-01 N2：重复裁决与过期裁决", () => {
  it("④ 同一调用方**重复**提交同一裁决 ⇒ 幂等失败，decidedBy 不被改写", async () => {
    const record = await register();
    const viaGui = callerOf(GUI_DECIDER, "allowed-once");
    const first = await viaGui(record);
    expect(first.record.status).toBe("allowed");
    const decidedBy = first.record.decidedByAgentInstanceId;

    await expect(viaGui(record)).rejects.toMatchObject({
      errorCode: "permission-ask-already-decided",
    });
    const finalRecord = await store.readRequest(record.askIdentifier);
    expect(finalRecord?.requestRevision).toBe(2);
    expect(finalRecord?.decidedByAgentInstanceId).toBe(decidedBy);
  });

  it("⑤ 请求已过期 ⇒ **两个调用方都被拒**，不得一边成功一边失败", async () => {
    const record = await register(0);
    const results = await Promise.allSettled([
      callerOf(CLI_DECIDER, "allowed-once")(record),
      callerOf(GUI_DECIDER, "denied")(record),
    ]);
    for (const entry of results) {
      expect(entry.status).toBe("rejected");
      if (entry.status === "rejected") {
        expect((entry.reason as { errorCode?: string }).errorCode).toBe(
          "permission-ask-expired",
        );
      }
    }
    const finalRecord = await store.readRequest(record.askIdentifier);
    expect(finalRecord?.status).toBe("expired");
  });
});
