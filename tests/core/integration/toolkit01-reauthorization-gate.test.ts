/**
 * 反例（2026-10-13，TOOLKIT-01-04 第 2/3 片）：版本切换的"新增副作用须重新授权"门禁，
 * 必须由**本地签发的重新授权记录**决定，**不得**由调用方自述的布尔值决定。
 *
 * 修复前实测缺口：`upgradeProjectVersion({ isReauthorized: true })` 即可完成切换
 * （调用方顺手传 true 就绕过），且 CLI 的 `--reauthorized` 就是这样一个参数。
 * 本文件从**存储层**（门禁真正所在处）钉住四条：
 *   无记录 ⇒ 拒；记录不存在 ⇒ 拒；绑定不匹配 ⇒ 拒；已被消费 ⇒ 拒；
 *   本地签发且匹配且未消费 ⇒ 放行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolPackageVersionStateStore } from "../../../packages/core/src/toolkit/tool-package-version-state-store.js";
import { authorizeToolPackageUpgrade } from "../../../packages/core/src/toolkit/tool-package-operation-control.js";

let stateDirectory: string;
let store: ToolPackageVersionStateStore;

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

/** v1（无副作用）已锁定并启用；v2 含新增副作用 `file-write`。 */
async function prepareOneToTwoWithNewSideEffect(): Promise<void> {
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

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit04-reauth-"));
  store = new ToolPackageVersionStateStore({ stateDirectory });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
});

describe("TOOLKIT-01-04：新增副作用门禁必须以本地签发的重新授权记录为依据", () => {
  it("① 无重新授权记录 ⇒ 必须拒绝（不存在'顺手传布尔就放行'的路径）", async () => {
    await prepareOneToTwoWithNewSideEffect();

    const outcome = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
    });

    expect(outcome.isApplied).toBe(false);
    expect(String(outcome.reason)).toMatch(/新增副作用|重新授权/);
    // 版本必须**没有被切换**
    const locks = (await store.readSnapshot()).projectLocks;
    expect(locks.find((lock) => lock.toolPackageId === TOOL_PACKAGE)?.version).toBe(1);
  });

  it("② 给了不存在的记录标识 ⇒ 必须拒绝（不得凭标识字面量放行）", async () => {
    await prepareOneToTwoWithNewSideEffect();

    const outcome = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: "not-a-real-record",
    });

    expect(outcome.isApplied).toBe(false);
    expect(String(outcome.reason)).toMatch(/不存在|核验未通过/);
  });

  it("③ 记录与本次操作绑定不匹配 ⇒ 必须拒绝（新增副作用不同）", async () => {
    await prepareOneToTwoWithNewSideEffect();
    // 记录声明的"新增副作用"与真实差异不一致
    const wrongRecord = await store.reauthorizationRecordStore.issueRecord({
      scope: {
        projectIdentifier: PROJECT,
        toolPackageId: TOOL_PACKAGE,
        fromVersion: 1,
        toVersion: 2,
        addedSideEffects: ["network"],
      },
      issuedBy: "user-1",
    });

    const outcome = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: wrongRecord.recordIdentifier,
    });

    expect(outcome.isApplied).toBe(false);
    expect(String(outcome.reason)).toMatch(/不匹配|核验未通过/);
  });

  it("④ 记录已被消费 ⇒ 必须拒绝（一次性，不得一次批准反复升级）", async () => {
    await prepareOneToTwoWithNewSideEffect();
    const differences = await store.describeUpgradeDifferences({
      toolPackageId: TOOL_PACKAGE,
      fromVersion: 1,
      toVersion: 2,
    });
    const record = await store.reauthorizationRecordStore.issueRecord({
      scope: {
        projectIdentifier: PROJECT,
        toolPackageId: TOOL_PACKAGE,
        fromVersion: 1,
        toVersion: 2,
        addedSideEffects: [...differences.addedSideEffects],
      },
      issuedBy: "user-1",
    });

    const first = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: record.recordIdentifier,
    });
    expect(first.isApplied).toBe(true);

    // 回滚锁定版本后再用同一条已消费记录尝试升级 ⇒ 必须拒绝
    await store.rollbackProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 1,
    });
    const second = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: record.recordIdentifier,
    });
    expect(second.isApplied).toBe(false);
    expect(String(second.reason)).toMatch(/已被使用过|核验未通过/);
  });

  it("⑤ 本地签发且绑定匹配且未消费 ⇒ 放行（正例，确认门禁不是'一律拒绝'）", async () => {
    await prepareOneToTwoWithNewSideEffect();
    const differences = await store.describeUpgradeDifferences({
      toolPackageId: TOOL_PACKAGE,
      fromVersion: 1,
      toVersion: 2,
    });
    expect(differences.requiresReauthorization).toBe(true);
    const record = await store.reauthorizationRecordStore.issueRecord({
      scope: {
        projectIdentifier: PROJECT,
        toolPackageId: TOOL_PACKAGE,
        fromVersion: 1,
        toVersion: 2,
        addedSideEffects: [...differences.addedSideEffects],
      },
      issuedBy: "user-1",
    });

    const outcome = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: record.recordIdentifier,
    });

    expect(outcome.isApplied).toBe(true);
    const locks = (await store.readSnapshot()).projectLocks;
    expect(locks.find((lock) => lock.toolPackageId === TOOL_PACKAGE)?.version).toBe(2);
  });

  it("⑥ 无新增副作用（1→3 同副作用）⇒ 不需要记录即可切换（门禁不过度拦截）", async () => {    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({
        version: 3,
        contentHash: "sha256:" + "c".repeat(64),
        declaredSideEffects: ["none"],
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

    const outcome = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 3,
    });

    expect(outcome.isApplied).toBe(true);
  });
});

describe("TOOLKIT-01-04：重新授权的签发入口（authorizeToolPackageUpgrade）", () => {
  it("⑦ 项目未锁定 ⇒ 拒绝签发（无法计算差异 ⇒ 不知情就不该签发授权）", async () => {
    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({
        version: 2,
        contentHash: "sha256:" + "b".repeat(64),
        declaredSideEffects: ["file-write"],
      }),
    );

    await expect(
      authorizeToolPackageUpgrade({
        stateDirectory,
        projectIdentifier: PROJECT,
        toolPackageId: TOOL_PACKAGE,
        toVersion: 2,
        issuedBy: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "tool-package-project-not-locked" });

    // 也没有留下任何记录
    await expect(store.reauthorizationRecordStore.listRecords()).resolves.toEqual([]);
  });

  it("⑧ 有新增副作用 ⇒ 签发记录，且**绑定真实差异**（用别的副作用列表换不出授权）", async () => {
    await prepareOneToTwoWithNewSideEffect();

    const outcome = await authorizeToolPackageUpgrade({
      stateDirectory,
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      issuedBy: "user-1",
    });

    expect(outcome.isReauthorizationRequired).toBe(true);
    expect(outcome.addedSideEffects).toEqual(["file-write"]);
    expect(outcome.reauthorizationRecordIdentifier).not.toBeNull();

    // 正例：拿这张记录可以真的完成升级
    const applied = await store.upgradeProjectVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 2,
      reauthorizationRecordIdentifier: String(outcome.reauthorizationRecordIdentifier),
    });
    expect(applied.isApplied).toBe(true);
  });

  it("⑨ 无新增副作用 ⇒ 不签发记录（避免留下无意义授权），但仍如实说明", async () => {
    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({ version: 3, contentHash: "sha256:" + "c".repeat(64) }),
    );
    await store.lockProjectToVersion({
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });

    const outcome = await authorizeToolPackageUpgrade({
      stateDirectory,
      projectIdentifier: PROJECT,
      toolPackageId: TOOL_PACKAGE,
      toVersion: 3,
      issuedBy: "user-1",
    });

    expect(outcome.isReauthorizationRequired).toBe(false);
    expect(outcome.reauthorizationRecordIdentifier).toBeNull();
    expect(outcome.detail).toContain("无需重新授权");
    await expect(store.reauthorizationRecordStore.listRecords()).resolves.toEqual([]);
  });
});

describe("TOOLKIT-01-04：版本状态文件的 fail-closed 与缺省字段兜底", () => {
  it("⑩ 状态文件非法（合法 JSON 但 `versions` 非数组）⇒ 明确报错，不静默当空状态", async () => {
    /**
     * 定向反例：`readSnapshot` 的 `!Array.isArray(raw.versions)` 一路此前未覆盖。
     * 语义要求：**明确报错**（"请修正或删除"），因为静默返回空快照会让
     * "版本状态丢失"看起来像"从没配过"，从而放行不该放行的启用/升级。
     */
    const stateFilePath = path.join(stateDirectory, "tool-package-version-state.json");
    await fs.writeFile(
      stateFilePath,
      JSON.stringify({ schemaVersion: "x", versions: "not-an-array" }),
      "utf8",
    );

    await expect(store.readSnapshot()).rejects.toThrowError(/非法/);
  });

  it("⑪ 旧文件缺 `projectLocks` 等可选字段 ⇒ 兜底为空数组，不抛错", async () => {
    /**
     * 定向反例：`?? []` 这几路（`projectLocks`/`callHistory`/`inFlightCalls`/`pendingSwitches`）。
     * 语义要求：**向后兼容**——旧版本写出的文件缺这些数组时按空处理，
     * 而不是把用户已有的版本登记一起废掉。
     */
    const stateFilePath = path.join(stateDirectory, "tool-package-version-state.json");
    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        schemaVersion: "ASTARRAY_TOOL_PACKAGE_VERSION_STATE_V1",
        versions: [],
        // 故意缺少 projectLocks / callHistory / inFlightCalls / pendingSwitches
      }),
      "utf8",
    );

    const snapshot = await store.readSnapshot();
    expect(snapshot.versions).toEqual([]);
    expect(snapshot.projectLocks).toEqual([]);
    expect(snapshot.callHistory).toEqual([]);
    expect(snapshot.inFlightCalls).toEqual([]);
    expect(snapshot.pendingSwitches).toEqual([]);
  });
});
