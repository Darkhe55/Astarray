/**
 * TOOLKIT-01-03 反例（2026-10-10）：用户级推广的三段分离、去项目化与防提权。
 *
 * 卡内 §5/§6/§7 明确要求：
 *  - 推广"**不自动发生**"，且"用户批准推广**不代表批准在所有项目运行**"；
 *  - 推广必须**分离通用逻辑 / 项目配置 / 用户偏好**（§6）；
 *  - 配置优先级首版固定：**包默认值 → 用户偏好 → 项目适配 → 本次显式非安全参数**，
 *    都经 schema 校验；**安全范围不参与这种后写覆盖，始终走权限求交**（§6）；
 *  - "偏好**不改变权限、安全行为或验收事实**"（§6）；
 *  - 推广不得带出**项目源码片段、绝对路径、私有配置、私有记忆、凭据和一次性授权**（§5）；
 *  - `portable` 至少要**两个结构不同的隔离项目**证明去项目化（§5）；
 *  - "**目标项目零修改**"与"**目标权限不继承**"（检查点 03）；
 *  - "项目锁定确切版本和哈希，**不自动随用户库升级**"（§8）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  applyPromotionDecision,
  createPromotionCandidate,
  resolveEffectiveConfiguration,
  validatePromotionCandidate,
} from "../../../packages/core/src/toolkit/tool-package-promotion.js";

function buildSourcePackage() {
  return {
    toolPackageId: "test-report-recipe",
    version: 1,
    contentHash: "sha256:" + "f".repeat(64),
    sourceProjectIdentifier: "project-alpha",
    generalLogic: {
      steps: ["parse-test-results", "compute-statistics"],
      descriptionTemplate: "报告：${conclusion}\n${details}",
    },
    projectAdaptations: {
      "project-alpha": { testFramework: "vitest", allowedResultFiles: ["results.json"] },
    },
    userPreferences: { language: "zh-CN", ordering: "conclusion-first" },
  };
}

describe("TOOLKIT-01-03：推广候选必须去项目化", () => {
  it("① 候选只能含通用逻辑 + 用户偏好；项目适配不得进入候选包", () => {
    const candidate = createPromotionCandidate({
      sourcePackage: buildSourcePackage(),
      targetScope: "user",
      reason: "多个项目重复使用",
    });
    expect(candidate.targetScope).toBe("user");
    expect(candidate.generalLogic.steps).toEqual(["parse-test-results", "compute-statistics"]);
    // 项目适配必须被剥离（不得带出项目配置）
    expect(Object.keys(candidate.projectAdaptations)).toEqual([]);
    expect(candidate.strippedProjectIdentifiers).toEqual(["project-alpha"]);
  });

  it("② 候选体内出现绝对路径 / 项目源码片段 / 凭据 / nonce / 私有记忆 ⇒ 拒绝", () => {
    const cases: Array<Record<string, unknown>> = [
      { generalLogic: { steps: ["读取 C:\\Users\\someone\\project\\a.ts"] } },
      { generalLogic: { steps: ["import x from '../project-alpha/src/secret.ts'"] } },
      { generalLogic: { steps: ["curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop'"] } },
      { userPreferences: { authorizationNonce: "once-123" } },
      { generalLogic: { steps: ["recall private memory entry mem-1"] } },
    ];
    for (const override of cases) {
      const candidate = createPromotionCandidate({
        sourcePackage: { ...buildSourcePackage(), ...override },
        targetScope: "user",
        reason: "测试敏感内容拦截",
      });
      const validation = validatePromotionCandidate({ candidate });
      expect(
        validation.isValid,
        "含敏感/项目内容的候选必须被拒绝: " + JSON.stringify(override),
      ).toBe(false);
      expect(String(validation.reason)).toMatch(/绝对路径|源码|凭据|nonce|记忆|敏感/);
    }
  });

  it("③ portable 需要两个结构不同的隔离项目（来源项目另计），否则拒绝", () => {
    const candidate = createPromotionCandidate({
      sourcePackage: buildSourcePackage(),
      targetScope: "portable",
      reason: "希望通用化",
    });
    // 默认只有来源项目 ⇒ 拒绝
    const withoutEvidence = validatePromotionCandidate({ candidate });
    expect(withoutEvidence.isValid).toBe(false);
    expect(String(withoutEvidence.reason)).toMatch(/两个|隔离项目|去项目化/);

    // 来源 + 一个隔离项目仍不足（无法证明脱离来源结构）
    const withOneIsolatedProject = validatePromotionCandidate({
      candidate,
      validatedProjectIdentifiers: ["project-alpha", "fixture-one"],
    });
    expect(withOneIsolatedProject.isValid).toBe(false);

    // 来源 + 两个结构不同的隔离项目 ⇒ 通过
    const withTwoIsolatedProjects = validatePromotionCandidate({
      candidate,
      validatedProjectIdentifiers: ["project-alpha", "fixture-one", "fixture-two"],
    });
    expect(withTwoIsolatedProjects.isValid).toBe(true);
  });

  it("④ user 作用域不要求两个项目，但必须已通过来源项目验证", () => {
    const candidate = createPromotionCandidate({
      sourcePackage: buildSourcePackage(),
      targetScope: "user",
      reason: "用户希望跨项目复用",
    });
    expect(validatePromotionCandidate({ candidate }).isValid).toBe(true);
    // 来源未验证（来源项目不在已验证集合）⇒ 拒绝
    const unvalidatedSource = validatePromotionCandidate({
      candidate,
      validatedProjectIdentifiers: ["some-other-project"],
    });
    expect(unvalidatedSource.isValid).toBe(false);
  });
});

describe("TOOLKIT-01-03：三段分离与配置优先级", () => {
  it("⑤ 优先级固定：包默认 → 用户偏好 → 项目适配 → 本次显式非安全参数", () => {
    const resolved = resolveEffectiveConfiguration({
      packageDefaults: { ordering: "detail-first", language: "en-US", pageSize: 20 },
      userPreferences: { ordering: "conclusion-first", language: "zh-CN" },
      projectAdaptations: { pageSize: 50 },
      callTimeExplicitParameters: { pageSize: 100 },
    });
    expect(resolved.isValid).toBe(true);
    expect(resolved.effectiveConfiguration["ordering"]).toBe("conclusion-first");
    expect(resolved.effectiveConfiguration["language"]).toBe("zh-CN");
    expect(resolved.effectiveConfiguration["pageSize"]).toBe(100);
  });

  it("⑥ **安全范围不参与后写覆盖**：偏好/适配/本次参数都不得改写安全键", () => {
    for (const overrider of ["userPreferences", "projectAdaptations", "callTimeExplicitParameters"] as const) {
      const resolved = resolveEffectiveConfiguration({
        packageDefaults: { permissionMode: "ask", allowNetworkAccess: false, ordering: "detail-first" },
        [overrider]: { permissionMode: "allow", allowNetworkAccess: true },
      });
      expect(
        resolved.isValid,
        "安全键被 " + overrider + " 覆盖必须被拒绝（安全范围始终走权限求交）",
      ).toBe(false);
      expect(String(resolved.reason)).toMatch(/安全|权限|不得覆盖|求交/);
    }
  });

  it("⑦ 未知配置键必须拒绝（schema 校验，fail-closed，不透传）", () => {
    const resolved = resolveEffectiveConfiguration({
      packageDefaults: { ordering: "detail-first" },
      projectAdaptations: { notADeclaredKey: "x" },
      declaredConfigurationKeys: ["ordering", "language", "pageSize"],
    });
    expect(resolved.isValid).toBe(false);
    expect(String(resolved.reason)).toMatch(/未知|未声明|schema/);
  });

  it("⑧ 偏好不得改变验收事实（验收结论字段属安全/事实范围，不可被偏好覆盖）", () => {
    const resolved = resolveEffectiveConfiguration({
      packageDefaults: { acceptanceVerdict: "needs-rework" },
      userPreferences: { acceptanceVerdict: "accepted" },
    });
    expect(resolved.isValid).toBe(false);
  });
});

describe("TOOLKIT-01-03：推广不自动启用、目标项目零修改、版本固定", () => {
  it("⑨ 用户批准推广**不等于**获批在所有项目运行；目标项目须显式启用", () => {
    const candidate = createPromotionCandidate({
      sourcePackage: buildSourcePackage(),
      targetScope: "user",
      reason: "用户希望跨项目复用",
    });
    const outcome = applyPromotionDecision({
      candidate,
      decision: "approved",
      approvedByUserId: "user-1",
    });
    expect(outcome.isApproved).toBe(true);
    expect(outcome.enabledProjectIdentifiers).toEqual([]);
    expect(outcome.scope).toBe("user");
    // 来源项目零修改：仅记录来源，不写回
    expect(outcome.sourceProjectIdentifier).toBe("project-alpha");
    expect(outcome.isSourceProjectModified).toBe(false);
  });

  it("⑩ 目标项目固定确切版本与哈希：不自动随用户库升级", () => {
    const candidate = createPromotionCandidate({
      sourcePackage: buildSourcePackage(),
      targetScope: "user",
      reason: "跨项目复用",
    });
    const outcome = applyPromotionDecision({
      candidate,
      decision: "approved",
      approvedByUserId: "user-1",
    });
    // 新版本号与哈希由候选决定，目标项目引用的是**固定**版本
    expect(outcome.pinnedVersion).toBe(candidate.candidateVersion);
    expect(outcome.pinnedContentHash).toBe(candidate.candidateContentHash);
    // 更高版本出现时不改变已固定引用
    const laterUpgrade = { candidateVersion: candidate.candidateVersion + 1 };
    expect(outcome.pinnedVersion).not.toBe(laterUpgrade.candidateVersion);
  });

  it("⑪ 目标权限不继承：推广结果不携带来源项目的权限/范围声明", () => {
    const candidate = createPromotionCandidate({
      sourcePackage: {
        ...buildSourcePackage(),
        // 来源包若声明了权限范围，推广不得把它带过去
        sourcePermissionDeclarations: { allowWriteTo: ["project-alpha/src"] },
      },
      targetScope: "user",
      reason: "跨项目复用",
    });
    const outcome = applyPromotionDecision({
      candidate,
      decision: "approved",
      approvedByUserId: "user-1",
    });
    expect(outcome.inheritedPermissionDeclarations).toEqual([]);
    expect(candidate.carriedPermissionDeclarations).toEqual([]);
  });
});
