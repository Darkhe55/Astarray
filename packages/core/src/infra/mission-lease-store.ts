/**
 * 跨进程 mission 活动租约（T12-01）。
 * 位置：<stateDirectory>/missions/<missionId>/mission-lease.json
 *
 * 背景：既有任务链/概要/检查点写入只使用进程内 AsyncMutex + stale-revision CAS，
 * 两个 CLI 进程推进同一 mission 时可能并发调度，产生重复领取/重复副作用。
 *
 * 本存储提供进程级排他活动租约：推进 mission 运行状态前必须先 tryAcquire，
 * 未取得即 mission-locked 快速失败；到期租约不自动接管（fail-closed），
 * 必须由调用方经 T12A 恢复分类后显式 takeOverExpiredLease。
 *
 * 语义说明：
 * - 租约文件是内部瞬时咨询锁（类似 pidfile），释放/接管为受控内部状态转换；
 *   不是用户业务内容，不进入备份保管库，删除只针对本文件且校验属主 revision。
 * - 租约不替代 revision CAS 与检查点恢复：三者叠加，单一失效仍 fail-closed。
 * - 文件损坏时抛 journal-corrupted，绝不静默覆盖。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { writeAtomicJson } from "./atomic-json.js";

export const MISSION_LEASE_SCHEMA_VERSION = 1 as const;
export const MISSION_LEASE_DEFAULT_TTL_MILLISECONDS = 30_000;

export type MissionLeasePurpose = "run" | "resume" | "recover";

export interface MissionLeaseDocument {
  schemaVersion: 1;
  /** 租约文件单调修订：每次内容变更 +1，跨进程 CAS 依据。 */
  leaseRevision: number;
  missionId: string;
  /** 不可复用的写入进程实例 ID（本进程唯一，非模型可控）。 */
  processInstanceId: string;
  /** 发起个体（如适用）；诊断用途，不做鉴权依据。 */
  agentInstanceId: string | null;
  purpose: MissionLeasePurpose;
  claimedAtIso: string;
  renewsUntilIso: string;
  claimantDescription: string;
}

export interface MissionLeaseClaimInput {
  missionId: string;
  processInstanceId: string;
  agentInstanceId?: string;
  purpose: MissionLeasePurpose;
  /** 诊断用途短描述，长度有界。 */
  claimantDescription?: string;
}

export type MissionLeaseAcquireOutcome =
  | { status: "acquired"; lease: MissionLeaseDocument }
  | { status: "locked-active"; lease: MissionLeaseDocument }
  | { status: "locked-stale"; lease: MissionLeaseDocument };

export interface MissionLeaseStoreOptions {
  stateDirectory: string;
  nowMilliseconds?: () => number;
  /** 续约窗口（单次租约有效时长），时间量显式带单位。 */
  leaseTtlMilliseconds?: number;
}

export class MissionLeaseStore {
  private readonly missionsDirectoryPath: string;
  private readonly nowMilliseconds: () => number;
  private readonly leaseTtlMilliseconds: number;

  constructor(options: MissionLeaseStoreOptions) {
    this.missionsDirectoryPath = path.join(options.stateDirectory, "missions");
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.leaseTtlMilliseconds =
      options.leaseTtlMilliseconds ?? MISSION_LEASE_DEFAULT_TTL_MILLISECONDS;
  }

  private leaseFilePath(missionId: string): string {
    return path.join(this.missionsDirectoryPath, missionId, "mission-lease.json");
  }

  async tryAcquire(
    claimInput: MissionLeaseClaimInput,
  ): Promise<MissionLeaseAcquireOutcome> {
    const claim = this.validateClaim(claimInput);
    const leaseFilePath = this.leaseFilePath(claim.missionId);
    await fs.mkdir(path.dirname(leaseFilePath), { recursive: true });

    const document = this.buildLeaseDocument(claim, 1, claim.missionId);
    const serialized = this.serializeDocument(document);
    let fileHandle;
    try {
      fileHandle = await fs.open(leaseFilePath, "wx");
    } catch (error) {
      if (this.isErrorCode(error, "EEXIST")) {
        const existing = await this.readLeaseInternal(claim.missionId);
        if (existing !== null) {
          return this.isExpired(existing)
            ? { status: "locked-stale", lease: existing }
            : { status: "locked-active", lease: existing };
        }
        // 排他创建失败但文件随后消失（释放竞态）：返回已取得并补建。
        return this.tryAcquire(claim);
      }
      throw error;
    }
    try {
      await fileHandle.writeFile(serialized, "utf8");
      await fileHandle.sync();
    } catch (writeError) {
      await fs.rm(leaseFilePath, { force: true }).catch(() => {});
      throw writeError;
    } finally {
      await fileHandle.close();
    }
    return { status: "acquired", lease: document };
  }

  /** 返回当前租约；不存在返回 null；损坏抛 journal-corrupted。 */
  async readLease(missionId: string): Promise<MissionLeaseDocument | null> {
    this.assertSafeMissionId(missionId);
    return this.readLeaseInternal(missionId);
  }

  private async readLeaseInternal(
    missionId: string,
  ): Promise<MissionLeaseDocument | null> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.leaseFilePath(missionId), "utf8");
    } catch (error) {
      if (this.isErrorCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(rawContent) as MissionLeaseDocument;
      if (
        parsed.schemaVersion !== MISSION_LEASE_SCHEMA_VERSION ||
        typeof parsed.leaseRevision !== "number" ||
        typeof parsed.processInstanceId !== "string" ||
        typeof parsed.renewsUntilIso !== "string"
      ) {
        throw new Error("invalid-lease-shape");
      }
      return parsed;
    } catch {
      throw new DomainError(
        "journal-corrupted",
        `mission 租约文件损坏，拒绝读取/覆盖: ${this.leaseFilePath(missionId)}`,
      );
    }
  }

  /**
   * 持有者续约：renewsUntil 顺延 leaseTtlMilliseconds，leaseRevision +1。
   * 返回 null 表示租约已不存在（被释放/接管，调用方必须停止推进）；
   * 过期租约不可续约（mission-locked），必须先接管。
   */
  async renewLease(
    missionId: string,
    expectedLeaseRevision: number,
    processInstanceId: string,
  ): Promise<MissionLeaseDocument | null> {
    this.assertSafeMissionId(missionId);
    const current = await this.readLeaseInternal(missionId);
    if (current === null) {
      return null;
    }
    if (this.isExpired(current)) {
      throw new DomainError(
        "mission-locked",
        `租约已过期不可续约，须经恢复分类后接管: ${missionId}`,
      );
    }
    this.assertOwnerRevision(current, expectedLeaseRevision, processInstanceId, missionId);
    const nextRevision = current.leaseRevision + 1;
    const renewed: MissionLeaseDocument = {
      ...current,
      leaseRevision: nextRevision,
      renewsUntilIso: new Date(
        this.nowMilliseconds() + this.leaseTtlMilliseconds,
      ).toISOString(),
    };
    await writeAtomicJson(this.leaseFilePath(missionId), renewed);
    return renewed;
  }

  /**
   * 属主释放租约。返回 true 表示本次释放成功；返回 false 表示租约已不存在
   * （幂等清理）。revision/属主不匹配抛 stale-revision。
   */
  async releaseLease(
    missionId: string,
    expectedLeaseRevision: number,
    processInstanceId: string,
  ): Promise<boolean> {
    this.assertSafeMissionId(missionId);
    const current = await this.readLeaseInternal(missionId);
    if (current === null) {
      return false;
    }
    this.assertOwnerRevision(current, expectedLeaseRevision, processInstanceId, missionId);
    await fs.rm(this.leaseFilePath(missionId), { force: true });
    return true;
  }

  /**
   * 显式接管过期租约（仅允许在过期后由恢复流程调用）：
   * leaseRevision +1 并更换属主。活动租约 mission-locked；
   * revision 不匹配 stale-revision；租约不存在 mission-not-found。
   */
  async takeOverExpiredLease(
    missionId: string,
    expectedLeaseRevision: number,
    claimInput: MissionLeaseClaimInput,
  ): Promise<MissionLeaseDocument> {
    this.assertSafeMissionId(missionId);
    const claim = this.validateClaim({ ...claimInput, missionId });
    const current = await this.readLeaseInternal(missionId);
    if (current === null) {
      throw new DomainError("mission-not-found", `不存在可接管的 mission 租约: ${missionId}`);
    }
    if (!this.isExpired(current)) {
      throw new DomainError(
        "mission-locked",
        `租约仍活跃，禁止直接接管: ${missionId}（属主 ${current.processInstanceId}）`,
      );
    }
    if (current.leaseRevision !== expectedLeaseRevision) {
      throw new DomainError(
        "stale-revision",
        `接管 revision 不匹配: 现有 ${current.leaseRevision}，试图 ${expectedLeaseRevision}`,
      );
    }
    const takenOver = this.buildLeaseDocument(
      claim,
      expectedLeaseRevision + 1,
      missionId,
    );
    await writeAtomicJson(this.leaseFilePath(missionId), takenOver);
    return takenOver;
  }

  private buildLeaseDocument(
    claim: MissionLeaseClaimInput,
    leaseRevision: number,
    missionId: string,
  ): MissionLeaseDocument {
    const claimedAtMilliseconds = this.nowMilliseconds();
    return {
      schemaVersion: MISSION_LEASE_SCHEMA_VERSION,
      leaseRevision,
      missionId,
      processInstanceId: claim.processInstanceId,
      agentInstanceId: claim.agentInstanceId ?? null,
      purpose: claim.purpose,
      claimedAtIso: new Date(claimedAtMilliseconds).toISOString(),
      renewsUntilIso: new Date(
        claimedAtMilliseconds + this.leaseTtlMilliseconds,
      ).toISOString(),
      claimantDescription: (claim.claimantDescription ?? "").slice(0, 200),
    };
  }

  private validateClaim(input: MissionLeaseClaimInput): MissionLeaseClaimInput {
    this.assertSafeMissionId(input.missionId);
    if (typeof input.processInstanceId !== "string" || input.processInstanceId.length === 0) {
      throw new DomainError("mission-locked", "processInstanceId 缺失，无法建立租约");
    }
    if (input.processInstanceId.length > 200) {
      throw new DomainError("mission-locked", "processInstanceId 过长");
    }
    if (input.purpose !== "run" && input.purpose !== "resume" && input.purpose !== "recover") {
      throw new DomainError("mission-locked", `未知租约用途: ${String(input.purpose)}`);
    }
    return input;
  }

  private assertSafeMissionId(missionId: string): void {
    if (typeof missionId !== "string" || missionId.length === 0 || missionId.length > 160) {
      throw new DomainError("path-escape-attempt", "missionId 非法（长度或空值）");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) {
      throw new DomainError("path-escape-attempt", `missionId 含非法字符: ${missionId}`);
    }
    if (missionId === "." || missionId === "..") {
      throw new DomainError("path-escape-attempt", "missionId 不得为 . 或 ..");
    }
  }

  private assertOwnerRevision(
    current: MissionLeaseDocument,
    expectedLeaseRevision: number,
    processInstanceId: string,
    missionId: string,
  ): void {
    if (current.leaseRevision !== expectedLeaseRevision) {
      throw new DomainError(
        "stale-revision",
        `租约 revision 不匹配: 现有 ${current.leaseRevision}，试图 ${expectedLeaseRevision}（${missionId}）`,
      );
    }
    if (current.processInstanceId !== processInstanceId) {
      throw new DomainError(
        "stale-revision",
        `非属主进程不得续约/释放: ${missionId}（现有 ${current.processInstanceId}，试图 ${processInstanceId}）`,
      );
    }
  }

  private isExpired(document: MissionLeaseDocument): boolean {
    const renewsUntilMilliseconds = Date.parse(document.renewsUntilIso);
    if (Number.isNaN(renewsUntilMilliseconds)) {
      return true;
    }
    return renewsUntilMilliseconds <= this.nowMilliseconds();
  }

  private serializeDocument(document: MissionLeaseDocument): string {
    return `${JSON.stringify(document, null, 2)}\n`;
  }

  private isErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException).code === code;
  }
}
