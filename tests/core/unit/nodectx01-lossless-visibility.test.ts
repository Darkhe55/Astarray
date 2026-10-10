/**
 * NODECTX-01-01 反例（2026-10-10）：**有损兜底盘点**与"节点可见性 ≠ 业务状态"。
 *
 * 卡内 §2.1 明文：
 *  - "所有 Astarray **可控制的**自动/手动语义压缩、滚动摘要替代历史、静默截断兜底
 *    **均禁用**，**不提供重新开启该机制的开关**"；
 *  - "**禁止的是强制有损替代**，**不把现有 SUM 组件仅改名后继续做有损截断**"；
 *  - "**仅保证本项目控制的**请求装配与存储；Provider 内部不可观察行为**不得宣称已禁用**"；
 *  - "适配器对可配置自动 compaction/truncation **明确禁用**；
 *    **无法保证的接口记录不支持该保证**，不以静默压缩重试"。
 *
 * 卡内 §2.2 明文："**节点业务执行/验收状态与上下文可见性分开存储**，
 * **不能把"暂不入提示词"当 done**"，并给出三态：
 * `active` / `temporarily-closed` / `permanently-closed`。
 *
 * 检查点 01 要求"**明确真正禁用点，不仅改术语**"⇒ 必须有一份
 * **逐项、可核对、含处置** 的盘点，而不是把组件改个名字。
 *
 * 本片钉住的语义：
 *  - 可见性与业务状态**必须分开**，且"不在提示词里"**绝不能**表示 done；
 *  - 盘点必须覆盖**每一处**有损兜底，并给出**处置**（禁用/改无损/记录不支持）；
 *  - **任何"只改名"的处置必须被拒绝**（`rename-only` 不是合法处置）；
 *  - **Provider 内部不可观察**的项**不得**标成"已禁用"；
 *  - 禁用必须是**不可重新开启**的（不存在"重新开启该机制的开关"）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  CONTEXT_VISIBILITY_STATES,
  LOSSY_FALLBACK_INVENTORY,
  auditLossyFallbackInventory,
  createNodeVisibilityRecord,
  isContextVisibleInPrompt,
} from "../../../packages/core/src/toolkit/context-lossless-visibility.js";

describe("NODECTX-01：节点可见性必须与业务状态分开", () => {
  it("① 三态齐备，且「暂不入提示词」绝不等价于业务 done", () => {
    expect([...CONTEXT_VISIBILITY_STATES]).toEqual([
      "active",
      "temporarily-closed",
      "permanently-closed",
    ]);
    const temporarilyClosed = createNodeVisibilityRecord({
      nodeIdentifier: "node-1",
      visibilityState: "temporarily-closed",
      businessStatus: "pending",
    });
    expect(isContextVisibleInPrompt(temporarilyClosed)).toBe(false);
    // 关键：不在提示词里 **不是** 业务完成
    expect(temporarilyClosed.isBusinessCompleted).toBe(false);

    // 只有业务状态真的 completed 才算完成（与可见性无关）
    const activeButIncomplete = createNodeVisibilityRecord({
      nodeIdentifier: "node-2",
      visibilityState: "active",
      businessStatus: "pending",
    });
    expect(isContextVisibleInPrompt(activeButIncomplete)).toBe(true);
    expect(activeButIncomplete.isBusinessCompleted).toBe(false);

    const permanentlyClosedAndCompleted = createNodeVisibilityRecord({
      nodeIdentifier: "node-3",
      visibilityState: "permanently-closed",
      businessStatus: "completed",
    });
    expect(permanentlyClosedAndCompleted.isBusinessCompleted).toBe(true);
  });

  it("② 永久关闭不得被当成物理删除或「永不查阅」", () => {
    const record = createNodeVisibilityRecord({
      nodeIdentifier: "node-4",
      visibilityState: "permanently-closed",
      businessStatus: "completed",
    });
    expect(record.isContentRetainedOnDisk).toBe(true);
    expect(record.isExplicitRecallAllowed).toBe(true);
  });
});

describe("NODECTX-01：有损兜底盘点（明确真正禁用点）", () => {
  it("③ 盘点中每一项都必须给出**处置**，不接受「仅改名」", () => {
    const audit = auditLossyFallbackInventory(LOSSY_FALLBACK_INVENTORY);
    expect(audit.length).toBeGreaterThan(0);
    for (const entry of audit) {
      expect(entry.disposition).toMatch(
        /^(disable-and-remove|rewrite-lossless|declare-unsupported)$/,
      );
    }
  });

  it("④ 合法处置只有三种；`rename-only` 必须被判为**非法**", () => {
    const withRenameOnly = [
      {
        fallbackIdentifier: "renamed-summary",
        locationIdentifier: "somewhere.ts",
        lossKind: "summary-replaces-history" as const,
        isUnderOurControl: true,
        disposition: "rename-only" as never,
      },
    ];
    const audit = auditLossyFallbackInventory(withRenameOnly);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.isAccepted).toBe(false);
    expect(String(audit[0]?.reason)).toMatch(/改名|rename|术语/);
  });

  it("⑤ **Provider 内部不可观察**的项不得标成「已禁用」", () => {
    const providerInternal = [
      {
        fallbackIdentifier: "provider-internal-compaction",
        locationIdentifier: "provider-side (unobservable)",
        lossKind: "provider-internal-compaction" as const,
        isUnderOurControl: false,
        disposition: "disable-and-remove" as const,
      },
    ];
    const audit = auditLossyFallbackInventory(providerInternal);
    expect(audit[0]?.isAccepted).toBe(false);
    expect(String(audit[0]?.reason)).toMatch(/不可观察|不可保证|declared-unsupported|不支持/);
  });

  it("⑥ 本项目控制的有损项必须**禁用或改无损**，不得保留仍可触发的有损路径", () => {
    for (const entry of LOSSY_FALLBACK_INVENTORY) {
      if (!entry.isUnderOurControl) {
        continue;
      }
      expect(entry.disposition).toMatch(/^(disable-and-remove|rewrite-lossless)$/);
    }
  });

  it("⑦ 整体盘点必须给出**真正禁用点**清单（不得为空，也不得只列术语变更）", () => {
    const audit = auditLossyFallbackInventory(LOSSY_FALLBACK_INVENTORY);
    const trulyDisabled = audit.filter(
      (entry) =>
        entry.isAccepted &&
        (entry.disposition === "disable-and-remove" ||
          entry.disposition === "rewrite-lossless"),
    );
    expect(trulyDisabled.length).toBeGreaterThan(0);
    // 每一项都要能定位到代码/装配点
    for (const entry of trulyDisabled) {
      expect(entry.locationIdentifier.length).toBeGreaterThan(0);
    }
  });

  it("⑧ 禁用必须**不可重新开启**（不得提供开启该机制的开关）", () => {
    const audit = auditLossyFallbackInventory(LOSSY_FALLBACK_INVENTORY);
    for (const entry of audit) {
      expect(entry.isReenablable).toBe(false);
    }
  });
});
