/**
 * TOOLKIT-01-04 反例（2026-10-10）：版本、更新、回滚与故障。
 *
 * 卡内 §8 的硬要求：
 *  - 项目**锁定确切版本和哈希**，**不自动随用户库升级**；旧项目继续使用旧版；
 *  - 新版本展示**行为、依赖和权限差异**；**新增副作用须重新授权**；
 *  - 启用/停用/锁定变更按 **revision 原子提交**；
 *  - **停用阻止新运行**，但**不得删掉运行中的文件造成结果未知**（在途调用按安全点收敛）；
 *  - **回滚只切换后续使用版本，不撤销历史副作用**；
 *  - 包损坏 / 依赖缺失 / 旧结果不兼容时**明确失败**；
 *  - 记录 run ID、步骤 ID、版本、**参数哈希**与来源、实际产物与失败原因，**不输出秘密**；
 *  - 支持**禁用和废弃**，不做物理删除；旧版被引用时保留。
 *
 * 本片只做**本地确定性**判定与状态迁移（不执行工具、不联网、不读凭据）。
 */
import { describe, expect, it } from "vitest";

import { ToolPackageVersionController } from "../../../packages/core/src/toolkit/tool-package-version-controller.js";

function buildPackageInput(overrides: Record<string, unknown> = {}) {
  return {
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: "sha256:" + "a".repeat(64),
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none"],
    declaredDependencies: ["vitest>=1"],
    permissionRequirements: ["read-file"],
    ...overrides,
  };
}

describe("TOOLKIT-01-04：项目锁定版本，不自动随库升级", () => {
  it("① 注册更高版本后，已锁定项目仍使用旧版本（不自动升级）", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.registerVersion(
      buildPackageInput({ version: 2, contentHash: "sha256:" + "b".repeat(64) }),
    );
    controller.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });
    controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });
    const resolved = controller.resolveVersionForExecution({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    expect(resolved?.version).toBe(1);
    // 更该验证"注册新版本**不会**改变已锁定项目的解析结果"
    expect(
      controller.resolveVersionForExecution({
        projectIdentifier: "project-alpha",
        toolPackageId: "report-formatter",
      })?.contentHash,
    ).toBe("sha256:" + "a".repeat(64));
  });

  it("② 升级差异必须列出行为/依赖/权限差异，并标出**新增副作用**", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.registerVersion(
      buildPackageInput({
        version: 2,
        contentHash: "sha256:" + "b".repeat(64),
        declaredSideEffects: ["none", "file-write"],
        declaredDependencies: ["vitest>=1", "jsdom>=20"],
        permissionRequirements: ["read-file", "write-file"],
      }),
    );
    const differences = controller.describeUpgradeDifferences({
      toolPackageId: "report-formatter",
      fromVersion: 1,
      toVersion: 2,
    });
    expect(differences.behaviorDifferences).toContain("file-write");
    expect(differences.dependencyDifferences).toContain("jsdom>=20");
    expect(differences.permissionDifferences).toContain("write-file");
    expect(differences.addedSideEffects).toEqual(["file-write"]);
    expect(differences.requiresReauthorization).toBe(true);
  });

  it("③ 新增副作用未重新授权时，升级到该版本必须被拒绝", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.registerVersion(
      buildPackageInput({
        version: 2,
        contentHash: "sha256:" + "b".repeat(64),
        declaredSideEffects: ["none", "file-write"],
      }),
    );
    controller.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });
    controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });
    const outcome = controller.upgradeProjectVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      toVersion: 2,
      isReauthorized: false,
    });
    expect(outcome.isApplied).toBe(false);
    expect(String(outcome.reason)).toMatch(/新增副作用|重新授权/);

    /**
     * 并验证**没有旁路**：`enableForProject` 不得被用来完成版本切换
     * （否则任何调用方顺手传个标志就能绕过重新授权门禁）。
     */
    const bypassAttempt = controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 2,
    });
    expect(bypassAttempt.isApplied).toBe(false);
    expect(String(bypassAttempt.reason)).toMatch(/upgradeProjectVersion|绕过/);
    // 重新授权后升级成功
    const reauthorized = controller.upgradeProjectVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      toVersion: 2,
      isReauthorized: true,
    });
    expect(reauthorized.isApplied).toBe(true);
  });
});

describe("TOOLKIT-01-04：原子变更、停用与在途收敛", () => {
  it("④ 每次变更按 revision 递增原子提交", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    const first = controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });
    const second = controller.disableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.isEnabled).toBe(false);
  });

  it("⑤ 停用阻止**新**运行，但在途调用不得被删除（必须能安全收敛）", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });
    controller.recordInFlightCall({
      runIdentifier: "run-1",
      stepIdentifier: "step-1",
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      argumentHash: "sha256:" + "c".repeat(64),
    });
    controller.disableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    // 新运行被阻止
    expect(
      controller.resolveVersionForExecution({
        projectIdentifier: "project-alpha",
        toolPackageId: "report-formatter",
      }),
    ).toBeNull();
    // 在途调用仍可收敛（不得因停用而"删掉运行中的文件造成结果未知"）
    const inFlight = controller.listInFlightCalls({ projectIdentifier: "project-alpha" });
    expect(inFlight).toHaveLength(1);
    expect(controller.convergeInFlightCall({ runIdentifier: "run-1" }).isConverged).toBe(true);
    expect(controller.listInFlightCalls({ projectIdentifier: "project-alpha" })).toHaveLength(0);
  });

  it("⑥ 回滚只切换后续使用版本，**不撤销历史副作用**", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.registerVersion(
      buildPackageInput({ version: 2, contentHash: "sha256:" + "b".repeat(64) }),
    );
    controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 2,
    });
    controller.recordCompletedCall({
      runIdentifier: "run-history",
      stepIdentifier: "step-1",
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 2,
      argumentHash: "sha256:" + "d".repeat(64),
      producedArtifacts: ["reports/out.md"],
    });
    const rollback = controller.rollbackProjectVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      toVersion: 1,
    });
    expect(rollback.isApplied).toBe(true);
    expect(
      controller.resolveVersionForExecution({
        projectIdentifier: "project-alpha",
        toolPackageId: "report-formatter",
      })?.version,
    ).toBe(1);
    // 历史副作用记录仍在（回滚不撤销历史）
    expect(controller.listCallHistory({ projectIdentifier: "project-alpha" })).toHaveLength(1);
  });
});

describe("TOOLKIT-01-04：故障明确失败与调用记录", () => {
  it("⑦ 包内容损坏 / 依赖缺失 ⇒ 明确失败并给出原因", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });
    controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });
    // 包内容损坏（实际哈希与登记不符）⇒ 解析失败 + 记录原因
    const corrupted = controller.resolveVersionForExecution({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      observedContentHash: "sha256:" + "9".repeat(64),
    });
    expect(corrupted).toBeNull();
    expect(String(controller.getLastFailureReason())).toMatch(/哈希|损坏|不一致/);

    const missingDependency = controller.checkPreconditions({
      toolPackageId: "report-formatter",
      version: 1,
      availableDependencies: [],
    });
    expect(missingDependency.isSatisfied).toBe(false);
    expect(String(missingDependency.reason)).toMatch(/依赖/);
  });

  it("⑧ 调用记录必须含 run/步骤/版本/参数哈希/来源/产物/失败原因，且**不含秘密**", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    const record = controller.recordCompletedCall({
      runIdentifier: "run-2",
      stepIdentifier: "step-2",
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      argumentHash: "sha256:" + "e".repeat(64),
      producedArtifacts: ["reports/out.md"],
    });
    expect(record.runIdentifier).toBe("run-2");
    expect(record.stepIdentifier).toBe("step-2");
    expect(record.version).toBe(1);
    expect(record.argumentHash).toBe("sha256:" + "e".repeat(64));
    expect(record.sourceProjectIdentifier).toBe("project-alpha");
    expect(record.producedArtifacts).toEqual(["reports/out.md"]);

    // 记录里不得出现秘密（传入含秘密的产物路径也要被拒绝或脱敏）
    expect(() => {
      controller.recordCompletedCall({
        runIdentifier: "run-3",
        stepIdentifier: "step-3",
        projectIdentifier: "project-alpha",
        toolPackageId: "report-formatter",
        version: 1,
        argumentHash: "sha256:" + "f".repeat(64),
        producedArtifacts: ["sk-live-abcdefghijklmnop"],
      });
    }).toThrowError(/秘密|凭据|不得记录/);
  });

  it("⑨ 支持禁用与废弃；被引用的旧版必须保留（不物理删除）", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.registerVersion(
      buildPackageInput({ version: 2, contentHash: "sha256:" + "b".repeat(64) }),
    );
    // 旧版被调用历史引用 ⇒ 不得物理删除
    controller.recordCompletedCall({
      runIdentifier: "run-old",
      stepIdentifier: "step-1",
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      argumentHash: "sha256:" + "1".repeat(64),
      producedArtifacts: [],
    });
    const removal = controller.removeVersion({
      toolPackageId: "report-formatter",
      version: 1,
    });
    expect(removal.isRemoved).toBe(false);
    expect(String(removal.reason)).toMatch(/引用|保留|历史/);

    // 未被引用的版本可废弃（标记而非删除）
    const deprecation = controller.deprecateVersion({
      toolPackageId: "report-formatter",
      version: 2,
    });
    expect(deprecation.isDeprecated).toBe(true);
    expect(
      controller.describeVersion({ toolPackageId: "report-formatter", version: 2 })?.status,
    ).toBe("deprecated");
  });

  it("⑩ 崩溃恢复：半提交的版本切换不得留下「已启用但哈希不符」的状态", () => {
    const controller = new ToolPackageVersionController();
    controller.registerVersion(buildPackageInput({ version: 1 }));
    controller.registerVersion(
      buildPackageInput({ version: 2, contentHash: "sha256:" + "b".repeat(64) }),
    );
    controller.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });
    // 模拟崩溃：写入前落了一份"半提交"意图记录（目标版本哈希与实际不符）
    controller.recordPendingVersionSwitch({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      intendedVersion: 2,
      intendedContentHash: "sha256:" + "7".repeat(64),
    });
    const recovered = controller.recoverFromInterruptedSwitch({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    // 必须收敛回**上一个可信**版本，而不是带着不符的哈希当作已启用
    expect(recovered.isRecovered).toBe(true);
    expect(recovered.activeVersion).toBe(1);
    const resolved = controller.resolveVersionForExecution({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    expect(resolved?.version).toBe(1);
    expect(resolved?.contentHash).toBe("sha256:" + "a".repeat(64));
  });
});
