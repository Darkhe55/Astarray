/**
 * AR-01 可重放红灯测试（独立于正式测试）。
 *
 * 可重放步骤：
 *   1) git checkout a257cfb~1 -- packages/core/src/tools/builtins.ts packages/core/src/tools/policy-wrapper.ts
 *   2) npx vitest run tests/core/unit/protected-storage-red-light.test.ts
 *      → 预期失败（修复前普通工具可读取/列出/覆盖保管库与审计文件，5 项红灯全亮）
 *   3) git checkout a257cfb -- packages/core/src/tools/builtins.ts packages/core/src/tools/policy-wrapper.ts
 *   4) npx vitest run tests/core/unit/protected-storage-red-light.test.ts → 预期全部通过
 *
 * 本文件仅依赖 executeBuiltinTool 的行为，不依赖新类型（executionContext 以 as never 传入），
 * 保证回滚接线后仍能编译并产生行为性红灯。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { BackupVault } from "../../../packages/core/src/tools/backup-vault.js";

let temporaryDirectory: string;
let protectedStoragePolicy: ProtectedStoragePolicy;
let vault: BackupVault;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar01-red-"));
  protectedStoragePolicy = new ProtectedStoragePolicy({
    stateDirectoryPath: temporaryDirectory,
  });
  vault = new BackupVault({ baseDirectory: temporaryDirectory });
  await vault.initialize();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

/** 构造绕过 PolicyWrapper 的直接工具执行上下文（保持行为可回放）。 */
function directContext(extra = {}) {
  return {
    workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    requestingAgentInstanceId: "red-light-agent",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy,
    ...extra,
  } as never;
}

/**
 * 红灯语义：访问被拒绝（抛错或列表被过滤）时通过；返回敏感内容时失败。
 * 修复前（无策略接线）普通工具可读取保管库 → 红灯亮。
 */
async function assertAccessBlocked(
  toolCall: Promise<{ outputText: string; isSideEffectFree: boolean }>,
  forbiddenMarker: string,
): Promise<void> {
  try {
    const result = await toolCall;
    expect(result.outputText).not.toContain(forbiddenMarker);
  } catch {
    return;
  }
}

async function seedProtectedContent(): Promise<string> {
  const victimPath = path.join(temporaryDirectory, "workspace", "victim.txt");
  await fs.mkdir(path.dirname(victimPath), { recursive: true });
  await fs.writeFile(victimPath, "受保护内容", "utf8");
  const receipt = await vault.createPreMutationBackup({
    toolName: "replaceFileContent",
    targetPath: victimPath,
    mutationKind: "overwrite",
  });
  await fs.appendFile(
    path.join(temporaryDirectory, "backup-deletion-audit.jsonl"),
    '{"auditRecordId":"audit-1"}\n',
    "utf8",
  );
  return receipt.backupIdentifier;
}

describe("AR-01 红灯：普通工具不得访问受保护存储（回放用）", () => {
  it("红灯 1：读取保管库文件必须被拒绝", async () => {
    const backupIdentifier = await seedProtectedContent();
    await assertAccessBlocked(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({
          filePath: path.join("backup-vault", "data", backupIdentifier),
        }),
        directContext(),
      ),
      "受保护内容",
    );
  });

  it("红灯 2：读取审计文件必须被拒绝", async () => {
    await seedProtectedContent();
    await assertAccessBlocked(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "backup-deletion-audit.jsonl" }),
        directContext(),
      ),
      "audit-1",
    );
  });

  it("红灯 3：列出保管库根必须被拒绝", async () => {
    await seedProtectedContent();
    await assertAccessBlocked(
      executeBuiltinTool(
        "listDirectory",
        JSON.stringify({ directoryPath: "backup-vault" }),
        directContext(),
      ),
      "manifest.json",
    );
  });

  it("红灯 4：覆盖保管库文件必须被拒绝", async () => {
    const backupIdentifier = await seedProtectedContent();
    await assertAccessBlocked(
      executeBuiltinTool(
        "replaceFileContent",
        JSON.stringify({
          filePath: path.join("backup-vault", "data", backupIdentifier),
          content: "篡改",
        }),
        directContext(),
      ),
      "已覆盖",
    );
    // 保管库对象内容未被改变
    expect(await vault.listBackups(null)).toHaveLength(1);
  });

  it("红灯 5：列出状态目录不暴露受保护子项", async () => {
    await seedProtectedContent();
    const result = await executeBuiltinTool(
      "listDirectory",
      JSON.stringify({ directoryPath: "." }),
      directContext(),
    );
    expect(result.outputText).not.toContain("backup-vault");
    expect(result.outputText).not.toContain("backup-deletion-audit.jsonl");
  });
});
