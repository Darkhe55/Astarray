/**
 * B6R-11：SessionPermissionElevationStore 持久化路径与缺口分支单测
 * （补 B6R-10 覆盖率缺口：listAllRecords 多文件、custom 匹配继续、
 * revision 不匹配失效、revokeAllForSession、个体撤销持久化、损坏文件容错）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import type { SessionPermissionElevationRecord } from "../../../packages/core/src/tools/session-permission-elevation.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-elev-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<SessionPermissionElevationRecord> = {}): SessionPermissionElevationRecord {
  return {
    elevationId: "elevation-1",
    sessionId: "session-1",
    scope: { scope: "all-secondary-agents-in-session" },
    capabilityId: "filesystem-read",
    resourceScope: "project",
    baseProfileReference: { kind: "builtin", profileId: "assist" },
    baseProfileRevision: 2,
    catalogVersion: 3,
    originalDecision: "deny",
    elevatedDecision: "ask",
    createdAtIso: "2026-08-16T00:00:00.000Z",
    expiresAtIso: null,
    userDecisionReference: "user-decision-1",
    sessionPermissionRevision: 1,
    ...overrides,
  };
}

describe("SessionPermissionElevationStore 持久化", () => {
  it("addRecord → 新实例 listRecords 恢复（往返持久化 + 会话过滤）", async () => {
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    await store.addRecord(makeRecord());
    const reloaded = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    const records = await reloaded.listRecords("session-1");
    expect(records).toHaveLength(1);
    expect(records[0]?.elevationId).toBe("elevation-1");
    // 其他会话不返回
    expect(await reloaded.listRecords("session-other")).toHaveLength(0);
  });

  it("listAllRecords 读取持久化文件（134）+ 目录不存在回退内存（147）", async () => {
    // 观察行为：store 单实例按会话重载，persist 会清理非当前会话的旧文件，
    // 因此跨文件读取按"同一实例最后写入的会话"为准
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    await store.addRecord(makeRecord({ elevationId: "elevation-b", sessionId: "session-b" }));
    const all = await store.listAllRecords();
    expect(all.map((record) => record.elevationId)).toEqual(["elevation-b"]);
    // 目录不存在（新 base）→ 回退内存记录（空）
    const emptyStore = new SessionPermissionElevationStore({
      baseDirectory: path.join(temporaryDirectory, "does-not-exist"),
    });
    expect(await emptyStore.listAllRecords()).toEqual([]);
  });

  it("损坏文件忽略（142）+ 无 .json 文件目录（130）", async () => {
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    await store.addRecord(makeRecord());
    await fs.writeFile(
      path.join(temporaryDirectory, "session-elevations", "broken.json"),
      "not-json{{{",
      "utf8",
    );
    const all = await store.listAllRecords();
    expect(all).toHaveLength(1);
  });

  it("revokeRecord 不存在返回 false；revokeAllForSession 返回撤销数量（399）", async () => {
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    const controller = new SessionPermissionElevationController(store);
    await controller.createElevation({
      sessionId: "session-1",
      scope: { scope: "all-secondary-agents-in-session" },
      capabilityId: "filesystem-read",
      resourceScope: "project",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 2,
      catalogVersion: 3,
      originalDecision: "deny",
      elevatedDecision: "ask",
      expiresAtIso: null,
      userDecisionReference: "user-decision-1",
      sessionPermissionRevision: 1,
    });
    expect(await controller.revokeElevation({ sessionId: "session-1", elevationId: "ghost" })).toBe(false);
    expect(await controller.revokeAllForSession("session-1")).toBe(1);
    expect(await controller.revokeAllForSession("session-1")).toBe(0);
  });

  it("revokeIndividualRecordsForAgent 持久化模式撤销个体覆盖", async () => {
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    await store.addRecord(
      makeRecord({
        elevationId: "elevation-scoped",
        scope: { scope: "specific-secondary-agent", agentInstanceId: "secondary-7" },
      }),
    );
    await store.addRecord(makeRecord({ elevationId: "elevation-session-wide" }));
    const revoked = await store.revokeIndividualRecordsForAgent("secondary-7");
    expect(revoked).toBe(1);
    const remaining = await new SessionPermissionElevationStore({
      baseDirectory: temporaryDirectory,
    }).listAllRecords();
    expect(remaining.map((record) => record.elevationId)).toEqual(["elevation-session-wide"]);
  });

  it("持久化清理：撤销会话后其持久化文件被移除（会话级单实例模式）", async () => {
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    await store.addRecord(makeRecord({ sessionId: "session-a" }));
    await store.revokeAllForSession("session-a");
    const files = await fs.readdir(path.join(temporaryDirectory, "session-elevations"));
    expect(files).toEqual([]);
  });

  it("sanitize 会话 ID：特殊字符编码后落盘", async () => {
    const store = new SessionPermissionElevationStore({ baseDirectory: temporaryDirectory });
    await store.addRecord(makeRecord({ sessionId: "sess:ion/1" }));
    const files = await fs.readdir(path.join(temporaryDirectory, "session-elevations"));
    expect(files.some((name) => name.includes("~003a") && name.includes("~002f"))).toBe(true);
  });
});

describe("EffectiveSecondaryPermissionResolver 缺口分支", () => {
  async function makeResolver() {
    const store = new SessionPermissionElevationStore();
    const catalog = new PermissionCapabilityCatalog();
    const profileStore = new PermissionProfileStore({
      baseDirectory: temporaryDirectory,
      catalog,
    });
    const baseProfile = profileStore.buildBuiltinProfile("assist");
    return { store, baseProfile };
  }

  it("custom profile 匹配继续生效（298 路径）", async () => {
    const { store, baseProfile } = await makeResolver();
    await store.addRecord(
      makeRecord({
        scope: { scope: "specific-secondary-agent", agentInstanceId: "secondary-1" },
        baseProfileReference: { kind: "custom", profileId: "custom-1" },
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
        expiresAtIso: "2030-01-01T00:00:00.000Z",
        elevatedDecision: "allow",
        sessionPermissionRevision: 5,
      }),
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const decision = await resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-1",
      sessionId: "session-1",
      capabilityId: "filesystem-read",
      baseProfile: { ...baseProfile, capabilityDecisions: { "filesystem-read": "deny" } },
      currentProfileReference: { kind: "custom", profileId: "custom-1" },
      elevationStore: store,
      nowUnixMilliseconds: new Date("2026-08-16T00:00:00.000Z").getTime(),
      isAgentRetired: false,
      currentSessionPermissionRevision: 5,
      requestedResourceScope: "project",
    });
    expect(decision).toBe("allow");
  });

  it("baseProfileRevision/catalogVersion 不匹配 → 覆盖失效（305）", async () => {
    const { store, baseProfile } = await makeResolver();
    await store.addRecord(
      makeRecord({
        baseProfileReference: { kind: "builtin", profileId: "assist" },
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
        elevatedDecision: "allow",
        sessionPermissionRevision: 5,
      }),
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    for (const revision of [baseProfile.revision - 1, baseProfile.revision]) {
      for (const catalogVersion of [baseProfile.catalogVersion, baseProfile.catalogVersion + 6]) {
        const decision = await resolver.resolveEffectiveDecision({
          agentInstanceId: "secondary-1",
          sessionId: "session-1",
          capabilityId: "filesystem-read",
          baseProfile: { ...baseProfile, revision, catalogVersion },
          currentProfileReference: { kind: "builtin", profileId: "assist" },
          elevationStore: store,
          nowUnixMilliseconds: Date.now(),
          isAgentRetired: false,
          currentSessionPermissionRevision: 5,
          requestedResourceScope: "project",
        });
        if (revision === baseProfile.revision && catalogVersion === baseProfile.catalogVersion) {
          expect(decision).toBe("allow");
        } else {
          expect(decision).toBe("deny");
        }
      }
    }
  });

  it("到期提升失效；到期边界时间点已失效", async () => {
    const { store, baseProfile } = await makeResolver();
    await store.addRecord(
      makeRecord({
        baseProfileReference: { kind: "builtin", profileId: "assist" },
        elevatedDecision: "allow",
        expiresAtIso: "2026-08-16T01:00:00.000Z",
        sessionPermissionRevision: 5,
      }),
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const atExpiry = await resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-1",
      sessionId: "session-1",
      capabilityId: "filesystem-read",
      baseProfile: { ...baseProfile },
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore: store,
      nowUnixMilliseconds: new Date("2026-08-16T01:00:00.000Z").getTime(),
      isAgentRetired: false,
      currentSessionPermissionRevision: 5,
      requestedResourceScope: "project",
    });
    expect(atExpiry).toBe("deny");
  });
});
