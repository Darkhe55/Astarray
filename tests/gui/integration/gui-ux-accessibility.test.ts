/**
 * GUI-01-R-04a：页面可访问性/离线自足静态断言与资源观察（补充证据；
 * 真实键盘/中文/缩放/可访问性人工结论仍由人工验收，不以本文件替代）。
 */
import http from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

const CSRF_TOKEN = "csrf-token-ux";
let servers: Array<{ close(): Promise<void> }>;

beforeEach(() => {
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => {});
  }
});

function createMinimalPort(onUnsubscribe: () => void) {
  return {
    subscribe: (_listener: unknown) => ({
      unsubscribe: () => {
        onUnsubscribe();
      },
    }),
    submitTask: async (input: { taskIdentifier: string }) => ({
      taskIdentifier: input.taskIdentifier,
      missionIdentifier: null,
      status: "accepted",
    }),
    cancelTask: async () => {},
  };
}

function getPage(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
        headers: { host: `127.0.0.1:${port}` },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => resolve(body));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("GUI-01-R-04a 页面可访问性与离线自足", () => {
  it("声明语言/视口/配色方案，且不加载任何外部资源", async () => {
    const handle = await startGuiServer({
      applicationService: createMinimalPort(() => {}),
      sessionId: "session-ux",
      mode: "assist",
      csrfTokenFactory: () => CSRF_TOKEN,
    });
    servers.push(handle);
    const page = await getPage(handle.port);

    expect(page).toContain('lang="zh-CN"');
    expect(page).toContain('name="viewport"');
    expect(page).toContain("color-scheme: light dark");
    // 离线自足：无外部脚本/样式/字体/CDN 依赖。
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+href=/i);
    expect(page).not.toContain("https://");
    // 不注入未净化 HTML（仅文本写入）。
    expect(page).not.toContain("innerHTML");
  });

  it("表单控件均有 label 关联，动态区域声明 aria-live", async () => {
    const handle = await startGuiServer({
      applicationService: createMinimalPort(() => {}),
      sessionId: "session-ux",
      mode: "assist",
      csrfTokenFactory: () => CSRF_TOKEN,
    });
    servers.push(handle);
    const page = await getPage(handle.port);

    for (const controlId of [
      "prompt",
      "budget-tokens",
      "profile",
    ]) {
      expect(page).toContain(`id="${controlId}"`);
      expect(page).toContain(`for="${controlId}"`);
    }
    for (const liveRegionId of [
      "status",
      "submit-result",
      "budget-result",
      "profile-result",
      "recovery",
      "verifications",
      "verification-result",
    ]) {
      expect(page).toContain(`id="${liveRegionId}"`);
    }
    expect((page.match(/aria-live="polite"/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // 所有按钮显式 type=button，避免表单隐式提交。
    expect(page).not.toMatch(/<button(?![^>]*type=)/);
  });

  it("关闭服务时释放事件订阅并结束 SSE 连接（资源观察）", async () => {
    let isUnsubscribed = false;
    let isSseClosed = false;
    const handle = await startGuiServer({
      applicationService: createMinimalPort(() => {
        isUnsubscribed = true;
      }),
      sessionId: "session-ux",
      mode: "assist",
      csrfTokenFactory: () => CSRF_TOKEN,
    });
    servers.push(handle);

    const sseFinished = new Promise<void>((resolve) => {
      const streamRequest = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          method: "GET",
          path: "/events",
          headers: {
            host: `127.0.0.1:${handle.port}`,
            accept: "text/event-stream",
          },
        },
        (incoming) => {
          incoming.setEncoding("utf8");
          incoming.on("data", () => {
            // 首帧快照到达后等待服务端关闭。
          });
          incoming.on("close", () => {
            isSseClosed = true;
            resolve();
          });
          incoming.on("end", () => {
            isSseClosed = true;
            resolve();
          });
        },
      );
      streamRequest.on("error", () => resolve());
      streamRequest.end();
      setTimeout(() => resolve(), 5_000);
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await handle.close();
    await sseFinished;

    expect(isUnsubscribed).toBe(true);
    expect(isSseClosed).toBe(true);
    // 关闭后端口可再次绑定（无残留监听）。
    const restarted = await startGuiServer({
      applicationService: createMinimalPort(() => {}),
      sessionId: "session-ux",
      mode: "assist",
      port: handle.port,
      csrfTokenFactory: () => CSRF_TOKEN,
    });
    servers.push(restarted);
    expect(restarted.port).toBe(handle.port);
  });
});
