/**
 * TOOLKIT-01-04 × MERGE-01 **联测**（2026-10-13 第 13 轮）。
 *
 * 卡内把 TOOLKIT-01-04 的剩余条件写作"与 MERGE-01 权限功能的完整联测"。
 * 本文件把两件功能放进**同一个应用状态目录**里一起驱动：
 *  - MERGE-01：`queryParameterAuthorizationSettings` / `updateParameterAuthorizationSettings`
 *    （逐项 `deny/ask/allow`；放宽须认证用户确认，否则被拒且**不落地**）；
 *  - TOOLKIT-01-04：版本切换的"新增副作用须重新授权"门禁
 *    （以本地签发、操作绑定、一次性消费的记录为依据）。
 *
 * 钉住的联测性质：
 *  ① 两者**互不干扰**：各自的配置 revision 独立递增，各自的落盘文件独立存在；
 *  ② 参数授权设置**未确认的放宽被拒**时，**不得**顺带改变工具包版本状态；
 *  ③ 版本门禁**不因**参数授权设置被打开/关闭而改变（它只认重新授权记录）；
 *  ④ 一次真实序列（设置变更 → 签发 → 升级）后，两边的**持久化**都可被新实例读回。
 *
 * 注：本文件**不主张**"参数授权设置就是重新授权记录的签发者" ——
 * 现行设计里两者仍是各自独立的机制（第 2/3 片定稿时明确否决了"靠调用方自述"的做法，
 * 但也尚未把 MERGE-01 的规则表接成签发来源）。该问题在卡内单独记录，不在此处假装已解决。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { ToolPackageVersionStateStore } from "../../../packages/core/src/toolkit/tool-package-version-state-store.js";
import { authorizeToolPackageUpgrade } from "../../../packages/core/src/toolkit/tool-package-operation-control.js";

let stateDirectory: string;
let application: AstarrayApplicationFacade | null = null;

const PROJECT = "project-alpha";
const TOOL_PACKAGE = "report-formatter";

function buildVersionInput(overrides: Record<string, unknown> = {}) {
  return {
    toolPackageId: TOOL_PACKAGE,
    version: 1,
    contentHash: "sha256:" + "a".repeat(64),
    sourceProjectIdentifier: PROJECT,
    declaredSideEffects: ["none"],
    declaredDependencies: ["vitest>=1"],
    permissionRequirements: ["read-file"],
    ...overrides,
  } as never;
}

async function prepareVersionedToolPackage(): Promise<void> {
  const store = new ToolPackageVersionStateStore({ stateDirectory });
  await store.registerVersion(buildVersionInput({ version: 1 }));
  await store.registerVersion(
    buildVersionInput({
      version: 2,
      contentHash: "sha256:" + "b".repeat(64),
      declaredSideEffects: ["file-write"],
      permissionRequirements: ["read-file", "write-file"],
    }),
  );
  await store.lockProjectToVersion({
    projectIdentifier: PROJECT,
    toolPackageId: TOOL_PACKAGE,
    version: 1,
    contentHash: "sha256:" + "a".repeat(64),
  });
  await store.enableForProject({
    projectIdentifier: PROJECT,
    toolPackageId: TOOL_PACKAGE,
    version: 1,
  });
}

async function createApplication(): Promise<AstarrayApplicationFacade> {
  application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 2,
    failureThreshold: 3,
  } as never);
  return application;
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit-merge-joint-"));
});

afterEach(async () => {
  await application?.shutdown().catch(() => {});
  application = null;
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
});

describe("TOOLKIT-01-04 × MERGE-01 联测", () => {
  it("① 参数授权设置变更**已确认** ⇒ 接受；且不影响工具包版本状态（互不干扰）", async () => {
    await prepareVersionedToolPackage();
    const facade = await createApplication();

    const before = await facade.queryParameterAuthorizationSettings();
    const accepted = await facade.updateParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      toolAuthorizationShapes: [
        {
          toolName: "projectFileWrite",
          unifiedEffect: "ask",
          ruleEffects: [{ ruleIdentifier: "rule-ask-write", effect: "ask" }],
        },
      ],
      isConfirmedByAuthenticatedUser: true,
    });
    expect(accepted.isAccepted).toBe(true);

    const after = await facade.queryParameterAuthorizationSettings();
    // 配置 revision 必须前进（MERGE-01 自己的语义）
    expect(after.configurationRevision).toBeGreaterThan(before.configurationRevision);

    // 工具包版本状态**不得**被这次设置变更动到
    const versionStore = new ToolPackageVersionStateStore({ stateDirectory });
    const lock = (await versionStore.readSnapshot()).projectLocks.find(
      (candidate) => candidate.toolPackageId === TOOL_PACKAGE,
    );
    expect(lock?.version).toBe(1);
  });

  it("② 未确认的**放宽**被拒 ⇒ 不得顺带改变工具包版本状态（两处都不落地）", async () => {
    await prepareVersionedToolPackage();
    const facade = await createApplication();

    /**
     * 放宽的判定形态取自既有可信用例（`merge01-parameter-authorization-settings-entry.test.ts` ②）：
     * 关闭"参数规则"（`isParameterRulesEnabled: false`）而该 action 的规则里仍有
     * `deny` 效果 ⇒ 判定为**放宽**；未确认即须拒绝。
     * 注：我先前凭直觉写的 `allow`+`allow` 组合**不构成放宽**（实测返回
     * `widenedPermissions: []` 且 `requiresAuthenticatedUserConfirmation: false`），
     * 那样写会得到一条"断言恒真"的空洞用例。
     */
    const before = await facade.queryParameterAuthorizationSettings();

    const rejected = await facade.updateParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      toolAuthorizationShapes: [
        {
          toolName: "projectFileWrite",
          unifiedEffect: "allow",
          ruleEffects: [{ ruleIdentifier: "rule-deny-write", effect: "deny" }],
        },
      ],
      isConfirmedByAuthenticatedUser: false,
    });
    expect(rejected.isAccepted).toBe(false);
    expect(rejected.widenedPermissions.length).toBeGreaterThan(0);

    // 设置未被改变
    const after = await facade.queryParameterAuthorizationSettings();
    expect(after.configurationRevision).toBe(before.configurationRevision);

    // 工具包版本也未被改变
    const versionStore = new ToolPackageVersionStateStore({ stateDirectory });
    const lock = (await versionStore.readSnapshot()).projectLocks.find(
      (candidate) => candidate.toolPackageId === TOOL_PACKAGE,
    );
    expect(lock?.version).toBe(1);
  });

  it("③ 版本门禁**只认重新授权记录**：参数授权设置开着也拦不住、关了也不放行", async () => {
    await prepareVersionedToolPackage();
    const facade = await createApplication();
    const versionStore = new ToolPackageVersionStateStore({ stateDirectory });

    // 先把参数授权设置打开（含已确认的收紧）
    await facade.updateParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      toolAuthorizationShapes: [
        {
          toolName: "projectFileWrite",
          unifiedEffect: "deny",
          ruleEffects: [{ ruleIdentifier: "rule-deny-write", effect: "deny" }],
        },
      ],
      isConfirmedByAuthenticatedUser: true,
    });

    // ① 无记录 ⇒ 仍被拒（参数授权设置不能替代版本门禁）
    const withoutRecord = await versionStore.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
    });
    expect(withoutRecord.isApplied).toBe(false);
    expect(String(withoutRecord.reason)).toMatch(/新增副作用|重新授权/);

    // ② 本地签发记录后 ⇒ 放行（与参数授权设置的开关无关）
    const authorization = await authorizeToolPackageUpgrade({
      stateDirectory,
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      issuedBy: "user-1",
    });
    const withRecord = await versionStore.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: String(
        authorization.reauthorizationRecordIdentifier,
      ),
    });
    expect(withRecord.isApplied).toBe(true);
  });

  it("④ 真实序列后的持久化：新实例能同时读回参数设置与工具包版本/授权记录", async () => {
    await prepareVersionedToolPackage();
    const facade = await createApplication();
    await facade.updateParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      toolAuthorizationShapes: [
        {
          toolName: "projectFileRead",
          unifiedEffect: "allow",
          ruleEffects: [{ ruleIdentifier: "rule-allow-read", effect: "allow" }],
        },
      ],
      isConfirmedByAuthenticatedUser: true,
    });
    const authorization = await authorizeToolPackageUpgrade({
      stateDirectory,
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      issuedBy: "user-1",
    });
    const versionStore = new ToolPackageVersionStateStore({ stateDirectory });
    const upgraded = await versionStore.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: String(
        authorization.reauthorizationRecordIdentifier,
      ),
    });
    expect(upgraded.isApplied).toBe(true);
    await facade.shutdown();
    application = null;

    // 全新实例（模拟重启）读回两边状态
    const reopenedFacade = await createApplication();
    const settings = await reopenedFacade.queryParameterAuthorizationSettings();
    expect(settings.isParameterAuthorizationEnabled).toBe(true);

    const reopenedStore = new ToolPackageVersionStateStore({ stateDirectory });
    const lock = (await reopenedStore.readSnapshot()).projectLocks.find(
      (candidate) => candidate.toolPackageId === TOOL_PACKAGE,
    );
    expect(lock?.version).toBe(2);
    // 授权记录仍在盘上（且已被消费 ⇒ 不可复用）
    const records = await reopenedStore.reauthorizationRecordStore.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.consumedAtIso).not.toBeNull();
  });
});
