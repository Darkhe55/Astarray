/**
 * 反例（裁决授权必须真正命中"判定侧"引擎）：
 * 生产次级 Agent 的 `ask/allow` 由 `ConfigurablePermissionPolicyEngine` 判定
 * （`application-runtime` 的 `useConfigurablePermissionProfileEngine: true`），
 * 而用户裁决此前只写进旧 `SessionAuthorizationManager`，且引擎按**字节级** sha256
 * 绑定参数。结果：用户 allow-once 之后，同一工具重跑仍被判 `ask`
 * （2026-10-01 真实写任务实测；且模型两次生成的等价参数键序不同）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { canonicalizeToolArguments, hashToolArguments } from "../../../packages/core/src/core/permission-policy.js";

const CREATE_FILE_ARGUMENTS = JSON.stringify({
  filePath: "tasks/PROBE-001.md",
  content: "# 授权命中探针\n",
});
/** 语义等价、键序不同（模型第二次调用常见形态）。 */
const REORDERED_ARGUMENTS = JSON.stringify({
  content: "# 授权命中探针\n",
  filePath: "tasks/PROBE-001.md",
});

interface PermissionDecidingEngine {
  decide(input: {
    toolName: string;
    profileReference: unknown;
    argumentsJson: string;
  }): Promise<{ decision: string }>;
}

let workspaceDirectory: string;

beforeEach(async () => {
  workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-auth-hit-"));
});

afterEach(async () => {
  await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("参数规范化（授权绑定口径）", () => {
  it("语义等价、键序不同 → 规范化与哈希一致；值/数组顺序变化仍敏感", () => {
    expect(canonicalizeToolArguments(CREATE_FILE_ARGUMENTS)).toBe(
      canonicalizeToolArguments(REORDERED_ARGUMENTS),
    );
    expect(hashToolArguments(CREATE_FILE_ARGUMENTS)).toBe(
      hashToolArguments(REORDERED_ARGUMENTS),
    );
    // 值变化必须失效
    expect(hashToolArguments(CREATE_FILE_ARGUMENTS)).not.toBe(
      hashToolArguments(
        JSON.stringify({ filePath: "tasks/PROBE-001.md", content: "# 改过了\n" }),
      ),
    );
    // 数组顺序敏感
    expect(hashToolArguments('{"items":["a","b"]}')).not.toBe(
      hashToolArguments('{"items":["b","a"]}'),
    );
    // 非 JSON 输入退回原文（不当作等价）
    expect(canonicalizeToolArguments("不是 JSON")).toBe("不是 JSON");
  });
});

describe("真实运行时装配下的裁决授权命中", () => {
  it("用户 allow-once（键序不同）→ 引擎裁决由 ask 变 allow", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory: path.join(workspaceDirectory, ".astarray"),
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      const profileReference = await application.getCurrentPermissionProfileReference();
      expect(profileReference).not.toBeNull();

      // 只读探针：真实运行时装配下的判定侧引擎。
      const engine = (
        application as unknown as {
          runtime: {
            controller: {
              options: { configurablePermissionPolicyEngine?: PermissionDecidingEngine };
            };
          };
        }
      ).runtime.controller.options.configurablePermissionPolicyEngine;
      expect(engine).toBeDefined();

      const beforeDecision = await engine?.decide({
        toolName: "createProjectFile",
        profileReference,
        argumentsJson: CREATE_FILE_ARGUMENTS,
      });
      expect(beforeDecision?.decision).toBe("ask");

      // 用户裁决（按提示里看到的等价参数文本）。
      await application.grantSessionAuthorization(
        "createProjectFile",
        REORDERED_ARGUMENTS,
        Math.floor(Date.now() / 1000),
      );

      const afterDecision = await engine?.decide({
        toolName: "createProjectFile",
        profileReference,
        argumentsJson: CREATE_FILE_ARGUMENTS,
      });
      expect(afterDecision?.decision).toBe("allow");
    } finally {
      await application.shutdown();
    }
  });
});
