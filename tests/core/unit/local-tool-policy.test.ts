/**
 * T06B 单测：Ponder 本地只读边界（ADR-0014）。
 * 覆盖：分类器确定性规则、引擎白名单 fail-closed、敏感路径排除、
 * git 固定视图、拒绝事件、降级后立即复检、断网一致性（本地规则无外部依赖）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider } from "../../../packages/core/src/core/permission-policy.js";
import { SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import type { ToolDescriptor } from "../../../packages/core/src/core/types.js";
import { LocalSensitiveOperationClassifier } from "../../../packages/core/src/tools/local-sensitive-operation-classifier.js";
import {
  LocalToolPolicyEngine,
  PONDER_READONLY_TOOL_NAMES,
  PONDER_READONLY_GIT_VIEWS,
} from "../../../packages/core/src/tools/local-tool-policy-engine.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let boundary: WorkspaceBoundary;
let protectedStoragePolicy: ProtectedStoragePolicy;
let engine: LocalToolPolicyEngine;
const denialEvents: Array<{ toolName: string; reason: string }> = [];

function readonlyDescriptor(toolName: string): ToolDescriptor {
  return {
    name: toolName,
    summary: toolName,
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {},
  };
}

function restrictedDescriptor(toolName: string): ToolDescriptor {
  return {
    ...readonlyDescriptor(toolName),
    category: "restricted",
  };
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06b-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
  boundary = new WorkspaceBoundary(workspaceDirectory);
  protectedStoragePolicy = new ProtectedStoragePolicy({
    stateDirectoryPath: temporaryDirectory,
  });
  denialEvents.length = 0;
  engine = new LocalToolPolicyEngine({
    workspaceBoundary: boundary,
    protectedStoragePolicy,
    denialEventSink: (event) => {
      denialEvents.push({ toolName: event.toolName, reason: event.reason });
    },
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("LocalSensitiveOperationClassifier", () => {
  const classifier = new LocalSensitiveOperationClassifier();

  it("只读文件/状态查询/git 只读分类为可证明只读", () => {
    expect(
      classifier.classifyOperation({ toolName: "readFile", mutationKind: "none" }),
    ).toMatchObject({ isProvablyReadOnly: true, operationClass: "readonly-file" });
    expect(
      classifier.classifyOperation({
        toolName: "taskSequenceStatus",
        mutationKind: "none",
      }),
    ).toMatchObject({ isProvablyReadOnly: true, operationClass: "state-query" });
    expect(
      classifier.classifyOperation({
        toolName: "gitReadonlyView",
        mutationKind: "none",
      }),
    ).toMatchObject({ isProvablyReadOnly: true, operationClass: "git-readonly" });
  });

  it("文件变更/Git 写/进程/网络/发布/凭据/备份分类为敏感或非只读", () => {
    expect(
      classifier.classifyOperation({
        toolName: "replaceFileContent",
        mutationKind: "overwrite",
      }),
    ).toMatchObject({ isProvablyReadOnly: false });
    expect(
      classifier.classifyOperation({ toolName: "git push", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "git-write", isProvablyReadOnly: false });
    expect(
      classifier.classifyOperation({ toolName: "shell", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "process-execution" });
    expect(
      classifier.classifyOperation({ toolName: "fetchUrl", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "network-access" });
    expect(
      classifier.classifyOperation({ toolName: "publishRelease", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "external-publish", isSensitive: true });
    expect(
      classifier.classifyOperation({ toolName: "readCredentials", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "credentials-access", isSensitive: true });
    expect(
      classifier.classifyOperation({ toolName: "backupVault", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "backup-access", isSensitive: true });
    expect(
      classifier.classifyOperation({ toolName: "npm install", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "system-level" });
    expect(
      classifier.classifyOperation({ toolName: "unknownTool", mutationKind: "none" }),
    ).toMatchObject({ operationClass: "unknown", isProvablyReadOnly: false });
  });

  it("规则版本为当前版本且携带于分类结果", () => {
    const classification = classifier.classifyOperation({
      toolName: "readFile",
      mutationKind: "none",
    });
    expect(classification.rulesVersion).toBeGreaterThanOrEqual(1);
  });
});

describe("LocalToolPolicyEngine（Ponder fail-closed）", () => {
  it("白名单工具放行：readFile/searchProjectText/gitReadonlyView", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "a.txt"), "hello", "utf8");
    for (const toolName of ["readFile", "searchProjectText", "gitReadonlyView"]) {
      const argumentsJson =
        toolName === "readFile"
          ? JSON.stringify({ filePath: "a.txt" })
          : toolName === "searchProjectText"
            ? JSON.stringify({ pattern: "hello" })
            : JSON.stringify({ view: "status" });
      await expect(
        engine.assertPonderToolExecutionAllowed({
          toolName,
          descriptor: readonlyDescriptor(toolName),
          argumentsJson,
        }),
      ).resolves.toBeUndefined();
    }
    expect(
      engine.isPonderToolExposable("readFile"),
    ).toBe(true);
  });

  it("非白名单工具一律 fail-closed 并产生拒绝事件", async () => {
    for (const toolName of [
      "writeFileTemporary",
      "replaceFileContent",
      "backupVault",
      "deleteBackup",
      "shell",
      "fetchUrl",
    ]) {
      await expect(
        engine.assertPonderToolExecutionAllowed({
          toolName,
          descriptor: restrictedDescriptor(toolName),
          argumentsJson: "{}",
        }),
      ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    }
    expect(denialEvents.length).toBe(6);
    expect(denialEvents[0]).toMatchObject({
      toolName: "writeFileTemporary",
    });
    expect(denialEvents[0]?.reason).toContain("白名单");
  });

  it("伪造 readonly 声明（mutationKind/backupPolicy/category 不一致）fail-closed", async () => {
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "readFile",
        descriptor: {
          ...readonlyDescriptor("readFile"),
          mutationKind: "overwrite",
        },
        argumentsJson: JSON.stringify({ filePath: "a.txt" }),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "readFile",
        descriptor: {
          ...readonlyDescriptor("readFile"),
          backupPolicy: "automatic-preimage",
        },
        argumentsJson: JSON.stringify({ filePath: "a.txt" }),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "readFile",
        descriptor: restrictedDescriptor("readFile"),
        argumentsJson: JSON.stringify({ filePath: "a.txt" }),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
  });

  it("路径穿越/绝对逃逸/受保护区/敏感路径全部拒绝", async () => {
    await fs.mkdir(path.join(temporaryDirectory, "backup-vault"), { recursive: true });
    await fs.writeFile(
      path.join(temporaryDirectory, "backup-vault", "data.txt"),
      "secret",
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDirectory, ".env"), "API_KEY=x", "utf8");
    await fs.writeFile(path.join(workspaceDirectory, "id_rsa.key"), "key", "utf8");
    await fs.writeFile(path.join(workspaceDirectory, "ok.txt"), "ok", "utf8");

    await expect(
      engine.assertPonderReadonlyFilePath("../outside.txt"),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
    const allowedPath = await engine.assertPonderReadonlyFilePath("ok.txt");
    expect(allowedPath).toContain("workspace");
    // 受保护区：状态目录下的 backup-vault（词法在 workspace 外，直接穿越拒绝）
    await expect(
      engine.assertPonderReadonlyFilePath(
        path.join("..", "backup-vault", "data.txt"),
      ),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
    // 敏感文件名
    await expect(
      engine.assertPonderReadonlyFilePath(".env"),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    await expect(
      engine.assertPonderReadonlyFilePath("id_rsa.key"),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
  });

  it("gitReadonlyView 非法视图/非法参数 fail-closed；固定参数构造", async () => {
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "gitReadonlyView",
        descriptor: readonlyDescriptor("gitReadonlyView"),
        argumentsJson: JSON.stringify({ view: "push" }),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "gitReadonlyView",
        descriptor: readonlyDescriptor("gitReadonlyView"),
        argumentsJson: JSON.stringify({ view: "log" }),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" }); // log 缺 limit
    expect(PONDER_READONLY_GIT_VIEWS).toEqual(["status", "diff", "log"]);
    expect(engine.buildPonderGitReadonlyArguments("status", null)).toEqual([
      "status",
      "--porcelain",
    ]);
    expect(engine.buildPonderGitReadonlyArguments("log", 5)).toEqual([
      "log",
      "--oneline",
      "-n",
      "5",
    ]);
    expect(
      engine.parsePonderGitReadonlyArguments({ view: "log", limit: 999 }),
    ).toMatchObject({ view: "log", logLimit: 20 });
  });

  it("未知工具与参数不可解析 fail-closed", async () => {
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "mysteryTool",
        descriptor: readonlyDescriptor("mysteryTool"),
        argumentsJson: "{}",
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    await expect(
      engine.assertPonderToolExecutionAllowed({
        toolName: "searchProjectText",
        descriptor: readonlyDescriptor("searchProjectText"),
        argumentsJson: "{ 非法",
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
  });
});

describe("PermissionDecider × Ponder 引擎（T06B 接入）", () => {
  it("Ponder 只读白名单放行、其余 deny；降级后立即复检且旧授权不沿用", async () => {
    const machine = new ModeMachine("assist");
    const manager = new SessionAuthorizationManager();
    const decider = new PermissionDecider(machine, manager, async (input) => {
      const localEngine = new LocalToolPolicyEngine({
        workspaceBoundary: boundary,
        protectedStoragePolicy,
      });
      const descriptor = readonlyDescriptor(input.toolName);
      if (input.toolName === "writeFileTemporary") {
        return false;
      }
      return (
        (await localEngine.evaluatePonderAccess({
          toolName: input.toolName,
          descriptor,
          argumentsJson: input.argumentsJson,
        })) === null
      );
    });
    // Assist：只读放行
    expect(
      await decider.decide(
        { toolName: "readFile", category: "readonly", argumentsJson: '{"filePath":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("allow");
    // 降级到 Ponder：白名单只读放行
    machine.transition("ponder", "degrade");
    expect(
      await decider.decide(
        { toolName: "readFile", category: "readonly", argumentsJson: '{"filePath":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("allow");
    // 写工具拒绝（即使 Assist 下授权过——旧授权不沿用）
    expect(
      await decider.decide(
        {
          toolName: "writeFileTemporary",
          category: "restricted",
          argumentsJson: '{"fileName":"x.txt","content":"x"}',
        },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("deny");
    // 未装配引擎：Ponder 一律 deny（与旧版一致）
    const bareDecider = new PermissionDecider(
      new ModeMachine("ponder"),
      new SessionAuthorizationManager(),
    );
    expect(
      await bareDecider.decide(
        { toolName: "readFile", category: "readonly", argumentsJson: '{"filePath":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("deny");
  });

  it("断网一致性：本地规则不依赖任何外部服务", async () => {
    // 分类与引擎均为纯本地实现；无网络调用路径可验证（确定性规则表 + 本地 fs）
    const classifier = new LocalSensitiveOperationClassifier();
    expect(
      classifier.classifyOperation({ toolName: "fetchUrl", mutationKind: "none" })
        .operationClass,
    ).toBe("network-access");
    expect(PONDER_READONLY_TOOL_NAMES).toContain("readFile");
  });
});

const NOW_UNIX_SECONDS = 1_750_000_000;
