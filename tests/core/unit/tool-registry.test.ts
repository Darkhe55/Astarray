import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
  hashToolArguments,
} from "../../../packages/core/src/core/permission-policy.js";
import type { ToolCallResult } from "../../../packages/core/src/core/types.js";
import type { ToolAuditEvent } from "../../../packages/core/src/tools/policy-wrapper.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

type ErrorToolCallResult = Extract<ToolCallResult, { kind: "error" }>;
type SuccessToolCallResult = Extract<ToolCallResult, { kind: "success" }>;

function expectError(result: ToolCallResult): ErrorToolCallResult {
  expect(result.kind).toBe("error");
  return result as ErrorToolCallResult;
}

function expectSuccess(result: ToolCallResult): SuccessToolCallResult {
  expect(result.kind).toBe("success");
  return result as SuccessToolCallResult;
}
const NOW_UNIX_SECONDS = 1_800_000_000;

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-tools-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(path.join(temporaryDirectory, "temp"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  return registry;
}

function buildWrapper(options: {
  mode: "ponder" | "assist" | "devolve";
  workerAllowedToolNames?: Set<string> | null;
  auditEvents?: ToolAuditEvent[];
}): PolicyWrapper {
  const modeMachine = new ModeMachine(options.mode);
  const sessionManager = new SessionAuthorizationManager();
  const decider = new PermissionDecider(modeMachine, sessionManager);
  return new PolicyWrapper({
    permissionDecider: decider,
    registry: buildRegistry(),
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    workerAllowedToolNames: options.workerAllowedToolNames ?? null,
    nowUnixSeconds: () => NOW_UNIX_SECONDS,
    getCurrentMode: () => modeMachine.getCurrentMode(),
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    auditSink: (event) => options.auditEvents?.push(event),
  });
}

describe("ToolRegistry", () => {
  it("主 Agent 只获得名称+摘要预览", () => {
    const registry = buildRegistry();
    const previews = registry.getPreviewDescriptors();
    expect(previews.length).toBeGreaterThan(0);
    for (const preview of previews) {
      expect(preview).toEqual({ name: expect.any(String), summary: expect.any(String) });
      expect(preview).not.toHaveProperty("inputSchema");
    }
  });

  it("三级 Agent 只获得任务所需工具子集", () => {
    const registry = buildRegistry();
    const subset = registry.getSubsetForTask("doc");
    expect(subset.every((descriptor) => descriptor.supportedTaskTypes.includes("doc"))).toBe(true);
    expect(subset.some((descriptor) => descriptor.name === "readFile")).toBe(true);
  });

  it("shell/删除/安装/发布/付款类工具默认未注册", () => {
    const registry = buildRegistry();
    for (const dangerousToolName of [
      "shell",
      "deleteFile",
      "npmInstall",
      "publish",
      "payment",
    ]) {
      expect(registry.isRegistered(dangerousToolName)).toBe(false);
    }
  });

  it("重复注册抛错", () => {
    const registry = new ToolRegistry();
    registry.register(BUILTIN_TOOL_DESCRIPTORS[0]!);
    expect(() => registry.register(BUILTIN_TOOL_DESCRIPTORS[0]!)).toThrowError(/重复注册/);
  });

  it("破坏性工具未提供工具内自动备份时拒绝注册", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "replaceText",
        summary: "替换文本",
        category: "restricted",
        mutationKind: "replace",
        backupPolicy: "not-required",
        authorizationPolicy: "standard",
        supportedTaskTypes: ["doc"],
        inputSchema: { type: "object" },
      }),
    ).toThrowError(/自动备份/);
  });

  it("删除备份工具必须使用独立特权删除策略", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "deleteBackup",
        summary: "删除受保护备份",
        category: "restricted",
        mutationKind: "delete-protected-backup",
        backupPolicy: "automatic-preimage",
        authorizationPolicy: "backup-deletion",
        supportedTaskTypes: ["maintenance"],
        inputSchema: { type: "object" },
      }),
    ).toThrowError(/特权删除策略/);
  });

  it("删除备份工具拒绝标准授权策略", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "deleteBackup",
        summary: "删除受保护备份",
        category: "restricted",
        mutationKind: "delete-protected-backup",
        backupPolicy: "protected-vault-deletion",
        authorizationPolicy: "standard",
        supportedTaskTypes: ["maintenance"],
        inputSchema: { type: "object" },
      }),
    ).toThrowError(/专用授权策略/);
  });

  it("工具描述注入 token 估算：更长描述产生更多 token", () => {
    const shortDescriptors = [{ name: "a", summary: "s", inputSchema: {} }];
    const longDescriptors = [
      { name: "veryLongToolName", summary: "这是一段很长的工具说明文字，用于估算 token 数量", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
    ];
    const shortTokenCount = ToolRegistry.estimateDescriptorTokenCount(shortDescriptors);
    const longTokenCount = ToolRegistry.estimateDescriptorTokenCount(longDescriptors);
    expect(shortTokenCount).toBeGreaterThan(0);
    expect(longTokenCount).toBeGreaterThan(shortTokenCount);
  });
});

describe("PolicyWrapper 权限执行", () => {
  it("Assist：只读工具 allow 并执行", async () => {
    const wrapper = buildWrapper({ mode: "assist" });
    const filePath = path.join(workspaceDirectory, "data.txt");
    await fs.writeFile(filePath, "hello", "utf8");
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "data.txt" }),
      "call-1",
      new AbortController().signal,
    );
    const successResult = expectSuccess(result);
    expect(successResult.outputText).toBe("hello");
  });

  it("Assist：受限工具未授权 ask", async () => {
    const wrapper = buildWrapper({ mode: "assist" });
    const result = await wrapper.execute(
      "writeFileTemporary",
      JSON.stringify({ fileName: "out.txt", content: "x" }),
      "call-2",
      new AbortController().signal,
    );
    const errorResult = expectError(result);
    expect(errorResult.errorCode).toBe("permission-ask-pending");
  });

  it("Assist：受限工具会话授权后 allow（参数一致）", async () => {
    const modeMachine = new ModeMachine("assist");
    const sessionManager = new SessionAuthorizationManager();
    const decider = new PermissionDecider(modeMachine, sessionManager);
    const registry = buildRegistry();
    const wrapper = new PolicyWrapper({
      permissionDecider: decider,
      registry,
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => NOW_UNIX_SECONDS,
      getCurrentMode: () => modeMachine.getCurrentMode(),
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: temporaryDirectory,
      }),
    });
    const argumentsJson = JSON.stringify({ fileName: "out.txt", content: "x" });
    sessionManager.grant("writeFileTemporary", hashToolArguments(argumentsJson), NOW_UNIX_SECONDS);
    const result = await wrapper.execute(
      "writeFileTemporary",
      argumentsJson,
      "call-3",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
  });

  it("Ponder：全部工具 deny", async () => {
    const wrapper = buildWrapper({ mode: "ponder" });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "data.txt" }),
      "call-4",
      new AbortController().signal,
    );
    const errorResult = expectError(result);
    expect(errorResult.errorCode).toBe("tool-permission-denied");
  });

  it("Devolve：注册工具 allow（工作区边界仍生效）", async () => {
    const wrapper = buildWrapper({ mode: "devolve" });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "../../etc/passwd" }),
      "call-5",
      new AbortController().signal,
    );
    const errorResult = expectError(result);
    expect(errorResult.errorCode).toBe("path-escape-attempt");
  });

  it("未注册工具 deny 并记录审计事件", async () => {
    const auditEvents: ToolAuditEvent[] = [];
    const wrapper = buildWrapper({ mode: "assist", auditEvents });
    const result = await wrapper.execute(
      "deleteFile",
      JSON.stringify({ filePath: "a.txt" }),
      "call-6",
      new AbortController().signal,
    );
    const errorResult = expectError(result);
    expect(errorResult.errorCode).toBe("tool-not-found");
    expect(auditEvents.at(-1)).toMatchObject({
      toolName: "deleteFile",
      decision: "deny",
    });
  });

  it("Worker 子集外工具 deny（最小权限）", async () => {
    const wrapper = buildWrapper({
      mode: "assist",
      workerAllowedToolNames: new Set(["readFile"]),
    });
    const result = await wrapper.execute(
      "listDirectory",
      JSON.stringify({ directoryPath: "." }),
      "call-7",
      new AbortController().signal,
    );
    const errorResult = expectError(result);
    expect(errorResult.errorCode).toBe("tool-permission-denied");
    expect(errorResult.errorMessage).toContain("子集");
  });

  it("取消信号到达时立即返回 cancelled 错误", async () => {
    const wrapper = buildWrapper({ mode: "assist" });
    const abortController = new AbortController();
    abortController.abort();
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "data.txt" }),
      "call-8",
      abortController.signal,
    );
    const errorResult = expectError(result);
    expect(errorResult.errorCode).toBe("provider-cancelled");
  });

  it("工作区内文件读取成功、逃逸被拒（WorkspaceBoundary）", async () => {
    const boundary = new WorkspaceBoundary(workspaceDirectory);
    const filePath = path.join(workspaceDirectory, "sub", "file.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "内容", "utf8");
    expect(await boundary.resolveWithinWorkspace("sub/file.txt")).toBe(filePath);
    await expect(
      boundary.resolveWithinWorkspace("../../outside.txt"),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
  });

  it("符号链接逃逸被拒（WorkspaceBoundary）", async () => {
    const boundary = new WorkspaceBoundary(workspaceDirectory);
    const outsideDirectory = path.join(temporaryDirectory, "outside");
    await fs.mkdir(outsideDirectory);
    const symlinkPath = path.join(workspaceDirectory, "link");
    await fs.symlink(outsideDirectory, symlinkPath, "junction").catch(() => {
      // 部分环境（权限）无法创建符号链接时跳过
    });
    if (await fs.access(symlinkPath).then(() => true).catch(() => false)) {
      await expect(
        boundary.resolveWithinWorkspace("link/secret.txt"),
      ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
    }
  });
});
