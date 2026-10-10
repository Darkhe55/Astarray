/**
 * RELIABILITY-01-02 反例（2026-10-10，「提前拒绝结算」同族）：
 * **敏感内容禁读**在触达资源**之前**被本地策略拒绝，必须按"确定无副作用"结算。
 *
 * 背景：本会话已修过两处同族缺陷（`tool-not-found` 未列入提前拒绝集合；
 * `PolicyWrapper` 丢弃 `SideEffectNoneError` 声明的 `sideEffectStatus`）。
 * 本轮实测发现第三处：`SensitiveContentAccessPolicy.buildDenial()` 抛的是**普通
 * `DomainError`**（不携带"确定无副作用"语义），于是：
 *   PolicyWrapper 只能报 `sideEffectStatus: "unknown"` ⇒ 范围门禁的预留进入
 *   `requires-reconciliation` ⇒ 该逻辑操作**永久**无法重试（须人工对账），
 *   尽管**这次读取从未发生**（拒绝发生在打开文件之前，由路径规则判定）。
 *
 * 期望：触达资源**之前**的本地策略拒绝必须声明"确定无副作用"（`none`）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";
import { SensitiveContentAccessPolicy } from "../../../packages/core/src/tools/sensitive-content-access-policy.js";

let workspaceDirectory: string;
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sensitive-none-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  // 敏感文件名（本地路径规则即可判定，无需读取内容）
  await fs.writeFile(path.join(workspaceDirectory, ".env"), "SECRET=1\n", "utf8");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("RELIABILITY-01-02：敏感禁读必须按无副作用结算", () => {
  it("① 路径规则拒绝的读取：必须报 sideEffectStatus=none（否则预留被永久毒化）", async () => {
    const modeMachine = new ModeMachine("devolve");
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const protectedStoragePolicy = new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    });
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
      registry,
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => modeMachine.getCurrentMode(),
      requestingAgentInstanceId: "agent-sensitive",
      taskExecutionId: "task-sensitive",
      protectedStoragePolicy,
      sensitiveContentAccessPolicy: new SensitiveContentAccessPolicy(),
    } as never);

    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: ".env" }),
      "call-sensitive-read",
      new AbortController().signal,
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      // 拒绝发生在打开文件之前 ⇒ 确定无副作用
      expect(result.errorCode).toBe("sensitive-content-read-denied");
      expect(
        result.sideEffectStatus,
        "敏感禁读必须声明 none（否则门禁预留进入 requires-reconciliation，永久无法重试）",
      ).toBe("none");
    }
  });
});
