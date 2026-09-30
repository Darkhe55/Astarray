/**
 * 反例（GUI/MCP 入口运行时选择验收面）：
 * `gui` 与 `mcp serve` 必须能把「本次实际选中的运行时」写到诊断报告，
 * 供 tarball 级安装验收断言受保护凭据引用真的被选用（而不是只断言 help 文本）。
 *
 * 本文件在实现 `--runtime-diagnostics-file` 之前必须失败。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 与 run-provider-entry 一致：provider 运行会启动独立反馈进程，放宽超时预算。
vi.setConfig({ testTimeout: 60_000 });

import { FileProviderCredentialStore } from "../../../packages/tui/src/cli/provider-cli.js";
import { writeRuntimeDiagnosticsReport } from "../../../packages/tui/src/cli/runtime-diagnostics-report.js";
import {
  executeGuiServeCommand,
  executeMcpServeCommand,
} from "../../../packages/tui/src/cli/commands.js";

class ProcessExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super("process.exit:" + exitCode);
  }
}

let stateDirectory: string;
let server: http.Server | null = null;
let requestCount = 0;
let stderrBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-runtime-diagnostics-"),
  );
  requestCount = 0;
  stderrBuffer = [];
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
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
                delta: { content: "本地协议服务器完成。\n" },
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

async function readDiagnosticsReport(reportFilePath: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const rawContent = await fs.readFile(reportFilePath, "utf8");
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      if (parsed["entryRuntimeKind"] !== undefined) {
        return parsed;
      }
    } catch {
      // 报告尚未写入：继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("运行时诊断报告未在期限内写入: " + reportFilePath);
}

describe("三入口运行时选择诊断报告", () => {
  it("mcp serve：受保护凭据引用被选用 → 报告 runtimeKind=provider 且记录引用 ID", async () => {
    const endpoint = await startLocalProtocolServer();
    const credentialStore = new FileProviderCredentialStore(stateDirectory);
    await credentialStore.writeCredential({
      referenceId: "cred-ref-mcp",
      baseUrl: endpoint,
      apiKey: "protected-secret-key",
    });
    const diagnosticsFilePath = path.join(stateDirectory, "mcp-runtime-diagnostics.json");
    // stdio 服务器为前台进程：报告写入后关闭 stdin（EOF），驱动其正常收口。
    const servePromise = executeMcpServeCommand({
      stateDirectory,
      runtime: "openai-compatible",
      providerModelIdentifier: "fake-model",
      providerCredentialReference: "cred-ref-mcp",
      runtimeDiagnosticsFilePath: diagnosticsFilePath,
    });
    let report: Record<string, unknown>;
    try {
      report = await readDiagnosticsReport(diagnosticsFilePath);
    } finally {
      process.stdin.push(null);
    }
    await expect(servePromise).resolves.toBe(0);
    expect(report["entryRuntimeKind"]).toBe("provider");
    expect(report["providerId"]).toBe("openai-compatible");
    expect(report["modelIdentifier"]).toBe("fake-model");
    expect(report["protectedCredentialReferenceId"]).toBe("cred-ref-mcp");
    expect((report["runtimeDiagnostics"] as Record<string, unknown>)["runtimeKind"]).toBe(
      "provider",
    );
    // 报告是公开诊断面：不得包含凭据值或端点内联 secret。
    expect(JSON.stringify(report)).not.toContain("protected-secret-key");
    expect(requestCount).toBe(0);
  });

  it("gui：受保护凭据引用被选用 → 报告 runtimeKind=provider", async () => {
    const endpoint = await startLocalProtocolServer();
    const credentialStore = new FileProviderCredentialStore(stateDirectory);
    await credentialStore.writeCredential({
      referenceId: "cred-ref-gui",
      baseUrl: endpoint,
      apiKey: "protected-secret-key",
    });
    const diagnosticsFilePath = path.join(stateDirectory, "gui-runtime-diagnostics.json");
    const exitCode = await executeGuiServeCommand({
      stateDirectory,
      port: 0,
      isBrowserOpenEnabled: false,
      shutdownSignal: Promise.resolve(),
      runtime: "openai-compatible",
      providerModelIdentifier: "fake-model",
      providerCredentialReference: "cred-ref-gui",
      runtimeDiagnosticsFilePath: diagnosticsFilePath,
    });
    expect(exitCode).toBe(0);
    const report = await readDiagnosticsReport(diagnosticsFilePath);
    expect(report["entryRuntimeKind"]).toBe("provider");
    expect(report["protectedCredentialReferenceId"]).toBe("cred-ref-gui");
    expect((report["runtimeDiagnostics"] as Record<string, unknown>)["runtimeKind"]).toBe(
      "provider",
    );
    expect(JSON.stringify(report)).not.toContain("protected-secret-key");
  });

  it("gui：未指定运行时 → 报告 mock（离线默认，不误报 provider）", async () => {
    const diagnosticsFilePath = path.join(stateDirectory, "gui-mock-runtime-diagnostics.json");
    const exitCode = await executeGuiServeCommand({
      stateDirectory,
      port: 0,
      isBrowserOpenEnabled: false,
      shutdownSignal: Promise.resolve(),
      runtimeDiagnosticsFilePath: diagnosticsFilePath,
    });
    expect(exitCode).toBe(0);
    const report = await readDiagnosticsReport(diagnosticsFilePath);
    expect(report["entryRuntimeKind"]).toBe("mock");
    expect(report["providerId"]).toBeNull();
    expect((report["runtimeDiagnostics"] as Record<string, unknown>)["runtimeKind"]).toBe("mock");
  });

  it("gui：受保护凭据引用缺失 → 退出码 2，且不写报告（不回退 mock）", async () => {
    const diagnosticsFilePath = path.join(stateDirectory, "gui-missing-runtime-diagnostics.json");
    await expect(
      executeGuiServeCommand({
        stateDirectory,
        port: 0,
        isBrowserOpenEnabled: false,
        shutdownSignal: Promise.resolve(),
        runtime: "openai-compatible",
        providerModelIdentifier: "fake-model",
        providerCredentialReference: "missing-ref",
        runtimeDiagnosticsFilePath: diagnosticsFilePath,
      }),
    ).rejects.toThrow("process.exit:2");
    expect(stderrBuffer.join("")).toContain("受保护凭据引用不存在");
    await expect(fs.access(diagnosticsFilePath)).rejects.toThrow();
  });

  it("报告覆盖前自动备份为 .bak，且不给报告路径时不产生副作用", async () => {
    const diagnosticsFilePath = path.join(stateDirectory, "runtime-diagnostics-backup.json");
    const fakeApplication = {
      getRuntimeDiagnostics: () => ({
        runtimeKind: "mock" as const,
        isFeedbackProcessIndependent: false,
        authenticatedUserSource: "host" as const,
        mainAgentInstanceId: "main-agent-test",
      }),
    };
    const reportOptions = {
      reportFilePath: diagnosticsFilePath,
      runtimeKind: "mock" as const,
      providerId: null,
      modelIdentifier: null,
      protectedCredentialReferenceId: null,
      application: fakeApplication,
    };
    await writeRuntimeDiagnosticsReport(reportOptions);
    const firstReport = await readDiagnosticsReport(diagnosticsFilePath);
    expect(firstReport["reportVersion"]).toBe("RUNTIME_SELECTION_DIAGNOSTICS_V1");
    await expect(fs.access(diagnosticsFilePath + ".bak")).rejects.toThrow();
    await writeRuntimeDiagnosticsReport(reportOptions);
    const backupContent = JSON.parse(
      await fs.readFile(diagnosticsFilePath + ".bak", "utf8"),
    ) as Record<string, unknown>;
    expect(backupContent["reportedAtIso"]).toBe(firstReport["reportedAtIso"]);

    // 未给路径 → 不写任何文件（不产生副作用）。
    await writeRuntimeDiagnosticsReport({ ...reportOptions, reportFilePath: undefined });
    await expect(
      writeRuntimeDiagnosticsReport({ ...reportOptions, reportFilePath: "" }),
    ).resolves.toBeUndefined();
  });
});
