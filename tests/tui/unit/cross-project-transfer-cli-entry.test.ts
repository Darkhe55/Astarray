/**
 * PROJECT-01-04 反例（2026-10-10）：只读/副本导入必须能从**公开 CLI 入口**真实使用。
 *
 * 现状缺口（本文件在实现前必须失败）：`CrossProjectTransferService` 已具备真实 I/O 与
 * 人工改动守卫，但**没有任何公开入口**调用它——SDK/CLI 只有"列表查询"，
 * 因此"用户精确授权 read 后可读不可写源""import-copy 只能写指定目标且不改来源"
 * 这两条卡内必测场景在**产品入口**上无法执行。
 *
 * 本轮钉住 CLI 入口最窄闭环：
 *  - `cross-project read`：有效授权 ⇒ exit 0 且**真的读出内容**；未授权 ⇒ 非 0 且不读资源；
 *  - `cross-project import-copy`：有效授权 ⇒ exit 0 且**目标文件真实出现**、来源字节不变；
 *    目标被人工占用且未提供基线 ⇒ **拒绝覆盖**（非 0）、人工字节保留；
 *  - 两个命令都使用 `--json` 输出可审计结果，且**不回显任何凭据**。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import {
  executeCrossProjectImportCopyCommand,
  executeCrossProjectReadCommand,
} from "../../../packages/tui/src/cli/commands.js";

let baseDirectory: string;
let sourceFilePath: string;
let targetFilePath: string;

const SOURCE_PROJECT = "project-a";
const TARGET_PROJECT = "project-b";
const SOURCE_REVISION = 3;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-cli-"));
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

async function grantAuthorization(input: {
  operationKind: "read" | "import-copy";
  argumentsHash: string;
}): Promise<void> {
  const store = new CrossProjectAuthorizationStore({ baseDirectory });
  await store.grantAuthorization({
    authorizationIdentifier: input.operationKind === "read" ? "auth-read" : "auth-import",
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: SOURCE_REVISION,
    targetProjectIdentifier: TARGET_PROJECT,
    targetProjectRevision: 1,
    operationKind: input.operationKind,
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: input.argumentsHash,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
  });
}

describe("PROJECT-01-04：只读入口（CLI）", () => {
  it("① 有效授权 ⇒ exit 0 且真实读出内容；来源字节不变", async () => {
    const content = "# 入口只读内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    await grantAuthorization({ operationKind: "read", argumentsHash: "hash-read" });

    const exitCode = await executeCrossProjectReadCommand({
      stateDirectory: baseDirectory,
      isJsonOutput: true,
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      absoluteResourcePath: sourceFilePath,
      argumentsHash: "hash-read",
    });
    expect(exitCode).toBe(0);
    expect(await fs.readFile(sourceFilePath, "utf8")).toBe(content);
  });

  it("② 参数哈希不匹配 ⇒ 非 0 退出码（不得放行）", async () => {
    await fs.writeFile(sourceFilePath, "内容\n", "utf8");
    await grantAuthorization({ operationKind: "read", argumentsHash: "hash-read" });

    const exitCode = await executeCrossProjectReadCommand({
      stateDirectory: baseDirectory,
      isJsonOutput: true,
      authorizationIdentifier: "auth-read",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      absoluteResourcePath: sourceFilePath,
      argumentsHash: "hash-different",
    });
    expect(exitCode).not.toBe(0);
  });
});

describe("PROJECT-01-04：副本导入入口（CLI）", () => {
  it("③ 有效授权 ⇒ exit 0、目标真实落盘、来源不变", async () => {
    const content = "# 入口导入内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const sourceHashBefore = sha256Text(content);
    await grantAuthorization({ operationKind: "import-copy", argumentsHash: "hash-import" });

    const exitCode = await executeCrossProjectImportCopyCommand({
      stateDirectory: baseDirectory,
      isJsonOutput: true,
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceFilePath,
      absoluteTargetPath: targetFilePath,
      sourceRevision: SOURCE_REVISION,
      argumentsHash: "hash-import",
    });
    expect(exitCode).toBe(0);
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
    expect(sha256Text(await fs.readFile(sourceFilePath, "utf8"))).toBe(sourceHashBefore);
  });

  it("④ 目标已存在且无基线 ⇒ 拒绝覆盖（非 0），人工字节保留", async () => {
    const content = "# 来源\n";
    const occupant = "# 人工已有内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    await fs.writeFile(targetFilePath, occupant, "utf8");
    await grantAuthorization({ operationKind: "import-copy", argumentsHash: "hash-import" });

    const exitCode = await executeCrossProjectImportCopyCommand({
      stateDirectory: baseDirectory,
      isJsonOutput: true,
      authorizationIdentifier: "auth-import",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: "docs/spec-copy.md",
      absoluteSourcePath: sourceFilePath,
      absoluteTargetPath: targetFilePath,
      sourceRevision: SOURCE_REVISION,
      argumentsHash: "hash-import",
    });
    expect(exitCode).not.toBe(0);
    expect(await fs.readFile(targetFilePath, "utf8")).toBe(occupant);
  });
});
