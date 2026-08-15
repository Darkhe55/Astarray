/**
 * T06F 单测：可配置权限组与自定义模式（ADR-0020）。
 * 覆盖：目录逐项默认值、最严格裁决、内置三组（Devolve 全 allow/Assist
 * 独立矩阵/Ponder 冻结）、自定义组生命周期（创建/改名/复制/重置/删除/
 * 名称唯一/保留名/无数量上限）、导入导出过滤、引擎裁决（未映射 deny/
 * ask 绑定 revision/参数哈希/授权失效）、工具注册校验。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import {
  PermissionProfileStore,
  BUILTIN_PROFILE_DISPLAY_NAMES,
  normalizeProfileDisplayName,
} from "../../../packages/core/src/tools/permission-profile-store.js";
import type { PermissionProfileDocument } from "../../../packages/core/src/tools/permission-profile-store.js";
import { CustomPermissionProfileController } from "../../../packages/core/src/tools/custom-permission-profile-controller.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import type { ToolDescriptor } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06f-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeStore() {
  const catalog = new PermissionCapabilityCatalog();
  return {
    catalog,
    store: new PermissionProfileStore({
      baseDirectory: temporaryDirectory,
      catalog,
    }),
  };
}

function makeController() {
  const { catalog, store } = makeStore();
  return {
    catalog,
    store,
    controller: new CustomPermissionProfileController(store, catalog),
  };
}

function makeToolDescriptor(toolName: string): ToolDescriptor {
  return {
    name: toolName,
    summary: toolName,
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {},
  };
}

describe("PermissionCapabilityCatalog", () => {
  const catalog = new PermissionCapabilityCatalog();

  it("目录逐项覆盖 ADR-0020 表（关键项存在且默认值正确）", () => {
    expect(catalog.getCapability("project.read")).toMatchObject({
      devolveDefault: "allow",
      assistDefault: "allow",
    });
    expect(catalog.getCapability("project.destructive-mutate")).toMatchObject({
      devolveDefault: "allow",
      assistDefault: "deny",
    });
    expect(catalog.getCapability("git.remote-write")).toMatchObject({
      devolveDefault: "allow",
      assistDefault: "deny",
    });
    expect(catalog.getCapability("financial.transact")).toMatchObject({
      devolveDefault: "allow",
      assistDefault: "deny",
    });
    expect(catalog.getCapability("memory.write")).toMatchObject({
      devolveDefault: "allow",
      assistDefault: "ask",
    });
    // 无宽泛"其他"项
    expect(catalog.getCapability("other")).toBeUndefined();
    expect(catalog.listCapabilities().length).toBeGreaterThanOrEqual(44);
  });

  it("工具需多项权限时取最严格结果（任一 deny→deny；否则任一 ask→ask；全 allow→allow）", () => {
    const allAllow = catalog.evaluateToolPermission({
      toolName: "readFile",
      capabilityDecisions: { "project.read": "allow" },
    });
    expect(allAllow).toBe("allow");
    const denied = catalog.evaluateToolPermission({
      toolName: "readFile",
      capabilityDecisions: { "project.read": "deny" },
    });
    expect(denied).toBe("deny");
    const asked = catalog.evaluateToolPermission({
      toolName: "readFile",
      capabilityDecisions: { "project.read": "ask" },
    });
    expect(asked).toBe("ask");
    // 未映射工具拒绝
    expect(
      catalog.evaluateToolPermission({
        toolName: "unmapped-tool",
        capabilityDecisions: {},
      }),
    ).toBe("deny");
  });

  it("工具映射完整（内置工具全部映射）", () => {
    for (const toolName of [
      "readFile",
      "listDirectory",
      "writeFileTemporary",
      "replaceFileContent",
      "backupVault",
      "deleteBackup",
      "taskSequenceStatus",
      "searchProjectText",
      "gitReadonlyView",
      "factVerification",
    ]) {
      expect(catalog.isToolMapped(toolName)).toBe(true);
    }
    expect(catalog.isToolMapped("mysteryTool")).toBe(false);
  });
});

describe("PermissionProfileStore（内置三组）", () => {
  function setup() {
    const { store } = makeStore();
    return { store };
  }

  it("Devolve 出厂全部 allow；Assist 独立矩阵；Ponder 全 deny + 签名冻结", () => {
    const { store } = setup();
    const devolve = store.buildBuiltinProfile("devolve");
    expect(
      Object.values(devolve.capabilityDecisions).every(
        (decision) => decision === "allow",
      ),
    ).toBe(true);
    const assist = store.buildBuiltinProfile("assist");
    expect(assist.capabilityDecisions["project.destructive-mutate"]).toBe("deny");
    expect(assist.capabilityDecisions["project.read"]).toBe("allow");
    const ponder = store.buildBuiltinProfile("ponder");
    expect(
      Object.values(ponder.capabilityDecisions).every(
        (decision) => decision === "deny",
      ),
    ).toBe(true);
    expect(ponder.frozenSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Assist 与 Devolve 配置互不污染", () => {
    const { store } = setup();
    const assist = store.buildBuiltinProfile("assist");
    const devolve = store.buildBuiltinProfile("devolve");
    expect(devolve.capabilityDecisions["git.rewrite-history"]).toBe("allow");
    expect(assist.capabilityDecisions["git.rewrite-history"]).toBe("deny");
  });

  it("内置 profile 不可写（saveCustomProfile 拒绝）", async () => {
    const { store } = setup();
    const builtin = store.buildBuiltinProfile("assist");
    await expect(
      store.saveCustomProfile({
        document: builtin,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("含特殊字符的权限组 ID 路径段安全编码（可读回）", async () => {
    const { store } = setup();
    const document: PermissionProfileDocument = {
      schemaVersion: 1,
      permissionProfileId: "profile:with:colons",
      displayName: "特殊 ID 组",
      isBuiltin: false,
      revision: 1,
      catalogVersion: 1,
      capabilityDecisions: {},
      fallbackDecision: "deny",
      frozenSignature: null,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    await store.saveCustomProfile({ document, expectedRevision: 0 });
    const reread = await store.readCustomProfile("profile:with:colons");
    expect(reread?.permissionProfileId).toBe("profile:with:colons");
    expect((await store.listCustomProfileIds())).toContain("profile:with:colons");
    // 签名冻结文档拒绝保存
    const frozen: PermissionProfileDocument = {
      ...document,
      permissionProfileId: "profile:frozen",
      frozenSignature: "abc",
    };
    await expect(
      store.saveCustomProfile({ document: frozen, expectedRevision: 0 }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("名称规范化：Unicode + 大小写折叠；保留内置中英文名", () => {
    expect(normalizeProfileDisplayName("  My  Profile ")).toBe("my  profile");
    expect(normalizeProfileDisplayName("ＭＹ")).toBe("ｍｙ");
    expect(BUILTIN_PROFILE_DISPLAY_NAMES).toContain("思索模式");
    expect(BUILTIN_PROFILE_DISPLAY_NAMES).toContain("Devolve");
  });
});

describe("CustomPermissionProfileController", () => {
  function setup() {
    return makeController();
  }

  it("创建（空白全 deny）→ 逐项更新 → 重命名 → 删除；revision 单调", async () => {
    const { controller, store } = setup();
    const created = await controller.createProfile({
      displayName: " 受限组 ",
      source: { kind: "blank" },
    });
    expect(created.isBuiltin).toBe(false);
    expect(created.revision).toBe(1);
    expect(created.capabilityDecisions).toEqual({});
    // 逐项更新
    const updated = await controller.updateCapabilityDecision({
      permissionProfileId: created.permissionProfileId,
      capabilityId: "project.read",
      decision: "allow",
      expectedRevision: 1,
    });
    expect(updated.revision).toBe(2);
    expect(updated.capabilityDecisions["project.read"]).toBe("allow");
    // 重命名（不改变 ID）
    const renamed = await controller.renameProfile({
      permissionProfileId: created.permissionProfileId,
      newDisplayName: "受限组 v2",
      expectedRevision: 2,
    });
    expect(renamed.permissionProfileId).toBe(created.permissionProfileId);
    expect(renamed.displayName).toBe("受限组 v2");
    // 持久化后读取
    const reread = await store.readCustomProfile(created.permissionProfileId);
    expect(reread?.displayName).toBe("受限组 v2");
    // 删除
    await controller.deleteProfile({
      permissionProfileId: created.permissionProfileId,
      isCurrentlyActive: false,
    });
    expect(await store.readCustomProfile(created.permissionProfileId)).toBeNull();
  });

  it("从 Assist/Devolve/自定义组复制（ID/revision 独立）", async () => {
    const { controller } = setup();
    const copied = await controller.createProfile({
      displayName: "从 Dev 复制",
      source: { kind: "builtin", profileId: "devolve" },
    });
    expect(
      copied.capabilityDecisions["project.destructive-mutate"],
    ).toBe("allow");
    const fromCustom = await controller.createProfile({
      displayName: "从自定义复制",
      source: { kind: "custom", permissionProfileId: copied.permissionProfileId },
    });
    expect(fromCustom.permissionProfileId).not.toBe(copied.permissionProfileId);
    expect(fromCustom.revision).toBe(1);
  });

  it("名称唯一（大小写折叠）与保留名拒绝", async () => {
    const { controller } = setup();
    await controller.createProfile({ displayName: "My Group", source: { kind: "blank" } });
    await expect(
      controller.createProfile({ displayName: "my group", source: { kind: "blank" } }),
    ).rejects.toThrowError(/已存在/);
    await expect(
      controller.createProfile({ displayName: "Devolve", source: { kind: "blank" } }),
    ).rejects.toThrowError(/保留名/);
    await expect(
      controller.createProfile({ displayName: "   ", source: { kind: "blank" } }),
    ).rejects.toThrowError(/不能为空/);
  });

  it("当前使用组不能删除；stale revision 拒绝；未知目录权限拒绝", async () => {
    const { controller } = setup();
    const created = await controller.createProfile({
      displayName: "组 A",
      source: { kind: "blank" },
    });
    await expect(
      controller.deleteProfile({
        permissionProfileId: created.permissionProfileId,
        isCurrentlyActive: true,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    await expect(
      controller.updateCapabilityDecision({
        permissionProfileId: created.permissionProfileId,
        capabilityId: "project.read",
        decision: "allow",
        expectedRevision: 99,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    await expect(
      controller.updateCapabilityDecision({
        permissionProfileId: created.permissionProfileId,
        capabilityId: "no-such-capability",
        decision: "allow",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
  });

  it("导出只含可配置字段；导入过滤未知权限与非法决定", async () => {
    const { controller, store } = setup();
    const created = await controller.createProfile({
      displayName: "导出组",
      source: { kind: "builtin", profileId: "assist" },
    });
    await controller.updateCapabilityDecision({
      permissionProfileId: created.permissionProfileId,
      capabilityId: "project.read",
      decision: "ask",
      expectedRevision: 1,
    });
    const exported = await controller.exportProfile({
      kind: "custom",
      profileId: created.permissionProfileId,
    });
    expect(exported.exportedDocument["capabilityDecisions"]).toBeDefined();
    expect(exported.exportedDocument["frozenSignature"]).toBeUndefined();
    expect(exported.exportedDocument["revision"]).toBeUndefined();
    // 导入（含未知权限与非法决定被过滤）
    const imported = await controller.importProfile({
      exportedDocument: {
        displayName: "导入组",
        capabilityDecisions: {
          "project.read": "allow",
          "no-such-capability": "allow",
          "project.create": "evil",
        },
      },
    });
    expect(imported.capabilityDecisions["project.read"]).toBe("allow");
    expect(imported.capabilityDecisions["no-such-capability"]).toBeUndefined();
    expect(imported.capabilityDecisions["project.create"]).toBeUndefined();
    // 内置 profile 也可导出
    const assistExport = await controller.exportProfile({ kind: "builtin", profileId: "assist" });
    expect(assistExport.exportedDocument["displayName"]).toBe("Assist");
    void store;
  });

  it("重置为创建源（保留 ID/名称，revision 单调）", async () => {
    const { controller } = makeController();
    const created = await controller.createProfile({
      displayName: "重置组",
      source: { kind: "builtin", profileId: "devolve" },
    });
    await controller.updateCapabilityDecision({
      permissionProfileId: created.permissionProfileId,
      capabilityId: "project.read",
      decision: "deny",
      expectedRevision: 1,
    });
    const reset = await controller.resetProfile({
      permissionProfileId: created.permissionProfileId,
      source: { kind: "builtin", profileId: "devolve" },
      expectedRevision: 2,
    });
    expect(reset.permissionProfileId).toBe(created.permissionProfileId);
    expect(reset.capabilityDecisions["project.read"]).toBe("allow");
    expect(reset.revision).toBe(3);
  });

  it("导入非法内容（缺字段/坏 displayName）拒绝；导出内置组", async () => {
    const { controller } = makeController();
    await expect(
      controller.importProfile({ exportedDocument: { capabilityDecisions: {} } }),
    ).rejects.toThrowError(/导入内容非法/);
    await expect(
      controller.importProfile({
        exportedDocument: { displayName: "  ", capabilityDecisions: {} },
      }),
    ).rejects.toThrowError(/导入内容非法/);
    const devolveExport = await controller.exportProfile({
      kind: "builtin",
      profileId: "devolve",
    });
    expect(
      Object.values(
        devolveExport.exportedDocument["capabilityDecisions"] as Record<string, string>,
      ).every((decision) => decision === "allow"),
    ).toBe(true);
  });

  it("无产品数量上限：连续创建 50 个自定义组（实现无计数分支）", async () => {
    const { controller } = setup();
    for (let index = 0; index < 50; index++) {
      await controller.createProfile({
        displayName: `组-${index}`,
        source: { kind: "blank" },
      });
    }
    expect((await controller["store"].listCustomProfileIds()).length).toBe(50);
  }, 20_000);
});

describe("ConfigurablePermissionPolicyEngine", () => {
  function setup() {
    return makeStore();
  }

  it("未映射工具 → deny（操作不可用，无规则类别泄露）", async () => {
    const { catalog, store } = setup();
    const engine = new ConfigurablePermissionPolicyEngine({ catalog, profileStore: store });
    const decision = await engine.decide({
      toolName: "mysteryTool",
      profileReference: { kind: "builtin", profileId: "devolve" },
      argumentsJson: "{}",
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("操作不可用");
    }
  });

  it("Devolve 全 allow：readFile 直接允许；Assist 下 destructive 拒绝", async () => {
    const { catalog, store } = setup();
    const engine = new ConfigurablePermissionPolicyEngine({ catalog, profileStore: store });
    const devolveAllow = await engine.decide({
      toolName: "readFile",
      profileReference: { kind: "builtin", profileId: "devolve" },
      argumentsJson: '{"filePath":"a.txt"}',
    });
    expect(devolveAllow.decision).toBe("allow");
    const assistDeny = await engine.decide({
      toolName: "replaceFileContent",
      profileReference: { kind: "builtin", profileId: "assist" },
      argumentsJson: '{"filePath":"a.txt","content":"x"}',
    });
    expect(assistDeny.decision).toBe("deny");
  });

  it("ask 授权绑定 profile revision 与参数哈希；revision/参数变化后失效", async () => {
    const { catalog, store } = setup();
    let clockSeconds = 1_000_000;
    const engine = new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore: store,
      nowUnixSeconds: () => clockSeconds,
      authorizationTtlSeconds: 300,
    });
    const reference = { kind: "builtin", profileId: "assist" } as const;
    const before = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    expect(before.decision).toBe("ask");
    // 用户授权（绑定 assist revision=1）
    await engine.grantSessionAuthorization({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    const afterGrant = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    expect(afterGrant.decision).toBe("allow");
    // 参数变化 → 授权失效
    const drifted = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"b.txt","content":"x"}',
    });
    expect(drifted.decision).toBe("ask");
    // 授权过期 → 失效
    await engine.grantSessionAuthorization({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"b.txt","content":"x"}',
    });
    clockSeconds += 400;
    const expired = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"b.txt","content":"x"}',
    });
    expect(expired.decision).toBe("ask");
  });

  it("内置↔自定义 profile 切换后旧授权失效", async () => {
    const { catalog, store, controller } = makeController();
    const assistEngine = new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore: store,
      nowUnixSeconds: () => 1_000_000,
    });
    const assistReference = { kind: "builtin", profileId: "assist" } as const;
    await assistEngine.grantSessionAuthorization({
      toolName: "writeFileTemporary",
      profileReference: assistReference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    // 切换到自定义组（同样 ask 权限）→ 授权不沿用
    const profile = await controller.createProfile({
      displayName: "切换组",
      source: { kind: "builtin", profileId: "assist" },
    });
    const customReference = {
      kind: "custom",
      profileId: profile.permissionProfileId,
    } as const;
    const decision = await assistEngine.decide({
      toolName: "writeFileTemporary",
      profileReference: customReference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    expect(decision.decision).toBe("ask");
  });

  it("自定义组 ask 授权在 profile revision 变化后失效", async () => {
    const { catalog, store, controller } = makeController();
    const profile = await controller.createProfile({
      displayName: "需询问组",
      source: { kind: "blank" },
    });
    await controller.updateCapabilityDecision({
      permissionProfileId: profile.permissionProfileId,
      capabilityId: "project.create",
      decision: "ask",
      expectedRevision: 1,
    });
    const engine = new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore: store,
      nowUnixSeconds: () => 1_000_000,
    });
    const reference = { kind: "custom", profileId: profile.permissionProfileId } as const;
    await engine.grantSessionAuthorization({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    // profile revision 变化（更新另一项）→ 授权失效
    await controller.updateCapabilityDecision({
      permissionProfileId: profile.permissionProfileId,
      capabilityId: "project.modify",
      decision: "ask",
      expectedRevision: 2,
    });
    const decision = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"a.txt","content":"x"}',
    });
    expect(decision.decision).toBe("ask");
  });
});

describe("ToolRegistry × 目录校验", () => {
  it("未映射工具拒绝注册；内置工具正常注册", () => {
    const registry = new ToolRegistry(new PermissionCapabilityCatalog());
    expect(() => registry.register(makeToolDescriptor("readFile"))).not.toThrow();
    expect(() => registry.register(makeToolDescriptor("mysteryTool"))).toThrowError(
      /未映射任何可配置权限/,
    );
  });
});
