/**
 * 检查点 B 反例：SDK 授权端口与身份绑定。
 * 目标：公开入口能注入删除备份/安装交互端口；身份来自可信宿主用户上下文；
 * 固定 "sdk-user"/"main-agent-sdk" 必须消失；缺身份时需人工授权的操作 fail-closed。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;
let facadeCounter = 0;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-identity-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const installationUserPort = {
  askExistingResource: async () => ({ hasExistingResource: false, evidenceSummary: null }) as never,
  askAllowOnce: async () => "deny" as const,
};

const backupDeletionControlPort = {
  requestAuthorization: async () => ({ decision: "deny" }) as never,
};

async function createFacade(options: Record<string, unknown> = {}) {
  facadeCounter += 1;
  return AstarrayApplicationFacade.create({
    stateDirectory: path.join(stateDirectory, "run-" + facadeCounter),
    mode: "assist",
    runtime: "mock",
    ...options,
  });
}

describe("SDK 授权端口与身份绑定", () => {
  it("显式身份与端口在诊断面如实报告", async () => {
    const application = await createFacade({
      authenticatedUserId: "carol",
      installationUserPort,
      backupDeletionControlPort,
    });
    const diagnostics = application.getRuntimeDiagnostics() as Record<string, unknown>;
    expect(diagnostics.hasInstallationUserPort).toBe(true);
    expect(diagnostics.hasBackupDeletionControlPort).toBe(true);
    expect(diagnostics.authenticatedUserSource).toBe("explicit");
    expect(diagnostics.authenticatedUserId).toBe("carol");
    await application.shutdown();
  });

  it("未显式提供身份时使用可信宿主用户上下文，绝不出现固定 sdk-user", async () => {
    const application = await createFacade();
    const diagnostics = application.getRuntimeDiagnostics() as Record<string, unknown>;
    expect(diagnostics.authenticatedUserId).not.toBe("sdk-user");
    expect(["host", "absent"]).toContain(diagnostics.authenticatedUserSource);
    expect(diagnostics.hasInstallationUserPort).toBe(false);
    expect(diagnostics.hasBackupDeletionControlPort).toBe(false);
    await application.shutdown();
  });

  it("主 Agent 实例 ID 逐运行时唯一且不再是固定值", async () => {
    const first = await createFacade();
    const second = await createFacade();
    const firstIdentifier = (first.getRuntimeDiagnostics() as Record<string, unknown>).mainAgentInstanceId;
    const secondIdentifier = (second.getRuntimeDiagnostics() as Record<string, unknown>).mainAgentInstanceId;
    expect(firstIdentifier).not.toBe("main-agent-sdk");
    expect(firstIdentifier).not.toBe(secondIdentifier);
    await first.shutdown();
    await second.shutdown();
  });

  it("同一会话（同一 state dir）跨进程复用同一主 Agent 实例 ID", async () => {
    const sharedStateDirectory = path.join(stateDirectory, "shared-session");
    const first = await AstarrayApplicationFacade.create({
      stateDirectory: sharedStateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    const firstIdentifier = (first.getRuntimeDiagnostics() as Record<string, unknown>).mainAgentInstanceId;
    await first.shutdown();
    const second = await AstarrayApplicationFacade.create({
      stateDirectory: sharedStateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    const secondIdentifier = (second.getRuntimeDiagnostics() as Record<string, unknown>).mainAgentInstanceId;
    await second.shutdown();
    expect(secondIdentifier).toBe(firstIdentifier);
  });

  it("缺认证身份时需人工授权的公共操作 fail-closed", async () => {
    const application = await createFacade({ authenticatedUserId: null });
    await expect(
      application.submitRuntimeGuidance({
        missionIdentifier: "mission-1",
        taskIdentifier: "task-1",
        instructionText: "需要身份的指导",
        sourceKind: "authenticated-user",
      }),
    ).rejects.toMatchObject({ errorCode: "authenticated-user-required" });
    await application.shutdown();
  });
});
