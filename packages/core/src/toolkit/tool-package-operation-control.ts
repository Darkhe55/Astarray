/**
 * TOOLKIT-01-04：工具包的**取消 / 崩溃恢复管理入口**与**独立反馈**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §7/§8
 * 与检查点 04（"取消/崩溃恢复与独立反馈"）。
 *
 * 卡内硬要求逐条落实：
 *  - "停用阻止新运行，**在途调用按安全点取消/收敛，不能删掉运行中的文件造成结果未知**"
 *    ⇒ 取消只**禁止新运行**，在途调用**保留**，必须由调用方按安全点收敛；
 *  - "启用/停用/锁定变更**按 revision 原子提交**" ⇒ 每次操作写回并记录该 revision；
 *  - 崩溃恢复 ⇒ 半提交意图**持久化**、重启可恢复、收敛到**上一个可信版本**，
 *    **绝不留下"已启用但哈希不符"**；
 *  - "**独立反馈**" ⇒ 每次管理操作产生一条带**具体 `agentInstanceId` 来源**、
 *    动作、revision 与结果的记录；**命中秘密即拒绝记录**（不做部分脱敏）。
 *
 * 本模块做**本地持久化 I/O**，但只在调用方给定的状态目录内；不联网、不读凭据。
 */

import { DomainError } from "../core/errors.js";
import { ToolPackageVersionStateStore } from "./tool-package-version-state-store.js";

/** 管理操作类型。 */
export type ToolPackageOperationKind =
  | "enable"
  | "disable"
  | "upgrade"
  | "rollback"
  | "cancel"
  | "recover";

export interface ToolPackageOperationFeedbackRecord {
  recordIdentifier: string;
  operationKind: ToolPackageOperationKind;
  projectIdentifier: string;
  toolPackageId: string;
  /** **具体**来源个体（不得是角色/模型名）。 */
  requestingAgentInstanceId: string;
  /** 操作时的 revision（变更类操作即提交后的 revision）。 */
  revision: number;
  outcome: "applied" | "rejected";
  detail: string;
  recordedAtIso: string;
}

export const TOOL_PACKAGE_FEEDBACK_SCHEMA_VERSION =
  "ASTARRAY_TOOL_PACKAGE_FEEDBACK_V1";

const FEEDBACK_FILE_NAME = "tool-package-feedback.json";

/** 禁止写入反馈的秘密特征（命中即拒绝，不做部分脱敏）。 */
const FORBIDDEN_FEEDBACK_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9-]{16,}/,
  /(Authorization|Bearer)\s*[:=]?\s*\S{8,}/i,
  /nonce/i,
];

/**
 * 独立反馈存储：与版本状态**分开落盘**。
 *
 * 为什么分开：卡内要求"独立反馈" —— 若与状态混在一份文件里，
 * 状态回滚/恢复会连带影响反馈历史，且难以独立查阅与审计。
 */
export class ToolPackageOperationFeedbackStore {
  private readonly stateDirectory: string;

  constructor(options: { stateDirectory: string }) {
    this.stateDirectory = options.stateDirectory;
  }

  private get feedbackFilePath(): string {
    return `${this.stateDirectory}/${FEEDBACK_FILE_NAME}`;
  }

  private get backupFilePath(): string {
    return `${this.feedbackFilePath}.backup`;
  }

  async listRecords(): Promise<ToolPackageOperationFeedbackRecord[]> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.feedbackFilePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return [];
    }
    const raw = readResult.content as { records?: unknown };
    if (raw === null || typeof raw !== "object" || !Array.isArray(raw.records)) {
      return [];
    }
    return raw.records as ToolPackageOperationFeedbackRecord[];
  }

  /** 追加一条反馈；命中秘密特征即**拒绝记录**。 */
  async appendRecord(
    input: Omit<ToolPackageOperationFeedbackRecord, "recordIdentifier" | "recordedAtIso">,
  ): Promise<ToolPackageOperationFeedbackRecord> {
    if (
      typeof input.requestingAgentInstanceId !== "string" ||
      input.requestingAgentInstanceId === ""
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "管理操作必须记录**具体**来源 agentInstanceId（不得只记角色/模型名）",
      );
    }
    const recordedText = [input.detail, input.toolPackageId, input.projectIdentifier].join("|");
    for (const pattern of FORBIDDEN_FEEDBACK_PATTERNS) {
      if (pattern.test(recordedText)) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "独立反馈不得包含秘密/凭据/一次性授权（拒绝记录，请先清理输入）",
        );
      }
    }
    const existingRecords = await this.listRecords();
    const record: ToolPackageOperationFeedbackRecord = {
      ...input,
      recordIdentifier: "feedback-" + String(existingRecords.length + 1),
      recordedAtIso: new Date().toISOString(),
    };
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    await backupExistingFile(this.feedbackFilePath, this.backupFilePath);
    await writeAtomicJson(this.feedbackFilePath, {
      schemaVersion: TOOL_PACKAGE_FEEDBACK_SCHEMA_VERSION,
      records: [...existingRecords, record],
    });
    return record;
  }
}

export interface ToolPackageCancellationOutcome {
  isCancelled: boolean;
  /** 取消后**保留**的在途调用数（**不得删除**）。 */
  retainedInFlightCallCount: number;
  revision: number | null;
  reason: string | null;
}

/**
 * **取消**某项目下的工具包使用。
 *
 * 语义（卡内 §8）：**阻止新运行**，但**保留在途调用**；
 * 在途调用必须由调用方按安全点收敛（"不能删掉运行中的文件造成结果未知"）。
 */
export async function cancelProjectToolPackage(input: {
  stateDirectory: string;
  projectIdentifier: string;
  toolPackageId: string;
  reason: string;
  requestingAgentInstanceId: string;
}): Promise<ToolPackageCancellationOutcome> {
  const store = new ToolPackageVersionStateStore({
    stateDirectory: input.stateDirectory,
  });
  const controller = await store.loadController();
  const disableOutcome = controller.disableForProject({
    projectIdentifier: input.projectIdentifier,
    toolPackageId: input.toolPackageId,
  });
  const retainedInFlightCallCount = controller.listInFlightCalls({
    projectIdentifier: input.projectIdentifier,
  }).length;
  await store.saveController(controller);

  const feedbackStore = new ToolPackageOperationFeedbackStore({
    stateDirectory: input.stateDirectory,
  });
  await feedbackStore.appendRecord({
    operationKind: "cancel",
    projectIdentifier: input.projectIdentifier,
    toolPackageId: input.toolPackageId,
    requestingAgentInstanceId: input.requestingAgentInstanceId,
    revision: disableOutcome.revision,
    outcome: disableOutcome.isApplied ? "applied" : "rejected",
    detail:
      (disableOutcome.isApplied ? "取消已生效：" : "取消未生效：") +
      String(disableOutcome.reason ?? input.reason) +
      "；保留在途调用 " +
      String(retainedInFlightCallCount) +
      " 个（不删除，待按安全点收敛）",
  });

  return {
    isCancelled: disableOutcome.isApplied,
    retainedInFlightCallCount,
    revision: disableOutcome.isApplied ? disableOutcome.revision : null,
    reason: disableOutcome.reason,
  };
}

export interface InterruptedSwitchRecoveryOutcome {
  isRecovered: boolean;
  activeVersion: number | null;
  feedbackRecordIdentifier: string;
}

/**
 * **崩溃恢复**：把半提交的版本切换收敛到上一个可信版本。
 *
 * 不变量：恢复后**绝不留下"已启用但哈希不符"**的中间态；
 * 恢复动作本身产生**独立反馈**记录（谁触发的、收敛到哪个版本）。
 */
export async function recoverInterruptedVersionSwitch(input: {
  stateDirectory: string;
  projectIdentifier: string;
  toolPackageId: string;
  requestingAgentInstanceId: string;
}): Promise<InterruptedSwitchRecoveryOutcome> {
  const store = new ToolPackageVersionStateStore({
    stateDirectory: input.stateDirectory,
  });
  const controller = await store.loadController();
  const recovery = controller.recoverFromInterruptedSwitch({
    projectIdentifier: input.projectIdentifier,
    toolPackageId: input.toolPackageId,
  });
  await store.saveController(controller);

  const lock = controller.findProjectLock({
    projectIdentifier: input.projectIdentifier,
    toolPackageId: input.toolPackageId,
  });
  const feedbackStore = new ToolPackageOperationFeedbackStore({
    stateDirectory: input.stateDirectory,
  });
  const feedbackRecord = await feedbackStore.appendRecord({
    operationKind: "recover",
    projectIdentifier: input.projectIdentifier,
    toolPackageId: input.toolPackageId,
    requestingAgentInstanceId: input.requestingAgentInstanceId,
    revision: lock?.revision ?? 0,
    outcome: recovery.isRecovered ? "applied" : "rejected",
    detail:
      recovery.isRecovered
        ? "已将半提交的切换收敛到可信版本 " + String(recovery.activeVersion)
        : "无待恢复的半提交切换（幂等：未做任何变更）",
  });

  return {
    isRecovered: recovery.isRecovered,
    activeVersion: recovery.activeVersion,
    feedbackRecordIdentifier: feedbackRecord.recordIdentifier,
  };
}
