/**
 * PROJECT-01-04 反例（2026-11-08，第 75 轮）：**经编排器真实派发的多同级个体**
 * 的隔离与可追溯 —— 且必须走**公开门面**。
 *
 * ## 为什么补这条（卡内如实登记的剩余项）
 *
 * > **仍未完成（不主张 PROJECT-01-04 完全通过）**：多同级个体目前只在**授权/回执维度**验证；
 * > 经编排器真实派发的多同级 Agent 端到端压力场景……仍未做。
 *
 * 既有 `cross-project-isolation-multi-project.test.ts` 有两点不足：
 * 1. 接收方身份是**手工拼的字符串**（`secondary-agent-1` / `secondary-agent-2`），
 *    不是**编排器真实派发**产生的身份；
 * 2. 它直接驱动 `CrossProjectAuthorizationStore` / `CrossProjectTransferService`，
 *    **绕过公开门面**。
 *
 * ## 本轮同时查实的**产品缺口**（不只是"缺测试"）
 *
 * `receivingAgentInstanceId` 维度在**存储层是存在的**（记录字段、授权入参、列表过滤都有），
 * 但**公开门面从未暴露它** ⇒ 卡内"多个同级个体可追溯、不串数据"这一验收要求
 * **在产品公开 API 上根本表达不出来**（正是本卡反复点名的"能力存在但产品不可达"）。
 *
 * 故本用例同时充当该能力的**行为反例**：
 * 先因门面缺 `receivingAgentInstanceId` 而失败，补齐后才通过。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

const TERMINAL_STATUSES = ["done", "failed", "blocked", "cancelled"];

/**
 * 把一个**真实派发**产生的 agent 身份取出来：读该 mission 的 `agents/` 目录名并解码。
 *
 * 目录名是**转义后**的（`~003a` = `:`），例如
 * `worker~003amission-x~003aT-001~003a1` ⇒ `worker:mission-x:T-001:1`
 * —— 这正是运行时使用的 `agentInstanceId`。
 */
async function listDispatchedAgentInstanceIds(missionIdentifier: string): Promise<string[]> {
  const agentsDirectory = path.join(stateDirectory, "missions", missionIdentifier, "agents");
  let directoryNames: string[];
  try {
    directoryNames = await fs.readdir(agentsDirectory);
  } catch {
    return [];
  }
  return directoryNames.map((directoryName) => directoryName.replaceAll("~003a", ":")).sort();
}

async function waitUntilTerminal(
  application: AstarrayApplicationFacade,
  sessionId: string,
  taskIdentifier: string,
): Promise<string> {
  const deadline = Date.now() + 45_000;
  let status = "accepted";
  while (!TERMINAL_STATUSES.includes(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (
      await application.queryTask({ sessionId, taskIdentifier })
    ).status;
  }
  return status;
}

/** 跑一个真实任务，返回其 mission 下**真实派发**的 agent 身份。 */
async function dispatchTaskAndReadAgentIdentity(
  application: AstarrayApplicationFacade,
  peerIndex: number,
): Promise<string> {
  const sessionId = "session-peer-" + String(peerIndex);
  const taskIdentifier = "task-peer-" + String(peerIndex);
  application.createSession({ sessionId, mode: "assist" });
  const submitted = await application.submitTask({
    sessionId,
    taskIdentifier,
    prompt: "为同级个体隔离验收写一句话。",
  });
  expect(submitted.missionIdentifier, "submitTask 必须返回 mission 标识").not.toBeNull();
  const status = await waitUntilTerminal(application, sessionId, taskIdentifier);
  expect(TERMINAL_STATUSES, "任务必须收敛到终态").toContain(status);
  const agentInstanceIds = await listDispatchedAgentInstanceIds(
    submitted.missionIdentifier as string,
  );
  expect(agentInstanceIds.length, "真实派发必须至少产生一个 agent 实例").toBeGreaterThanOrEqual(1);
  return agentInstanceIds[0]!;
}

describe("PROJECT-01-04：经编排器真实派发的多同级个体隔离与可追溯（公开门面）", () => {
  beforeEach(async () => {
    stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-peers-"));
  });

  afterEach(async () => {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
  });

  it("① 两个真实派发的同级个体各自只看到自己的授权（不串），且身份可追溯", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      statusPollIntervalMilliseconds: 20,
    });
    try {
      const firstPeerInstanceId = await dispatchTaskAndReadAgentIdentity(application, 1);
      const secondPeerInstanceId = await dispatchTaskAndReadAgentIdentity(application, 2);

      // 两个身份必须是**不同**的真实派发身份（同级但个体不同）
      expect(firstPeerInstanceId).not.toBe(secondPeerInstanceId);
      // 且必须是运行时形态的身份（不是手工字符串）
      expect(firstPeerInstanceId).toContain(":");
      expect(secondPeerInstanceId).toContain(":");

      // 各自绑定各自接收身份的授权
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-first-peer",
        sourceProjectIdentifier: "project-a",
        sourceProjectRevision: 3,
        targetProjectIdentifier: "project-b",
        operationKind: "import-copy",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "hash-first-peer",
        receivingAgentInstanceId: firstPeerInstanceId,
      });
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-second-peer",
        sourceProjectIdentifier: "project-a",
        sourceProjectRevision: 3,
        targetProjectIdentifier: "project-b",
        operationKind: "import-copy",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "hash-second-peer",
        receivingAgentInstanceId: secondPeerInstanceId,
      });

      // **不串数据**：按接收身份过滤，各自只看到自己那一条
      const firstPeerAuthorizations = await application.listCrossProjectAuthorizations({
        receivingAgentInstanceId: firstPeerInstanceId,
      });
      expect(firstPeerAuthorizations).toHaveLength(1);
      expect(firstPeerAuthorizations[0]?.authorizationIdentifier).toBe("auth-first-peer");
      // **可追溯**：记录里带回接收身份本身
      expect(firstPeerAuthorizations[0]?.receivingAgentInstanceId).toBe(firstPeerInstanceId);

      const secondPeerAuthorizations = await application.listCrossProjectAuthorizations({
        receivingAgentInstanceId: secondPeerInstanceId,
      });
      expect(secondPeerAuthorizations).toHaveLength(1);
      expect(secondPeerAuthorizations[0]?.authorizationIdentifier).toBe("auth-second-peer");
      expect(secondPeerAuthorizations[0]?.receivingAgentInstanceId).toBe(secondPeerInstanceId);

      // 不串：第一条的列表里**不得**出现第二条
      expect(
        firstPeerAuthorizations.map((record) => record.authorizationIdentifier),
      ).not.toContain("auth-second-peer");

      // 不带过滤时两条都在（总数不丢）
      const allAuthorizations = await application.listCrossProjectAuthorizations();
      expect(allAuthorizations).toHaveLength(2);
    } finally {
      await application.shutdown();
    }
  });
});
