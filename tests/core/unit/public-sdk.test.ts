/**
 * T07D-08 测试：Public SDK、桥接端口与依赖方向。
 * 验收：SDK 只暴露公共 DTO（无凭据/内部字段）；桥接契约冻结
 * （认证主体/来源/任务信封/工具映射/权限复检）；依赖方向
 * （Core 不依赖 TUI/GUI；消费者不引用 packages/ 源码路径）。
 */
import { describe, expect, it } from "vitest";

import {
  ASTARRAY_SDK_VERSION,
  AstarrayApplicationFacade,
} from "../../../packages/core/src/public-sdk.js";
import {
  assertBridgeRequestValid,
  externalHarnessBridgeRequestSchema,
} from "../../../packages/core/src/orchestration/external-harness-bridge-port.js";

describe("AstarrayApplicationFacade（Public SDK）", () => {
  it("创建会话/订阅/提交任务/读取结果/关闭（公共 DTO 无内部字段）", async () => {
    const facade = new AstarrayApplicationFacade({});
    const receivedEvents: Array<{ eventType: string }> = [];
    const subscription = facade.subscribe((event) => {
      receivedEvents.push(event);
    });
    const session = facade.createSession({
      sessionId: "session-1",
      mode: "assist",
    });
    expect(session).toEqual({ sessionId: "session-1", mode: "assist", status: "idle" });
    const result = await facade.submitTask({
      taskIdentifier: "task-1",
      prompt: "分析项目",
      mode: "assist",
    });
    expect(result.status).toBe("accepted");
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    subscription.unsubscribe();
    facade.shutdown();
    expect(() => facade.createSession({ sessionId: "x", mode: "ponder" })).toThrow(
      /SDK 已关闭/,
    );
  });

  it("SDK 版本与公共 DTO 不携带凭据/内部字段", async () => {
    expect(ASTARRAY_SDK_VERSION).toBe("0.1.0");
    const facade = new AstarrayApplicationFacade({});
    const session = facade.createSession({ sessionId: "s", mode: "devolve" });
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("credential");
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
    const { promises: fs } = await import("node:fs");
    const pathModule = await import("node:path");
    const walk = async (directoryPath: string): Promise<string[]> => {
      const files: string[] = [];
      for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
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
      const content = await fs.readFile(filePath, "utf8");
      expect(content, `${filePath} 不得引用 TUI/GUI`).not.toMatch(
        /packages\/tui|packages\/gui|\.\.\/\.\.\/tui|\.\.\/\.\.\/gui/,
      );
    }
  });
});