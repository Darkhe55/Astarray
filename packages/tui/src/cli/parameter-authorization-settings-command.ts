
/* ────────── MERGE-01 §1.3 第 4 项：参数授权设置入口（CLI） ────────── */

import { EXIT_CODES, failWith, logToStderr, printJson } from "./json-output.js";

import type { ToolAuthorizationShape } from "../../../core/src/public-sdk.js";

export interface ParameterAuthorizationSettingsCommandOptions {
  stateDirectory: string;
  isJsonOutput: boolean;
  /** 是否关闭"每工具细分"开关（默认不改）。 */
  shouldDisableGranularity: boolean;
  /** 是否关闭总开关（默认不改）。 */
  shouldDisableParameterAuthorization: boolean;
  /**
   * 工具授权形态（用于**放宽判定**），格式：
   * `工具名:统一效果:规则ID=效果,规则ID=效果`（规则段可省略）。
   */
  toolAuthorizationShapeSpecifications: string[];
  isConfirmedByAuthenticatedUser: boolean;
}

/** 解析 `工具名:统一效果[:规则ID=效果,...]`。 */
function parseToolAuthorizationShapeSpecification(
  specification: string,
): { shape: ToolAuthorizationShape } | { reason: string } {
  const segments = specification.split(":");
  if (segments.length < 2) {
    return { reason: "工具授权形态格式应为 工具名:统一效果[:规则ID=效果,...]：" + specification };
  }
  const toolName = segments[0] ?? "";
  const unifiedEffect = segments[1] ?? "";
  const knownEffects = ["deny", "ask", "allow"];
  if (toolName === "" || !knownEffects.includes(unifiedEffect)) {
    return {
      reason:
        "工具名不能为空，且统一效果必须是 deny/ask/allow：" + specification,
    };
  }
  const ruleEffects: Array<{ ruleIdentifier: string; effect: "deny" | "ask" | "allow" }> = [];
  const ruleSegmentText = segments[2] ?? "";
  if (segments.length >= 3 && ruleSegmentText !== "") {
    for (const ruleSegment of ruleSegmentText.split(",")) {
      const [ruleIdentifier, effect] = ruleSegment.split("=");
      if (!ruleIdentifier || !effect || !knownEffects.includes(effect)) {
        return { reason: "规则段格式应为 规则ID=deny|ask|allow：" + ruleSegment };
      }
      ruleEffects.push({
        ruleIdentifier,
        effect: effect as "deny" | "ask" | "allow",
      });
    }
  }
  return {
    shape: {
      toolName,
      unifiedEffect: unifiedEffect as "deny" | "ask" | "allow",
      ruleEffects,
    },
  };
}

/**
 * `settings parameter-authorization`：读取或写入参数授权设置。
 *
 * 卡内 §1.3："**关闭细分若会从 deny/ask 回退 allow，必须明确提示放宽范围，
 * 不以'关闭功能'静默扩大权限**"；"扩大权限需既有认证用户确认"。
 * 本命令**不做自己的判定**，一律走 SDK 的同一实现，保证 CLI/SDK 结论一致。
 */
export async function executeParameterAuthorizationSettingsCommand(
  options: ParameterAuthorizationSettingsCommandOptions,
): Promise<number> {
  try {
    const { AstarrayApplicationFacade } = await import(
      "../../../core/src/public-sdk.js"
    );
    const shapes: ToolAuthorizationShape[] = [];
    for (const specification of options.toolAuthorizationShapeSpecifications) {
      const parsed = parseToolAuthorizationShapeSpecification(specification);
      if ("reason" in parsed) {
        logToStderr(parsed.reason);
        return EXIT_CODES.USAGE_ERROR;
      }
      shapes.push(parsed.shape);
    }

    const application = await AstarrayApplicationFacade.create({
      stateDirectory: options.stateDirectory,
      mode: "assist",
      runtime: "mock",
      statusPollIntervalMilliseconds: 25,
    });
    try {
      const isWriteRequested =
        options.shouldDisableGranularity || options.shouldDisableParameterAuthorization;
      if (!isWriteRequested) {
        const settings = await application.queryParameterAuthorizationSettings();
        if (options.isJsonOutput) {
          printJson({
            isParameterAuthorizationEnabled: settings.isParameterAuthorizationEnabled,
            isParameterRulesEnabled: settings.isParameterRulesEnabled,
            configurationRevision: settings.configurationRevision,
            ruleCount: settings.ruleCount,
          });
        } else {
          process.stdout.write(
            "参数授权总开关: " +
              String(settings.isParameterAuthorizationEnabled) +
              "；每工具细分: " +
              String(settings.isParameterRulesEnabled) +
              "；规则数: " +
              String(settings.ruleCount) +
              "；配置 revision: " +
              String(settings.configurationRevision) +
              "\n",
          );
        }
        return EXIT_CODES.SUCCESS;
      }

      const currentSettings = await application.queryParameterAuthorizationSettings();
      const updateOutcome = await application.updateParameterAuthorizationSettings({
        isParameterAuthorizationEnabled: options.shouldDisableParameterAuthorization
          ? false
          : currentSettings.isParameterAuthorizationEnabled,
        isParameterRulesEnabled: options.shouldDisableGranularity
          ? false
          : currentSettings.isParameterRulesEnabled,
        toolAuthorizationShapes: shapes,
        isConfirmedByAuthenticatedUser: options.isConfirmedByAuthenticatedUser,
      });
      if (!updateOutcome.isAccepted) {
        /**
         * **放宽未确认**：如实报告并给非 0 退出码；**不写任何文件**。
         * 卡内明令"不以'关闭功能'静默扩大权限"。
         */
        logToStderr(String(updateOutcome.reason));
        if (options.isJsonOutput) {
          printJson({
            isAccepted: false,
            reason: updateOutcome.reason,
            widenedPermissions: updateOutcome.widenedPermissions,
            requiresAuthenticatedUserConfirmation:
              updateOutcome.requiresAuthenticatedUserConfirmation,
          });
        }
        return EXIT_CODES.FAILURE;
      }
      if (options.isJsonOutput) {
        printJson({
          isAccepted: true,
          configurationRevision: updateOutcome.configurationRevision,
          effectiveRevision: updateOutcome.effectiveRevision,
          widenedPermissions: updateOutcome.widenedPermissions,
          tightenedPermissions: updateOutcome.tightenedPermissions,
        });
      } else {
        process.stdout.write(
          "设置已保存（配置 revision " +
            String(updateOutcome.configurationRevision) +
            "，生效 revision " +
            String(updateOutcome.effectiveRevision) +
            "）\n",
        );
      }
      return EXIT_CODES.SUCCESS;
    } finally {
      await application.shutdown();
    }
  } catch (error) {
    failWith(error instanceof Error ? error : new Error(String(error)));
  }
}
