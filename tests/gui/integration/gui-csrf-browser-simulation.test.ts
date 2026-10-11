/**
 * 行为反例（2026-10-10 **真实用户人工体验发现**）：
 * GUI 的状态变更请求**在真实浏览器里必然 403 `csrf-required`**。
 *
 * **用户实测现象**（Windows 11 + 火狐，`127.0.0.1:4675`）：
 *  - 提交后显示 `已受理：undefined（受理不等于完成）`；
 *  - 切换权限组显示 `切换失败：csrf-required`。
 *
 * **根因（自相矛盾）**：前端从 `document.cookie` 读取 `gui_csrf`（页面脚本），
 * 而服务端下发该 cookie 时带了 **`HttpOnly`** ⇒ **JavaScript 永远读不到** ⇒
 * 前端拿到的 token 恒为空字符串 ⇒ 所有 POST 被 CSRF 门禁 403。
 * 提交结果显示 `undefined` 是因为提交处理**不检查 HTTP 状态**，把 403 的错误体
 * （`{"error":"csrf-required"}`）当成成功体解析，`payload.taskIdentifier` 即 undefined。
 *
 * **为什么既有测试发现不了（关键）**：现有用例全部通过
 * `csrfTokenFactory: () => "…"` **直接注入 token** 到请求头，**从不模拟浏览器从页面取
 * token 这一步** ⇒ 属"自证"。本文件专门补上这一步。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-csrf-"));
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
        missionIdentifier: "mission-csrf-probe",
        status: "accepted",
      };
    },
    async cancelTask(_input: { taskIdentifier: string }) {},
  };
}

/** 用**真实的**随机 token 工厂（不注入固定值），才可能暴露本缺陷。 */
async function startServerWithRealToken(): Promise<GuiServerHandle> {
  const handle = await startGuiServer({
    applicationService: createFakeApplicationPort(),
    sessionId: "session-csrf-probe",
    mode: "assist",
  });
  servers.push(handle);
  return handle;
}

function request(input: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
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
          resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body }),
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

/**
 * 模拟**浏览器**取得 CSRF token 的两条合法途径，任一可用即可。
 * 返回 null 表示"页面里根本拿不到 token"（即缺陷状态）。
 */
function extractBrowserAccessibleCsrfToken(input: {
  pageHtml: string;
  setCookieHeader: string;
}): string | null {
  // 途径 1：脚本可读的 cookie（`HttpOnly` 则浏览器不给 document.cookie）
  const isCookieHttpOnly = /HttpOnly/i.test(input.setCookieHeader);
  const cookieToken = /gui_csrf=([^;]+)/.exec(input.setCookieHeader)?.[1] ?? null;
  if (!isCookieHttpOnly && cookieToken !== null && cookieToken !== "") {
    return cookieToken;
  }
  // 途径 2：页面内嵌（跨源读不到页面内容，故仍然安全）
  const embeddedToken =
    /<meta\s+name="gui-csrf-token"\s+content="([^"]+)"/i.exec(input.pageHtml)?.[1] ?? null;
  if (embeddedToken !== null && embeddedToken !== "") {
    return embeddedToken;
  }
  return null;
}

describe("GUI：真实浏览器必须能从页面取得 CSRF token（否则状态变更必然 403）", () => {
  it("① 页面必须给出浏览器可用的 CSRF token（修复前：cookie 是 HttpOnly 且页面未内嵌 ⇒ null）", async () => {
    const handle = await startServerWithRealToken();
    const page = await request({ port: handle.port, method: "GET", path: "/" });
    const setCookieHeader = String(page.headers["set-cookie"] ?? "");

    const browserToken = extractBrowserAccessibleCsrfToken({
      pageHtml: page.body,
      setCookieHeader,
    });
    expect(
      browserToken,
      "浏览器取不到 token ⇒ 所有 POST 必然 403 csrf-required。" +
        "set-cookie=" +
        setCookieHeader,
    ).not.toBeNull();
  });

  it("② 用页面给出的 token 提交任务 ⇒ 必须 202 且响应含真实 taskIdentifier（不得 403）", async () => {
    const handle = await startServerWithRealToken();
    const page = await request({ port: handle.port, method: "GET", path: "/" });
    const browserToken = extractBrowserAccessibleCsrfToken({
      pageHtml: page.body,
      setCookieHeader: String(page.headers["set-cookie"] ?? ""),
    });
    expect(browserToken).not.toBeNull();

    const submitted = await request({
      port: handle.port,
      method: "POST",
      path: "/commands/submit",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": String(browserToken),
      },
      body: JSON.stringify({ prompt: "中文提交测试", idempotencyKey: "k-csrf-1" }),
    });

    expect(submitted.statusCode, "响应体=" + submitted.body).toBe(202);
    const payload = JSON.parse(submitted.body) as { taskIdentifier?: string };
    // 正是用户看到的 `undefined`：403 的错误体里没有 taskIdentifier
    expect(payload.taskIdentifier).toBeTruthy();
  });

  it("③ **submit 处理器**必须在解析响应前检查 HTTP 状态（否则 403 会被显示成成功）", async () => {
    const handle = await startServerWithRealToken();
    const page = await request({ port: handle.port, method: "GET", path: "/" });
    /**
     * 页面脚本内联在 HTML 里，故用**源码断言**钉住"解析前检查 HTTP 状态"这一必需行为。
     *
     * 为什么要**限定在 submit 处理器内**：页面上的 budget / 权限组处理器**本来就**
     * 检查了 `response.ok`（我最初写成全页正则，于是被它们**误判为通过** —— "假绿"）。
     * 真实缺陷恰恰只在 submit 这条路径上。
     */
    const submitHandlerStart = page.body.indexOf('getElementById("submit")');
    expect(submitHandlerStart, "页面里应能找到 submit 处理器").toBeGreaterThan(-1);
    const submitHandlerCode = page.body.slice(submitHandlerStart, submitHandlerStart + 1_200);
    expect(
      submitHandlerCode,
      "submit 处理器未检查 HTTP 状态 ⇒ 403 错误体会被当成成功体、显示 undefined。" +
        "处理器片段=\n" +
        submitHandlerCode,
    ).toMatch(/response\.ok|status\s*(!==|>=)\s*[24]\d\d/);
  });
});
