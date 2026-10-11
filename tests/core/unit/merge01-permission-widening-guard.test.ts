/**
 * MERGE-01 反例（2026-10-10）：**关闭参数细分不得静默扩大权限**。
 *
 * 卡内 §1.3 明文：
 *  "**关闭细分若会从 deny/ask 回退 allow，必须明确提示放宽范围，
 *  不以"关闭功能"静默扩大权限**。收紧立即阻止新执行，旧在途按取消/对账收敛；
 *  **所有旧批准按 revision 失效复检**。"
 * 以及"设置变更展示**简短准确差异**，**扩大权限需既有认证用户确认**；
 *  **配置保存和生效 revision 分开**"。
 *
 * 现状缺口（本轮实测）：`parameter-authorization-settings-store.ts` 只校验开关**是否为布尔值**，
 * **完全没有**"关闭细分会不会把 deny/ask 放宽成 allow"的判定，也没有"扩大权限需确认"的门禁
 * ⇒ 一次 `isParameterRulesEnabled: false` 写入即可**静默扩大权限**。
 *
 * 本片钉住的语义（全部 fail-closed）：
 *  - 关闭细分/总开关若**任何**受影响工具/参数从 deny 或 ask 落到 allow ⇒ 判为**放宽**
 *    并**逐条列出**（可读、简短、准确）；
 *  - 存在放宽而**未获认证用户确认** ⇒ **拒绝写入**（不得静默生效）；
 *  - 已确认时写入成功，并**如实回报**放宽条目；
 *  - **收紧**（allow→deny/ask）**无需**确认，但必须**立即生效并记录**；
 *  - 变更必须带**配置 revision 与生效 revision 分开**的信息。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateParameterAuthorizationSettingChange,
  type PermissionEffect,
} from "../../../packages/core/src/tools/parameter-authorization-settings-store.js";

interface ToolAuthorizationShape {
  toolName: string;
  unifiedEffect: PermissionEffect;
  ruleEffects: Array<{ ruleIdentifier: string; effect: PermissionEffect }>;
}

function buildTool(overrides: Partial<ToolAuthorizationShape> = {}): ToolAuthorizationShape {
  return {
    toolName: "readFile",
    unifiedEffect: "allow",
    ruleEffects: [{ ruleIdentifier: "rule-deny-secrets", effect: "deny" }],
    ...overrides,
  };
}

describe("MERGE-01：关闭细分若放宽权限必须提示并要求确认", () => {
  it("① 关闭细分使某参数从 deny 回退 allow ⇒ 判为放宽并逐条列出", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [buildTool()],
      isConfirmedByAuthenticatedUser: true,
    });
    const widenEntry = outcome.widenedPermissions.find(
      (permission) => permission.toolName === "readFile",
    );
    expect(widenEntry).toBeDefined();
    expect(widenEntry?.previousEffect).toBe("deny");
    expect(widenEntry?.nextEffect).toBe("allow");
    // 可读、简短、准确
    expect(String(widenEntry?.displaySummary)).toMatch(/readFile/);
    expect(String(widenEntry?.displaySummary)).toMatch(/deny/);
    expect(String(widenEntry?.displaySummary)).toMatch(/allow/);
  });

  it("② 存在放宽但**未获认证用户确认** ⇒ 必须拒绝写入", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [buildTool()],
      isConfirmedByAuthenticatedUser: false,
    });
    expect(outcome.isAccepted).toBe(false);
    expect(outcome.requiresAuthenticatedUserConfirmation).toBe(true);
    expect(String(outcome.reason)).toMatch(/确认|放宽/);
  });

  it("③ ask → allow 同样算放宽（ask 不是 allow）", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [
        buildTool({
          toolName: "createProjectFile",
          unifiedEffect: "allow",
          ruleEffects: [{ ruleIdentifier: "rule-ask", effect: "ask" }],
        }),
      ],
      isConfirmedByAuthenticatedUser: false,
    });
    const widenEntry = outcome.widenedPermissions.find(
      (permission) => permission.toolName === "createProjectFile",
    );
    expect(widenEntry?.previousEffect).toBe("ask");
    expect(widenEntry?.nextEffect).toBe("allow");
  });

  it("④ 关闭细分但**结果不变**（细分规则与基线一致）⇒ 不算放宽，无需确认", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [
        buildTool({
          unifiedEffect: "allow",
          ruleEffects: [{ ruleIdentifier: "rule-allow", effect: "allow" }],
        }),
      ],
      isConfirmedByAuthenticatedUser: false,
    });
    expect(outcome.widenedPermissions).toEqual([]);
    expect(outcome.isAccepted).toBe(true);
    expect(outcome.requiresAuthenticatedUserConfirmation).toBe(false);
  });

  it("⑤ 收紧（allow 基线 + 规则 deny 被启用）无需确认，但必须记录并立即生效", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      tools: [buildTool()],
      isConfirmedByAuthenticatedUser: false,
    });
    expect(outcome.widenedPermissions).toEqual([]);
    expect(outcome.isAccepted).toBe(true);
    // 收紧必须被记录（便于人工核对"谁在何时收紧了什么"）
    expect(outcome.tightenedPermissions.length).toBeGreaterThan(0);
  });

  it("⑥ 关闭**总开关**同样要检测放宽，且不得因'关闭功能'而免检", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: false,
        isParameterRulesEnabled: true,
      },
      tools: [buildTool()],
      isConfirmedByAuthenticatedUser: false,
    });
    expect(outcome.widenedPermissions.length).toBeGreaterThan(0);
    expect(outcome.isAccepted).toBe(false);
  });

  it("⑦ 变更必须把**配置 revision 与生效 revision 分开**", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [buildTool()],
      isConfirmedByAuthenticatedUser: true,
      configurationRevision: 7,
      effectiveRevision: 7,
    });
    expect(outcome.isAccepted).toBe(true);
    /**
     * 生效 revision 必须在**应用之后**才前进：卡内要求"配置保存和生效 revision 分开"。
     */
    expect(outcome.configurationRevision).toBe(8);
    expect(outcome.effectiveRevision).toBe(8);
    expect(outcome.isRevisionAppliedImmediately).toBe(true);
  });

  it("⑧ 未确认被拒时**不得**推进任何 revision（不得半生效）", () => {
    const outcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [buildTool()],
      isConfirmedByAuthenticatedUser: false,
      configurationRevision: 7,
      effectiveRevision: 7,
    });
    expect(outcome.isAccepted).toBe(false);
    expect(outcome.configurationRevision).toBe(7);
    expect(outcome.effectiveRevision).toBe(7);
  });
});
