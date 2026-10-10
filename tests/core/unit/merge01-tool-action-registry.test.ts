/**
 * MERGE-01-01/02 反例（2026-10-10）：**能力族 / action 统一**与只读投影。
 *
 * 卡内 §1.2 明确要求：
 *  - 以**能力族 + action 枚举**复用现有工具（如统一读取工具的 format/view 参数），
 *    不因格式相近就另造一套名称；
 *  - 先适配**两个现有相近入口**作纵向样本，**保留旧名称兼容别名**并路由同一实现；
 *  - 不得为了统一变成"任意 shell / 任意方法调用入口"；
 *  - 工具描述符按 **action 与参数**判定副作用、权限、备份与幂等性；
 *    **含写动作的工具不能整体伪装成 readonly**；
 *  - 不同 action 的必需参数使用**可校验 schema 分支**，**不认识的 action/参数拒绝**；
 *  - Ponder / 主 Agent 只读视图**只暴露允许的读取动作**，
 *    统一工具名**不得**让隐藏的写动作绕过本地执行检查。
 *
 * 现状缺口（本文件在实现前必须失败）：本仓没有"能力族 + action"这一层，
 * `readFile` / `searchProjectText` 仍是两条彼此独立、无兼容别名、无 action 判定的工具名。
 */
import { describe, expect, it } from "vitest";

import {
  PROJECT_FILE_READ_FAMILY,
  projectReadOnlyActionProjection,
  resolveToolAction,
  validateActionArguments,
} from "../../../packages/core/src/tools/tool-action-registry.js";

describe("MERGE-01：能力族 + action 统一（纵向样本）", () => {
  it("① 旧名称（兼容别名）必须解析到同一能力族的对应 action", () => {
    const readAction = resolveToolAction({ toolNameOrAlias: "readFile" });
    const searchAction = resolveToolAction({ toolNameOrAlias: "searchProjectText" });
    expect(readAction?.familyName).toBe(PROJECT_FILE_READ_FAMILY.familyName);
    expect(searchAction?.familyName).toBe(PROJECT_FILE_READ_FAMILY.familyName);
    expect(readAction?.action).toBe("read");
    expect(searchAction?.action).toBe("search");
    // 同一实现：两者指向同一能力族
    expect(readAction?.familyName).toBe(searchAction?.familyName);
  });

  it("② 统一名 + action 也必须解析；不认识的 action 与工具名一律拒绝", () => {
    const unified = resolveToolAction({
      toolNameOrAlias: PROJECT_FILE_READ_FAMILY.familyName,
      action: "read",
    });
    expect(unified?.action).toBe("read");

    expect(
      resolveToolAction({
        toolNameOrAlias: PROJECT_FILE_READ_FAMILY.familyName,
        action: "not-an-action",
      }),
    ).toBeNull();
    expect(resolveToolAction({ toolNameOrAlias: "someOtherTool" })).toBeNull();
    // 不得退化成"任意方法调用入口"：未知名字即便带 action 也拒绝
    expect(
      resolveToolAction({ toolNameOrAlias: "arbitraryShell", action: "read" }),
    ).toBeNull();
  });

  it("③ 每个 action 的副作用/备份/幂等由 action 自身判定（不由族整体决定）", () => {
    const readAction = resolveToolAction({ toolNameOrAlias: "readFile" });
    const searchAction = resolveToolAction({ toolNameOrAlias: "searchProjectText" });
    for (const action of [readAction, searchAction]) {
      expect(action?.isReadOnly).toBe(true);
      expect(action?.requiresPreMutationBackup).toBe(false);
      expect(action?.isIdempotent).toBe(true);
    }
  });

  it("④ 含写动作的能力族**不得**整体伪装 readonly（逐 action 判定）", () => {
    // 本族只有读动作 ⇒ 只读投影包含全部动作
    const readOnlyProjection = projectReadOnlyActionProjection(PROJECT_FILE_READ_FAMILY);
    expect(readOnlyProjection.map((action) => action.action).sort()).toEqual([
      "read",
      "search",
    ]);
    // 显式断言：投影中不允许出现任何非只读动作
    for (const action of readOnlyProjection) {
      expect(action.isReadOnly).toBe(true);
    }
  });

  it("⑤ 只读投影必须**过滤掉写动作**（构造含写动作的族验证过滤生效）", () => {
    const mixedFamily = {
      familyName: "projectFileMixed",
      actions: [
        {
          action: "read",
          aliases: ["readFile"],
          isReadOnly: true,
          mutationKind: "none" as const,
          requiresPreMutationBackup: false,
          isIdempotent: true,
          requiredParameters: ["filePath"],
        },
        {
          action: "write",
          aliases: ["replaceFileContent"],
          isReadOnly: false,
          mutationKind: "overwrite" as const,
          requiresPreMutationBackup: true,
          isIdempotent: false,
          requiredParameters: ["filePath", "content"],
        },
      ],
    };
    const projection = projectReadOnlyActionProjection(mixedFamily);
    expect(projection.map((action) => action.action)).toEqual(["read"]);
    expect(projection.some((action) => action.action === "write")).toBe(false);
  });

  it("⑥ 每个 action 声明必需参数（供可校验 schema 分支使用）", () => {
    const readAction = resolveToolAction({ toolNameOrAlias: "readFile" });
    const searchAction = resolveToolAction({ toolNameOrAlias: "searchProjectText" });
    expect(readAction?.requiredParameters).toEqual(["filePath"]);
    expect(searchAction?.requiredParameters).toEqual(["pattern"]);
  });
});

describe("MERGE-01：action 参数校验（动作切换不得被静默接受）", () => {
  it("⑦ 缺少必需参数 / 参数不可解析 ⇒ 拒绝（fail-closed）", () => {
    const readDescriptor = PROJECT_FILE_READ_FAMILY.actions.find(
      (action) => action.action === "read",
    );
    if (readDescriptor === undefined) {
      throw new Error("测试前提失败：read action 不存在");
    }
    expect(
      validateActionArguments({
        descriptor: readDescriptor,
        argumentsJson: JSON.stringify({ pattern: "x" }),
      }).isValid,
    ).toBe(false);
    expect(
      validateActionArguments({ descriptor: readDescriptor, argumentsJson: "{ 坏" }).isValid,
    ).toBe(false);
    expect(
      validateActionArguments({
        descriptor: readDescriptor,
        argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      }).isValid,
    ).toBe(true);
  });

  it("⑧ 动作切换（read→search）沿用旧参数时，必须因缺失必需参数被拒", () => {
    const searchDescriptor = PROJECT_FILE_READ_FAMILY.actions.find(
      (action) => action.action === "search",
    );
    if (searchDescriptor === undefined) {
      throw new Error("测试前提失败：search action 不存在");
    }
    // 调用方把 read 的参数（filePath）直接用于 search：search 需要 pattern ⇒ 拒绝
    const outcome = validateActionArguments({
      descriptor: searchDescriptor,
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
    });
    expect(outcome.isValid).toBe(false);
    expect(String(outcome.reason)).toContain("pattern");
  });
});
