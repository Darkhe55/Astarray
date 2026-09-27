/**
 * 安全能力注入反例：敏感内容策略与读取时间锁必须按**实际文件系统大小写能力**判定，
 * 而不是按平台猜测——macOS 默认大小写不敏感，若走 POSIX 分支会漏判大小写变体。
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SensitiveContentAccessPolicy } from "../../../packages/core/src/tools/sensitive-content-access-policy.js";
import { CanonicalResourceIdentityResolver } from "../../../packages/core/src/tools/read-suppression-ledger.js";

function swapPathCase(targetPath: string): string {
  return targetPath.replace(/[A-Za-z]/g, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
  );
}

describe("敏感内容策略：按注入的文件系统大小写能力折叠", () => {
  // 策略内部对管理员扩展路径做 path.resolve，因此测试也用平台绝对路径，避免根前缀差异。
  // 用不受内置规则（含 *.env 这类大小写不敏感规则）影响的名字，单独验证"管理员扩展路径"的折叠语义。
  const sensitivePath = path.resolve("/data/app/deployment-notes.txt");

  it("大小写不敏感：大小写变体命中管理员扩展敏感路径", () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePaths: [sensitivePath],
      fileSystemCaseSensitivity: "case-insensitive",
    });
    expect(policy.matchSensitivePathName(sensitivePath)).toBe("admin-extended");
    expect(policy.matchSensitivePathName(swapPathCase(sensitivePath))).toBe("admin-extended");
  });

  it("大小写敏感：大小写变体是不同文件，不命中", () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePaths: [sensitivePath],
      fileSystemCaseSensitivity: "case-sensitive",
    });
    expect(policy.matchSensitivePathName(sensitivePath)).toBe("admin-extended");
    expect(policy.matchSensitivePathName(swapPathCase(sensitivePath))).toBeNull();
  });
});

describe("读取时间锁：按注入的文件系统大小写能力生成规范身份", () => {
  it("大小写不敏感：规范身份折叠大小写与分隔符", async () => {
    const resolver = new CanonicalResourceIdentityResolver({
      fileSystemCaseSensitivity: "case-insensitive",
    });
    const identity = await resolver.resolveIdentity("/data/app/DATA.TXT");
    expect(identity.normalizedCasePath).toBe("/data/app/data.txt");
  });

  it("大小写敏感：规范身份保留大小写（仅统一分隔符）", async () => {
    const resolver = new CanonicalResourceIdentityResolver({
      fileSystemCaseSensitivity: "case-sensitive",
    });
    const identity = await resolver.resolveIdentity("/data/app/DATA.TXT");
    expect(identity.normalizedCasePath).toBe("/data/app/DATA.TXT");
  });
});
