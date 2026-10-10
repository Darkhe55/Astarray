/**
 * MERGE-01-01/02 反例（2026-10-10）：**参数级授权**的优先规则必须精确且 fail-closed。
 *
 * 卡内 §1.3 明确要求：
 *  - 参数级授权总开关 `isParameterAuthorizationEnabled`（**初始关闭**以兼容旧配置）；
 *  - 每个工具另有"启用参数细分"开关 `isParameterRulesEnabled`；
 *  - **总开关关闭 或 该工具细分关闭 ⇒ 使用统一授权（基线）**；
 *  - 均开启时：**已匹配参数规则覆盖工具基线，未匹配回退基线**；
 *  - 冲突时 **deny 优先于 ask，ask 优先于 allow**；
 *  - **工具明确 deny 为总拒绝，不被参数 allow 覆盖**；
 *  - 基础 ask 可对明确 action 细化 allow，但仍受更外层权限上限约束；
 *  - 规则只支持 action 枚举 / 枚举与布尔值 / 明确数值区间 / 固定参数值；
 *    **禁止可执行脚本、任意正则**（不认识的 action/参数拒绝）。
 *
 * 现状缺口（本文件在实现前必须失败）：`isParameterAuthorizationEnabled` /
 * `isParameterRulesEnabled` 在整个 `packages/` 内**零命中** ⇒ 该能力完全未实现。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateParameterAuthorization,
  type ParameterAuthorizationRule,
} from "../../../packages/core/src/tools/parameter-authorization.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";

const FILE_TOOL = "createProjectFile";

function rule(overrides: Partial<ParameterAuthorizationRule>): ParameterAuthorizationRule {
  return {
    toolName: FILE_TOOL,
    action: "create",
    decision: "allow",
    explanation: "测试规则",
    ...overrides,
  };
}

const enabledSettings = {
  isParameterAuthorizationEnabled: true,
  isParameterRulesEnabled: true,
};

describe("MERGE-01：参数级授权优先规则", () => {
  it("① 总开关关闭 ⇒ 一律回退工具基线（规则不得生效）", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      baselineDecision: "ask",
      settings: { isParameterAuthorizationEnabled: false, isParameterRulesEnabled: true },
      rules: [rule({ decision: "allow", match: { kind: "path-prefix", field: "filePath", prefix: "docs/" } })],
    });
    expect(outcome.decision).toBe("ask");
    expect(outcome.appliedRuleExplanation).toBeNull();
    expect(outcome.source).toBe("tool-baseline");
  });

  it("② 该工具细分关闭 ⇒ 回退基线（即使总开关开启）", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      baselineDecision: "ask",
      settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: false },
      rules: [rule({ decision: "allow", match: { kind: "path-prefix", field: "filePath", prefix: "docs/" } })],
    });
    expect(outcome.decision).toBe("ask");
    expect(outcome.source).toBe("tool-baseline");
  });

  it("③ 均开启：匹配的参数规则覆盖基线（ask 基线 + 明确 action ⇒ allow）", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [
        rule({
          decision: "allow",
          match: { kind: "path-prefix", field: "filePath", prefix: "docs/" },
          explanation: "仅允许写入 docs/ 前缀",
        }),
      ],
    });
    expect(outcome.decision).toBe("allow");
    expect(outcome.source).toBe("parameter-rule");
    expect(outcome.appliedRuleExplanation).toBe("仅允许写入 docs/ 前缀");
  });

  it("④ 未匹配参数 ⇒ 回退基线（不得因存在规则就放行）", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "outside/a.md" }),
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [
        rule({ decision: "allow", match: { kind: "path-prefix", field: "filePath", prefix: "docs/" } }),
      ],
    });
    expect(outcome.decision).toBe("ask");
    expect(outcome.source).toBe("tool-baseline");
  });

  it("⑤ 冲突时 deny > ask > allow（即使 allow 规则先声明）", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "secrets/a.md" }),
      baselineDecision: "allow",
      settings: enabledSettings,
      rules: [
        rule({ decision: "allow", match: { kind: "path-prefix", field: "filePath", prefix: "secrets/" } }),
        rule({ decision: "ask", match: { kind: "path-prefix", field: "filePath", prefix: "secrets/" } }),
        rule({ decision: "deny", match: { kind: "path-prefix", field: "filePath", prefix: "secrets/" } }),
      ],
    });
    expect(outcome.decision).toBe("deny");
    expect(outcome.source).toBe("parameter-rule");
  });

  it("⑥ 工具基线明确 deny 是总拒绝：不得被参数 allow 覆盖", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      baselineDecision: "deny",
      settings: enabledSettings,
      rules: [
        rule({ decision: "allow", match: { kind: "path-prefix", field: "filePath", prefix: "docs/" } }),
      ],
    });
    expect(outcome.decision).toBe("deny");
    expect(outcome.source).toBe("tool-baseline");
  });

  it("⑦ action 不匹配 ⇒ 规则不生效（不同 action 不得互相覆盖）", () => {
    const outcome = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "delete",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [
        rule({
          action: "create",
          decision: "allow",
          match: { kind: "path-prefix", field: "filePath", prefix: "docs/" },
        }),
      ],
    });
    expect(outcome.decision).toBe("ask");
    expect(outcome.source).toBe("tool-baseline");
  });

  it("⑧ 固定参数值与数值区间可判定；未知字段/非法参数拒绝（fail-closed）", () => {
    const fixedValue = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md", mode: "append" }),
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [
        rule({
          decision: "allow",
          match: { kind: "fixed-value", field: "mode", value: "append" },
        }),
      ],
    });
    expect(fixedValue.decision).toBe("allow");

    const numericRange = evaluateParameterAuthorization({
      toolName: "runCommand",
      action: "execute",
      argumentsJson: JSON.stringify({ timeoutSeconds: 30 }),
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [
        {
          toolName: "runCommand",
          action: "execute",
          decision: "allow",
          explanation: "允许 60 秒内的执行",
          match: { kind: "numeric-range", field: "timeoutSeconds", minimum: 0, maximum: 60 },
        },
      ],
    });
    expect(numericRange.decision).toBe("allow");

    // 参数不可解析 ⇒ 不得套用任何规则（回退基线，不猜测）
    const unparsable = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: "{ 不是 JSON",
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [
        rule({ decision: "allow", match: { kind: "path-prefix", field: "filePath", prefix: "docs/" } }),
      ],
    });
    expect(unparsable.decision).toBe("ask");
    expect(unparsable.source).toBe("tool-baseline");
  });

  it("⑨ 规则本身不合法（未知 action / 未知匹配种类）时不得放行", () => {
    const unknownAction = evaluateParameterAuthorization({
      toolName: FILE_TOOL,
      action: "create",
      argumentsJson: JSON.stringify({ filePath: "docs/a.md" }),
      baselineDecision: "ask",
      settings: enabledSettings,
      rules: [rule({ action: "not-an-action", decision: "allow" })],
    });
    expect(unknownAction.decision).toBe("ask");
  });
});

/**
 * ⑩ production 接线（MERGE-01-02 的门槛）：可配置权限引擎必须在**执行前裁决**时
 * 应用参数级规则，而不是只在纯函数里可用。
 *
 * action 绑定使用工具描述符的 `mutationKind`（本仓已有的本地确定性事实），
 * 因此调用方只需给出 baseline 与规则集；引擎不猜测 action。
 */
describe("MERGE-01：参数级规则在权限引擎裁决中生效", () => {
  it("⑩ 引擎 decide：匹配的参数 allow 覆盖基线 ask；未匹配时回退 ask", async () => {
    const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge01-engine-"));
    try {
      const catalog = new PermissionCapabilityCatalog();
      const profileStore = new PermissionProfileStore({ baseDirectory, catalog });
      const engine = new ConfigurablePermissionPolicyEngine({
        catalog,
        profileStore,
        nowUnixSeconds: () => 1_000_000,
        // 参数级授权（总开关 + 该工具细分）由调用方注入：
        parameterAuthorization: {
          settings: {
            isParameterAuthorizationEnabled: true,
            isParameterRulesEnabled: true,
          },
          rules: [
            {
              toolName: "createProjectFile",
              // 与描述符 mutationKind 绑定（本地确定性事实，不由模型给出）
              action: "file-create",
              decision: "allow",
              explanation: "仅允许 docs/ 前缀的新建",
              match: { kind: "path-prefix", field: "filePath", prefix: "docs/" },
            },
          ],
        },
      });
      const profileReference = { kind: "builtin" as const, profileId: "assist" as const };
      const allowed = await engine.decide({
        toolName: "createProjectFile",
        action: "file-create",
        profileReference,
        argumentsJson: JSON.stringify({ filePath: "docs/a.md", content: "x" }),
      });
      expect(allowed.decision).toBe("allow");

      const fallback = await engine.decide({
        toolName: "createProjectFile",
        action: "file-create",
        profileReference,
        argumentsJson: JSON.stringify({ filePath: "outside/a.md", content: "x" }),
      });
      // assist 基线为 ask ⇒ 未匹配必须回退 ask（不得因存在规则就放行）
      expect(fallback.decision).toBe("ask");
    } finally {
      await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
