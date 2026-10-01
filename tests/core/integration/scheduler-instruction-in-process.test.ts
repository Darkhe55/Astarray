/**
 * 反例（裁决指令必须在**同进程内**送达 scheduler）：
 * `AssistScheduler` 实例活在主进程（`MainController.activeOrchestrators`），
 * 而 `scheduler:<missionId>` 的 mailbox 在反馈子进程。此前 `sendSchedulerInstruction`
 * 只经反馈传输投递 → 子进程把消息标记已投递但不回传 → 父进程 `onMessage` 从不触发
 * → 用户 allow-once 后的 `unblock` 永远到不了 scheduler（真实写任务实测永久 blocked）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

interface SchedulerStub {
  handleInstruction(instructionText: string): void;
}

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-inproc-instruction-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function accessibleController(application: AstarrayApplicationFacade): {
  activeOrchestrators: Map<string, { scheduler: SchedulerStub; mode: string }>;
} {
  return (
    application as unknown as {
      runtime: {
        controller: {
          activeOrchestrators: Map<string, { scheduler: SchedulerStub; mode: string }>;
        };
      };
    }
  ).runtime.controller;
}

describe("裁决指令投递", () => {
  it("sendSchedulerInstruction 直接在同进程调用 scheduler.handleInstruction", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      const controller = accessibleController(application);
      const handleInstruction = vi.fn();
      controller.activeOrchestrators.set("mission-inproc-1", {
        scheduler: { handleInstruction },
        mode: "assist",
      });

      const instructionText = JSON.stringify({ action: "unblock", taskId: "T-001" });
      application.sendSchedulerInstruction("mission-inproc-1", instructionText);

      expect(handleInstruction).toHaveBeenCalledTimes(1);
      expect(handleInstruction).toHaveBeenCalledWith(instructionText);
    } finally {
      await application.shutdown();
    }
  });

  it("未激活的 mission 不应抛错（指令仅镜像到反馈信箱）", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      expect(() =>
        application.sendSchedulerInstruction(
          "mission-not-active",
          JSON.stringify({ action: "unblock", taskId: "T-001" }),
        ),
      ).not.toThrow();
    } finally {
      await application.shutdown();
    }
  });
});
