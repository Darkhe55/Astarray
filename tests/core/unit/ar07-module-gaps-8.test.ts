/**
 * AR-07 批次 7/8：剩余零散分支补测。
 * 覆盖：进度守卫显式时钟、会话提升显式时钟与覆盖更窄分支、权限组文档 schema 非法、
 * 策略包装层非 DomainError 兜底、敏感内容附加模式右操作数分支、反馈入口零散分支。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import type { FeedbackIpcMessage } from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { runFeedbackProcessEntry } from "../../../packages/core/src/feedback-process/entrypoint.js";
import type { ChildProcessLike } from "../../../packages/core/src/feedback-process/entrypoint.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider, SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { LocalProgressAndCycleGuard } from "../../../packages/core/src/tools/local-progress-and-cycle-guard.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { SensitiveContentAccessPolicy } from "../../../packages/core/src/tools/sensitive-content-access-policy.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let temporaryDirectory: string;
const ISO = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07-b8-"));
});

afterEach(async () => {
  await fs
    .rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    .catch(() => {});
});

describe("AR-07 批次8：显式时钟与覆盖更窄分支", () => {
  it("进度守卫与提升存储显式注入时钟", async () => {
    const guard = new LocalProgressAndCycleGuard({
      nowUnixMilliseconds: () => 1_000,
    });
    expect(
      await guard.recordCallAndDetectViolation({
        callerKey: "a",
        calleeKey: "b",
        nodeKind: "tool",
        taskExecutionId: null,
        outcomeSignature: null,
        isNewProgress: false,
      }),
    ).toBeNull();

    const markedStore = new SessionPermissionElevationStore({
      nowUnixMilliseconds: () => 2_000,
    });
    expect(markedStore.getNowUnixMilliseconds()).toBe(2_000);
  });

  it("基础决定已为 allow 时更窄覆盖不生效", async () => {
    const store = new SessionPermissionElevationStore({ nowUnixMilliseconds: () => 1 });
    const controller = new SessionPermissionElevationController(store);
    await controller.createElevation({
      sessionId: "session-allow",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "project.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "devolve" },
      baseProfileRevision: 1,
      catalogVersion: 1,
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "decision-allow",
      sessionPermissionRevision: 1,
    });
    const resolver = new EffectiveSecondaryPermissionResolver();
    const decision = await resolver.resolveEffectiveDecision({
      agentInstanceId: "agent-a",
      sessionId: "session-allow",
      capabilityId: "project.read",
      baseProfile: {
        schemaVersion: 1,
        permissionProfileId: "builtin:devolve",
        displayName: "Devolve",
        isBuiltin: true,
        revision: 1,
        catalogVersion: 1,
        capabilityDecisions: { "project.read": "allow" },
        fallbackDecision: "allow",
        frozenSignature: null,
        createdAtIso: ISO,
        updatedAtIso: ISO,
      } as never,
      currentProfileReference: { kind: "builtin", profileId: "devolve" },
      elevationStore: store,
      nowUnixMilliseconds: 1,
      isAgentRetired: false,
      currentSessionPermissionRevision: 1,
      requestedResourceScope: "workspace",
    });
    expect(decision).toBe("allow");
  });
});

describe("AR-07 批次8：权限组文档非法与策略包装层兜底", () => {
  it("合法 JSON 但 schema 不符的权限组文档 → journal-corrupted", async () => {
    const store = new PermissionProfileStore({ baseDirectory: temporaryDirectory });
    const profilesDirectory = path.join(temporaryDirectory, "permission-profiles");
    await fs.mkdir(profilesDirectory, { recursive: true });
    await fs.writeFile(
      path.join(profilesDirectory, "profile-bad-schema.json"),
      JSON.stringify({ schemaVersion: 2, permissionProfileId: "profile-bad-schema" }),
      "utf8",
    );
    await expect(
      store.readCustomProfile("profile-bad-schema"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("审计回调抛非 DomainError → 返回 unknown 错误码", async () => {
    const modeMachine = new ModeMachine("assist");
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(
        modeMachine,
        new SessionAuthorizationManager(),
      ),
      registry,
      workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => 1,
      getCurrentMode: () => modeMachine.getCurrentMode(),
      auditSink: () => {
        throw new Error("审计写入失败");
      },
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: path.join(temporaryDirectory, "state"),
      }),
    });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: path.join(temporaryDirectory, "x.txt") }),
      "call-audit-failure",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "error", errorCode: "unknown" });
  });
});

describe("AR-07 批次8：敏感内容附加模式路径匹配", () => {
  it("附加模式命中完整路径但不命中文件名", () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePatterns: [/parent-only/],
    });
    expect(policy.matchSensitivePathName("C:/parent-only/notes.txt")).toBe(
      "admin-extended",
    );
  });
});

describe("AR-07 批次8：反馈入口零散分支", () => {
  class FakeParent implements ChildProcessLike {
    connected = true;
    pid = 4_242;
    sentMessages: FeedbackIpcMessage[] = [];
    private messageListeners: Array<(message?: FeedbackIpcMessage) => void> = [];

    send(message: FeedbackIpcMessage): boolean {
      this.sentMessages.push(message);
      return true;
    }

    on(
      event: "message" | "disconnect",
      listener: (message?: FeedbackIpcMessage) => void,
    ): void {
      if (event === "message") {
        this.messageListeners.push(listener);
      }
    }

    emitMessage(message?: FeedbackIpcMessage): void {
      for (const listener of this.messageListeners) {
        listener(message);
      }
    }
  }

  function makeMessage(recipientId: string, index: number): FeedbackMessage {
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      source: {
        sourceType: "agent",
        agentInstanceId: `instance-${index}`,
        agentRole: "tertiary",
      },
      recipientId,
      priority: "success",
      createdAtIso: ISO,
      idempotencyKey: `ar07-b8-${recipientId}-${index}`,
      payload: { kind: "success", summary: `批次8 ${index}` },
    };
  }

  it("非连通通道不发消息；undefined 消息被忽略", () => {
    const parent = new FakeParent();
    parent.connected = false;
    const exitRequests: number[] = [];
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: (code) => exitRequests.push(code),
      writeStderr: () => {},
    });
    parent.emitMessage({ type: "health", requestId: "health-1" });
    parent.emitMessage(undefined);
    expect(parent.sentMessages).toHaveLength(0);
    expect(exitRequests).toEqual([1]);
  });

  it("未先握手即关闭时不清理心跳看门狗", async () => {
    const parent = new FakeParent();
    const exitRequests: number[] = [];
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: (code) => exitRequests.push(code),
      writeStderr: () => {},
    });
    parent.emitMessage({ type: "shutdown", requestId: "shutdown-1" });
    expect(parent.sentMessages).toEqual([
      { type: "shutdownComplete", requestId: "shutdown-1" },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitRequests).toEqual([0]);
  });

  it("replay 遇到未投递消息不计数", async () => {
    vi.useFakeTimers();
    try {
      const parent = new FakeParent();
      runFeedbackProcessEntry(parent, {
        defaultBaseDirectory: temporaryDirectory,
        processExit: () => {},
        writeStderr: () => {},
      });
      const seededJournal = new MailboxJournal(temporaryDirectory);
      await seededJournal.enqueue(makeMessage("recipient-b8", 1));
      parent.emitMessage({
        type: "hello",
        protocolVersion: 1,
        baseDirectory: temporaryDirectory,
        heartbeatTimeoutMilliseconds: 30_000,
      });
      parent.emitMessage({
        type: "replay",
        requestId: "replay-b8",
        recipientId: "recipient-b8",
      });
      await vi.waitFor(
        () => {
          expect(
            parent.sentMessages.some((message) => message.type === "replayResult"),
          ).toBe(true);
        },
        { timeout: 5_000, interval: 1 },
      );
      const replayResult = parent.sentMessages.find(
        (message) => message.type === "replayResult",
      );
      expect(replayResult).toMatchObject({ replayCount: 0 });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
