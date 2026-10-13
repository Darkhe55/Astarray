/**
 * COMM-01-02（2026-10-18）：执行层**唯一上级**归属与按地址投递授权。
 *
 * 卡内缺口（COMM-01-01 审计原文）：
 *  - `unbounded-agent-registry.ts`："**无统一持久化父子归属字段与跨实例唯一性约束**"；
 *  - `quaternary-lifecycle-controller.ts`："尚不能证明所有入口、恢复和转交路径都**强制唯一上级**"。
 *
 * 本模块把"唯一上级"做成**本地确定性**约束（不联网、不调用模型）：
 *  - `ParentBindingController.bindChildToParent()`：一个子**至多一个**上级；
 *    两个上级并发绑定时**先到者胜**，后到者被拒（不得顶掉既有归属）；
 *    同一上级重复绑定同一子 ⇒ **幂等成功**（重试不应失败）。
 *  - `isDeliveryAllowed()`：投递出口**只认唯一直属上级**；非直属上级（越级、直联兄弟、
 *    伪造来源）与"未绑定的子"一律拒绝 —— 不要求叶子模型自行判断对象。
 *  - `releaseChild()`：释放后**允许重新绑定**（否则被回收的子永久不可用）；
 *    但**只有当前直属上级**能释放，避免他人抢占。
 *  - `markParentRecycled()`：上级回收后**历史归属仍可查**
 *    （`resolveHistoricalParentOf`），但**不再放行新投递**（`isDeliveryAllowed` 为 false）
 *    —— 既不双上级、也不让已消失的上级继续收件。
 *
 * 与既有模块的分工：`UnboundedAgentInstanceRegistry` 管**个体生命周期与资源准入**，
 * 本模块只管**归属关系**（谁是谁的唯一上级），二者不互相复制规则。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE_NAME = "agent-parent-bindings.json";

export interface AgentParentBindingRecord {
  childAgentInstanceId: string;
  parentAgentInstanceId: string;
  boundAtIso: string;
  /** 释放时间；非 null 表示当前**无**归属（历史记录仍保留）。 */
  releasedAtIso: string | null;
  /** 上级被回收的时间；非 null 表示该绑定不得再放行新投递。 */
  parentRecycledAtIso: string | null;
}

export interface ParentBindingStoreOptions {
  stateDirectory: string;
  /** 可注入时钟（测试用）；默认真实时间。 */
  nowIso?: () => string;
}

/** 归属关系的**持久化**存储（只读写，不含判定规则）。 */
export class ParentBindingStore {
  private readonly stateDirectory: string;
  private readonly nowIso: () => string;
  /** 子 → 该子的**全部**历史绑定（按时间顺序追加）。 */
  private bindingsByChild = new Map<string, AgentParentBindingRecord[]>();
  private parentRecycledAtByParent = new Map<string, string>();
  private isLoaded = false;

  constructor(options: ParentBindingStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  private get stateFilePath(): string {
    return path.join(this.stateDirectory, STATE_FILE_NAME);
  }

  async ensureLoaded(): Promise<void> {
    if (this.isLoaded) {
      return;
    }
    this.isLoaded = true;
    let rawText: string;
    try {
      rawText = await fs.readFile(this.stateFilePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(rawText) as {
        schemaVersion?: unknown;
        bindings?: unknown;
        recycledParents?: unknown;
      };
      // 版本不符 ⇒ 按空继续（不伪造历史）
      if (parsed.schemaVersion !== 1) {
        return;
      }
      for (const raw of Array.isArray(parsed.bindings) ? parsed.bindings : []) {
        const record = raw as AgentParentBindingRecord;
        const existing = this.bindingsByChild.get(record.childAgentInstanceId) ?? [];
        existing.push(record);
        this.bindingsByChild.set(record.childAgentInstanceId, existing);
      }
      for (const raw of Array.isArray(parsed.recycledParents) ? parsed.recycledParents : []) {
        const entry = raw as { parentAgentInstanceId: string; recycledAtIso: string };
        this.parentRecycledAtByParent.set(entry.parentAgentInstanceId, entry.recycledAtIso);
      }
    } catch {
      // 损坏状态：按空继续（不伪造历史）
    }
  }

  /** 当前生效的归属（未被释放且上级未被回收）；无则 null。 */
  async getActiveBinding(childAgentInstanceId: string): Promise<AgentParentBindingRecord | null> {
    await this.ensureLoaded();
    const history = this.bindingsByChild.get(childAgentInstanceId) ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const record = history[index]!;
      if (record.releasedAtIso === null) {
        return record;
      }
    }
    return null;
  }

  /** **历史**归属（含已释放/上级已回收）——供报告追溯"当初是谁收的"。 */
  async getHistoricalBinding(childAgentInstanceId: string): Promise<AgentParentBindingRecord | null> {
    await this.ensureLoaded();
    const history = this.bindingsByChild.get(childAgentInstanceId) ?? [];
    return history.length === 0 ? null : history[history.length - 1]!;
  }

  async isParentRecycled(parentAgentInstanceId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.parentRecycledAtByParent.has(parentAgentInstanceId);
  }

  /**
   * 追加一条绑定记录。**唯一性由调用方（控制器）在同一临界区内判定** ——
   * 存储层不做规则判定，避免"存储层与判定层结论不一致"。
   */
  async appendBinding(input: {
    childAgentInstanceId: string;
    parentAgentInstanceId: string;
  }): Promise<AgentParentBindingRecord> {
    await this.ensureLoaded();
    const record: AgentParentBindingRecord = {
      childAgentInstanceId: input.childAgentInstanceId,
      parentAgentInstanceId: input.parentAgentInstanceId,
      boundAtIso: this.nowIso(),
      releasedAtIso: null,
      parentRecycledAtIso: null,
    };
    const history = this.bindingsByChild.get(input.childAgentInstanceId) ?? [];
    history.push(record);
    this.bindingsByChild.set(input.childAgentInstanceId, history);
    await this.persist();
    return record;
  }

  /** 释放当前生效的绑定（追加一个 releasedAtIso 标记，不删除历史）。 */
  async releaseActiveBinding(input: {
    childAgentInstanceId: string;
    parentAgentInstanceId: string;
  }): Promise<boolean> {
    await this.ensureLoaded();
    const history = this.bindingsByChild.get(input.childAgentInstanceId) ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const record = history[index]!;
      if (
        record.releasedAtIso === null &&
        record.parentAgentInstanceId === input.parentAgentInstanceId
      ) {
        record.releasedAtIso = this.nowIso();
        await this.persist();
        return true;
      }
    }
    return false;
  }

  async markParentRecycled(parentAgentInstanceId: string): Promise<void> {
    await this.ensureLoaded();
    if (this.parentRecycledAtByParent.has(parentAgentInstanceId)) {
      return;
    }
    this.parentRecycledAtByParent.set(parentAgentInstanceId, this.nowIso());
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    const bindings = [...this.bindingsByChild.values()].flat();
    const recycledParents = [...this.parentRecycledAtByParent.entries()].map(
      ([parentAgentInstanceId, recycledAtIso]) => ({ parentAgentInstanceId, recycledAtIso }),
    );
    await fs.writeFile(
      this.stateFilePath,
      JSON.stringify({ schemaVersion: 1, bindings, recycledParents }, null, 2) + "\n",
      "utf8",
    );
  }
}

export interface ParentBindingControllerOptions {
  store: ParentBindingStore;
}

/** 唯一上级与按地址投递授权的**本地确定性**判定器。 */
export class ParentBindingController {
  private readonly store: ParentBindingStore;

  constructor(options: ParentBindingControllerOptions) {
    this.store = options.store;
  }

  /**
   * 绑定唯一上级。
   * - 尚无生效归属 ⇒ 绑定成功；
   * - 已有生效归属且**同一上级** ⇒ 幂等成功（重试不失败）；
   * - 已有生效归属且**不同上级** ⇒ 拒绝（先到者胜，不得被顶掉）。
   */
  async bindChildToParent(input: {
    childAgentInstanceId: string;
    parentAgentInstanceId: string;
  }): Promise<{ isBound: boolean; reason: string | null }> {
    const active = await this.store.getActiveBinding(input.childAgentInstanceId);
    if (active !== null) {
      if (active.parentAgentInstanceId === input.parentAgentInstanceId) {
        return { isBound: true, reason: null };
      }
      return {
        isBound: false,
        reason:
          "该子已有唯一的直属上级（" +
          active.parentAgentInstanceId +
          "），不得被 " +
          input.parentAgentInstanceId +
          " 顶替",
      };
    }
    // 上一条绑定若已被释放，其上级若也被回收不阻止**重新**绑定（回收的是旧上级）。
    await this.store.appendBinding(input);
    return { isBound: true, reason: null };
  }

  /** 当前直属上级；无生效归属 ⇒ null。 */
  async resolveParentOf(childAgentInstanceId: string): Promise<string | null> {
    const active = await this.store.getActiveBinding(childAgentInstanceId);
    return active === null ? null : active.parentAgentInstanceId;
  }

  /** 历史归属（含已释放/上级已回收）——供报告追溯。 */
  async resolveHistoricalParentOf(childAgentInstanceId: string): Promise<string | null> {
    const historical = await this.store.getHistoricalBinding(childAgentInstanceId);
    return historical === null ? null : historical.parentAgentInstanceId;
  }

  /**
   * 投递出口判定：**只认唯一直属上级**。
   * 未绑定、非直属上级、伪造来源、上级已被回收 ⇒ 一律 false。
   */
  async isDeliveryAllowed(input: {
    childAgentInstanceId: string;
    claimedParentAgentInstanceId: string;
  }): Promise<boolean> {
    const active = await this.store.getActiveBinding(input.childAgentInstanceId);
    if (active === null) {
      return false;
    }
    if (active.parentAgentInstanceId !== input.claimedParentAgentInstanceId) {
      return false;
    }
    // 上级已被回收 ⇒ 不得再收件（历史归属仍可查）
    if (await this.store.isParentRecycled(active.parentAgentInstanceId)) {
      return false;
    }
    return true;
  }

  /** 释放归属：**只有当前直属上级**能释放（防他人抢占）。 */
  async releaseChild(input: {
    childAgentInstanceId: string;
    parentAgentInstanceId: string;
  }): Promise<{ wasReleased: boolean; reason: string | null }> {
    const active = await this.store.getActiveBinding(input.childAgentInstanceId);
    if (active === null) {
      return { wasReleased: false, reason: "该子当前没有生效归属，无需释放" };
    }
    if (active.parentAgentInstanceId !== input.parentAgentInstanceId) {
      return {
        wasReleased: false,
        reason:
          "只有当前直属上级（" +
          active.parentAgentInstanceId +
          "）能释放该归属",
      };
    }
    const released = await this.store.releaseActiveBinding(input);
    return released
      ? { wasReleased: true, reason: null }
      : { wasReleased: false, reason: "释放未生效（绑定已被改变）" };
  }

  async markParentRecycled(input: { parentAgentInstanceId: string }): Promise<void> {
    await this.store.markParentRecycled(input.parentAgentInstanceId);
  }
}
