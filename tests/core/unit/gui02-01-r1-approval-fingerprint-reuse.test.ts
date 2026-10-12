/**
 * GUI-02-01 **R1 返修**的行为反例（先红后绿）。
 *
 * 缺陷背景（见 `docs/reports/GUI02_01_REMEDIATION_APPROVAL_FINGERPRINT_GAP_2026-10-11.md`）：
 * 现有 `shouldReusePreviousApproval` **只比较工具名 + 目标路径**，
 * **其余参数完全不参与判定** ⇒ 同一路径、**内容不同**也会复用批准，
 * 与用户 S3 要求"绑定**完整参数指纹**"冲突。
 *
 * 用户已批准方案 **R1**：
 * > 复用判定改为：**规范化参数指纹相同** 且 无副作用 ⇒ 复用；
 * > 指纹不同 ⇒ `ask-user`；并新增**有效期**与**请求 revision** 校验。
 *
 * **必须同时保住既有决策**（2026-10-02 方案 B）：
 * > 同一授权周期内**容忍"无副作用重试"的参数抖动**（换行/键序等格式差异）。
 *
 * 因此本文件的两条对称反例是关键：
 *  - **内容变化 ⇒ 必须重新询问**（消除缺陷）；
 *  - **仅键序不同 ⇒ 仍复用**（方案 B 的容忍**未被取消**）。
 *
 * 本文件在实现前必须失败（`ApprovalReuseDecision` 尚无表示"批准过期"的取值）。
 */
import { describe, expect, it } from "vitest";

import {
  shouldReusePreviousApproval,
  type PermissionAsk,
} from "../../../packages/core/src/orchestration/permission-ask-contract.js";

function ask(toolName: string, argumentsJson: string): PermissionAsk {
  return {
    taskIdentifier: "T-001",
    toolName,
    argumentsJson,
    explanation: "需要写入项目文件",
  };
}

describe("GUI-02-01 R1：批准复用必须绑定**完整规范化参数指纹**", () => {
  it("① 【消除缺陷】同一目标路径、**内容不同** ⇒ 必须重新询问（当前实现会复用 ⇒ 红）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        '{"filePath":"a/b.txt","content":"**完全不同的第二版内容**"}',
      ),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"第一版内容"}',
        hasSucceededWithSameTarget: false,
      },
    });
    expect(
      decision,
      "内容已变却复用批准，与 S3『完整参数指纹』冲突",
    ).toBe("ask-user");
  });

  it("② 【保住方案 B】仅**键序不同** ⇒ 仍复用（格式抖动容忍不得被取消）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        '{"content":"同一内容","filePath":"a/b.txt"}',
      ),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: false,
      },
    });
    expect(
      decision,
      "键序不同属格式抖动，方案 B 明确容忍 ⇒ 必须仍复用",
    ).toBe("reuse-without-asking");
  });

  it("③ 仅**空白/换行差异** ⇒ 仍复用", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{ "filePath" : "a/b.txt" , "content" : "同一内容" }'),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: false,
      },
    });
    expect(decision).toBe("reuse-without-asking");
  });

  it("④ 完整参数完全相同 且 无副作用 ⇒ 复用（原有正确行为不得回退）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/b.txt","content":"同一内容"}'),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: false,
      },
    });
    expect(decision).toBe("reuse-without-asking");
  });

  it("⑤ 已成功写入过同一目标 ⇒ 一律不得复用（fail-closed 不放宽）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/b.txt","content":"同一内容"}'),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: true,
      },
    });
    expect(decision).toBe("already-executed");
  });

  it("⑥ 目标路径相同、但**新增了一个参数** ⇒ 必须重新询问（指纹已变）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask(
        "createProjectFile",
        '{"filePath":"a/b.txt","content":"同一内容","mode":"append"}',
      ),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: false,
      },
    });
    expect(decision).toBe("ask-user");
  });

  it("⑦ 参数不可解析 ⇒ 必须询问（保守，不放宽）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", "{ 不是 JSON"),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: "{ 也不是 JSON",
        hasSucceededWithSameTarget: false,
      },
    });
    expect(decision).toBe("ask-user");
  });

  it("⑧ **超出有效期**的批准不得复用", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/b.txt","content":"同一内容"}'),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: false,
        // 已过期：登记时给"过去"的时间点
        expiresAtIso: "2020-01-01T00:00:00.000Z",
      },
    });
    expect(decision).toBe("ask-user");
  });

  it("⑨ **未过期**的批准仍可复用（有效期未生效时不得误伤）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/b.txt","content":"同一内容"}'),
      previousApproval: {
        toolName: "createProjectFile",
        argumentsJson: '{"filePath":"a/b.txt","content":"同一内容"}',
        hasSucceededWithSameTarget: false,
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(decision).toBe("reuse-without-asking");
  });
});
