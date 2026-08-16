/**
 * B6R-05 测试：T06G 临时提升有效性与权限求交（先红后绿）。
 * - 失败反例：会话权限 revision 变化、资源范围不匹配、期限越界后旧提升
 *   仍生效（resolver 不校验）；
 * - 接入后：resolver 输入含 session permission revision/规范化资源身份/
 *   具体 agentInstanceId；三级求交覆盖三态/资源范围/期限；属性测试
 *   tertiary <= secondary；导出与运行时同源解析。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import type { PermissionProfileDocument } from "../../../packages/core/src/tools/permission-profile-store.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
  TertiaryPermissionDelegationGuard,
} from "../../../packages/core/src/tools/session-permission-elevation.js";
import { CurrentPermissionConfigurationExporter } from "../../../packages/core/src/tools/session-shutdown-and-export.js";

let temporaryDirectory: string;
let clockMilliseconds: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r05-"));
  clockMilliseconds = 1_000_000;
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

function makeElevationInput(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe("B6R-05 失败反例（先红）", () => {
  it("会话权限 revision 变化后旧提升仍生效（应失效）", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(elevationStore);
    const resolver = new EffectiveSecondaryPermissionResolver();
    elevationController.createElevation(
      makeElevationInput() as never,
    );
    // 会话权限 revision 变化（新提升/撤销后 revision=2）→ 旧提升（revision=1）应失效
    const result = await resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-a",
      sessionId: "session-1",
      capabilityId: "backup.read",
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
      currentSessionPermissionRevision: 2,
      requestedResourceScope: "workspace",
    });
    // 会话权限 revision=2 → 旧提升（revision=1 快照）失效 → 基础 ask
    expect(result).toBe("ask");
  });

  it("资源范围不匹配的旧提升仍生效（应失效）", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(elevationStore);
    const resolver = new EffectiveSecondaryPermissionResolver();
    elevationController.createElevation(
      makeElevationInput({ resourceScope: "database-a" }) as never,
    );
    const result = await resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-a",
      sessionId: "session-1",
      capabilityId: "backup.read",
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
      currentSessionPermissionRevision: 1,
      requestedResourceScope: "database-b",
    });
    expect(result).toBe("ask"); // 占位：接入后应为基础 ask（范围不匹配）
  });
});

describe("B6R-05 接入后（先红后绿）", () => {
  function makeResolverContext(
    elevationStore: SessionPermissionElevationStore,
    assistProfile: PermissionProfileDocument,
  ) {
    return {
      resolver: new EffectiveSecondaryPermissionResolver(),
      baseInput: {
        agentInstanceId: "secondary-a",
        sessionId: "session-1",
        baseProfile: assistProfile,
        currentProfileReference: { kind: "builtin" as const, profileId: "assist" as const },
        elevationStore,
        nowUnixMilliseconds: clockMilliseconds,
        isAgentRetired: false,
      },
    };
  }

  it("会话 revision 变化 → 旧提升失效；新提升（新 revision）生效", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(elevationStore);
    const { resolver, baseInput } = makeResolverContext(elevationStore, assistProfile);
    elevationController.createElevation(
      makeElevationInput({ sessionPermissionRevision: 1 }) as never,
    );
    // revision=1 时生效
    expect(
      await resolver.resolveEffectiveDecision({
        ...baseInput,
        capabilityId: "backup.read",
        currentSessionPermissionRevision: 1,
        requestedResourceScope: "workspace",
      }),
    ).toBe("allow");
    // 会话 revision=2（新提升）→ 旧记录失效 → 基础 ask
    expect(
      await resolver.resolveEffectiveDecision({
        ...baseInput,
        capabilityId: "backup.read",
        currentSessionPermissionRevision: 2,
        requestedResourceScope: "workspace",
      }),
    ).toBe("ask");
    // 新提升（revision=2）生效
    elevationController.createElevation(
      makeElevationInput({
        sessionPermissionRevision: 2,
        capabilityId: "backup.read",
      }) as never,
    );
    expect(
      await resolver.resolveEffectiveDecision({
        ...baseInput,
        capabilityId: "backup.read",
        currentSessionPermissionRevision: 2,
        requestedResourceScope: "workspace",
      }),
    ).toBe("allow");
  });

  it("资源范围不匹配 → 提升不应用；匹配 → 生效", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(elevationStore);
    const { resolver, baseInput } = makeResolverContext(elevationStore, assistProfile);
    elevationController.createElevation(
      makeElevationInput({ resourceScope: "database-a" }) as never,
    );
    expect(
      await resolver.resolveEffectiveDecision({
        ...baseInput,
        capabilityId: "backup.read",
        currentSessionPermissionRevision: 1,
        requestedResourceScope: "database-b",
      }),
    ).toBe("ask");
    expect(
      await resolver.resolveEffectiveDecision({
        ...baseInput,
        capabilityId: "backup.read",
        currentSessionPermissionRevision: 1,
        requestedResourceScope: "database-a",
      }),
    ).toBe("allow");
  });

  it("个体提升不传播到其他次级 Agent（隔离）", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(elevationStore);
    elevationController.createElevation(
      makeElevationInput({
        scope: { scope: "specific-secondary-agent", agentInstanceId: "secondary-a" },
        capabilityId: "git.write-local",
        originalDecision: "ask",
        elevatedDecision: "allow",
      }) as never,
    );
    const resolver = new EffectiveSecondaryPermissionResolver();
    const resultForB = await resolver.resolveEffectiveDecision({
      agentInstanceId: "secondary-b",
      sessionId: "session-1",
      capabilityId: "git.write-local",
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: false,
      currentSessionPermissionRevision: 1,
      requestedResourceScope: "workspace",
    });
    expect(resultForB).toBe("ask");
  });

  it("三级权限逐项求交：三态/资源范围/期限均不得宽于次级", async () => {
    const guard = new TertiaryPermissionDelegationGuard();
    // 三态求交
    expect(
      guard.computeDelegatedDecision({
        secondaryEffectiveDecision: "ask",
        requestedDelegatedDecision: "allow",
      }),
    ).toBe("ask");
    // 资源范围求交：次级仅 database-a → 三级请求 database-b 拒绝
    const delegatedScope = guard.computeDelegatedResourceScope({
      secondaryAllowedResourceScopes: ["database-a"],
      requestedResourceScopes: ["database-a", "database-b"],
    });
    expect(delegatedScope).toEqual(["database-a"]);
    // 期限求交：三级请求期限不得晚于次级有效期限
    const secondaryExpiry = new Date(clockMilliseconds + 60_000).toISOString();
    const requestedExpiry = new Date(clockMilliseconds + 120_000).toISOString();
    const delegatedExpiry = guard.computeDelegatedExpiry({
      secondaryExpiresAtIso: secondaryExpiry,
      requestedExpiresAtIso: requestedExpiry,
    });
    expect(delegatedExpiry).toBe(secondaryExpiry);
  });

  it("属性测试：随机组合下 tertiary <= secondary（宽度单调）", () => {
    const guard = new TertiaryPermissionDelegationGuard();
    const decisions = ["deny", "ask", "allow"] as const;
    const width: Record<string, number> = { deny: 0, ask: 1, allow: 2 };
    for (let iteration = 0; iteration < 500; iteration++) {
      const secondary = decisions[Math.floor(Math.random() * 3)]!;
      const requested = decisions[Math.floor(Math.random() * 3)]!;
      const delegated = guard.computeDelegatedDecision({
        secondaryEffectiveDecision: secondary,
        requestedDelegatedDecision: requested,
      });
      expect(width[delegated]!).toBeLessThanOrEqual(width[secondary]!);
      expect(width[delegated]!).toBeLessThanOrEqual(width[requested]!);
    }
  });

  it("导出与运行时同源解析：过期/会话 revision 失效记录不出现在导出中", async () => {
    const { store } = makeProfiles();
    const assistProfile = store.buildBuiltinProfile("assist");
    const elevationStore = new SessionPermissionElevationStore();
    const elevationController = new SessionPermissionElevationController(elevationStore);
    // 过期记录
    elevationController.createElevation(
      makeElevationInput({
        sessionPermissionRevision: 1,
        expiresAtIso: new Date(clockMilliseconds - 1).toISOString(),
        capabilityId: "backup.read",
      }) as never,
    );
    // 有效记录（新会话 revision）
    elevationController.createElevation(
      makeElevationInput({
        sessionPermissionRevision: 2,
        capabilityId: "backup.read",
        expiresAtIso: null,
      }) as never,
    );
    const exporter = new CurrentPermissionConfigurationExporter();
    const snapshot = await exporter.exportEffectiveConfiguration({
      sessionId: "session-1",
      agentInstanceId: null,
      baseProfile: assistProfile,
      currentProfileReference: { kind: "builtin", profileId: "assist" },
      elevationStore,
      resolver: new EffectiveSecondaryPermissionResolver(),
      nowUnixMilliseconds: clockMilliseconds,
      isAgentRetired: () => false,
      currentSessionPermissionRevision: 2,
    });
    // 导出使用与运行时相同的有效性解析：revision=2 的有效记录生效 → backup.read=allow
    expect(snapshot.capabilityDecisions["backup.read"]).toBe("allow");
    // 导出不泄露会话授权能力（无 nonce/授权字段）
    expect(JSON.stringify(snapshot)).not.toContain("elevationId");
    expect(JSON.stringify(snapshot)).not.toContain("nonce");
  });
});
