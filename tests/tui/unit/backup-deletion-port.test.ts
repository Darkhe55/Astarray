/**
 * S5：交互式删除备份授权通道测试。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { BackupDeletionAuthorizationRequest } from "../../../packages/core/src/core/types.js";
import { InteractiveBackupDeletionAuthorizationPort } from "../../../packages/tui/src/cli/backup-deletion-port.js";

/** 可注入的伪 TTY 输入流（Readable 子集）。 */
class FakeTtyInput extends EventEmitter {
  readonly isTTY = true;
  constructor() {
    super();
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  /** 写入一行输入（模拟用户回车）。 */
  answer(line: string): void {
    for (const chunk of `${line}\n`) {
      this.emit("data", chunk);
    }
  }
}

class NonTtyInput {
  readonly isTTY = false;
  readonly on = (..._args: unknown[]): unknown => undefined;
  readonly resume = (): unknown => undefined;
  readonly pause = (): unknown => undefined;
}

function makeRequest(): BackupDeletionAuthorizationRequest {
  return {
    authorizationRequestId: "request-1",
    requestingAgentInstanceId: "agent-a",
    toolCallId: "call-1",
    backupIdentifiers: ["backup-1", "backup-2"],
    warningText: "即将永久删除 2 个受保护备份",
    createdAtIso: "2026-08-12T10:00:00.000Z",
    canRememberForSession: false,
  };
}

describe("InteractiveBackupDeletionAuthorizationPort", () => {
  it("TTY 输入 yes → allow-once，且不携带会话记忆", async () => {
    const input = new FakeTtyInput();
    const warnings: string[] = [];
    const port = new InteractiveBackupDeletionAuthorizationPort({
      input,
      warnOutput: { write: (text) => warnings.push(text) },
    });
    const request = makeRequest();
    const decisionPromise = port.requestAuthorization(request);
    input.answer("yes");
    const decision = await decisionPromise;
    expect(decision.decision).toBe("allow-once");
    expect(decision.authorizedBackupIdentifiers).toEqual(["backup-1", "backup-2"]);
    expect(decision.authorizationRequestId).toBe(request.authorizationRequestId);
    const warningText = warnings.join("");
    expect(warningText).toContain("删除备份授权请求");
    expect(warningText).toContain("即将永久删除 2 个受保护备份");
    expect(warningText).toContain("仅本次生效，不记忆");
  });

  it("TTY 输入非 yes → deny", async () => {
    const input = new FakeTtyInput();
    const warnings: string[] = [];
    const port = new InteractiveBackupDeletionAuthorizationPort({
      input,
      warnOutput: { write: (text) => warnings.push(text) },
    });
    const decisionPromise = port.requestAuthorization(makeRequest());
    input.answer("no");
    const decision = await decisionPromise;
    expect(decision.decision).toBe("deny");
    expect(decision.authorizedBackupIdentifiers).toEqual([]);
    expect(warnings.join("")).toContain("用户拒绝");
  });

  it("非 TTY 环境 fail-closed：直接拒绝且不等待输入", async () => {
    const input = new NonTtyInput();
    const warnings: string[] = [];
    const port = new InteractiveBackupDeletionAuthorizationPort({
      input,
      warnOutput: { write: (text) => warnings.push(text) },
    });
    const decision = await port.requestAuthorization(makeRequest());
    expect(decision.decision).toBe("deny");
    expect(warnings.join("")).toContain("fail-closed");
  });

  it("默认输出目标为 stderr（JSON 模式 stdout 保持干净）", () => {
    const port = new InteractiveBackupDeletionAuthorizationPort({});
    expect(port["warnOutput"]).toBe(process.stderr);
  });
});
