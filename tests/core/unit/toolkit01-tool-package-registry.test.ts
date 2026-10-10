/**
 * TOOLKIT-01 反例（2026-10-10，首片）：工具包**登记与作用域**契约。
 *
 * 卡内 §4/§5 明确要求（本卡原为 pending，本片开始实施）：
 *  - 名称**不是路由键**：调用固定 `ID + 版本 + 哈希`，禁止自动选"最新同名工具"；
 *  - **已启用内容不可原地修改**；代码或依赖变化必须生成**新版本**；
 *  - 运行前校验实际文件与登记哈希，**拒绝校验后偷换内容**；
 *  - 作用域三层：`project`（仅来源项目可发现/使用）→ `user`（用户自己的跨项目库，
 *    不是所有人可用）→ `portable`（可导出，不自动联网发布）；
 *  - **推广不自动发生**：运行频次或模型"认为通用"只能产生**提案**；
 *  - **目标项目只取得明确授予的能力**：user/portable 包也必须在目标项目**显式启用**，
 *    且固定版本；未启用包只能被查看、不能调用；
 *  - 来源身份必须是**具体 `agentInstanceId`**（不得只保存角色/模型名）；
 *  - 不得携带凭据/授权 nonce/私有记忆。
 *
 * 现状缺口：本仓有 `CraftsmanWorkflowLifecycleController`（提交/单链/独立验收），
 * 但**没有**包登记与作用域这一层 ⇒ 上面的作用域、不可变、显式启用均无判定点。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import { ToolPackageRegistry } from "../../../packages/core/src/toolkit/tool-package-registry.js";

function buildPackage(overrides: Record<string, unknown> = {}) {
  return {
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: "sha256:" + "a".repeat(64),
    schemaVersion: "ASTARRAY_TOOL_PACKAGE_V1",
    packageKind: "recipe" as const,
    readableName: "测试报告格式化",
    purposeSummary: "把测试结果整理为报告",
    applicableConditions: ["有测试结果文件"],
    sourceProjectIdentifier: "project-alpha",
    generatorAgentInstanceId: "agent-gen-1",
    acceptorAgentInstanceId: "agent-acc-1",
    evidenceReferences: ["docs/reports/EVIDENCE.md"],
    supportedActions: ["read", "format"],
    ...overrides,
  };
}

describe("TOOLKIT-01：工具包登记与作用域", () => {
  it("① 以 ID+版本+哈希 寻址；同名不同版本必须区分（名称不是路由键）", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage({ version: 1, contentHash: "sha256:" + "a".repeat(64) }));
    registry.register(buildPackage({ version: 2, contentHash: "sha256:" + "b".repeat(64) }));

    const foundOne = registry.resolveByIdentity({
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });
    const foundTwo = registry.resolveByIdentity({
      toolPackageId: "report-formatter",
      version: 2,
      contentHash: "sha256:" + "b".repeat(64),
    });
    expect(foundOne?.version).toBe(1);
    expect(foundTwo?.version).toBe(2);

    // 按**名称**解析必须失败（名称不是路由键，不得自动选最新）
    expect(registry.resolveByReadableName("测试报告格式化")).toBeNull();
  });

  it("② 已启用内容不可原地修改：同 ID+版本 换哈希必须拒绝，须新版本", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage());
    expect(() =>
      registry.register(buildPackage({ contentHash: "sha256:" + "c".repeat(64) })),
    ).toThrowError(/不可原地修改|新版本|已存在/);
  });

  it("③ 运行前校验实际文件哈希；不一致必须拒绝（拒绝校验后偷换内容）", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage());
    expect(
      registry.verifyContentBeforeUse({
        toolPackageId: "report-formatter",
        version: 1,
        observedContentHash: "sha256:" + "a".repeat(64),
      }).isValid,
    ).toBe(true);
    const swapped = registry.verifyContentBeforeUse({
      toolPackageId: "report-formatter",
      version: 1,
      observedContentHash: "sha256:" + "d".repeat(64),
    });
    expect(swapped.isValid).toBe(false);
    expect(String(swapped.reason)).toMatch(/哈希|篡改|不一致/);
  });

  it("④ project 作用域：仅在来源项目可发现，其它项目一律不可见/不可调用", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage({ scope: "project" }));
    registry.enable({
      toolPackageId: "report-formatter",
      version: 1,
      targetProjectIdentifier: "project-alpha",
    });

    expect(
      registry.listDiscoverable({ projectIdentifier: "project-alpha" }).map(
        (entry) => entry.toolPackageId,
      ),
    ).toEqual(["report-formatter"]);
    // 其它项目：不可发现
    expect(registry.listDiscoverable({ projectIdentifier: "project-beta" })).toEqual([]);
    // 其它项目：即使知道 ID+版本也不可调用（未在其项目启用）
    const callFromOtherProject = registry.resolveForExecution({
      toolPackageId: "report-formatter",
      version: 1,
      projectIdentifier: "project-beta",
    });
    expect(callFromOtherProject).toBeNull();
  });

  it("⑤ 未启用包只能被查看、不能调用（draft/validated 不可执行）", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage());
    // 已登记但未在任何项目启用
    const beforeEnable = registry.resolveForExecution({
      toolPackageId: "report-formatter",
      version: 1,
      projectIdentifier: "project-alpha",
    });
    expect(beforeEnable).toBeNull();
    // 但可被查看（管理视图）
    expect(registry.describePackage({ toolPackageId: "report-formatter", version: 1 })).not.toBeNull();
  });

  it("⑥ 作用域提升到 user 不等于在所有项目可运行：目标项目仍须显式启用", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage({ scope: "project" }));
    const promotionProposal = registry.proposePromotion({
      toolPackageId: "report-formatter",
      version: 1,
      targetScope: "user",
      reason: "多个项目重复使用",
    });
    // 提案不改变任何可用性
    expect(promotionProposal.outcome).toBe("proposed");
    expect(
      registry.resolveForExecution({
        toolPackageId: "report-formatter",
        version: 1,
        projectIdentifier: "project-beta",
      }),
    ).toBeNull();
    // 提升需要用户批准（本层只登记批准结果），批准后成为 user 作用域的新版本
    registry.applyPromotionDecision({
      proposalIdentifier: promotionProposal.proposalIdentifier,
      decision: "approved",
    });
    expect(registry.describePackage({ toolPackageId: "report-formatter", version: 1 })?.scope).toBe(
      "user",
    );
    // 仍未在 project-beta 显式启用 ⇒ 依然不可调用
    expect(
      registry.resolveForExecution({
        toolPackageId: "report-formatter",
        version: 1,
        projectIdentifier: "project-beta",
      }),
    ).toBeNull();
    // 显式启用后才可调用，且固定版本
    registry.enable({
      toolPackageId: "report-formatter",
      version: 1,
      targetProjectIdentifier: "project-beta",
    });
    expect(
      registry.resolveForExecution({
        toolPackageId: "report-formatter",
        version: 1,
        projectIdentifier: "project-beta",
      })?.version,
    ).toBe(1);
  });

  it("⑦ 登记必须含具体来源 agentInstanceId；缺来源身份必须拒绝", () => {
    const registry = new ToolPackageRegistry();
    expect(() =>
      registry.register(buildPackage({ generatorAgentInstanceId: "" })),
    ).toThrowError(/来源|generatorAgentInstanceId|必须/);
    expect(() => registry.register(buildPackage({ acceptorAgentInstanceId: "" }))).toThrowError(
      /验收|acceptorAgentInstanceId|必须/,
    );
  });

  it("⑧ 不得携带凭据/授权 nonce/私有记忆（登记即拒绝）", () => {
    const registry = new ToolPackageRegistry();
    for (const forbiddenField of [
      "credentialReference",
      "authorizationNonce",
      "privateMemoryEntries",
    ]) {
      expect(
        () => registry.register(buildPackage({ [forbiddenField]: "x" })),
        "含 " + forbiddenField + " 的包必须被拒绝",
      ).toThrowError(/不得|凭据|nonce|记忆/);
    }
  });

  it("⑨ 禁止把未验收/未启用包登记为可调用（状态最小集合）", () => {
    const registry = new ToolPackageRegistry();
    registry.register(buildPackage({ scope: "project" }));
    // 直接以"启用"登记但没有验收记录 ⇒ 拒绝
    expect(() =>
      registry.enable({
        toolPackageId: "report-formatter",
        version: 1,
        targetProjectIdentifier: "project-alpha",
        isAcceptanceRecorded: false,
      }),
    ).toThrowError(/验收|未验收/);
  });
});
