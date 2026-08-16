/**
 * 安装门禁执行守卫（B6R-02 / ADR-0019）。
 * 所有进程、代码库取得、依赖解析和安装类工具在实际执行前经过分类与
 * T06E 两阶段门禁：
 *   classify → 非安装放行
 *           → 安装：询问是否已有资源（挂起等待用户）
 *               → 已有且验证通过 → 复用放行
 *               → 已有但验证失败 → 返回差异等待用户决定（不得自动安装）
 *               → 没有 → 检查独立开关（默认 false）
 *                   → 关闭 → 拒绝
 *                   → 开启 → 精确计划 allow-once 授权 → 执行前复检 → 消费 → 放行
 * 等待用户时不持有文件/任务/包管理器锁；Headless 无可信交互通道时 fail-closed。
 */
import { DomainError } from "../core/errors.js";
import type { InstallationOperationClassifier } from "./installation-operation-classifier.js";
import type {
  AssistInstallationRequest,
  ExistingResourceAnswer,
  ExistingResourceInquiry,
  ResourceReadonlyVerificationPort,
} from "./assist-installation-gate.js";
import type {
  AssistInstallationAuthorizationController,
  ExistingResourceInquiryController,
} from "./assist-installation-gate.js";

/** 用户交互端口（CLI/TUI 装配；不可信通道必须 fail-closed）。 */
export interface InstallationGateUserPort {
  /** 安装前询问是否已有资源；返回回答或 null（用户超时/无通道 → fail-closed）。 */
  askExistingResource(
    inquiry: ExistingResourceInquiry,
  ): Promise<ExistingResourceAnswer | null>;
  /** 展示精确安装计划并请求 allow-once；返回决定或 null（超时/无通道 → fail-closed）。 */
  askAllowOnce(request: AssistInstallationRequest): Promise<"allow-once" | "deny" | null>;
}

export interface InstallationGateGuardOptions {
  classifier: InstallationOperationClassifier;
  inquiryController: ExistingResourceInquiryController;
  authorizationController: AssistInstallationAuthorizationController;
  userPort: InstallationGateUserPort | null;
  /** 认证用户 ID（harness 注入）。 */
  authenticatedUserId: string;
  /** 当前模式（可信运行时提供）。 */
  getCurrentMode: () => "ponder" | "assist" | "devolve";
  /** 只读资源验证端口（可选）。 */
  verificationPort?: ResourceReadonlyVerificationPort | null;
}

export type InstallationGateDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export class InstallationGateGuard {
  private readonly classifier: InstallationOperationClassifier;
  private readonly inquiryController: ExistingResourceInquiryController;
  private readonly authorizationController: AssistInstallationAuthorizationController;
  private readonly userPort: InstallationGateUserPort | null;
  private readonly authenticatedUserId: string;
  private readonly getCurrentMode: () => "ponder" | "assist" | "devolve";

  constructor(options: InstallationGateGuardOptions) {
    this.classifier = options.classifier;
    this.inquiryController = options.inquiryController;
    this.authorizationController = options.authorizationController;
    this.userPort = options.userPort ?? null;
    this.authenticatedUserId = options.authenticatedUserId;
    this.getCurrentMode = options.getCurrentMode;
  }

  /**
   * 工具执行前调用：对安装类调用执行两阶段门禁。
   * commandName/arguments 来自受控工具参数（不经 shell）。
   */
  async assertInstallationAllowed(input: {
    commandName: string;
    arguments: string[];
    requestingAgentInstanceId: string;
    taskExecutionId: string;
  }): Promise<InstallationGateDecision> {
    const classification = this.classifier.classifyCommand({
      commandName: input.commandName,
      arguments: input.arguments,
      workingDirectoryPath: null,
    });
    if (!classification.isInstallationAttempt) {
      return { allowed: true };
    }
    if (this.getCurrentMode() !== "assist") {
      // 安装门禁只约束 Assist；其他模式由各自权限策略处理
      return { allowed: false, reason: "安装尝试需经 Assist 门禁" };
    }
    if (this.userPort === null) {
      return { allowed: false, reason: "无可信交互通道，安装被拒绝（fail-closed）" };
    }
    // 阶段 1：询问是否已有资源
    const inquiry = this.inquiryController.createInquiry({
      authenticatedUserId: this.authenticatedUserId,
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      taskExecutionId: input.taskExecutionId,
      requiredCapabilitySummary: `安装 ${classification.detectedTarget ?? input.commandName}`,
      intendedUse: "任务执行所需依赖/工具",
      compatibleCandidateTypes: [],
    });
    const answer = await this.userPort.askExistingResource(inquiry);
    if (answer === null) {
      return { allowed: false, reason: "用户未回答已有资源询问，安装被拒绝（fail-closed）" };
    }
    const answerResult = await this.inquiryController.handleAnswer({
      inquiry,
      authenticatedUserId: this.authenticatedUserId,
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      taskExecutionId: input.taskExecutionId,
      answer,
    });
    if (answerResult.outcome === "resource-accepted") {
      return { allowed: true };
    }
    if (answerResult.outcome === "resource-rejected-with-differences") {
      // 已有资源但验证失败：回到用户决定，不得自动安装
      return {
        allowed: false,
        reason: `已有资源验证失败（差异: ${answerResult.verification.differences.join("；")}），请用户决定`,
      };
    }
    // 阶段 2：开关 + allow-once
    const requestResult = await this.authorizationController.createAuthorizationRequest({
      inquiryReceipt: this.inquiryController.readReceipt(inquiry.inquiryId)!,
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      taskExecutionId: input.taskExecutionId,
      userDecisionReference: `install-user-decision-${Date.now()}`,
      sourceUrlOrRegistry: "unknown-registry",
      packageOrRepositoryIdentifier: classification.detectedTarget ?? input.commandName,
      pinnedVersionOrCommit: classification.pinnedVersionOrCommit,
      integrityInformation: null,
      targetPathOrScope: "workspace",
      packageManager: input.commandName,
      parametersJson: JSON.stringify(input.arguments),
      requiresNetwork: true,
      hasInstallScripts: true,
      expectedChangesSummary: `安装 ${classification.detectedTarget ?? input.commandName}`,
    });
    if (requestResult.outcome === "denied-settings-disabled") {
      return { allowed: false, reason: "安装开关默认关闭，安装被拒绝" };
    }
    if (requestResult.outcome === "denied-invalid-inquiry-receipt") {
      return { allowed: false, reason: "询问回执无效，安装被拒绝" };
    }
    const allowOnceDecision = await this.userPort.askAllowOnce(requestResult.request);
    if (allowOnceDecision === null || allowOnceDecision === "deny") {
      return { allowed: false, reason: "用户拒绝本次安装授权" };
    }
    const authorization = await this.authorizationController.authorizeAllowOnce({
      request: requestResult.request,
      decision: "allow-once",
    });
    if (authorization === null) {
      return { allowed: false, reason: "授权失败（allow-once 不可重复使用）" };
    }
    const verification = await this.authorizationController.verifyAndConsumeAuthorization({
      request: requestResult.request,
      currentMode: this.getCurrentMode(),
    });
    if (!verification.allowed) {
      return { allowed: false, reason: `执行前复检失败: ${verification.reason}` };
    }
    return { allowed: true };
  }

  /** 供调用方构造拒绝 DomainError。 */
  static buildDenial(reason: string): DomainError {
    return new DomainError("tool-permission-denied", `安装门禁拒绝: ${reason}`);
  }
}
