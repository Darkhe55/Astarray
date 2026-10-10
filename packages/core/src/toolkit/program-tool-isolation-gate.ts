/**
 * TOOLKIT-01-05：受控**确定性程序工具**的隔离边界门禁（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md`
 * §7 与检查点 05。
 *
 * 本模块只做**本地确定性判定**：不执行程序、不做 I/O、不联网、不读凭据。
 *
 * 卡内硬要求逐条落实：
 *  - **程序工具不能凭 `readOnly` 自声明成为安全工具** ⇒ 自声明与实际情况矛盾即拒绝；
 *  - **纯转换**（无文件/进程/网络副作用）在具备可强制执行沙箱时可启用；
 *  - 涉及**文件/进程/网络**必须**同时**具备可强制执行的沙箱与受控 broker，缺一即拒绝；
 *  - 平台**无法兑现所需隔离** ⇒ **拒绝启用并报告不支持**，且提示**保留配方路径**；
 *  - 首版**不增加任意脚本后备入口** ⇒ 结果显式给出 `isArbitraryScriptFallbackAllowed: false`；
 *  - **有界依赖深度与执行预算**（恰好等于上限应被接受）。
 */

/** 程序工具可能需要的能力（卡内点名的三类敏感能力用显式名字）。 */
export type ProgramToolCapability =
  | "file-read"
  | "file-write"
  | "process-execute"
  | "network-access";

/** **需要沙箱 + 受控 broker 双备**的能力（卡内："涉及文件/进程/网络"）。 */
const CAPABILITIES_REQUIRING_SANDBOX_AND_BROKER: readonly ProgramToolCapability[] = [
  "file-read",
  "file-write",
  "process-execute",
  "network-access",
];

export interface ProgramToolDeclaration {
  toolPackageId: string;
  version: number;
  /** `sha256:<64 hex>`。 */
  contentHash: string;
  /**
   * **作者自声明**的只读性。
   *
   * 卡内明文：该声明**不构成信任**（不能凭它成为安全工具）。
   * 本门禁只把它当作"待核对的声明"，与实际副作用/能力申请交叉校验。
   */
  readOnlySelfDeclaration: boolean;
  /** 该程序工具**申请**的能力。 */
  requiredCapabilities: ProgramToolCapability[];
  /** 该程序工具**声明**的副作用（`none` 表示无副作用）。 */
  declaredSideEffects: ProgramToolCapability[] | ["none"];
  /** 依赖深度（有界；超出平台上限即拒绝）。 */
  dependencyDepth: number;
  /** 单次执行预算（毫秒，有界）。 */
  executionBudgetMilliseconds: number;
}

export interface SandboxCapabilityProfile {
  platformIdentifier: string;
  /** 是否存在**可强制执行**的沙箱（不是提示词或静态扫描）。 */
  hasEnforceableSandbox: boolean;
  /** 是否存在**受控 broker**。 */
  hasControlledBroker: boolean;
  /** 该平台**实际支持**的能力。 */
  supportedCapabilities: ProgramToolCapability[];
  maximumDependencyDepth: number;
  maximumExecutionBudgetMilliseconds: number;
}

export interface ProgramToolEnablementOutcome {
  isEnabled: boolean;
  reason: string | null;
  /** 平台不支持的能力（非空表示"报告不支持"）。 */
  unsupportedCapabilities: ProgramToolCapability[];
  /**
   * 被拒绝时保留的既有路径。
   *
   * 卡内："保留已有工具配方路径" ⇒ 恒为 `recipe-only`（配方仍可用）。
   */
  fallbackPath: "recipe-only";
  /**
   * 是否允许"任意脚本后备入口"。
   *
   * 卡内："首版**不增加任意脚本后备入口**" ⇒ **恒为 false**（不可配置）。
   */
  isArbitraryScriptFallbackAllowed: false;
}

/** 声明无副作用时使用的哨兵值。 */
const NO_SIDE_EFFECT_SENTINEL = "none";

function declaredEffectCapabilities(
  declaration: ProgramToolDeclaration,
): ProgramToolCapability[] {
  return declaration.declaredSideEffects.filter(
    (sideEffect): sideEffect is ProgramToolCapability =>
      sideEffect !== NO_SIDE_EFFECT_SENTINEL,
  );
}

function buildRejection(
  reason: string,
  unsupportedCapabilities: ProgramToolCapability[] = [],
): ProgramToolEnablementOutcome {
  return {
    isEnabled: false,
    reason,
    unsupportedCapabilities,
    fallbackPath: "recipe-only",
    isArbitraryScriptFallbackAllowed: false,
  };
}

/**
 * 判定是否**允许启用**该确定性程序工具。
 *
 * 判定顺序（任一不满足即拒绝，且给出**可读原因**）：
 *  1. `readOnly` 自声明与实际矛盾（自声明只读却要文件/进程/网络能力，或声明了副作用）；
 *  2. 声明与能力申请自相矛盾（声明无副作用却申请了敏感能力）；
 *  3. 涉及文件/进程/网络但平台缺**沙箱**或**broker**；
 *  4. 平台**不支持**所需能力（报告不支持并保留配方路径）；
 *  5. 依赖深度或执行预算越界。
 */
export function evaluateProgramToolEnablement(input: {
  declaration: ProgramToolDeclaration;
  platform: SandboxCapabilityProfile;
}): ProgramToolEnablementOutcome {
  const { declaration, platform } = input;
  const declaredEffects = declaredEffectCapabilities(declaration);
  const requiresSensitiveCapability = declaration.requiredCapabilities.some(
    (capability) => CAPABILITIES_REQUIRING_SANDBOX_AND_BROKER.includes(capability),
  );

  /**
   * ① `readOnly` 自声明不构成信任。
   *
   * 自声明只读，却申请了文件/进程/网络能力，或声明了任何副作用 ⇒ 声明与实际矛盾，
   * 必须拒绝：否则"作者写个 readOnly: true"就能把危险程序工具变成"安全工具"。
   */
  if (declaration.readOnlySelfDeclaration) {
    const contradictoryCapabilities = declaration.requiredCapabilities.filter(
      (capability) => CAPABILITIES_REQUIRING_SANDBOX_AND_BROKER.includes(capability),
    );
    if (contradictoryCapabilities.length > 0) {
      return buildRejection(
        "readOnly 自声明与实际能力申请矛盾（自声明不构成信任）: " +
          contradictoryCapabilities.join(","),
      );
    }
    if (declaredEffects.length > 0) {
      return buildRejection(
        "readOnly 自声明与实际声明的副作用矛盾（自声明不构成信任）: " +
          declaredEffects.join(","),
      );
    }
  }

  /** ② 声明与能力申请自相矛盾：声称无副作用却申请敏感能力。 */
  if (declaredEffects.length === 0 && requiresSensitiveCapability) {
    return buildRejection(
      "声明无副作用却申请了文件/进程/网络能力（声明与实际不一致）",
    );
  }

  /**
   * ③ 平台**不支持**所需能力 ⇒ 报告不支持并保留配方路径。
   *
   * **必须排在沙箱/broker 检查之前**（2026-10-10 由反例 ⑦b 暴露）：
   * 若先报"缺沙箱"，用户会以为"补个沙箱就行"，而实际上该平台根本不支持该能力；
   * 卡内要求的是"**未支持环境明确拒绝**并报告不支持"。
   */
  const unsupportedCapabilities = declaration.requiredCapabilities.filter(
    (capability) => !platform.supportedCapabilities.includes(capability),
  );
  if (unsupportedCapabilities.length > 0) {
    return buildRejection(
      "目标平台不支持所需能力，拒绝启用该程序工具；请保留已有工具**配方路径**: " +
        unsupportedCapabilities.join(","),
      unsupportedCapabilities,
    );
  }

  /** ④ 涉及文件/进程/网络 ⇒ 必须沙箱 + broker 双备。 */
  if (requiresSensitiveCapability) {
    if (!platform.hasEnforceableSandbox) {
      return buildRejection(
        "涉及文件/进程/网络的程序工具需要**可强制执行的沙箱**，当前平台不具备",
      );
    }
    if (!platform.hasControlledBroker) {
      return buildRejection(
        "涉及文件/进程/网络的程序工具需要**受控 broker**，当前平台不具备",
      );
    }
  }

  /** ⑤ 有界依赖深度与执行预算（恰好等于上限应被接受）。 */
  if (declaration.dependencyDepth > platform.maximumDependencyDepth) {
    return buildRejection(
      "依赖深度 " +
        String(declaration.dependencyDepth) +
        " 超出平台上限 " +
        String(platform.maximumDependencyDepth),
    );
  }
  if (
    declaration.executionBudgetMilliseconds >
    platform.maximumExecutionBudgetMilliseconds
  ) {
    return buildRejection(
      "执行预算 " +
        String(declaration.executionBudgetMilliseconds) +
        "ms 超出平台上限 " +
        String(platform.maximumExecutionBudgetMilliseconds) +
        "ms",
    );
  }

  return {
    isEnabled: true,
    reason: null,
    unsupportedCapabilities: [],
    fallbackPath: "recipe-only",
    isArbitraryScriptFallbackAllowed: false,
  };
}
