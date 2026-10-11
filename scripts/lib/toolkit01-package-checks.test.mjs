/**
 * TOOLKIT-01-06 包级验收**判定逻辑**的测试（先红后绿，2026-10-10）。
 *
 * 动机（本仓已有教训）：内联判定曾导致"**零判据通过**"。包级验收的判据必须是
 * **可测试的不变量**；任何必需观测缺失 ⇒ **失败**（fail-closed），不得缺省跳过。
 *
 * 覆盖的关键不变量：
 *  - 只能按 ID+版本+哈希 寻址；**名称不是路由键**（按名称解析必须为 null）；
 *  - 已启用内容**不可原地修改**（同 ID+版本 换哈希必须被拒）；
 *  - `project` 作用域**不得**在其它项目可发现/可调用；
 *  - **"复用不是只 import"**：验证期未执行全部声明工具必须判未验证；
 *  - 升级含**新增副作用**且未重新授权必须被拒；授权后才可切换；
 *  - **readOnly 自声明不构成信任**；缺沙箱/缺 broker 必须拒绝；
 *  - 任意脚本后备入口**必须为 false**、配方路径**必须保留**；
 *  - 转换器真实可用（gate 通过 + 转换成功 + 坏行明确失败）。
 *
 * 运行：`npm run test:scripts`（node --test）
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildToolkitPackageChecks } from "./toolkit01-package-checks.mjs";

/** 造一份"全部正常"的观测输入；各用例只覆盖需要变形的字段。 */
function buildPassingObservation() {
  return {
    publicEntryExports: {
      RecipeExecutionEngine: true,
      createRecipeLifecycle: true,
      ToolPackageRegistry: true,
      ToolPackageVersionController: true,
      ToolPackageVersionStateStore: true,
      evaluateProgramToolEnablement: true,
      DETERMINISTIC_CSV_TO_JSON_CONVERTER: true,
      runDeterministicProgramTool: true,
      // NODECTX-01（与 MERGE-01 同卡）
      createLosslessContextManager: true,
      buildContextVisibilityDisplayRows: true,
      // MERGE-01 §1.3：参数授权设置变更判定
      evaluateParameterAuthorizationSettingChange: true,
      evaluateInstructionMergeEligibility: true,
      buildGuiToolPackageView: false,
    },
    recipe: {
      isDefinitionValid: true,
      resolvedToolNames: ["readFile", "listDirectory"],
      executedToolNames: ["readFile", "listDirectory"],
      isExecutionSuccessful: true,
      validatorDiffersFromAuthor: true,
      isValidationAccepted: true,
      rejectedSameAuthorValidation: true,
      isReuseProvenNotImportOnly: true,
    },
    registry: {
      resolveByIdentityWorks: true,
      resolveByReadableNameIsNull: true,
      immutabilityEnforced: true,
      otherProjectCannotDiscover: true,
      otherProjectCannotExecute: true,
    },
    promotion: {
      candidateStripsProjectAdaptations: true,
      sensitiveContentRejected: true,
      approvalDoesNotEnableAnyProject: true,
    },
    version: {
      reauthorizationRequiredForNewSideEffect: true,
      reauthorizationGateNotBypassable: true,
      rollbackKeepsHistory: true,
    },
    isolation: {
      readOnlySelfDeclarationNotTrusted: true,
      missingSandboxRejected: true,
      missingBrokerRejected: true,
      unsupportedPlatformRejected: true,
      arbitraryScriptFallbackDisallowed: true,
      recipeFallbackPreserved: true,
    },
    converter: {
      gatePassed: true,
      conversionSucceeded: true,
      outputIsExpected: true,
      badRowRejected: true,
      determinismVerified: true,
    },
    /** NODECTX-01（与 MERGE-01 同卡）：无损上下文与可见性展示。 */
    losslessContext: {
      isPromptAbsenceShownAsDeletion: false,
      isTextFreeOfDeletionWording: true,
      isContentRetainedOnDisk: true,
      diskFailureKeepsStateUnchanged: true,
      toolPairIsAtomic: true,
      pendingRatificationIsNotShownCompleted: true,
      isStateRestoredAcrossRestart: true,
      isOriginalContentBytesIdenticalAfterRestart: true,
    },
    /** MERGE-01-02：确定性合并资格判定。 */
    instructionMerge: {
      isSwitchInitiallyDisabled: true,
      isRetentionKeptWhenDisabled: true,
      isCrossProjectRejected: true,
      isResultMappedBackToOriginalIds: true,
      isSplitBackLimitedToUnexecuted: true,
      isSideEffectReplayed: false,
    },
    /** MERGE-01 §1.3：参数授权设置变更（放宽须确认）。 */
    parameterAuthorization: {
      isWideningDetected: true,
      isUnconfirmedWideningRejected: true,
      isRejectionSideEffectFree: true,
    },
  };
}

test("全部正常时判据全过且数量固定", () => {
  const checks = buildToolkitPackageChecks(buildPassingObservation());
  assert.ok(checks.length >= 12, "判据数量应覆盖各关键不变量");
  const failed = checks.filter((check) => !check.passed);
  assert.deepEqual(failed, [], "正常观测下不应有失败判据");
});

test("任何必需观测缺失 ⇒ 失败（fail-closed，不得零判据通过）", () => {
  for (const missingKey of [
    "publicEntryExports",
    "recipe",
    "registry",
    "promotion",
    "version",
    "isolation",
    "converter",
  ]) {
    const observation = buildPassingObservation();
    delete observation[missingKey];
    const checks = buildToolkitPackageChecks(observation);
    assert.ok(
      checks.some((check) => !check.passed),
      "缺失 " + missingKey + " 时必须至少失败一条",
    );
  }
  // 完全空的观测也必须失败（绝不允许"零判据通过"）
  const emptyChecks = buildToolkitPackageChecks({});
  assert.ok(emptyChecks.length > 0, "不得返回空判据列表");
  assert.ok(
    emptyChecks.some((check) => !check.passed),
    "空观测必须失败",
  );
});

test("名称不是路由键：按可读名称解析必须为 null，否则失败", () => {
  const observation = buildPassingObservation();
  observation.registry.resolveByReadableNameIsNull = false;
  const checks = buildToolkitPackageChecks(observation);
  assert.ok(
    checks.some((check) => !check.passed && /名称|路由键/.test(check.name)),
    "名称可路由必须判失败",
  );
});

test("不可原地修改：同 ID+版本 换哈希必须被拒，否则失败", () => {
  const observation = buildPassingObservation();
  observation.registry.immutabilityEnforced = false;
  const checks = buildToolkitPackageChecks(observation);
  assert.ok(
    checks.some((check) => !check.passed && /不可原地修改|哈希/.test(check.name)),
    "允许原地改内容必须判失败",
  );
});

test("跨项目隔离：其它项目可发现或可调用必须判失败", () => {
  const discoverable = buildPassingObservation();
  discoverable.registry.otherProjectCannotDiscover = false;
  assert.ok(
    buildToolkitPackageChecks(discoverable).some(
      (check) => !check.passed && /其它项目|发现/.test(check.name),
    ),
  );
  const executable = buildPassingObservation();
  executable.registry.otherProjectCannotExecute = false;
  assert.ok(
    buildToolkitPackageChecks(executable).some(
      (check) => !check.passed && /调用|执行/.test(check.name),
    ),
  );
});

test("复用不是只 import：未执行全部声明工具必须判失败", () => {
  const observation = buildPassingObservation();
  observation.recipe.isReuseProvenNotImportOnly = false;
  observation.recipe.executedToolNames = ["readFile"];
  const checks = buildToolkitPackageChecks(observation);
  assert.ok(
    checks.some((check) => !check.passed && /import|复用/.test(check.name)),
    "只 import 未真实执行必须判失败",
  );
});

test("作者自验必须被拒：未记录拒绝则判失败", () => {
  const observation = buildPassingObservation();
  observation.recipe.rejectedSameAuthorValidation = false;
  const checks = buildToolkitPackageChecks(observation);
  assert.ok(
    checks.some((check) => !check.passed && /自验|独立/.test(check.name)),
    "未拒绝自验必须判失败",
  );
});

test("新增副作用未重新授权必须被拒；且门禁不可旁路", () => {
  const notRequired = buildPassingObservation();
  notRequired.version.reauthorizationRequiredForNewSideEffect = false;
  assert.ok(
    buildToolkitPackageChecks(notRequired).some(
      (check) => !check.passed && /重新授权/.test(check.name),
    ),
  );
  const bypassable = buildPassingObservation();
  bypassable.version.reauthorizationGateNotBypassable = false;
  assert.ok(
    buildToolkitPackageChecks(bypassable).some(
      (check) => !check.passed && /旁路|bypass/.test(check.name),
    ),
  );
});

test("readOnly 自声明被信任 / 缺沙箱 / 缺 broker / 平台不支持 任一未拒绝即失败", () => {
  for (const [key, pattern] of [
    ["readOnlySelfDeclarationNotTrusted", /readOnly|自声明/],
    ["missingSandboxRejected", /沙箱/],
    ["missingBrokerRejected", /broker/],
    ["unsupportedPlatformRejected", /不支持/],
  ]) {
    const observation = buildPassingObservation();
    observation.isolation[key] = false;
    const checks = buildToolkitPackageChecks(observation);
    assert.ok(
      checks.some((check) => !check.passed && pattern.test(check.name)),
      key + " 为 false 时必须判失败",
    );
  }
});

test("任意脚本后备入口必须为 false；配方路径必须保留", () => {
  const arbitrary = buildPassingObservation();
  arbitrary.isolation.arbitraryScriptFallbackDisallowed = false;
  assert.ok(
    buildToolkitPackageChecks(arbitrary).some(
      (check) => !check.passed && /脚本|后备/.test(check.name),
    ),
  );
  const noRecipe = buildPassingObservation();
  noRecipe.isolation.recipeFallbackPreserved = false;
  assert.ok(
    buildToolkitPackageChecks(noRecipe).some(
      (check) => !check.passed && /配方/.test(check.name),
    ),
  );
});

test("转换器：坏行未被拒或确定性未验证必须判失败", () => {
  const badRow = buildPassingObservation();
  badRow.converter.badRowRejected = false;
  assert.ok(
    buildToolkitPackageChecks(badRow).some(
      (check) => !check.passed && /坏行|列数|拒绝/.test(check.name),
    ),
  );
  const nondeterministic = buildPassingObservation();
  nondeterministic.converter.determinismVerified = false;
  assert.ok(
    buildToolkitPackageChecks(nondeterministic).some(
      (check) => !check.passed && /确定性/.test(check.name),
    ),
  );
});

test("判据名称唯一（避免两个 check 同名导致核对困难）", () => {
  const checks = buildToolkitPackageChecks(buildPassingObservation());
  const names = checks.map((check) => check.name);
  assert.equal(new Set(names).size, names.length, "判据名称必须唯一");
});
