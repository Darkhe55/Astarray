/**
 * NODECTX-01-03 反例（2026-10-10）：**长会话 + 多模型 + 重启**的无损性。
 *
 * 卡内检查点 03 明文：
 *  "**长会话多模型假服务、重启**与包级公共入口验收；展示 active/暂存/永久关闭/待追认及暂存原因……"
 * 测试重点（§2.5）："强制小窗口时**原文 hash 不变**；……低优先内容落盘**不丢原指令**……
 *  **跨 tokenizer 预算变化不截断**；工具调用与结果不拆散"。
 *
 * 现状缺口（本轮实测）：`createLosslessContextManager` 的可见性/已补回/振荡状态**只在内存**，
 * 暂存目录里只有原文，**没有索引** ⇒ 进程重启后：
 *  - 暂存的节点**无法恢复为 temporarily-closed**（会退回 active 或消失）；
 *  - 已补回的**幂等键**丢失 ⇒ 可能**重复注入**（卡内明令"防止重复注入与丢节点"）。
 *
 * 本片钉住的语义：
 *  - 暂存后**重启**（真实子进程退出 + 新进程重开）：状态与原文都必须**原样恢复**；
 *  - 原文 hash **逐字节不变**（无损，不允许任何摘要/截断）；
 *  - 已补回幂等键跨重启保持 ⇒ **不重复注入**；
 *  - 长会话多轮次（模拟多模型/多次预算变化）后，扫描到的原文 hash 集合**恒等**。
 *
 * 只跑本地临时目录与真实子进程；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLosslessContextManager } from "../../../packages/core/src/toolkit/lossless-context-manager.js";

let stateDirectory: string;
let stagingDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-nodectx03-"));
  stagingDirectory = path.join(stateDirectory, "staging");
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sha256Of(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

function buildNode(overrides: Record<string, unknown> = {}) {
  return {
    nodeIdentifier: "node-1",
    revision: 1,
    sourceKind: "agent" as const,
    priorityTier: 1,
    contentText: "原始正文",
    isUrgent: false,
    isImportant: false,
    isNeededForCurrentExecution: false,
    toolCallIdentifier: null,
    dependencyNodeIdentifiers: [],
    ...overrides,
  };
}

/** 从磁盘**直接**读取所有暂存原文（绕过管理器，作为独立核对口径）。 */
async function readAllStagedRawContents(): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  let fileNameList: string[];
  try {
    fileNameList = await fs.readdir(stagingDirectory);
  } catch {
    return contents;
  }
  for (const fileName of fileNameList) {
    if (!fileName.endsWith(".txt")) {
      continue;
    }
    contents.set(fileName, await fs.readFile(path.join(stagingDirectory, fileName), "utf8"));
  }
  return contents;
}

describe("NODECTX-01-03：暂存状态必须能跨重启恢复", () => {
  it("① 同进程内重建管理器：状态与原文必须恢复（不得丢节点）", async () => {
    const firstManager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    const node = buildNode({ contentText: "需要跨重启保留的正文" });
    const stageOutcome = await firstManager.stageNode(node);
    expect(stageOutcome.isStaged).toBe(true);

    /**
     * 模拟重启：**全新**管理器对象，指向同一状态目录
     * （不共享任何内存状态）。
     */
    const restartedManager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    const restoreOutcome = await restartedManager.restoreFromDisk();

    expect(restoreOutcome.isRestored).toBe(true);
    expect(restoreOutcome.restoredNodeCount).toBe(1);
    // 可见性必须恢复为"暂存"，而不是悄悄变成 active 或消失
    expect(restartedManager.getVisibilityState("node-1")).toBe("temporarily-closed");
    // 原文必须**逐字节**可读
    expect(await restartedManager.readStagedContent("node-1")).toBe("需要跨重启保留的正文");
  });

  it("② 已补回的幂等键必须跨重启保持 ⇒ 不得重复注入", async () => {
    const firstManager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    await firstManager.stageNode(buildNode());
    const firstReclaim = await firstManager.reclaimAtSafetyPoint();
    expect(firstReclaim.reclaimedNodeIdentifiers).toEqual(["node-1"]);

    const restartedManager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    await restartedManager.restoreFromDisk();
    /**
     * 重启后再次在安全点触发：该节点已是 active，**不得**再次注入；
     * 且已补回键必须已被恢复（否则会被当成新节点重复补回）。
     */
    const secondReclaim = await restartedManager.reclaimAtSafetyPoint();
    expect(secondReclaim.reclaimedNodeIdentifiers).toEqual([]);
    expect(restartedManager.getVisibilityState("node-1")).toBe("active");
  });

  it("③ 真实跨进程重启：子进程暂存后退出，父进程重开必须恢复", async () => {
    const scriptDirectory = path.resolve(".tmp", "nodectx03-restart");
    await fs.mkdir(scriptDirectory, { recursive: true });
    const scriptPath = path.join(scriptDirectory, "stage-then-exit.mjs");
    await fs.writeFile(
      scriptPath,
      `
import { createLosslessContextManager } from __SDK_MODULE_URL__;
const stagingDirectory = process.argv[2];
const manager = createLosslessContextManager({ stagingDirectory, maximumMigrationsPerRound: 4 });
const outcome = await manager.stageNode({
  nodeIdentifier: "node-child",
  revision: 3,
  sourceKind: "agent",
  priorityTier: 2,
  contentText: "子进程写入的原文",
  isUrgent: false,
  isImportant: false,
  isNeededForCurrentExecution: false,
  toolCallIdentifier: null,
  dependencyNodeIdentifiers: [],
});
process.stdout.write(outcome.isStaged ? "STAGED\\n" : "FAILED\\n");
// 不做任何优雅收尾：模拟进程结束（状态必须已经在磁盘上）
process.exit(0);
`.replace(
        "__SDK_MODULE_URL__",
        JSON.stringify(pathToFileURL(path.resolve("dist/public-sdk.js")).href),
      ),
      "utf8",
    );

    const childExitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [scriptPath, stagingDirectory], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      });
      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
      });
      child.on("close", (code) => {
        expect(stdoutBuffer).toContain("STAGED");
        resolve(code ?? 1);
      });
    });
    expect(childExitCode).toBe(0);

    // 父进程：全新管理器，仅凭磁盘恢复
    const parentManager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    const restoreOutcome = await parentManager.restoreFromDisk();
    expect(restoreOutcome.isRestored).toBe(true);
    expect(parentManager.getVisibilityState("node-child")).toBe("temporarily-closed");
    expect(await parentManager.readStagedContent("node-child")).toBe("子进程写入的原文");
  });
});

describe("NODECTX-01-03：长会话多轮次（模拟多模型/预算变化）无损性", () => {
  it("④ 多轮暂存/补回/重启后，原文 hash 集合**恒等**（跨预算变化不截断）", async () => {
    const originalContents = [
      "第一段原文（模型 A 小窗口期间）",
      "第二段原文（切换到模型 B）",
      "第三段原文（切回模型 A）",
    ];
    /** 独立口径：暂存前记录原文 hash。 */
    const expectedHashByNodeIdentifier = new Map<string, string>();
    originalContents.forEach((contentText, index) => {
      expectedHashByNodeIdentifier.set("node-" + String(index + 1), sha256Of(contentText));
    });

    const manager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 8,
    });

    // 第一轮：全部暂存（模拟窗口收紧）
    for (let index = 0; index < originalContents.length; index += 1) {
      const outcome = await manager.stageNode(
        buildNode({
          nodeIdentifier: "node-" + String(index + 1),
          contentText: originalContents[index],
        }),
      );
      expect(outcome.isStaged).toBe(true);
    }

    // 第二轮：重启（模拟切换模型/进程更替）
    const restartedManager = createLosslessContextManager({
      stagingDirectory,
      maximumMigrationsPerRound: 8,
    });
    await restartedManager.restoreFromDisk();

    // 第三轮：全部补回（模拟窗口放宽）
    const reclaimOutcome = await restartedManager.reclaimAtSafetyPoint();
    expect(reclaimOutcome.reclaimedNodeIdentifiers).toHaveLength(3);

    // 第四轮：再次全部暂存（模拟窗口再次收紧，多轮往复）
    for (let index = 0; index < originalContents.length; index += 1) {
      await restartedManager.stageNode(
        buildNode({
          nodeIdentifier: "node-" + String(index + 1),
          contentText: originalContents[index],
        }),
      );
    }

    /**
     * 核对：磁盘上每一份暂存原文的 hash 必须与**最初**记录的一致
     * ⇒ 没有任何摘要替代、截断或改写。
     */
    const stagedContents = await readAllStagedRawContents();
    expect(stagedContents.size).toBe(3);
    for (let index = 0; index < originalContents.length; index += 1) {
      const nodeIdentifier = "node-" + String(index + 1);
      const stagedText = await restartedManager.readStagedContent(nodeIdentifier);
      expect(stagedText).toBe(originalContents[index]);
      expect(sha256Of(String(stagedText))).toBe(
        expectedHashByNodeIdentifier.get(nodeIdentifier),
      );
    }
  });
});
