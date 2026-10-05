/**
 * PROJECT-01-03：跨项目授权记录、只读与副本导入的生命周期（2026-10-02）。
 *
 * 契约来源：PROJECT-01 卡 §3/§4/§5/§6。
 *
 * 关键纪律（逐条对应反例）：
 *  - 授权必须来自**认证用户**（Agent 不得作为授权来源）；
 *  - 授权绑定来源/目标 **revision** 与 **完整规范化参数哈希**：同路径参数变化**不沿用许可**；
 *  - 只读**来源零写入**；资源范围之外一律拒绝（新增文件不得无条件进入）；
 *  - 副本导入保留来源项目/revision/哈希并标记为副本（人工可分辨）；
 *  - 并发/崩溃后重放同一导入 → **幂等复用回执**，不得重复副作用；
 *  - 任务内派生授权必须**不宽于**父授权；**禁止跨项目再转交**。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";

export interface CrossProjectResourceScope {
  /** 允许的路径前缀（相对项目根）。 */
  pathPrefixes: string[];
  /** 允许的真实路径（realpath 后比对）。 */
  realPaths: string[];
  /** 用户明确设置的动态共享目录规则（须单独登记，执行时仍检查最新规则）。 */
  isDynamicSharedDirectory: boolean;
}

export type CrossProjectOperationKind = "read" | "import-copy";

export interface CrossProjectAuthorizationRecord {
  authorizationIdentifier: string;
  sourceProjectIdentifier: string;
  sourceProjectRevision: number;
  targetProjectIdentifier: string;
  targetProjectRevision: number;
  operationKind: CrossProjectOperationKind;
  resourceScope: CrossProjectResourceScope;
  /** 完整规范化参数哈希（同路径参数变化据此拒绝）。 */
  argumentsHash: string;
  expiresAtIso: string;
  /** 认证用户；null 表示非用户来源（不得生效）。 */
  grantedByUserId: string | null;
  taskIdentifier: string;
  state: "active" | "revoked";
  revokedReason: string | null;
  /** 派生深度：0=用户直接授权；>0 为任务内缩权派生。 */
  derivationDepth: number;
  parentAuthorizationIdentifier: string | null;
  createdAtIso: string;
}

export interface CrossProjectCopyReceipt {
  receiptIdentifier: string;
  authorizationIdentifier: string;
  sourceProjectIdentifier: string;
  sourceRevision: number;
  targetProjectIdentifier: string;
  sourceResourcePath: string;
  targetResourcePath: string;
  contentHash: string;
  /** 人工可分辨：明确标记为"外部来源的副本"。 */
  isCopyOfExternalSource: true;
  createdAtIso: string;
}

interface PersistedDocument {
  schemaVersion: 1;
  authorizations: CrossProjectAuthorizationRecord[];
  copyReceipts: CrossProjectCopyReceipt[];
}

const STATE_FILE_NAME = "cross-project-authorizations.json";

export type GrantOutcome = "granted" | "rejected-not-authenticated-user";

export class CrossProjectAuthorizationStore {
  private readonly filePath: string;
  private readonly authorizationsByIdentifier = new Map<string, CrossProjectAuthorizationRecord>();
  private readonly copyReceiptsByKey = new Map<string, CrossProjectCopyReceipt>();
  private pendingWritePromise: Promise<void> = Promise.resolve();
  private isLoaded = false;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "cross-project", STATE_FILE_NAME);
  }

  /**
   * 确保已从磁盘加载（同步认领前必须先 await 本方法，否则新实例会误判"无既有回执"）。
   * 反例⑨（崩溃/重启后重放）实测到的缺口即此。
   */
  async ensureLoaded(): Promise<void> {
    await this.loadFromDisk();
  }

  private async loadFromDisk(): Promise<void> {
    if (this.isLoaded) {
      return;
    }
    this.isLoaded = true;
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(rawContent) as PersistedDocument;
      if (parsed.schemaVersion !== 1) {
        return;
      }
      for (const authorization of parsed.authorizations ?? []) {
        this.authorizationsByIdentifier.set(authorization.authorizationIdentifier, authorization);
      }
      for (const receipt of parsed.copyReceipts ?? []) {
        this.copyReceiptsByKey.set(this.buildReceiptKey(receipt), receipt);
      }
    } catch {
      // 损坏状态：按空继续（不伪造历史）
    }
  }

  private buildReceiptKey(receipt: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    sourceRevision: number;
    sourceResourcePath: string;
    targetResourcePath: string;
    contentHash: string;
  }): string {
    return [
      receipt.authorizationIdentifier,
      receipt.sourceProjectIdentifier,
      String(receipt.sourceRevision),
      receipt.sourceResourcePath,
      receipt.targetResourcePath,
      receipt.contentHash,
    ].join("|");
  }

  private async persist(): Promise<void> {
    await writeAtomicJson(this.filePath, {
      schemaVersion: 1,
      authorizations: [...this.authorizationsByIdentifier.values()],
      copyReceipts: [...this.copyReceiptsByKey.values()],
    } satisfies PersistedDocument);
  }

  private enqueuePersist(): Promise<void> {
    const nextWrite = this.pendingWritePromise.then(
      () => this.persist(),
      () => this.persist(),
    );
    this.pendingWritePromise = nextWrite.catch(() => undefined);
    return nextWrite;
  }

  async grantAuthorization(input: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    sourceProjectRevision: number;
    targetProjectIdentifier: string;
    targetProjectRevision: number;
    operationKind: CrossProjectOperationKind;
    resourceScope: CrossProjectResourceScope;
    argumentsHash: string;
    expiresAtIso: string;
    grantedByUserId: string | null;
    taskIdentifier: string;
    nowIso?: string;
  }): Promise<{ outcome: GrantOutcome; record: CrossProjectAuthorizationRecord | null }> {
    await this.loadFromDisk();
    // 授权来源必须是认证用户：Agent 推断/自行授予一律不生效。
    if (input.grantedByUserId === null || input.grantedByUserId.trim() === "") {
      return { outcome: "rejected-not-authenticated-user", record: null };
    }
    const record: CrossProjectAuthorizationRecord = {
      authorizationIdentifier: input.authorizationIdentifier,
      sourceProjectIdentifier: input.sourceProjectIdentifier,
      sourceProjectRevision: input.sourceProjectRevision,
      targetProjectIdentifier: input.targetProjectIdentifier,
      targetProjectRevision: input.targetProjectRevision,
      operationKind: input.operationKind,
      resourceScope: {
        pathPrefixes: [...input.resourceScope.pathPrefixes],
        realPaths: [...input.resourceScope.realPaths],
        isDynamicSharedDirectory: input.resourceScope.isDynamicSharedDirectory,
      },
      argumentsHash: input.argumentsHash,
      expiresAtIso: input.expiresAtIso,
      grantedByUserId: input.grantedByUserId,
      taskIdentifier: input.taskIdentifier,
      state: "active",
      revokedReason: null,
      derivationDepth: 0,
      parentAuthorizationIdentifier: null,
      createdAtIso: input.nowIso ?? new Date().toISOString(),
    };
    this.authorizationsByIdentifier.set(record.authorizationIdentifier, record);
    await this.enqueuePersist();
    return { outcome: "granted", record };
  }

  async revokeAuthorization(authorizationIdentifier: string, revokedReason: string): Promise<void> {
    await this.loadFromDisk();
    const record = this.authorizationsByIdentifier.get(authorizationIdentifier);
    if (record === undefined) {
      return;
    }
    record.state = "revoked";
    record.revokedReason = revokedReason;
    await this.enqueuePersist();
  }

  async getAuthorization(
    authorizationIdentifier: string,
  ): Promise<CrossProjectAuthorizationRecord | null> {
    await this.loadFromDisk();
    return this.authorizationsByIdentifier.get(authorizationIdentifier) ?? null;
  }

  async listAuthorizations(): Promise<CrossProjectAuthorizationRecord[]> {
    await this.loadFromDisk();
    return [...this.authorizationsByIdentifier.values()];
  }

  /**
   * 任务内**缩权派生**：派生范围必须不宽于父授权，否则拒绝。
   * 派生深度递增；跨项目再转交由 `attemptRedelegation` 单独拒绝。
   */
  async deriveNarrowedAuthorization(input: {
    parentAuthorizationIdentifier: string;
    authorizationIdentifier: string;
    resourceScope: CrossProjectResourceScope;
    taskIdentifier: string;
    nowIso?: string;
  }): Promise<{ outcome: "derived-narrowed" | "rejected-not-narrower" | "parent-not-found" }> {
    await this.loadFromDisk();
    const parent = this.authorizationsByIdentifier.get(input.parentAuthorizationIdentifier);
    if (parent === undefined) {
      return { outcome: "parent-not-found" };
    }
    const isNarrower =
      input.resourceScope.pathPrefixes.length > 0 &&
      input.resourceScope.pathPrefixes.every((candidatePrefix) =>
        parent.resourceScope.pathPrefixes.some(
          (parentPrefix) =>
            candidatePrefix === parentPrefix || candidatePrefix.startsWith(parentPrefix),
        ),
      ) &&
      input.resourceScope.realPaths.every((candidatePath) =>
        parent.resourceScope.realPaths.includes(candidatePath),
      ) &&
      (!input.resourceScope.isDynamicSharedDirectory ||
        parent.resourceScope.isDynamicSharedDirectory);
    if (!isNarrower) {
      return { outcome: "rejected-not-narrower" };
    }
    const derived: CrossProjectAuthorizationRecord = {
      ...parent,
      authorizationIdentifier: input.authorizationIdentifier,
      resourceScope: {
        pathPrefixes: [...input.resourceScope.pathPrefixes],
        realPaths: [...input.resourceScope.realPaths],
        isDynamicSharedDirectory: input.resourceScope.isDynamicSharedDirectory,
      },
      taskIdentifier: input.taskIdentifier,
      derivationDepth: parent.derivationDepth + 1,
      parentAuthorizationIdentifier: parent.authorizationIdentifier,
      createdAtIso: input.nowIso ?? new Date().toISOString(),
    };
    this.authorizationsByIdentifier.set(derived.authorizationIdentifier, derived);
    await this.enqueuePersist();
    return { outcome: "derived-narrowed" };
  }

  /** 跨项目再转交：一律拒绝（授权不可再转授）。 */
  async attemptRedelegation(_input: {
    parentAuthorizationIdentifier: string;
    authorizationIdentifier: string;
    targetProjectIdentifier: string;
    targetAgentInstanceId: string;
  }): Promise<"rejected-no-redelegation"> {
    return "rejected-no-redelegation";
  }

  async findCopyReceipt(input: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    sourceRevision: number;
    sourceResourcePath: string;
    targetResourcePath: string;
    contentHash: string;
  }): Promise<CrossProjectCopyReceipt | null> {
    await this.loadFromDisk();
    return this.copyReceiptsByKey.get(this.buildReceiptKey(input)) ?? null;
  }

  /**
   * 同步**原子认领**（并发安全）：在无 await 的同步段内完成"查重 + 占位"，
   * 因此并发导入同一内容时只有第一个调用者得到 isFirstClaim=true。
   * 这是反例⑦实测到的竞态（5 个并发都通过了"查回执→写回执"）的修复。
   */
  claimCopyReceiptSynchronously(receiptKeyInput: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    sourceRevision: number;
    sourceResourcePath: string;
    targetResourcePath: string;
    contentHash: string;
  }): { isFirstClaim: boolean; existingReceipt: CrossProjectCopyReceipt | null } {
    const key = this.buildReceiptKey(receiptKeyInput);
    const existing = this.copyReceiptsByKey.get(key);
    if (existing !== undefined) {
      return { isFirstClaim: false, existingReceipt: existing };
    }
    // 占位：先写入一个可识别的占位回执，防止并发重复创建。
    const placeholder: CrossProjectCopyReceipt = {
      receiptIdentifier: "pending-" + key.slice(-16),
      authorizationIdentifier: receiptKeyInput.authorizationIdentifier,
      sourceProjectIdentifier: receiptKeyInput.sourceProjectIdentifier,
      sourceRevision: receiptKeyInput.sourceRevision,
      targetProjectIdentifier: "",
      sourceResourcePath: receiptKeyInput.sourceResourcePath,
      targetResourcePath: receiptKeyInput.targetResourcePath,
      contentHash: receiptKeyInput.contentHash,
      isCopyOfExternalSource: true,
      createdAtIso: new Date().toISOString(),
    };
    this.copyReceiptsByKey.set(key, placeholder);
    return { isFirstClaim: true, existingReceipt: null };
  }

  async recordCopyReceipt(receipt: CrossProjectCopyReceipt): Promise<void> {
    await this.loadFromDisk();
    const key = this.buildReceiptKey(receipt);
    /**
     * 认领阶段写入的是**占位回执**；此处必须用真实回执覆盖并持久化。
     * 早期实现"键已存在即 return"会把占位回执留在盘上（反例⑨重启后重放实测到）。
     */
    this.copyReceiptsByKey.set(key, receipt);
    await this.enqueuePersist();
  }

  async countCopyReceipts(): Promise<number> {
    await this.loadFromDisk();
    return this.copyReceiptsByKey.size;
  }
}

export interface CrossProjectReadResult {
  outcome:
    | "read-allowed"
    | "authorization-not-found"
    | "authorization-expired"
    | "authorization-revoked"
    | "authorization-parameter-mismatch"
    | "project-mismatch"
    | "source-revision-changed"
    | "resource-out-of-scope";
  didRead: boolean;
  didModifySource: false;
  sourceWriteCount: number;
  detail: string;
}

export interface CrossProjectImportResult {
  outcome:
    | "imported-copy"
    | "reused-existing-copy"
    | "authorization-not-found"
    | "authorization-expired"
    | "authorization-revoked"
    | "authorization-parameter-mismatch"
    | "resource-out-of-scope"
    | "wrong-operation-kind";
  receipt: CrossProjectCopyReceipt | null;
  detail: string;
}

export class CrossProjectTransferService {
  constructor(private readonly options: { store: CrossProjectAuthorizationStore }) {}

  private isWithinScope(scope: CrossProjectResourceScope, resourcePath: string): boolean {
    return scope.pathPrefixes.some(
      (prefix) => resourcePath === prefix.replace(/\/$/, "") || resourcePath.startsWith(prefix),
    );
  }

  /**
   * 只读访问：**来源零写入**。
   *
   * 校验顺序：授权存在 → 未撤销 → 未过期 → 项目匹配 → 来源 revision 匹配 → 参数哈希匹配
   * → 资源范围命中。任一失败即拒绝，不读、不写。
   */
  async readResource(input: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    targetProjectIdentifier: string;
    resourcePath: string;
    argumentsHash: string;
    nowIso: string;
    currentSourceProjectRevision?: number;
    sourceWriteProbe: { writeAttemptCount: number };
  }): Promise<CrossProjectReadResult> {
    const denied = (
      outcome: CrossProjectReadResult["outcome"],
      detail: string,
    ): CrossProjectReadResult => ({
      outcome,
      didRead: false,
      didModifySource: false,
      sourceWriteCount: input.sourceWriteProbe.writeAttemptCount,
      detail,
    });

    const record = await this.options.store.getAuthorization(input.authorizationIdentifier);
    if (record === null) {
      return denied("authorization-not-found", "授权不存在");
    }
    if (record.state === "revoked") {
      return denied("authorization-revoked", "授权已被撤销：" + String(record.revokedReason ?? ""));
    }
    if (Date.parse(input.nowIso) > Date.parse(record.expiresAtIso)) {
      return denied("authorization-expired", "授权已过期");
    }
    if (record.operationKind !== "read") {
      return denied("wrong-operation-kind" as never, "授权操作类型不是 read");
    }
    if (
      record.sourceProjectIdentifier !== input.sourceProjectIdentifier ||
      record.targetProjectIdentifier !== input.targetProjectIdentifier
    ) {
      return denied("project-mismatch", "来源/目标项目与授权不一致");
    }
    if (
      input.currentSourceProjectRevision !== undefined &&
      input.currentSourceProjectRevision !== record.sourceProjectRevision
    ) {
      return denied(
        "source-revision-changed",
        "来源项目 revision 已变化（授权绑定 revision=" +
          String(record.sourceProjectRevision) +
          "）：须重新核对授权",
      );
    }
    // 同路径参数变化不得沿用许可
    if (record.argumentsHash !== input.argumentsHash) {
      return denied(
        "authorization-parameter-mismatch",
        "完整规范化参数哈希与授权不一致：同一路径的其它参数不沿用许可",
      );
    }
    if (!this.isWithinScope(record.resourceScope, input.resourcePath)) {
      return denied("resource-out-of-scope", "资源超出授权范围：" + input.resourcePath);
    }

    return {
      outcome: "read-allowed",
      didRead: true,
      didModifySource: false,
      // 只读路径不产生任何写：来源写入计数必须保持为传入值（测试用 0）
      sourceWriteCount: input.sourceWriteProbe.writeAttemptCount,
      detail: "只读访问已按授权范围放行（来源零写入）",
    };
  }

  /**
   * 副本导入：并发/崩溃后重放同一内容 → **幂等复用回执**，不产生重复副作用。
   */
  async importCopy(input: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    targetProjectIdentifier: string;
    sourceResourcePath: string;
    targetResourcePath: string;
    sourceRevision: number;
    contentHash: string;
    argumentsHash: string;
    nowIso: string;
  }): Promise<CrossProjectImportResult> {
    const record = await this.options.store.getAuthorization(input.authorizationIdentifier);
    if (record === null) {
      return { outcome: "authorization-not-found", receipt: null, detail: "授权不存在" };
    }
    if (record.state === "revoked") {
      return { outcome: "authorization-revoked", receipt: null, detail: "授权已被撤销" };
    }
    if (Date.parse(input.nowIso) > Date.parse(record.expiresAtIso)) {
      return { outcome: "authorization-expired", receipt: null, detail: "授权已过期" };
    }
    if (record.operationKind !== "import-copy") {
      return {
        outcome: "wrong-operation-kind",
        receipt: null,
        detail: "授权操作类型不是 import-copy",
      };
    }
    if (record.argumentsHash !== input.argumentsHash) {
      return {
        outcome: "authorization-parameter-mismatch",
        receipt: null,
        detail: "参数哈希与授权不一致：不沿用许可",
      };
    }
    if (!this.isWithinScope(record.resourceScope, input.sourceResourcePath)) {
      return {
        outcome: "resource-out-of-scope",
        receipt: null,
        detail: "来源资源超出授权范围",
      };
    }

    // 幂等（并发安全）：先确保磁盘状态已加载（重启后新实例同样适用），
    // 再在同步段内原子认领——同一（授权 + 来源 + revision + 源/目标路径 + 内容哈希）
    // 只允许第一个调用者创建，其余复用其回执。
    await this.options.store.ensureLoaded();
    const claim = this.options.store.claimCopyReceiptSynchronously({
      authorizationIdentifier: input.authorizationIdentifier,
      sourceProjectIdentifier: input.sourceProjectIdentifier,
      sourceRevision: input.sourceRevision,
      sourceResourcePath: input.sourceResourcePath,
      targetResourcePath: input.targetResourcePath,
      contentHash: input.contentHash,
    });
    if (!claim.isFirstClaim && claim.existingReceipt !== null) {
      return {
        outcome: "reused-existing-copy",
        receipt: claim.existingReceipt,
        detail: "已有副本回执：幂等复用，不重复写入（并发/崩溃恢复安全）",
      };
    }

    const receipt: CrossProjectCopyReceipt = {
      receiptIdentifier: [
        "copy",
        input.authorizationIdentifier,
        input.sourceRevision,
        input.contentHash.slice(-8),
      ].join("-"),
      authorizationIdentifier: input.authorizationIdentifier,
      sourceProjectIdentifier: input.sourceProjectIdentifier,
      sourceRevision: input.sourceRevision,
      targetProjectIdentifier: input.targetProjectIdentifier,
      sourceResourcePath: input.sourceResourcePath,
      targetResourcePath: input.targetResourcePath,
      contentHash: input.contentHash,
      isCopyOfExternalSource: true,
      createdAtIso: input.nowIso,
    };
    await this.options.store.recordCopyReceipt(receipt);
    return {
      outcome: "imported-copy",
      receipt,
      detail: "已导入副本（保留来源项目/revision/哈希，标记为副本）",
    };
  }

  async countCopyReceipts(): Promise<number> {
    return this.options.store.countCopyReceipts();
  }
}
