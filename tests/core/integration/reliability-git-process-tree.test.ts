/**
 * 行为反例（RELIABILITY-01-02 · R2，2026-10-02）：
 *
 * 审计（RELIABILITY-01-01 §疑点3）确认：`GitProcess` 超时只对**单个进程**发 SIGKILL，
 * 未做进程树/进程组收口 → 子进程派生的孙进程可能继续存活（残留句柄/继续写盘）。
 * 卡内要求："核查子进程树收口、退出确认、锁释放及远端结果对账；
 *          超时不能等同操作失败或停止成功。"
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";

vi.setConfig({ testTimeout: 60_000 });

let workingDirectoryPath: string;

beforeEach(async () => {
  workingDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-git-tree-"));
});

afterEach(async () => {
  try {
    await fs.rm(workingDirectoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

/** 孙进程心跳：每 50ms 追加一行；文件停止增长即表示孙进程已被收口。 */
/**
 * 夹具（父 + 孙）的最长存活时间。
 *
 * ## 为什么是 8 秒而不是 60 秒（2026-11-07，RELIABILITY-01-03）
 *
 * **实测复现的缺陷**：每次运行本文件都会**永久泄漏**一个 `astarray-git-tree-*` 临时目录。
 * 机制：用例 ⓪ 只等 **6s** 就把夹具丢下（`Promise.race` 的窗口），而夹具原本活 **60s**
 * ⇒ 孙进程作为孤儿继续持有该目录内的心跳文件句柄 ⇒ `afterEach` 的
 * `fs.rm(..., { force: true })` 在 Windows 上因**文件被占用**而失败
 * ⇒ 目录残留（`force` 只忽略 ENOENT，不忽略 EBUSY/EPERM）。
 * 已验证：文件跑完后**系统里已无任何 node 进程**（`Get-Process node` = 0），
 * 目录**依然存在** ⇒ 属**永久**残留，不是"等一会儿就好"。
 *
 * ⇒ 把最长存活压到 **8s**：两次用例都不需要夹具活得比这更久
 * （⓪ 只要求 6s 内写出 >3 行心跳；① 在 1s 超时后只再观测 ~2.2s），
 * 于是孤儿在 `afterEach` 之前（或至少很快）就自然退出，句柄释放、目录可回收。
 * **断言强度未变**：⓪ 仍是 `>3` 行，① 仍是"心跳停止增长"。
 */
const FIXTURE_MAXIMUM_LIFETIME_MILLISECONDS = 8_000;

function buildGrandchildHeartbeatScript(heartbeatPath: string): string {
  const escapedPath = heartbeatPath.replace(/\\/g, "\\\\");
  return [
    'const fs = require("node:fs");',
    "const timer = setInterval(() => {",
    `  try { fs.appendFileSync("${escapedPath}", "beat\\n"); } catch {}`,
    "}, 50);",
    "timer.unref?.();",
    `setTimeout(() => process.exit(0), ${String(FIXTURE_MAXIMUM_LIFETIME_MILLISECONDS)});`,
  ].join("\n");
}

function buildParentScript(heartbeatPath: string): string {
  return [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(buildGrandchildHeartbeatScript(heartbeatPath))}], { stdio: "ignore", windowsHide: true });`,
    "child.unref();",
    `setTimeout(() => process.exit(0), ${String(FIXTURE_MAXIMUM_LIFETIME_MILLISECONDS)});`,
  ].join("\n");
}

function countHeartbeatLines(heartbeatPath: string): number {
  if (!existsSync(heartbeatPath)) {
    return 0;
  }
  return readFileSync(heartbeatPath, "utf8").split("\n").filter((line) => line === "beat").length;
}

describe("GitProcess 超时的进程树收口（R2）", () => {
  it("⓪ 夹具活性：孙进程确实启动并在写心跳（否则本文件无判定力）", async () => {
    const heartbeatPath = path.join(workingDirectoryPath, "heartbeat-liveness.txt");
    const gitProcess = new GitProcess({
      gitCommandTimeoutSeconds: 30,
      executablePath: process.execPath,
      executableArgumentsPrefix: ["-e", buildParentScript(heartbeatPath)],
    });

    /**
     * 让夹具运行一段时间后主动放弃等待（不依赖超时），确认孙进程已写入心跳。
     *
     * **2026-10-10 修复（负载下的假失败）**：此前这个窗口是 **1.2s**，
     * 而本用例要求的是"**生成**一棵进程树（parent 再 spawn grandchild，各自启动一个
     * Node 运行时）并在窗口内写出 **>3** 行心跳（每 50ms 一行 ⇒ 至少 150ms）"。
     * 在全量并发（`npm run check`，几百个用例抢 CPU）下，仅 **Node 进程启动**
     * 就可能吃掉 1.2s 的大部分 ⇒ 心跳行数 <3 ⇒ **假失败**。
     * 孤立复跑该文件是 2/2 通过（⓪ 实际耗时约 4.1s，说明树生成确实慢），
     * 证实是**窗口预算不足**，不是产品缺陷、也不是本文件断言的缺陷。
     *
     * 故把活性窗口放宽到 **6s**：这只影响"是否给夹具足够时间**证明自己活着**"，
     * **不触及任何断言强度** —— `>3` 的门槛与 ① 的"心跳停止增长"判定都原样保留。
     *
     * **2026-11-07 修正（RELIABILITY-01-03，临时目录泄漏）**：上面这种"等 6s 就把夹具
     * **丢下不管**"的写法会让夹具继续存活到其上限，而**孤儿孙进程持有本临时目录内
     * 心跳文件的句柄** ⇒ `afterEach` 的 `fs.rm` 在 Windows 上失败 ⇒ **每次运行永久残留
     * 一个 `astarray-git-tree-*` 目录**（已实测复现）。
     * 现改为**等夹具自然结束**（其上限已压到 8s）：既仍然证明"孙进程确实在写心跳"，
     * 又保证用例结束时不留下任何持有句柄的进程。**断言强度不变**。
     */
    await gitProcess.run(workingDirectoryPath, [], "夹具命令（活性）").catch(() => null);
    expect(countHeartbeatLines(heartbeatPath)).toBeGreaterThan(3);
  });

  it("① 超时后孙进程必须被收口（心跳停止增长）", async () => {
    const heartbeatPath = path.join(workingDirectoryPath, "heartbeat.txt");
    const gitProcess = new GitProcess({
      gitCommandTimeoutSeconds: 1,
      executablePath: process.execPath,
      executableArgumentsPrefix: ["-e", buildParentScript(heartbeatPath)],
    });

    // 超时必须可区分（不得等同操作失败）。
    await expect(
      gitProcess.run(workingDirectoryPath, [], "夹具命令（超时用例）"),
    ).rejects.toThrow(/超时/);

    // 让孙进程有机会暴露：等待 1.5s 后统计心跳（若仍存活会继续增长）。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const firstCount = countHeartbeatLines(heartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const secondCount = countHeartbeatLines(heartbeatPath);

    expect(secondCount).toBe(firstCount);
  });
});
