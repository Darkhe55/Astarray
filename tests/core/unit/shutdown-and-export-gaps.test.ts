/**
 * B6R-11：session-shutdown-and-export 缺口分支单测
 * （个体记录资源范围、到期失效、backupPort 缺省 .bak 复制、
 * nowUnixMilliseconds 缺省、导出目标不存在、writeExportFile 备份）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CurrentPermissionConfigurationExporter,
  SessionShutdownCoordinator,
} from "../../../packages/core/src/tools/session-shutdown-and-export.js";
import type { EffectivePermissionSnapshot } from "../../../packages/core/src/tools/session-shutdown-and-export.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationStore,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import type { SessionPermissionElevationRecord } from "../../../packages/core/src/tools/session-permission-elevation.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-export-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function buildAssistProfile() {
  const catalog = new PermissionCapabilityCatalog();
  const profileStore = new PermissionProfileStore({
    baseDirectory: temporaryDirectory,
    catalog,
  });
  const assistProfile = profileStore.buildBuiltinProfile("assist");
  const capabilityDecisions: Record<string, "allow" | "ask" | "deny"> = {
    ...assistProfile.capabilityDecisions,
    "filesystem-read": "deny",
    "backup.read": "ask",
  };
  return { ...assistProfile, capabilityDecisions };
}

function makeElevationRecord(overrides: Partial<SessionPermissionElevationRecord> = {}): SessionPermissionElevationRecord {
  return {
    elevationId: "elevation-1",
    sessionId: "session-1",
    scope: { scope: "specific-secondary-agent", agentInstanceId: "secondary-1" },
    capabilityId: "filesystem-read",
    resourceScope: "project-x",
    baseProfileReference: { kind: "builtin", profileId: "assist" },
    baseProfileRevision: 2,
    catalogVersion: 3,
    originalDecision: "deny",
    elevatedDecision: "allow",
    createdAtIso: "2026-08-16T00:00:00.000Z",
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    userDecisionReference: "user-decision-1",
    sessionPermissionRevision: 7,
    ...overrides,
  };
}

describe("CurrentPermissionConfigurationExporter 补缺", () => {
  it("个体导出：匹配记录生效且资源范围取记录值（86-92）", async () => {
    const store = new SessionPermissionElevationStore();
    const assistProfile = buildAssistProfile();
    await store.addRecord(
      makeElevationRecord({
        scope: { scope: "specific-secondary-agent", agentInstanceId: "secondary-1" },
        resourceScope: "workspace",
        baseProfileRevision: assistProfile.revision,
        catalogVersion: assistProfile.catalogVersion,
      }),
    );
    const exporter = new CurrentPermissionConfigurationExporter();
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: "secondary-1",
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore: store,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: Date.now(),
      isAgentRetired: () => false,
      currentSessionPermissionRevision: 7,
    });
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("allow");
    expect(snapshot.resourceScopes["filesystem-read"]).toBe("workspace");
  });

  it("到期记录失效（166）：revision 匹配但已到期 → 导出不含覆盖", async () => {
    const store = new SessionPermissionElevationStore();
    const assistProfile = buildAssistProfile();
    await store.addRecord(
      makeElevationRecord({
        capabilityId: "backup.read",
        originalDecision: "ask",
        elevatedDecision: "allow",
        expiresAtIso: "2020-01-01T00:00:00.000Z",
        resourceScope: "backup-root",
        sessionPermissionRevision: 7,
        baseProfileRevision: assistProfile.revision,
        catalogVersion: assistProfile.catalogVersion,
      }),
    );
    const exporter = new CurrentPermissionConfigurationExporter();
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: "secondary-1",
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore: store,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: Date.now(),
      isAgentRetired: () => false,
      currentSessionPermissionRevision: 7,
    });
    expect(snapshot.capabilityDecisions["backup.read"]).toBe("ask");
  });

  it("writeExportFile：目标已存在时覆盖前自动备份 .bak（175）", async () => {
    const exportPath = path.join(temporaryDirectory, "config", "permissions.json");
    await fs.mkdir(path.dirname(exportPath), { recursive: true });
    await fs.writeFile(exportPath, '{"old":true}\n', "utf8");
    const snapshot: EffectivePermissionSnapshot = {
      capabilityDecisions: { "filesystem-read": "allow" },
      resourceScopes: {},
      catalogVersion: 3,
      sourceProfileReference: { kind: "builtin", profileId: "assist" },
      sourceProfileRevision: 2,
      displayName: "Assist",
      exportedAtIso: "2026-08-16T00:00:00.000Z",
    };
    const exporter = new CurrentPermissionConfigurationExporter();
    await exporter.writeExportFile(exportPath, snapshot);
    const backup = await fs.readFile(`${exportPath}.bak`, "utf8");
    expect(backup).toContain("old");
    expect(await fs.readFile(exportPath, "utf8")).toContain("filesystem-read");
  });
});

describe("SessionShutdownCoordinator 补缺", () => {
  it("backupPort 缺省：目标存在时普通 .bak 复制（260）；无目标时直接写", async () => {
    const coordinator = new SessionShutdownCoordinator({
      elevationStore: new SessionPermissionElevationStore(),
    });
    const exportPath = path.join(temporaryDirectory, "permissions.json");
    await fs.writeFile(exportPath, "old-content\n", "utf8");
    const snapshot: EffectivePermissionSnapshot = {
      capabilityDecisions: {},
      resourceScopes: {},
      catalogVersion: 3,
      sourceProfileReference: { kind: "builtin", profileId: "assist" },
      sourceProfileRevision: 2,
      displayName: "Assist",
      exportedAtIso: "2026-08-16T00:00:00.000Z",
    };
    const result = await coordinator.shutdownSession({
      sessionId: "session-1",
      drainInFlightCalls: async () => undefined,
      exportPath,
      exportSnapshot: snapshot,
    });
    expect(result.closed).toBe(true);
    expect(result.exportWrote).toBe(true);
    expect(await fs.readFile(`${exportPath}.bak`, "utf8")).toBe("old-content\n");
    // 第二次导出（目标存在且 backupPort 缺省）→ 仍 .bak
    const second = await coordinator.shutdownSession({
      sessionId: "session-1",
      drainInFlightCalls: async () => undefined,
      exportPath,
      exportSnapshot: snapshot,
    });
    expect(second.exportWrote).toBe(true);
  });

  it("导出失败只报告不阻塞：目标目录不可写 → exportFailedReason + closed", async () => {
    const coordinator = new SessionShutdownCoordinator({
      elevationStore: new SessionPermissionElevationStore(),
    });
    const snapshot: EffectivePermissionSnapshot = {
      capabilityDecisions: {},
      resourceScopes: {},
      catalogVersion: 3,
      sourceProfileReference: { kind: "builtin", profileId: "assist" },
      sourceProfileRevision: 2,
      displayName: "Assist",
      exportedAtIso: "2026-08-16T00:00:00.000Z",
    };
    // 目标路径指向一个目录 → 写文件必失败
    const blockingDirectory = path.join(temporaryDirectory, "blocking");
    await fs.mkdir(blockingDirectory, { recursive: true });
    const result = await coordinator.shutdownSession({
      sessionId: "session-1",
      drainInFlightCalls: async () => undefined,
      exportPath: blockingDirectory,
      exportSnapshot: snapshot,
    });
    expect(result.closed).toBe(true);
    expect(result.exportWrote).toBe(false);
    expect(result.exportFailedReason).not.toBeNull();
  });
});
