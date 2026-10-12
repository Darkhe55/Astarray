/**
 * GUI-02-01 片② 行为反例：**权限询问事件的登记与发布**（先红后绿）。
 *
 * 背景：片① 让 CLI 能登记**请求实体**，但当时是 CLI **直接** import 核心 store
 * （绕过了门面）—— 这既让 CLI 承担了不该有的存储细节，也使**事件无法发布**
 * （事件必须经门面的订阅口广播给 GUI/多页面）。
 *
 * 本片把"登记 + 发布"收进**门面方法** `registerPermissionAskRequest()`，并断言：
 *  ① 返回可核对的记录（`askIdentifier` / `operationFingerprint` / `status` / `requestRevision`）；
 *  ② **通过 `subscribe` 广播 `permission-ask` 事件**（GUI 与多页面同步的数据来源）；
 *  ③ 事件**不含原始 `argumentsJson`**（用户明确禁止），只携安全预览；
 *  ④ 事件含多页面同步所需字段：`status` + `requestRevision` + `askIdentifier`；
 *  ⑤ 登记**不产生任何执行副作用**（不 unblock、不写产物）。
 *
 * 本文件在实现前必须失败（门面尚无该方法）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import type { PublicAstarrayEvent } from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;
let facade: AstarrayApplicationFacade;
let receivedEvents: PublicAstarrayEvent[];

const OWNER = "worker:mission-askreg:T-001:1";
const PROJECT_ROOT = process.cwd();
const ARGUMENTS = JSON.stringify({ filePath: "src/ask.ts", content: "const a = 1;\n" });

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ask-event-"));
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
  facade = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory: baseDirectory,
  });
  facade.createSession({ sessionId: "gui-session-local", mode: "assist" });
  receivedEvents = [];
  facade.subscribe((event) => {
    receivedEvents.push(event);
  });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function permissionAskEvents(): PublicAstarrayEvent[] {
  return receivedEvents.filter(
    (event) => (event as { eventType?: string }).eventType === "permission-ask",
  );
}

describe("GUI-02-01 片②：门面登记权限询问并广播事件", () => {
  it("① 登记返回可核对记录，并**广播一条 permission-ask 事件**", async () => {
    const record = await facade.registerPermissionAskRequest({
      ownerAgentInstanceId: OWNER,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: ARGUMENTS,
      explanation: "需要写入项目文件",
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });

    expect(record.askIdentifier.length).toBeGreaterThan(0);
    expect(record.operationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.status).toBe("pending");
    expect(record.requestRevision).toBe(1);

    const events = permissionAskEvents();
    expect(events.length, "登记必须广播事件（GUI/多页面同步来源）").toBe(1);
  });

  it("② 事件含多页面同步所需字段，且**不含原始 argumentsJson**", async () => {
    await facade.registerPermissionAskRequest({
      ownerAgentInstanceId: OWNER,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: ARGUMENTS,
      explanation: "需要写入项目文件",
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });

    const event = permissionAskEvents()[0] as unknown as Record<string, unknown>;
    expect(event["askIdentifier"]).toBeTruthy();
    expect(event["status"]).toBe("pending");
    expect(event["requestRevision"]).toBe(1);
    expect(event["operationFingerprint"]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(event["agentInstanceId"]).toBe(OWNER);
    expect(event["projectIdentifier"]).toBe("astarray");
    expect(event["sessionIdentifier"]).toBe("gui-session-local");
    expect(event["action"]).toBe("create");
    // 禁止原始参数**字段**进事件
    expect(
      JSON.stringify(event).includes("argumentsJson"),
      "公共事件不得携带原始参数字段",
    ).toBe(false);
    /**
     * **不**断言"事件不得包含变更文本" —— 那是**过度断言**：用户明确要求
     * "文件写入可提供**按权限过滤的差异预览**"，故 `diffPreview` 里出现
     * `+ const a = 1;` 是**正确行为**（该内容不含秘密）。
     * 真正要禁的是**原始参数对象**（上面那条）与**秘密值**（见用例④）。
     */
    expect(event["preview"]).toBeTruthy();
  });

  it("③ 登记**不产生执行副作用**：任务未被执行、无产物写出", async () => {
    await facade.registerPermissionAskRequest({
      ownerAgentInstanceId: OWNER,
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: ARGUMENTS,
      explanation: "需要写入项目文件",
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });

    // 只登记：不得写出被请求的文件
    expect(
      await fs
        .access(path.join(PROJECT_ROOT, "src", "ask.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    // 且事件列表里不得出现 task-status/task-finished 这类"执行进展"事件
    const executionEvents = receivedEvents.filter((event) =>
      ["task-status", "task-finished"].includes(
        (event as { eventType?: string }).eventType ?? "",
      ),
    );
    expect(executionEvents, "登记不得触发任务执行").toHaveLength(0);
  });

  it("④ 敏感路径 ⇒ 事件标记需受控详情，且不含内容", async () => {
    await facade.registerPermissionAskRequest({
      ownerAgentInstanceId: OWNER,
      taskIdentifier: "T-002",
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({
        filePath: ".env",
        content: "SECRET_VALUE_MUST_NOT_LEAK=1",
      }),
      explanation: "写入环境文件",
      projectIdentifier: "astarray",
      sessionIdentifier: "gui-session-local",
      projectRootPath: PROJECT_ROOT,
    });

    const event = permissionAskEvents()[0] as unknown as Record<string, unknown>;
    const preview = event["preview"] as Record<string, unknown>;
    expect(preview["requiresControlledDetail"]).toBe(true);
    expect(JSON.stringify(event)).not.toContain("SECRET_VALUE_MUST_NOT_LEAK");
  });
});
