/**
 * GUI 本地宿主（GUI-01-R-02）。
 *
 * 边界（对齐旧 GUI-01 卡与 GUI-01-R-01 冻结）：
 * - 只监听 loopback；校验规范化 Host/Origin 与会话 CSRF（SameSite=Strict）；
 * - 只提供脱敏 JSON 与文本转义后的 HTML；不提供通用文件读取 API；
 * - 状态变更经公共应用服务（会话/提交/取消），不在前端复制任何规则；
 * - 状态事件走 SSE，带 revision 与幂等 ID；重连先取完整快照；
 * - 关闭时注销订阅、结束 SSE、释放端口。
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

import type { AgentMode } from "../../../core/src/core/types.js";
import type { PublicAstarrayEvent } from "../../../core/src/public-sdk.js";
import {
  applyGuiEventToTracker,
  buildGuiSnapshot,
  createGuiTaskTracker,
} from "../application/gui-read-model.js";

const MAXIMUM_PROMPT_CHARACTERS = 4000;
const MAXIMUM_REQUEST_BODY_BYTES = 200_000;
/**
 * 禁止进入模型上下文的控制字符码位（保留 \n \r \t：不改变换行语义）。
 * 用码位集合而非正则，避免控制字符出现在源码与正则字面量中。
 */
function createDisallowedControlCharacterCodes(): Set<number> {
  const codes = new Set<number>();
  for (let code = 0x00; code <= 0x1f; code += 1) {
    if (code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      codes.add(code);
    }
  }
  codes.add(0x7f);
  return codes;
}

const DISALLOWED_CONTROL_CHARACTER_CODES = createDisallowedControlCharacterCodes();

/**
 * GUI 依赖的公共应用服务子集（AstarrayApplicationFacade 结构兼容）。
 * GUI 不实现第二套会话/任务/权限逻辑。
 */
export interface GuiApplicationPort {
  subscribe(listener: (event: PublicAstarrayEvent) => void): {
    unsubscribe(): void;
  };
  submitTask(input: {
    sessionId: string;
    taskIdentifier: string;
    prompt: string;
    idempotencyKey?: string;
  }): Promise<{
    taskIdentifier: string;
    missionIdentifier: string | null;
    status: string;
  }>;
  cancelTask(input: {
    sessionId: string;
    taskIdentifier: string;
  }): Promise<void>;
}

export interface GuiServerOptions {
  applicationService: GuiApplicationPort;
  sessionId: string;
  mode: AgentMode;
  /** 监听地址（固定 loopback；仅允许 127.0.0.1/::1）。 */
  host?: string;
  /** 0 = 由操作系统分配端口。 */
  port?: number;
  csrfTokenFactory?: () => string;
}

export interface GuiServerHandle {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

/** 文本转义（HTML 内容/属性安全；禁止未净化的 innerHTML）。 */
export function escapeHtmlText(value: string): string {
  return value
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

/** 输入清洗：去控制字符、限长、去首尾空白（不改变语义）。 */
export function sanitizeUserInput(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !DISALLOWED_CONTROL_CHARACTER_CODES.has(codePoint);
    })
    .join("")
    .slice(0, MAXIMUM_PROMPT_CHARACTERS)
    .trim();
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function isAllowedHostHeader(hostHeader: string | undefined, port: number): boolean {
  if (hostHeader === undefined) {
    return false;
  }
  const normalized = hostHeader.trim().toLowerCase();
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}`
  );
}

function isAllowedOriginHeader(
  originHeader: string | undefined,
  port: number,
): boolean {
  if (originHeader === undefined) {
    // 同源请求（无 Origin，如导航或 curl）允许；状态变更仍需 CSRF。
    return true;
  }
  const normalized = originHeader.trim().toLowerCase();
  return (
    normalized === `http://127.0.0.1:${port}` ||
    normalized === `http://localhost:${port}` ||
    normalized === `http://[::1]:${port}`
  );
}

function renderPage(input: { sessionId: string; mode: AgentMode }): string {
  const sessionId = escapeHtmlText(input.sessionId);
  const mode = escapeHtmlText(input.mode);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Astarray GUI</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
#status { font-weight: 600; }
main { display: grid; gap: 12px; margin-top: 16px; }
section { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 12px; }
textarea { width: 100%; min-height: 96px; }
ul { margin: 8px 0 0; padding-left: 20px; }
</style>
</head>
<body>
<header>
  <h1>Astarray</h1>
  <span>模式：<strong id="mode">${mode}</strong></span>
  <span>会话：<code id="session">${sessionId}</code></span>
  <span id="status">连接中…</span>
</header>
<main>
  <section aria-labelledby="submit-heading">
    <h2 id="submit-heading">提交用户指导</h2>
    <label for="prompt">任务描述</label>
    <textarea id="prompt" name="prompt" aria-describedby="submit-hint"></textarea>
    <p id="submit-hint">提交后输入区保持可用；受理不等于完成。</p>
    <button id="submit" type="button">提交</button>
    <p id="submit-result" role="status" aria-live="polite"></p>
  </section>
  <section aria-labelledby="tasks-heading">
    <h2 id="tasks-heading">任务</h2>
    <ul id="tasks" aria-live="polite"></ul>
  </section>
</main>
<script>
(function () {
  var csrfToken = document.cookie.split("; ").filter(function (entry) {
    return entry.indexOf("gui_csrf=") === 0;
  }).map(function (entry) { return entry.slice("gui_csrf=".length); })[0] || "";
  var statusElement = document.getElementById("status");
  var tasksElement = document.getElementById("tasks");
  var resultElement = document.getElementById("submit-result");
  function renderTasks(tasks) {
    tasksElement.textContent = "";
    (tasks || []).forEach(function (task) {
      var item = document.createElement("li");
      item.textContent = task.taskIdentifier + " · " + task.status + " · r" + task.revision;
      tasksElement.appendChild(item);
    });
  }
  function refreshState() {
    fetch("/state", { headers: { accept: "application/json" } })
      .then(function (response) { return response.json(); })
      .then(function (snapshot) { renderTasks(snapshot.tasks); })
      .catch(function () {});
  }
  document.getElementById("submit").addEventListener("click", function () {
    var prompt = document.getElementById("prompt").value;
    fetch("/commands/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ prompt: prompt, idempotencyKey: "gui-" + Date.now().toString(36) }),
    })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        resultElement.textContent = payload.isCompleted
          ? "已完成"
          : "已受理：" + payload.taskIdentifier + "（受理不等于完成）";
      })
      .catch(function (error) { resultElement.textContent = "提交失败：" + String(error); });
  });
  var source = new EventSource("/events");
  source.onopen = function () { statusElement.textContent = "已连接"; };
  source.onerror = function () { statusElement.textContent = "重连中…"; };
  source.onmessage = function (messageEvent) {
    try {
      var parsed = JSON.parse(messageEvent.data);
      if (parsed.eventType === "task-status" || parsed.eventType === "task-finished") {
        refreshState();
      }
    } catch (error) { /* 忽略非 JSON 事件 */ }
  };
  refreshState();
})();
</script>
</body>
</html>
`;
}

export async function startGuiServer(
  options: GuiServerOptions,
): Promise<GuiServerHandle> {
  const requestedHost = options.host ?? "127.0.0.1";
  if (!isLoopbackAddress(requestedHost)) {
    throw new Error(`GUI 只允许监听 loopback 地址，拒绝: ${requestedHost}`);
  }
  const csrfToken = options.csrfTokenFactory?.() ?? randomBytes(32).toString("hex");
  const tracker = createGuiTaskTracker();
  const sseResponses = new Set<http.ServerResponse>();
  const unsubscribe = options.applicationService.subscribe(
    (event: PublicAstarrayEvent) => {
      applyGuiEventToTracker(tracker, event as never);
      const payload = `id: ${event.idempotencyId}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const response of sseResponses) {
        response.write(payload);
      }
    },
  );

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: "internal-error" }));
    });
  });

  async function readBody(request: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      if (totalBytes > MAXIMUM_REQUEST_BODY_BYTES) {
        throw new Error("请求正文过大");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const port = (server.address() as { port: number }).port;
    const hostHeader = request.headers.host;
    if (
      !isLoopbackAddress(request.socket.remoteAddress ?? undefined) ||
      !isAllowedHostHeader(
        Array.isArray(hostHeader) ? hostHeader[0] : hostHeader,
        port,
      ) ||
      !isAllowedOriginHeader(
        Array.isArray(request.headers.origin)
          ? request.headers.origin[0]
          : request.headers.origin,
        port,
      )
    ) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "loopback-host-origin-required" }));
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const isStateChanging = request.method === "POST";
    if (isStateChanging) {
      const providedToken = request.headers["x-csrf-token"];
      if (
        typeof providedToken !== "string" ||
        providedToken.length !== csrfToken.length ||
        providedToken !== csrfToken
      ) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "csrf-required" }));
        return;
      }
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `gui_csrf=${csrfToken}; Path=/; SameSite=Strict; HttpOnly`,
        "cache-control": "no-store",
      });
      response.end(renderPage({ sessionId: options.sessionId, mode: options.mode }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/state") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify(
          buildGuiSnapshot({
            sessionId: options.sessionId,
            mode: options.mode,
            tracker,
          }),
        ),
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      // 重连（last-event-id）先回完整快照，再由客户端按 revision 继续
      const lastEventId = request.headers["last-event-id"];
      response.write(
        `id: snapshot-${Date.now().toString(36)}\ndata: ${JSON.stringify({
          eventType: "snapshot",
          revision: 0,
          idempotencyId: "snapshot",
          snapshot: buildGuiSnapshot({
            sessionId: options.sessionId,
            mode: options.mode,
            tracker,
          }),
          isReconnect: typeof lastEventId === "string",
        })}\n\n`,
      );
      sseResponses.add(response);
      request.on("close", () => {
        sseResponses.delete(response);
      });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/commands/submit") {
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        prompt?: unknown;
        idempotencyKey?: unknown;
      };
      const prompt = sanitizeUserInput(
        typeof parsedBody.prompt === "string" ? parsedBody.prompt : "",
      );
      if (prompt === "") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "prompt-required" }));
        return;
      }
      const idempotencyKey =
        typeof parsedBody.idempotencyKey === "string" &&
        parsedBody.idempotencyKey !== ""
          ? parsedBody.idempotencyKey
          : undefined;
      const taskIdentifier = `gui-task-${randomBytes(6).toString("hex")}`;
      const submitted = await options.applicationService.submitTask({
        sessionId: options.sessionId,
        taskIdentifier,
        prompt,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      applyGuiEventToTracker(tracker, {
        eventType: "task-status",
        taskIdentifier: submitted.taskIdentifier,
        status: submitted.status,
        missionIdentifier: submitted.missionIdentifier,
        revision: 0,
      });
      response.writeHead(202, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          taskIdentifier: submitted.taskIdentifier,
          missionIdentifier: submitted.missionIdentifier,
          status: submitted.status,
          isCompleted: false,
        }),
      );
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/commands/cancel") {
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        taskIdentifier?: unknown;
      };
      if (typeof parsedBody.taskIdentifier !== "string") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "taskIdentifier-required" }));
        return;
      }
      await options.applicationService.cancelTask({
        sessionId: options.sessionId,
        taskIdentifier: parsedBody.taskIdentifier,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ taskIdentifier: parsedBody.taskIdentifier, status: "cancelled" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not-found" }));
  }

  await new Promise<void>((resolve, reject) => {
    const handleListenError = (error: Error): void => {
      reject(error);
    };
    // 端口冲突等监听失败必须有界拒绝，不允许悬挂。
    server.once("error", handleListenError);
    server.listen(options.port ?? 0, requestedHost, () => {
      server.off("error", handleListenError);
      resolve();
    });
  });
  const address = server.address() as { port: number };
  return {
    host: requestedHost,
    port: address.port,
    url: `http://${requestedHost}:${address.port}/`,
    close: async () => {
      unsubscribe.unsubscribe();
      for (const response of sseResponses) {
        response.end();
      }
      sseResponses.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
