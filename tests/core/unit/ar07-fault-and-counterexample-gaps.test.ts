/**
 * AR-07 批次 10：故障注入 / 并发 / 安全反例补测。
 * - 单调时钟回拨不得让未变化资源被误放行；
 * - 路径别名/相对段不得绕过读取抑制键；
 * - DLP 扫描器故障必须 fail-closed（拒绝传播，而非静默放行）；
 * - 会话授权过期后立即回到 ask，不得延续 allow；
 * - 并发查询下抑制决定保持一致。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";
import { SensitiveContentAccessPolicy } from "../../../packages/core/src/tools/sensitive-content-access-policy.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07-b10-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function queryFor(canonicalPath: string) {
  return {
    agentInstanceId: "agent-a",
    taskExecutionId: "task-1",
    canonicalPath,
    operationKind: "read",
    normalizedRange: "full",
    parameterHash: "hash-1",
  } as never;
}

describe("AR-07 批次10：故障注入与安全反例", () => {
  it("单调时钟回拨不误放行未变化资源", async () => {
    let nowMilliseconds = 10_000;
    const ledger = new ReadSuppressionLedger({
      nowUnixMilliseconds: () => nowMilliseconds,
      unchangedReadSuppressionWindowMilliseconds: 1_000,
    });
    const filePath = path.join(temporaryDirectory, "clock.txt");
    await fs.writeFile(filePath, "v1", "utf8");
    await ledger.registerRead({
      ...(queryFor(filePath) as object),
      contentFingerprint: null,
    } as never);

    nowMilliseconds = 9_000; // 时钟回拨
    const decision = await ledger.querySuppression(queryFor(filePath));
    expect(decision.isSuppressed).toBe(true);
    expect(decision.retryAfterMilliseconds).toBeGreaterThan(1_000);
  });

  it("路径别名与相对段不能绕过抑制键", async () => {
    let nowMilliseconds = 1_000;
    const ledger = new ReadSuppressionLedger({
      nowUnixMilliseconds: () => nowMilliseconds,
    });
    const filePath = path.join(temporaryDirectory, "alias.txt");
    await fs.writeFile(filePath, "v1", "utf8");
    await ledger.registerRead({
      ...(queryFor(filePath) as object),
      contentFingerprint: null,
    } as never);
    nowMilliseconds = 1_100;

    const aliased = path.join(temporaryDirectory, "sub", "..", "alias.txt");
    expect(await ledger.querySuppression(queryFor(aliased))).toMatchObject({
      isSuppressed: true,
    });
    expect(await ledger.getEntryCount()).toBe(1);
  });

  it("DLP 扫描器故障 fail-closed（拒绝传播而非放行）", async () => {
    const policy = new SensitiveContentAccessPolicy({
      dlpScanner: {
        scanTextContent: async () => {
          throw new Error("dlp-offline");
        },
      },
    });
    await expect(
      policy.assertSensitiveContentReadAllowed({
        canonicalPath: path.join(temporaryDirectory, "notes.txt"),
        content: "普通内容",
      }),
    ).rejects.toThrow("dlp-offline");
  });

  it("会话授权过期后立即回到 ask", async () => {
    let nowSeconds = 1_000;
    const profile = {
      schemaVersion: 1,
      permissionProfileId: "builtin:assist",
      displayName: "Assist",
      isBuiltin: true,
      revision: 1,
      catalogVersion: 1,
      capabilityDecisions: {},
      fallbackDecision: "ask",
      frozenSignature: null,
      createdAtIso: "2026-01-01T00:00:00.000Z",
      updatedAtIso: "2026-01-01T00:00:00.000Z",
    };
    const engine = new ConfigurablePermissionPolicyEngine({
      catalog: {
        isToolMapped: () => true,
        evaluateToolPermission: () => "ask",
      } as never,
      profileStore: { readProfile: async () => profile } as never,
      nowUnixSeconds: () => nowSeconds,
      authorizationTtlSeconds: 10,
    });
    const reference = { kind: "builtin", profileId: "assist" } as const;
    await engine.grantSessionAuthorization({
      toolName: "project.read",
      profileReference: reference,
      argumentsJson: "{}",
    });
    expect(
      (await engine.decide({
        toolName: "project.read",
        profileReference: reference,
        argumentsJson: "{}",
      })).decision,
    ).toBe("allow");

    nowSeconds = 2_000;
    expect(
      (await engine.decide({
        toolName: "project.read",
        profileReference: reference,
        argumentsJson: "{}",
      })).decision,
    ).toBe("ask");
  });

  it("并发查询下抑制决定保持一致", async () => {
    const ledger = new ReadSuppressionLedger({
      nowUnixMilliseconds: () => 5_000,
      unchangedReadSuppressionWindowMilliseconds: 30_000,
    });
    const filePath = path.join(temporaryDirectory, "concurrent.txt");
    await fs.writeFile(filePath, "v1", "utf8");
    await ledger.registerRead({
      ...(queryFor(filePath) as object),
      contentFingerprint: null,
    } as never);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => ledger.querySuppression(queryFor(filePath))),
    );
    expect(decisions.every((decision) => decision.isSuppressed)).toBe(true);
    expect(new Set(decisions.map((decision) => decision.readReceiptId)).size).toBe(1);
  });
});
