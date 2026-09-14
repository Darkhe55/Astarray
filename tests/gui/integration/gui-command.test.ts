/**
 * GUI-01-R-02 集成测试：astarray gui 公共入口真实启动本地服务并复用公共门面。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeGuiServeCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-cli-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("executeGuiServeCommand", () => {
  it("拒绝非法端口并返回用法错误码", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitCode = await executeGuiServeCommand({
      stateDirectory,
      port: 70_000,
      isBrowserOpenEnabled: false,
      shutdownSignal: Promise.resolve(),
    });
    expect(exitCode).toBe(2);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("端口无效");
  });

  it("启动真实 loopback 服务、打印 URL 并在关闭信号后收口", async () => {
    let releaseShutdown: () => void = () => {};
    const shutdownSignal = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    let printedUrl: string | undefined;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        const text = String(chunk);
        originalWrite(text);
        const match = /Astarray GUI 已启动：(http:\/\/[^\s（]+)/.exec(text);
        if (match?.[1] !== undefined && printedUrl === undefined) {
          printedUrl = match[1];
        }
        return true;
      });

    const commandPromise = executeGuiServeCommand({
      stateDirectory,
      port: 0,
      isBrowserOpenEnabled: false,
      shutdownSignal,
    });
    // 等到 URL 打印（服务已监听）后访问真实路由。
    const deadline = Date.now() + 15_000;
    while (printedUrl === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(printedUrl).toBeDefined();
    const stateUrl = new URL("state", printedUrl).toString();
    const response = await fetch(stateUrl);
    expect(response.status).toBe(200);
    const stateBody: unknown = await response.json();
    releaseShutdown();
    await expect(commandPromise).resolves.toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stateBody).toMatchObject({
      sessionId: "gui-session-local",
      mode: "assist",
      connectionStatus: "connected",
    });
    await expect(fetch(stateUrl)).rejects.toThrow();
  }, 60_000);
});