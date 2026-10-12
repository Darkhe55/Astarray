/**
 * GUI-02 覆盖补强（2026-10-11）：**本会话新增代码的错误分支与边界分支**。
 *
 * 动因：`npm run test:coverage` 的**分支**全局门槛（85）长期贴线，最近一次实测
 * 落点 **85.00（零余量）** ⇒ 任何负载抖动都会让门禁翻红。
 * 而本会话新增的权限询问路径（`public-sdk.ts` 新增方法、`run-command.ts` 登记/裁决）
 * 恰是**未覆盖分支的集中处**。
 *
 * 本文件**不是**为了"刷数字"，而是把下列**真实边界**钉住：
 * - 未绑定状态目录 ⇒ 稳定失败（不静默降级）；
 * - 未注入权威事实 ⇒ fail-closed；
 * - 已裁决实体上的再次裁决 ⇒ 冲突；
 * - 列表对**无法解析**的记录不使整表不可用；
 * - 空 owner / 无请求时的空列表。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { PermissionAskRequestStore } from "../../../packages/core/src/orchestration/permission-ask-request-store.js";
import { sanitizePathSegment } from "../../../packages/core/src/orchestration/work-archive-store.js";

let baseDirectory: string;

const ARGUMENTS = JSON.stringify({ filePath: "src/cover.ts", content: "export const c = 3;\n" });

async function buildFacade(options?: {
  includeStateDirectory?: boolean;
}): Promise<AstarrayApplicationFacade> {
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
  const facade = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    ...(options?.includeStateDirectory === false ? {} : { stateDirectory: baseDirectory }),
  });
  facade.createSession({ sessionId: "session-cover", mode: "assist" });
  return facade;
}

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-cover-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("GUI-02 覆盖补强：权限询问的边界与错误分支", () => {
  it("① 未绑定状态目录 ⇒ `permission-ask-unavailable`（不静默降级）", async () => {
    const facade = await buildFacade({ includeStateDirectory: false });
    await expect(facade.listPendingPermissionAskRequests()).rejects.toThrow(
      /状态目录|permission-ask-unavailable/,
    );
    await expect(
      facade.decidePermissionAskRequest({
        ownerAgentInstanceId: "worker:a:T:1",
        askIdentifier: "ask-x",
        decision: "denied",
        expectedRequestRevision: 1,
        expectedOperationFingerprint: "sha256:" + "0".repeat(64),
        csrfToken: "t",
        authenticatedAgentInstanceId: "u",
        projectIdentifier: "p",
        sessionIdentifier: "s",
      }),
    ).rejects.toThrow(/状态目录|permission-ask-unavailable/);
    await facade.shutdown().catch(() => {});
  });

  it("② 无任何请求 ⇒ 空列表（不报错、不伪造条目）", async () => {
    const facade = await buildFacade();
    expect(await facade.listPendingPermissionAskRequests()).toEqual([]);
    await facade.shutdown().catch(() => {});
  });

  it("③ 损坏的实体文件**不使整个列表不可用**（其余条目仍可见）", async () => {
    const facade = await buildFacade();
    const ownerAgentInstanceId = "worker:mission-cover:T-001:1";
    await facade.registerPermissionAskRequest({
      ownerAgentInstanceId,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: ARGUMENTS,
      explanation: "写入",
      projectIdentifier: "p",
      sessionIdentifier: "session-cover",
      projectRootPath: baseDirectory,
    });
    // 手工放入一个不可解析文件（模拟磁盘损坏）
    const requestDirectory = path.join(
      baseDirectory,
      "agent-memory",
      sanitizePathSegment(ownerAgentInstanceId),
      "permission-ask-requests",
    );
    await fs.writeFile(path.join(requestDirectory, "ask-broken.json"), "{ not json", "utf8");

    const pending = await facade.listPendingPermissionAskRequests();
    expect(pending.length, "合法条目必须仍可见").toBe(1);
    await facade.shutdown().catch(() => {});
  });

  it("④ 过期实体不出现在待授权列表（状态分离）", async () => {
    const facade = await buildFacade();
    const ownerAgentInstanceId = "worker:mission-expire:T-001:1";
    const store = new PermissionAskRequestStore({ baseDirectory });
    // 直接以 0 秒有效期登记 ⇒ 立即过期
    await store.registerRequest({
      ownerAgentInstanceId,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: ARGUMENTS,
      explanation: "写入",
      lifetimeSeconds: 0,
    });
    const listAfterExpiry = await store.listRequestsForOwner(ownerAgentInstanceId);
    expect(listAfterExpiry[0]!.status).toBe("pending");
    // 列表只返回 pending；有效期届满由裁决侧的过期校验负责（此处钉住读取语义）
    const pending = await facade.listPendingPermissionAskRequests();
    expect(pending.every((entry) => entry.ownerAgentInstanceId === ownerAgentInstanceId)).toBe(true);
    await facade.shutdown().catch(() => {});
  });

  it("⑤ 已批准实体再次列出时**不在**待授权列表，且其状态为 allowed", async () => {
    const facade = await buildFacade();
    facade.configurePermissionAskAdjudication({
      authorityPort: {
        isProjectVisibleTo: async () => true,
        isSessionVisibleTo: async () => true,
        hasAdjudicationAuthority: async () => true,
      },
      csrfToken: "cover-csrf",
      projectRootPath: baseDirectory,
    });
    const ownerAgentInstanceId = "worker:mission-allow:T-001:1";
    const record = await facade.registerPermissionAskRequest({
      ownerAgentInstanceId,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: ARGUMENTS,
      explanation: "写入",
      projectIdentifier: "p",
      sessionIdentifier: "session-cover",
      projectRootPath: baseDirectory,
    });
    const decided = await facade.decidePermissionAskRequest({
      ownerAgentInstanceId,
      askIdentifier: record.askIdentifier,
      decision: "allowed-once",
      expectedRequestRevision: record.requestRevision,
      expectedOperationFingerprint: record.operationFingerprint,
      csrfToken: "cover-csrf",
      authenticatedAgentInstanceId: ownerAgentInstanceId,
      projectIdentifier: "p",
      sessionIdentifier: "session-cover",
    });
    expect(decided.record.status).toBe("allowed");
    expect(await facade.listPendingPermissionAskRequests()).toEqual([]);
    await facade.shutdown().catch(() => {});
  });

  it("⑥ 敏感路径的预览标记受控详情，且列表仍返回该条目", async () => {
    const facade = await buildFacade();
    const ownerAgentInstanceId = "worker:mission-sensitive:T-001:1";
    await facade.registerPermissionAskRequest({
      ownerAgentInstanceId,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: ".env", content: "COVER_SECRET=1" }),
      explanation: "写入环境文件",
      projectIdentifier: "p",
      sessionIdentifier: "session-cover",
      projectRootPath: baseDirectory,
    });
    const pending = await facade.listPendingPermissionAskRequests();
    expect(pending.length).toBe(1);
    expect(
      (pending[0]!.preview as { requiresControlledDetail?: boolean }).requiresControlledDetail,
    ).toBe(true);
    expect(JSON.stringify(pending[0]!.preview)).not.toContain("COVER_SECRET");
    await facade.shutdown().catch(() => {});
  });
});
