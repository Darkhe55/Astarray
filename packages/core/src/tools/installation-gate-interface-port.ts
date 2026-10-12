/**
 * GUI-02-02 专用流程（2026-10-12）：**面向界面控制的安装门禁用户通道**。
 *
 * 定位：`InstallationGateUserPort` 的**界面侧实现** —— 把门禁的两个提问
 * （是否已有资源 / 是否允许本次安装）落成**待决记录**，交由界面（GUI 卡片或 CLI 提示）
 * 回答；**未回答 / 超时 / 取消 ⇒ `null` ⇒ 门禁 fail-closed**。
 *
 * 为什么放在核心而非 GUI 包：**核心不得依赖 GUI 包**（架构守卫）。
 * 本类只依赖核心内部的注册表与领域类型，界面侧通过门禁动作读取/回答。
 *
 * 安全性质：
 * - **不做授权决定**：只把用户回答原样交给门禁；判定仍由门禁与授权控制器完成；
 * - **不存凭据**；记录只含界面判断所需字段；
 * - 回答必须匹配询问自身 `revision`（由注册表强制）；
 * - 超时上限**有界**（构造参数，必须为正数）。
 */
import type { InstallationGateUserPort } from "./installation-gate-guard.js";
import type { AssistInstallationRequest, ExistingResourceInquiry } from "./assist-installation-gate.js";
import type {
  InstallationInquiryRegistry,
  InstallationInquiryAnswer,
} from "./installation-inquiry-registry.js";

/** 门禁用户通道的界面侧实现参数。 */
export interface InstallationGateInterfacePortOptions {
  registry: InstallationInquiryRegistry;
  /** 单次询问的等待上限（毫秒，必须为正数；到时即 fail-closed）。 */
  inquiryTimeoutMilliseconds: number;
  /** 是否具备可信交互通道（false ⇒ 一律返回 null，fail-closed）。 */
  isInteractive: () => boolean;
  /** 诊断输出（默认静默；不得写入 stdout 以免污染 JSON）。 */
  writeDiagnostic?: (message: string) => void;
}

/**
 * 把 `ExistingResourceInquiry` 归一为界面所需摘要（不引入额外内部字段）。
 */
export class InstallationGateInterfacePort implements InstallationGateUserPort {
  private readonly registry: InstallationInquiryRegistry;
  private readonly inquiryTimeoutMilliseconds: number;
  private readonly isInteractive: () => boolean;
  private readonly writeDiagnostic: (message: string) => void;

  constructor(options: InstallationGateInterfacePortOptions) {
    if (!(options.inquiryTimeoutMilliseconds > 0)) {
      throw new Error(
        "安装询问超时上限必须为正数毫秒: " +
          String(options.inquiryTimeoutMilliseconds),
      );
    }
    this.registry = options.registry;
    this.inquiryTimeoutMilliseconds = options.inquiryTimeoutMilliseconds;
    this.isInteractive = options.isInteractive;
    this.writeDiagnostic = options.writeDiagnostic ?? (() => {});
  }

  /**
   * 阶段 1：询问是否已有满足任务的资源。
   *
   * 返回 `null`（无交互通道 / 超时 / 取消）⇒ 门禁判「用户未回答已有资源询问」并拒绝。
   */
  async askExistingResource(
    inquiry: ExistingResourceInquiry,
  ): Promise<InstallationInquiryAnswer | null> {
    if (!this.isInteractive()) {
      return null;
    }
    const record = this.registry.register({
      stage: "existing-resource",
      /**
       * 说明：`ExistingResourceInquiry` **不含**发起个体与任务执行 ID
       * （它们在门禁随后构造的**回执**里回填）。此处以界面会话作为记录所有者 ——
       * 真正与 Agent/任务绑定的是门禁写入的回执，**本通道不参与该绑定**。
       */
      requestingAgentInstanceId: "interface-session",
      taskExecutionId: inquiry.inquiryId,
      summary: inquiry.requiredCapabilitySummary,
    });
    this.writeDiagnostic(
      `[安装门禁] 待用户回答「是否已有资源」：${record.inquiryIdentifier}`,
    );
    const answer = await this.registry.waitForAnswer(
      record.inquiryIdentifier,
      this.inquiryTimeoutMilliseconds,
    );
    if (answer === null) {
      return null;
    }
    // 阶段 1 的回答形态与 `ExistingResourceAnswer` 结构兼容。
    return answer as InstallationInquiryAnswer;
  }

  /**
   * 阶段 2：展示**精确安装计划**并请求 `allow-once`。
   *
   * 返回 `null`（无通道 / 超时 / 取消）或 `"deny"` ⇒ 门禁拒绝本次安装。
   */
  async askAllowOnce(
    request: AssistInstallationRequest,
  ): Promise<"allow-once" | "deny" | null> {
    if (!this.isInteractive()) {
      return null;
    }
    const record = this.registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: request.requestingAgentInstanceId,
      taskExecutionId: request.taskExecutionId,
      summary: `安装 ${request.packageOrRepositoryIdentifier}`,
      installationPlan: {
        packageOrRepositoryIdentifier: request.packageOrRepositoryIdentifier,
        pinnedVersionOrCommit: request.pinnedVersionOrCommit ?? null,
        targetPathOrScope: request.targetPathOrScope,
        packageManager: request.packageManager,
        expectedChangesSummary: request.expectedChangesSummary,
        requiresNetwork: request.requiresNetwork,
        hasInstallScripts: request.hasInstallScripts,
        parametersJson: request.parametersJson,
      },
    });
    this.writeDiagnostic(
      `[安装门禁] 待用户回答「是否允许本次安装」：${record.inquiryIdentifier}`,
    );
    const decision = await this.registry.waitForAnswer(
      record.inquiryIdentifier,
      this.inquiryTimeoutMilliseconds,
    );
    if (decision === null) {
      return null;
    }
    return decision as "allow-once" | "deny";
  }
}
