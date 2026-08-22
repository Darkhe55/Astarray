/**
 * T08C-04 测试：侦察型三级 Agent 与 PROJECT_CONTEXT_DIGEST_V1。
 * 验收：大仓库摘要、stale 标记、增量复查、敏感禁读、只读工具子集。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectReconnaissanceDigestStore } from "../../../packages/core/src/orchestration/project-reconnaissance-digest-store.js";
import { ProjectReconnaissanceController } from "../../../packages/core/src/orchestration/project-reconnaissance-controller.js";
import {
  PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION,
  PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION,
} from "../../../packages/core/src/orchestration/agent-routing-schemas.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08c04-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeDigest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION as 1,
    digestId: "digest-1",
    reconnaissanceAgentInstanceId: "recon-1",
    scanningScope: "packages/core/src/orchestration",
    keyEntryPoints: ["main-controller.ts"],
    stableContracts: ["TaskSequenceManageController"],
    relevantFileReferences: [
      { filePath: "src/orchestration/main-controller.ts", contentFingerprint: VALID_SHA256 },
    ],
    dependencyRelations: ["orchestration → core"],
    testEntryPoints: ["tests/core/unit"],
    openQuestions: ["四级工作存档范围"],
    conflicts: ["PLAN_STATUS 标记过时"],
    sources: ["docs/architecture.md"],
    isStale: false,
    tokenBudget: 4000,
    contentHash: VALID_SHA256,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function makeReconnaissanceTask(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION as 1,
    reconnaissanceTaskId: "recon-task-1",
    assigningSecondaryAgentInstanceId: "secondary-1",
    scopeQuery: "核心编排模块结构",
    allowedReadToolNames: ["project-read", "project-search"],
    tokenBudget: 4000,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeHarness(options: {
  registeredReconnaissance?: string[];
  sensitivePaths?: string[];
} = {}) {
  const store = new ProjectReconnaissanceDigestStore({
    baseDirectory: temporaryDirectory,
  });
  const registered = new Set(options.registeredReconnaissance ?? ["recon-1"]);
  const sensitiveSet = new Set(options.sensitivePaths ?? []);
  const controller = new ProjectReconnaissanceController({
    digestStore: store,
    sensitivePathMatchPort: {
      matchSensitivePathName: (filePath) =>
        sensitiveSet.has(filePath) ? "env-file" : null,
    },
    sourceAuthenticationPort: {
      isRegisteredReconnaissance: async (agentInstanceId) =>
        registered.has(agentInstanceId),
    },
  });
  return { store, controller };
}

describe("ProjectReconnaissanceDigestStore", () => {
  it("保存 → 读取往返；revision 单调递增", async () => {
    const store = new ProjectReconnaissanceDigestStore({
      baseDirectory: temporaryDirectory,
    });
    await store.saveDigest(makeDigest() as never);
    const read = await store.readDigest("digest-1");
    expect(read?.digestId).toBe("digest-1");
    expect(read?.revision).toBe(1);
    expect(read?.isStale).toBe(false);
  });

  it("同 digestId 非单调 revision 拒绝（幂等）", async () => {
    const store = new ProjectReconnaissanceDigestStore({
      baseDirectory: temporaryDirectory,
    });
    await store.saveDigest(makeDigest() as never);
    await expect(
      store.saveDigest(makeDigest({ revision: 1 }) as never),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("markStale 标记后读取为 stale；不存在返回 false", async () => {
    const store = new ProjectReconnaissanceDigestStore({
      baseDirectory: temporaryDirectory,
    });
    await store.saveDigest(makeDigest() as never);
    expect(await store.markStale("digest-1")).toBe(true);
    expect((await store.readDigest("digest-1"))?.isStale).toBe(true);
    expect(await store.markStale("ghost")).toBe(false);
  });
});

describe("ProjectReconnaissanceController", () => {
  it("创建只读侦察任务通过（最小读取工具子集）", async () => {
    const { controller } = makeHarness();
    const task = await controller.createReconnaissanceTask({
      task: makeReconnaissanceTask(),
    });
    expect(task.reconnaissanceTaskId).toBe("recon-task-1");
  });

  it("拒绝非只读工具（写入/执行/网络/备份不在子集）", async () => {
    const { controller } = makeHarness();
    await expect(
      controller.createReconnaissanceTask({
        task: makeReconnaissanceTask({ allowedReadToolNames: ["project-write"] }),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("记录摘要：来源认证 + 落盘 + 同范围旧摘要标 stale", async () => {
    const { store, controller } = makeHarness();
    await controller.recordDigest({ digest: makeDigest() });
    await controller.recordDigest({
      digest: makeDigest({
        digestId: "digest-2",
        reconnaissanceAgentInstanceId: "recon-1",
        revision: 1,
      }),
    });
    expect((await store.readDigest("digest-1"))?.isStale).toBe(true);
    expect((await store.readDigest("digest-2"))?.isStale).toBe(false);
  });

  it("记录摘要：来源侦察 Agent 未登记 → 拒绝", async () => {
    const { controller } = makeHarness({ registeredReconnaissance: ["recon-1"] });
    await expect(
      controller.recordDigest({
        digest: makeDigest({ reconnaissanceAgentInstanceId: "attacker-recon" }),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("记录摘要：文件引用涉敏感路径 → 拒绝（敏感禁读对侦察同样生效）", async () => {
    const { store, controller } = makeHarness({
      sensitivePaths: ["src/orchestration/.env"],
    });
    await expect(
      controller.recordDigest({
        digest: makeDigest({
          relevantFileReferences: [
            { filePath: "src/orchestration/.env", contentFingerprint: VALID_SHA256 },
          ],
        }),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(await store.listDigests()).toHaveLength(0);
  });

  it("增量复查：指纹变化 → 标记 stale + 增量提示（不重新注入全部历史）", async () => {
    const { store, controller } = makeHarness();
    await controller.recordDigest({ digest: makeDigest() });
    const result = await controller.requestIncrementalRefresh({ digestId: "digest-1" });
    expect(result).toMatchObject({
      digestId: "digest-1",
      isStale: true,
      refreshHint: expect.stringContaining("不重新注入全部历史"),
    });
    expect((await store.readDigest("digest-1"))?.isStale).toBe(true);
  });

  it("增量复查：摘要不存在 → 拒绝", async () => {
    const { controller } = makeHarness();
    await expect(
      controller.requestIncrementalRefresh({ digestId: "ghost" }),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
  });
});
