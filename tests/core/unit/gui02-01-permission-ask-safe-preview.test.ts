/**
 * GUI-02-01 行为反例：权限询问事件的**安全预览**（先红后绿）。
 *
 * 用户 2026-10-11 的原文要求（逐条落为断言）：
 * > 事件只传必要且**脱敏**的信息，**不包含秘密或可复用执行令牌**。
 * > **禁止原始 argumentsJson 进入公共事件**。
 * > `explanation` 和参数摘要也必须经过**本地脱敏与长度限制**，
 * > **不能因为叫"摘要"就直接信任模型文本**。
 * > 关键参数采用**本地生成的结构化安全预览**，而非模糊的一句话。
 * > 例如展示**项目内相对路径、创建／覆盖动作、内容长度、变更摘要及影响范围**；
 * > 文件写入可提供按权限过滤的差异预览；**敏感值遮蔽，不进入事件**。
 * > **若脱敏后不足以让用户准确判断，不能要求用户盲批**：
 * > 改走**独立受控详情**或**专用授权流程**。
 *
 * 本文件钉住的安全语义（实现前必须红）：
 *  ① 预览**只含白名单字段**（不得把 `argumentsJson` 原样带出，不得带任何未列字段）；
 *  ② **秘密/令牌被遮蔽**（api key / Bearer / `sk-…` / 长随机串）；
 *  ③ **长度受限**（超长内容被截断且**明确标注**已截断，不得静默丢弃）；
 *  ④ 结构化预览含**项目内相对路径、动作、内容长度、影响范围**，
 *     且**不是**模糊的一句话（不得回退为"该操作需要授权"式描述）；
 *  ⑤ **敏感路径**（.env / 私钥等）⇒ 预览**仍不含内容**，且标记为**需受控详情**；
 *  ⑥ `explanation` 走同一套脱敏与限长（**不信任模型文本**）；
 *  ⑦ 深度/规模受限：超大参数不得被完整展开（只给长度与结构摘要）。
 */
import { describe, expect, it } from "vitest";

import { buildPermissionAskSafePreview } from "../../../packages/core/src/orchestration/permission-ask-safe-preview.js";

const ALLOWED_PREVIEW_KEYS = [
  "action",
  "contentLength",
  "diffPreview",
  "explanation",
  "fileCount",
  "impactScope",
  "requiresControlledDetail",
  "targetPathRelative",
  "truncatedFields",
].sort();

describe("GUI-02-01 安全预览：白名单与脱敏", () => {
  it("① 预览只含白名单字段，**绝不含原始 argumentsJson**", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({
        filePath: "src/a.ts",
        content: "const a = 1;\n",
      }),
      explanation: "需要写入项目文件",
      projectRootPath: process.cwd(),
    });
    expect(Object.keys(preview).sort()).toEqual(ALLOWED_PREVIEW_KEYS);
    const serialized = JSON.stringify(preview);
    expect(
      serialized.includes("argumentsJson"),
      "预览不得携带 argumentsJson 字段（用户明确禁止原始参数进公共事件）",
    ).toBe(false);
  });

  it("② 参数中的秘密**绝不出现**在预览里（非敏感路径也不内联内容）", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({
        filePath: ".tmp/secret.txt",
        content: [
          "apiKey = sk-abcdefghijklmnopqrstuvwxyz012345",
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          "token=AKIAIOSFODNN7EXAMPLE0123456789ABCDEF",
        ].join("\n"),
      }),
      explanation: "写入含凭据的示例",
      projectRootPath: process.cwd(),
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE0123456789ABCDEF");
    expect(serialized, "Bearer 后的令牌必须不出现").not.toMatch(/Bearer\s+abcdefghij/);
    expect(serialized).not.toContain("apiKey");
    // 只报告长度，不内联正文
    expect(preview.contentLength).toBeGreaterThan(0);
    expect(serialized).not.toContain("Authorization:");
  });

  it("②b 确实被渲染的文本走脱敏：差异预览中的秘密必须变 [REDACTED]", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({
        filePath: "src/config.sample",
        content: "apiKey = sk-abcdefghijklmnopqrstuvwxyz012345",
      }),
      explanation: "使用 Bearer abcdefghijklmnopqrstuvwxyz 调用",
      projectRootPath: process.cwd(),
    });
    // 非敏感路径 ⇒ 提供差异预览；其中必须已脱敏
    expect(preview.diffPreview).not.toBeNull();
    expect(preview.diffPreview).toContain("[REDACTED]");
    expect(preview.diffPreview).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    // explanation 同样脱敏
    expect(preview.explanation).toContain("[REDACTED]");
    expect(preview.explanation).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("③ 超长内容被截断且**明确标注**（不得静默丢弃信息）", () => {
    const longContent = "x".repeat(50_000);
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: "big.txt", content: longContent }),
      explanation: "写入大文件",
      projectRootPath: process.cwd(),
    });
    expect(preview.contentLength).toBe(50_000);
    expect(preview.truncatedFields).toContain("content");
    expect(
      JSON.stringify(preview).length,
      "超长内容不得被完整展开进事件",
    ).toBeLessThan(4_000);
  });

  it("④ 结构化预览：含**项目内相对路径**、动作、内容长度、影响范围；不是模糊一句话", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: "src/新文件.ts", content: "一" }),
      explanation: "需要写入项目文件",
      projectRootPath: process.cwd(),
    });
    expect(preview.action).toBe("create");
    expect(preview.targetPathRelative).toBe("src/新文件.ts");
    expect(preview.contentLength).toBeGreaterThan(0);
    expect(preview.impactScope.length).toBeGreaterThan(0);
    // 不是"模糊的一句话"：动作与路径必须**结构化可分**
    expect(typeof preview.action).toBe("string");
    expect(preview.action).not.toContain("需要");
  });

  it("⑤ 敏感路径（.env / 私钥）⇒ 标记需受控详情，且预览不含内容", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({
        filePath: ".env",
        content: "SECRET_VALUE_SHOULD_NOT_APPEAR=1",
      }),
      explanation: "写入环境文件",
      projectRootPath: process.cwd(),
    });
    expect(preview.requiresControlledDetail).toBe(true);
    expect(
      JSON.stringify(preview).includes("SECRET_VALUE_SHOULD_NOT_APPEAR"),
      "敏感路径的文件内容不得进入事件（改走受控详情）",
    ).toBe(false);
    expect(preview.diffPreview).toBeNull();
  });

  it("⑥ explanation 走同一套脱敏与限长（不信任模型文本）", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: "a.txt", content: "x" }),
      explanation:
        "理由：使用 apiKey = sk-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz 访问 " + "很长的说明".repeat(400),
      projectRootPath: process.cwd(),
    });
    expect(preview.explanation.length).toBeLessThanOrEqual(512);
    expect(preview.explanation).not.toContain("sk-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
  });

  it("⑦ 文件写入提供**按权限过滤的差异预览**（非敏感路径时）", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({
        filePath: "src/preview.txt",
        content: "第一行\n第二行\n",
      }),
      explanation: "写入预览文件",
      projectRootPath: process.cwd(),
    });
    expect(preview.requiresControlledDetail).toBe(false);
    expect(
      typeof preview.diffPreview === "string" || preview.diffPreview === null,
    ).toBe(true);
  });

  it("⑧ 参数不可解析 ⇒ 保守：标记需受控详情，不猜动作与路径", () => {
    const preview = buildPermissionAskSafePreview({
      toolName: "createProjectFile",
      argumentsJson: "{ 这不是 JSON",
      explanation: "参数不可解析",
      projectRootPath: process.cwd(),
    });
    expect(preview.action).toBe("unknown");
    expect(preview.targetPathRelative).toBeNull();
    expect(preview.requiresControlledDetail).toBe(true);
  });
});
