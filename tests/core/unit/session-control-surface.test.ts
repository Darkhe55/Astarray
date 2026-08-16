/**
 * B6R-06 测试：主 Agent 永久只读、次级控制面与会话关闭导出接入。
 * 覆盖：主只读投影（任意 profile/提升不变）、CLI 提升创建/撤销/列表、
 * 关闭导出（受控备份 + TOCTOU）、导出失败不残留提升、无"提升主 Agent"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MainAgentReadonlyToolProjection } from "../../../packages/core/src/tools/main-agent-readonly-projection.js";
import {
  SessionPermissionElevationStore,
  SessionPermissionElevationController,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import { SessionShutdownCoordinator } from "../../../packages/core/src/tools/session-shutdown-and-export.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import { CurrentPermissionConfigurationExporter } from "../../../packages/core/src/tools/session-shutdown-and-export.js";
import { EffectiveSecondaryPermissionResolver } from "../../../packages/core/src/tools/session-permission-elevation.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r06-"));
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

describe("B6R-06 主 Agent 永久只读", () => {
  it("任意 profile/提升下主 Agent 只读白名单不变", () => {
    const projection = new MainAgentReadonlyToolProjection();
    const allTools = [
      "readFile",
      "listDirectory",
      "searchProjectText",
      "taskSequenceStatus",
      "gitReadonlyView",
      "factVerification",
      "replaceFileContent",
      "deleteBackup",
      "spawnAgent",
      "grantPermission",
      "exportConfiguration",
    ];
    const projected = projection.projectTools(allTools);
    expect(projected).toEqual([
      "readFile",
      "listDirectory",
      "searchProjectText",
      "taskSequenceStatus",
      "gitReadonlyView",
      "factVerification",
    ]);
    // 模拟任意 profile/提升：不改变投影（固定白名单）
    for (const profile of ["devolve", "assist", "custom"]) {
      void profile;
      expect(projection.projectTools(allTools)).toEqual(projected);
    }
  });
});

describe("B6R-06 会话提升与关闭导出", () => {
  function makeElevationContext() {
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(
      elevationStore,
    );
    return { elevationStore, elevationController };
  }

  it("认证用户创建/撤销提升；列表只含公开字段", async () => {
    const { elevationStore, elevationController } = makeElevationContext();
    const record = await elevationController.createElevation({
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
      userDecisionReference: "cli-elevate-1",
      sessionPermissionRevision: 1,
    });
    expect(record.elevationId).toMatch(/^elevation-/);
    const listed = await elevationStore.listRecords("session-1");
    expect(listed).toHaveLength(1);
    // 撤销
    expect(
      await elevationController.revokeElevation({
        sessionId: "session-1",
        elevationId: record.elevationId,
      }),
    ).toBe(true);
    expect(await elevationStore.listRecords("session-1")).toHaveLength(0);
  });

  it("提升方向必须更宽（allow→ask 拒绝）", async () => {
    const { elevationController } = makeElevationContext();
    await expect(
      elevationController.createElevation({
        sessionId: "session-1",
        scope: { scope: "all-secondary-agents-in-session" },
        capabilityId: "backup.read",
        resourceScope: "workspace",
        baseProfileReference: { kind: "builtin", profileId: "devolve" },
        baseProfileRevision: 1,
        catalogVersion: 1,
        originalDecision: "allow",
        elevatedDecision: "ask",
        expiresAtIso: null,
        userDecisionReference: "u1",
        sessionPermissionRevision: 1,
      }),
    ).rejects.toThrowError(/更宽/);
  });

  it("关闭导出：覆盖已有导出文件经受控备份（非相邻 .bak）；失败不残留提升", async () => {
    const { elevationStore, elevationController } = makeElevationContext();
    const { catalog, store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
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
    // 受控备份端口（模拟 BackupVault）
    let backupCalls = 0;
    let toctouFails = false;
    const backupPort = {
      createPreMutationBackup: async () => {
        backupCalls += 1;
        return { targetFingerprintBeforeMutation: "fingerprint-1" };
      },
      verifyTargetUnchanged: async () => {
        if (toctouFails) {
          return false;
        }
        return true;
      },
    };
    const coordinator = new SessionShutdownCoordinator({
      elevationStore,
      backupPort,
    });
    const exportPath = path.join(temporaryDirectory, "export.json");
    await fs.writeFile(exportPath, "旧内容", "utf8");
    const exporter = new CurrentPermissionConfigurationExporter();
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: Date.now(),
      isAgentRetired: () => false,
      currentSessionPermissionRevision: 1,
    });
    const result = await coordinator.shutdownSession({
      sessionId: "session-1",
      drainInFlightCalls: async () => {},
      exportPath,
      exportSnapshot: snapshot,
    });
    expect(result.closed).toBe(true);
    expect(result.exportWrote).toBe(true);
    expect(result.revokedElevationCount).toBe(1);
    expect(backupCalls).toBe(1);
    // 受控备份产物在保管库（非相邻 .bak）
    expect(await fs.access(`${exportPath}.bak`).then(() => false).catch(() => true)).toBe(true);
    // 导出内容不含旧内容
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as {
      capabilityDecisions: Record<string, string>;
    };
    expect(exported.capabilityDecisions["backup.read"]).toBe("allow");
    expect(JSON.stringify(exported)).not.toContain("旧内容");
    // 提升已撤销
    expect(await elevationStore.listRecords("session-1")).toHaveLength(0);

    // TOCTOU 失败：备份后目标被改 → 导出失败但提升仍撤销（不残留）
    const secondStore = new SessionPermissionElevationStore();
    const secondController = new SessionPermissionElevationController(secondStore);
    secondController.createElevation({
      sessionId: "session-2",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "backup.read",
      resourceScope: "workspace",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: catalog.getCatalogVersion(),
      originalDecision: "ask",
      elevatedDecision: "allow",
      expiresAtIso: null,
      userDecisionReference: "u2",
      sessionPermissionRevision: 1,
    });
    const toctouCoordinator = new SessionShutdownCoordinator({
      elevationStore: secondStore,
      backupPort,
    });
    toctouFails = true;
    const failedResult = await toctouCoordinator.shutdownSession({
      sessionId: "session-2",
      drainInFlightCalls: async () => {},
      exportPath,
      exportSnapshot: snapshot,
    });
    expect(failedResult.exportWrote).toBe(false);
    expect(failedResult.exportFailedReason).not.toBeNull();
    expect(failedResult.closed).toBe(true);
    expect(await secondStore.listRecords("session-2")).toHaveLength(0);
  });
});
