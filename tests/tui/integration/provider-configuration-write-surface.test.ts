/**
 * 反例（`config provider` 写入面）：受保护凭据引用必须能从公共 CLI 面**写入**，
 * 且 API key 只能经 STDIN 输入——绝不经过命令行参数、环境变量、日志或回显。
 *
 * 本文件在 `config provider credential-set` / `config provider register`
 * 实现之前必须失败（命令不存在、写入面缺失）。
 */
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../../../packages/tui/src/cli/json-output.js";
import {
  executeDoctorProviderCommand,
  executeProviderCredentialSetCommand,
  executeProviderListCommand,
  executeProviderRegisterCommand,
} from "../../../packages/tui/src/cli/commands.js";
import {
  FileProviderCredentialStore,
  ProviderCliCatalog,
} from "../../../packages/tui/src/cli/provider-cli.js";

let stateDirectory: string;
let stdoutBuffer: string[];
let stderrBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-provider-write-"));
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function stdinFromText(text: string): PassThrough {
  const stdinStream = new PassThrough();
  stdinStream.end(text);
  return stdinStream;
}

const SECRET_API_KEY = "sk-live-must-not-leak-9f3a2b";

function credentialPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    referenceId: "cred-ref-write-1",
    baseUrl: "https://provider.example.com/v1/chat/completions?tenant=secret-tenant",
    apiKey: SECRET_API_KEY,
    ...overrides,
  });
}

describe("config provider credential-set（受保护凭据写入）", () => {
  it("STDIN JSON → 凭据落盘且可被 store 读回；输出只含引用 ID，不回显 key/baseUrl 细节", async () => {
    const exitCode = await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText(credentialPayload()),
      isJsonOutput: true,
    });
    expect(exitCode).toBe(EXIT_CODES.SUCCESS);

    const store = new FileProviderCredentialStore(stateDirectory);
    expect(await store.doesReferenceExist("cred-ref-write-1")).toBe(true);
    const stored = await store.readCredential("cred-ref-write-1");
    expect(stored?.apiKey).toBe(SECRET_API_KEY);

    const output = stdoutBuffer.join("") + stderrBuffer.join("");
    expect(output).toContain("cred-ref-write-1");
    // 公开面纪律：不得出现凭据值、查询串或内联 secret。
    expect(output).not.toContain(SECRET_API_KEY);
    expect(output).not.toContain("secret-tenant");
    expect(output).not.toContain("tenant=");
    const parsed = JSON.parse(stdoutBuffer.join("")) as Record<string, unknown>;
    expect(parsed["apiKeyPresent"]).toBe(true);
    expect(parsed["endpointHost"]).toBe("provider.example.com");
    expect(JSON.stringify(parsed)).not.toContain(SECRET_API_KEY);
  });

  it("非法 STDIN（缺字段 / 非 JSON）→ 退出码 2，且不写入任何凭据", async () => {
    const missingKeyExitCode = await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText(credentialPayload({ baseUrl: "" })),
      isJsonOutput: true,
    });
    expect(missingKeyExitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(stderrBuffer.join("")).toContain("baseUrl");

    stderrBuffer = [];
    const malformedExitCode = await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText("{ 不是 JSON"),
      isJsonOutput: true,
    });
    expect(malformedExitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(stderrBuffer.join("")).toContain("JSON");

    const store = new FileProviderCredentialStore(stateDirectory);
    expect(await store.listReferenceIds()).toEqual([]);
    // 非法输入不得回显原文（可能含 secret 片段）。
    expect(stdoutBuffer.join("") + stderrBuffer.join("")).not.toContain("不是 JSON");
  });

  it("覆盖既有引用前自动备份为 .bak（可追溯旧值），且不留 .tmp 残留", async () => {
    await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText(credentialPayload()),
      isJsonOutput: false,
    });
    stdoutBuffer = [];
    await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText(credentialPayload({ apiKey: "sk-rotated-0001" })),
      isJsonOutput: false,
    });
    const credentialFilePath = path.join(
      stateDirectory,
      "providers",
      "provider-credentials.json",
    );
    const backupRawContent = await fs.readFile(credentialFilePath + ".bak", "utf8");
    expect(backupRawContent).toContain(SECRET_API_KEY);
    const directoryEntries = await fs.readdir(path.dirname(credentialFilePath));
    expect(directoryEntries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    // 旧值只在受控备份中保留，公开输出不含。
    expect(stdoutBuffer.join("")).not.toContain(SECRET_API_KEY);
  });

  it("STDIN 超长（>64KiB）→ 退出码 2 拒绝，不落盘", async () => {
    const exitCode = await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText(
        credentialPayload({ apiKey: "k".repeat(70 * 1024) }),
      ),
      isJsonOutput: true,
    });
    expect(exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(stderrBuffer.join("")).toContain("过大");
    const store = new FileProviderCredentialStore(stateDirectory);
    expect(await store.listReferenceIds()).toEqual([]);
  });
});

describe("config provider register（凭据引用登记）", () => {
  async function writeReference(referenceId: string): Promise<void> {
    const store = new FileProviderCredentialStore(stateDirectory);
    await store.writeCredential({
      referenceId,
      baseUrl: "https://provider.example.com/v1/chat/completions",
      apiKey: SECRET_API_KEY,
    });
  }

  it("登记引用已存在的 Provider → 目录可读，输出只含引用 ID（无凭据值）", async () => {
    await writeReference("cred-ref-write-1");
    const exitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "demo-provider",
      protocolName: "generic-openai-compatible",
      apiVersion: "2024-06-01",
      capabilityNames: ["text", "tool-calling"],
      supportLevel: "adapter-only",
      protectedCredentialReferenceId: "cred-ref-write-1",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    const catalog = new ProviderCliCatalog(stateDirectory);
    const registration = await catalog.getRegistration("demo-provider");
    expect(registration?.protectedCredentialReferenceId).toBe("cred-ref-write-1");

    // 机器可读面复用公开 DTO：**不含**凭据引用、更不含凭据值。
    const jsonOutput = stdoutBuffer.join("");
    expect(jsonOutput).toContain("demo-provider");
    expect(jsonOutput).toContain("adapter-only");
    expect(jsonOutput).not.toContain("cred-ref-write-1");
    expect(jsonOutput).not.toContain(SECRET_API_KEY);

    // 人读面（本地终端）才显示受保护引用 ID；仍绝不显示凭据值。
    stdoutBuffer = [];
    const humanExitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "demo-provider",
      protocolName: "generic-openai-compatible",
      apiVersion: "2024-06-01",
      capabilityNames: ["text", "tool-calling"],
      supportLevel: "adapter-only",
      protectedCredentialReferenceId: "cred-ref-write-1",
      isJsonOutput: false,
    });
    expect(humanExitCode).toBe(EXIT_CODES.SUCCESS);
    const humanOutput = stdoutBuffer.join("");
    expect(humanOutput).toContain("凭据引用: cred-ref-write-1");
    expect(humanOutput).not.toContain(SECRET_API_KEY);
    expect(stdoutBuffer.join("") + stderrBuffer.join("")).not.toContain(SECRET_API_KEY);
  });

  it("引用不存在 → 退出码 2（fail-closed），不登记；不支持的 supportLevel 亦拒绝", async () => {
    const missingReferenceExitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "ghost-provider",
      protocolName: "generic-openai-compatible",
      apiVersion: "2024-06-01",
      capabilityNames: ["text"],
      supportLevel: "adapter-only",
      protectedCredentialReferenceId: "cred-ref-missing",
      isJsonOutput: true,
    });
    expect(missingReferenceExitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(stderrBuffer.join("")).toContain("受保护凭据引用不存在");
    const catalog = new ProviderCliCatalog(stateDirectory);
    expect(await catalog.getRegistration("ghost-provider")).toBeNull();

    await writeReference("cred-ref-write-1");
    stderrBuffer = [];
    const badSupportLevelExitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "demo-provider",
      protocolName: "generic-openai-compatible",
      apiVersion: "2024-06-01",
      capabilityNames: ["text"],
      supportLevel: "totally-verified",
      protectedCredentialReferenceId: "cred-ref-write-1",
      isJsonOutput: true,
    });
    expect(badSupportLevelExitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(stderrBuffer.join("")).toContain("support-level");
    expect(await catalog.getRegistration("demo-provider")).toBeNull();
  });

  it("写入 → 登记 → 读取闭环：doctor --provider 报告引用已解析，且无凭据泄漏", async () => {
    // 只用公共写入面：STDIN 写引用 + register 入目录（不手工写凭据文件）。
    const credentialSetExitCode = await executeProviderCredentialSetCommand({
      stateDirectory,
      stdinStream: stdinFromText(
        JSON.stringify({
          referenceId: "cred-ref-loop",
          baseUrl: "https://loop.example.com/v1/chat/completions",
          apiKey: SECRET_API_KEY,
        }),
      ),
      isJsonOutput: false,
    });
    expect(credentialSetExitCode).toBe(EXIT_CODES.SUCCESS);
    const registerExitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "loop-provider",
      protocolName: "generic-openai-compatible",
      apiVersion: "2024-06-01",
      capabilityNames: ["text"],
      supportLevel: "fake-server-conformant",
      protectedCredentialReferenceId: "cred-ref-loop",
      isJsonOutput: false,
    });
    expect(registerExitCode).toBe(EXIT_CODES.SUCCESS);

    stdoutBuffer = [];
    const listExitCode = await executeProviderListCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(listExitCode).toBe(EXIT_CODES.SUCCESS);
    expect(stdoutBuffer.join("")).toContain("loop-provider");

    stdoutBuffer = [];
    const doctorExitCode = await executeDoctorProviderCommand({
      stateDirectory,
      providerProfileId: "loop-provider",
      isJsonOutput: true,
    });
    expect(doctorExitCode).toBe(EXIT_CODES.SUCCESS);
    const doctorReport = JSON.parse(stdoutBuffer.join("")) as Record<string, unknown>;
    expect(doctorReport["credentialReferenceResolved"]).toBe(true);
    expect(doctorReport["supportLevel"]).toBe("fake-server-conformant");
    expect(JSON.stringify(doctorReport)).not.toContain(SECRET_API_KEY);
  });
});
