/**
 * MERGE-01-02 反例（2026-10-10）：统一读取工具的 **format / view 参数化**。
 *
 * 卡内 §1.2 原文："以能力族和 action 枚举复用现有工具，**例如统一读取工具的 format/view 参数**，
 * 复用 READ-FORMAT/SUM"。以及"不同 action 的必需参数使用可校验 schema 分支，
 * **不认识的 action/参数拒绝**"。
 *
 * 现状缺口：`readFile` 已有 `shouldIncludeComments` / `shouldIncludeImports` 两个布尔视图参数，
 * 但没有统一到能力族的 **format / view 参数层**；`searchProjectText` 也没有可共用的规范化入口。
 * 因此"同一族内 action 的参数语义"没有单一判定点，容易被各调用点各写一套。
 *
 * 本轮钉住的语义：
 *  - 统一入口按 **action** 规范化视图参数（同一族、同一实现）；
 *  - **别名与统一名必须得到完全相同的规范化结果**（不得两套行为）；
 *  - 缺省填为**与既有读取行为一致**的默认值（不因引入 format/view 改变默认读取）；
 *  - `view` 只接受枚举值；**不认识的 view / format 拒绝**（不猜测、不透传）；
 *  - 不适用于该 action 的视图参数 **拒绝**（例如检索 action 不接受 format）；
 *  - 规范化结果必须**确定性**（键序不敏感，但取值必须一致）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  READ_VIEW_FORMATS,
  normalizeReadViewParameters,
} from "../../../packages/core/src/tools/tool-action-registry.js";

describe("MERGE-01：统一读取工具的 format / view 参数化", () => {
  it("① 别名与统一名必须得到**完全相同**的规范化结果（不得两套行为）", () => {
    const byAlias = normalizeReadViewParameters({
      toolNameOrAlias: "readFile",
      argumentsJson: JSON.stringify({
        filePath: "docs/a.md",
        shouldIncludeComments: true,
        shouldIncludeImports: false,
      }),
    });
    const byUnifiedName = normalizeReadViewParameters({
      toolNameOrAlias: "projectFileRead",
      action: "read",
      argumentsJson: JSON.stringify({
        filePath: "docs/a.md",
        shouldIncludeComments: true,
        shouldIncludeImports: false,
      }),
    });
    expect(byAlias.outcome).toBe("normalized");
    expect(byUnifiedName.outcome).toBe("normalized");
    expect(byUnifiedName.format).toBe(byAlias.format);
    expect(byUnifiedName.view).toBe(byAlias.view);
    expect(byUnifiedName.shouldIncludeComments).toBe(byAlias.shouldIncludeComments);
    expect(byUnifiedName.shouldIncludeImports).toBe(byAlias.shouldIncludeImports);
  });

  it("② 缺省必须与既有读取行为一致（不因引入 format/view 改变默认读取）", () => {
    const outcome = normalizeReadViewParameters({
      toolNameOrAlias: "readFile",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
    });
    expect(outcome.outcome).toBe("normalized");
    // 既有实现：两个可选布尔视图参数缺省为 true（默认读取含注释与导入的视图）
    expect(outcome.shouldIncludeComments).toBe(true);
    expect(outcome.shouldIncludeImports).toBe(true);
    // format 缺省为自动识别（按扩展名解析策略）
    expect(outcome.format).toBe("auto");
  });

  it("③ view/format 只接受枚举值；不认识的取值必须拒绝", () => {
    const badView = normalizeReadViewParameters({
      toolNameOrAlias: "readFile",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md", view: "not-a-view" }),
    });
    expect(badView.outcome).toBe("invalid-view");
    expect(badView.format).toBeNull();

    const badFormat = normalizeReadViewParameters({
      toolNameOrAlias: "readFile",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md", format: "not-a-format" }),
    });
    expect(badFormat.outcome).toBe("invalid-format");
  });

  it("④ 枚举内的 format/view 必须被接受并原样规范化", () => {
    for (const format of READ_VIEW_FORMATS) {
      const outcome = normalizeReadViewParameters({
        toolNameOrAlias: "readFile",
        argumentsJson: JSON.stringify({ filePath: "docs/a.md", format }),
      });
      expect(outcome.outcome).toBe("normalized");
      expect(outcome.format).toBe(format);
    }
    const withView = normalizeReadViewParameters({
      toolNameOrAlias: "readFile",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md", view: "summary" }),
    });
    expect(withView.outcome).toBe("normalized");
    expect(withView.view).toBe("summary");
  });

  it("⑤ 不适用于该 action 的视图参数必须拒绝（检索 action 不接受 format/view）", () => {
    const outcome = normalizeReadViewParameters({
      toolNameOrAlias: "searchProjectText",
      argumentsJson: JSON.stringify({ pattern: "x", format: "auto" }),
    });
    expect(outcome.outcome).toBe("parameter-not-applicable");
  });

  it("⑥ 未知工具名 / 未知 action / 参数不可解析 ⇒ 拒绝（fail-closed，不猜测）", () => {
    expect(
      normalizeReadViewParameters({ toolNameOrAlias: "unknownTool", argumentsJson: "{}" }).outcome,
    ).toBe("unknown-tool-action");
    expect(
      normalizeReadViewParameters({
        toolNameOrAlias: "projectFileRead",
        action: "not-an-action",
        argumentsJson: "{}",
      }).outcome,
    ).toBe("unknown-tool-action");
    expect(
      normalizeReadViewParameters({ toolNameOrAlias: "readFile", argumentsJson: "{ 坏" }).outcome,
    ).toBe("invalid-arguments");
  });

  it("⑦ 非布尔视图参数必须拒绝（不得把字符串当真值）", () => {
    const outcome = normalizeReadViewParameters({
      toolNameOrAlias: "readFile",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md", shouldIncludeComments: "yes" }),
    });
    expect(outcome.outcome).toBe("invalid-arguments");
  });
});
