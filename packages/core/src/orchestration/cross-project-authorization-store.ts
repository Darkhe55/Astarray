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
import { createHash } from "node:crypto";
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
  /** 接收方具体个体（可空 = 未限定具体个体）。 */
  receivingAgentInstanceId?: string | null;
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
    receivingAgentInstanceId?: string | null;
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
      receivingAgentInstanceId: input.receivingAgentInstanceId ?? null,
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

  async listAuthorizations(filter?: {
    sourceProjectIdentifier?: string;
    targetProjectIdentifier?: string;
    receivingAgentInstanceId?: string;
  }): Promise<CrossProjectAuthorizationRecord[]> {
    await this.loadFromDisk();
    return [...this.authorizationsByIdentifier.values()].filter((record) => {
      if (
        filter?.sourceProjectIdentifier !== undefined &&
        record.sourceProjectIdentifier !== filter.sourceProjectIdentifier
      ) {
        return false;
      }
      if (
        filter?.targetProjectIdentifier !== undefined &&
        record.targetProjectIdentifier !== filter.targetProjectIdentifier
      ) {
        return false;
      }
      if (
        filter?.receivingAgentInstanceId !== undefined &&
        (record.receivingAgentInstanceId ?? null) !== filter.receivingAgentInstanceId
      ) {
        return false;
      }
      return true;
    });
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

  /**
   * 释放**未完成**的认领（2026-10-10，PROJECT-01-03 真实 I/O 接入）。
   *
   * 场景：`importCopy` 先原子认领（占位回执），随后真实写入副本；若写入失败，
   * 占位回执若不撤销，重试会被"已有回执 ⇒ 幂等复用"挡住，而目标项目里**永远没有文件**
   * ——即"把回执当导入完成"。因此写入失败必须显式释放该键。
   *
   * 纪律：**只允许释放占位回执**（`receiptIdentifier` 以 `pending-` 开头）。
   * 已落定的真实回执一旦被释放，就等价于允许对**已完成**的副本重复写入，属放宽重放保护，
   * 故此处 fail-closed：非占位回执一律不删。
   */
  async releaseCopyReceiptClaim(receiptKeyInput: {
    authorizationIdentifier: string;
    sourceProjectIdentifier: string;
    sourceRevision: number;
    sourceResourcePath: string;
    targetResourcePath: string;
    contentHash: string;
  }): Promise<{ wasReleased: boolean }> {
    await this.loadFromDisk();
    const key = this.buildReceiptKey(receiptKeyInput);
    const existing = this.copyReceiptsByKey.get(key);
    if (existing === undefined) {
      return { wasReleased: false };
    }
    if (!existing.receiptIdentifier.startsWith("pending-")) {
      // 已落定的真实回执：不得撤销（防重复副作用）。
      return { wasReleased: false };
    }
    this.copyReceiptsByKey.delete(key);
    await this.enqueuePersist();
    return { wasReleased: true };
  }

  async countCopyReceipts(): Promise<number> {
    await this.loadFromDisk();
    return this.copyReceiptsByKey.size;
  }

  /** 只读列出全部副本回执（公开入口用；不联网、不写盘）。 */
  async listCopyReceipts(): Promise<CrossProjectCopyReceipt[]> {
    await this.loadFromDisk();
    return [...this.copyReceiptsByKey.values()];
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
    | "resource-out-of-scope"
    | "resource-not-found"
    | "resource-read-failed"
    | "content-hash-mismatch";
  didRead: boolean;
  didModifySource: false;
  sourceWriteCount: number;
  /** 真实读到的内容；未读取时为 null（**不得**在看板/回执上伪装成已读取）。 */
  content: string | null;
  /** 真实内容的 sha256；未读取时为 null。 */
  contentHash: string | null;
  /** 读取前后的来源内容哈希（必须相等 ⇒ 来源零写入的**可核对**证据）。 */
  sourceContentHashBefore: string | null;
  sourceContentHashAfter: string | null;
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
    | "wrong-operation-kind"
    | "resource-not-found"
    | "resource-read-failed"
    | "content-hash-mismatch"
    | "target-write-failed";
  receipt: CrossProjectCopyReceipt | null;
  /** 是否**真的**写出了目标副本（回执存在不等于文件存在）。 */
  didWriteTarget: boolean;
  /** 来源内容哈希（导入前后必须相等 ⇒ 来源零写入的可核对证据）。 */
  sourceContentHashBefore: string | null;
  sourceContentHashAfter: string | null;
  detail: string;
}

/**
 * 跨项目资源 I/O 端口（2026-10-10，PROJECT-01-03）。
 *
 * 为什么不直接 `import { promises as fs }`：本服务被 SDK/CLI/GUI 复用，
 * 真实 I/O 必须可注入（可测替换、可审计、可换成受控边界实现），
 * 且"是否真的读/写"必须由调用方提供的端口行为决定，而不是由本服务**自称**。
 */
export interface CrossProjectResourceIoPort {
  readTextFile(absolutePath: string): Promise<string>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  ensureDirectory(absoluteDirectoryPath: string): Promise<void>;
  fileExists(absolutePath: string): Promise<boolean>;
}

export class CrossProjectTransferService {
  constructor(
    private readonly options: {
      store: CrossProjectAuthorizationStore;
      /**
       * 资源 I/O 端口。**未注入时不执行任何资源读写**：`readResource` 会如实
       * 返回 `resource-read-failed`（不伪装 `didRead`），`importCopy` 会如实返回
       * `target-write-failed`，从而不会产生"有回执但无文件"的假完成。
       */
      resourceIo?: CrossProjectResourceIoPort;
    },
  ) {}

  private static sha256Text(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  private isWithinScope(scope: CrossProjectResourceScope, resourcePath: string): boolean {
    return scope.pathPrefixes.some(
      (prefix) => resourcePath === prefix.replace(/\/$/, "") || resourcePath.startsWith(prefix),
    );
  }

  /**
   * 只读访问：**真实读取 + 来源零写入**（2026-10-10 接入真实 I/O）。
   *
   * 校验顺序：授权存在 → 未撤销 → 未过期 → 项目匹配 → 来源 revision 匹配 → 参数哈希匹配
   * → 资源范围命中。**任一失败即拒绝，零 I/O**（不触碰资源，见反例④）。
   *
   * 通过校验后才真实读取，并给出**可核对的来源零写入证据**：
   * 读取前后对来源内容各取一次 sha256，两者必须相等。
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
    /** 资源的**绝对路径**（相对路径只用于范围判定；未给出即无法真实读取）。 */
    absoluteResourcePath?: string;
    /** 调用方声明的内容哈希；给出时必须与实际内容一致，否则拒绝。 */
    expectedContentHash?: string;
  }): Promise<CrossProjectReadResult> {
    const denied = (
      outcome: CrossProjectReadResult["outcome"],
      detail: string,
    ): CrossProjectReadResult => ({
      outcome,
      didRead: false,
      didModifySource: false,
      sourceWriteCount: input.sourceWriteProbe.writeAttemptCount,
      content: null,
      contentHash: null,
      sourceContentHashBefore: null,
      sourceContentHashAfter: null,
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

    // ─── 以下才触达资源（授权已全部通过）───
    const resourceIo = this.options.resourceIo;
    if (resourceIo === undefined || input.absoluteResourcePath === undefined) {
      return denied(
        "resource-read-failed",
        "未接入资源 I/O 端口或缺少资源绝对路径：只读未执行（不伪装已读取）",
      );
    }
    if (!(await resourceIo.fileExists(input.absoluteResourcePath))) {
      return denied("resource-not-found", "资源不存在：" + input.resourcePath);
    }

    let content: string;
    let sourceContentHashBefore: string;
    try {
      content = await resourceIo.readTextFile(input.absoluteResourcePath);
      sourceContentHashBefore = CrossProjectTransferService.sha256Text(content);
    } catch (error) {
      return denied("resource-read-failed", "资源读取失败：" + (error as Error).message);
    }

    const contentHash = CrossProjectTransferService.sha256Text(content);
    // 声明哈希与实际内容不符 ⇒ 拒绝：不得把别的版本当成本次许可的内容。
    if (
      input.expectedContentHash !== undefined &&
      input.expectedContentHash !== contentHash
    ) {
      return denied(
        "content-hash-mismatch",
        "声明的内容哈希与实际内容不一致（实际 " +
          contentHash.slice(0, 12) +
          "…）：拒绝按此许可读取",
      );
    }

    // 读后再取一次来源哈希：与读取前相等 ⇒ 来源零写入的可核对证据。
    let sourceContentHashAfter: string;
    try {
      const sourceTextAfterRead = await resourceIo.readTextFile(input.absoluteResourcePath);
      sourceContentHashAfter = CrossProjectTransferService.sha256Text(sourceTextAfterRead);
    } catch (error) {
      return denied(
        "resource-read-failed",
        "读取后复核来源失败：" + (error as Error).message,
      );
    }
    if (sourceContentHashAfter !== sourceContentHashBefore) {
      return {
        ...denied(
          "resource-read-failed",
          "读取期间来源内容发生变化：拒绝（本次读取结果不构成稳定的只读证据）",
        ),
        sourceContentHashBefore,
        sourceContentHashAfter,
      };
    }

    return {
      outcome: "read-allowed",
      didRead: true,
      didModifySource: false,
      // 只读路径不产生任何写：来源写入计数必须保持为传入值（测试用 0）
      sourceWriteCount: input.sourceWriteProbe.writeAttemptCount,
      content,
      contentHash,
      sourceContentHashBefore,
      sourceContentHashAfter,
      detail: "只读访问已按授权范围放行（真实读取；来源零写入，前后哈希一致）",
    };
  }

  /**
   * 副本导入：**真实写出目标副本** + 并发/崩溃后重放同一内容 → **幂等复用回执**。
   *
   * 顺序要紧（2026-10-10 接入真实 I/O）：
   * 授权校验 → 真实读取来源（含前后哈希，证明来源零写入）→ 原子认领回执 →
   * **真实写出目标** → 落定真实回执。写入失败 ⇒ **释放认领**并如实返回
   * `target-write-failed`，绝不留"有回执但无文件"的假完成。
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
    /** 来源/目标**绝对路径**（相对路径只用于范围判定与回执；未给出即无法真实拷贝）。 */
    absoluteSourcePath?: string;
    absoluteTargetPath?: string;
  }): Promise<CrossProjectImportResult> {
    const refusal = (
      outcome: CrossProjectImportResult["outcome"],
      detail: string,
    ): CrossProjectImportResult => ({
      outcome,
      receipt: null,
      didWriteTarget: false,
      sourceContentHashBefore: null,
      sourceContentHashAfter: null,
      detail,
    });

    const record = await this.options.store.getAuthorization(input.authorizationIdentifier);
    if (record === null) {
      return refusal("authorization-not-found", "授权不存在");
    }
    if (record.state === "revoked") {
      return refusal("authorization-revoked", "授权已被撤销");
    }
    if (Date.parse(input.nowIso) > Date.parse(record.expiresAtIso)) {
      return refusal("authorization-expired", "授权已过期");
    }
    if (record.operationKind !== "import-copy") {
      return refusal("wrong-operation-kind", "授权操作类型不是 import-copy");
    }
    if (record.argumentsHash !== input.argumentsHash) {
      return refusal("authorization-parameter-mismatch", "参数哈希与授权不一致：不沿用许可");
    }
    if (!this.isWithinScope(record.resourceScope, input.sourceResourcePath)) {
      return refusal("resource-out-of-scope", "来源资源超出授权范围");
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
        didWriteTarget: false,
        sourceContentHashBefore: null,
        sourceContentHashAfter: null,
        detail: "已有副本回执：幂等复用，不重复写入（并发/崩溃恢复安全）",
      };
    }

    /** 释放未完成的认领，避免"有回执无文件"挡住重试。 */
    const releaseClaim = async (): Promise<void> => {
      try {
        await this.options.store.releaseCopyReceiptClaim({
          authorizationIdentifier: input.authorizationIdentifier,
          sourceProjectIdentifier: input.sourceProjectIdentifier,
          sourceRevision: input.sourceRevision,
          sourceResourcePath: input.sourceResourcePath,
          targetResourcePath: input.targetResourcePath,
          contentHash: input.contentHash,
        });
      } catch {
        // 释放失败不改变"本次未导入成功"的事实；如实返回失败即可。
      }
    };

    const resourceIo = this.options.resourceIo;
    if (
      resourceIo === undefined ||
      input.absoluteSourcePath === undefined ||
      input.absoluteTargetPath === undefined
    ) {
      await releaseClaim();
      return refusal(
        "target-write-failed",
        "未接入资源 I/O 端口或缺少源/目标绝对路径：副本未写入（不产生假完成回执）",
      );
    }

    // 真实读取来源（并取前后哈希 ⇒ 来源零写入的可核对证据）
    if (!(await resourceIo.fileExists(input.absoluteSourcePath))) {
      await releaseClaim();
      return refusal("resource-not-found", "来源资源不存在：" + input.sourceResourcePath);
    }
    let sourceContent: string;
    let sourceContentHashBefore: string;
    try {
      sourceContent = await resourceIo.readTextFile(input.absoluteSourcePath);
      sourceContentHashBefore = CrossProjectTransferService.sha256Text(sourceContent);
    } catch (error) {
      await releaseClaim();
      return refusal("resource-read-failed", "来源读取失败：" + (error as Error).message);
    }
    // 声明哈希与来源实际内容不符 ⇒ 拒绝（不得把别的版本当成本次许可的副本内容）。
    if (sourceContentHashBefore !== input.contentHash) {
      await releaseClaim();
      return {
        ...refusal(
          "content-hash-mismatch",
          "来源实际内容哈希（" +
            sourceContentHashBefore.slice(0, 12) +
            "…）与声明的 contentHash 不一致：拒绝导入",
        ),
        sourceContentHashBefore,
      };
    }

    // 真实写出目标副本（先建父目录，再写内容）
    try {
      await resourceIo.ensureDirectory(path.dirname(input.absoluteTargetPath));
      await resourceIo.writeTextFile(input.absoluteTargetPath, sourceContent);
    } catch (error) {
      await releaseClaim();
      return {
        ...refusal("target-write-failed", "目标副本写入失败：" + (error as Error).message),
        sourceContentHashBefore,
      };
    }

    // 写出后复核目标确实存在：回执成立必须以文件成立为前提。
    if (!(await resourceIo.fileExists(input.absoluteTargetPath))) {
      await releaseClaim();
      return {
        ...refusal("target-write-failed", "写入后复核目标不存在：不落定回执"),
        sourceContentHashBefore,
      };
    }

    let sourceContentHashAfter: string;
    try {
      sourceContentHashAfter = CrossProjectTransferService.sha256Text(
        await resourceIo.readTextFile(input.absoluteSourcePath),
      );
    } catch (error) {
      await releaseClaim();
      return {
        ...refusal("resource-read-failed", "写入后复核来源失败：" + (error as Error).message),
        sourceContentHashBefore,
      };
    }
    if (sourceContentHashAfter !== sourceContentHashBefore) {
      await releaseClaim();
      return {
        ...refusal(
          "resource-read-failed",
          "导入期间来源内容发生变化：拒绝落定回执（本次导入不构成稳定证据）",
        ),
        sourceContentHashBefore,
        sourceContentHashAfter,
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
      didWriteTarget: true,
      sourceContentHashBefore,
      sourceContentHashAfter,
      detail: "已导入副本（真实写出目标；保留来源项目/revision/哈希，标记为副本；来源零写入）",
    };
  }

  async countCopyReceipts(): Promise<number> {
    return this.options.store.countCopyReceipts();
  }
}

/** 路径前缀范围（来源可导出 / 目标可接收 / 接收个体权限）。 */
export interface CrossProjectPathScope {
  pathPrefixes: string[];
}

export type CrossProjectPermissionDecision =
  | "allow-by-intersection"
  | "allow-by-preset-shared-scope"
  | "deny-wins"
  | "deny-out-of-preset-shared-scope"
  | "deny-target-does-not-receive"
  | "deny-outside-source-export"
  | "deny-outside-receiving-agent-permission"
  | "deny-ponder-readonly-only"
  | "ask-user";

export interface CrossProjectPermissionEvaluation {
  decision: CrossProjectPermissionDecision;
  isAllowed: boolean;
  isHumanDecisionRequired: boolean;
  detail: string;
}

function isPathWithinScope(scope: CrossProjectPathScope, resourcePath: string): boolean {
  return scope.pathPrefixes.some(
    (prefix) => resourcePath === prefix.replace(/\/$/, "") || resourcePath.startsWith(prefix),
  );
}

/**
 * 有效跨项目授权判定（PROJECT-01-04 / 卡内 §4）。
 *
 * 判定顺序：
 *  1) **deny 优先**：显式拒绝即整体拒绝；
 *  2) 思索模式：跨项目 grant 不授予写/执行，仅原有只读能力 → 非只读操作一律拒绝；
 *  3) 三集合交集：来源可导出 ∩ 目标可接收 ∩ 接收 Agent 当前权限（缺一即拒，并给具体原因）；
 *  4) 模式：放权在**预设共享范围**内自动通过（无需人等）；协同/超范围仍需人裁决。
 *
 * 注意：**"可配置权限默认 allow"不自动创建项目间共享关系** ——
 * 目标侧未声明可接收范围（空）即视为不接收，不因默认 allow 放行。
 */
export function evaluateEffectiveCrossProjectPermission(input: {
  sourceExportScope: CrossProjectPathScope;
  targetReceiveScope: CrossProjectPathScope;
  receivingAgentPermissionScope: CrossProjectPathScope;
  requestedResourcePath: string;
  mode: "ponder" | "assist" | "devolve";
  requestedOperationKind?: CrossProjectOperationKind;
  explicitDenyScopes?: CrossProjectPathScope[];
  requestedResourceIsDenied?: boolean;
  hasUserPresetDelegation?: boolean;
}): CrossProjectPermissionEvaluation {
  // 1) deny 优先
  if (input.requestedResourceIsDenied === true) {
    return {
      decision: "deny-wins",
      isAllowed: false,
      isHumanDecisionRequired: false,
      detail: "显式拒绝优先：即使其它侧允许也不放行",
    };
  }

  // 2) 思索模式：仅原有只读能力
  if (input.mode === "ponder" && input.requestedOperationKind === "import-copy") {
    return {
      decision: "deny-ponder-readonly-only",
      isAllowed: false,
      isHumanDecisionRequired: false,
      detail: "思索模式：跨项目 grant 不授予写入/执行；导入执行由获准执行层承担",
    };
  }

  // 3) 目标侧未声明可接收范围 → 不接收（默认 allow 不等于同意接收）
  if (input.targetReceiveScope.pathPrefixes.length === 0) {
    return {
      decision: "deny-target-does-not-receive",
      isAllowed: false,
      isHumanDecisionRequired: false,
      detail: "目标项目未声明可接收范围：默认 allow 不自动创建项目间共享关系",
    };
  }

  // 4) 三集合交集：分别识别是哪一侧挡住，给出**具体原因**
  const outsideScopes: string[] = [];
  if (!isPathWithinScope(input.sourceExportScope, input.requestedResourcePath)) {
    outsideScopes.push("来源可导出范围");
  }
  if (!isPathWithinScope(input.targetReceiveScope, input.requestedResourcePath)) {
    outsideScopes.push("目标可接收范围");
  }
  if (!isPathWithinScope(input.receivingAgentPermissionScope, input.requestedResourcePath)) {
    outsideScopes.push("接收 Agent 当前有效权限");
  }

  if (outsideScopes.length > 0) {
    // 放权模式：超出预设共享范围 → **不放行且无需人工介入**
    if (input.mode === "devolve") {
      return {
        decision: "deny-out-of-preset-shared-scope",
        isAllowed: false,
        isHumanDecisionRequired: false,
        detail:
          "放权模式：超出用户预设共享范围（" + outsideScopes.join("、") + "）→ 不放行",
      };
    }
    // 协同模式：超出范围 → 询问用户（不得自动放行）
    return {
      decision: "ask-user",
      isAllowed: false,
      isHumanDecisionRequired: true,
      detail: "超出范围（" + outsideScopes.join("、") + "）：需人工裁决",
    };
  }

  // 5) 三集合交集成立：按模式决定是否需人工介入
  if (input.mode === "assist" && input.hasUserPresetDelegation !== true) {
    return {
      decision: "ask-user",
      isAllowed: false,
      isHumanDecisionRequired: true,
      detail: "三集合交集成立，但协同模式未获用户预委托：仍需人工裁决",
    };
  }
  return {
    decision:
      input.hasUserPresetDelegation === true ? "allow-by-preset-shared-scope" : "allow-by-intersection",
    isAllowed: true,
    isHumanDecisionRequired: false,
    detail: "有效授权 = 来源可导出 ∩ 目标可接收 ∩ 接收 Agent 权限，三者均通过",
  };
}

export interface CopyReceiptSummaryEntry {
  receiptIdentifier: string;
  /** 面向人的标签：显式标注"副本"并给出来源项目、revision 与内容哈希。 */
  displayLabel: string;
  sourceProjectIdentifier: string;
  sourceRevision: number;
  sourceResourcePath: string;
  targetProjectIdentifier: string;
  targetResourcePath: string;
  contentHash: string;
  isCopyOfExternalSource: true;
  isOriginal: false;
}

export interface CopyReceiptSummary {
  receipts: CopyReceiptSummaryEntry[];
  count: number;
}

/**
 * 副本摘要（公开入口）：**人工可分辨副本与原件**。
 * 只读：仅读已落盘回执，不联网、不写盘。
 */
export async function summarizeCopyReceipts(input: {
  store: CrossProjectAuthorizationStore;
}): Promise<CopyReceiptSummary> {
  const receipts = await input.store.listCopyReceipts();
  return {
    count: receipts.length,
    receipts: receipts.map((receipt) => ({
      receiptIdentifier: receipt.receiptIdentifier,
      displayLabel:
        "[副本] " +
        receipt.sourceProjectIdentifier +
        "@r" +
        String(receipt.sourceRevision) +
        " " +
        receipt.sourceResourcePath +
        " → " +
        receipt.targetProjectIdentifier +
        ":" +
        receipt.targetResourcePath +
        " (" +
        receipt.contentHash +
        ")",
      sourceProjectIdentifier: receipt.sourceProjectIdentifier,
      sourceRevision: receipt.sourceRevision,
      sourceResourcePath: receipt.sourceResourcePath,
      targetProjectIdentifier: receipt.targetProjectIdentifier,
      targetResourcePath: receipt.targetResourcePath,
      contentHash: receipt.contentHash,
      isCopyOfExternalSource: true,
      isOriginal: false,
    })),
  };
}
