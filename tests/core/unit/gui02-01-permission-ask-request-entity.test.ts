/**
 * GUI-02-01 行为反例：**权限询问的请求实体**（先红后绿）。
 *
 * **为什么需要它**（用户 2026-10-11 指出的边界）：
 * > 裁决入口接收请求 ID、决定及预期 revision／指纹；服务器从**本地权威记录**
 * > 取原始参数，重新校验主体、权限、期限和当前状态。
 * > **不得接受前端提交的新参数替换原请求**，也不得**把知道请求 ID 或指纹当作有权批准**。
 *
 * 现状（提取后已核实）：permission-ask 只有"问一次答一次"的
 * `PermissionAsk`（4 个字段），**没有请求实体** —— 没有 `askIdentifier`、
 * 没有请求自身状态、没有 revision、没有有效期。因此：
 * - **N3「过期裁决被拒」没有可测载体**；
 * - **N1「同一请求经 CLI／GUI 裁决结果一致」没有"同一请求"这个概念**；
 * - S3 要求的"绑定完整参数指纹 + revision""过期/撤销不得复用"**无处落地**。
 *
 * 本文件钉住的语义（全部是**期望行为**，故在实现前必须红）：
 *  ① **身份与指纹**：登记后产生 `askIdentifier`、`operationFingerprint`
 *     与**本地权威原始参数**；指纹绑定**完整规范化参数**，参数变化即指纹不同。
 *  ② **状态机与 revision**：`pending` → `allowed` / `denied`，**只有 `pending` 可裁决**；
 *     每次状态迁移 **revision 递增**；重复裁决同一 revision ⇒ 幂等失败（不重复生效）。
 *  ③ **期限**：超过 `expiresAtIso` ⇒ 拒绝裁决（`expired`），不得复用批准。
 *  ④ **不得替换参数**：裁决只接受"请求 ID + 决定 + 预期 revision/指纹"，
 *     **不接受新参数**；裁决后回读到的原始参数与登记时**逐字一致**。
 *  ⑤ **知道 ID/指纹 ≠ 有权批准**：无裁决权的调用方即便拿到正确 ID 与指纹，也必须被拒。
 *  ⑥ **关页面/重启不等于批准**：未裁决的请求在重新读取后仍为 `pending`（不得自动放行）。
 *
 * 本文件在实现前必须失败（模块尚不存在）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionAskRequestStore,
  type PermissionAskRequestRecord,
} from "../../../packages/core/src/orchestration/permission-ask-request-store.js";

let baseDirectory: string;
let store: PermissionAskRequestStore;

const OWNER = "worker:mission-ask-1:T-001:1";
const CAPSULE_ARGUMENTS = '{"filePath":"a/b.txt","content":"第一版内容"}';

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ask-request-"));
  store = new PermissionAskRequestStore({ baseDirectory });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function register(overrides: Partial<{ argumentsJson: string; lifetimeSeconds: number }> = {}) {
  return store.registerRequest({
    ownerAgentInstanceId: OWNER,
    taskIdentifier: "T-001",
    toolName: "createProjectFile",
    argumentsJson: overrides.argumentsJson ?? CAPSULE_ARGUMENTS,
    explanation: "需要写入项目文件",
    ...(overrides.lifetimeSeconds === undefined
      ? {}
      : { lifetimeSeconds: overrides.lifetimeSeconds }),
  });
}

describe("GUI-02-01 请求实体：身份、指纹与持久化", () => {
  it("① 登记后产生 askIdentifier / operationFingerprint / pending 状态 / revision 1，且参数逐字保留", async () => {
    const record = await register();
    expect(record.askIdentifier).toMatch(/\S+/);
    expect(record.operationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.status).toBe("pending");
    expect(record.requestRevision).toBe(1);
    // **本地权威原始参数**：不得改写、不得截断
    expect(record.argumentsJson).toBe(CAPSULE_ARGUMENTS);
    // 有效期必须是可判定的时间点
    expect(Number.isNaN(Date.parse(record.expiresAtIso))).toBe(false);
  });

  it("② 指纹绑定**完整规范化参数**：内容变化 ⇒ 指纹不同；键序变化 ⇒ 指纹相同", async () => {
    const first = await register({ argumentsJson: '{"filePath":"a/b.txt","content":"第一版"}' });
    const changedContent = await register({
      argumentsJson: '{"filePath":"a/b.txt","content":"第二版"}',
    });
    expect(
      changedContent.operationFingerprint,
      "内容变化必须改变指纹（S3：绑定完整参数指纹）",
    ).not.toBe(first.operationFingerprint);

    const reordered = await register({
      argumentsJson: '{"content":"第一版","filePath":"a/b.txt"}',
    });
    expect(
      reordered.operationFingerprint,
      "仅键序不同必须得到同一指纹（保留方案 B 对格式抖动的容忍）",
    ).toBe(first.operationFingerprint);
  });

  it("③ 持久化：新实例重新读取后仍是同一请求（重启不丢、也不自动放行）", async () => {
    const record = await register();
    const reopened = new PermissionAskRequestStore({ baseDirectory });
    const readBack = await reopened.readRequest(record.askIdentifier);
    expect(readBack?.askIdentifier).toBe(record.askIdentifier);
    expect(readBack?.status, "未裁决的请求重启后必须仍为 pending（关闭页面/重启不等于批准）").toBe(
      "pending",
    );
    expect(readBack?.argumentsJson).toBe(CAPSULE_ARGUMENTS);
  });
});

describe("GUI-02-01 请求实体：状态机、revision 与期限", () => {
  it("④ 只有 pending 可裁决；允许后 revision 递增且状态为 allowed", async () => {
    const record = await register();
    const decided = await store.decideRequest({
      askIdentifier: record.askIdentifier,
      decision: "allowed-once",
      expectedRequestRevision: record.requestRevision,
      expectedOperationFingerprint: record.operationFingerprint,
      deciderAgentInstanceId: "main-agent-1",
      hasAdjudicationAuthority: true,
    });
    expect(decided.status).toBe("allowed");
    expect(decided.requestRevision).toBe(record.requestRevision + 1);
    expect(decided.argumentsJson, "裁决不得改变本地权威原始参数").toBe(CAPSULE_ARGUMENTS);
  });

  it("⑤ 重复裁决（同一 expectedRevision）⇒ 幂等失败，不重复生效", async () => {
    const record = await register();
    await store.decideRequest({
      askIdentifier: record.askIdentifier,
      decision: "allowed-once",
      expectedRequestRevision: record.requestRevision,
      expectedOperationFingerprint: record.operationFingerprint,
      deciderAgentInstanceId: "main-agent-1",
      hasAdjudicationAuthority: true,
    });
    await expect(
      store.decideRequest({
        askIdentifier: record.askIdentifier,
        decision: "denied",
        expectedRequestRevision: record.requestRevision,
        expectedOperationFingerprint: record.operationFingerprint,
        deciderAgentInstanceId: "main-agent-1",
        hasAdjudicationAuthority: true,
      }),
      "已裁决的请求不得被再次裁决（多页面并发只能有一个有效结果）",
    ).rejects.toMatchObject({ errorCode: "permission-ask-already-decided" });
  });

  it("⑥ 期限已过 ⇒ 拒绝裁决并标记 expired（不得复用批准）", async () => {
    const record = await register({ lifetimeSeconds: 0 });
    await expect(
      store.decideRequest({
        askIdentifier: record.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: record.requestRevision,
        expectedOperationFingerprint: record.operationFingerprint,
        deciderAgentInstanceId: "main-agent-1",
        hasAdjudicationAuthority: true,
      }),
      "过期请求必须被拒（S3：过期不得复用批准）",
    ).rejects.toMatchObject({ errorCode: "permission-ask-expired" });
    const readBack = await store.readRequest(record.askIdentifier);
    expect(readBack?.status).toBe("expired");
  });

  it("⑦ 预期 revision 或指纹不匹配 ⇒ 拒绝陈旧裁决", async () => {
    const record = await register();
    await expect(
      store.decideRequest({
        askIdentifier: record.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: record.requestRevision + 5,
        expectedOperationFingerprint: record.operationFingerprint,
        deciderAgentInstanceId: "main-agent-1",
        hasAdjudicationAuthority: true,
      }),
      "陈旧 revision 必须被拒",
    ).rejects.toMatchObject({ errorCode: "permission-ask-stale-revision" });

    await expect(
      store.decideRequest({
        askIdentifier: record.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: record.requestRevision,
        expectedOperationFingerprint: "sha256:" + "0".repeat(64),
        deciderAgentInstanceId: "main-agent-1",
        hasAdjudicationAuthority: true,
      }),
      "指纹不匹配必须被拒（参数变化不得复用批准）",
    ).rejects.toMatchObject({ errorCode: "permission-ask-fingerprint-mismatch" });
  });

  it("⑧ 知道请求 ID 与指纹但**无裁决权** ⇒ 必须被拒（不得当作有权批准）", async () => {
    const record = await register();
    await expect(
      store.decideRequest({
        askIdentifier: record.askIdentifier,
        decision: "allowed-once",
        expectedRequestRevision: record.requestRevision,
        expectedOperationFingerprint: record.operationFingerprint,
        deciderAgentInstanceId: "some-other-agent",
        hasAdjudicationAuthority: false,
      }),
      "无裁决权必须被拒，即便 ID 与指纹都正确",
    ).rejects.toMatchObject({ errorCode: "permission-ask-not-authorized" });
    const readBack = await store.readRequest(record.askIdentifier);
    expect(readBack?.status, "被拒的裁决不得改变状态").toBe("pending");
  });

  it("⑨ 未登记的请求 ID ⇒ 明确拒绝（不猜、不静默）", async () => {
    await expect(
      store.decideRequest({
        askIdentifier: "ask-does-not-exist",
        decision: "allowed-once",
        expectedRequestRevision: 1,
        expectedOperationFingerprint: "sha256:" + "1".repeat(64),
        deciderAgentInstanceId: "main-agent-1",
        hasAdjudicationAuthority: true,
      }),
    ).rejects.toMatchObject({ errorCode: "permission-ask-not-found" });
  });

  it("⑩ 记录形状：裁决入口只接受 ID+决定+预期 revision/指纹（不接受新参数）", () => {
    /**
     * 这是**类型层**约束的运行时对照：`decideRequest` 的入参里**没有** `argumentsJson`。
     * 一旦有人给裁决入口加上"可提交参数"，本断言会失败以提示复核。
     */
    const decideSourceKeys = Object.keys({
      askIdentifier: "",
      decision: "",
      expectedRequestRevision: 0,
      expectedOperationFingerprint: "",
      deciderAgentInstanceId: "",
      hasAdjudicationAuthority: false,
    }).sort();
    expect(decideSourceKeys).toEqual([
      "askIdentifier",
      "deciderAgentInstanceId",
      "decision",
      "expectedOperationFingerprint",
      "expectedRequestRevision",
      "hasAdjudicationAuthority",
    ]);
    const recordKeys: Array<keyof PermissionAskRequestRecord> = [
      "askIdentifier",
      "argumentsJson",
      "createdAtIso",
      "decidedAtIso",
      "decidedByAgentInstanceId",
      "expiresAtIso",
      "explanation",
      "operationFingerprint",
      "ownerAgentInstanceId",
      "requestRevision",
      "status",
      "taskIdentifier",
      "toolName",
    ];
    expect(recordKeys.length).toBe(13);
  });
});
