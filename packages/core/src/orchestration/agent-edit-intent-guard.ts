/**
 * 产品侧 **Agent 编辑意图**与**陈旧写入强制**（E2E-01-03 S1；契约 T05D-03 / ADR-0028 §3）。
 *
 * 为什么需要它（已查证的既有缺陷）：
 *  - `StaleWriteGuard` 早已实现且有单测，但**产品路径从未调用**（唯一非测试引用只把它当作
 *    一个恒真的"能力存在"标志位）；`AgentEditIntent` 也**没有产品侧生产者**。
 *  - `replaceFileContent` 原有防护（备份 → 写入前 `verifyTargetUnchanged`）的基线取自
 *    **备份那一刻**，覆盖不到"Agent 已读、尚未备份"这段窗口：人工在此期间修改同一文件，
 *    复检会通过，Agent 会**静默覆盖人工改动**。
 *
 * 本模块补的正是这段窗口：把**读取时**的内容指纹记为编辑意图基线，写入前比对；
 * 不一致即拒绝并把 Agent 待写内容保全为可追溯 patch（人工字节一个都不动）。
 *
 * 语义与边界（不得扩大声明）：
 *  - 基线**首次读取时**记录；**再次读取不刷新基线**（否则人工改动会被"读一次"吸收掉）；
 *  - Agent **自身写入成功后**基线前移（否则它下一次合法写入会被误判为陈旧）；
 *  - **盲覆盖**（本次任务从未读过该文件 → 无基线）返回 `baseline-missing`，
 *    **不**套用人工基线检查，交回既有防护（权限/范围门禁 + 自动备份 + TOCTOU 复检）；
 *    这是已登记的残余边界，不是"已覆盖"；
 *  - 路径边界与编辑范围仍由既有 scope/权限门禁负责；本模块不做第二套范围判定，
 *    构造给守卫的意图只含**单个目标路径**。
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { backupExistingFile, readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import {
  AGENT_EDIT_INTENT_SCHEMA_VERSION,
  type AgentEditIntent,
} from "./human-agent-concurrent-change-schemas.js";
import {
  Sha256FileFingerprinter,
  type HumanFileFingerprintPort,
} from "./human-worktree-observer.js";
import { StaleWriteGuard } from "./stale-write-guard.js";
import { sanitizePathSegment } from "./work-archive-store.js";

/** 意图有效期（默认 24 小时；过期即拒绝写入，避免陈旧意图长期有效）。 */
export const AGENT_EDIT_INTENT_VALIDITY_MILLISECONDS = 24 * 60 * 60 * 1_000;

/** `taskExecutionId` 缺失时的占位值（契约要求非空字符串）。 */
export const UNSPECIFIED_TASK_EXECUTION_IDENTIFIER = "task-execution:unspecified";
/** 读时拿不到提交标识时的占位值（契约要求非空字符串）。 */
export const UNKNOWN_BASE_COMMIT_IDENTIFIER = "base-commit:unknown";

/** 规范内容指纹（`sha256:<hex>`），与 `resourceFingerprintSchema` 同格式。 */
export function computeContentFingerprint(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export interface AgentEditIntentGuardOptions {
  /** 状态目录（意图文件与 patch 保管库都放这里）。 */
  baseDirectory: string;
  /** 指纹器（默认 sha256 文件指纹；可注入以便测试）。 */
  fingerprintPort?: HumanFileFingerprintPort;
  nowUnixMilliseconds?: () => number;
}

export interface RecordReadBaselineInput {
  agentInstanceId: string;
  taskExecutionIdentifier: string | null;
  /** 已解析的绝对路径（读取与写入两侧必须用同一形态作键）。 */
  targetPath: string;
  /** 读取时的内容指纹（`sha256:<hex>`）。 */
  contentFingerprint: string;
  baseCommitIdentifier?: string | null;
}

export interface GuardOverwriteInput {
  agentInstanceId: string;
  taskExecutionIdentifier: string | null;
  targetPath: string;
  /** Agent 待写内容（被拒绝时保全为 patch）。 */
  pendingWriteContent: string;
}

export interface RecordOwnWriteInput {
  agentInstanceId: string;
  taskExecutionIdentifier: string | null;
  targetPath: string;
  contentFingerprint: string;
}

export type GuardOverwriteOutcome =
  /** 基线一致 → 允许写入。 */
  | { kind: "allowed" }
  /** 本次任务从未读过该文件 → 无基线，未套用人工基线检查（残余边界，见模块头注释）。 */
  | { kind: "baseline-missing" }
  /** 人工变化/文件不可读/意图过期 → 拒绝写入，待写内容已保全为 patch。 */
  | { kind: "stale-rejected"; staleReason: string; preservedPatchPath: string };

interface AgentEditIntentDocument {
  schemaVersion: 1;
  agentInstanceId: string;
  intents: AgentEditIntent[];
}

/** 供产品路径注入的窄端口（未装配时工具退回既有防护，不假装已校验）。 */
export interface AgentEditIntentGuardPort {
  recordReadBaseline(input: RecordReadBaselineInput): Promise<void>;
  recordOwnWrite(input: RecordOwnWriteInput): Promise<void>;
  guardOverwrite(input: GuardOverwriteInput): Promise<GuardOverwriteOutcome>;
}

export class AgentEditIntentGuard implements AgentEditIntentGuardPort {
  private readonly baseDirectory: string;
  private readonly fingerprintPort: HumanFileFingerprintPort;
  private readonly nowUnixMilliseconds: () => number;
  private readonly staleWriteGuard: StaleWriteGuard;

  constructor(options: AgentEditIntentGuardOptions) {
    this.baseDirectory = options.baseDirectory;
    this.fingerprintPort = options.fingerprintPort ?? new Sha256FileFingerprinter();
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? Date.now;
    this.staleWriteGuard = new StaleWriteGuard({
      fingerprintPort: this.fingerprintPort,
      patchVaultBaseDirectory: this.baseDirectory,
      ...(options.nowUnixMilliseconds === undefined
        ? {}
        : { nowUnixMilliseconds: options.nowUnixMilliseconds }),
    });
  }

  async recordReadBaseline(input: RecordReadBaselineInput): Promise<void> {
    const document = await this.loadDocument(input.agentInstanceId);
    const taskKey = input.taskExecutionIdentifier ?? UNSPECIFIED_TASK_EXECUTION_IDENTIFIER;
    const existingIntent = document.intents.find(
      (intent) => intent.taskExecutionIdentifier === taskKey,
    );
    if (existingIntent === undefined) {
      document.intents.push({
        schemaVersion: AGENT_EDIT_INTENT_SCHEMA_VERSION,
        editIntentIdentifier: `edit-intent:${input.agentInstanceId}:${taskKey}`,
        agentInstanceId: input.agentInstanceId,
        taskExecutionIdentifier: taskKey,
        baseCommitIdentifier:
          input.baseCommitIdentifier ?? UNKNOWN_BASE_COMMIT_IDENTIFIER,
        plannedReadPaths: [input.targetPath],
        allowedWritePaths: [input.targetPath],
        initialResourceFingerprintsByPath: {
          [input.targetPath]: input.contentFingerprint,
        },
        affectedContractIdentifiers: [],
        expiresAtIso: this.computeExpiresAtIso(),
        revision: 1,
      });
    } else if (existingIntent.initialResourceFingerprintsByPath[input.targetPath] === undefined) {
      /**
       * 仅**首次**读取该路径时记录基线。
       * 已有基线时**一律不刷新**：人工改完之后 Agent 再读一次，不得因此把人工内容
       * 当作"基线"而获得覆盖许可。
       */
      existingIntent.initialResourceFingerprintsByPath[input.targetPath] =
        input.contentFingerprint;
      existingIntent.allowedWritePaths = [
        ...new Set([...existingIntent.allowedWritePaths, input.targetPath]),
      ];
      existingIntent.plannedReadPaths = [
        ...new Set([...existingIntent.plannedReadPaths, input.targetPath]),
      ];
      existingIntent.revision += 1;
    }
    await this.saveDocument(document);
  }

  async recordOwnWrite(input: RecordOwnWriteInput): Promise<void> {
    const document = await this.loadDocument(input.agentInstanceId);
    const taskKey = input.taskExecutionIdentifier ?? UNSPECIFIED_TASK_EXECUTION_IDENTIFIER;
    const intent = document.intents.find(
      (candidate) => candidate.taskExecutionIdentifier === taskKey,
    );
    if (intent === undefined) {
      return;
    }
    // Agent 自身写入成功 → 基线前移（否则它下一次合法写入会被判成陈旧）。
    intent.initialResourceFingerprintsByPath[input.targetPath] = input.contentFingerprint;
    intent.expiresAtIso = this.computeExpiresAtIso();
    intent.revision += 1;
    await this.saveDocument(document);
  }

  async guardOverwrite(input: GuardOverwriteInput): Promise<GuardOverwriteOutcome> {
    const document = await this.loadDocument(input.agentInstanceId);
    const taskKey = input.taskExecutionIdentifier ?? UNSPECIFIED_TASK_EXECUTION_IDENTIFIER;
    const intent = document.intents.find(
      (candidate) => candidate.taskExecutionIdentifier === taskKey,
    );
    if (
      intent === undefined ||
      intent.initialResourceFingerprintsByPath[input.targetPath] === undefined
    ) {
      return { kind: "baseline-missing" };
    }
    /**
     * 只把**该目标路径**放进意图的允许写入集合：本模块不做第二套范围判定
     * （范围与权限由既有 scope/权限门禁负责），这里只做"人工基线是否变化"这一件事。
     */
    const guardResult = await this.staleWriteGuard.guardWrite({
      intent: { ...intent, allowedWritePaths: [input.targetPath] },
      targetPath: input.targetPath,
      pendingWriteContent: input.pendingWriteContent,
    });
    if (guardResult.isAllowed) {
      return { kind: "allowed" };
    }
    return {
      kind: "stale-rejected",
      staleReason: guardResult.staleReason,
      preservedPatchPath: guardResult.preservedPatchPath,
    };
  }

  private computeExpiresAtIso(): string {
    return new Date(
      this.nowUnixMilliseconds() + AGENT_EDIT_INTENT_VALIDITY_MILLISECONDS,
    ).toISOString();
  }

  private filePathForAgent(agentInstanceId: string): string {
    return path.join(
      this.baseDirectory,
      "agent-edit-intents",
      `${sanitizePathSegment(agentInstanceId)}.json`,
    );
  }

  private async loadDocument(agentInstanceId: string): Promise<AgentEditIntentDocument> {
    const filePath = this.filePathForAgent(agentInstanceId);
    let recoveryResult: Awaited<ReturnType<typeof readJsonWithBackupRecovery>>;
    try {
      recoveryResult = await readJsonWithBackupRecovery(filePath, `${filePath}.bak`);
    } catch {
      /**
       * 意图文件与备份均损坏：**不**猜测基线（也不假装校验过），按"无基线"处理，
       * 让调用方退回既有防护；损坏本身不阻塞产品写入。
       */
      return { schemaVersion: 1, agentInstanceId, intents: [] };
    }
    if (recoveryResult === null) {
      return { schemaVersion: 1, agentInstanceId, intents: [] };
    }
    const parsed = recoveryResult.content as Partial<AgentEditIntentDocument> | null;
    if (parsed === null || !Array.isArray(parsed.intents)) {
      return { schemaVersion: 1, agentInstanceId, intents: [] };
    }
    const validIntents = parsed.intents.filter(
      (intent): intent is AgentEditIntent =>
        intent !== null &&
        typeof intent === "object" &&
        typeof (intent as AgentEditIntent).taskExecutionIdentifier === "string" &&
        typeof (intent as AgentEditIntent).initialResourceFingerprintsByPath === "object" &&
        (intent as AgentEditIntent).initialResourceFingerprintsByPath !== null,
    );
    return { schemaVersion: 1, agentInstanceId, intents: validIntents };
  }

  private async saveDocument(document: AgentEditIntentDocument): Promise<void> {
    const filePath = this.filePathForAgent(document.agentInstanceId);
    // 写前备份既有主文件（非破坏性 API），使损坏时可经 readJsonWithBackupRecovery 恢复。
    await backupExistingFile(filePath, `${filePath}.bak`);
    await writeAtomicJson(filePath, document);
  }
}
