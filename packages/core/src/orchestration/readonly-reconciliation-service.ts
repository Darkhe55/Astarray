/**
 * 启动只读对账服务（T12A-03 / ADR-0030 §1/§3）。
 *
 * - 启动后先执行只读对账：文件、Git、worktree、人工变化状态未确认前
 *   不得继续写入；对账阶段只读（不得运行可能修改项目/安装依赖/访问
 *   敏感文件的命令）；
 * - 离线期间人工修改由 T05D 对账：旧 Agent 检查点不得覆盖；
 * - 差异分类：无差异 / 离线人工修改 / 分支变化 / 脏工作树 / 丢失 worktree。
 */
import type { HumanChangeObservation } from "./human-agent-concurrent-change-schemas.js";

/** Git 状态端口（只读；装配方接入真实 git）。 */
export interface GitStatusPort {
  readStatus(): Promise<{
    branchName: string;
    headCommitIdentifier: string;
    hasDirtyWorkingTree: boolean;
  }>;
}

/** worktree 存在性端口（只读）。 */
export interface WorktreeExistencePort {
  doesWorktreeExist(input: { worktreeIdentifier: string }): Promise<boolean>;
}

/** 人工变化观察端口（只读；T05D 观察器）。 */
export interface HumanChangeObservationPort {
  readLatestObservation(): Promise<HumanChangeObservation | null>;
}

/** 对账差异类型（冻结）。 */
export const RECONCILIATION_DISCREPANCY_TYPES = [
  "no-discrepancy",
  "offline-human-change",
  "branch-changed",
  "dirty-working-tree",
  "worktree-missing",
] as const;
export type ReconciliationDiscrepancyType =
  (typeof RECONCILIATION_DISCREPANCY_TYPES)[number];

export interface ReadonlyReconciliationInput {
  /** 检查点记录的 Git 目标状态。 */
  checkpointGitState: {
    targetBranchName: string;
    targetHeadCommitIdentifier: string;
    expectedDirty: boolean;
  };
  /** 检查点记录的人工变化观察 revision。 */
  checkpointHumanChangeObservationRevision: number;
  /** 检查点记录的 worktree 标识（缺失即丢失）。 */
  expectedWorktreeIdentifiers: string[];
}

export interface ReadonlyReconciliationResult {
  isReadonlyConfirmed: boolean;
  discrepancies: Array<{
    type: ReconciliationDiscrepancyType;
    detail: string;
  }>;
  /** 存在离线人工修改 → 需 T05D 重对账（旧贡献 stale）。 */
  requiresHumanChangeReconciliation: boolean;
  /** 全部无差异 → 可继续恢复。 */
  isSafeToProceed: boolean;
}

export class ReadonlyReconciliationService {
  private readonly gitStatusPort: GitStatusPort;
  private readonly worktreeExistencePort: WorktreeExistencePort;
  private readonly humanChangeObservationPort: HumanChangeObservationPort;

  constructor(options: {
    gitStatusPort: GitStatusPort;
    worktreeExistencePort: WorktreeExistencePort;
    humanChangeObservationPort: HumanChangeObservationPort;
  }) {
    this.gitStatusPort = options.gitStatusPort;
    this.worktreeExistencePort = options.worktreeExistencePort;
    this.humanChangeObservationPort = options.humanChangeObservationPort;
  }

  /**
   * 启动只读对账：只读取状态并分类差异；本方法不做任何写入。
   * 离线人工修改/分支变化/脏工作树/丢失 worktree 均产生明确差异。
   */
  async reconcile(
    input: ReadonlyReconciliationInput,
  ): Promise<ReadonlyReconciliationResult> {
    const discrepancies: ReadonlyReconciliationResult["discrepancies"] = [];
    // 1) Git 状态（只读）
    const gitStatus = await this.gitStatusPort.readStatus();
    if (gitStatus.branchName !== input.checkpointGitState.targetBranchName) {
      discrepancies.push({
        type: "branch-changed",
        detail: `检查点分支 ${input.checkpointGitState.targetBranchName} ≠ 当前 ${gitStatus.branchName}`,
      });
    }
    if (
      gitStatus.headCommitIdentifier !==
      input.checkpointGitState.targetHeadCommitIdentifier
    ) {
      discrepancies.push({
        type: "branch-changed",
        detail: `HEAD 变化：检查点 ${input.checkpointGitState.targetHeadCommitIdentifier.slice(0, 12)} ≠ 当前 ${gitStatus.headCommitIdentifier.slice(0, 12)}`,
      });
    }
    if (gitStatus.hasDirtyWorkingTree && !input.checkpointGitState.expectedDirty) {
      discrepancies.push({
        type: "dirty-working-tree",
        detail: "工作树脏状态与检查点预期不一致（存在未提交修改）",
      });
    }
    // 2) worktree 存在性（只读）
    for (const worktreeIdentifier of input.expectedWorktreeIdentifiers) {
      const exists = await this.worktreeExistencePort.doesWorktreeExist({
        worktreeIdentifier,
      });
      if (!exists) {
        discrepancies.push({
          type: "worktree-missing",
          detail: `worktree ${worktreeIdentifier} 丢失`,
        });
      }
    }
    // 3) 人工变化观察（只读；T05D 对账输入）
    const latestObservation =
      await this.humanChangeObservationPort.readLatestObservation();
    const requiresHumanChangeReconciliation =
      latestObservation !== null &&
      latestObservation.observationRevision >
        input.checkpointHumanChangeObservationRevision;
    if (requiresHumanChangeReconciliation) {
      discrepancies.push({
        type: "offline-human-change",
        detail: `离线期间人工变化（观察 revision ${latestObservation.observationRevision} > 检查点 ${input.checkpointHumanChangeObservationRevision}）；旧 Agent 检查点不得覆盖`,
      });
    }
    return {
      isReadonlyConfirmed: true,
      discrepancies,
      requiresHumanChangeReconciliation,
      isSafeToProceed: discrepancies.length === 0,
    };
  }
}