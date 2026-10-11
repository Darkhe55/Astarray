/**
 * GUI-02-01 反例：**批准复用必须绑定完整参数指纹**（用户要求 S3）。
 *
 * **背景**：用户 2026-10-11 的公共授权契约要求：
 * > 请求绑定具体操作、**完整参数指纹**及权限 revision；过期、撤销、参数变化均不能复用批准。
 *
 * **现状（本文件钉住的事实）**：提取到核心的 `shouldReusePreviousApproval`
 * 只比较 **工具名 + 目标路径**（`TARGET_PATH_KEYS`：path/filePath/targetPath/directoryPath），
 * **不比较完整参数**。因此**同一目标路径、内容不同的两次写入**会被判为
 * `reuse-without-asking` —— 即**参数已变化却复用了批准**，与 S3 不符。
 *
 * **本文件的性质（如实声明，不掩盖）**：
 * - `it(...)` 断言的是**现存行为**，故**当前为绿**；它**不是**"缺陷已修"的证据，
 *   而是把"当前契约与 S3 的差距"固定下来，供返修时改写为期望行为；
 * - 按用户定的规矩（"若发现现有缺陷 ⇒ 另列返修，**不混入提取悄悄改变语义**"），
 *   本文件**只记录与钉住差距，不在提取里修改判定语义**；
 * - 返修方案见 §"返修建议"，需用户确认后再改（涉及批准复用的放宽/收紧，属安全语义）。
 *
 * **为什么不能"顺手改成比完整参数"**：现有复用语义是 2026-10-02 用户明确选择的
 * **方案 B**（"同一授权周期内容忍无副作用重试的参数抖动"）——故意容忍换行/键序差异。
 * 直接改成比完整 `argumentsJson` 会**取消该容忍**（行为变更）；正确做法是
 * **规范化后比对**（键序无关、仅忽略无副作用差异），并在判定里同时纳入
 * **有效期与请求 revision**，这需要先有"请求实体"（见 §未完成）。
 */
import { describe, expect, it } from "vitest";

import {
  buildPermissionAskFromEscalation,
  shouldReusePreviousApproval,
  type PermissionAsk,
  type PreviousApprovalRecord,
} from "../../../packages/core/src/orchestration/permission-ask-contract.js";

function ask(toolName: string, argumentsJson: string): PermissionAsk {
  return {
    taskIdentifier: "T-001",
    toolName,
    argumentsJson,
    explanation: "需要写入项目文件",
  };
}

describe("GUI-02-01 N4：批准复用与『完整参数指纹』的差距（记录现状，非已修）", () => {
  it("① 【记录现状】同一目标路径、**内容不同**时，当前判定仍为 reuse-without-asking（与 S3 不符）", () => {
    const previousApproval: PreviousApprovalRecord = {
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a/b.txt","content":"第一版内容"}',
      hasSucceededWithSameTarget: false,
    };
    const pendingAsk = ask(
      "createProjectFile",
      '{"filePath":"a/b.txt","content":"**完全不同的第二版内容**"}',
    );

    const decision = shouldReusePreviousApproval({ pendingAsk, previousApproval });

    /**
     * 现象：**内容已变、批准仍被复用**。
     * 这正是 S3 要求"完整参数指纹"要消除的情况 —— 本断言把差距固定下来，
     * 返修时应改为期望 `"ask-user"`（或引入规范化指纹后按指纹判定）。
     */
    expect(
      decision,
      "当前只比工具名+目标路径 ⇒ 内容变化也复用批准（与 S3『完整参数指纹』不符）",
    ).toBe("reuse-without-asking");
  });

  it("② 目标路径变化 ⇒ 必须重新询问（现有行为已正确）", () => {
    const previousApproval: PreviousApprovalRecord = {
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a/b.txt","content":"内容"}',
      hasSucceededWithSameTarget: false,
    };
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/OTHER.txt","content":"内容"}'),
      previousApproval,
    });
    expect(decision).toBe("ask-user");
  });

  it("③ 工具名变化 ⇒ 必须重新询问（现有行为已正确）", () => {
    const previousApproval: PreviousApprovalRecord = {
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a/b.txt","content":"内容"}',
      hasSucceededWithSameTarget: false,
    };
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("deleteBackup", '{"filePath":"a/b.txt","content":"内容"}'),
      previousApproval,
    });
    expect(decision).toBe("ask-user");
  });

  it("④ 已成功写入过同一目标 ⇒ 不得复用（fail-closed，现有行为已正确）", () => {
    const previousApproval: PreviousApprovalRecord = {
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":"a/b.txt","content":"内容"}',
      hasSucceededWithSameTarget: true,
    };
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/b.txt","content":"内容"}'),
      previousApproval,
    });
    expect(decision).toBe("already-executed");
  });

  it("⑤ 无批准记录 ⇒ 必须询问（现有行为已正确）", () => {
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", '{"filePath":"a/b.txt"}'),
      previousApproval: null,
    });
    expect(decision).toBe("ask-user");
  });

  it("⑥ 参数不可解析 ⇒ 必须询问（保守，现有行为已正确）", () => {
    const previousApproval: PreviousApprovalRecord = {
      toolName: "createProjectFile",
      argumentsJson: "{ 不是 JSON",
      hasSucceededWithSameTarget: false,
    };
    const decision = shouldReusePreviousApproval({
      pendingAsk: ask("createProjectFile", "{ 也不是 JSON"),
      previousApproval,
    });
    expect(decision).toBe("ask-user");
  });
});

describe("GUI-02-01 N3：过期裁决 —— **当前无法实现**（缺请求实体）", () => {
  /**
   * 用户要求 S3 含"**过期**…不能复用批准"，N3 要求"过期裁决被拒"。
   *
   * **为什么现在写不了**：核心目前**没有权限询问的请求实体** ——
   * 没有 `askIdentifier`、没有请求自身的 `revision`、没有**有效期**。
   * （全局搜到的 `askIdentifier`/`operationFingerprint`/`expiresAtIso` 属于
   * **安装授权**与**跨项目授权**等**其它子系统**，不是 permission-ask 的。）
   *
   * 因此"过期裁决被拒"**尚无可被测试的载体**：既没有"裁决"这个对象，
   * 也没有"过期"这个可判定属性。
   *
   * **本用例只钉住该前提**：一旦有人给 permission-ask 加上有效期/
   * 请求 revision，此处前的说明即失效，应改写为真正的过期反例。
   */
  it("前提：permission-ask 的公开契约目前**不含**有效期与请求 revision 字段", () => {
    const contractKeys = Object.keys(
      ask("createProjectFile", '{"filePath":"a/b.txt"}'),
    ).sort();
    expect(
      contractKeys,
      "权限询问契约尚无 expiresAtIso / revision / askIdentifier ⇒ N3『过期裁决』暂无可测载体",
    ).toEqual(["argumentsJson", "explanation", "taskIdentifier", "toolName"]);
  });

  it("前提：从升级文本解析出的询问同样不含有效期与 revision", () => {
    const parsed = buildPermissionAskFromEscalation(
      "任务 T-001 需要权限调用 createProjectFile（写入项目文件），参数: {\"filePath\":\"a/b.txt\"}",
    );
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "argumentsJson",
      "explanation",
      "taskIdentifier",
      "toolName",
    ]);
  });
});
