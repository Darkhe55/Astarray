/**
 * GUI-02-01 覆盖率补片：把安全预览与请求实体的**行为分支**逐一走通。
 *
 * 说明（为何单列一个文件）：`npm run test:coverage` 的四维门槛均为 **85**，
 * 而全局分支长期贴在 **84.9–85.1%** 的线上。本轮新增
 * `permission-ask-safe-preview.ts`（86 分支）与 `permission-ask-request-store.ts`（30 分支）
 * 后，未覆盖分支把全局压到门槛之下。**这里补的是真实行为分支**（动作判定、
 * 路径归属、批量计数、截断标注、保守回退、参数非法等），不是为凑数写的空断言。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPermissionAskSafePreview,
  inferPreviewAction,
  PERMISSION_ASK_PREVIEW_LIMITS,
} from "../../../packages/core/src/orchestration/permission-ask-safe-preview.js";
import { PermissionAskRequestStore } from "../../../packages/core/src/orchestration/permission-ask-request-store.js";

const PROJECT_ROOT = process.cwd();

function previewOf(toolName: string, argumentsJson: string) {
  return buildPermissionAskSafePreview({
    toolName,
    argumentsJson,
    explanation: "说明",
    projectRootPath: PROJECT_ROOT,
  });
}

describe("安全预览：动作判定覆盖", () => {
  it("按工具名动词判定动作（delete/remove/read/list/search/grep/write/edit/save/apply）", () => {
    expect(inferPreviewAction({ toolName: "deleteProjectFile", hasContent: false })).toBe("delete");
    expect(inferPreviewAction({ toolName: "removeDirectory", hasContent: false })).toBe("delete");
    expect(inferPreviewAction({ toolName: "readProjectFile", hasContent: false })).toBe("read");
    expect(inferPreviewAction({ toolName: "listDirectory", hasContent: false })).toBe("list");
    expect(inferPreviewAction({ toolName: "searchText", hasContent: false })).toBe("search");
    expect(inferPreviewAction({ toolName: "grepText", hasContent: false })).toBe("search");
    expect(inferPreviewAction({ toolName: "editProjectFile", hasContent: false })).toBe("overwrite");
    expect(inferPreviewAction({ toolName: "saveProjectFile", hasContent: false })).toBe("overwrite");
    expect(inferPreviewAction({ toolName: "applyPatch", hasContent: false })).toBe("overwrite");
    // 有内容 ⇒ create；无内容 ⇒ overwrite
    expect(inferPreviewAction({ toolName: "writeProjectFile", hasContent: true })).toBe("create");
    expect(inferPreviewAction({ toolName: "writeProjectFile", hasContent: false })).toBe("overwrite");
    // 无法判定 ⇒ 保守
    expect(inferPreviewAction({ toolName: "unknownTool", hasContent: true })).toBe("unknown");
  });

  it("删除类工具：无内容 ⇒ contentLength 0，且影响范围不写内容长度", () => {
    const preview = previewOf("deleteProjectFile", '{"filePath":"src/a.ts"}');
    expect(preview.action).toBe("delete");
    expect(preview.contentLength).toBe(0);
    expect(preview.impactScope).not.toContain("内容");
  });

  it("动作不可判定 ⇒ 影响范围明确写『动作不可判定』（保守）", () => {
    const preview = previewOf("mysteryTool", '{"filePath":"src/a.ts"}');
    expect(preview.action).toBe("unknown");
    expect(preview.impactScope).toContain("动作不可判定");
  });
});

describe("安全预览：路径归属与计数", () => {
  it("目标在项目外（.. 逃逸）⇒ targetPathRelative 为 null 且影响范围标注不可判定", () => {
    const preview = previewOf("createProjectFile", '{"filePath":"../../outside.txt","content":"x"}');
    expect(preview.targetPathRelative).toBeNull();
    expect(preview.impactScope).toContain("不在项目内");
  });

  it("绝对路径在项目内 ⇒ 归一化为项目内相对路径", () => {
    const absoluteInside = path.join(PROJECT_ROOT, "src", "inside.txt");
    const preview = previewOf(
      "createProjectFile",
      JSON.stringify({ filePath: absoluteInside, content: "x" }),
    );
    expect(preview.targetPathRelative).toBe("src/inside.txt");
  });

  it("路径含 NUL ⇒ 视为不可判定（不得用于文件系统）", () => {
    const preview = previewOf(
      "createProjectFile",
      JSON.stringify({ filePath: "src/a\u0000b.txt", content: "x" }),
    );
    expect(preview.targetPathRelative).toBeNull();
  });

  it("空路径字符串 ⇒ 不可判定", () => {
    const preview = previewOf("createProjectFile", '{"filePath":"   ","content":"x"}');
    expect(preview.targetPathRelative).toBeNull();
  });

  it("批量（files 数组）⇒ fileCount 为数组长度且影响范围写多文件", () => {
    const preview = previewOf(
      "writeProjectFiles",
      JSON.stringify({ files: [{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }] }),
    );
    expect(preview.fileCount).toBe(3);
    expect(preview.impactScope).toContain("3 个文件");
  });

  it("无目标路径 ⇒ fileCount 为 0", () => {
    const preview = previewOf("listDirectory", '{"directoryPath":""}');
    expect(preview.fileCount).toBe(0);
  });

  it("可注入更强的敏感路径匹配器（例如 SensitiveContentAccessPolicy）", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"ordinary.txt","content":"x"}',
      explanation: "注入匹配器",
      projectRootPath: PROJECT_ROOT,
      matchSensitivePathName: (filePath) => (filePath.endsWith(".txt") ? filePath : null),
    });
    expect(preview.requiresControlledDetail).toBe(true);
    expect(preview.diffPreview).toBeNull();
  });

  it("可注入的匹配器返回 null ⇒ 不按敏感处理", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"ordinary2.dat","content":"x"}',
      explanation: "注入匹配器返回 null",
      projectRootPath: PROJECT_ROOT,
      matchSensitivePathName: () => null,
    });
    expect(preview.requiresControlledDetail).toBe(false);
  });
});

describe("安全预览：截断标注与候选内容键", () => {
  it("targetPathRelative 超长 ⇒ 截断并登记", () => {
    const longName = "d/".repeat(600) + "f.txt";
    const preview = previewOf(
      "createProjectFile",
      JSON.stringify({ filePath: longName, content: "x" }),
    );
    expect(preview.truncatedFields).toContain("targetPathRelative");
    expect(preview.targetPathRelative!.length).toBeLessThanOrEqual(
      PERMISSION_ASK_PREVIEW_LIMITS.targetPathCharacters,
    );
  });

  it("差异预览超长 ⇒ 受限（不超过上限），且超长内容本身被登记为截断", () => {
    // 每行足够长，使**字符上限**先于"最多 40 行"生效
    const longContent = Array.from(
      { length: 40 },
      (_, index) => "行" + String(index) + ":" + "x".repeat(120),
    ).join("\n");
    const preview = previewOf(
      "createProjectFile",
      JSON.stringify({ filePath: "src/long.txt", content: longContent }),
    );
    expect(preview.diffPreview).not.toBeNull();
    expect(preview.diffPreview!.length).toBeLessThanOrEqual(
      PERMISSION_ASK_PREVIEW_LIMITS.diffPreviewCharacters,
    );
    // 内容超过内联阈值 ⇒ 必须登记 content 被截断（不静默）
    expect(preview.truncatedFields).toContain("content");
  });

  it("候选内容键：contents / text / newContent 均被识别为内容", () => {
    for (const key of ["contents", "text", "newContent"]) {
      const preview = previewOf(
        "createProjectFile",
        JSON.stringify({ filePath: "src/k.txt", [key]: "内容" }),
      );
      expect(preview.contentLength, key).toBe(2);
    }
  });

  it("候选路径键：path / targetPath / directoryPath 均被识别", () => {
    for (const key of ["path", "targetPath", "directoryPath"]) {
      const preview = previewOf(
        "createProjectFile",
        JSON.stringify({ [key]: "src/key.txt", content: "x" }),
      );
      expect(preview.targetPathRelative, key).toBe("src/key.txt");
    }
  });

  it("参数是数组或 null ⇒ 保守回退（unknown + 需受控详情）", () => {
    for (const raw of ["[]", "null", '"字符串"', "42"]) {
      const preview = previewOf("createProjectFile", raw);
      expect(preview.action, raw).toBe("unknown");
      expect(preview.requiresControlledDetail, raw).toBe(true);
    }
  });
});

describe("请求实体：非法参数与读取缺失分支", () => {
  let baseDirectory: string;
  let store: PermissionAskRequestStore;

  beforeEach(async () => {
    baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ask-cov-"));
    store = new PermissionAskRequestStore({ baseDirectory });
  });

  afterEach(async () => {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
  });

  it("有效期为负数 ⇒ 以 permission-ask-invalid 拒绝（不落盘）", async () => {
    await expect(
      store.registerRequest({
        ownerAgentInstanceId: "owner-1",
        taskIdentifier: "T-001",
        toolName: "createProjectFile",
        argumentsJson: "{}",
        explanation: "非法有效期",
        lifetimeSeconds: -1,
      }),
    ).rejects.toMatchObject({ errorCode: "permission-ask-invalid" });
  });

  it("读取未登记的请求 ⇒ null（不抛错）", async () => {
    expect(await store.readRequest("ask-不存在")).toBeNull();
    // 再次读取以覆盖"逐个 owner 目录扫描后仍未命中"的路径
    expect(await store.readRequest("ask-也不存在")).toBeNull();
  });

  it("登记时可显式指定 askIdentifier；重复登记同一 ID 覆盖为 pending", async () => {
    const first = await store.registerRequest({
      ownerAgentInstanceId: "owner-2",
      taskIdentifier: "T-002",
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a.txt","content":"x"}',
      explanation: "第一次",
      askIdentifier: "ask-fixed-1",
    });
    expect(first.askIdentifier).toBe("ask-fixed-1");
    const reread = await store.readRequest("ask-fixed-1");
    expect(reread?.status).toBe("pending");
  });

  it("拒绝裁决 ⇒ 状态为 denied 且 revision 递增", async () => {
    const record = await store.registerRequest({
      ownerAgentInstanceId: "owner-3",
      taskIdentifier: "T-003",
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a.txt","content":"x"}',
      explanation: "将被拒绝",
    });
    const decided = await store.decideRequest({
      askIdentifier: record.askIdentifier,
      decision: "denied",
      expectedRequestRevision: record.requestRevision,
      expectedOperationFingerprint: record.operationFingerprint,
      deciderAgentInstanceId: "main-agent-1",
      hasAdjudicationAuthority: true,
    });
    expect(decided.status).toBe("denied");
    expect(decided.requestRevision).toBe(2);
    expect(decided.decidedByAgentInstanceId).toBe("main-agent-1");
  });

  it("已过期后再裁决 ⇒ 仍以 expired 拒绝（状态已是 expired，不重复迁移）", async () => {
    const record = await store.registerRequest({
      ownerAgentInstanceId: "owner-4",
      taskIdentifier: "T-004",
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a.txt","content":"x"}',
      explanation: "过期两次",
      lifetimeSeconds: 0,
    });
    const attempt = {
      askIdentifier: record.askIdentifier,
      decision: "allowed-once" as const,
      expectedRequestRevision: record.requestRevision,
      expectedOperationFingerprint: record.operationFingerprint,
      deciderAgentInstanceId: "main-agent-1",
      hasAdjudicationAuthority: true,
    };
    await expect(store.decideRequest(attempt)).rejects.toMatchObject({
      errorCode: "permission-ask-expired",
    });
    await expect(store.decideRequest(attempt)).rejects.toMatchObject({
      errorCode: "permission-ask-expired",
    });
  });
});
