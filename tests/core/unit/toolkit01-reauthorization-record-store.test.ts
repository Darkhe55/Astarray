/**
 * 反例（2026-10-13）：重新授权记录必须**绑定操作**、**一次性**、**fail-closed**。
 *
 * 背景（实测缺口）：版本升级的"新增副作用须重新授权"门禁此前只依赖调用方自述的
 * `isReauthorized: true` ⇒ 任何调用方都能打开门禁。本文件钉住替代原语的安全性质。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeReauthorizationScopeFingerprint,
  ToolPackageReauthorizationRecordStore,
  type ToolPackageReauthorizationScope,
} from "../../../packages/core/src/toolkit/tool-package-reauthorization-record-store.js";

let stateDirectory: string;
let store: ToolPackageReauthorizationRecordStore;

const BASE_SCOPE: ToolPackageReauthorizationScope = {
  projectIdentifier: "project-alpha",
  toolPackageId: "report-formatter",
  fromVersion: 1,
  toVersion: 2,
  addedSideEffects: ["file-write"],
};

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-reauth-store-"));
  store = new ToolPackageReauthorizationRecordStore({ stateDirectory });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
});

describe("重新授权记录原语", () => {
  it("① 绑定一致且未消费 ⇒ 放行，并标记为已消费", async () => {
    const record = await store.issueRecord({ scope: BASE_SCOPE, issuedBy: "user-1" });

    const outcome = await store.consumeRecordForOperation({
      recordIdentifier: record.recordIdentifier,
      scope: BASE_SCOPE,
    });

    expect(outcome.isConsumed).toBe(true);
    const records = await store.listRecords();
    expect(records[0]!.consumedAtIso).not.toBeNull();
  });

  it("② 一次性：同一条记录不得二次放行（避免一次批准反复升级）", async () => {
    const record = await store.issueRecord({ scope: BASE_SCOPE, issuedBy: "user-1" });
    await store.consumeRecordForOperation({
      recordIdentifier: record.recordIdentifier,
      scope: BASE_SCOPE,
    });

    const second = await store.consumeRecordForOperation({
      recordIdentifier: record.recordIdentifier,
      scope: BASE_SCOPE,
    });

    expect(second.isConsumed).toBe(false);
    expect(second.reason ?? "").toContain("已被使用过");
  });

  it("③ 记录不存在 ⇒ 拒绝（不得凭自述放行）", async () => {
    const outcome = await store.consumeRecordForOperation({
      recordIdentifier: "not-a-real-record",
      scope: BASE_SCOPE,
    });

    expect(outcome.isConsumed).toBe(false);
    expect(outcome.reason ?? "").toContain("不存在");
  });

  it("④ 绑定字段任一不同 ⇒ 拒绝（新增副作用 / 版本 / 项目 / 包名）", async () => {
    const record = await store.issueRecord({ scope: BASE_SCOPE, issuedBy: "user-1" });

    const mismatches: Array<[string, ToolPackageReauthorizationScope]> = [
      ["新增副作用多了一项", { ...BASE_SCOPE, addedSideEffects: ["file-write", "network"] }],
      ["新增副作用少了一项", { ...BASE_SCOPE, addedSideEffects: [] }],
      ["toVersion 不同", { ...BASE_SCOPE, toVersion: 3 }],
      ["fromVersion 不同", { ...BASE_SCOPE, fromVersion: 0 }],
      ["项目不同", { ...BASE_SCOPE, projectIdentifier: "project-beta" }],
      ["工具包不同", { ...BASE_SCOPE, toolPackageId: "other-package" }],
    ];

    for (const [label, scope] of mismatches) {
      const outcome = await store.consumeRecordForOperation({
        recordIdentifier: record.recordIdentifier,
        scope,
      });
      expect(outcome.isConsumed, label).toBe(false);
      expect(outcome.reason ?? "", label).toContain("不匹配");
    }
  });

  it("⑤ 副作用**顺序**不同不算不匹配（规范化指纹，避免误拒）", async () => {
    const record = await store.issueRecord({
      scope: { ...BASE_SCOPE, addedSideEffects: ["network", "file-write"] },
      issuedBy: "user-1",
    });

    const outcome = await store.consumeRecordForOperation({
      recordIdentifier: record.recordIdentifier,
      // 同一批副作用，顺序颠倒
      scope: { ...BASE_SCOPE, addedSideEffects: ["file-write", "network"] },
    });

    expect(outcome.isConsumed).toBe(true);
  });

  it("⑥ 记录文件缺失或损坏 ⇒ 视为无任何有效授权（fail-closed，且不抛错）", async () => {
    // 文件不存在
    const missing = await store.consumeRecordForOperation({
      recordIdentifier: "any",
      scope: BASE_SCOPE,
    });
    expect(missing.isConsumed).toBe(false);

    // 写坏文件后再问：仍必须拒绝
    await fs.writeFile(
      path.join(stateDirectory, "tool-package-reauthorizations.json"),
      "{ this is not json",
      "utf8",
    );
    const corrupted = await store.consumeRecordForOperation({
      recordIdentifier: "any",
      scope: BASE_SCOPE,
    });
    expect(corrupted.isConsumed).toBe(false);
    await expect(store.listRecords()).resolves.toEqual([]);
  });

  it("⑦ 指纹对字段敏感、对副作用顺序不敏感（直接钉住规范化规则）", () => {
    const base = computeReauthorizationScopeFingerprint(BASE_SCOPE);
    const reordered = computeReauthorizationScopeFingerprint({
      ...BASE_SCOPE,
      addedSideEffects: ["file-write"],
    });
    const changed = computeReauthorizationScopeFingerprint({
      ...BASE_SCOPE,
      toVersion: 99,
    });

    expect(reordered).toBe(base);
    expect(changed).not.toBe(base);
  });
});
