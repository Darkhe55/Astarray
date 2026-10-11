/**
 * B6R-10 反例（2026-10-10）：`session-shutdown-and-export` 的**记录有效性契约**。
 *
 * 卡内 B6R-10 要求"单模块覆盖率 ≥95%"；`B6R10_FINAL_ACCEPTANCE.md` 当时记录
 * 该模块 ~82%（余"个体资源范围不匹配等"）。**本轮实测复测为 91.30%（21/23，余 L148/L149）**，
 * 即卡内数字过期，但**确实仍有缺口**。
 *
 * 缺口定位：`isRecordStillValid()` 中
 * ```
 * if (record.baseProfileReference.kind !== input.currentProfileReference.kind) return false;
 * if (record.baseProfileReference.kind === "custom") {
 *   if (input.currentProfileReference.kind !== "custom" || ...) return false;
 *   //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 这一半**恒为 false**（上一行已保证 kind 相等）
 * }
 * ```
 * ⇒ `input.currentProfileReference.kind !== "custom"` 是**不可达分支**。
 *
 * 本片以**行为**方式钉住该函数的真实契约（而不是为覆盖率而覆盖率）：
 *  - 提升记录**绑定基础 profile 的身份（kind + profileId）与 revision**；
 *    任一不符 ⇒ 记录**失效**，导出结果**不得**包含该覆盖；
 *  - `custom` 类型下，**profileId 不同**必须失效（即使 kind 相同）；
 *  - 失效时**如实回退**到基础 profile 的决定，而不是保留已失效的提升。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CurrentPermissionConfigurationExporter } from "../../../packages/core/src/tools/session-shutdown-and-export.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationStore,
  type SessionPermissionElevationRecord,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import type { PermissionProfileReference } from "../../../packages/core/src/tools/permission-profile-store.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r10-shutdown-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildBaseProfile() {
  const catalog = new PermissionCapabilityCatalog();
  const profileStore = new PermissionProfileStore({
    baseDirectory: temporaryDirectory,
    catalog,
  });
  const assistProfile = profileStore.buildBuiltinProfile("assist");
  return {
    ...assistProfile,
    capabilityDecisions: {
      ...assistProfile.capabilityDecisions,
      // 基线 deny ⇒ 只有"记录仍有效"时才会被提升为 allow，便于区分
      "filesystem-read": "deny" as const,
    },
  };
}

function buildElevationRecord(
  overrides: Partial<SessionPermissionElevationRecord> = {},
): SessionPermissionElevationRecord {
  return {
    elevationId: "elevation-1",
    sessionId: "session-1",
    scope: { scope: "specific-secondary-agent", agentInstanceId: "secondary-1" },
    capabilityId: "filesystem-read",
    resourceScope: "workspace",
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

async function exportWithRecord(input: {
  record: SessionPermissionElevationRecord;
  baseProfile: ReturnType<typeof buildBaseProfile>;
  currentProfileReference: PermissionProfileReference;
}) {
  const store = new SessionPermissionElevationStore();
  await store.addRecord(input.record);
  const exporter = new CurrentPermissionConfigurationExporter();
  return await exporter.exportEffectiveConfiguration({
    sessionId: "session-1",
    agentInstanceId: "secondary-1",
    baseProfile: input.baseProfile,
    currentProfileReference: input.currentProfileReference,
    elevationStore: store,
    resolver: new EffectiveSecondaryPermissionResolver(),
    nowUnixMilliseconds: Date.now(),
    isAgentRetired: () => false,
    currentSessionPermissionRevision: 7,
  });
}

describe("B6R-10：提升记录的有效性必须绑定基础 profile 身份", () => {
  it("① 基线一致（kind+profileId+revision 均匹配）⇒ 覆盖生效", async () => {
    const baseProfile = buildBaseProfile();
    const snapshot = await exportWithRecord({
      record: buildElevationRecord({
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
      }),
      baseProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
    });
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("allow");
  });

  it("② **kind 不同** ⇒ 记录失效（不得把 builtin 记录套用到 custom 会话）", async () => {
    const baseProfile = buildBaseProfile();
    const snapshot = await exportWithRecord({
      record: buildElevationRecord({
        baseProfileReference: { kind: "builtin", profileId: "assist" },
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
      }),
      baseProfile,
      currentProfileReference: { kind: "custom", profileId: "my-mode" },
    });
    // 失效 ⇒ 回退基础 profile 的 deny
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("deny");
  });

  it("③ **custom 且 profileId 不同** ⇒ 记录失效（kind 相同不足以保证同一 profile）", async () => {
    const baseProfile = buildBaseProfile();
    const snapshot = await exportWithRecord({
      record: buildElevationRecord({
        baseProfileReference: { kind: "custom", profileId: "mode-a" },
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
      }),
      baseProfile,
      currentProfileReference: { kind: "custom", profileId: "mode-b" },
    });
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("deny");
  });

  it("④ custom 且 profileId **相同** ⇒ 覆盖生效（不得因 custom 就一律失效）", async () => {
    const baseProfile = buildBaseProfile();
    const snapshot = await exportWithRecord({
      record: buildElevationRecord({
        baseProfileReference: { kind: "custom", profileId: "mode-a" },
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
      }),
      baseProfile,
      currentProfileReference: { kind: "custom", profileId: "mode-a" },
    });
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("allow");
  });

  it("⑤ revision 不匹配 ⇒ 记录失效（旧 revision 的批准必须复检）", async () => {
    const baseProfile = buildBaseProfile();
    const snapshot = await exportWithRecord({
      record: buildElevationRecord({
        baseProfileRevision: baseProfile.revision + 99,
        catalogVersion: baseProfile.catalogVersion,
      }),
      baseProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
    });
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("deny");
  });

  it("⑥ 会话权限 revision 不匹配 ⇒ 记录失效（B6R-05 同源快照）", async () => {
    const baseProfile = buildBaseProfile();
    const store = new SessionPermissionElevationStore();
    await store.addRecord(
      buildElevationRecord({
        baseProfileRevision: baseProfile.revision,
        catalogVersion: baseProfile.catalogVersion,
        sessionPermissionRevision: 7,
      }),
    );
    const snapshot = await new CurrentPermissionConfigurationExporter().exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: "secondary-1",
      baseProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore: store,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: Date.now(),
      isAgentRetired: () => false,
      // 会话权限已前进 ⇒ 旧批准失效
      currentSessionPermissionRevision: 8,
    });
    expect(snapshot.capabilityDecisions["filesystem-read"]).toBe("deny");
  });
});
