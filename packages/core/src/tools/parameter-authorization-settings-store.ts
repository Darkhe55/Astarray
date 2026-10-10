/**
 * MERGE-01 §1.3 第 4 项：参数授权的**设置入口**（2026-10-10）。
 *
 * 卡内要求："参数授权总开关、每工具细分开关和规则列表"必须是一个**设置入口**，
 * 且默认**全部开启**；同时 §1.2 要求规则优先级 deny>ask>allow、认识不到的参数拒绝。
 *
 * 此前这两个开关**只存在于权限引擎的构造参数里**，全仓 TUI/CLI/GUI/设置零入口，
 * 因此"设置入口"在产品层面不成立（TOOLKIT-01-04 也依赖它）。
 *
 * 本模块是**受控持久化层**：只做读写与校验，不做裁决
 * （裁决仍由纯函数 `evaluateParameterAuthorization` 与权限引擎负责，避免两套结论）。
 */

import {
  evaluateParameterAuthorization,
  type ParameterAuthorizationRule,
} from "./parameter-authorization.js";
import { resolveToolAction } from "./tool-action-registry.js";

export const PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION =
  "ASTARRAY_PARAMETER_AUTHORIZATION_SETTINGS_V1";

const SETTINGS_FILE_NAME = "parameter-authorization-settings.json";

export interface ParameterAuthorizationSettingsDocument {
  schemaVersion: string;
  settings: {
    /** 总开关；默认开启（卡内"默认全部开启"）。 */
    isParameterAuthorizationEnabled: boolean;
    /** 每工具细分开关；默认开启。 */
    isParameterRulesEnabled: boolean;
  };
  rules: ParameterAuthorizationRule[];
}

export interface ParameterAuthorizationSettingsStoreOptions {
  stateDirectory: string;
}

export interface ParameterAuthorizationSettingsWriteResult {
  isValid: boolean;
  reason: string | null;
}

/** 默认文档：两个开关都开启、无规则（卡内"默认全部开启"）。 */
function buildDefaultDocument(): ParameterAuthorizationSettingsDocument {
  return {
    schemaVersion: PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
    settings: {
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
    },
    rules: [],
  };
}

export class ParameterAuthorizationSettingsStore {
  private readonly stateDirectory: string;

  constructor(options: ParameterAuthorizationSettingsStoreOptions) {
    this.stateDirectory = options.stateDirectory;
  }

  private get settingsFilePath(): string {
    return `${this.stateDirectory}/${SETTINGS_FILE_NAME}`;
  }

  private get settingsBackupFilePath(): string {
    return `${this.settingsFilePath}.backup`;
  }

  /**
   * 读取设置。
   *
   * 文件不存在 ⇒ 返回**默认值**（两个开关开启）且**不创建文件**：
   * 为了"看一次设置"而写出配置文件会让"用户是否显式改过"无法区分。
   */
  async readSettings(): Promise<ParameterAuthorizationSettingsDocument> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.settingsFilePath,
      this.settingsBackupFilePath,
    );
    if (readResult === null) {
      return buildDefaultDocument();
    }
    const raw = readResult.content as ParameterAuthorizationSettingsDocument;
    // 落盘内容一律重新校验：手工编辑过的坏文件不得被当成有效设置使用。
    const validation = validateSettingsDocument(raw);
    if (!validation.isValid) {
      throw new Error(
        "参数授权设置文件非法（请修正或删除）: " + String(validation.reason),
      );
    }
    return raw;
  }

  /** 写入设置（先校验，非法一律不落盘）。 */
  async writeSettings(
    document: Omit<ParameterAuthorizationSettingsDocument, "schemaVersion"> & {
      schemaVersion?: string;
    },
  ): Promise<ParameterAuthorizationSettingsWriteResult> {
    const candidate: ParameterAuthorizationSettingsDocument = {
      schemaVersion:
        document.schemaVersion ?? PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
      settings: document.settings,
      rules: document.rules,
    };
    const validation = validateSettingsDocument(candidate);
    if (!validation.isValid) {
      return validation;
    }
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    await backupExistingFile(this.settingsFilePath, this.settingsBackupFilePath);
    await writeAtomicJson(this.settingsFilePath, candidate);
    return { isValid: true, reason: null };
  }
}

/**
 * 校验设置文档（**纯函数**、fail-closed）。
 *
 * 拒绝：schemaVersion 不符、开关非布尔、规则非数组、规则缺必需字段、
 * **规则 action 不属于该工具**、**匹配种类未知**、**规则 ID 重复**、
 * 以及规则本身无法被判定器理解（用判定器做一次综合校验）。
 */
export function validateSettingsDocument(
  document: ParameterAuthorizationSettingsDocument,
): ParameterAuthorizationSettingsWriteResult {
  if (
    document === null ||
    typeof document !== "object" ||
    document.schemaVersion !== PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION
  ) {
    return { isValid: false, reason: "schemaVersion 不符或文档结构非法" };
  }
  const settings = document.settings;
  if (settings === null || typeof settings !== "object") {
    return { isValid: false, reason: "settings 缺失" };
  }
  if (
    typeof settings.isParameterAuthorizationEnabled !== "boolean" ||
    typeof settings.isParameterRulesEnabled !== "boolean"
  ) {
    return {
      isValid: false,
      reason: "参数授权开关必须为布尔值（isParameterAuthorizationEnabled/isParameterRulesEnabled）",
    };
  }
  if (!Array.isArray(document.rules)) {
    return { isValid: false, reason: "rules 必须为数组" };
  }
  const seenRuleIdentifiers = new Set<string>();
  for (const rule of document.rules) {
    if (rule === null || typeof rule !== "object") {
      return { isValid: false, reason: "规则项必须为对象" };
    }
    const ruleRecord = rule as unknown as Record<string, unknown>;
    const ruleIdentifier = ruleRecord["ruleIdentifier"];
    if (typeof ruleIdentifier !== "string" || ruleIdentifier === "") {
      return { isValid: false, reason: "规则缺少 ruleIdentifier" };
    }
    if (seenRuleIdentifiers.has(ruleIdentifier)) {
      return {
        isValid: false,
        reason: "规则 ruleIdentifier 重复（后写会静默覆盖前写）: " + ruleIdentifier,
      };
    }
    seenRuleIdentifiers.add(ruleIdentifier);
    if (typeof ruleRecord["toolName"] !== "string" || ruleRecord["toolName"] === "") {
      return { isValid: false, reason: "规则缺少 toolName: " + ruleIdentifier };
    }
    if (typeof ruleRecord["action"] !== "string" || ruleRecord["action"] === "") {
      return { isValid: false, reason: "规则缺少 action: " + ruleIdentifier };
    }
    if (
      ruleRecord["decision"] !== "deny" &&
      ruleRecord["decision"] !== "ask" &&
      ruleRecord["decision"] !== "allow"
    ) {
      return {
        isValid: false,
        reason: "规则 decision 必须是 deny/ask/allow: " + ruleIdentifier,
      };
    }
    const match = ruleRecord["match"];
    if (match === null || typeof match !== "object") {
      return { isValid: false, reason: "规则缺少 match: " + ruleIdentifier };
    }
    const matchKind = (match as Record<string, unknown>)["kind"];
    if (!KNOWN_MATCH_KINDS.includes(matchKind as (typeof KNOWN_MATCH_KINDS)[number])) {
      return {
        isValid: false,
        reason:
          "规则的匹配种类未知（不得使用正则等可执行匹配）: " + String(matchKind),
      };
    }
    /**
     * 综合校验：把规则交给判定器实测。这样"设置里存了判定器不认识的东西"
     * 会在**保存时**暴露，而不是等到执行时才静默失效。
     */
    const probe = evaluateParameterAuthorization({
      toolName: ruleRecord["toolName"] as string,
      action: ruleRecord["action"] as string,
      argumentsJson: "{}",
      baselineDecision: "ask",
      settings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      rules: [rule as unknown as ParameterAuthorizationRule],
    });
    if (probe.isRuleEvaluationSkipped) {
      return {
        isValid: false,
        reason:
          "规则与工具/action 不匹配（判定器未接受该规则）: " + ruleIdentifier,
      };
    }
    /**
     * 还要确认该 action 是**工具真实存在的 action**。
     *
     * 仅靠判定器不够：一个 `action: "not-an-action"` 的规则只是"永不匹配"，
     * 判定器会如常返回（`isRuleEvaluationSkipped=false`），于是这条**永远不生效**的规则
     * 会被静默保存 —— 用户以为配了策略，实际什么都没发生。故显式拒绝。
     */
    const knownAction = resolveToolAction({
      toolNameOrAlias: ruleRecord["toolName"] as string,
      action: ruleRecord["action"] as string,
    });
    if (knownAction === null) {
      return {
        isValid: false,
        reason:
          "规则的 action 不属于该工具（该规则将永不生效，不得静默保存）: " +
          ruleIdentifier +
          " action=" +
          String(ruleRecord["action"]),
      };
    }
  }
  return { isValid: true, reason: null };
}

/** 已登记的匹配种类（与卡内允许的四种一致；**不允许正则/脚本**）。 */
const KNOWN_MATCH_KINDS = [
  "path-prefix",
  "allowed-values",
  "fixed-value",
  "numeric-range",
] as const;
