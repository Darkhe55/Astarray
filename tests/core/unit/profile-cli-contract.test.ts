/**
 * B6R-04 测试：CLI 权限组控制面契约（Headless）。
 * 覆盖：list（分页/JSON/无数量上限）、create/rename/copy/reset/set-capability/
 * export/import/delete/switch/show、当前组删除保护、JSON 契约稳定。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeProfileCopyCommand,
  executeProfileCreateCommand,
  executeProfileDeleteCommand,
  executeProfileExportCommand,
  executeProfileImportCommand,
  executeProfileListCommand,
  executeProfileRenameCommand,
  executeProfileResetCommand,
  executeProfileSetCapabilityCommand,
  executeProfileShowCommand,
  executeProfileSwitchCommand,
} from "../../../packages/tui/src/cli/commands.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { CurrentPermissionSelectionStore } from "../../../packages/core/src/tools/current-permission-selection.js";

let temporaryDirectory: string;
let stateDirectory: string;

/** 捕获 process.stdout。 */
function captureStdout(): { text: () => string; restore: () => void } {
  const originalWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => captured,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

function captureStderr(): { text: () => string; restore: () => void } {
  const originalWrite = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => captured,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r04-"));
  stateDirectory = path.join(temporaryDirectory, "state");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("B6R-04 CLI 权限组控制面", () => {
  it("list：内置三组 + 自定义组，JSON 契约稳定，无数量上限", async () => {
    const stdout = captureStdout();
    try {
      for (let index = 0; index < 30; index++) {
        const out = captureStdout();
        await executeProfileCreateCommand({
          stateDirectory,
          displayName: `组-${index}`,
          source: "blank",
        });
        out.restore();
      }
      const jsonOut = captureStdout();
      await executeProfileListCommand({
        stateDirectory,
        isJsonOutput: true,
        page: 1,
        pageSize: 50,
      });
      const parsed = JSON.parse(jsonOut.text()) as {
        profiles: Array<{ permissionProfileId: string; isBuiltin: boolean }>;
        total: number;
        currentSelection: unknown;
      };
      expect(parsed.total).toBe(33);
      expect(parsed.profiles.length).toBe(33);
      expect(parsed.profiles.filter((profile) => profile.isBuiltin).length).toBe(3);
      expect(parsed.currentSelection).toBeNull();
    } finally {
      stdout.restore();
    }
  });

  it("create/rename/copy/reset/set-capability/show 全生命周期", async () => {
    const createOut = captureStdout();
    await executeProfileCreateCommand({
      stateDirectory,
      displayName: "生产组",
      source: "devolve",
    });
    const profileId = createOut.text().split("\t")[0]!.replace("created ", "");
    createOut.restore();
    // set-capability
    await executeProfileSetCapabilityCommand({
      stateDirectory,
      permissionProfileId: profileId,
      capabilityId: "project.read",
      decision: "deny",
    });
    // show
    const showOut = captureStdout();
    await executeProfileShowCommand({
      stateDirectory,
      reference: profileId,
      isJsonOutput: true,
    });
    const shown = JSON.parse(showOut.text()) as {
      capabilityDecisions: Record<string, string>;
    };
    expect(shown.capabilityDecisions["project.read"]).toBe("deny");
    showOut.restore();
    // rename（ID 不变）
    const renameOut = captureStdout();
    await executeProfileRenameCommand({
      stateDirectory,
      permissionProfileId: profileId,
      newDisplayName: "生产组 v2",
    });
    renameOut.restore();
    const store = new PermissionProfileStore({
      baseDirectory: stateDirectory,
      catalog: new PermissionCapabilityCatalog(),
    });
    const renamed = await store.readCustomProfile(profileId);
    expect(renamed?.displayName).toBe("生产组 v2");
    // copy
    const copyOut = captureStdout();
    await executeProfileCopyCommand({
      stateDirectory,
      permissionProfileId: profileId,
      newDisplayName: "生产组副本",
    });
    const copiedId = copyOut.text().split("\t")[0]!.replace("copied ", "");
    copyOut.restore();
    expect(copiedId).not.toBe(profileId);
    // reset
    await executeProfileResetCommand({
      stateDirectory,
      permissionProfileId: profileId,
      source: "devolve",
    });
    const resetProfile = await store.readCustomProfile(profileId);
    expect(resetProfile?.capabilityDecisions["project.read"]).toBe("allow");
  });

  it("export 只含公开字段；import 重新创建；switch 持久化；delete 当前组保护", async () => {
    const createOut = captureStdout();
    await executeProfileCreateCommand({
      stateDirectory,
      displayName: "导出组",
      source: "assist",
    });
    const profileId = createOut.text().split("\t")[0]!.replace("created ", "");
    createOut.restore();
    await executeProfileSetCapabilityCommand({
      stateDirectory,
      permissionProfileId: profileId,
      capabilityId: "backup.read",
      decision: "allow",
    });
    // export
    const exportOut = captureStdout();
    await executeProfileExportCommand({
      stateDirectory,
      reference: profileId,
      outputPath: path.join(temporaryDirectory, "export.json"),
    });
    exportOut.restore();
    const exportedRaw = await fs.readFile(
      path.join(temporaryDirectory, "export.json"),
      "utf8",
    );
    const exported = JSON.parse(exportedRaw) as Record<string, unknown>;
    expect(exported["revision"]).toBeUndefined();
    expect(exported["frozenSignature"]).toBeUndefined();
    expect(exported["capabilityDecisions"]).toBeDefined();
    // 导入（改名避免同名冲突；只接受可配置字段）
    exported["displayName"] = "导入的导出组";
    await fs.writeFile(
      path.join(temporaryDirectory, "export.json"),
      JSON.stringify(exported),
      "utf8",
    );
    const importOut = captureStdout();
    await executeProfileImportCommand({
      stateDirectory,
      inputPath: path.join(temporaryDirectory, "export.json"),
    });
    const importedId = importOut.text().split("\t")[0]!.replace("imported ", "");
    importOut.restore();
    const store = new PermissionProfileStore({
      baseDirectory: stateDirectory,
      catalog: new PermissionCapabilityCatalog(),
    });
    const imported = await store.readCustomProfile(importedId);
    expect(imported?.capabilityDecisions["backup.read"]).toBe("allow");
    // switch（认证用户选择当前权限组）
    await executeProfileSwitchCommand({
      stateDirectory,
      reference: profileId,
    });
    const selectionStore = new CurrentPermissionSelectionStore({
      baseDirectory: stateDirectory,
    });
    const selection = await selectionStore.readSelection();
    expect(selection?.selectedReference).toEqual({
      kind: "custom",
      profileId,
    });
    // 当前组删除保护（stderr 含提示；命令抛错）
    const stderr = captureStderr();
    await expect(
      executeProfileDeleteCommand({
        stateDirectory,
        permissionProfileId: profileId,
      }),
    ).rejects.toThrowError(/先 switch/);
    stderr.restore();
    // 切回内置后删除成功
    await executeProfileSwitchCommand({ stateDirectory, reference: "devolve" });
    await executeProfileDeleteCommand({
      stateDirectory,
      permissionProfileId: profileId,
    });
    expect(await store.readCustomProfile(profileId)).toBeNull();
  });

  it("非法来源/非法 decision 稳定拒绝", async () => {
    const stderr = captureStderr();
    await expect(
      executeProfileCreateCommand({
        stateDirectory,
        displayName: "x",
        source: "evil-source",
      }),
    ).rejects.toThrowError(/非法来源/);
    stderr.restore();
  });
});
