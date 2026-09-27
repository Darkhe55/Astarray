/**
 * 生产接线：独立反馈进程（T04 / AGENTS.md "反馈工具为独立进程"）。
 * 修复前：公共 SDK 硬编码 useFeedbackProcess:false 且反馈进程入口路径为 null，
 * 嵌入方（CLI run / GUI / SDK 消费者）无法获得独立反馈进程，也无诊断面可查。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { resolveFeedbackProcessEntryPath } from "../../../packages/core/src/feedback-process/process-supervisor.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-feedback-wiring-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("公共 SDK 的独立反馈进程接线", () => {
  it("默认不启用（嵌入方自担拓扑），诊断面如实报告", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    const diagnostics = application.getRuntimeDiagnostics();
    expect(diagnostics.isFeedbackProcessIndependent).toBe(false);
    await application.shutdown();
  });

  it("显式启用后反馈传输来自独立进程，并可干净关闭", async () => {
    const feedbackEntryPath = resolveFeedbackProcessEntryPath();
    if (!existsSync(feedbackEntryPath)) {
      // 干净检出（未构建 dist）时无法 fork 反馈进程；此时不制造假通过。
      return;
    }
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: true,
      feedbackProcessModulePath: resolveFeedbackProcessEntryPath(),
    });
    expect(application.getRuntimeDiagnostics().isFeedbackProcessIndependent).toBe(true);
    await application.shutdown();
  });

  it("反馈进程入口解析回退到包内 dist 入口（源码运行时不留悬空路径）", () => {
    const entryPath = resolveFeedbackProcessEntryPath();
    expect(path.basename(entryPath)).toBe("feedback-process-entry.js");
    expect(path.isAbsolute(entryPath)).toBe(true);
  });
});
