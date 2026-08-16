/**
 * B6R-11：profile 命令组错误路径与文本模式覆盖补缺。
 * （show 文本/无选择、非法来源、rename/reset/set-capability 不存在、
 * delete 当前使用组拒绝、export 写文件、switch custom: 前缀、list 分页标记。）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeProfileCreateCommand,
  executeProfileDeleteCommand,
  executeProfileExportCommand,
  executeProfileListCommand,
  executeProfileRenameCommand,
  executeProfileResetCommand,
  executeProfileSetCapabilityCommand,
  executeProfileShowCommand,
  executeProfileSwitchCommand,
} from "../../../packages/tui/src/cli/commands.js";

let temporaryDirectory: string;
let stdoutBuffer: string[];
let originalWrite: typeof process.stdout.write;
let originalExitCode: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-profcmd-"));
  stdoutBuffer = [];
  originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  originalExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
});

afterEach(async () => {
  process.stdout.write = originalWrite;
  process.exitCode = originalExitCode;
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

async function createProfile(displayName = "测试组"): Promise<string> {
  await executeProfileCreateCommand({
    stateDirectory: temporaryDirectory,
    displayName,
    source: "blank",
  });
  const line = stdoutBuffer.find((chunk) => chunk.includes("created ")) ?? "";
  stdoutBuffer.length = 0;
  return line.replace("created ", "").split("\t")[0] ?? "";
}

describe("profile 命令错误路径与文本模式", () => {
  it("rename/reset/set-capability 权限组不存在 → failWithCode（exit 2 + 抛错）", async () => {
    for (const run of [
      () =>
        executeProfileRenameCommand({
          stateDirectory: temporaryDirectory,
          permissionProfileId: "ghost",
          newDisplayName: "x",
        }),
      () =>
        executeProfileResetCommand({
          stateDirectory: temporaryDirectory,
          permissionProfileId: "ghost",
          source: "assist",
        }),
      () =>
        executeProfileSetCapabilityCommand({
          stateDirectory: temporaryDirectory,
          permissionProfileId: "ghost",
          capabilityId: "filesystem-read",
          decision: "allow",
        }),
    ]) {
      await expect(run()).rejects.toThrow(/不存在/);
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    }
  });

  it("create 非法来源 → 拒绝；custom:<id> 来源可用（617/619）", async () => {
    await expect(
      executeProfileCreateCommand({
        stateDirectory: temporaryDirectory,
        displayName: "x",
        source: "whatever",
      }),
    ).rejects.toThrow(/非法来源/);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    const profileId = await createProfile("源组");
    stdoutBuffer.length = 0;
    await executeProfileCreateCommand({
      stateDirectory: temporaryDirectory,
      displayName: "复制组",
      source: `custom:${profileId}`,
    });
    expect(stdoutBuffer.join("")).toContain("created ");
  });

  it("switch custom: 前缀引用 + list 文本模式当前标记与分页", async () => {
    const profileId = await createProfile("定制组");
    stdoutBuffer.length = 0;
    await executeProfileSwitchCommand({
      stateDirectory: temporaryDirectory,
      reference: `custom:${profileId}`,
    });
    expect(stdoutBuffer.join("")).toContain("switched");
    stdoutBuffer.length = 0;
    await executeProfileListCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: false,
      page: 2,
      pageSize: 2,
    });
    const text = stdoutBuffer.join("");
    expect(text).toContain("*"); // 当前使用组标记
    expect(text).toContain("定制组");
  });

  it("delete 当前使用组 → 拒绝（先 switch）", async () => {
    const profileId = await createProfile("当前组");
    await executeProfileSwitchCommand({
      stateDirectory: temporaryDirectory,
      reference: profileId,
    });
    stdoutBuffer.length = 0;
    await expect(
      executeProfileDeleteCommand({
        stateDirectory: temporaryDirectory,
        permissionProfileId: profileId,
      }),
    ).rejects.toThrow(/先 switch/);
    expect(process.exitCode).toBe(2);
  });

  it("show 无选择 → 拒绝；show 文本模式列出 capability", async () => {
    await expect(
      executeProfileShowCommand({
        stateDirectory: temporaryDirectory,
        reference: null,
      }),
    ).rejects.toThrow(/未选择权限组/);
    const profileId = await createProfile("文本组");
    stdoutBuffer.length = 0;
    await executeProfileShowCommand({
      stateDirectory: temporaryDirectory,
      reference: profileId,
      isJsonOutput: false,
    });
    expect(stdoutBuffer.join("")).toContain("文本组");
    expect(stdoutBuffer.join("")).toContain("revision=");
  });

  it("export 写入文件（含 .bak 覆盖备份）", async () => {
    const profileId = await createProfile("导出组");
    const exportPath = path.join(temporaryDirectory, "export", "group.json");
    await fs.mkdir(path.dirname(exportPath), { recursive: true });
    await fs.writeFile(exportPath, '{"old":true}\n', "utf8");
    stdoutBuffer.length = 0;
    await executeProfileExportCommand({
      stateDirectory: temporaryDirectory,
      reference: profileId,
      outputPath: exportPath,
    });
    expect(stdoutBuffer.join("")).toContain("exported →");
    expect(await fs.readFile(`${exportPath}.bak`, "utf8")).toContain("old");
    expect(await fs.readFile(exportPath, "utf8")).toContain("permissionProfileId");
  });

  it("export 无 outputPath：stdout 输出 JSON（511）；show --json", async () => {
    const profileId = await createProfile("stdout 组");
    stdoutBuffer.length = 0;
    await executeProfileExportCommand({
      stateDirectory: temporaryDirectory,
      reference: profileId,
      outputPath: null,
    });
    const exported = JSON.parse(stdoutBuffer.join("")) as { displayName: string };
    expect(exported.displayName).toBe("stdout 组");
    stdoutBuffer.length = 0;
    await executeProfileShowCommand({
      stateDirectory: temporaryDirectory,
      reference: profileId,
      isJsonOutput: true,
    });
    const shown = JSON.parse(stdoutBuffer.join("")) as { permissionProfileId: string };
    expect(shown.permissionProfileId).toBe(profileId);
  });
});
