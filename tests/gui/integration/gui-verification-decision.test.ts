/**
 * GUI-01-R-03b 集成测试：待追认列表与人工裁决（签收/否决）经公共门面接真实控制器，
 * 并锁定跨 Agent 隔离与"图前进后签字过期"。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 覆盖率插桩下真实任务链路会变慢：沿用整文件超时，不放宽任何断言。
vi.setConfig({ testTimeout: 90_000 });

import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

const CSRF_TOKEN = "csrf-token-verification";
let stateDirectory: string;
let servers: Array<{ close(): Promise<void> }>;
let applications: AstarrayApplicationFacade[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-gui-verification-"),
  );
  servers = [];
  applications = [];
});

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => {});
  }
  for (const application of applications) {
    await application.shutdown().catch(() => {});
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

/** 真实产品路径：Devolve 任务收口为 deferred-review-closed 并生成延迟核验任务。 */
async function runDevolveMission(): Promise<void> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "devolve",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });
  applications.push(application);
  application.createSession({ sessionId: "session-verification", mode: "devolve" });
  const submitted = await application.submitTask({
    sessionId: "session-verification",
    taskIdentifier: "task-verification-1",
    prompt: "生成待追认产物",
  });
  const deadline = Date.now() + 30_000;
  let status = submitted.status;
  while (!["done", "failed", "blocked", "cancelled"].includes(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    status = (
      await application.queryTask({
        sessionId: "session-verification",
        taskIdentifier: submitted.taskIdentifier,
      })
    ).status;
  }
  expect(status).toBe("done");
}

async function findDeferredTask(): Promise<{
  ownerAgentInstanceId: string;
  taskIdentifier: string;
  contextNodeIdentifier: string;
}> {
  const agentMemoryDirectory = path.join(stateDirectory, "agent-memory");
  const owners = await fs.readdir(agentMemoryDirectory);
  for (const owner of owners) {
    const directoryPath = path.join(
      agentMemoryDirectory,
      owner,
      "deferred-verification-tasks",
    );
    const fileNames = await fs.readdir(directoryPath).catch(() => [] as string[]);
    const fileName = fileNames.find((name) => name.endsWith(".json"));
    if (fileName === undefined) {
      continue;
    }
    const task = JSON.parse(
      await fs.readFile(path.join(directoryPath, fileName), "utf8"),
    ) as { contextNodeIdentifier: string };
    return {
      ownerAgentInstanceId: owner,
      taskIdentifier: fileName.slice(0, -".json".length),
      contextNodeIdentifier: task.contextNodeIdentifier,
    };
  }
  throw new Error("未找到延迟核验任务");
}

async function readOwnerGraph(
  ownerAgentInstanceId: string,
): Promise<{ graph: { revision: number; nodes: Array<{ contextNodeIdentifier: string; state: string }> }; graphIdentifier: string }> {
  const graphDirectoryPath = path.join(
    stateDirectory,
    "agent-memory",
    ownerAgentInstanceId,
    "context-graphs",
  );
  const graphIdentifier = (await fs.readdir(graphDirectoryPath))[0] ?? "";
  const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
  const graph = await graphStore.readGraph(ownerAgentInstanceId, graphIdentifier);
  if (graph === null) {
    throw new Error("上下文图不存在");
  }
  return { graph, graphIdentifier };
}

async function startGuiOnStateDirectory(): Promise<{ application: AstarrayApplicationFacade; port: number }> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "devolve",
    runtime: "mock",
    statusPollIntervalMilliseconds: 20,
  });
  applications.push(application);
  application.createSession({ sessionId: "session-gui-verification", mode: "devolve" });
  const handle = await startGuiServer({
    applicationService: application,
    sessionId: "session-gui-verification",
    mode: "devolve",
    csrfTokenFactory: () => CSRF_TOKEN,
  });
  servers.push(handle);
  return { application, port: handle.port };
}

function request(input: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers: input.headers ?? {},
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () =>
          resolve({ statusCode: incoming.statusCode ?? 0, body }),
        );
      },
    );
    outgoing.on("error", reject);
    if (input.body !== undefined) {
      outgoing.write(input.body);
    }
    outgoing.end();
  });
}

async function decide(
  port: number,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return request({
    port,
    method: "POST",
    path: "/commands/verification-decision",
    headers: {
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      "x-csrf-token": CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

describe("GUI-01-R-03b 待追认与人工裁决", () => {
  it("列出待追认项并经 GUI 追认，签收写入归属 Agent 存档", async () => {
    await runDevolveMission();
    const { port } = await startGuiOnStateDirectory();
    const task = await findDeferredTask();

    const list = await request({ port, method: "GET", path: "/verifications" });
    expect(list.statusCode).toBe(200);
    const entries = (JSON.parse(list.body) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ownerAgentInstanceId: task.ownerAgentInstanceId,
      taskIdentifier: task.taskIdentifier,
      contextNodeIdentifier: task.contextNodeIdentifier,
    });
    expect(list.body).not.toContain(stateDirectory);

    const before = await readOwnerGraph(task.ownerAgentInstanceId);
    const accepted = await decide(port, {
      ownerAgentInstanceId: task.ownerAgentInstanceId,
      taskIdentifier: task.taskIdentifier,
      decision: "accepted",
    });
    expect(accepted.statusCode).toBe(200);
    const result = JSON.parse(accepted.body) as {
      decision: string;
      acceptanceIdentifier: string;
    };
    expect(result.decision).toBe("accepted");
    expect(result.acceptanceIdentifier).toBeTruthy();

    const acceptancePath = path.join(
      stateDirectory,
      "agent-memory",
      task.ownerAgentInstanceId,
      "acceptances",
      result.acceptanceIdentifier + ".json",
    );
    const acceptanceRecord = JSON.parse(await fs.readFile(acceptancePath, "utf8")) as {
      contextGraphRevision: number;
      nodeIdentifiers: string[];
      ownerAgentInstanceId: string;
    };
    expect(acceptanceRecord.ownerAgentInstanceId).toBe(task.ownerAgentInstanceId);
    expect(acceptanceRecord.nodeIdentifiers).toEqual([task.contextNodeIdentifier]);
    expect(acceptanceRecord.contextGraphRevision).toBe(before.graph.revision);
  });

  it("跨 Agent 裁决被拒绝，且不写入对方存档（隔离）", async () => {
    await runDevolveMission();
    const { port } = await startGuiOnStateDirectory();
    const task = await findDeferredTask();

    const crossAgent = await decide(port, {
      ownerAgentInstanceId: "another-agent-instance",
      taskIdentifier: task.taskIdentifier,
      decision: "accepted",
    });
    expect(crossAgent.statusCode).toBe(404);
    expect(crossAgent.body).toContain("verification-not-found");
    await expect(
      fs.readdir(
        path.join(stateDirectory, "agent-memory", "another-agent-instance", "acceptances"),
      ),
    ).rejects.toThrow();
  });

  it("上下文图前进后签字过期，409 且不产生签收", async () => {
    await runDevolveMission();
    const { port } = await startGuiOnStateDirectory();
    const task = await findDeferredTask();
    const { graph, graphIdentifier } = await readOwnerGraph(task.ownerAgentInstanceId);

    const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
    await graphStore.markNodeState({
      ownerAgentInstanceId: task.ownerAgentInstanceId,
      graphIdentifier,
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: task.contextNodeIdentifier,
      state: "accepted-closed",
    });

    const stale = await decide(port, {
      ownerAgentInstanceId: task.ownerAgentInstanceId,
      taskIdentifier: task.taskIdentifier,
      decision: "accepted",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain("stale-revision");
    await expect(
      fs.readdir(
        path.join(stateDirectory, "agent-memory", task.ownerAgentInstanceId, "acceptances"),
      ),
    ).rejects.toThrow();
  });

  it("否决重开节点但不破坏已产出产物", async () => {
    await runDevolveMission();
    const { port } = await startGuiOnStateDirectory();
    const task = await findDeferredTask();
    const { graphIdentifier } = await readOwnerGraph(task.ownerAgentInstanceId);

    const rejected = await decide(port, {
      ownerAgentInstanceId: task.ownerAgentInstanceId,
      taskIdentifier: task.taskIdentifier,
      decision: "rejected",
      reason: "产物与预期不符",
    });
    expect(rejected.statusCode).toBe(200);
    const result = JSON.parse(rejected.body) as {
      decision: string;
      reopenedNodeIdentifiers: string[];
    };
    expect(result.decision).toBe("rejected");
    expect(result.reopenedNodeIdentifiers).toEqual([task.contextNodeIdentifier]);

    const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
    const afterGraph = await graphStore.readGraph(
      task.ownerAgentInstanceId,
      graphIdentifier,
    );
    expect(
      afterGraph?.nodes.find(
        (node) => node.contextNodeIdentifier === task.contextNodeIdentifier,
      )?.state,
    ).toBe("reopened");
    // 否决只重开节点，不删除产物；再次列表仍可见该待追认项（未伪造成已签收）。
    const list = await request({ port, method: "GET", path: "/verifications" });
    expect(list.body).toContain(task.taskIdentifier);
  });
});
