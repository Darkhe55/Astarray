/**
 * 工具内破坏性变更备份层（T06A）。
 *
 * 原则：
 * - 文件/目录删除、文字删除、替换、截断和覆盖必须先由工具自动保存完整 pre-image；
 *   自动备份过程不经过模型（BackupVault 由 harness 在工具执行前调用）。
 * - 备份数据、路径与恢复能力不经过模型端；ToolBackupReceipt 只在工具/恢复子系统内部流转。
 * - 删除备份走独立特权入口 deleteBackup：协同模式必须警告、暂停发起 Agent 并逐次取得用户授权
 *   （backup-deletion-warning，禁止会话级记忆）；放权模式不提示但写入高查阅优先级审计日志。
 * - 采用 quarantine 两阶段删除：先隔离（quarantined），再清除（purged），防止递归与死锁。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION } from "../core/types.js";
import { BACKUP_DELETION_AUDIT_PRIORITY } from "../core/types.js";
import type {
  AgentMode,
  BackupDeletionAuditRecord,
  BackupDeletionAuthorizationControlPort,
  BackupDeletionAuthorizationDecision,
  BackupDeletionAuthorizationRequest,
  BackupSummary,
  ReadBackupResult,
  ToolBackupReceipt,
  ToolBackupServicePort,
} from "../core/types.js";
import { writeAtomicJson } from "../infra/atomic-json.js";

export interface BackupVaultEntry {
  backupIdentifier: string;
  createdAtIso: string;
  toolName: string;
  targetPath: string;
  mutationKind: "delete-resource" | "delete-content" | "overwrite" | "replace" | "truncate";
  targetFingerprintBeforeMutation: string;
  backupContentHash: string;
  restoreCapabilityIdentifier: string;
  status: "active" | "quarantined" | "purged";
  quarantinedAtIso: string | null;
  purgedAtIso: string | null;
}

export interface BackupVaultManifest {
  schemaVersion: number;
  revision: number;
  updatedAtIso: string;
  entries: BackupVaultEntry[];
}

/**
 * pre-image 快照文档：文件型单条目；目录型递归条目（base64 内容，支持二进制）。
 * 指纹 = 对规范化快照内容的 SHA-256。
 */
export interface BackupSnapshotEntry {
  relativePath: string;
  contentBase64: string;
}

export interface BackupSnapshotDocument {
  schemaVersion: 1;
  kind: "file" | "directory";
  entries: BackupSnapshotEntry[];
}

function snapshotFingerprint(snapshot: BackupSnapshotDocument): string {
  const canonical = JSON.stringify(snapshot);
  return createHash("sha256").update(canonical).digest("hex");
}

function isValidSnapshotDocument(value: unknown): value is BackupSnapshotDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<BackupSnapshotDocument>;
  return (
    candidate.schemaVersion === 1 &&
    (candidate.kind === "file" || candidate.kind === "directory") &&
    Array.isArray(candidate.entries) &&
    candidate.entries.length > 0 &&
    candidate.entries.every(
      (entry) =>
        typeof entry.relativePath === "string" &&
        typeof entry.contentBase64 === "string",
    )
  );
}

/**
 * 探测内容是否为可读文本：可 UTF-8 解码且不含 NUL 字节。
 * 用于 readBackup 的编码选择（AR-01：不得无条件按 UTF-8 损坏二进制）。
 */
function isUtf8TextContent(content: Buffer): boolean {
  if (content.includes(0x00)) {
    return false;
  }
  const decoded = content.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(content);
}

export interface BackupVaultOptions {
  baseDirectory: string;
}

export class BackupVault implements ToolBackupServicePort {
  private readonly vaultDirectory: string;
  private readonly backupDataDirectory: string;
  private readonly manifestPath: string;
  private manifest: BackupVaultManifest;

  constructor(options: BackupVaultOptions) {
    this.vaultDirectory = path.join(options.baseDirectory, "backup-vault");
    this.backupDataDirectory = path.join(this.vaultDirectory, "data");
    this.manifestPath = path.join(this.vaultDirectory, "manifest.json");
    this.manifest = {
      schemaVersion: DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION,
      revision: 0,
      updatedAtIso: new Date().toISOString(),
      entries: [],
    };
  }

  /** 启动时加载清单（损坏则视为空清单并回写，绝不把备份数据当模型上下文）。 */
  async initialize(): Promise<void> {
    try {
      const rawContent = await fs.readFile(this.manifestPath, "utf8");
      const parsed = JSON.parse(rawContent) as BackupVaultManifest;
      if (
        parsed.schemaVersion === DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION &&
        Array.isArray(parsed.entries)
      ) {
        this.manifest = parsed;
        return;
      }
    } catch {
      // 清单缺失或损坏：重建空清单
    }
    await this.persistManifest();
  }

  /**
   * 破坏性变更前自动保存完整 pre-image（由 PolicyWrapper 在工具执行前调用，不经过模型）。
   * 支持二进制文件与目录递归快照；pre-image 以 base64 快照文档持久化。
   */
  async createPreMutationBackup(input: {
    toolName: string;
    targetPath: string;
    mutationKind: "delete-resource" | "delete-content" | "overwrite" | "replace" | "truncate";
  }): Promise<ToolBackupReceipt> {
    const absoluteTargetPath = path.resolve(input.targetPath);
    const snapshot = await this.captureTargetSnapshot(absoluteTargetPath);
    const backupIdentifier = `backup-${randomUUID()}`;
    const preImagePath = path.join(this.backupDataDirectory, backupIdentifier);
    await fs.mkdir(this.backupDataDirectory, { recursive: true });
    await fs.writeFile(preImagePath, JSON.stringify(snapshot), "utf8");

    const targetFingerprintBeforeMutation = snapshotFingerprint(snapshot);
    const backupContentHash = targetFingerprintBeforeMutation;
    const restoreCapabilityIdentifier = `restore:${backupIdentifier}:${randomUUID()}`;

    this.manifest.entries.push({
      backupIdentifier,
      createdAtIso: new Date().toISOString(),
      toolName: input.toolName,
      targetPath: absoluteTargetPath,
      mutationKind: input.mutationKind,
      targetFingerprintBeforeMutation,
      backupContentHash,
      restoreCapabilityIdentifier,
      status: "active",
      quarantinedAtIso: null,
      purgedAtIso: null,
    });
    await this.persistManifest();

    return {
      backupIdentifier,
      createdAtIso: this.manifest.entries.at(-1)!.createdAtIso,
      mutationKind: input.mutationKind,
      targetFingerprintBeforeMutation,
      backupContentHash,
      restoreCapabilityIdentifier,
    };
  }

  /**
   * TOCTOU 闭环校验（审计 S3）：确认目标在备份后未被第三方修改。
   * 变更工具必须在写入前调用；指纹不一致返回 false，调用方应中止写入。
   */
  async verifyTargetUnchanged(
    targetPath: string,
    expectedFingerprint: string,
  ): Promise<boolean> {
    try {
      const currentSnapshot = await this.captureTargetSnapshot(path.resolve(targetPath));
      return snapshotFingerprint(currentSnapshot) === expectedFingerprint;
    } catch {
      return false;
    }
  }

  /** 列出备份公开摘要（AR-01 DTO：不含对象哈希、能力标识与物理路径）。 */
  async listBackups(missionId: string | null): Promise<BackupSummary[]> {
    void missionId;
    return this.manifest.entries
      .filter((entry) => entry.status !== "purged")
      .map((entry) => ({
        backupIdentifier: entry.backupIdentifier,
        createdAtIso: entry.createdAtIso,
        toolName: entry.toolName,
        targetPath: entry.targetPath,
        mutationKind: entry.mutationKind,
        status: entry.status,
        quarantinedAtIso: entry.quarantinedAtIso,
        purgedAtIso: entry.purgedAtIso,
      }));
  }

  /**
   * 受控读取备份内容（AR-01）。
   * 返回显式编码与媒体类型：文本 utf-8 原文、二进制 base64、目录为结构化清单；
   * 不按 UTF-8 无条件解码二进制内容。
   */
  async readBackup(backupIdentifier: string): Promise<ReadBackupResult> {
    const snapshot = await this.readSnapshot(backupIdentifier);
    if (snapshot.kind === "directory") {
      const directoryListing = snapshot.entries
        .map(
          (entry) =>
            `${entry.relativePath} (${entry.contentBase64.length} B)`,
        )
        .join("\n");
      return {
        encoding: "utf-8",
        mediaType: "application/vnd.astarray.directory-snapshot",
        content: directoryListing,
      };
    }
    const content = Buffer.from(snapshot.entries[0]!.contentBase64, "base64");
    if (isUtf8TextContent(content)) {
      return {
        encoding: "utf-8",
        mediaType: "text/plain; charset=utf-8",
        content: content.toString("utf8"),
      };
    }
    return {
      encoding: "base64",
      mediaType: "application/octet-stream",
      content: content.toString("base64"),
    };
  }

  /**
   * 恢复：先将当前目标自动备份（恢复本身可撤销，审计 S3），再写回 pre-image。
   */
  async restoreBackup(backupIdentifier: string): Promise<{ restoredPath: string }> {
    const entry = this.manifest.entries.find(
      (candidate) => candidate.backupIdentifier === backupIdentifier,
    );
    if (entry === undefined || entry.status === "purged") {
      throw new DomainError("mission-not-found", `备份不存在: ${backupIdentifier}`);
    }
    const snapshot = await this.readSnapshot(backupIdentifier);
    // 恢复前先自动备份当前版本，使恢复操作可撤销
    await this.createPreMutationBackup({
      toolName: "backupVault.restore",
      targetPath: entry.targetPath,
      mutationKind: "overwrite",
    });
    await this.writeSnapshotToTarget(snapshot, entry.targetPath);
    return { restoredPath: entry.targetPath };
  }

  /**
   * 两阶段删除 - 阶段 1：隔离。备份移入隔离状态，数据文件保留。
   * 由 deleteBackup 特权入口在取得授权后调用。
   */
  async quarantineBackups(backupIdentifiers: string[]): Promise<string[]> {
    const quarantined: string[] = [];
    for (const backupIdentifier of backupIdentifiers) {
      const entry = this.manifest.entries.find(
        (candidate) => candidate.backupIdentifier === backupIdentifier,
      );
      if (entry === undefined || entry.status !== "active") {
        continue;
      }
      entry.status = "quarantined";
      entry.quarantinedAtIso = new Date().toISOString();
      quarantined.push(backupIdentifier);
    }
    await this.persistManifest();
    return quarantined;
  }

  /**
   * 两阶段删除 - 阶段 2：清除。删除隔离区数据文件并从清单移除。
   * 物理删除失败（非 ENOENT）时抛错且不标记 purged，避免"已删除"虚报（审计 S3）。
   */
  async purgeQuarantinedBackups(backupIdentifiers: string[]): Promise<string[]> {
    const purged: string[] = [];
    for (const backupIdentifier of backupIdentifiers) {
      const entryIndex = this.manifest.entries.findIndex(
        (candidate) => candidate.backupIdentifier === backupIdentifier,
      );
      if (entryIndex < 0) {
        continue;
      }
      const entry = this.manifest.entries[entryIndex]!;
      if (entry.status !== "quarantined") {
        continue;
      }
      const preImagePath = path.join(this.backupDataDirectory, backupIdentifier);
      try {
        await fs.rm(preImagePath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // 数据文件已不存在：视为已清除
        } else {
          throw new DomainError(
            "tool-execution-failed",
            `清除备份数据失败（保持 quarantined）: ${backupIdentifier}（${(error as Error).message}）`,
          );
        }
      }
      entry.status = "purged";
      entry.purgedAtIso = new Date().toISOString();
      purged.push(backupIdentifier);
    }
    await this.persistManifest();
    return purged;
  }

  /** 清单当前 revision（删除授权决策校验用）。 */
  getManifestRevision(): number {
    return this.manifest.revision;
  }

  /** 读取指定备份的快照文档（不存在或已清除时抛错）。 */
  private async readSnapshot(backupIdentifier: string): Promise<BackupSnapshotDocument> {
    const entry = this.manifest.entries.find(
      (candidate) => candidate.backupIdentifier === backupIdentifier,
    );
    if (entry === undefined || entry.status === "purged") {
      throw new DomainError("mission-not-found", `备份不存在: ${backupIdentifier}`);
    }
    const preImagePath = path.join(this.backupDataDirectory, backupIdentifier);
    const rawContent = await fs.readFile(preImagePath, "utf8");
    const parsed = JSON.parse(rawContent) as BackupSnapshotDocument;
    if (!isValidSnapshotDocument(parsed)) {
      throw new DomainError("journal-corrupted", `备份快照损坏: ${backupIdentifier}`);
    }
    return parsed;
  }

  /**
   * 捕获目标当前快照：缺失视为空文件；目录递归收集（跳过符号链接，防循环与逃逸）；
   * 文件以二进制 base64 保存，支持任意编码。
   */
  private async captureTargetSnapshot(
    targetPath: string,
  ): Promise<BackupSnapshotDocument> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, kind: "file", entries: [{ relativePath: "", contentBase64: "" }] };
      }
      throw error;
    }
    if (stat.isDirectory()) {
      const entries: BackupSnapshotEntry[] = [];
      await this.collectDirectorySnapshot(targetPath, targetPath, entries);
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      return { schemaVersion: 1, kind: "directory", entries };
    }
    const content = await fs.readFile(targetPath);
    return {
      schemaVersion: 1,
      kind: "file",
      entries: [{ relativePath: "", contentBase64: content.toString("base64") }],
    };
  }

  private async collectDirectorySnapshot(
    rootPath: string,
    currentPath: string,
    collectedEntries: BackupSnapshotEntry[],
  ): Promise<void> {
    const directoryEntries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const directoryEntry of directoryEntries) {
      const absoluteEntryPath = path.join(currentPath, directoryEntry.name);
      if (directoryEntry.isSymbolicLink()) {
        continue;
      }
      const relativePath = path.relative(rootPath, absoluteEntryPath);
      if (directoryEntry.isDirectory()) {
        await this.collectDirectorySnapshot(rootPath, absoluteEntryPath, collectedEntries);
        continue;
      }
      if (directoryEntry.isFile()) {
        const content = await fs.readFile(absoluteEntryPath);
        collectedEntries.push({
          relativePath,
          contentBase64: content.toString("base64"),
        });
      }
    }
  }

  /** 将快照写回目标路径（文件重建；目录递归重建）。 */
  private async writeSnapshotToTarget(
    snapshot: BackupSnapshotDocument,
    targetPath: string,
  ): Promise<void> {
    if (snapshot.kind === "file") {
      const content = Buffer.from(snapshot.entries[0]!.contentBase64, "base64");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
      return;
    }
    await fs.mkdir(targetPath, { recursive: true });
    for (const entry of snapshot.entries) {
      const entryPath = path.join(targetPath, entry.relativePath);
      await fs.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.writeFile(entryPath, Buffer.from(entry.contentBase64, "base64"));
    }
  }

  private async persistManifest(): Promise<void> {
    this.manifest.revision += 1;
    this.manifest.updatedAtIso = new Date().toISOString();
    await writeAtomicJson(this.manifestPath, this.manifest);
  }
}

export class BackupDeletionAuditLog {
  private readonly auditFilePath: string;

  constructor(baseDirectory: string) {
    this.auditFilePath = path.join(baseDirectory, "backup-deletion-audit.jsonl");
  }

  /** 追加一条不可删除的高查阅优先级审计记录（哈希链）。 */
  async appendRecord(input: {
    requestingAgentInstanceId: string;
    mode: AgentMode;
    backupIdentifiers: string[];
    outcome: BackupDeletionAuditRecord["outcome"];
  }): Promise<BackupDeletionAuditRecord> {
    const previousRecordHash = await this.readLastRecordHash();
    const record: BackupDeletionAuditRecord = {
      auditRecordId: `audit-${randomUUID()}`,
      recordedAtIso: new Date().toISOString(),
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      mode: input.mode,
      backupIdentifiers: input.backupIdentifiers,
      outcome: input.outcome,
      reviewPriority: BACKUP_DELETION_AUDIT_PRIORITY,
      previousRecordHash,
      recordHash: "",
    };
    record.recordHash = createHash("sha256")
      .update(`${previousRecordHash ?? ""}${JSON.stringify(record)}`)
      .digest("hex");
    await fs.appendFile(this.auditFilePath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  private async readLastRecordHash(): Promise<string | null> {
    try {
      const rawContent = await fs.readFile(this.auditFilePath, "utf8");
      const lines = rawContent.trim().split("\n").filter(Boolean);
      const lastLine = lines.at(-1);
      if (lastLine === undefined) {
        return null;
      }
      const parsed = JSON.parse(lastLine) as BackupDeletionAuditRecord;
      return parsed.recordHash ?? null;
    } catch {
      return null;
    }
  }

  /** 供审计视图读取全部记录。 */
  async readAllRecords(): Promise<BackupDeletionAuditRecord[]> {
    try {
      const rawContent = await fs.readFile(this.auditFilePath, "utf8");
      return rawContent
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as BackupDeletionAuditRecord);
    } catch {
      return [];
    }
  }
}

export interface BackupDeletionAuthorizationControllerOptions {
  mode: () => AgentMode;
  /** 协同模式下的用户授权控制通道（专用，不走普通消息队列）。 */
  controlPort: BackupDeletionAuthorizationControlPort | null;
  auditLog: BackupDeletionAuditLog;
  nowIso?: () => string;
  /**
   * 授权校验后读取备份库的"当前最新 revision"。
   * 用户授权绑定的是授权时的 revision；等待授权期间清单变化则授权作废（审计 S4）。
   */
  readCurrentVaultRevision: () => Promise<number> | number;
}

/**
 * 删除备份的特权授权控制器。
 * - 协同模式：构造警告 → 请求用户逐次授权（allow-once，无会话记忆）→ 校验 vault revision。
 * - 放权模式：不提示用户，直接写 HIGH 审计记录。
 * 结果统一以审计记录落盘。
 */
export class BackupDeletionAuthorizationController {
  private readonly nowIso: () => string;

  constructor(private readonly options: BackupDeletionAuthorizationControllerOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * 对指定备份发起授权。返回授权决定；协同模式未获授权时抛 DomainError（backup-deletion 拒绝）。
   * 严格校验（审计 S4）：授权请求 ID、发起 Agent、精确备份 ID 集合、过期时间、
   * 授权绑定的 revision 与等待授权后读取的"当前最新 revision"一致。
   */
  async requestDeletionAuthorization(input: {
    requestingAgentInstanceId: string;
    toolCallId: string;
    backupIdentifiers: string[];
    warningText: string;
    expectedVaultRevision: number;
  }): Promise<BackupDeletionAuthorizationDecision> {
    const currentMode = this.options.mode();
    const request: BackupDeletionAuthorizationRequest = {
      authorizationRequestId: randomUUID(),
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      toolCallId: input.toolCallId,
      backupIdentifiers: input.backupIdentifiers,
      warningText: input.warningText,
      createdAtIso: this.nowIso(),
      canRememberForSession: false,
    };

    if (currentMode === "devolve") {
      await this.options.auditLog.appendRecord({
        requestingAgentInstanceId: input.requestingAgentInstanceId,
        mode: currentMode,
        backupIdentifiers: input.backupIdentifiers,
        outcome: "authorized",
      });
      return {
        authorizationRequestId: request.authorizationRequestId,
        requestingAgentInstanceId: input.requestingAgentInstanceId,
        decision: "allow-once",
        authorizedBackupIdentifiers: input.backupIdentifiers,
        expectedVaultRevision: input.expectedVaultRevision,
        expiresAtIso: this.nowIso(),
      };
    }

    if (this.options.controlPort === null) {
      await this.options.auditLog.appendRecord({
        requestingAgentInstanceId: input.requestingAgentInstanceId,
        mode: currentMode,
        backupIdentifiers: input.backupIdentifiers,
        outcome: "rejected",
      });
      throw new DomainError(
        "tool-permission-denied",
        `协同模式缺少删除备份授权通道，拒绝删除: ${input.backupIdentifiers.join(",")}`,
      );
    }

    const decision = await this.options.controlPort.requestAuthorization(request);
    if (decision.decision === "deny") {
      await this.recordAuthorizationFailure(input, currentMode, "rejected");
      throw new DomainError(
        "tool-permission-denied",
        `用户拒绝删除备份: ${input.backupIdentifiers.join(",")}`,
      );
    }
    // 严格绑定校验：请求 ID / 发起 Agent / 精确备份 ID 集合 / 授权请求自身绑定
    const bindingErrors = this.validateDecisionBinding(request, decision, input);
    if (bindingErrors !== null) {
      await this.recordAuthorizationFailure(input, currentMode, "failed");
      throw new DomainError("mission-locked", `删除授权绑定校验失败: ${bindingErrors}`);
    }
    // 授权过期校验
    if (new Date(decision.expiresAtIso).getTime() <= Date.now()) {
      await this.recordAuthorizationFailure(input, currentMode, "failed");
      throw new DomainError(
        "mission-locked",
        "删除授权已过期，请重新授权",
      );
    }
    // 等待授权后读取"当前最新 revision"，与用户授权的 revision 比对（授权期间清单变化即作废）
    const currentVaultRevision = await this.options.readCurrentVaultRevision();
    if (currentVaultRevision !== decision.expectedVaultRevision) {
      await this.recordAuthorizationFailure(input, currentMode, "failed");
      throw new DomainError(
        "mission-locked",
        `备份库当前 revision ${currentVaultRevision} 与授权绑定的 ${decision.expectedVaultRevision} 不一致，授权作废`,
      );
    }
    await this.options.auditLog.appendRecord({
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      mode: currentMode,
      backupIdentifiers: input.backupIdentifiers,
      outcome: "authorized",
    });
    return decision;
  }

  private validateDecisionBinding(
    request: BackupDeletionAuthorizationRequest,
    decision: BackupDeletionAuthorizationDecision,
    input: {
      requestingAgentInstanceId: string;
      backupIdentifiers: string[];
      expectedVaultRevision: number;
    },
  ): string | null {
    if (decision.authorizationRequestId !== request.authorizationRequestId) {
      return "授权请求 ID 不匹配";
    }
    if (decision.requestingAgentInstanceId !== input.requestingAgentInstanceId) {
      return "发起 Agent ID 不匹配";
    }
    const requestedSet = [...input.backupIdentifiers].sort();
    const authorizedSet = [...decision.authorizedBackupIdentifiers].sort();
    if (
      requestedSet.length !== authorizedSet.length ||
      requestedSet.some((identifier, index) => identifier !== authorizedSet[index])
    ) {
      return "授权备份 ID 集合与请求不一致（仅允许精确集合）";
    }
    if (decision.expectedVaultRevision !== input.expectedVaultRevision) {
      return "授权绑定的 revision 与请求不一致";
    }
    return null;
  }

  private async recordAuthorizationFailure(
    input: {
      requestingAgentInstanceId: string;
      backupIdentifiers: string[];
    },
    mode: AgentMode,
    outcome: "rejected" | "failed",
  ): Promise<void> {
    await this.options.auditLog.appendRecord({
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      mode,
      backupIdentifiers: input.backupIdentifiers,
      outcome,
    });
  }

  /** 删除执行过程中的阶段审计（quarantined / purged / failed）。 */
  async appendOutcomeAudit(
    requestingAgentInstanceId: string,
    backupIdentifiers: string[],
    outcome: "quarantined" | "purged" | "failed",
  ): Promise<void> {
    await this.options.auditLog.appendRecord({
      requestingAgentInstanceId,
      mode: this.options.mode(),
      backupIdentifiers,
      outcome,
    });
  }
}
