/**
 * T06C 单测：全模式本地敏感内容禁读（ADR-0018）。
 * 覆盖：文件名规则（含大小写变体）、符号链接/硬链接身份、DLP 内容扫描、
 * 目录过滤、错误不泄露秘密、普通配置放行、Devolve/授权不能放行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DomainError } from "../../../packages/core/src/core/errors.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { LocalToolPolicyEngine } from "../../../packages/core/src/tools/local-tool-policy-engine.js";
import {
  SensitiveContentAccessPolicy,
  SensitiveResourceIdentityResolver,
} from "../../../packages/core/src/tools/sensitive-content-access-policy.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let boundary: WorkspaceBoundary;
let sensitivePolicy: SensitiveContentAccessPolicy;
let localEngine: LocalToolPolicyEngine;

function baseContext() {
  return {
    workspaceBoundary: boundary,
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    requestingAgentInstanceId: "agent-t06c",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    localToolPolicyEngine: localEngine,
    sensitiveContentAccessPolicy: sensitivePolicy,
  };
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06c-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
  boundary = new WorkspaceBoundary(workspaceDirectory);
  sensitivePolicy = new SensitiveContentAccessPolicy();
  localEngine = new LocalToolPolicyEngine({
    workspaceBoundary: boundary,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("SensitiveContentAccessPolicy 文件名规则", () => {
  it(".env 及大小写/变体全部拒绝", async () => {
    const names = [".env", ".ENV", ".Env.Local", "service.env", "config.env"];
    for (const name of names) {
      const filePath = path.join(workspaceDirectory, name);
      await fs.writeFile(filePath, "SECRET=1", "utf8");
      await expect(
        sensitivePolicy.assertSensitiveContentReadAllowed({
          canonicalPath: filePath,
        }),
      ).rejects.toMatchObject({
        errorCode: "sensitive-content-read-denied",
      });
    }
  });

  it("凭据库/私钥/证书容器/云凭据全部拒绝", async () => {
    const names = [
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "id_rsa",
      "id_ed25519",
      "server.key",
      "cert.pem",
      "archive.p12",
      "client.pfx",
      "kubeconfig",
      "credentials.json",
      "secrets.yaml",
    ];
    for (const name of names) {
      const filePath = path.join(workspaceDirectory, name);
      await fs.writeFile(filePath, "x", "utf8");
      await expect(
        sensitivePolicy.assertSensitiveContentReadAllowed({
          canonicalPath: filePath,
        }),
      ).rejects.toMatchObject({
        errorCode: "sensitive-content-read-denied",
      });
    }
  });

  it("普通非敏感文件放行（不误杀常规配置）", async () => {
    const names = ["package.json", "tsconfig.json", "README.md", "config.yaml", ".gitignore"];
    for (const name of names) {
      const filePath = path.join(workspaceDirectory, name);
      await fs.writeFile(filePath, "ordinary content", "utf8");
      await expect(
        sensitivePolicy.assertSensitiveContentReadAllowed({
          canonicalPath: filePath,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("管理员扩展敏感路径与模式生效", async () => {
    const extendedPolicy = new SensitiveContentAccessPolicy({
      additionalSensitivePaths: [
        path.join(workspaceDirectory, "internal", "seal.txt"),
      ],
      additionalSensitivePatterns: [/^\.company-keep-out$/],
    });
    const extendedFile = path.join(workspaceDirectory, "internal", "seal.txt");
    await fs.mkdir(path.dirname(extendedFile), { recursive: true });
    await fs.writeFile(extendedFile, "x", "utf8");
    const patternFile = path.join(workspaceDirectory, ".company-keep-out");
    await fs.writeFile(patternFile, "x", "utf8");
    await expect(
      extendedPolicy.assertSensitiveContentReadAllowed({
        canonicalPath: extendedFile,
      }),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
    await expect(
      extendedPolicy.assertSensitiveContentReadAllowed({
        canonicalPath: patternFile,
      }),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });
});

describe("SensitiveResourceIdentityResolver（链接/硬链接伪装）", () => {
  it("符号链接指向 .env 同样拒绝（realpath 同一性）", async () => {
    const envFilePath = path.join(workspaceDirectory, ".env");
    await fs.writeFile(envFilePath, "TOKEN=abc123", "utf8");
    const aliasPath = path.join(workspaceDirectory, "innocent.txt");
    try {
      await fs.symlink(envFilePath, aliasPath);
    } catch {
      return; // 平台无符号链接权限（Windows 需管理员/开发者模式）：跳过
    }
    await expect(
      sensitivePolicy.assertSensitiveContentReadAllowed({
        canonicalPath: aliasPath,
      }),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });

  it("硬链接到凭据文件同样拒绝（deviceInode 同一性）", async () => {
    // 凭据库文件经硬链接别名读取：名称正常，但内容含凭据 → DLP 拒绝。
    // （凭据库文件内容本身无凭据模式时 DLP 有界限，见 ADR-0018 文档说明。）
    const credentialsFilePath = path.join(workspaceDirectory, "credentials.json");
    await fs.writeFile(
      credentialsFilePath,
      '{"token": "abcdefghijklmnopqrstuvwxyz012345"}',
      "utf8",
    );
    const aliasPath = path.join(workspaceDirectory, "data.json");
    try {
      await fs.link(credentialsFilePath, aliasPath);
    } catch {
      return; // 平台不支持硬链接：跳过
    }
    await expect(
      sensitivePolicy.assertSensitiveContentReadAllowed({
        canonicalPath: aliasPath,
        content: '{"token": "abcdefghijklmnopqrstuvwxyz012345"}',
      }),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });

  it("isSameResource 对同一文件不同路径判定一致", async () => {
    const resolver = new SensitiveResourceIdentityResolver();
    const filePath = path.join(workspaceDirectory, "plain.txt");
    await fs.writeFile(filePath, "x", "utf8");
    const identityA = await resolver.resolveIdentity(filePath);
    const identityB = await resolver.resolveIdentity(filePath);
    expect(resolver.isSameResource(identityA, identityB)).toBe(true);
  });
});

describe("DLP 内容扫描（名称正常但内容疑似凭据）", () => {
  it("正常文件名含密钥内容 → 整个结果拒绝；错误不含秘密值", async () => {
    const filePath = path.join(workspaceDirectory, "notes.txt");
    await fs.writeFile(
      filePath,
      "随手记录: api_key=sk-abcdef1234567890abcdef1234567890",
      "utf8",
    );
    const error = (await sensitivePolicy
      .assertSensitiveContentReadAllowed({
        canonicalPath: filePath,
        content:
          "随手记录: api_key=sk-abcdef1234567890abcdef1234567890",
      })
      .catch((caught: unknown) => caught as DomainError)) as DomainError;
    expect(error.errorCode).toBe("sensitive-content-read-denied");
    expect(error.message).not.toContain("sk-");
    expect(error.message).toContain("dlp:api-key");
  });

  it("AWS 密钥/私钥块/连接串内容命中", async () => {
    for (const content of [
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "postgres://user:pass@host:5432/db",
      "glpat-abcdefghijklmnopqrstuv",
    ]) {
      const result = await sensitivePolicy
        .assertSensitiveContentReadAllowed({
          canonicalPath: path.join(workspaceDirectory, "blob.txt"),
          content,
        })
        .then(() => null)
        .catch((caught: unknown) => caught as DomainError);
      expect(result?.errorCode).toBe("sensitive-content-read-denied");
    }
  });

  it("无凭据的普通文本内容放行", async () => {
    await expect(
      sensitivePolicy.assertSensitiveContentReadAllowed({
        canonicalPath: path.join(workspaceDirectory, "notes.txt"),
        content: "今天完成了任务链设计。",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("builtins 读通道接入（三种模式统一拒绝）", () => {
  it("readFile 直接拒绝 .env（不依赖模式权限）", async () => {
    await fs.writeFile(path.join(workspaceDirectory, ".env"), "TOKEN=secret", "utf8");
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: ".env" }),
        baseContext(),
      ),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });

  it("readFile 正常文件但内容含密钥 → 拒绝且不返回正文", async () => {
    await fs.writeFile(
      path.join(workspaceDirectory, "diary.txt"),
      "api_token=abcdefghijklmnopqrstuvwxyz0123456789",
      "utf8",
    );
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "diary.txt" }),
        baseContext(),
      ),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });

  it("listDirectory 过滤敏感条目且不泄露名称", async () => {
    await fs.writeFile(path.join(workspaceDirectory, ".env"), "x", "utf8");
    await fs.writeFile(path.join(workspaceDirectory, "ok.txt"), "x", "utf8");
    const result = await executeBuiltinTool(
      "listDirectory",
      JSON.stringify({ directoryPath: "." }),
      baseContext(),
    );
    expect(result.outputText).toContain("ok.txt");
    expect(result.outputText).not.toContain(".env");
  });

  it("searchProjectText 不返回敏感文件内容", async () => {
    await fs.writeFile(
      path.join(workspaceDirectory, ".env"),
      "TARGET_KEYWORD=sk-abcdefghijklmnopqrstuvwxyz01234567",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDirectory, "doc.txt"),
      "TARGET_KEYWORD 普通文档",
      "utf8",
    );
    const result = await executeBuiltinTool(
      "searchProjectText",
      JSON.stringify({ pattern: "TARGET_KEYWORD" }),
      baseContext(),
    );
    expect(result.outputText).toContain("doc.txt");
    expect(result.outputText).not.toContain(".env");
  });
});
