/**
 * 行为反例（2026-10-10 **真实用户人工体验发现**）：
 * 断线重连后客户端**丢弃首帧快照** ⇒ 任务列表既不清空也不更新。
 *
 * **用户实测**（Windows 11 + 火狐，`127.0.0.1:9485`）：我杀掉 GUI 进程并在**同一端口**
 * 重启后，用户页面「任务列表未清空，也没有显示重连等提示」。
 * 用户猜测是浏览器问题 —— **实测不是**。
 *
 * **根因**：服务端确实在重连时先回**完整快照**（`gui-server.ts:983-993`：
 * `eventType: "snapshot"`，内含 `snapshot.tasks`）。但客户端脚本的事件处理只认两种类型：
 *
 * ```js
 * source.onmessage = function (messageEvent) {
 *   var parsed = JSON.parse(messageEvent.data);
 *   if (parsed.eventType === "task-status" || parsed.eventType === "task-finished") {
 *     refreshState();
 *   }
 * };
 * ```
 *
 * ⇒ `snapshot` 被**静默丢弃**：不调用 `refreshState()`，界面因此保留**旧会话的陈旧任务列表**，
 * 也看不到重连后的真实状态。EventSource 的自动重连本身是好的（火狐行为正常），
 * 坏的是**客户端没有消费快照**。
 *
 * **为什么既有 72 个 GUI 测试没发现**：唯一涉及快照的断言是
 * `gui-server.test.ts:320` 的 `expect(streamText).toContain("snapshot")` —— 只验证
 * **服务端发了**这个事件，从不验证**客户端会不会处理**。又是"只测我们发出去的东西"。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PublicAstarrayEvent } from "../../../packages/core/src/public-sdk.js";
import {
  startGuiServer,
  type GuiServerHandle,
} from "../../../packages/gui/src/server/gui-server.js";

let stateDirectory: string;
let servers: GuiServerHandle[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-snapshot-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => {});
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function createFakeApplicationPort() {
  return {
    subscribe(_listener: (event: PublicAstarrayEvent) => void) {
      return { unsubscribe: () => {} };
    },
    async submitTask(input: { taskIdentifier: string; prompt: string }) {
      return {
        taskIdentifier: input.taskIdentifier,
        missionIdentifier: "mission-snapshot-probe",
        status: "accepted",
      };
    },
    async cancelTask(_input: { taskIdentifier: string }) {},
  };
}

async function startServer(): Promise<GuiServerHandle> {
  const handle = await startGuiServer({
    applicationService: createFakeApplicationPort(),
    sessionId: "session-snapshot-probe",
    mode: "assist",
  });
  servers.push(handle);
  return handle;
}

function request(input: {
  port: number;
  method: string;
  path: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port: input.port, method: input.method, path: input.path },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => resolve({ statusCode: incoming.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/**
 * 抽出页面脚本里的 `source.onmessage` 处理器（客户端消费事件的全部逻辑）。
 * 取到下一个顶层 `};` 为止 —— 足够判定它是否处理 `snapshot`。
 */
function extractClientOnMessageHandler(pageHtml: string): string {
  const anchorIndex = pageHtml.indexOf("source.onmessage");
  expect(anchorIndex, "页面脚本应包含 source.onmessage 处理器").toBeGreaterThan(-1);
  const terminatorIndex = pageHtml.indexOf("};", anchorIndex);
  const endIndex = terminatorIndex === -1 ? pageHtml.length : terminatorIndex + 2;
  return pageHtml.slice(anchorIndex, endIndex);
}

describe("GUI：断线重连后客户端必须消费首帧快照", () => {
  it("① 页面脚本的 onmessage 处理器必须处理 snapshot 事件（修复前只认 task-status/task-finished）", async () => {
    const handle = await startServer();
    const page = await request({ port: handle.port, method: "GET", path: "/" });
    const handlerCode = extractClientOnMessageHandler(page.body);

    expect(
      handlerCode,
      "客户端忽略 snapshot ⇒ 重连后列表保留旧会话任务、既不清空也不更新。处理器片段=\n" +
        handlerCode,
    ).toMatch(/snapshot/);
  });

  /**
   * 前提守卫：本缺陷只有在**服务端仍发 snapshot**时才成立；若将来服务端不再发该事件，
   * ① 就失去意义，本守卫会先失败以提示复核。
   *
   * 这里**不**去请求 `/events` —— 它是**永不结束的流**，按普通请求读会在超时上挂死
   * （我最初的写法正是如此）。服务端"确实发出了 snapshot"由
   * `tests/gui/integration/gui-server.test.ts` 的流断言覆盖。
   */
  it("② 服务端代码路径仍会发出 snapshot 事件（前提守卫）", async () => {
    const serverSource = await fs.readFile(
      path.join(
        process.cwd(),
        "packages",
        "gui",
        "src",
        "server",
        "gui-server.ts",
      ),
      "utf8",
    );
    expect(
      serverSource,
      "服务端不再发 snapshot ⇒ 请复核本文件的适用性",
    ).toContain('eventType: "snapshot"');
  });
});
