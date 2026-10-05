/**
 * 行为反例（可操作性缺陷，2026-10-02）：
 *
 * `config provider register` 建条目时把 `verifiedAtIso` **固定写 null**
 * （`packages/tui/src/cli/provider-cli.ts` 的 registerProvider），因此：
 *  - 即便登记的支持等级是 `product-path-verified`（有实测证据），
 *    `describeConnectionStatus().isVerified` 仍为 **false**，`show` 显示"未验证"；
 *  - 唯一补救手段是**手工编辑状态目录里的 JSON**（本次真实验收后就不得不这么做）。
 *
 * 期望：登记时可显式给出验证时间；未给出时保持 null（不臆造）。
 * 本文件在修复前必须失败。
 */
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-provider-verified-"));
});

afterEach(async () => {
  try {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function runCli(cliArguments: string[], stdinText?: string): string {
  return execFileSync(process.execPath, [cliEntryPath, ...cliArguments], {
    cwd: stateDirectory,
    encoding: "utf8",
    input: stdinText,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("provider 登记：验证时间必须可由命令行给出", () => {
  it("① --verified-at 应写入 verifiedAtIso，并使 isVerified 为真", async () => {
    // 先准备受保护凭据引用（register 要求它已存在）。
    runCli(
      ["config", "provider", "credential-set"],
      '{"referenceId":"prov-test-1","baseUrl":"https://example.invalid/v1","apiKey":"test-key"}\n',
    );

    const verifiedAtIso = "2026-10-05T09:12:27.737Z";
    runCli([
      "config",
      "provider",
      "register",
      "test-provider",
      "--protocol",
      "generic-openai-compatible",
      "--api-version",
      "unversioned",
      "--capability",
      "text",
      "tool-calling",
      "--support-level",
      "product-path-verified",
      "--credential-reference",
      "prov-test-1",
      "--verified-at",
      verifiedAtIso,
    ]);

    const catalogText = readFileSync(
      path.join(stateDirectory, ".astarray", "providers", "provider-catalog.json"),
      "utf8",
    );
    const entries = JSON.parse(catalogText) as Array<{
      providerProfileId: string;
      verifiedAtIso: string | null;
    }>;
    const entry = entries.find((candidate) => candidate.providerProfileId === "test-provider");
    expect(entry).toBeDefined();
    expect(entry?.verifiedAtIso).toBe(verifiedAtIso);

    // show 必须报告为已验证。
    const showOutput = runCli(["config", "provider", "show", "test-provider"]);
    expect(showOutput).not.toContain("未验证");
    expect(showOutput).toContain(verifiedAtIso);
  });

  it("② 未给出 --verified-at 时保持 null（不臆造验证时间）", async () => {
    runCli(
      ["config", "provider", "credential-set"],
      '{"referenceId":"prov-test-2","baseUrl":"https://example.invalid/v1","apiKey":"test-key"}\n',
    );
    runCli([
      "config",
      "provider",
      "register",
      "unverified-provider",
      "--protocol",
      "generic-openai-compatible",
      "--api-version",
      "unversioned",
      "--capability",
      "text",
      "--support-level",
      "adapter-only",
      "--credential-reference",
      "prov-test-2",
    ]);
    const entries = JSON.parse(
      readFileSync(path.join(stateDirectory, ".astarray", "providers", "provider-catalog.json"), "utf8"),
    ) as Array<{ providerProfileId: string; verifiedAtIso: string | null }>;
    const entry = entries.find((candidate) => candidate.providerProfileId === "unverified-provider");
    expect(entry?.verifiedAtIso).toBeNull();
  });
});
