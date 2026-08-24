/**
 * 人工—Agent 冲突分类器（T05D-04 / ADR-0028 §4）。
 *
 * - 无重叠（路径与契约均不相交）→ no-overlap-revalidate：验证人工新
 *   基线后重新运行差异审查与相关测试；
 * - 文本重叠（同一路径）→ text-conflict-reconcile：需协调 Agent；
 *   原实现者不能单独宣布解决；
 * - 契约重叠（路径不同但共享公共契约）→ contract-conflict-reconcile：
 *   冻结相关实现/测试/验收节点并生成影响清单；
 * - 行为冲突（测试/验收/人工体验不一致）→ 返修（blocked-human-review）；
 * - Git 无文本冲突不代表语义兼容；未知情况 fail-closed。
 */
import { DomainError } from "../core/errors.js";
import { CONCURRENT_CHANGE_DECISION_VALUES } from "./human-agent-concurrent-change-schemas.js";
import type { ConcurrentChangeDecision } from "./human-agent-concurrent-change-schemas.js";

/** 契约 → 影响节点映射端口（装配方注入：契约标识 → 实现/测试/验收节点）。 */
export interface ContractImpactNodePort {
  listImpactedNodeIdentifiers(contractIdentifiers: string[]): string[];
}

export interface ClassifyChangeInput {
  /** 人工变化的路径与影响的公共契约。 */
  humanChangedPaths: string[];
  humanAffectedContractIdentifiers: string[];
  /** Agent 编辑意图的写入路径与影响的公共契约。 */
  agentWritePaths: string[];
  agentAffectedContractIdentifiers: string[];
  /** Git 文本冲突（同一路径行级重叠）标记。 */
  hasGitTextConflict: boolean;
  /** 行为一致性证据：自动合并后测试/验收是否通过。 */
  behavioralEvidence: {
    testsPassed: boolean;
    acceptancePassed: boolean;
  };
}

export interface ClassificationResult {
  decision: ConcurrentChangeDecision;
  /** 契约重叠时的受影响节点清单（冻结实现/测试/验收）。 */
  impactedNodeIdentifiers: string[];
  reason: string;
}

export class ConcurrentChangeClassifier {
  constructor(private readonly contractImpactNodePort: ContractImpactNodePort) {}

  /** 确定性分类；无法确定时 fail-closed（blocked-human-review）。 */
  classifyChange(input: ClassifyChangeInput): ClassificationResult {
    const sharedWritePaths = input.humanChangedPaths.filter((path) =>
      input.agentWritePaths.includes(path),
    );
    const sharedContracts = input.humanAffectedContractIdentifiers.filter(
      (contract) => input.agentAffectedContractIdentifiers.includes(contract),
    );

    // 1) 行为冲突：Git 合并成功但测试/验收不一致 → 返修（不以合并成功为完成证据）
    if (!input.behavioralEvidence.testsPassed || !input.behavioralEvidence.acceptancePassed) {
      return {
        decision: "blocked-human-review",
        impactedNodeIdentifiers: [],
        reason: "行为冲突：自动合并后测试/验收不一致，进入返修（Git 无文本冲突不代表语义兼容）",
      };
    }

    // 2) 文本重叠（同一路径）
    if (sharedWritePaths.length > 0 || input.hasGitTextConflict) {
      return {
        decision: "text-conflict-reconcile",
        impactedNodeIdentifiers: [],
        reason: `文本重叠：路径 ${sharedWritePaths.join(",") || "(git 文本冲突)"} 需协调 Agent；原实现者不能单独宣布解决`,
      };
    }

    // 3) 契约重叠（路径不同但共享公共契约）
    if (sharedContracts.length > 0) {
      const impactedNodeIdentifiers =
        this.contractImpactNodePort.listImpactedNodeIdentifiers(sharedContracts);
      return {
        decision: "contract-conflict-reconcile",
        impactedNodeIdentifiers,
        reason: `契约重叠（路径不同但共享契约 ${sharedContracts.join(",")}）：冻结实现/测试/验收节点并影响分析`,
      };
    }

    // 4) 无重叠
    return {
      decision: "no-overlap-revalidate",
      impactedNodeIdentifiers: [],
      reason: "无重叠：验证人工新基线后重新运行差异审查与相关测试",
    };
  }

  /** 契约重叠时校验影响清单非空（未知契约 → fail-closed 人工审查）。 */
  assertImpactAnalysisComplete(result: ClassificationResult): void {
    if (result.decision === "contract-conflict-reconcile") {
      if (result.impactedNodeIdentifiers.length === 0) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "契约重叠但影响清单为空（未知契约/影响分析缺失）→ fail-closed 人工审查",
        );
      }
    }
  }

  /** 分类输入合法性（契约标识/路径非空；禁止模型伪造）。 */
  static assertClassificationInputValid(input: ClassifyChangeInput): void {
    if (
      input.humanChangedPaths.length === 0 &&
      input.agentWritePaths.length === 0
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "冲突分类输入缺少路径（模型不能伪造空变化）",
      );
    }
    if (
      !CONCURRENT_CHANGE_DECISION_VALUES.includes("no-overlap-revalidate")
    ) {
      throw new DomainError("invalid-task-chain", "冲突决定常量被破坏");
    }
  }
}