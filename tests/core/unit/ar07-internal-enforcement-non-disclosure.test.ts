/**
 * AR-07 / T06F：**内部强制执行层不得进入可配置权限目录，也不得对外披露**。
 *
 * 规则原文（`AGENTS.md` 强制规范）：
 *
 * > 底层强制约束**不进入可配置权限目录**，不生成设置按钮，也**不得由 TUI/CLI、帮助、
 * > 导出配置、普通错误详情或模型提示向用户披露**其存在或规则清单。
 *
 * `permission-capability-catalog.ts` 自己的 docstring 也写着同一句
 * （「内部强制执行层（敏感内容禁读、自动备份、身份认证、工具注册与参数 schema、
 * 真实路径/工作区/OS 边界、审计完整性、不可代理的用户确认）不属于可配置权限，
 * 不进入目录、设置、帮助、导出、普通审计或模型描述」）。
 *
 * ## 2026-11-08（第 93 轮）发现：该规则此前**只有文档、没有守卫**
 *
 * 变异探针实测：往目录里注入一条
 * `internal.sensitive-content-read-denied`（显示名「敏感内容禁读（内部强制）」、
 * 说明「内部强制执行层：不属于可配置权限」）后，
 * **18 个相关测试文件 / 147 条用例全部照旧通过** ⇒ **没有任何测试能拦住"把内部层写进目录"**。
 * 本用例即补上的守卫（并已纳入 `scripts/verify-mutation-kills.mjs` 的永久变异体）。
 */
import { describe, expect, it } from "vitest";

import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";

/**
 * 内部强制执行层的**公开可辨识措辞**（取自上述规则与目录 docstring 的枚举）。
 *
 * 只要这些词出现在面向用户的目录文案里，就说明内部层被当成"可配置权限"披露了。
 */
const INTERNAL_ENFORCEMENT_TERMS = [
  "敏感内容",
  "自动备份",
  "身份认证",
  "工具注册",
  "参数 schema",
  "真实路径",
  "工作区边界",
  "审计完整性",
  "不可代理",
  "内部强制",
  "底层强制",
] as const;

/** 允许出现的**公开**命名空间（新增公开能力须**有意**更新本清单 —— 这正是守卫的意义）。 */
const PUBLIC_CAPABILITY_NAMESPACES = [
  "agent",
  "backup",
  "browser",
  "clipboard",
  "cloud",
  "code-repository",
  "connector",
  "database",
  "dependency",
  "environment",
  "extension",
  "external",
  "financial",
  "git",
  "memory",
  "network",
  "process",
  "project",
  "system",
  "task",
] as const;

describe("AR-07：内部强制执行层不得披露为可配置权限", () => {
  it("目录文案里不得出现内部强制层的措辞（每条能力逐字段检查）", () => {
    const capabilities = new PermissionCapabilityCatalog().listCapabilities();
    expect(capabilities.length, "目录不应为空（否则本守卫形同虚设）").toBeGreaterThan(0);

    const violations: string[] = [];
    for (const capability of capabilities) {
      const searchableText = [
        capability.capabilityId,
        capability.displayName,
        capability.description,
        capability.riskSummary,
      ].join(" ");
      for (const term of INTERNAL_ENFORCEMENT_TERMS) {
        if (searchableText.includes(term)) {
          violations.push(capability.capabilityId + " 含内部层措辞「" + term + "」");
        }
      }
    }
    expect(
      violations,
      "内部强制执行层不得作为可配置权限披露（AGENTS.md 强制规范）：" + JSON.stringify(violations),
    ).toEqual([]);
  });

  it("每条能力的命名空间必须属于**冻结的公开清单**，且标识不得暗示内部层", () => {
    const catalog = new PermissionCapabilityCatalog();
    const capabilityIds = catalog.getCapabilityIds();
    // 无重复
    expect(new Set(capabilityIds).size).toBe(capabilityIds.length);

    const violations: string[] = [];
    for (const capabilityId of capabilityIds) {
      const namespace = capabilityId.split(".")[0] ?? "";
      if (!(PUBLIC_CAPABILITY_NAMESPACES as readonly string[]).includes(namespace)) {
        violations.push(capabilityId + " 的命名空间「" + namespace + "」不在公开清单内");
      }
      if (capabilityId.includes("internal")) {
        violations.push(capabilityId + " 标识含 internal（内部层不得出现在目录）");
      }
    }
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});
