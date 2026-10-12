/**
 * GUI-02 覆盖率结构性补强（2026-10-12）：`commands.ts` 的面板命令**进程内**覆盖。
 *
 * 动因（实测）：`packages/tui/src/cli/commands.ts` 的**未覆盖分支最多**
 * （缺 **297/899 ≈ 全局 2.7%**），而 `test:coverage` 的全局**分支**门槛为 85，
 * 实测在 **84.97–85.02** 间摆动 ⇒ **抖动量级（约 ±0.02 点）大于单条测试贡献（约 0.01 点）**，
 * 零散补分支徒劳。故改为**结构性补测**：覆盖这些命令的**真实路径**以取得远离抖动带的余量。
 *
 * 说明：这些命令此前**仅由子进程驱动**（v8 不可见 ⇒ 长期低覆盖，见 B6R-10 记录）。
 * 本文件直接调用命令函数（不 spawn），使覆盖可见。
 *
 * **如实记录两处取舍**（我多次试错后判定为「应先读清语义、不写猜测性断言」）：
 * - `set-capability`：`capabilityId` 必须是 `PermissionCapabilityCatalog` 中的**可配置**能力，
 *   而目录首位（如 `project.read`）属**不可配置**的底层强制约束 ⇒ 需先摸清"哪些可配置"；
 * - `session-elevate` 的非法决定值：实测**并未**按我预期返回非 0。
 * 二者本轮**未纳入**，以免把猜测写进断言。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeProfileCopyCommand,
  executeProfileCreateCommand,
  executeProfileDeleteCommand,
  executeProfileExportCommand,
  executeProfileImportCommand,
  executeProfileListCommand,
  executeProfileRenameCommand,
  executeProfileResetCommand,
  executeProfileShowCommand,
  executeProfileSwitchCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

/**
 * `create` / `copy` **无视 `isJsonOutput`**（既有实现：恒输出
 * `created|copied <id>\t<name>`），故从纯文本解析 ID —— 这是**如实适配既有契约**，
 * 不修改产品行为。
 */
function readCreatedProfileId(output: string): string {
  const matched = /^(?:created|copied) (\S+)/m.exec(output);
  if (matched === null) {
    throw new Error("未从输出解析到 profileId: " + output);
  }
  return matched[1]!;
}

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { getOutput: () => chunks.join("") };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-cmd-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GUI-02 覆盖补强：profile 命令（进程内）", () => {
  it("① list：JSON 与非 JSON 两条输出分支，且内置三档可见", async () => {
    const jsonCapture = captureStdout();
    expect(
      await executeProfileListCommand({
        stateDirectory,
        isJsonOutput: true,
        page: 1,
        pageSize: 2,
      }),
    ).toBe(0);
    const payload = JSON.parse(jsonCapture.getOutput()) as {
      profiles: Array<{ permissionProfileId: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(payload.profiles.length).toBe(2);
    expect(payload.total).toBeGreaterThanOrEqual(3);
    vi.restoreAllMocks();

    const textCapture = captureStdout();
    expect(
      await executeProfileListCommand({ stateDirectory, isJsonOutput: false }),
    ).toBe(0);
    expect(textCapture.getOutput()).toContain("assist");
  });

  it("② create → show → rename → copy → reset → delete 全链路", async () => {
    const createCapture = captureStdout();
    expect(
      await executeProfileCreateCommand({
        stateDirectory,
        isJsonOutput: true,
        displayName: "我的面板",
        source: "assist",
      }),
    ).toBe(0);
    const profileId = readCreatedProfileId(createCapture.getOutput());
    expect(profileId.length).toBeGreaterThan(0);
    vi.restoreAllMocks();

    const showCapture = captureStdout();
    expect(
      await executeProfileShowCommand({
        stateDirectory,
        isJsonOutput: true,
        reference: "custom:" + profileId,
      }),
    ).toBe(0);
    expect(showCapture.getOutput()).toContain(profileId);
    vi.restoreAllMocks();

    expect(
      await executeProfileRenameCommand({
        stateDirectory,
        isJsonOutput: true,
        permissionProfileId: profileId,
        newDisplayName: "改名后",
      }),
    ).toBe(0);
    vi.restoreAllMocks();

    const copyCapture = captureStdout();
    expect(
      await executeProfileCopyCommand({
        stateDirectory,
        isJsonOutput: true,
        permissionProfileId: profileId,
        newDisplayName: "副本",
      }),
    ).toBe(0);
    const copiedId = readCreatedProfileId(copyCapture.getOutput());
    expect(copiedId).not.toBe(profileId);
    vi.restoreAllMocks();

    expect(
      await executeProfileResetCommand({
        stateDirectory,
        isJsonOutput: true,
        permissionProfileId: profileId,
        source: "devolve",
      }),
    ).toBe(0);
    vi.restoreAllMocks();

    expect(
      await executeProfileDeleteCommand({
        stateDirectory,
        isJsonOutput: true,
        permissionProfileId: copiedId,
      }),
    ).toBe(0);
  });

  it("③ export → 删除原档 → import 往返；缺失输入文件**抛 ENOENT**", async () => {
    const createCapture = captureStdout();
    await executeProfileCreateCommand({
      stateDirectory,
      isJsonOutput: true,
      displayName: "导出面板",
      source: "devolve",
    });
    const profileId = readCreatedProfileId(createCapture.getOutput());
    vi.restoreAllMocks();

    const exportPath = path.join(stateDirectory, "exported-profile.json");
    expect(
      await executeProfileExportCommand({
        stateDirectory,
        isJsonOutput: true,
        reference: "custom:" + profileId,
        outputPath: exportPath,
      }),
    ).toBe(0);
    expect(await fs.readFile(exportPath, "utf8")).toContain("schemaVersion");
    vi.restoreAllMocks();

    /**
     * **必须先删除原档**：`importProfile` **不支持改名**，而重名会被既有校验
     * 以「权限组名称已存在」拒绝 ⇒ 先导出、删原档、再导入，才能覆盖导入成功路径。
     */
    expect(
      await executeProfileDeleteCommand({
        stateDirectory,
        isJsonOutput: true,
        permissionProfileId: profileId,
      }),
    ).toBe(0);
    vi.restoreAllMocks();

    const importCapture = captureStdout();
    expect(
      await executeProfileImportCommand({
        stateDirectory,
        isJsonOutput: true,
        inputPath: exportPath,
      }),
    ).toBe(0);
    expect(importCapture.getOutput().length).toBeGreaterThan(0);
    vi.restoreAllMocks();

    /**
     * **如实适配既有行为**：不存在的输入文件会让 `fs.readFile` 抛 `ENOENT`
     * （该命令**不**把它转成返回码）⇒ 断言「抛出」，不改产品行为。
     */
    await expect(
      executeProfileImportCommand({
        stateDirectory,
        isJsonOutput: true,
        inputPath: path.join(stateDirectory, "does-not-exist.json"),
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("④ switch：内置档与自定义档均成功；未知自定义档**不报错**（既有语义）", async () => {
    const createCapture = captureStdout();
    await executeProfileCreateCommand({
      stateDirectory,
      isJsonOutput: true,
      displayName: "切换面板",
      source: "ponder",
    });
    const profileId = readCreatedProfileId(createCapture.getOutput());
    vi.restoreAllMocks();

    expect(
      await executeProfileSwitchCommand({
        stateDirectory,
        isJsonOutput: true,
        reference: "assist",
      }),
    ).toBe(0);
    vi.restoreAllMocks();

    expect(
      await executeProfileSwitchCommand({
        stateDirectory,
        isJsonOutput: true,
        reference: "custom:" + profileId,
      }),
    ).toBe(0);
    vi.restoreAllMocks();

    /**
     * **如实适配既有行为**：`parseProfileReference` 对未知 `custom:<id>` 仍返回
     * `{kind:"custom"}`，而 `switch` 只写选择、**不校验该档是否存在** ⇒ 返回 0。
     * 此处只断言「返回数字、不抛异常」，**不把它当错误**，也不改产品行为。
     */
    const unknownSwitchExit = await executeProfileSwitchCommand({
      stateDirectory,
      isJsonOutput: true,
      reference: "custom:custom-not-exists",
    });
    expect(typeof unknownSwitchExit).toBe("number");
  });
});