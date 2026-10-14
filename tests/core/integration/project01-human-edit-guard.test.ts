/**
 * 反例（2026-10-31）：人工改动守卫的生产实现。
 *
 * 卡内要求（PROJECT-01-03 检查点 ②）：缺守卫时"目标已存在恒 fail-closed"，
 * 是安全默认但等于**"能读不能导"**。本文件钉住守卫的正确判定，
 * 尤其是**必须 fail-closed** 的那几条（不确定 ⇒ 判为有人工改动）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCrossProjectHumanEditGuard } from "../../../packages/core/src/tools/cross-project-human-edit-guard.js";

let temporaryDirectory: string;
let targetFilePath: string;
let guard: ReturnType<typeof createCrossProjectHumanEditGuard>;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-xproj-guard-"));
  targetFilePath = path.join(temporaryDirectory, "target.md");
  guard = createCrossProjectHumanEditGuard();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("PROJECT-01-03：人工改动守卫 —— 正常判定", () => {
  it("① 目标**不存在** ⇒ 无人工改动（没有人工字节可保护）", async () => {
    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: targetFilePath,
      expectedContent: "来源内容",
    });

    expect(outcome.hasHumanChange).toBe(false);
  });

  it("② 目标内容**等于**预期 ⇒ 无人工改动（幂等重放/重复导入安全）", async () => {
    await fs.writeFile(targetFilePath, "来源内容", "utf8");

    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: targetFilePath,
      expectedContent: "来源内容",
    });

    expect(outcome.hasHumanChange).toBe(false);
  });

  it("③ 目标内容**不等于**预期 ⇒ **有人工改动**（服务据此拒绝陈旧覆盖）", async () => {
    await fs.writeFile(targetFilePath, "用户手改过的内容", "utf8");

    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: targetFilePath,
      expectedContent: "来源内容",
    });

    expect(outcome.hasHumanChange).toBe(true);
    expect(String(outcome.reason)).toContain("不一致");
  });

  it("④ 仅**一处字符**不同也必须判为人工改动（逐字节比较，不做模糊匹配）", async () => {
    await fs.writeFile(targetFilePath, "来源内容!", "utf8");

    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: targetFilePath,
      expectedContent: "来源内容",
    });

    expect(outcome.hasHumanChange).toBe(true);
  });
});

describe("PROJECT-01-03：人工改动守卫 —— **不确定时必须 fail-closed**", () => {
  it("⑤ 目标是**目录**而非普通文件 ⇒ 判为有人工改动（不得当空文件覆盖）", async () => {
    const directoryPath = path.join(temporaryDirectory, "a-directory");
    await fs.mkdir(directoryPath, { recursive: true });

    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: directoryPath,
      expectedContent: "来源内容",
    });

    expect(outcome.hasHumanChange).toBe(true);
    expect(String(outcome.reason)).toContain("不是普通文件");
  });

  it("⑥ 预期内容为空串、目标为**非空**文件 ⇒ 仍判人工改动", async () => {
    await fs.writeFile(targetFilePath, "有人写过东西", "utf8");

    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: targetFilePath,
      expectedContent: "",
    });

    expect(outcome.hasHumanChange).toBe(true);
  });

  it("⑦ 预期与目标**都为空** ⇒ 视为一致（不算人工改动）", async () => {
    await fs.writeFile(targetFilePath, "", "utf8");

    const outcome = await guard.hasUnexpectedHumanChange({
      absoluteTargetPath: targetFilePath,
      expectedContent: "",
    });

    expect(outcome.hasHumanChange).toBe(false);
  });
});
