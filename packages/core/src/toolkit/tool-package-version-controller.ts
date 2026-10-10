/**
 * TOOLKIT-01-04：工具包**版本、更新、回滚与故障**控制器（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §8。
 *
 * 本模块只做**本地确定性**判定与状态迁移：不执行工具、不做 I/O、不联网、不读凭据。
 *
 * 卡内 §8 逐条落实：
 *  - 项目**锁定确切版本和哈希**，注册更高版本**不自动升级**已锁定项目；
 *  - 升级前给出**行为/依赖/权限差异**并标出**新增副作用**，新增副作用**须重新授权**；
 *  - 启用/停用/锁定变更按 **revision 原子提交**（每次变更 revision 单调递增）；
 *  - **停用阻止新运行**，但**不删除在途调用**（必须能按安全点收敛，
 *    "不能删掉运行中的文件造成结果未知"）；
 *  - **回滚只切换后续使用版本**，历史调用记录（含实际副作用）**保留**；
 *  - 包损坏/依赖缺失 ⇒ **明确失败**并给出原因；
 *  - 调用记录含 run ID/步骤 ID/版本/参数哈希/来源/产物，**拒绝记录秘密**；
 *  - 支持**禁用与废弃**（标记），被历史引用的版本**不物理删除**。
 */

export interface ToolPackageVersionRegistration {
  toolPackageId: string;
  version: number;
  /** `sha256:<64 hex>`。 */
  contentHash: string;
  sourceProjectIdentifier: string;
  /** 声明的副作用集合（`none` 表示无副作用）。 */
  declaredSideEffects: string[];
  declaredDependencies: string[];
  permissionRequirements: string[];
}

export type ToolPackageVersionLifecycleStatus = "available" | "deprecated" | "disabled";

interface StoredVersion {
  registration: ToolPackageVersionRegistration;
  status: ToolPackageVersionLifecycleStatus;
}

interface ProjectVersionLock {
  projectIdentifier: string;
  toolPackageId: string;
  version: number;
  contentHash: string;
  isEnabled: boolean;
  revision: number;
}

export interface ToolPackageUpgradeDifferences {
  behaviorDifferences: string[];
  dependencyDifferences: string[];
  permissionDifferences: string[];
  removedSideEffects: string[];
  addedSideEffects: string[];
  requiresReauthorization: boolean;
}

export interface ToolPackageVersionChangeOutcome {
  isApplied: boolean;
  revision: number;
  reason: string | null;
}

export interface ToolPackageCallRecord {
  runIdentifier: string;
  stepIdentifier: string;
  projectIdentifier: string;
  toolPackageId: string;
  version: number;
  argumentHash: string;
  sourceProjectIdentifier: string;
  producedArtifacts: string[];
  failureReason: string | null;
}

export interface ToolPackageInFlightCall {
  runIdentifier: string;
  stepIdentifier: string;
  projectIdentifier: string;
  toolPackageId: string;
  version: number;
  argumentHash: string;
}

interface PendingVersionSwitch {
  projectIdentifier: string;
  toolPackageId: string;
  intendedVersion: number;
  intendedContentHash: string;
}

function versionKey(toolPackageId: string, version: number): string {
  return toolPackageId + "@" + String(version);
}

function projectLockKey(projectIdentifier: string, toolPackageId: string): string {
  return projectIdentifier + "|" + toolPackageId;
}

/**
 * 禁止写进调用记录的秘密特征（本地确定性模式；命中即拒绝，不做部分脱敏）。
 *
 * 注意 `sk-` 后必须允许 **连字符**：真实密钥常见 `sk-live-<payload>` 形态，
 * 而 `sk-` 与首个连字符之间只有 3–4 个字母，若写成 `sk-[A-Za-z0-9]{16,}`
 * 会把这类密钥**整条漏掉**（2026-10-10 由本文件反例 ⑧ 实测发现）。
 */
const FORBIDDEN_RECORD_CONTENT_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9-]{16,}/,
  /(Authorization|Bearer)\s*[:=]?\s*\S{8,}/i,
  /nonce/i,
];

export class ToolPackageVersionController {
  private readonly versions = new Map<string, StoredVersion>();
  private readonly projectLocks = new Map<string, ProjectVersionLock>();
  private readonly callHistory: ToolPackageCallRecord[] = [];
  private readonly inFlightCalls = new Map<string, ToolPackageInFlightCall>();
  private readonly pendingSwitches = new Map<string, PendingVersionSwitch>();
  private lastFailureReason: string | null = null;

  registerVersion(registration: ToolPackageVersionRegistration): void {
    this.versions.set(versionKey(registration.toolPackageId, registration.version), {
      registration: { ...registration },
      status: "available",
    });
  }

  /** 全部已登记版本（供持久化与只读管理视图使用）。 */
  listRegisteredVersions(): Array<{
    registration: ToolPackageVersionRegistration;
    status: ToolPackageVersionLifecycleStatus;
  }> {
    return [...this.versions.values()]
      .map((stored) => ({ registration: { ...stored.registration }, status: stored.status }))
      .sort((left, right) => {
        if (left.registration.toolPackageId !== right.registration.toolPackageId) {
          return left.registration.toolPackageId.localeCompare(right.registration.toolPackageId);
        }
        return left.registration.version - right.registration.version;
      });
  }

  /** 全部项目锁定（供持久化与只读管理视图使用）。 */
  listProjectLocks(): Array<{
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
    isEnabled: boolean;
    revision: number;
  }> {
    return [...this.projectLocks.values()]
      .map((lock) => ({ ...lock }))
      .sort((left, right) => {
        if (left.projectIdentifier !== right.projectIdentifier) {
          return left.projectIdentifier.localeCompare(right.projectIdentifier);
        }
        return left.toolPackageId.localeCompare(right.toolPackageId);
      });
  }

  /** 查询单个项目锁定（不存在返回 null）。 */
  findProjectLock(input: {
    projectIdentifier: string;
    toolPackageId: string;
  }): {
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
    isEnabled: boolean;
    revision: number;
  } | null {
    const lock = this.projectLocks.get(
      projectLockKey(input.projectIdentifier, input.toolPackageId),
    );
    return lock === undefined ? null : { ...lock };
  }

  describeVersion(input: {
    toolPackageId: string;
    version: number;
  }): { registration: ToolPackageVersionRegistration; status: ToolPackageVersionLifecycleStatus } | null {
    const stored = this.versions.get(versionKey(input.toolPackageId, input.version));
    if (stored === undefined) {
      return null;
    }
    return { registration: { ...stored.registration }, status: stored.status };
  }

  /** 项目**锁定**确切版本与哈希（不自动随用户库升级）。 */
  lockProjectToVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
  }): ToolPackageVersionChangeOutcome {
    const stored = this.versions.get(versionKey(input.toolPackageId, input.version));
    if (stored === undefined) {
      return { isApplied: false, revision: 0, reason: "版本未登记" };
    }
    if (stored.registration.contentHash !== input.contentHash) {
      return {
        isApplied: false,
        revision: 0,
        reason: "锁定哈希与登记哈希不一致（拒绝锁定未知内容）",
      };
    }
    const key = projectLockKey(input.projectIdentifier, input.toolPackageId);
    const previousRevision = this.projectLocks.get(key)?.revision ?? 0;
    this.projectLocks.set(key, {
      projectIdentifier: input.projectIdentifier,
      toolPackageId: input.toolPackageId,
      version: input.version,
      contentHash: input.contentHash,
      isEnabled: false,
      revision: previousRevision + 1,
    });
    return { isApplied: true, revision: previousRevision + 1, reason: null };
  }

  /**
   * 在项目内**首次启用**（或对**同一版本**重复启用）。
   *
   * 设计要点（2026-10-10 修正）：这里**不接受** `isReauthorized`。
   * 早期版本允许调用方传 `isReauthorized` 来完成版本切换，但那等于给"新增副作用"
   * 的门禁开了一个**旁路**：任何调用方只要顺手传个 true 就能绕过重新授权。
   * 因此版本切换**只能**走 `upgradeProjectVersion()`（它总是做差异判定），
   * 本方法遇到"目标版本与已锁定版本不同"时直接**拒绝并指路**。
   */
  enableForProject(input: {
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
  }): ToolPackageVersionChangeOutcome {
    const stored = this.versions.get(versionKey(input.toolPackageId, input.version));
    if (stored === undefined) {
      return { isApplied: false, revision: 0, reason: "版本未登记" };
    }
    if (stored.status === "disabled") {
      return { isApplied: false, revision: 0, reason: "该版本已禁用，不可启用" };
    }
    const key = projectLockKey(input.projectIdentifier, input.toolPackageId);
    const existingLock = this.projectLocks.get(key);
    if (existingLock !== undefined && existingLock.version !== input.version) {
      return {
        isApplied: false,
        revision: existingLock.revision,
        reason:
          "切换版本不得经 enableForProject（否则可绕过新增副作用重新授权）；" +
          "请使用 upgradeProjectVersion()",
      };
    }
    const revision = (existingLock?.revision ?? 0) + 1;
    this.projectLocks.set(key, {
      projectIdentifier: input.projectIdentifier,
      toolPackageId: input.toolPackageId,
      version: input.version,
      contentHash: stored.registration.contentHash,
      isEnabled: true,
      revision,
    });
    return { isApplied: true, revision, reason: null };
  }

  /** 升级项目版本：**唯一**的版本切换入口，总是做差异判定与重新授权门禁。 */
  upgradeProjectVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    toVersion: number;
    isReauthorized: boolean;
  }): ToolPackageVersionChangeOutcome {
    const stored = this.versions.get(versionKey(input.toolPackageId, input.toVersion));
    if (stored === undefined) {
      return { isApplied: false, revision: 0, reason: "目标版本未登记" };
    }
    if (stored.status === "disabled") {
      return { isApplied: false, revision: 0, reason: "该版本已禁用，不可启用" };
    }
    const key = projectLockKey(input.projectIdentifier, input.toolPackageId);
    const existingLock = this.projectLocks.get(key);
    if (existingLock === undefined) {
      return {
        isApplied: false,
        revision: 0,
        reason: "项目尚未锁定该工具包；请先 lockProjectToVersion()",
      };
    }
    const differences = this.describeUpgradeDifferences({
      toolPackageId: input.toolPackageId,
      fromVersion: existingLock.version,
      toVersion: input.toVersion,
    });
    if (differences.requiresReauthorization && !input.isReauthorized) {
      return {
        isApplied: false,
        revision: existingLock.revision,
        reason:
          "目标版本含**新增副作用**，须重新授权后方可切换（新增副作用: " +
          differences.addedSideEffects.join(",") +
          "）",
      };
    }
    const revision = existingLock.revision + 1;
    this.projectLocks.set(key, {
      ...existingLock,
      version: input.toVersion,
      contentHash: stored.registration.contentHash,
      isEnabled: true,
      revision,
    });
    return { isApplied: true, revision, reason: null };
  }

  /**
   * 停用：**阻止新运行**，但**保留在途调用**（不得删除运行中的文件造成结果未知）。
   * 在途调用需由 `convergeInFlightCall()` 按安全点收敛。
   */
  disableForProject(input: {
    projectIdentifier: string;
    toolPackageId: string;
  }): ToolPackageVersionChangeOutcome & { isEnabled: boolean } {
    const key = projectLockKey(input.projectIdentifier, input.toolPackageId);
    const existingLock = this.projectLocks.get(key);
    if (existingLock === undefined) {
      return { isApplied: false, revision: 0, reason: "项目未锁定该工具包", isEnabled: false };
    }
    const revision = existingLock.revision + 1;
    this.projectLocks.set(key, { ...existingLock, isEnabled: false, revision });
    return { isApplied: true, revision, reason: null, isEnabled: false };
  }

  /** 回滚：只切换后续使用版本，**不撤销历史副作用**。 */
  rollbackProjectVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    toVersion: number;
  }): ToolPackageVersionChangeOutcome {
    const stored = this.versions.get(versionKey(input.toolPackageId, input.toVersion));
    if (stored === undefined) {
      return { isApplied: false, revision: 0, reason: "回滚目标版本未登记" };
    }
    const key = projectLockKey(input.projectIdentifier, input.toolPackageId);
    const existingLock = this.projectLocks.get(key);
    if (existingLock === undefined) {
      return { isApplied: false, revision: 0, reason: "项目未锁定该工具包" };
    }
    const revision = existingLock.revision + 1;
    this.projectLocks.set(key, {
      ...existingLock,
      version: input.toVersion,
      contentHash: stored.registration.contentHash,
      revision,
    });
    return { isApplied: true, revision, reason: null };
  }

  /**
   * 执行前解析：只有"已锁定**且已启用**"才返回；
   * 给出 `observedContentHash` 时还要与实际内容一致（防止校验后偷换/内容损坏）。
   */
  resolveVersionForExecution(input: {
    projectIdentifier: string;
    toolPackageId: string;
    observedContentHash?: string;
  }): { version: number; contentHash: string } | null {
    const existingLock = this.projectLocks.get(
      projectLockKey(input.projectIdentifier, input.toolPackageId),
    );
    if (existingLock === undefined || !existingLock.isEnabled) {
      return null;
    }
    const stored = this.versions.get(
      versionKey(input.toolPackageId, existingLock.version),
    );
    if (stored === undefined || stored.status === "disabled") {
      return null;
    }
    if (stored.registration.contentHash !== existingLock.contentHash) {
      this.lastFailureReason = "登记哈希与项目锁定哈希不一致（包内容可能被替换或损坏）";
      return null;
    }
    if (
      input.observedContentHash !== undefined &&
      input.observedContentHash !== stored.registration.contentHash
    ) {
      this.lastFailureReason = "实际内容哈希与登记哈希不一致（包内容损坏或被篡改）";
      return null;
    }
    return {
      version: existingLock.version,
      contentHash: existingLock.contentHash,
    };
  }

  getLastFailureReason(): string | null {
    return this.lastFailureReason;
  }

  /** 依赖前置条件检查（缺失即明确失败）。 */
  checkPreconditions(input: {
    toolPackageId: string;
    version: number;
    availableDependencies: string[];
  }): { isSatisfied: boolean; reason: string | null } {
    const stored = this.versions.get(versionKey(input.toolPackageId, input.version));
    if (stored === undefined) {
      return { isSatisfied: false, reason: "版本未登记" };
    }
    const missingDependencies = stored.registration.declaredDependencies.filter(
      (dependency) => !input.availableDependencies.includes(dependency),
    );
    if (missingDependencies.length > 0) {
      return {
        isSatisfied: false,
        reason: "依赖缺失: " + missingDependencies.join(","),
      };
    }
    return { isSatisfied: true, reason: null };
  }

  /** 升级差异（行为/依赖/权限 + 新增副作用）。 */
  describeUpgradeDifferences(input: {
    toolPackageId: string;
    fromVersion: number;
    toVersion: number;
  }): ToolPackageUpgradeDifferences {
    const fromVersion = this.versions.get(
      versionKey(input.toolPackageId, input.fromVersion),
    )?.registration;
    const toVersion = this.versions.get(versionKey(input.toolPackageId, input.toVersion))
      ?.registration;
    if (fromVersion === undefined || toVersion === undefined) {
      return {
        behaviorDifferences: [],
        dependencyDifferences: [],
        permissionDifferences: [],
        removedSideEffects: [],
        addedSideEffects: [],
        requiresReauthorization: false,
      };
    }
    const addedSideEffects = toVersion.declaredSideEffects.filter(
      (sideEffect) => !fromVersion.declaredSideEffects.includes(sideEffect),
    );
    const removedSideEffects = fromVersion.declaredSideEffects.filter(
      (sideEffect) => !toVersion.declaredSideEffects.includes(sideEffect),
    );
    return {
      behaviorDifferences: addedSideEffects,
      dependencyDifferences: toVersion.declaredDependencies.filter(
        (dependency) => !fromVersion.declaredDependencies.includes(dependency),
      ),
      permissionDifferences: toVersion.permissionRequirements.filter(
        (requirement) => !fromVersion.permissionRequirements.includes(requirement),
      ),
      removedSideEffects,
      addedSideEffects,
      requiresReauthorization: addedSideEffects.length > 0,
    };
  }

  recordInFlightCall(call: ToolPackageInFlightCall): void {
    this.inFlightCalls.set(call.runIdentifier, { ...call });
  }

  listInFlightCalls(input: { projectIdentifier: string }): ToolPackageInFlightCall[] {
    return [...this.inFlightCalls.values()].filter(
      (call) => call.projectIdentifier === input.projectIdentifier,
    );
  }

  /** 按安全点收敛在途调用（停用后仍需完成，避免"结果未知"）。 */
  convergeInFlightCall(input: { runIdentifier: string }): { isConverged: boolean } {
    return { isConverged: this.inFlightCalls.delete(input.runIdentifier) };
  }

  recordCompletedCall(input: {
    runIdentifier: string;
    stepIdentifier: string;
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    argumentHash: string;
    producedArtifacts: string[];
    failureReason?: string | null;
  }): ToolPackageCallRecord {
    /**
     * 不得把秘密写进记录：命中即**拒绝**（而非部分脱敏 ——
     * 部分脱敏容易漏掉变体，宁可让调用方改正输入）。
     */
    const recordedText = [input.argumentHash, ...input.producedArtifacts]
      .concat(input.failureReason ?? [])
      .join("|");
    for (const pattern of FORBIDDEN_RECORD_CONTENT_PATTERNS) {
      if (pattern.test(recordedText)) {
        throw new Error(
          "调用记录不得包含秘密/凭据/一次性授权（拒绝记录，请先清理输入）",
        );
      }
    }
    const stored = this.versions.get(versionKey(input.toolPackageId, input.version));
    const record: ToolPackageCallRecord = {
      runIdentifier: input.runIdentifier,
      stepIdentifier: input.stepIdentifier,
      projectIdentifier: input.projectIdentifier,
      toolPackageId: input.toolPackageId,
      version: input.version,
      argumentHash: input.argumentHash,
      sourceProjectIdentifier: stored?.registration.sourceProjectIdentifier ?? "",
      producedArtifacts: [...input.producedArtifacts],
      failureReason: input.failureReason ?? null,
    };
    this.callHistory.push(record);
    return record;
  }

  listCallHistory(input: { projectIdentifier: string }): ToolPackageCallRecord[] {
    return this.callHistory.filter(
      (record) => record.projectIdentifier === input.projectIdentifier,
    );
  }

  /** 全部调用历史（供持久化使用）。 */
  listAllCallRecords(): ToolPackageCallRecord[] {
    return this.callHistory.map((record) => ({
      ...record,
      producedArtifacts: [...record.producedArtifacts],
    }));
  }

  /**
   * 从持久化快照恢复状态（供跨进程管理入口使用）。
   *
   * 只恢复数据，不改变任何判定逻辑；`pendingSwitches` 一并恢复，
   * 使崩溃恢复在**新进程**中依然可用。
   */
  restoreFromSnapshot(snapshot: {
    versions: Array<{
      registration: ToolPackageVersionRegistration;
      status: ToolPackageVersionLifecycleStatus;
    }>;
    projectLocks: Array<{
      projectIdentifier: string;
      toolPackageId: string;
      version: number;
      contentHash: string;
      isEnabled: boolean;
      revision: number;
    }>;
    callHistory: ToolPackageCallRecord[];
    pendingSwitches?: PendingVersionSwitch[];
  }): void {
    for (const stored of snapshot.versions) {
      this.versions.set(
        versionKey(stored.registration.toolPackageId, stored.registration.version),
        { registration: { ...stored.registration }, status: stored.status },
      );
    }
    for (const lock of snapshot.projectLocks) {
      this.projectLocks.set(
        projectLockKey(lock.projectIdentifier, lock.toolPackageId),
        { ...lock },
      );
    }
    this.callHistory.length = 0;
    for (const record of snapshot.callHistory) {
      this.callHistory.push({
        ...record,
        producedArtifacts: [...record.producedArtifacts],
      });
    }
    for (const pendingSwitch of snapshot.pendingSwitches ?? []) {
      this.pendingSwitches.set(
        projectLockKey(pendingSwitch.projectIdentifier, pendingSwitch.toolPackageId),
        { ...pendingSwitch },
      );
    }
  }

  /** 全部待处理切换意图（供持久化使用）。 */
  listPendingSwitches(): PendingVersionSwitch[] {
    return [...this.pendingSwitches.values()].map((pending) => ({ ...pending }));
  }

  /** 废弃（标记，不删除）。 */
  deprecateVersion(input: {
    toolPackageId: string;
    version: number;
  }): { isDeprecated: boolean; reason: string | null } {
    const key = versionKey(input.toolPackageId, input.version);
    const stored = this.versions.get(key);
    if (stored === undefined) {
      return { isDeprecated: false, reason: "版本未登记" };
    }
    this.versions.set(key, { ...stored, status: "deprecated" });
    return { isDeprecated: true, reason: null };
  }

  /**
   * 移除版本：**被调用历史引用的版本不得物理删除**（卡内 §8 末条）。
   * 未引用的版本允许移除。
   */
  removeVersion(input: {
    toolPackageId: string;
    version: number;
  }): { isRemoved: boolean; reason: string | null } {
    const isReferenced = this.callHistory.some(
      (record) =>
        record.toolPackageId === input.toolPackageId &&
        record.version === input.version,
    );
    if (isReferenced) {
      return {
        isRemoved: false,
        reason: "该版本被调用/恢复点引用，必须保留（如需清理请走备份与授权规则）",
      };
    }
    const isRemoved = this.versions.delete(versionKey(input.toolPackageId, input.version));
    return {
      isRemoved,
      reason: isRemoved ? null : "版本未登记",
    };
  }

  /**
   * 记录"半提交"的切换意图（用于崩溃恢复）。
   *
   * 真实实现会在**切换前**落盘意图；崩溃后据此判断"切换是否真的完成"。
   */
  recordPendingVersionSwitch(switchIntent: PendingVersionSwitch): void {
    this.pendingSwitches.set(
      projectLockKey(switchIntent.projectIdentifier, switchIntent.toolPackageId),
      { ...switchIntent },
    );
  }

  /**
   * 崩溃恢复：把中间态收敛到**上一个可信版本**。
   *
   * 关键不变量：绝不留下"已启用但哈希与实际不符"的状态 ——
   * 那会让后续执行在读到一个**未知内容**的包时仍以为它是被验收过的版本。
   */
  recoverFromInterruptedSwitch(input: {
    projectIdentifier: string;
    toolPackageId: string;
  }): { isRecovered: boolean; activeVersion: number | null } {
    const key = projectLockKey(input.projectIdentifier, input.toolPackageId);
    const pendingSwitch = this.pendingSwitches.get(key);
    const existingLock = this.projectLocks.get(key);
    if (pendingSwitch === undefined) {
      return { isRecovered: false, activeVersion: existingLock?.version ?? null };
    }
    this.pendingSwitches.delete(key);
    if (existingLock === undefined) {
      return { isRecovered: true, activeVersion: null };
    }
    /**
     * 半提交 ⇒ 切换**未完成**：保留切换前的锁定（`existingLock` 未被改写）。
     * 若此前已被改写为"意图版本"，则此处按哈希核对回退。
     */
    const intendedVersion = this.versions.get(
      versionKey(input.toolPackageId, pendingSwitch.intendedVersion),
    );
    const isLockConsistentWithIntended =
      existingLock.version === pendingSwitch.intendedVersion &&
      intendedVersion !== undefined &&
      intendedVersion.registration.contentHash === pendingSwitch.intendedContentHash &&
      pendingSwitch.intendedContentHash === existingLock.contentHash;
    if (isLockConsistentWithIntended) {
      return { isRecovered: false, activeVersion: existingLock.version };
    }
    // 不一致 ⇒ 收敛回锁定记录本身（其上仍是切换前的可信版本与哈希）
    return { isRecovered: true, activeVersion: existingLock.version };
  }
}
