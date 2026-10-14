/**
 * 反例（2026-10-30）：跨项目资源 I/O 端口必须是**受控**的。
 *
 * 卡内要求（PROJECT-01-03 检查点）：
 * "在装配层提供一个**项目内受控**的 `CrossProjectResourceIoPort` 并注入 SDK 路径，要求：
 *  ① 读写必须经过既有的 `WorkspaceBoundary` 与 `ProtectedStoragePolicy`
 *    （**不得**照搬 CLI 的裸 `fs` 端口：那样等于'拿到绝对路径就能读写'）；
 *  ② 人工改动守卫同样需要生产实现；
 *  ③ 先写**行为反例**（越界路径必须被拒、受保护存储必须被拒、未授权不得读写）。"
 *
 * 本文件覆盖 ③ 的前两组。**关键点**：拒绝必须发生在**触达磁盘之前**
 * （用"文件确实存在且内容已知"来证明"没读到"，而不是只看抛错）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ControlledCrossProjectResourceIo } from "../../../packages/core/src/tools/controlled-cross-project-resource-io.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let temporaryDirectory: string;
let workspaceRoot: string;
let outsideRoot: string;
let port: ControlledCrossProjectResourceIo;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-xproj-port-"));
  workspaceRoot = path.join(temporaryDirectory, "workspace");
  outsideRoot = path.join(temporaryDirectory, "outside");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });

  port = new ControlledCrossProjectResourceIo({
    workspaceBoundary: new WorkspaceBoundary(workspaceRoot),
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: path.join(workspaceRoot, ".astarray"),
    }),
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("PROJECT-01-03：受控跨项目资源端口 —— 越界必须被拒", () => {
  it("① 读取**工作区外**的绝对路径 ⇒ 拒绝，且**没有读到内容**", async () => {
    const outsideFile = path.join(outsideRoot, "secret.md");
    const secretContent = "outside-should-not-be-readable";
    await fs.writeFile(outsideFile, secretContent, "utf8");

    await expect(port.readTextFile(outsideFile)).rejects.toThrow();

    // 反证"没读到"：文件确实存在且有内容，但返回值从未包含它
    expect(await fs.readFile(outsideFile, "utf8")).toBe(secretContent);
  });

  it("② 用 `..` **逃逸**出工作区 ⇒ 拒绝", async () => {
    const escapingPath = path.join(workspaceRoot, "..", "outside", "secret.md");
    const secretContent = "escape-attempt";
    await fs.writeFile(path.join(outsideRoot, "secret.md"), secretContent, "utf8");

    await expect(port.readTextFile(escapingPath)).rejects.toThrow();
  });

  it("③ **写入**工作区外 ⇒ 拒绝，且**不得创建文件**", async () => {
    const outsideTarget = path.join(outsideRoot, "should-not-exist.md");

    await expect(port.writeTextFile(outsideTarget, "written")).rejects.toThrow();

    // 关键：拒绝要发生在写盘之前 ⇒ 文件不应存在
    await expect(fs.access(outsideTarget)).rejects.toThrow();
  });

  it("④ `ensureDirectory` 越界 ⇒ 拒绝，且**不得建目录**", async () => {
    const outsideDirectory = path.join(outsideRoot, "should-not-exist-dir");

    await expect(port.ensureDirectory(outsideDirectory)).rejects.toThrow();
    await expect(fs.access(outsideDirectory)).rejects.toThrow();
  });

  it("⑤ 工作区内的正常路径 ⇒ 放行（确认不是「一律拒绝」）", async () => {
    const insideFile = path.join(workspaceRoot, "docs", "note.md");

    await port.writeTextFile(insideFile, "hello");
    await expect(port.readTextFile(insideFile)).resolves.toBe("hello");
    await expect(port.fileExists(insideFile)).resolves.toBe(true);
    await expect(port.fileExists(path.join(workspaceRoot, "nope.md"))).resolves.toBe(false);
  });
});

describe("PROJECT-01-03：受控跨项目资源端口 —— 受保护存储必须被拒", () => {
  it("⑥ 读取**保管库**内文件 ⇒ 拒绝，且未读到内容", async () => {
    const vaultDirectory = path.join(workspaceRoot, ".astarray", "backup-vault");
    const vaultFile = path.join(vaultDirectory, "secret-backup.json");
    const secretContent = "vault-content-should-not-leak";
    await fs.mkdir(vaultDirectory, { recursive: true });
    await fs.writeFile(vaultFile, secretContent, "utf8");

    await expect(port.readTextFile(vaultFile)).rejects.toThrow();
    expect(await fs.readFile(vaultFile, "utf8")).toBe(secretContent);
  });

  it("⑦ 写入**保管库** ⇒ 拒绝，且不覆盖既有内容", async () => {
    const vaultDirectory = path.join(workspaceRoot, ".astarray", "backup-vault");
    const vaultFile = path.join(vaultDirectory, "secret-backup.json");
    const originalContent = "original-vault-bytes";
    await fs.mkdir(vaultDirectory, { recursive: true });
    await fs.writeFile(vaultFile, originalContent, "utf8");

    await expect(port.writeTextFile(vaultFile, "overwritten")).rejects.toThrow();
    // 关键：拒绝发生在写之前 ⇒ 原内容必须完好
    expect(await fs.readFile(vaultFile, "utf8")).toBe(originalContent);
  });

  it("⑧ 删除审计文件同样不得经该端口读取", async () => {
    const auditDirectory = path.join(workspaceRoot, ".astarray");
    const auditFile = path.join(auditDirectory, "backup-deletion-audit.jsonl");
    await fs.mkdir(auditDirectory, { recursive: true });
    await fs.writeFile(auditFile, '{"audit":"should-not-leak"}\n', "utf8");

    await expect(port.readTextFile(auditFile)).rejects.toThrow();
  });

  it("⑨ `fileExists` 对受保护路径也必须先判定（不得因「只查存在」而绕过策略）", async () => {
    const vaultDirectory = path.join(workspaceRoot, ".astarray", "backup-vault");
    await fs.mkdir(vaultDirectory, { recursive: true });

    await expect(port.fileExists(vaultDirectory)).rejects.toThrow();
  });
});
