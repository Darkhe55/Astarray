/**
 * 反例（2026-10-28）：**协作请求经唯一直属上级代理转达**。
 *
 * 依据本卡 §2.2（逐条对应，见实现文件顶部注释）：
 * 执行者不选收件人；跨上级协作须向**目标执行者的唯一直属上级**递交请求并由其转达；
 * **不允许第二上级直接下令**；转达**保留原始来源、转达者与任务关联，不冒充原创**；
 * 原上级不可用 ⇒ **暂停并存档**，执行者**不得自行找新上级**。
 *
 * 只跑本地逻辑与临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentCreationRegistry } from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";
import { routeCollaborationViaUniqueParent } from "../../../packages/core/src/orchestration/collaboration-relay-via-parent.js";

let stateDirectory: string;
let registry: AgentCreationRegistry;

const SECONDARY_A = "secondary-agent-a";
const SECONDARY_B = "secondary-agent-b";
const TERTIARY_A1 = "tertiary-a1";
const TERTIARY_B1 = "tertiary-b1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm01-relay-"));
  registry = new AgentCreationRegistry({ stateDirectory });
  // 拓扑：A 建了 a1；B 建了 b1（a1 与 b1 互相不直属）
  await registry.registerCreatedAgent({
    agentInstanceId: SECONDARY_A,
    createdByAgentInstanceId: "main-agent-1",
  });
  await registry.registerCreatedAgent({
    agentInstanceId: SECONDARY_B,
    createdByAgentInstanceId: "main-agent-1",
  });
  await registry.registerCreatedAgent({
    agentInstanceId: TERTIARY_A1,
    createdByAgentInstanceId: SECONDARY_A,
  });
  await registry.registerCreatedAgent({
    agentInstanceId: TERTIARY_B1,
    createdByAgentInstanceId: SECONDARY_B,
  });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("COMM-01-02：协作请求必须经目标的唯一直属上级转达", () => {
  it("① 收件人**由本地按归属算出** = 目标的唯一直属上级（执行者不选收件人）", async () => {
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_A1,
      targetAgentInstanceId: TERTIARY_B1,
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(true);
    if (!outcome.isRoutable) return;
    // 不是直接发给 b1，而是发给 b1 的上级 B
    expect(outcome.request.relayRecipientAgentInstanceId).toBe(SECONDARY_B);
    expect(outcome.request.targetAgentInstanceId).toBe(TERTIARY_B1);
  });

  it("② 转达**保留原始来源、转达者与任务关联**，且**显式标注为转达**（不冒充原创）", async () => {
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_A1,
      targetAgentInstanceId: TERTIARY_B1,
      taskIdentifier: "task-42",
    });

    expect(outcome.isRoutable).toBe(true);
    if (!outcome.isRoutable) return;
    expect(outcome.request.originalSourceAgentInstanceId).toBe(TERTIARY_A1);
    expect(outcome.request.relayedByAgentInstanceId).toBe(SECONDARY_B);
    expect(outcome.request.taskIdentifier).toBe("task-42");
    // 关键：不得让接收方以为这是直属上级的原创指令
    expect(outcome.request.isRelayedRequest).toBe(true);
  });

  it("③ 目标**未登记** ⇒ 拒绝（不存在的主体不得被协作）", async () => {
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_A1,
      targetAgentInstanceId: "never-created",
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(false);
    expect(String((outcome as { reason: string }).reason)).toContain("不是已登记主体");
  });

  it("④ 目标**已回收** ⇒ 拒绝（不再是活跃主体）", async () => {
    await registry.markRecycled(TERTIARY_B1);
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_A1,
      targetAgentInstanceId: TERTIARY_B1,
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(false);
    expect(String((outcome as { reason: string }).reason)).toContain("已被回收");
  });

  it("⑤ 目标**由用户/控制面直接创建**（无上级）⇒ 拒绝，明说无从转达", async () => {
    await registry.registerCreatedAgent({
      agentInstanceId: "user-created-agent",
      createdByAgentInstanceId: null,
    });
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_A1,
      targetAgentInstanceId: "user-created-agent",
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(false);
    expect(String((outcome as { reason: string }).reason)).toContain("没有唯一直属上级");
  });

  it("⑥ **原上级已不可用** ⇒ **暂停并存档**，执行者不得自行另找上级", async () => {
    await registry.markRecycled(SECONDARY_B);

    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_A1,
      targetAgentInstanceId: TERTIARY_B1,
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(false);
    if (outcome.isRoutable) return;
    // 必须明确要求暂停/存档，而不是让执行者换个对象发
    expect(outcome.isPausedForRecovery).toBe(true);
    expect(String(outcome.reason)).toContain("不得自行另找上级");
  });

  it("⑦ 目标与发起者同一主体 ⇒ 拒绝（不得借'自我协作'绕开路由）", async () => {
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: TERTIARY_B1,
      targetAgentInstanceId: TERTIARY_B1,
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(false);
    expect(String((outcome as { reason: string }).reason)).toContain("同一主体");
  });

  it("⑧ **不允许第二上级直接下令**：路由结果永远只指向目标的直属上级", async () => {
    // 即使发起者是另一个次级（A），收件人也必须是 b1 的直属上级 B —— 而不是 A 自己
    const outcome = await routeCollaborationViaUniqueParent({
      registry,
      originalSourceAgentInstanceId: SECONDARY_A,
      targetAgentInstanceId: TERTIARY_B1,
      taskIdentifier: "task-1",
    });

    expect(outcome.isRoutable).toBe(true);
    if (!outcome.isRoutable) return;
    expect(outcome.request.relayRecipientAgentInstanceId).toBe(SECONDARY_B);
    expect(outcome.request.relayRecipientAgentInstanceId).not.toBe(SECONDARY_A);
  });
});
