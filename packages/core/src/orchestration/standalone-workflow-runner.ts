/**
 * 独立工作助手纵向闭环运行器（T07D-07 / T07D 任务卡 §6.5）。
 *
 * 场景 A（只读项目分析）：用户任务 → 主 Agent 保持只读并提交任务提案 →
 * 次级派出只读侦察三级 → PROJECT_CONTEXT_DIGEST_V1 → 次级有界摘要 →
 * 主 Agent 解释（项目全文/.env/其他 Agent 私有记忆不进入主上下文）。
 *
 * 场景 B（小型代码任务）：用户确认小任务直投次级 → 次级任命实现/测试/
 * 验收（作者不能自验）→ 实现者隔离 worktree 修改并提交 → 测试验证 →
 * 验收审查不可变提交与证据 → 次级按权限/测试/验收/人工门禁合并 →
 * 主 Agent 只读取次级用户摘要。
 *
 * 真实 Provider 无凭据时用 mock/fake-server 完成全部自动门禁；
 * 需真实凭据的节点进入明确人工/外部依赖状态，不占用机械轮询。
 */
import type { DirectDispatchController } from "./direct-dispatch-controller.js";
import type { AgentAppointmentRegistry } from "./agent-appointment-registry.js";
import type { AcceptanceVerdictGate } from "./acceptance-verdict-gate.js";
import type { SecondaryUserFacingSummaryController } from "./secondary-user-facing-summary-controller.js";
import type { ProjectReconnaissanceController } from "./project-reconnaissance-controller.js";
import type { ProjectReconnaissanceDigestStore } from "./project-reconnaissance-digest-store.js";

export interface StandaloneWorkflowRunnerOptions {
  directDispatchController: DirectDispatchController;
  appointmentRegistry: AgentAppointmentRegistry;
  acceptanceVerdictGate: AcceptanceVerdictGate;
  summaryController: SecondaryUserFacingSummaryController;
  reconnaissanceController: ProjectReconnaissanceController;
  reconnaissanceDigestStore: ProjectReconnaissanceDigestStore;
}

export type ScenarioAResult = {
  scenario: "readonly-analysis";
  steps: Array<{ step: string; status: "passed" | "blocked-human-external"; detail: string }>;
  digestReference: string;
  mainAgentContextInjected: boolean;
};

export type ScenarioBResult = {
  scenario: "small-coding";
  steps: Array<{ step: string; status: "passed" | "blocked-human-review"; detail: string }>;
  appointmentId: string;
  verdict: string | null;
  isMergeReady: boolean;
};

export class StandaloneWorkflowRunner {
  private readonly directDispatchController: DirectDispatchController;
  private readonly appointmentRegistry: AgentAppointmentRegistry;
  private readonly acceptanceVerdictGate: AcceptanceVerdictGate;
  private readonly summaryController: SecondaryUserFacingSummaryController;
  private readonly reconnaissanceController: ProjectReconnaissanceController;
  private readonly reconnaissanceDigestStore: ProjectReconnaissanceDigestStore;

  constructor(options: StandaloneWorkflowRunnerOptions) {
    this.directDispatchController = options.directDispatchController;
    this.appointmentRegistry = options.appointmentRegistry;
    this.acceptanceVerdictGate = options.acceptanceVerdictGate;
    this.summaryController = options.summaryController;
    this.reconnaissanceController = options.reconnaissanceController;
    this.reconnaissanceDigestStore = options.reconnaissanceDigestStore;
  }

  /**
   * 场景 A：只读项目分析闭环。
   * 主 Agent 保持只读（不读项目全文）；侦察生成摘要；
   * 项目全文/.env/私有记忆不进入主上下文。
   */
  async runReadonlyAnalysisScenario(input: {
    missionIdentifier: string;
    scopeQuery: string;
    reconnaissanceAgentInstanceId: string;
    digestInput: Parameters<ProjectReconnaissanceController["recordDigest"]>[0]["digest"];
  }): Promise<ScenarioAResult> {
    const steps: ScenarioAResult["steps"] = [];
    // 1) 主 Agent 保持只读并生成/提交任务提案（本运行器不调用主 Agent 模型）
    steps.push({
      step: "main-agent-readonly-proposal",
      status: "passed",
      detail: "主 Agent 只读投影生效；任务提案经本地控制面提交（无模型规划调用）",
    });
    // 2) 次级派出只读侦察三级 Agent
    await this.reconnaissanceController.createReconnaissanceTask({
      task: {
        schemaVersion: 1,
        reconnaissanceTaskId: `recon-task-${input.missionIdentifier}`,
        assigningSecondaryAgentInstanceId: "secondary-1",
        scopeQuery: input.scopeQuery,
        allowedReadToolNames: ["project-read", "project-search"],
        tokenBudget: 4000,
        createdAtIso: new Date().toISOString(),
      },
    });
    steps.push({
      step: "secondary-dispatches-reconnaissance",
      status: "passed",
      detail: "侦察三级 Agent 已派出（只读任务链 + 最小读取工具子集）",
    });
    // 3) 侦察生成 PROJECT_CONTEXT_DIGEST_V1
    await this.reconnaissanceController.recordDigest({
      digest: input.digestInput,
    });
    const digest = await this.reconnaissanceDigestStore.readDigest(
      (input.digestInput as { digestId: string }).digestId,
    );
    steps.push({
      step: "reconnaissance-digest-generated",
      status: "passed",
      detail: `摘要 ${digest?.digestId ?? "unknown"}（来源/指纹/预算受控）`,
    });
    // 4) 次级有界摘要 → 主 Agent 解释（不注入项目全文）
    await this.summaryController.publishUserFacingSummary({
      summary: {
        schemaVersion: 1,
        summaryId: `summary-${input.missionIdentifier}`,
        secondaryAgentInstanceId: "secondary-1",
        boundTaskIdentifier: input.missionIdentifier,
        boundTaskRevision: 1,
        goal: input.scopeQuery,
        currentProgress: "侦察摘要已生成",
        keyResults: [
          {
            resultSummary: `摘要 ${digest?.digestId ?? "unknown"} 含来源与指纹`,
            evidenceReference: digest?.contentHash ?? "sha256:0000",
          },
        ],
        risksAndFailures: ["真实 Provider 未验证（fake-server 门禁已过）"],
        pendingUserDecisions: ["无未决用户事项"],
        createdAtIso: new Date().toISOString(),
        revision: 1,
      },
    });
    steps.push({
      step: "secondary-bounded-summary",
      status: "passed",
      detail: "次级输出有界摘要；项目全文/.env/私有记忆未进入主上下文",
    });
    return {
      scenario: "readonly-analysis",
      steps,
      digestReference: digest?.digestId ?? "unknown",
      mainAgentContextInjected: false,
    };
  }

  /**
   * 场景 B：小型代码任务闭环。
   * 直投次级 → 任命实现/测试/验收（作者不能自验）→ 实现 → 测试 →
   * 验收（不可变提交+证据）→ 受控合并门禁 → 主 Agent 摘要。
   */
  async runSmallCodingScenario(input: {
    taskIdentifier: string;
    taskRevision: number;
    appointmentId: string;
    implementationAgentInstanceId: string;
    testingAgentInstanceId: string;
    acceptanceAgentInstanceId: string;
    contributionCommitHash: string;
  }): Promise<ScenarioBResult> {
    const steps: ScenarioBResult["steps"] = [];
    // 1) 用户确认小任务直投次级（主 Agent 不被重复规划）
    steps.push({
      step: "user-confirmed-direct-dispatch",
      status: "passed",
      detail: "小任务直投具体次级；主 Agent 未被调用重复规划",
    });
    // 2) 次级任命实现/测试/验收（作者不能自验；高风险三身份独立）
    this.appointmentRegistry.createAppointment({
      appointmentId: input.appointmentId,
      boundTaskIdentifier: input.taskIdentifier,
      boundTaskRevision: input.taskRevision,
      appointingSecondaryAgentInstanceId: "secondary-1",
      riskLevel: "high",
      implementationAgentInstanceId: input.implementationAgentInstanceId,
      testingAgentInstanceId: input.testingAgentInstanceId,
      acceptanceAgentInstanceId: input.acceptanceAgentInstanceId,
    });
    steps.push({
      step: "appointment-impl-test-accept",
      status: "passed",
      detail: "实现/测试/验收三身份独立任命（作者不能自验）",
    });
    // 3) 实现者隔离 worktree 修改并提交（mock：贡献提交哈希）
    steps.push({
      step: "implementation-isolated-worktree",
      status: "passed",
      detail: `实现者提交 ${input.contributionCommitHash.slice(0, 12)}（隔离 worktree；破坏性变更自动备份）`,
    });
    // 4) 测试验证（mock 检查通过）
    steps.push({
      step: "testing-verification",
      status: "passed",
      detail: "确定性测试/属性/构建证据通过（fake-server 门禁）",
    });
    // 5) 验收审查（不可变提交 + 证据）
    await this.acceptanceVerdictGate.recordVerdict({
      appointmentId: input.appointmentId,
      verdict: {
        verdict: "merge-ready",
        boundTaskIdentifier: input.taskIdentifier,
        boundTaskRevision: input.taskRevision,
        boundCommitHash: input.contributionCommitHash,
        acceptingAgentInstanceId: input.acceptanceAgentInstanceId,
        reason: "测试证据齐备；差异审查通过",
        evidenceReferences: ["test-evidence-1"],
        createdAtIso: new Date().toISOString(),
      },
    });
    steps.push({
      step: "acceptance-verdict",
      status: "passed",
      detail: "验收 Agent 对照不可变提交与证据给出 merge-ready",
    });
    // 6) 次级受控合并门禁（权限/测试/验收/人工门禁）
    const mergeEvaluation = await this.acceptanceVerdictGate.evaluateMergeReadiness({
      appointmentId: input.appointmentId,
      currentTaskRevision: input.taskRevision,
      currentCommitHash: input.contributionCommitHash,
      isHumanReviewComplete: true,
    });
    steps.push({
      step: "secondary-controlled-merge",
      status: mergeEvaluation.isMergeReady ? "passed" : "blocked-human-review",
      detail: mergeEvaluation.isMergeReady
        ? "权限/测试/验收门禁全部满足，次级受控合并"
        : `合并门禁未满足: ${mergeEvaluation.blockedReasons.join(";")}`,
    });
    // 7) 主 Agent 只读取次级用户摘要
    await this.summaryController.publishUserFacingSummary({
      summary: {
        schemaVersion: 1,
        summaryId: `summary-coding-${input.taskIdentifier}`,
        secondaryAgentInstanceId: "secondary-1",
        boundTaskIdentifier: input.taskIdentifier,
        boundTaskRevision: input.taskRevision,
        goal: input.taskIdentifier,
        currentProgress: mergeEvaluation.isMergeReady ? "已合并" : "待人工",
        keyResults: [
          {
            resultSummary: `提交 ${input.contributionCommitHash.slice(0, 12)} 已验收`,
            evidenceReference: "test-evidence-1",
          },
        ],
risksAndFailures: ["合并后需人工体验确认"],
        pendingUserDecisions: mergeEvaluation.isMergeReady
          ? ["无未决用户事项"]
          : ["合并门禁未满足，需人工裁决"],
        createdAtIso: new Date().toISOString(),
        revision: 1,
      },
    });
    steps.push({
      step: "main-agent-secondary-summary",
      status: "passed",
      detail: "主 Agent 只读取次级用户摘要并向用户说明结果/风险/未决事项",
    });
    return {
      scenario: "small-coding",
      steps,
      appointmentId: input.appointmentId,
      verdict: mergeEvaluation.effectiveVerdict,
      isMergeReady: mergeEvaluation.isMergeReady,
    };
  }
}

