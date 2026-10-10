/**
 * MERGE-01 反例（2026-10-10，§1.3 第 4 项）：参数授权的**设置入口**。
 *
 * 卡内 §1.3 第 4 项点名要有"参数授权设置入口"（总开关 + 每工具细分开关 + 规则列表），
 * 且 §1.2 要求默认**全部开启**、优先级 deny>ask>allow。
 *
 * 实测缺口：`isParameterAuthorizationEnabled` / `isParameterRulesEnabled` 此前**只存在于
 * 权限引擎的构造函数参数里**，全仓 TUI/CLI/GUI/设置**零入口** ⇒
 * 「参数授权设置入口」在产品层面不成立，且 TOOLKIT-01-04（依赖 MERGE-01 该功能）无法开始。
 *
 * 本片钉住设置入口的**判定与持久化**语义：
 *  - 无配置文件时取出**默认值**（两个开关默认开启 —— 卡内要求默认全部开启）
 *    且**不落盘**（不因为读了一次就把配置文件创建出来）；
 *  - 两个开关必须为**布尔**，其它类型一律拒绝；
 *  - 规则逐条校验（action 必须属于该工具、匹配种类必须已知、必需字段齐全），非法即拒绝；
 *  - 规则 ID 重复必须拒绝（避免"后写覆盖前写"导致规则悄悄失效）；
 *  - 写入必须**持久化**（新进程读回一致）；
 *  - 设置必须真的被权限引擎消费（设置 → 引擎 → 裁决一致），而不是只存不用。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ParameterAuthorizationSettingsStore } from "../../../packages/core/src/tools/parameter-authorization-settings-store.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge01-settings-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildValidRule(overrides: Record<string, unknown> = {}) {
  return {
    ruleIdentifier: "rule-docs-only",
    toolName: "createProjectFile",
    action: "create",
    decision: "allow" as const,
    explanation: "仅允许 docs/ 前缀的新建",
    match: { kind: "path-prefix" as const, field: "filePath", prefix: "docs/" },
    ...overrides,
  };
}

describe("MERGE-01：参数授权设置入口（读取与默认值）", () => {
  it("① 无配置文件时默认**两个开关都开启**，且读取不创建文件", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory });
    const document = await store.readSettings();
    expect(document.settings.isParameterAuthorizationEnabled).toBe(true);
    expect(document.settings.isParameterRulesEnabled).toBe(true);
    expect(document.rules).toEqual([]);
    // 只读不落盘
    const entries = await fs.readdir(stateDirectory);
    expect(entries).toEqual([]);
  });

  it("② 写入后必须持久化（新实例读回一致）", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory });
    await store.writeSettings({
      settings: { isParameterAuthorizationEnabled: false, isParameterRulesEnabled: true },
      rules: [buildValidRule()],
    });
    const reopened = new ParameterAuthorizationSettingsStore({ stateDirectory });
    const document = await reopened.readSettings();
    expect(document.settings.isParameterAuthorizationEnabled).toBe(false);
    expect(document.settings.isParameterRulesEnabled).toBe(true);
    expect(document.rules).toHaveLength(1);
    expect(document.rules[0]?.ruleIdentifier).toBe("rule-docs-only");
  });
});

describe("MERGE-01：参数授权设置入口（校验，fail-closed）", () => {
  it("③ 开关必须为布尔；其它类型一律拒绝", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory });
    for (const invalidValue of ["true", 1, null]) {
      const outcome = await store.writeSettings({
        settings: {
          isParameterAuthorizationEnabled: invalidValue as never,
          isParameterRulesEnabled: true,
        },
        rules: [],
      });
      expect(outcome.isValid, "非法开关值必须被拒: " + String(invalidValue)).toBe(false);
    }
  });

  it("④ 规则 action 不属于该工具 / 未知匹配种类 / 缺必需字段 ⇒ 拒绝", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory });
    const validSettings = {
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
    };

    const unknownAction = await store.writeSettings({
      settings: validSettings,
      rules: [buildValidRule({ action: "not-an-action" }) as never],
    });
    expect(unknownAction.isValid).toBe(false);

    const unknownMatchKind = await store.writeSettings({
      settings: validSettings,
      rules: [
        buildValidRule({
          match: { kind: "regex", field: "filePath", pattern: ".*" },
        }) as never,
      ],
    });
    expect(unknownMatchKind.isValid).toBe(false);
    expect(String(unknownMatchKind.reason)).toMatch(/匹配|kind|正则|regex|已知/);

    const missingToolName = await store.writeSettings({
      settings: validSettings,
      rules: [buildValidRule({ toolName: "" }) as never],
    });
    expect(missingToolName.isValid).toBe(false);
  });

  it("⑤ 规则 ID 重复必须拒绝（避免后写静默覆盖前写）", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory });
    const outcome = await store.writeSettings({
      settings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      rules: [buildValidRule(), buildValidRule({ decision: "deny" })],
    });
    expect(outcome.isValid).toBe(false);
    expect(String(outcome.reason)).toMatch(/重复|ruleIdentifier|唯一/);
  });
});

describe("MERGE-01：设置必须真的被权限引擎消费（不是只存不用）", () => {
  it("⑥ 关闭总开关后，参数规则不再放行（与引擎裁决一致）", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory });
    const catalog = new PermissionCapabilityCatalog();
    const profileStore = new PermissionProfileStore({
      baseDirectory: stateDirectory,
      catalog,
    });
    const profileReference = { kind: "builtin" as const, profileId: "assist" as const };
    const callArguments = JSON.stringify({ filePath: "docs/a.md", content: "x" });

    const runEngineWithStoredSettings = async () => {
      const document = await store.readSettings();
      const engine = new ConfigurablePermissionPolicyEngine({
        catalog,
        profileStore,
        nowUnixSeconds: () => 1_000_000,
        parameterAuthorization: {
          settings: document.settings,
          rules: document.rules,
        },
      });
      return engine.decide({
        toolName: "createProjectFile",
        action: "create",
        profileReference,
        argumentsJson: callArguments,
      });
    };

    // 开启：规则放行
    await store.writeSettings({
      settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
      rules: [buildValidRule()],
    });
    expect((await runEngineWithStoredSettings()).decision).toBe("allow");

    // 关闭总开关：回退 assist 基线 ask
    await store.writeSettings({
      settings: { isParameterAuthorizationEnabled: false, isParameterRulesEnabled: true },
      rules: [buildValidRule()],
    });
    expect((await runEngineWithStoredSettings()).decision).toBe("ask");
  });
});
