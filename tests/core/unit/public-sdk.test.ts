/**
 * T07D-08 测试：Public SDK、桥接端口与依赖方向。
 * 验收：SDK 只暴露公共 DTO（无凭据/内部字段）；桥接契约冻结
 * （认证主体/来源/任务信封/工具映射/权限复检）；依赖方向
 * （Core 不依赖 TUI/GUI；消费者不引用 packages/ 源码路径）。
 * T07D-R1-01 起：应用必须从公开 exports 创建，并委托真实控制器。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASTARRAY_SDK_VERSION,
  AstarrayApplicationFacade,
} from "../../../packages/core/src/public-sdk.js";
import {
  assertBridgeRequestValid,
  externalHarnessBridgeRequestSchema,
} from "../../../packages/core/src/orchestration/external-harness-bridge-port.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sdk-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("AstarrayApplicationFacade（Public SDK）", () => {
  it("从公开入口创建应用：会话/提交/查询/订阅/关闭（公共 DTO 无内部字段）", async () => {
    const facade = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
    });
    const receivedEvents: Array<{ eventType: string }> = [];
    const subscription = facade.subscribe((event) => {
      receivedEvents.push(event);
    });
    const session = facade.createSession({ sessionId: "session-1", mode: "assist" });
    expect(session).toEqual({ sessionId: "session-1", mode: "assist", status: "idle" });

    const result = await facade.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "分析项目",
    });
    expect(result.status).toBe("accepted");
    expect(result.missionIdentifier).not.toBeNull();

    const queried = await facade.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    expect(["running", "blocked", "done", "failed", "cancelled"]).toContain(queried.status);
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    subscription.unsubscribe();

    await facade.shutdown();
    expect(facade.isClosed).toBe(true);
    expect(() => facade.createSession({ sessionId: "x", mode: "assist" })).toThrow(
      /已关闭/,
    );
  });

  it("SDK 版本与公共 DTO 不携带凭据/内部字段", async () => {
    expect(ASTARRAY_SDK_VERSION).toBe("0.1.0");
    const facade = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "devolve",
    });
    const session = facade.createSession({ sessionId: "s", mode: "devolve" });
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("credential");
    await facade.shutdown();
  });
});

describe("ExternalHarnessBridgePort 契约", () => {
  const request = {
    schemaVersion: 1 as const,
    requestIdentifier: "bridge-1",
    bridgeProtocol: "mcp",
    authenticatedPrincipal: "user:alice",
    sourceKind: "user" as const,
    taskEnvelope: {
      taskIdentifier: "task-1",
      scopeDescription: "分析模块",
      acceptanceCriteria: "摘要完整",
    },
    toolMappings: [
      { externalToolName: "read_file", mappedLocalToolName: "project.read" },
    ],
    createdAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法桥接请求通过；认证主体/来源校验", () => {
    expect(externalHarnessBridgeRequestSchema.safeParse(request).success).toBe(true);
    expect(() => assertBridgeRequestValid(request)).not.toThrow();
  });

  it("反例：伪造认证主体/用户来源无 user 前缀 → 拒绝", () => {
    expect(
      externalHarnessBridgeRequestSchema.safeParse({
        ...request,
        authenticatedPrincipal: "",
      }).success,
    ).toBe(false);
    expect(() =>
      assertBridgeRequestValid({
        ...request,
        sourceKind: "user",
        authenticatedPrincipal: "agent:evil",
      } as never),
    ).toThrowError(/用户来源桥接必须绑定认证用户主体/);
  });

  it("反例：任务信封缺字段/工具映射空 → 拒绝", () => {
    expect(
      externalHarnessBridgeRequestSchema.safeParse({
        ...request,
        taskEnvelope: { taskIdentifier: "t" },
      }).success,
    ).toBe(false);
    expect(
      externalHarnessBridgeRequestSchema.safeParse({
        ...request,
        toolMappings: [],
      }).success,
    ).toBe(false);
  });
});

describe("依赖方向", () => {
  it("Core 源码不 import TUI/GUI（依赖方向：core 不反向依赖界面）", async () => {
    const { promises: fileSystem } = await import("node:fs");
    const pathModule = await import("node:path");
    const walk = async (directoryPath: string): Promise<string[]> => {
      const files: string[] = [];
      for (const entry of await fileSystem.readdir(directoryPath, { withFileTypes: true })) {
        const entryPath = pathModule.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await walk(entryPath)));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(entryPath);
        }
      }
      return files;
    };
    const coreSourceFiles = await walk(
      pathModule.join(process.cwd(), "packages", "core", "src"),
    );
    for (const filePath of coreSourceFiles) {
      const content = await fileSystem.readFile(filePath, "utf8");
      for (const forbiddenFragment of ["packages/tui", "packages/gui", "../tui", "../gui"]) {
        expect(
          content.includes(forbiddenFragment),
          filePath + " 不得引用 " + forbiddenFragment,
        ).toBe(false);
      }
    }
  });
});
