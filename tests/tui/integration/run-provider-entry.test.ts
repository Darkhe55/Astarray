/**
 * E2E-01-02 切片测试：run --runtime openai-compatible 从公共入口连通本地协议服务器。
 * 验收：真实 HTTP 请求驱动任务到 done；缺端点/模型必须 fail-closed（不回退 mock）。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeRunCommand } from "../../../packages/tui/src/cli/run-command.js";

class ProcessExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super("process.exit:" + exitCode);
  }
}

let stateDirectory: string;
let server: http.Server | null = null;
let requestCount = 0;
let stdoutBuffer: string[];
let stderrBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-e2e01-provider-"));
  requestCount = 0;
  stdoutBuffer = [];
  stderrBuffer = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrBuffer.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code ?? 0);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function startLocalProtocolServer(): Promise<string> {
  const completionMarkerLine =
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:local-server",
      completionAttemptId: "attempt-local-1",
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    });
  server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      response.write(
        "data: " +
          JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }) +
          "\n\n",
      );
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: { content: "本地协议服务器完成。\n" + completionMarkerLine },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\n",
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

describe("run --runtime openai-compatible（本地协议服务器）", () => {
  it("真实 HTTP 请求驱动任务到 done，且 stdout 仅 JSON", async () => {
    const endpoint = await startLocalProtocolServer();
    const exitCode = await executeRunCommand({
      prompt: "本地协议服务器纵向探针",
      mode: "assist",
      runtime: "openai-compatible",
      isJsonOutput: true,
      stateDirectory,
      providerEndpoint: endpoint,
      providerModelIdentifier: "fake-model",
      timeoutSeconds: 60,
    });
    expect(exitCode).toBe(0);
    expect(requestCount).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(stdoutBuffer.join("")) as {
      status: string;
      mode: string;
      missionId: string;
    };
    expect(parsed.status).toBe("done");
    expect(parsed.mode).toBe("assist");
    expect(parsed.missionId).toMatch(/^mission-/);
  });

  it("缺少 --provider-endpoint 时 fail-closed（退出码 2，不回退 mock）", async () => {
    await expect(
      executeRunCommand({
        prompt: "缺少端点",
        mode: "assist",
        runtime: "openai-compatible",
        isJsonOutput: true,
        stateDirectory,
        providerModelIdentifier: "fake-model",
      }),
    ).rejects.toThrow("process.exit:2");
    expect(stderrBuffer.join("")).toContain("provider-endpoint");
    expect(stdoutBuffer.join("")).toBe("");
  });

  it("缺少 --provider-model 时 fail-closed（退出码 2）", async () => {
    const endpoint = await startLocalProtocolServer();
    await expect(
      executeRunCommand({
        prompt: "缺少模型",
        mode: "assist",
        runtime: "openai-compatible",
        isJsonOutput: true,
        stateDirectory,
        providerEndpoint: endpoint,
      }),
    ).rejects.toThrow("process.exit:2");
    expect(stderrBuffer.join("")).toContain("provider-model");
  });
});
