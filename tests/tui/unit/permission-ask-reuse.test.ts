/**
 * 反例（授权抖动收敛，2026-10-02 用户选择方案 B）：
 *
 * 语义：**同一授权周期内容忍"无副作用重试"的参数抖动**，跨周期仍然严格。
 *
 *  - 同一工具 + **同一目标路径**，参数只有格式差异（结尾换行/键序）→ 视为同一逻辑操作，
 *    不得再次要求用户裁决；
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
  it("① 同工具同路径，仅结尾换行不同 → 复用（不再询问）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        JSON.stringify({ filePath: "docs/A.md", content: "# A" }),
      ),
      previousApproval: approval(),
    });
    expect(decision).toBe("reuse-without-asking");
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
