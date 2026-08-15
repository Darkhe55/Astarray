/**
 * T06G 单测：主 Agent 永久只读、次级权限上限与会话临时提升（ADR-0021）。
 * 覆盖：主 Agent 只读投影（任意 profile/提升不变）、次级绑定不可复用、
 * 提升记录（方向校验/作用域/到期/撤销/个体隔离）、有效解析（profile/
 * revision/目录变化失效、Agent 回收撤销个体覆盖）、三级求交（不宽于次级）、
 * 导出（剥离内部字段）、关闭协调（收敛/导出失败不延长租约/无条件撤销）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MainAgentReadonlyToolProjection,
  SecondaryAgentSessionController,
} from "../../../packages/core/src/tools/main-agent-readonly-projection.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
  TertiaryPermissionDelegationGuard,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import type { SessionPermissionElevationRecord } from "../../../packages/core/src/tools/session-permission-elevation.js";
import {
  CurrentPermissionConfigurationExporter,
  SessionShutdownCoordinator,
} from "../../../packages/core/src/tools/session-shutdown-and-export.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import type { PermissionProfileDocument } from "../../../packages/core/src/tools/permission-profile-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06g-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeProfiles() {
  const catalog = new PermissionCapabilityCatalog();
  const store = new PermissionProfileStore({
    baseDirectory: temporaryDirectory,
    catalog,
  });
  return { catalog, store };
}

describe("MainAgentReadonlyToolProjection", () => {
  const projection = new MainAgentReadonlyToolProjection();

  it("主 Agent 只得到读取类白名单工具", () => {
    const allTools = [
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
    ];
    const projected = projection.projectTools(allTools);
    expect(projected).not.toContain("replaceFileContent");
    expect(projected).not.toContain("deleteBackup");
    expect(projected).toContain("readFile");
    expect(projected).toContain("factVerification");
  });

  it("任意 profile/提升下主 Agent 只读能力不变（无写入/管理/导出工具）", () => {
    for (const toolName of [
      "replaceFileContent",
      "deleteBackup",
      "spawnAgent",
      "grantPermission",
      "exportConfiguration",
      "installPackage",
    ]) {
      expect(projection.isMainAgentToolAllowed(toolName)).toBe(false);
    }
    expect(projection.isMainAgentToolAllowed("readFile")).toBe(true);
  });
});

describe("SecondaryAgentSessionController", () => {
  it("创建不可复用次级实例 ID 并绑定权限快照", () => {
    let counter = 0;
    const controller = new SecondaryAgentSessionController({
      generateAgentInstanceId: () => {
        counter += 1;
        return `secondary-instance-${counter}`;
      },
    });
    const binding = controller.createSecondaryAgentBinding({
      sessionId: "session-1",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
    });
    expect(binding.agentInstanceId).toBe("secondary-instance-1");
    expect(binding.sessionPermissionRevision).toBe(0);
    expect(binding.baseProfileReference).toEqual({
      kind: "builtin",
      profileId: "assist",
    });
    const second = controller.createSecondaryAgentBinding({
      sessionId: "session-1",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
    });
    expect(second.agentInstanceId).not.toBe(binding.agentInstanceId);
  });

  it("空实例 ID 拒绝（不可复用身份保障）", () => {
    const controller = new SecondaryAgentSessionController({
      generateAgentInstanceId: () => "",
    });
    expect(() =>
      controller.createSecondaryAgentBinding({
        sessionId: "session-1",
        baseProfileReference: { kind: "builtin", profileId: "devolve" },
        baseProfileRevision: 1,
        catalogVersion: 1,
      }),
    ).toThrowError(/不能为空/);
  });
});

describe("SessionPermissionElevation", () => {
  let clockMilliseconds: number;

  beforeEach(() => {
    clockMilliseconds = 1_000_000;
  });

  function makeElevation(input: Partial<SessionPermissionElevationRecord> = {}) {
    return {
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "project.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
      originalDecision: "deny",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "user-decision-1",
      sessionPermissionRevision: 1,
      ...input,
    } as SessionPermissionElevationRecord;
  }

  it("提升方向必须更宽（deny→ask/allow、ask→allow）", () => {
    const store = new SessionPermissionElevationStore();
    const controller = new SessionPermissionElevationController(store);
    const created = controller.createElevation(
      makeElevation({
        originalDecision: "deny",
        elevatedDecision: "allow",
      }),
    );
    expect(created.elevationId).toMatch(/^elevation-/);
    expect(created.originalDecision).toBe("deny");
    expect(created.elevatedDecision).toBe("allow");
    expect(() =>
      controller.createElevation(
        makeElevation({
          originalDecision: "allow",
          elevatedDecision: "deny",
        }),
      ),
    ).toThrowError(/更宽/);
    expect(() =>
      controller.createElevation(
        makeElevation({
          originalDecision: "ask",
          elevatedDecision: "ask",
        }),
      ),
    ).toThrowError(/更宽/);
  });

  it("会话级覆盖应用于全部现有及后续次级 Agent；个体覆盖隔离", async () => {
    const { store } = makeProfiles();
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const assistProfile = store.buildBuiltinProfile("assist");
    const reference = { kind: "builtin", profileId: "assist" } as const;
    // 会话级提升：backup.read deny → allow
    elevationController.createElevation(
      makeElevation({
        capabilityId: "backup.read",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }),
    );
    const effectiveAgentA = resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-a",
      sessionId: "session-1",
      capabilityId: "backup.read",
      baseProfile: assistProfile,
      currentProfileReference: reference,
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
    });
    expect(effectiveAgentA).toBe("allow");
    // 后续次级 Agent 同样生效
    const effectiveAgentB = resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-b",
      sessionId: "session-1",
      capabilityId: "backup.read",
      baseProfile: assistProfile,
      currentProfileReference: reference,
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
    });
    expect(effectiveAgentB).toBe("allow");
    // 个体提升只影响指定 Agent（用需提升的能力：git.write-local ask → allow）
    elevationController.createElevation(
      makeElevation({
        scope: {
          scope: "specific-secondary-agent",
          agentInstanceId: "secondary-a",
        },
        capabilityId: "git.write-local",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }),
    );
    const agentAWrite = resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-a",
      sessionId: "session-1",
      capabilityId: "git.write-local",
      baseProfile: assistProfile,
      currentProfileReference: reference,
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
    });
    expect(agentAWrite).toBe("allow");
    const agentBWrite = resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-b",
      sessionId: "session-1",
      capabilityId: "git.write-local",
      baseProfile: assistProfile,
      currentProfileReference: reference,
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
    });
    expect(agentBWrite).toBe("ask");
  });

  it("到期/profile revision/目录版本变化/Agent 回收使覆盖失效", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const reference = { kind: "builtin", profileId: "assist" } as const;
    elevationController.createElevation(
      makeElevation({
        capabilityId: "git.remote-write",
        originalDecision: "deny",
        elevatedDecision: "allow",
        expiresAtIso: new Date(clockMilliseconds + 60_000).toISOString(),
      }),
    );
    // 未到期生效
    expect(
      resolver.resolveEffectiveDecision({
        agentInstanceId: "secondary-a",
        sessionId: "session-1",
        capabilityId: "git.remote-write",
        baseProfile: assistProfile,
        currentProfileReference: reference,
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: false,
      }),
    ).toBe("allow");
    // 到期后失效
    clockMilliseconds += 120_000;
    expect(
      resolver.resolveEffectiveDecision({
        agentInstanceId: "secondary-a",
        sessionId: "session-1",
        capabilityId: "git.remote-write",
        baseProfile: assistProfile,
        currentProfileReference: reference,
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: false,
      }),
    ).toBe("deny");
    // 个体覆盖在 Agent 回收后失效
    elevationController.createElevation(
      makeElevation({
        elevationId: "elevation-individual",
        scope: {
          scope: "specific-secondary-agent",
          agentInstanceId: "secondary-retired",
        },
        capabilityId: "git.write-local",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }),
    );
    expect(
      resolver.resolveEffectiveDecision({
        agentInstanceId: "secondary-retired",
        sessionId: "session-1",
        capabilityId: "git.write-local",
        baseProfile: assistProfile,
        currentProfileReference: reference,
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: false,
      }),
    ).toBe("allow");
    expect(
      resolver.resolveEffectiveDecision({
        agentInstanceId: "secondary-retired",
        sessionId: "session-1",
        capabilityId: "git.write-local",
        baseProfile: assistProfile,
        currentProfileReference: reference,
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: true,
      }),
    ).toBe("ask");
  });

  it("撤销不存在/会话级批量撤销/个体回收撤销计数正确", () => {
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    const created = elevationController.createElevation(
      makeElevation({ capabilityId: "backup.read" }),
    );
    elevationController.createElevation(
      makeElevation({
        capabilityId: "git.write-local",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }),
    );
    elevationController.createElevation(
      makeElevation({
        scope: {
          scope: "specific-secondary-agent",
          agentInstanceId: "secondary-retired",
        },
        capabilityId: "project.create",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }),
    );
    // 撤销不存在的 ID
    expect(
      elevationController.revokeElevation({
        sessionId: "session-1",
        elevationId: "no-such-elevation",
      }),
    ).toBe(false);
    // 个体回收撤销个体覆盖
    expect(
      elevationStore.revokeIndividualRecordsForAgent("secondary-retired"),
    ).toBe(1);
    // 会话关闭批量撤销
    expect(elevationStore.revokeAllForSession("session-1")).toBe(2);
    expect(elevationStore.listRecords("session-1")).toHaveLength(0);
    expect(elevationStore.listAllRecords()).toHaveLength(0);
    void created;
  });

  it("自定义 profile 引用的提升在 profile 切换后失效", async () => {
    const { catalog, store } = makeProfiles();
    const customProfile = await (async () => {
      const { CustomPermissionProfileController } = await import(
        "../../../packages/core/src/tools/custom-permission-profile-controller.js"
      );
      const controller = new CustomPermissionProfileController(store, catalog);
      return controller.createProfile({
        displayName: "自定义组",
        source: { kind: "blank" },
      });
    })();
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const reference = {
      kind: "custom",
      profileId: customProfile.permissionProfileId,
    } as const;
    elevationController.createElevation(
      makeElevation({
        baseProfileReference: reference,
        capabilityId: "backup.read",
        originalDecision: "deny",
        elevatedDecision: "allow",
        sessionPermissionRevision: 1,
      }),
    );
    const effective = resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-a",
      sessionId: "session-1",
      capabilityId: "backup.read",
      baseProfile: customProfile,
      currentProfileReference: reference,
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
    });
    expect(effective).toBe("allow");
    // 切换到内置 profile → 提升失效（custom 引用不匹配）
    const assistProfile = store.buildBuiltinProfile("assist");
    const switched = resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-a",
      sessionId: "session-1",
      capabilityId: "backup.read",
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
    });
    expect(switched).toBe("ask");
  });

  it("撤销提升后恢复基础决定", async () => {    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const created = elevationController.createElevation(
      makeElevation({
        capabilityId: "git.write-local",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }),
    );
    expect(
      resolver.resolveEffectiveDecision({
        agentInstanceId: "secondary-a",
        sessionId: "session-1",
        capabilityId: "git.write-local",
        baseProfile: assistProfile,
        currentProfileReference: { kind: "builtin", profileId: "assist" },
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: false,
      }),
    ).toBe("allow");
    expect(
      elevationController.revokeElevation({
        sessionId: "session-1",
        elevationId: created.elevationId,
      }),
    ).toBe(true);
    expect(
      resolver.resolveEffectiveDecision({
        agentInstanceId: "secondary-a",
        sessionId: "session-1",
        capabilityId: "git.write-local",
        baseProfile: assistProfile,
        currentProfileReference: { kind: "builtin", profileId: "assist" },
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: false,
      }),
    ).toBe("ask");
  });
});

describe("TertiaryPermissionDelegationGuard", () => {
  const guard = new TertiaryPermissionDelegationGuard();

  it("三级最终权限不得宽于次级有效权限（求交）", () => {
    expect(
      guard.computeDelegatedDecision({
        secondaryEffectiveDecision: "deny",
        requestedDelegatedDecision: "allow",
      }),
    ).toBe("deny");
    expect(
      guard.computeDelegatedDecision({
        secondaryEffectiveDecision: "ask",
        requestedDelegatedDecision: "allow",
      }),
    ).toBe("ask");
    expect(
      guard.computeDelegatedDecision({
        secondaryEffectiveDecision: "allow",
        requestedDelegatedDecision: "ask",
      }),
    ).toBe("ask");
    expect(() =>
      guard.assertDelegationAllowed({
        secondaryEffectiveDecision: "deny",
        requestedDelegatedDecision: "ask",
      }),
    ).toThrowError(/宽于次级/);
    expect(() =>
      guard.assertDelegationAllowed({
        secondaryEffectiveDecision: "allow",
        requestedDelegatedDecision: "allow",
      }),
    ).not.toThrow();
  });
});

describe("Exporter 与 ShutdownCoordinator", () => {
  it("导出剥离会话/Agent 身份与内部字段；只含公开决定", async () => {
    const { catalog, store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    elevationController.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: catalog.getCatalogVersion(),
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "user-decision-1",
      sessionPermissionRevision: 1,
    });
    const exporter = new CurrentPermissionConfigurationExporter();
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: 1_000_000,
      isAgentRetired: () => false,
    });
    expect(snapshot.capabilityDecisions["backup.read"]).toBe("allow");
    expect(snapshot.capabilityDecisions["git.remote-write"]).toBe("deny");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("session-1");
    expect(serialized).not.toContain("elevationId");
    expect(serialized).not.toContain("userDecisionReference");
    expect(serialized).not.toContain("expiresAtIso");
  });

  it("会话级导出在 profile 切换/revision 变化后覆盖失效", async () => {
    const { catalog, store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    elevationController.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: catalog.getCatalogVersion(),
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "u1",
      sessionPermissionRevision: 1,
    });
    const exporter = new CurrentPermissionConfigurationExporter();
    // profile 切换（自定义组 fallback deny）→ 覆盖失效
    const customProfile = await (async () => {
      const { CustomPermissionProfileController } = await import(
        "../../../packages/core/src/tools/custom-permission-profile-controller.js"
      );
      const controller = new CustomPermissionProfileController(store, catalog);
      return controller.createProfile({
        displayName: "切换验证组",
        source: { kind: "blank" },
      });
    })();
    const switchedSnapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: customProfile,
      currentProfileReference: {
        kind: "custom",
        profileId: customProfile.permissionProfileId,
      },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: 1_000_000,
      isAgentRetired: () => false,
    });
    // 自定义组不包含 backup.read（提升绑定 assist，未扩散到其他 profile）
    expect(switchedSnapshot.capabilityDecisions["backup.read"]).toBeUndefined();
    // revision 变化（模拟 assist revision 2）→ 覆盖失效
    const bumpedProfile: PermissionProfileDocument = {
      ...assistProfile,
      revision: 2,
    };
    const bumpedSnapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: bumpedProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: 1_000_000,
      isAgentRetired: () => false,
    });
    expect(bumpedSnapshot.capabilityDecisions["backup.read"]).toBe("ask");
  });

  it("custom 提升记录导出到 builtin profile 时失效（kind 不匹配）", async () => {
    const { catalog, store } = makeProfiles();
    const { CustomPermissionProfileController } = await import(
      "../../../packages/core/src/tools/custom-permission-profile-controller.js"
    );
    const customController = new CustomPermissionProfileController(store, catalog);
    const customProfile = await customController.createProfile({
      displayName: "custom 导出组",
      source: { kind: "builtin", profileId: "devolve" },
    });
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    elevationController.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.delete",
      resourceScope: "workspace",
      baseProfileReference: {
        kind: "custom",
        profileId: customProfile.permissionProfileId,
      },
      baseProfileRevision: 1,
      catalogVersion: catalog.getCatalogVersion(),
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "u1",
      sessionPermissionRevision: 1,
    });
    const exporter = new CurrentPermissionConfigurationExporter();
    // 导出到 builtin assist：custom 提升记录不匹配 → 失效（assist backup.delete = ask）
    const assistProfile = store.buildBuiltinProfile("assist");
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: 1_000_000,
      isAgentRetired: () => false,
    });
    expect(snapshot.capabilityDecisions["backup.delete"]).toBe("ask");
  });

  it("custom 提升记录绑定 A，导出 profile B（不同 custom ID）→ 失效", async () => {
    const { catalog, store } = makeProfiles();
    const { CustomPermissionProfileController } = await import(
      "../../../packages/core/src/tools/custom-permission-profile-controller.js"
    );
    const customController = new CustomPermissionProfileController(store, catalog);
    const profileA = await customController.createProfile({
      displayName: "组 A",
      source: { kind: "blank" },
    });
    const profileB = await customController.createProfile({
      displayName: "组 B",
      source: { kind: "blank" },
    });
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    elevationController.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.read",
      resourceScope: "workspace",
      baseProfileReference: {
        kind: "custom",
        profileId: profileA.permissionProfileId,
      },
      baseProfileRevision: 1,
      catalogVersion: catalog.getCatalogVersion(),
      originalDecision: "deny",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "u1",
      sessionPermissionRevision: 1,
    });
    const exporter = new CurrentPermissionConfigurationExporter();
    // 导出 profile B：提升记录绑定 A → 不匹配 → 覆盖不生效（B 无 backup.read）
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: profileB,
      currentProfileReference: {
        kind: "custom",
        profileId: profileB.permissionProfileId,
      },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: 1_000_000,
      isAgentRetired: () => false,
    });
    expect(snapshot.capabilityDecisions["backup.read"]).toBeUndefined();
  });

  it("写入导出文件覆盖前自动备份", async () => {
    const exporter = new CurrentPermissionConfigurationExporter();
    const filePath = path.join(temporaryDirectory, "export.json");
    const snapshot = {
      capabilityDecisions: {},
      resourceScopes: {},
      catalogVersion: 1,
      sourceProfileReference: { kind: "builtin", profileId: "assist" } as const,
      sourceProfileRevision: 1,
      displayName: "Assist",
      exportedAtIso: new Date().toISOString(),
    };
    await exporter.writeExportFile(filePath, snapshot);
    await exporter.writeExportFile(filePath, { ...snapshot, displayName: "Assist v2" });
    const backupContent = await fs.readFile(`${filePath}.bak`, "utf8");
    expect(backupContent).toContain('"displayName": "Assist"');
  });

  it("关闭会话：收敛在途调用 + 导出失败只报告 + 无条件撤销全部提升", async () => {
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    elevationController.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "u1",
      sessionPermissionRevision: 1,
    });
    const coordinator = new SessionShutdownCoordinator({ elevationStore });
    let drained = false;
    // 导出路径不可写（父目录被文件占用）→ 导出失败但会话仍关闭
    const blockingPath = path.join(temporaryDirectory, "blocker");
    await fs.writeFile(blockingPath, "x", "utf8");
    const result = await coordinator.shutdownSession({
      sessionId: "session-1",
      drainInFlightCalls: async () => {
        drained = true;
      },
      exportPath: path.join(blockingPath, "export.json"),
      exportSnapshot: {
        capabilityDecisions: {},
        resourceScopes: {},
        catalogVersion: 1,
        sourceProfileReference: { kind: "builtin", profileId: "assist" } as const,
        sourceProfileRevision: 1,
        displayName: "Assist",
        exportedAtIso: new Date().toISOString(),
      },
    });
    expect(drained).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.exportWrote).toBe(false);
    expect(result.exportFailedReason).not.toBeNull();
    expect(result.revokedElevationCount).toBe(1);
    expect(elevationStore.listRecords("session-1")).toHaveLength(0);
  });

  it("关闭会话成功导出时撤销全部提升", async () => {
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    elevationController.createElevation({
      sessionId: "session-2",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "u1",
      sessionPermissionRevision: 1,
    });
    const coordinator = new SessionShutdownCoordinator({ elevationStore });
    const exportPath = path.join(temporaryDirectory, "export2.json");
    const result = await coordinator.shutdownSession({
      sessionId: "session-2",
      drainInFlightCalls: async () => {},
      exportPath,
      exportSnapshot: {
        capabilityDecisions: { "backup.read": "allow" },
        resourceScopes: { "backup.read": "workspace" },
        catalogVersion: 1,
        sourceProfileReference: { kind: "builtin", profileId: "assist" } as const,
        sourceProfileRevision: 1,
        displayName: "Assist",
        exportedAtIso: new Date().toISOString(),
      },
    });
    expect(result.closed).toBe(true);
    expect(result.exportWrote).toBe(true);
    expect(result.revokedElevationCount).toBe(1);
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as {
      capabilityDecisions: Record<string, string>;
    };
    expect(exported.capabilityDecisions["backup.read"]).toBe("allow");
  });
});
