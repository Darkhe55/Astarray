/**
 * 反例（授权抖动收敛，2026-10-02 用户选择方案 B）：
 *
 * 语义：**同一授权周期内容忍"无副作用重试"的参数抖动**，跨周期仍然严格。
 *
 *  - 同一工具 + **同一目标路径**，参数只有**键序**差异 → 视为同一逻辑操作，
 *    不得再次要求用户裁决；
 *    （**2026-10-11 更正**：既有实现与本文原先把"**内容结尾换行**"也算作格式差异，
 *    但 `canonicalizeToolArguments` 的**既定原则**是"数组顺序与**所有值保持原样**
 *    （**值变化仍必须使授权失效**）"，且只把**键序**列为语义无关。
 *    两者冲突；按 GUI-02-01 R1（用户 2026-10-11 批准：绑定**完整规范化参数指纹**）
 *    与上述原则，**内容变化（含结尾换行）必须重新裁决**。故本用例改为期望
 *    `ask-user`，键序容忍**保留**。）
 *  - 目标路径不同 → 必须重新裁决（不是同一操作）；
 *  - 工具不同 → 必须重新裁决；
 *  - 该路径**已成功写入过** → 必须 fail-closed（不得靠抖动绕过重放保护）。
 */
import { describe, expect, it } from "vitest";

import {
  shouldReusePreviousApproval,
  type PreviousApprovalRecord,
} from "../../../packages/tui/src/cli/permission-ask-adjudication.js";
import type { PermissionAsk } from "../../../packages/tui/src/cli/permission-ask-adjudication.js";

function ask(toolName: string, argumentsJson: string): PermissionAsk {
  return { taskIdentifier: "T-001", toolName, argumentsJson, explanation: "执行任务需要调用工具" };
}

function approval(overrides: Partial<PreviousApprovalRecord> = {}): PreviousApprovalRecord {
  return {
    toolName: "createProjectFile",
    argumentsJson: JSON.stringify({ filePath: "docs/A.md", content: "# A\n" }),
    hasSucceededWithSameTarget: false,
    ...overrides,
  };
}

describe("授权抖动收敛：同一授权周期内容忍无副作用重试", () => {
  it("① 同工具同路径，**内容结尾换行不同** → 必须重新裁决（值已变化）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        JSON.stringify({ filePath: "docs/A.md", content: "# A" }),
      ),
      previousApproval: approval(),
    });
    // 内容为 "# A" vs "# A\n"：**值已变化** ⇒ 必须重新裁决（见文件头 2026-10-11 更正）
    expect(decision).toBe("ask-user");
  });

  it("② 同工具同路径，仅键序不同 → 复用（键序不是语义差异）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        JSON.stringify({ content: "# A\n", filePath: "docs/A.md" }),
      ),
      previousApproval: approval(),
    });
    expect(decision).toBe("reuse-without-asking");
  });

  it("③ 同工具但目标路径不同 → 必须重新裁决（不是同一操作）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        JSON.stringify({ filePath: "docs/B.md", content: "# A\n" }),
      ),
      previousApproval: approval(),
    });
    expect(decision).toBe("ask-user");
  });

  it("④ 工具不同（即使路径相同）→ 必须重新裁决", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "replaceFileContent",
        JSON.stringify({ filePath: "docs/A.md", content: "# A\n" }),
      ),
      previousApproval: approval(),
    });
    expect(decision).toBe("ask-user");
  });

  it("⑤ 该目标路径已成功写入过 → fail-closed（不得靠抖动绕过重放保护）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        JSON.stringify({ filePath: "docs/A.md", content: "# A" }),
      ),
      previousApproval: approval({ hasSucceededWithSameTarget: true }),
    });
    expect(decision).toBe("already-executed");
  });

  it("⑥ 无既有批准记录 → 必须询问（不得凭空复用）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        JSON.stringify({ filePath: "docs/A.md", content: "# A\n" }),
      ),
      previousApproval: null,
    });
    expect(decision).toBe("ask-user");
  });

  it("⑦ 参数不可解析 → 必须询问（不得猜测目标路径）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", "{ 非法 JSON"),
      previousApproval: approval(),
    });
    expect(decision).toBe("ask-user");
  });
});
