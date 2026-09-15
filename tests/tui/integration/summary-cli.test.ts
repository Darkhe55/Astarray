/**
 * SUM-01-04b 集成测试：摘要 CLI（list/build/show）经公共门面接线，状态诚实。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeSummaryBuildCommand,
  executeSummaryListCommand,
  executeSummaryShowCommand,
} from "../../../packages/tui/src/cli/commands.js";
import { executeRunCommand } from "../../../packages/tui/src/cli/run-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-summary-cli-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    },
  );
  return { getOutput: () => chunks.join("") };
}

async function runMockMission(): Promise<string> {
  const runCapture = captureStdout();
  const exitCode = await executeRunCommand({
    prompt: "摘要 CLI 联测任务",
    mode: "assist",
    runtime: "mock",
    isJsonOutput: true,
    stateDirectory,
  });
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(runCapture.getOutput()) as { missionId: string };
  return parsed.missionId;
}

describe("SUM-01-04b 摘要 CLI", () => {
  it("无来源时 list 状态诚实为 no-summary（退出码 1）", async () => {
    const capture = captureStdout();
    const exitCode = await executeSummaryListCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(capture.getOutput())).toMatchObject({ status: "no-summary" });
  });

  it("build 从真实 mission 存档生成摘要，list/show 可读取与展开", async () => {
    const missionId = await runMockMission();

    const buildCapture = captureStdout();
    const buildExitCode = await executeSummaryBuildCommand({
      stateDirectory,
      missionId,
      isJsonOutput: true,
    });
    expect(buildExitCode).toBe(0);
    const build = JSON.parse(buildCapture.getOutput()) as {
      status: string;
      chunkCount: number;
      generatorVersion: string;
    };
    expect(build.status).toBe("ok");
    expect(build.chunkCount).toBeGreaterThan(0);
    expect(build.generatorVersion).toBe("local-extractive-1");

    const listCapture = captureStdout();
    const listExitCode = await executeSummaryListCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(listExitCode).toBe(0);
    const list = JSON.parse(listCapture.getOutput()) as {
      status: string;
      sources: Array<{ sourceIdentifier: string; chunkCount: number }>;
    };
    expect(list.status).toBe("ok");
    expect(list.sources[0]?.sourceIdentifier).toBe(missionId);

    const showCapture = captureStdout();
    const showExitCode = await executeSummaryShowCommand({
      stateDirectory,
      sourceIdentifier: missionId,
      detailLevel: "section",
      pageSize: 2,
      chunkIdentifier: undefined,
      maximumReturnUnitCount: undefined,
      isJsonOutput: true,
    });
    expect(showExitCode).toBe(0);
    const show = JSON.parse(showCapture.getOutput()) as {
      status: string;
      view: {
        chunks: Array<{ chunkIdentifier: string; excerpt: string }>;
        coverage: { chunkCount: number };
        resourceMetrics: { manifestFileBytes: number; sourceAccessCount: number };
        isReturnBounded: boolean;
      };
    };
    expect(show.status).toBe("ok");
    expect(show.view.chunks.length).toBeGreaterThan(0);
    expect(show.view.resourceMetrics.manifestFileBytes).toBeGreaterThan(0);
    expect(show.view.resourceMetrics.sourceAccessCount).toBe(0);

    const sectionCapture = captureStdout();
    const sectionExitCode = await executeSummaryShowCommand({
      stateDirectory,
      sourceIdentifier: missionId,
      detailLevel: "section",
      pageSize: 10,
      chunkIdentifier: show.view.chunks[0]!.chunkIdentifier,
      maximumReturnUnitCount: undefined,
      isJsonOutput: true,
    });
    expect(sectionExitCode).toBe(0);
    const section = JSON.parse(sectionCapture.getOutput()) as {
      status: string;
      section: {
        excerpt: string;
        evidencePointers: Array<{ sourceIdentifier: string }>;
      };
    };
    expect(section.status).toBe("ok");
    expect(section.section.evidencePointers[0]?.sourceIdentifier).toContain("#");

    // 资源不足：只裁剪本次返回，覆盖率不变。
    const boundedCapture = captureStdout();
    const boundedExitCode = await executeSummaryShowCommand({
      stateDirectory,
      sourceIdentifier: missionId,
      detailLevel: "detail",
      pageSize: show.view.coverage.chunkCount,
      chunkIdentifier: undefined,
      maximumReturnUnitCount: 1,
      isJsonOutput: true,
    });
    expect(boundedExitCode).toBe(0);
    const bounded = JSON.parse(boundedCapture.getOutput()) as {
      view: {
        isReturnBounded: boolean;
        returnedUnitCount: number;
        coverage: { chunkCount: number };
      };
    };
    expect(bounded.view.isReturnBounded).toBe(true);
    expect(bounded.view.returnedUnitCount).toBeLessThanOrEqual(1);
    expect(bounded.view.coverage.chunkCount).toBe(show.view.coverage.chunkCount);

    const missingCapture = captureStdout();
    const missingExitCode = await executeSummaryShowCommand({
      stateDirectory,
      sourceIdentifier: "mission-does-not-exist",
      detailLevel: "summary",
      pageSize: 10,
      chunkIdentifier: undefined,
      maximumReturnUnitCount: undefined,
      isJsonOutput: true,
    });
    expect(missingExitCode).toBe(1);
    expect(JSON.parse(missingCapture.getOutput())).toMatchObject({
      status: "summary-not-found",
    });
  }, 60_000);
});
