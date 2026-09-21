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
  // ─── GUI-01-R-03：设置与恢复（可选能力；缺失时服务端显式 501，不静默降级） ───
  queryContextSettings?(): Promise<GuiContextSettingsView>;
  updateContextBudget?(input: {
    expectedRevision: number;
    configuredMaximumGlobalContextTokenCount: number;
  }): Promise<GuiContextSettingsView>;
  getCurrentPermissionProfileReference?(): Promise<GuiPermissionProfileReferenceView | null>;
  listPermissionProfiles?(input: { page: number; pageSize: number }): Promise<{
    profiles: GuiPermissionProfileSummaryView[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  switchPermissionProfile?(
    reference: GuiPermissionProfileReferenceView,
  ): Promise<void>;
  queryRecoveryOverview?(): Promise<GuiRecoveryOverviewView>;
  inspectRecoveryMission?(
    missionIdentifier: string,
  ): Promise<GuiRecoveryMissionView | null>;
  listPendingVerifications?(): Promise<GuiPendingVerificationView[]>;
  recordVerificationDecision?(input: {
    ownerAgentInstanceId: string;
    taskIdentifier: string;
    decision: "accepted" | "rejected";
    reason?: string;
  }): Promise<GuiVerificationDecisionView>;
}

/** GUI-01-R-03：上下文预算 DTO（结构兼容 PublicContextSettings，无内部字段）。 */
export interface GuiContextSettingsView {
  configuredMaximumGlobalContextTokenCount: number;
  effectiveMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  budgetReductionReason: string | null;
  assemblySampleSize: number;
  lastAssemblyBudgetPolicyRevision: number | null;
}

export interface GuiPermissionProfileReferenceView {
  kind: "builtin" | "custom";
  profileId: string;
}

export interface GuiPermissionProfileSummaryView {
  permissionProfileId: string;
  displayName: string;
  isBuiltin: boolean;
  revision: number;
}

/** GUI-01-R-03：恢复 mission 只读视图（不含租约持有进程标识）。 */
export interface GuiRecoveryMissionView {
  missionIdentifier: string;
  exists: boolean;
  reconciliationRequired: boolean;
  status: string | null;
  isCorrupted: boolean;
  pendingTaskCount: number | null;
  hasTrustedCheckpoint: boolean;
  isLeaseActive: boolean;
}

export interface GuiRecoveryOverviewView {
  missions: GuiRecoveryMissionView[];
  requiresDecisionMissions: string[];
}

/** GUI-01-R-03b：待追认项（按 owner Agent 隔离，不合并上下文）。 */
export interface GuiPendingVerificationView {
  ownerAgentInstanceId: string;
  taskIdentifier: string;
  contextNodeIdentifier: string;
  contextGraphRevision: number;
  humanSteps: string;
  risks: string[];
  artifactOrCommitReferences: string[];
  automaticTestReferences: string[];
  createdAtIso: string;
}

export interface GuiVerificationDecisionView {
  ownerAgentInstanceId: string;
  taskIdentifier: string;
  decision: "accepted" | "rejected";
  acceptanceIdentifier: string | null;
  reopenedNodeIdentifiers: string[];
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
  <section aria-labelledby="settings-heading">
    <h2 id="settings-heading">设置（上下文预算与权限组）</h2>
    <p id="budget" aria-live="polite">读取中…</p>
    <label for="budget-tokens">全局上下文预算（token）</label>
    <input id="budget-tokens" name="budget-tokens" type="number" min="0" step="1" />
    <button id="save-budget" type="button">保存预算</button>
    <p id="budget-result" role="status" aria-live="polite"></p>
    <label for="profile">权限组</label>
    <select id="profile"></select>
    <button id="switch-profile" type="button">切换权限组</button>
    <p id="profile-result" role="status" aria-live="polite"></p>
  </section>
  <section aria-labelledby="recovery-heading">
    <h2 id="recovery-heading">恢复中心（只读状态与差异）</h2>
    <button id="refresh-recovery" type="button">刷新</button>
    <ul id="recovery" aria-live="polite"></ul>
  </section>
  <section aria-labelledby="verifications-heading">
    <h2 id="verifications-heading">待追认（按 Agent 隔离）</h2>
    <button id="refresh-verifications" type="button">刷新</button>
    <ul id="verifications" aria-live="polite"></ul>
    <p id="verification-result" role="status" aria-live="polite"></p>
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
  var budgetElement = document.getElementById("budget");
  var budgetResultElement = document.getElementById("budget-result");
  var budgetTokensElement = document.getElementById("budget-tokens");
  var profileElement = document.getElementById("profile");
  var profileResultElement = document.getElementById("profile-result");
  var recoveryElement = document.getElementById("recovery");
  var currentBudgetRevision = null;
  function refreshSettings() {
    fetch("/settings", { headers: { accept: "application/json" } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        var context = payload.context;
        if (!context) { budgetElement.textContent = "预算能力不可用"; return; }
        budgetElement.textContent = "配置 " + context.configuredMaximumGlobalContextTokenCount +
          " token · 生效 " + context.effectiveMaximumGlobalContextTokenCount +
          " token · r" + context.budgetPolicyRevision +
          " · 装配样本 " + context.assemblySampleSize +
          (context.lastAssemblyBudgetPolicyRevision === null
            ? ""
            : " · 最近装配 r" + context.lastAssemblyBudgetPolicyRevision);
        currentBudgetRevision = context.budgetPolicyRevision;
        budgetTokensElement.value = String(context.configuredMaximumGlobalContextTokenCount);
        var profiles = payload.permissionProfiles || {};
        profileElement.textContent = "";
        (profiles.available || []).forEach(function (profile) {
          var option = document.createElement("option");
          option.value = profile.permissionProfileId;
          option.textContent = profile.displayName +
            (profiles.current && profiles.current.profileId === profile.permissionProfileId ? "（当前）" : "");
          profileElement.appendChild(option);
        });
      })
      .catch(function () {});
  }
  document.getElementById("save-budget").addEventListener("click", function () {
    var tokens = parseInt(budgetTokensElement.value, 10);
    fetch("/commands/set-context-budget", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        expectedRevision: currentBudgetRevision,
        configuredMaximumGlobalContextTokenCount: tokens,
      }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { isOk: response.ok, payload: payload };
        });
      })
      .then(function (outcome) {
        budgetResultElement.textContent = outcome.isOk
          ? "已保存 r" + outcome.payload.context.budgetPolicyRevision
          : "保存失败：" + outcome.payload.error;
        refreshSettings();
      })
      .catch(function (error) { budgetResultElement.textContent = "保存失败：" + String(error); });
  });
  document.getElementById("switch-profile").addEventListener("click", function () {
    var profileId = profileElement.value;
    var isBuiltin = ["ponder", "assist", "devolve"].indexOf(profileId) !== -1;
    fetch("/commands/switch-permission-profile", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ kind: isBuiltin ? "builtin" : "custom", profileId: profileId }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { isOk: response.ok, payload: payload };
        });
      })
      .then(function (outcome) {
        profileResultElement.textContent = outcome.isOk
          ? "已切换到 " + outcome.payload.reference.profileId
          : "切换失败：" + outcome.payload.error;
        refreshSettings();
      })
      .catch(function (error) { profileResultElement.textContent = "切换失败：" + String(error); });
  });
  function refreshRecovery() {
    fetch("/recovery", { headers: { accept: "application/json" } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        recoveryElement.textContent = "";
        var missions = payload.missions || [];
        if (missions.length === 0) {
          var emptyItem = document.createElement("li");
          emptyItem.textContent = "无可恢复 mission";
          recoveryElement.appendChild(emptyItem);
          return;
        }
        missions.forEach(function (mission) {
          var item = document.createElement("li");
          item.textContent = mission.missionIdentifier + " · " + (mission.status || "未知") +
            (mission.isCorrupted ? " · 损坏" : "") +
            (mission.isLeaseActive ? " · 租约活跃" : "") +
            (mission.hasTrustedCheckpoint ? " · 有可信检查点" : "") +
            (mission.reconciliationRequired ? " · 需先对账" : "");
          recoveryElement.appendChild(item);
        });
      })
      .catch(function () {});
  }
  document.getElementById("refresh-recovery").addEventListener("click", refreshRecovery);
  var verificationsElement = document.getElementById("verifications");
  var verificationResultElement = document.getElementById("verification-result");
  function decideVerification(entry, decision) {
    fetch("/commands/verification-decision", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        ownerAgentInstanceId: entry.ownerAgentInstanceId,
        taskIdentifier: entry.taskIdentifier,
        decision: decision,
        reason: "GUI 人工裁决",
      }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { isOk: response.ok, payload: payload };
        });
      })
      .then(function (outcome) {
        if (!outcome.isOk) {
          verificationResultElement.textContent = "裁决失败：" + outcome.payload.error;
        } else if (outcome.payload.decision === "accepted") {
          verificationResultElement.textContent = "已追认：" + outcome.payload.acceptanceIdentifier;
        } else {
          verificationResultElement.textContent = "已否决，重开节点：" +
            (outcome.payload.reopenedNodeIdentifiers || []).join(", ");
        }
        refreshVerifications();
      })
      .catch(function (error) { verificationResultElement.textContent = "裁决失败：" + String(error); });
  }
  function renderVerifications(entries) {
    verificationsElement.textContent = "";
    if (entries.length === 0) {
      var emptyItem = document.createElement("li");
      emptyItem.textContent = "无待追认项";
      verificationsElement.appendChild(emptyItem);
      return;
    }
    entries.forEach(function (entry) {
      var item = document.createElement("li");
      var label = document.createElement("span");
      label.textContent = entry.ownerAgentInstanceId + " · " + entry.taskIdentifier +
        " · 节点 " + entry.contextNodeIdentifier +
        " · r" + entry.contextGraphRevision +
        " · " + entry.humanSteps;
      item.appendChild(label);
      [["accepted", "追认"], ["rejected", "否决"]].forEach(function (pair) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = pair[1];
        button.addEventListener("click", function () { decideVerification(entry, pair[0]); });
        item.appendChild(button);
      });
      verificationsElement.appendChild(item);
    });
  }
  function refreshVerifications() {
    fetch("/verifications", { headers: { accept: "application/json" } })
      .then(function (response) { return response.json(); })
      .then(function (payload) { renderVerifications(payload.entries || []); })
      .catch(function () {});
  }
  document.getElementById("refresh-verifications").addEventListener("click", refreshVerifications);
  refreshSettings();
  refreshRecovery();
  refreshVerifications();
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

  function writeJsonResponse(
    response: http.ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }

  function writeCapabilityUnavailable(response: http.ServerResponse): void {
    writeJsonResponse(response, 501, { error: "capability-unavailable" });
  }

  function readApplicationErrorCode(error: unknown): string | null {
    if (error === null || typeof error !== "object") {
      return null;
    }
    const candidate = (error as { errorCode?: unknown }).errorCode;
    return typeof candidate === "string" ? candidate : null;
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
    if (request.method === "GET" && requestUrl.pathname === "/settings") {
      const applicationService = options.applicationService;
      const contextSettings =
        applicationService.queryContextSettings === undefined
          ? null
          : await applicationService.queryContextSettings();
      const currentReference =
        applicationService.getCurrentPermissionProfileReference === undefined
          ? null
          : await applicationService.getCurrentPermissionProfileReference();
      const profilePage =
        applicationService.listPermissionProfiles === undefined
          ? null
          : await applicationService.listPermissionProfiles({
              page: 1,
              pageSize: 50,
            });
      writeJsonResponse(response, 200, {
        sessionId: options.sessionId,
        mode: options.mode,
        context: contextSettings,
        permissionProfiles: {
          current: currentReference,
          available: profilePage?.profiles ?? [],
          total: profilePage?.total ?? 0,
        },
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/recovery") {
      const applicationService = options.applicationService;
      if (applicationService.queryRecoveryOverview === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      writeJsonResponse(
        response,
        200,
        await applicationService.queryRecoveryOverview(),
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/verifications") {
      const applicationService = options.applicationService;
      if (applicationService.listPendingVerifications === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      writeJsonResponse(response, 200, {
        entries: await applicationService.listPendingVerifications(),
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/commands/verification-decision"
    ) {
      const applicationService = options.applicationService;
      if (applicationService.recordVerificationDecision === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        ownerAgentInstanceId?: unknown;
        taskIdentifier?: unknown;
        decision?: unknown;
        reason?: unknown;
      };
      const ownerAgentInstanceId = parsedBody.ownerAgentInstanceId;
      const taskIdentifier = parsedBody.taskIdentifier;
      const decision = parsedBody.decision;
      if (
        typeof ownerAgentInstanceId !== "string" ||
        ownerAgentInstanceId === "" ||
        typeof taskIdentifier !== "string" ||
        taskIdentifier === "" ||
        (decision !== "accepted" && decision !== "rejected")
      ) {
        writeJsonResponse(response, 400, { error: "invalid-arguments" });
        return;
      }
      try {
        const result = await applicationService.recordVerificationDecision({
          ownerAgentInstanceId,
          taskIdentifier,
          decision,
          ...(typeof parsedBody.reason === "string"
            ? { reason: parsedBody.reason }
            : {}),
        });
        writeJsonResponse(response, 200, result);
      } catch (error) {
        const errorCode = readApplicationErrorCode(error);
        if (errorCode === "stale-revision") {
          writeJsonResponse(response, 409, { error: "stale-revision" });
          return;
        }
        if (
          errorCode === "verification-not-found" ||
          errorCode === "verification-context-missing"
        ) {
          writeJsonResponse(response, 404, { error: errorCode });
          return;
        }
        throw error;
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/commands/set-context-budget"
    ) {
      const applicationService = options.applicationService;
      if (applicationService.updateContextBudget === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        expectedRevision?: unknown;
        configuredMaximumGlobalContextTokenCount?: unknown;
      };
      const expectedRevision = parsedBody.expectedRevision;
      const configuredMaximumGlobalContextTokenCount =
        parsedBody.configuredMaximumGlobalContextTokenCount;
      if (
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 1 ||
        typeof configuredMaximumGlobalContextTokenCount !== "number" ||
        !Number.isInteger(configuredMaximumGlobalContextTokenCount) ||
        configuredMaximumGlobalContextTokenCount < 0
      ) {
        writeJsonResponse(response, 400, { error: "invalid-arguments" });
        return;
      }
      try {
        const updated = await applicationService.updateContextBudget({
          expectedRevision,
          configuredMaximumGlobalContextTokenCount,
        });
        writeJsonResponse(response, 200, { context: updated });
      } catch (error) {
        const errorCode = readApplicationErrorCode(error);
        if (errorCode === "stale-revision") {
          writeJsonResponse(response, 409, { error: "stale-revision" });
          return;
        }
        throw error;
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/commands/switch-permission-profile"
    ) {
      const applicationService = options.applicationService;
      if (applicationService.switchPermissionProfile === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        kind?: unknown;
        profileId?: unknown;
      };
      const kind = parsedBody.kind;
      const profileId = parsedBody.profileId;
      const isBuiltinProfileId =
        profileId === "ponder" || profileId === "assist" || profileId === "devolve";
      if (
        (kind !== "builtin" && kind !== "custom") ||
        typeof profileId !== "string" ||
        profileId === "" ||
        (kind === "builtin" && !isBuiltinProfileId)
      ) {
        writeJsonResponse(response, 400, { error: "invalid-arguments" });
        return;
      }
      try {
        await applicationService.switchPermissionProfile({
          kind,
          profileId,
        });
      } catch (error) {
        const errorCode = readApplicationErrorCode(error);
        if (errorCode === "permission-profile-not-found") {
          writeJsonResponse(response, 404, {
            error: "permission-profile-not-found",
          });
          return;
        }
        throw error;
      }
      writeJsonResponse(response, 200, {
        status: "switched",
        reference: { kind, profileId },
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
