/**
 * ACCURACY-02：幂等签收、可选理解确认与"条目 → 证据"覆盖校验（复用既有完成门禁，不新建调度）。
 *
 * 硬规则（见 docs/adr/0040-accuracy-tiers-budget-and-skip-status.md）：
 * - 签收幂等：同一 `completionAttemptId` 重放返回既有结论且不重复产生副作用（可跨进程重启恢复）；
 * - 版本一致：低于当前 revision 判陈旧、**高于当前判未来**，两者都拒绝；
 * - 收件人必须匹配（错收件人拒绝）；
 * - 证据必须真实：产物/测试回执需有内容指纹；伪造证据（如模型自述冒充产物）拒绝；
 * - 产物在证据之后又被修改 → 陈旧产物，拒绝；
 * - 必需验收条目必须全部覆盖；部分完成只能报告进度，不得据此结案；
 * - 快速档返回独立的 `quality-check-skipped` 状态，绝不写成"通过"。
 */
export const ACCURACY_TIERS = ["fast", "standard", "strict"] as const;
export type AccuracyTier = (typeof ACCURACY_TIERS)[number];

export type AcceptanceEvidenceRequirement =
  | "artifact"
  | "test-report"
  | "manual-acknowledgement"
  | "any";

export interface AcceptanceEntry {
  entryIdentifier: string;
  description: string;
  isRequired: boolean;
  evidenceRequirement: AcceptanceEvidenceRequirement;
}

export type EvidenceKind =
  | "artifact"
  | "test-report"
  | "manual-acknowledgement"
  | "model-claim";

export interface EvidenceReference {
  evidenceIdentifier: string;
  entryIdentifier: string;
  evidenceKind: EvidenceKind;
  /** 产物/回执的内容指纹；`model-claim` 允许为 null。 */
  contentHash: string | null;
  /** 证据产生时的产物 revision（用于检测陈旧产物）。 */
  producedAtRevision: number;
  producedByAgentInstanceId: string | null;
  observedAtIso: string;
}

export interface CompletionDeclaration {
  taskIdentifier: string;
  completionAttemptId: string;
  taskSequenceRevision: number;
  completedEntryIdentifiers: string[];
  evidenceReferences: EvidenceReference[];
  understandingConfirmation?: {
    restatedGoal: string;
    confirmedAtIso: string;
  } | null;
  deliveredToRecipientIdentifier: string;
}

export interface AccuracyVerificationResult {
  verdict: "accepted" | "rejected" | "quality-check-skipped";
  reasons: string[];
  coveredEntryIdentifiers: string[];
  missingRequiredEntryIdentifiers: string[];
  forgedEvidenceIdentifiers: string[];
  staleEvidenceIdentifiers: string[];
  isUnderstandingConfirmed: boolean;
  isIdempotentReplay: boolean;
  tier: AccuracyTier;
}

export interface AccuracyVerifierPorts {
  getCurrentTaskSequenceRevision(taskIdentifier: string): Promise<number>;
  getRequiredAcceptanceEntries(taskIdentifier: string): Promise<AcceptanceEntry[]>;
  getArtifactRevision(evidence: EvidenceReference): Promise<number | null>;
  getExpectedRecipientIdentifier(taskIdentifier: string): Promise<string>;
  getTier(taskIdentifier: string): Promise<AccuracyTier>;
  isClarificationRequired(taskIdentifier: string): Promise<boolean>;
  findProcessedAttempt?(
    completionAttemptId: string,
  ): Promise<AccuracyVerificationResult | null>;
  recordProcessedAttempt?(
    completionAttemptId: string,
    result: AccuracyVerificationResult,
  ): Promise<void>;
}

const MODEL_CLAIM_ALLOWED_TIERS: ReadonlySet<AccuracyTier> = new Set([
  "fast",
  "standard",
]);

export class TaskAccuracyVerifier {
  constructor(private readonly ports: AccuracyVerifierPorts) {}

  async verifyCompletion(
    declaration: CompletionDeclaration,
  ): Promise<AccuracyVerificationResult> {
    // 幂等：无论内存还是外部日志命中，都直接返回既有结论（不重复副作用）。
    const processed =
      (await this.ports.findProcessedAttempt?.(declaration.completionAttemptId)) ??
      null;
    if (processed !== null) {
      return { ...processed, isIdempotentReplay: true };
    }

    const tier = await this.ports.getTier(declaration.taskIdentifier);
    const result = await this.evaluate(declaration, tier);
    await this.ports.recordProcessedAttempt?.(
      declaration.completionAttemptId,
      result,
    );
    return result;
  }

  private async evaluate(
    declaration: CompletionDeclaration,
    tier: AccuracyTier,
  ): Promise<AccuracyVerificationResult> {
    const reasons: string[] = [];
    const requiredEntries = await this.ports.getRequiredAcceptanceEntries(
      declaration.taskIdentifier,
    );
    const requiredEntryIdentifiers = new Set(
      requiredEntries.filter((entry) => entry.isRequired).map((entry) => entry.entryIdentifier),
    );
    const coveredEntryIdentifiers = [...new Set(declaration.completedEntryIdentifiers)];
    const missingRequiredEntryIdentifiers = [...requiredEntryIdentifiers].filter(
      (entryIdentifier) => !coveredEntryIdentifiers.includes(entryIdentifier),
    );

    // 结构性检查（收件人/版本）在快速档下同样执行：它们不新增模型审查或人工等待。
    const expectedRecipientIdentifier =
      await this.ports.getExpectedRecipientIdentifier(declaration.taskIdentifier);
    if (declaration.deliveredToRecipientIdentifier !== expectedRecipientIdentifier) {
      reasons.push(
        "wrong-recipient: 完成声明送达 " +
          declaration.deliveredToRecipientIdentifier +
          "，期望 " +
          expectedRecipientIdentifier,
      );
    }

    const currentRevision = await this.ports.getCurrentTaskSequenceRevision(
      declaration.taskIdentifier,
    );
    if (declaration.taskSequenceRevision < currentRevision) {
      reasons.push(
        "stale-revision: 声明依据 r" +
          String(declaration.taskSequenceRevision) +
          "，当前 r" +
          String(currentRevision),
      );
    } else if (declaration.taskSequenceRevision > currentRevision) {
      reasons.push(
        "future-revision: 声明依据 r" +
          String(declaration.taskSequenceRevision) +
          " 高于当前 r" +
          String(currentRevision) +
          "（未来版本不可信）",
      );
    }

    // 快速档：跳过本机制新增的理解复述/语义审查/质量门禁，返回独立状态。
    if (tier === "fast") {
      return {
        verdict:
          reasons.length > 0 ? "rejected" : "quality-check-skipped",
        reasons:
          reasons.length > 0
            ? reasons
            : [
                "quality-check-skipped: 快速档跳过质量门禁（不等于测试/验收通过）",
              ],
        coveredEntryIdentifiers,
        missingRequiredEntryIdentifiers,
        forgedEvidenceIdentifiers: [],
        staleEvidenceIdentifiers: [],
        isUnderstandingConfirmed: false,
        isIdempotentReplay: false,
        tier,
      };
    }

    const forgedEvidenceIdentifiers: string[] = [];
    const staleEvidenceIdentifiers: string[] = [];
    const doesModelClaimAllowed = MODEL_CLAIM_ALLOWED_TIERS.has(tier);

    for (const evidence of declaration.evidenceReferences) {
      if (evidence.evidenceKind === "model-claim" && !doesModelClaimAllowed) {
        forgedEvidenceIdentifiers.push(evidence.evidenceIdentifier);
        continue;
      }
      if (
        evidence.evidenceKind !== "model-claim" &&
        (evidence.contentHash === null || evidence.contentHash.trim() === "")
      ) {
        forgedEvidenceIdentifiers.push(evidence.evidenceIdentifier);
        continue;
      }
      const artifactRevision =
        await this.ports.getArtifactRevision(evidence);
      if (
        artifactRevision !== null &&
        artifactRevision > evidence.producedAtRevision
      ) {
        staleEvidenceIdentifiers.push(evidence.evidenceIdentifier);
      }
    }
    if (forgedEvidenceIdentifiers.length > 0) {
      reasons.push(
        "forged-evidence: 证据缺少真实指纹或使用被禁止的模型自述: " +
          forgedEvidenceIdentifiers.join(", "),
      );
    }
    if (staleEvidenceIdentifiers.length > 0) {
      reasons.push(
        "stale-artifact: 产物在证据之后又被修改: " +
          staleEvidenceIdentifiers.join(", "),
      );
    }

    if (
      declaration.evidenceReferences.length === 0 &&
      requiredEntryIdentifiers.size > 0
    ) {
      reasons.push("empty-evidence: 必需条目存在但没有任何证据引用");
    }
    if (missingRequiredEntryIdentifiers.length > 0) {
      reasons.push(
        "required-entry-missing: 必需验收条目未覆盖: " +
          missingRequiredEntryIdentifiers.join(", ") +
          "（部分完成只能报告进度，不得结案）",
      );
    }

    const isClarificationRequired = await this.ports.isClarificationRequired(
      declaration.taskIdentifier,
    );
    const isUnderstandingConfirmed =
      declaration.understandingConfirmation !== undefined &&
      declaration.understandingConfirmation !== null &&
      declaration.understandingConfirmation.restatedGoal.trim() !== "";
    if (!isUnderstandingConfirmed && (tier === "strict" || isClarificationRequired)) {
      reasons.push(
        "understanding-confirmation-missing: " +
          (tier === "strict" ? "严格档必须复述目标并确认" : "存在歧义时必须先确认理解"),
      );
    }

    return {
      verdict: reasons.length === 0 ? "accepted" : "rejected",
      reasons,
      coveredEntryIdentifiers,
      missingRequiredEntryIdentifiers,
      forgedEvidenceIdentifiers,
      staleEvidenceIdentifiers,
      isUnderstandingConfirmed,
      isIdempotentReplay: false,
      tier,
    };
  }
}

/** 进程内幂等日志（跨重启可用持久化实现替换）。 */
export class InMemoryAccuracyAttemptJournal {
  private readonly resultsByAttemptId = new Map<string, AccuracyVerificationResult>();

  async findProcessedAttempt(
    completionAttemptId: string,
  ): Promise<AccuracyVerificationResult | null> {
    const result = this.resultsByAttemptId.get(completionAttemptId);
    return result === undefined ? null : { ...result };
  }

  async recordProcessedAttempt(
    completionAttemptId: string,
    result: AccuracyVerificationResult,
  ): Promise<void> {
    this.resultsByAttemptId.set(completionAttemptId, { ...result });
  }

  size(): number {
    return this.resultsByAttemptId.size;
  }
}
