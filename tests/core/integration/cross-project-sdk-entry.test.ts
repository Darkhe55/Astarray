/**
 * PROJECT-01-04 反例（2026-10-10）：只读/副本导入必须能从 **SDK 公开入口**真实使用。
 *
 * 现状缺口（本文件在实现前必须失败）：CLI 已有 `cross-project read/import-copy`，
 * 但 `AstarrayApplicationFacade` 上**没有任何**跨项目传输入口——
 * SDK 消费者（含 GUI 的只读视图）拿不到"来源零写入的真实读取"与"真实写出副本"的能力，
 * 只能自己去找授权存储内部路径，违反"消费者不依赖内部实现"的公开入口约束。
 *
 * 本轮钉住的语义（全部经公开入口）：
 *  - `readCrossProjectResource`：有效授权 ⇒ `read-allowed` 且 `didRead=true`、内容真实；
 *    未授权 ⇒ 如实拒绝且 `didRead=false`（不得谎报已读）；
 *  - `importCrossProjectResource`：有效授权 ⇒ `imported-copy` 且目标文件**真实存在**；
 *    目标被人工占用且无基线 ⇒ 拒绝覆盖、人工字节保留；
 *  - 幂等重放 ⇒ `reused-existing-copy`，不重复写入；
 *  - 来源字节在只读与导入后都**保持不变**。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import type { CrossProjectResourceIoPort } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let baseDirectory: string;
let sourceFilePath: string;
let targetFilePath: string;

const SOURCE_PROJECT = "project-a";
const TARGET_PROJECT = "project-b";
const SOURCE_REVISION = 3;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-sdk-"));
  sourceFilePath = path.join(baseDirectory, "project-a", "docs", "spec.md");
  targetFilePath = path.join(baseDirectory, "project-b", "docs", "spec-copy.md");
  await fs.mkdir(path.dirname(sourceFilePath), { recursive: true });
  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildResourceIo(): CrossProjectResourceIoPort {
  return {
    readTextFile: (absolutePath: string) => fs.readFile(absolutePath, "utf8"),
    writeTextFile: (absolutePath: string, content: string) =>
      fs.writeFile(absolutePath, content, "utf8"),
    ensureDirectory: async (absoluteDirectory: string) => {
      await fs.mkdir(absoluteDirectory, { recursive: true });
    },
    fileExists: async (absolutePath: string) => {
      try {
        await fs.stat(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function createApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory: baseDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 2,
    failureThreshold: 3,
    crossProjectResourceIo: buildResourceIo(),
  } as never);
}

describe("PROJECT-01-04：跨项目传输的 SDK 公开入口", () => {
  it("① 有效授权只读 ⇒ read-allowed 且真实读到内容；来源不变", async () => {
    const content = "# SDK 只读内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const application = await createApplication();
    try {
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "sdk-auth-read",
        sourceProjectIdentifier: SOURCE_PROJECT,
        sourceProjectRevision: SOURCE_REVISION,
        targetProjectIdentifier: TARGET_PROJECT,
        operationKind: "read",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "sdk-hash-read",
      });

      const result = await application.readCrossProjectResource({
        authorizationIdentifier: "sdk-auth-read",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        absoluteResourcePath: sourceFilePath,
        argumentsHash: "sdk-hash-read",
      });
      expect(result.outcome).toBe("read-allowed");
      expect(result.didRead).toBe(true);
      expect(result.content).toBe(content);
      expect(result.sourceContentHashBefore).toBe(sha256Text(content));
      expect(result.sourceContentHashAfter).toBe(result.sourceContentHashBefore);
      expect(await fs.readFile(sourceFilePath, "utf8")).toBe(content);
    } finally {
      await application.shutdown();
    }
  });

  it("② 未授权只读 ⇒ 如实拒绝且 didRead=false（不谎报已读）", async () => {
    await fs.writeFile(sourceFilePath, "内容\n", "utf8");
    const application = await createApplication();
    try {
      const result = await application.readCrossProjectResource({
        authorizationIdentifier: "sdk-auth-missing",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        absoluteResourcePath: sourceFilePath,
        argumentsHash: "sdk-hash-read",
      });
      expect(result.outcome).toBe("authorization-not-found");
      expect(result.didRead).toBe(false);
      expect(result.content).toBeNull();
    } finally {
      await application.shutdown();
    }
  });

  it("③ 有效授权导入 ⇒ 目标真实落盘；重复导入幂等；来源不变", async () => {
    const content = "# SDK 导入内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const sourceHashBefore = sha256Text(content);
    const application = await createApplication();
    try {
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "sdk-auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        sourceProjectRevision: SOURCE_REVISION,
        targetProjectIdentifier: TARGET_PROJECT,
        operationKind: "import-copy",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "sdk-hash-import",
      });

      const importInput = {
        authorizationIdentifier: "sdk-auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "docs/spec-copy.md",
        absoluteSourcePath: sourceFilePath,
        absoluteTargetPath: targetFilePath,
        sourceRevision: SOURCE_REVISION,
        argumentsHash: "sdk-hash-import",
      };
      const first = await application.importCrossProjectResource(importInput);
      expect(first.outcome).toBe("imported-copy");
      expect(first.didWriteTarget).toBe(true);
      expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);

      const second = await application.importCrossProjectResource(importInput);
      expect(second.outcome).toBe("reused-existing-copy");
      expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
      expect(sha256Text(await fs.readFile(sourceFilePath, "utf8"))).toBe(sourceHashBefore);
    } finally {
      await application.shutdown();
    }
  });

  it("④ 目标被人工占用且无基线 ⇒ 拒绝覆盖，人工字节保留", async () => {
    const content = "# 来源\n";
    const occupant = "# 人工已有\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    await fs.writeFile(targetFilePath, occupant, "utf8");
    const application = await createApplication();
    try {
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "sdk-auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        sourceProjectRevision: SOURCE_REVISION,
        targetProjectIdentifier: TARGET_PROJECT,
        operationKind: "import-copy",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "sdk-hash-import",
      });
      const result = await application.importCrossProjectResource({
        authorizationIdentifier: "sdk-auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "docs/spec-copy.md",
        absoluteSourcePath: sourceFilePath,
        absoluteTargetPath: targetFilePath,
        sourceRevision: SOURCE_REVISION,
        argumentsHash: "sdk-hash-import",
      });
      expect(result.outcome).toBe("target-stale-rejected");
      expect(await fs.readFile(targetFilePath, "utf8")).toBe(occupant);
    } finally {
      await application.shutdown();
    }
  });
});
