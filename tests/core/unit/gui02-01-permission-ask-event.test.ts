/**
 * GUI-02-01 行为反例：权限询问的**公共事件**（先红后绿）。
 *
 * 用户 2026-10-11 的字段白名单（原文）：
 * > 在你建议的字段上，补齐或复用公共事件信封中的：
 * > - `projectIdentifier`、`sessionIdentifier`；
 * > - 发起方具体 `agentInstanceId`；
 * > - `action`：工具包含多种操作时必须明确；
 * > - `operationFingerprint`：绑定本地保存的完整规范化参数；
 * > - 请求状态及请求自身的 revision，用于多页面同步和拒绝陈旧裁决。
 * > **不重复已有信封字段。** `explanation` 和参数摘要也必须经过本地脱敏与长度限制。
 * > **禁止原始 argumentsJson 进入公共事件。**
 *
 * 本文件钉住：
 *  ① 事件只含**白名单字段**，且**不含 `argumentsJson`**；
 *  ② 必含 `projectIdentifier` / `sessionIdentifier` / `agentInstanceId` /
 *     `action` / `operationFingerprint` / 请求状态 / 请求自身 revision / `askIdentifier`；
 *  ③ 携带的是**安全预览**（本地脱敏+限长），而不是原始参数；
 *  ④ **参数中的秘密绝不出现**在事件里；
 *  ⑤ 裁决后事件反映**新状态与新 revision**（多页面同步 / 拒绝陈旧裁决的依据）。
 *
 * 本文件在实现前必须失败（事件类型与构造函数尚不存在）。
 */
import { describe, expect, it } from "vitest";

import {
  buildPermissionAskEvent,
  PERMISSION_ASK_EVENT_TYPE,
} from "../../../packages/core/src/orchestration/permission-ask-event.js";
import type { PermissionAskRequestRecord } from "../../../packages/core/src/orchestration/permission-ask-request-store.js";

const PROJECT_ROOT = process.cwd();

function recordFixture(
  overrides: Partial<PermissionAskRequestRecord> = {},
): PermissionAskRequestRecord {
  return {
    askIdentifier: "ask-1",
    ownerAgentInstanceId: "worker:mission-1:T-001:1",
    taskIdentifier: "T-001",
    toolName: "createProjectFile",
    argumentsJson: '{"filePath":"src/a.ts","content":"const a = 1;\\n"}',
    explanation: "需要写入项目文件",
    operationFingerprint: "sha256:" + "a".repeat(64),
    status: "pending",
    requestRevision: 1,
    createdAtIso: "2026-10-11T00:00:00.000Z",
    expiresAtIso: "2026-10-11T00:15:00.000Z",
    decidedAtIso: null,
    decidedByAgentInstanceId: null,
    ...overrides,
  };
}

const ALLOWED_EVENT_KEYS = [
  "action",
  "agentInstanceId",
  "askIdentifier",
  "eventType",
  "expiresAtIso",
  "idempotencyId",
  "operationFingerprint",
  "preview",
  "projectIdentifier",
  "requestRevision",
  "revision",
  "sessionIdentifier",
  "status",
  "taskIdentifier",
  "toolName",
].sort();

describe("GUI-02-01 公共事件：字段白名单与脱敏", () => {
  it("① 事件只含白名单字段，且**不含 argumentsJson**", () => {
    const event = buildPermissionAskEvent({
      record: recordFixture(),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });
    expect(Object.keys(event).sort()).toEqual(ALLOWED_EVENT_KEYS);
    expect(
      JSON.stringify(event).includes("argumentsJson"),
      "公共事件禁止携带原始参数",
    ).toBe(false);
  });

  it("② 必含项目/会话/发起方具体个体/动作/指纹/状态/请求 revision", () => {
    const event = buildPermissionAskEvent({
      record: recordFixture(),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });
    expect(event.eventType).toBe(PERMISSION_ASK_EVENT_TYPE);
    expect(event.projectIdentifier).toBe("astarray");
    expect(event.sessionIdentifier).toBe("gui-session-local");
    expect(event.agentInstanceId).toBe("worker:mission-1:T-001:1");
    expect(event.action).toBe("create");
    expect(event.operationFingerprint).toBe("sha256:" + "a".repeat(64));
    expect(event.status).toBe("pending");
    expect(event.requestRevision).toBe(1);
    expect(event.askIdentifier).toBe("ask-1");
    expect(event.toolName).toBe("createProjectFile");
    // 供多页面同步 / 拒绝陈旧裁决：事件自身也有 revision 与幂等 ID
    expect(typeof event.revision).toBe("number");
    expect(event.idempotencyId.length).toBeGreaterThan(0);
  });

  it("③ 携带的是**安全预览**（结构化），而非原始参数", () => {
    const event = buildPermissionAskEvent({
      record: recordFixture(),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });
    expect(event.preview.action).toBe("create");
    expect(event.preview.targetPathRelative).toBe("src/a.ts");
    expect(event.preview.contentLength).toBeGreaterThan(0);
    expect(event.preview.impactScope.length).toBeGreaterThan(0);
  });

  it("④ 参数或说明中的秘密**绝不出现**在事件里", () => {
    const event = buildPermissionAskEvent({
      record: recordFixture({
        argumentsJson: JSON.stringify({
          filePath: "src/config.ts",
          content: "apiKey = sk-abcdefghijklmnopqrstuvwxyz012345",
        }),
        explanation: "使用 Bearer abcdefghijklmnopqrstuvwxyz 调用",
      }),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(serialized).not.toMatch(/Bearer\s+abcdefghijklmnopqrstuvwxyz/);
    /**
     * 说明：**变量名不是秘密** —— `diffPreview` 里出现 `apiKey`（值已 `[REDACTED]`）
     * 是正确行为；本用例只要求**秘密值**不出现（那才是安全性质）。
     */
    expect(serialized).toContain("[REDACTED]");
  });

  it("⑤ 敏感路径 ⇒ 事件标记需受控详情，且不含内容", () => {
    const event = buildPermissionAskEvent({
      record: recordFixture({
        argumentsJson: JSON.stringify({
          filePath: ".env",
          content: "SECRET_SHOULD_NOT_APPEAR=1",
        }),
      }),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });
    expect(event.preview.requiresControlledDetail).toBe(true);
    expect(JSON.stringify(event)).not.toContain("SECRET_SHOULD_NOT_APPEAR");
  });

  it("⑥ 裁决后的事件反映**新状态与新 revision**（陈旧裁决据此被拒）", () => {
    const decided = buildPermissionAskEvent({
      record: recordFixture({
        status: "allowed",
        requestRevision: 2,
        decidedAtIso: "2026-10-11T00:05:00.000Z",
        decidedByAgentInstanceId: "main-agent-1",
      }),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });
    expect(decided.status).toBe("allowed");
    expect(decided.requestRevision).toBe(2);
  });

  it("idempotencyIdFactory 返回 **null** 时回退到默认 ID（覆盖 `??` 兜底分支）", () => {
    /**
     * `idempotencyIdFactory?.(record) ?? 默认值` —— `??` **只对 `null`/`undefined` 生效**。
     * （我起初误以为空串也会回退，实测得到**空 ID** ⇒ 证明 `??` 不回退空串；
     * 这是**我的错误假设**，已按真实语义改正。）
     */
    const event = buildPermissionAskEvent({
      record: recordFixture(),
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
      idempotencyIdFactory: (() => null) as unknown as (
        record: PermissionAskRequestRecord,
      ) => string,
    });
    expect(event.idempotencyId).toBe("permission-ask:ask-1:1");
  });
});
