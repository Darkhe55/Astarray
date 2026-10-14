/**
 * COMM-01-02 反例（**2026-10-22 依设计清单与用户澄清订正**）：
 * **Agent 创建来源登记** + **按地址投递的地址完整性**。
 *
 * ## 为什么整份重写（保留此说明以免后来者重犯）
 *
 * 首版把本片写成"**唯一上级 = 通信授权**"：一个子只能有一个上级、
 * 且只允许直属上级投递。**那是错的**：
 *
 * - `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54：**同项目的主层与次级层默认全连接**
 *   （不逐边申请通信授权）；跨项目按需连接且仅主—主/次级—次级建议通道须授权；
 *   三级/四级只向**唯一直属上级**请示报告，其他协作请求由直属上级**代理转达**。
 * - **反馈不按上下级关系走**：默认走**任务发布者的反向通道**。
 * - **绑定记录**是**创建时由创建工具自动登记**的来源事实，**不是通信授权**。
 * - 向**没有绑定记录**的对象投递 ⇒ **直接拒绝**（地址完整性）。
 *
 * ⇒ 正确语义只有两条：**登记来源** 与 **拒收未知地址**。
 * 本文件据此重写；旧断言（"别人的下级不得投递"）**已删除** —— 它测的是错误模型。
 *
 * 只跑本地逻辑与临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentAddressGuard,
  AgentCreationRegistry,
} from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";

let stateDirectory: string;

const CHILD = "tertiary-agent-1";
const CREATOR = "secondary-agent-a";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm01-creation-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("COMM-01-02：创建来源登记（谁创建了谁）", () => {
  it("① 登记后可查到创建者；**无绑定记录**的主体查不到（不得凭空存在）", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    await registry.registerCreatedAgent({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: CREATOR,
    });

    const guard = new AgentAddressGuard({ registry });
    await expect(guard.resolveCreatorOf(CHILD)).resolves.toBe(CREATOR);
    await expect(guard.resolveCreatorOf("never-created")).resolves.toBeNull();
    await expect(registry.isRegisteredAgent("never-created")).resolves.toBe(false);
  });

  it("② 重复登记**幂等**且保留首次来源（重试不得改写创建者）", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    const first = await registry.registerCreatedAgent({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: CREATOR,
    });
    const retry = await registry.registerCreatedAgent({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: "secondary-agent-b",
    });

    expect(retry.createdByAgentInstanceId).toBe(CREATOR);
    expect(retry.createdAtIso).toBe(first.createdAtIso);
    await expect(registry.getRecord(CHILD)).resolves.toMatchObject({
      createdByAgentInstanceId: CREATOR,
    });
  });

  it("③ 登记必须**持久化**：新实例（模拟重启）仍读到来源", async () => {
    const firstRegistry = new AgentCreationRegistry({ stateDirectory });
    await firstRegistry.registerCreatedAgent({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: CREATOR,
    });

    const reopened = new AgentCreationRegistry({ stateDirectory });
    await expect(reopened.getRecord(CHILD)).resolves.toMatchObject({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: CREATOR,
    });
  });

  it("④ 由**用户/控制面**直接创建 ⇒ 创建者如实记为 null（不编造上级）", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    const record = await registry.registerCreatedAgent({
      agentInstanceId: "main-agent-1",
      createdByAgentInstanceId: null,
    });

    expect(record.createdByAgentInstanceId).toBeNull();
    await expect(registry.isRegisteredAgent("main-agent-1")).resolves.toBe(true);
  });
});

describe("COMM-01-02：按地址投递的地址完整性", () => {
  it("⑤ **无绑定记录**的收件人 ⇒ 直接拒绝（用户澄清的硬规则）", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    const guard = new AgentAddressGuard({ registry });

    await expect(guard.isDeliverableRecipient("never-created")).resolves.toBe(false);
  });

  it("⑥ 已登记且未回收 ⇒ 可投递", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    await registry.registerCreatedAgent({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: CREATOR,
    });
    const guard = new AgentAddressGuard({ registry });

    await expect(guard.isDeliverableRecipient(CHILD)).resolves.toBe(true);
  });

  it("⑦ 已回收 ⇒ 不再可投递，但历史来源仍可查（可追溯“谁建的”）", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    await registry.registerCreatedAgent({
      agentInstanceId: CHILD,
      createdByAgentInstanceId: CREATOR,
    });
    const guard = new AgentAddressGuard({ registry });

    await registry.markRecycled(CHILD);

    await expect(guard.isDeliverableRecipient(CHILD)).resolves.toBe(false);
    // 历史不得被抹掉
    await expect(guard.resolveCreatorOf(CHILD)).resolves.toBe(CREATOR);
  });

  it("⑧ 地址完整性**不限制通信对象**：同项目任意已登记主体之间都可投递", async () => {
    /**
     * 这是对首版错误的**直接回归**：首版会让"非直属上级"投递被拒。
     * 按设计清单，同项目主层与次级层默认全连接、反馈走任务发布者反向通道，
     * 因此**只要收件人是已登记主体**，发送者是谁都不得成为拒收理由。
     */
    const registry = new AgentCreationRegistry({ stateDirectory });
    const guard = new AgentAddressGuard({ registry });
    // 两个不同创建者建出来的主体，且互不为对方的“下级”
    await registry.registerCreatedAgent({
      agentInstanceId: "secondary-agent-a",
      createdByAgentInstanceId: "main-agent-1",
    });
    await registry.registerCreatedAgent({
      agentInstanceId: "secondary-agent-b",
      createdByAgentInstanceId: "main-agent-2",
    });

    // 同级、跨创建者，仍必须可投递
    await expect(guard.isDeliverableRecipient("secondary-agent-a")).resolves.toBe(true);
    await expect(guard.isDeliverableRecipient("secondary-agent-b")).resolves.toBe(true);
  });
});

describe("COMM-01-02：登记文件的 fail-closed", () => {
  it("⑨ `schemaVersion` 不符 ⇒ 按空继续（**不伪造主体存在性**）", async () => {
    await fs.writeFile(
      path.join(stateDirectory, "agent-creation-registry.json"),
      JSON.stringify({
        schemaVersion: 999,
        records: [
          {
            agentInstanceId: CHILD,
            createdByAgentInstanceId: CREATOR,
            createdAtIso: "2026-10-01T00:00:00.000Z",
            recycledAtIso: null,
          },
        ],
      }),
      "utf8",
    );
    const registry = new AgentCreationRegistry({ stateDirectory });
    const guard = new AgentAddressGuard({ registry });

    // 异版本记录不得被当作"存在的主体"（否则未知地址会变成可投递）
    await expect(registry.isRegisteredAgent(CHILD)).resolves.toBe(false);
    await expect(guard.isDeliverableRecipient(CHILD)).resolves.toBe(false);
  });

  it("⑩ 合法 JSON 但缺 `records` / 非数组 ⇒ 兜底为空且不抛错", async () => {
    const variants = [
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify({ schemaVersion: 1, records: "not-an-array" }),
      JSON.stringify({ schemaVersion: 1, records: null }),
    ];
    for (const variant of variants) {
      await fs.writeFile(
        path.join(stateDirectory, "agent-creation-registry.json"),
        variant,
        "utf8",
      );
      const registry = new AgentCreationRegistry({ stateDirectory });
      await expect(registry.isRegisteredAgent(CHILD), variant).resolves.toBe(false);
      await expect(registry.getRecord(CHILD), variant).resolves.toBeNull();
    }
  });
});
