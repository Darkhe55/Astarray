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
  /**
   * SMART-01-04：指令窗口只读查询（可选能力；缺失时快照返回空窗口，
   * 不伪造指令、也不阻塞既有 /state 与 SSE 快照）。
   * 签名与公共 facade `queryInstructionWindow({ sessionId })` 对齐。
   */
  queryInstructionWindow?(input: { sessionId: string }): Promise<{
    windowCapacity: number;
    activeInstructions: Array<{
      instructionIdentifier: string;
      instructionText: string;
      state: string;
      admittedAtIso: string;
    }>;
    queuedInstructions: Array<{
      instructionIdentifier: string;
      instructionText: string;
      state: string;
      admittedAtIso: string;
    }>;
  }>;
  /**
   * PROJECT-01-04：跨项目授权只读列表（可选能力；缺失时快照返回空列表，
   * 不伪造授权、也不阻塞既有 /state 与 SSE 快照）。
   */
  listCrossProjectAuthorizations?(): Promise<
    Array<{
      authorizationIdentifier: string;
      sourceProjectIdentifier: string;
      targetProjectIdentifier: string;
      operationKind: "read" | "import-copy";
      state: string;
      taskIdentifier: string;
    }>
  >;
  /**
   * TOOLKIT-01-04：工具包版本与升级差异只读快照（可选能力）。
   *
   * 缺失时视图回落为空（**不伪造**条目），且**不阻塞**既有 `/state` 与 SSE 快照。
   * 卡内 §11 要求用户"能看懂升级权限差异并拒绝"，因此该能力必须可被界面取到。
   */
  listToolPackages?(): Promise<{    versions: Array<{
      toolPackageId: string;
      version: number;
      contentHash: string;
      revision: number;
      scope: string;
      status: string;
      readableName: string;
      sourceProjectIdentifier: string;
      enabledProjectIdentifiers: string[];
    }>;
    upgradeDifferences: Array<{
      toolPackageId: string;
      fromVersion: number;
      toVersion: number;
      addedSideEffects: string[];
      removedSideEffects: string[];
      dependencyDifferences: string[];
      permissionDifferences: string[];
      requiresReauthorization: boolean;
    }>;
  }>;
  /**
   * MERGE-01-03：参数授权设置**只读**快照（可选能力）。
   *
   * 卡内检查点 03 要求"CLI/TUI/GUI/SDK 设置一致"。GUI **只读**：
   * "扩大权限需既有认证用户确认"，故此处**不提供写入**，缺失时视图如实报"未知"。
   */
  queryParameterAuthorizationSettings?(): Promise<{
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
    configurationRevision: number;
    ruleCount: number;
  }>;
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
  /**
   * GUI-02-02（2026-10-11）：**待授权列表**。
   *
   * 只读：不得触发模型调用、不得注入上下文、不得自动恢复任务（用户明确要求）。
   */
  listPendingPermissionAsks?(): Promise<GuiPendingPermissionAskView[]>;
  /**
   * GUI-02-02（2026-10-11）：**裁决入口**。
   *
   * 只接受**请求锚点与裁决**，不接受前端提交的新参数；服务器从本地权威记录
   * 取原始参数并重新校验主体、权限、期限与当前状态（用户明确要求）。
   */
  decidePermissionAsk?(input: {
    ownerAgentInstanceId: string;
    askIdentifier: string;
    decision: "allowed-once" | "denied";
    expectedRequestRevision: number;
    expectedOperationFingerprint: string;
  }): Promise<GuiPermissionAskDecisionView>;
  /**
   * GUI-02-02 **专用流程**（2026-10-12）：**待决安装询问**列表。
   *
   * 安装**不走**普通权限询问（门禁自带完整判定：询问已有资源 → 独立开关 →
   * `askAllowOnce` → 授权 → 执行前复检）⇒ 这是**独立只读入口**；
   * 未开启界面安装通道时返回空数组（**不是**"已授权"）。
   */
  listPendingInstallationInquiries?(): Promise<GuiInstallationInquiryView[]>;
  /**
   * GUI-02-02 **专用流程**：回答安装询问（**独立裁决入口**，不与权限询问混用）。
   *
   * 阶段 1 回答"是否已有资源"；阶段 2 回答"是否允许本次安装"。
   * 必须带 `expectedRevision`（过期/重复回答被拒 ⇒ **不复用旧回答**）。
   */
  decideInstallationInquiry?(input: {
    inquiryIdentifier: string;
    expectedRevision: number;
    stage: "existing-resource" | "allow-once";
    /** 阶段 1：是否有资源（`has-resource` 时必须给引用）。 */
    answerKind?: "has-resource" | "no-resource";
    resourceReference?: string;
    /** 阶段 2：是否允许本次安装。 */
    allowOnceDecision?: "allow-once" | "deny";
  }): Promise<GuiInstallationInquiryDecisionView>;
}

/** GUI-02-02 专用流程：待决安装询问视图（只含界面判断所需字段）。 */
export interface GuiInstallationInquiryView {
  inquiryIdentifier: string;
  stage: "existing-resource" | "allow-once";
  summary: string;
  revision: number;
  createdAtIso: string;
  /** 阶段 2 的精确安装计划（供用户判断；阶段 1 为 null）。 */
  installationPlan: {
    packageOrRepositoryIdentifier: string;
    pinnedVersionOrCommit: string | null;
    targetPathOrScope: string;
    packageManager: string;
    expectedChangesSummary: string;
    requiresNetwork: boolean;
    hasInstallScripts: boolean;
  } | null;
}

/** GUI-02-02 专用流程：安装询问裁决结果视图。 */
export interface GuiInstallationInquiryDecisionView {
  inquiryIdentifier: string;
  status: string;
  revision: number;
}

/**
 * GUI-02-02：待授权条目视图（**只含界面所需字段**）。
 *
 * **不得携带原始 `argumentsJson`** —— 长内容与敏感值经核心的安全预览
 * （脱敏 + 限长 + 敏感路径回退受控详情）后才可出现在界面上。
 */
export interface GuiPendingPermissionAskView {
  ownerAgentInstanceId: string;
  askIdentifier: string;
  taskIdentifier: string;
  toolName: string;
  action: string;
  operationFingerprint: string;
  requestRevision: number;
  status: string;
  createdAtIso: string;
  expiresAtIso: string | null;
  /** 结构化安全预览（与公共事件同源，白名单字段）。 */
  preview: Record<string, unknown>;
}

/** GUI-02-02：裁决结果视图。 */
export interface GuiPermissionAskDecisionView {
  askIdentifier: string;
  status: string;
  requestRevision: number;
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
  /**
   * SMART-01-04 / OBS 入口补做：可观测性概览的只读状态目录。
   * 未提供时不暴露 /observability 端点（保持既有行为不变）。
   */
  observabilityStateDirectory?: string;
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

/**
 * 渲染工作台页面。
 *
 * **2026-10-10 真实浏览器修复（用户人工体验发现）**：本函数现在接收并**内嵌**
 * CSRF token。此前页面脚本从 `document.cookie` 读取 `gui_csrf`，而该 cookie 由服务端
 * 以 **`HttpOnly`** 下发 ⇒ **JavaScript 永远读不到** ⇒ 前端 token 恒为空 ⇒
 * 所有状态变更 POST 被 CSRF 门禁 403（用户实测：提交显示 `已受理：undefined`、
 * 切换权限组显示 `切换失败：csrf-required`）。
 *
 * 内嵌是**安全等价**的更优解：跨源页面**读不到**我们的 HTML（同源策略），
 * 故内嵌 token 不会泄漏给攻击者；同时可**保留 `HttpOnly`**（cookie 仍不被脚本读取），
 * 比"去掉 HttpOnly 让 JS 读 cookie"更保守。
 */
function renderPage(input: {
  sessionId: string;
  mode: AgentMode;
  csrfToken: string;
}): string {
  const sessionId = escapeHtmlText(input.sessionId);
  const mode = escapeHtmlText(input.mode);
  const csrfToken = escapeHtmlText(input.csrfToken);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="gui-csrf-token" content="${csrfToken}" />
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
  <section aria-labelledby="permission-asks-heading">
    <h2 id="permission-asks-heading">待授权（按 Agent 隔离）</h2>
    <p>
      以下请求需要你本人裁决。默认不会选中任何选项；系统不提供一键批准全部。
      裁决只对本次这一条、当前这一版有效。
    </p>
    <button id="refresh-permission-asks" type="button">刷新</button>
    <ul id="permission-asks" aria-live="polite"></ul>
    <p id="permission-ask-result" role="status" aria-live="polite"></p>
  </section>
  <section aria-labelledby="installation-inquiries-heading">
    <h2 id="installation-inquiries-heading">待安装询问（专用流程，独立于上方授权卡）</h2>
    <p>
      安装不走上方的普通授权卡：安装门禁会先问"是否已有可用资源"，
      再展示精确安装计划请你逐次确认。默认不会选中任何选项。
      未回答即视为拒绝（不会自动安装）。
    </p>
    <button id="refresh-installation-inquiries" type="button">刷新</button>
    <ul id="installation-inquiries" aria-live="polite"></ul>
    <p id="installation-inquiry-result" role="status" aria-live="polite"></p>
  </section>
</main>
<script>
(function () {
  /**
   * CSRF token 来源：**优先读页面内嵌的 meta**（2026-10-10 修复）。
   * 服务端以 HttpOnly 下发 gui_csrf cookie，脚本**读不到**它；此前只读 cookie
   * 导致 token 恒为空、所有状态变更 403。保留 cookie 读取作为后备兼容。
   */
  var csrfTokenMeta = document.querySelector('meta[name="gui-csrf-token"]');
  var csrfToken = (csrfTokenMeta && csrfTokenMeta.getAttribute("content")) ||
    document.cookie.split("; ").filter(function (entry) {
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
      .then(function (response) {
        /**
         * **2026-10-10 修复**：此前**不检查 HTTP 状态**，于是 403 的错误体
         * （{"error":"csrf-required"}）被当成成功体解析，界面显示
         * 「已受理：undefined」—— 把**失败**呈现成了**受理**。
         */
        return response.json().then(function (payload) {
          return { isOk: response.ok, payload: payload };
        });
      })
      .then(function (outcome) {
        if (!outcome.isOk) {
          resultElement.textContent =
            "提交失败：" + (outcome.payload && outcome.payload.error
              ? outcome.payload.error
              : "未知错误");
          return;
        }
        resultElement.textContent = outcome.payload.isCompleted
          ? "已完成"
          : "已受理：" + outcome.payload.taskIdentifier + "（受理不等于完成）";
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
  /**
   * GUI-02-02 片3（2026-10-11）：**待授权**的呈现与裁决。
   *
   * 设计要点（用户明确要求）：
   * - **独立详情卡**：每条请求一张卡，逐卡给出"批准本次/拒绝"；
   * - **不默认选中批准**：卡片里没有任何预选控件，必须用户**主动点击**某个按钮；
   * - **不提供一键批准全部**：界面没有任何"全部批准"入口；
   * - 卡片展示**本地生成的安全预览**（脱敏 + 限长），**不展示原始参数**；
   * - 批准按钮文案明确带期限语义（"仅本次"），避免被理解为长期授权；
   * - 裁决携带 requestRevision 与 operationFingerprint ⇒ 过期或参数变化时
   *   服务端返回 **409**，界面提示"该请求已变化，请刷新后重新裁决"（**不复用**旧批准）。
   */
  var permissionAsksElement = document.getElementById("permission-asks");
  var permissionAskResultElement = document.getElementById("permission-ask-result");
  function renderPermissionAsks(entries) {
    permissionAsksElement.textContent = "";
    if (entries.length === 0) {
      var emptyItem = document.createElement("li");
      emptyItem.textContent = "无待授权请求";
      permissionAsksElement.appendChild(emptyItem);
      return;
    }
    entries.forEach(function (entry) {
      var item = document.createElement("li");
      var card = document.createElement("article");
      card.setAttribute("aria-label", "待授权请求 " + entry.askIdentifier);

      var title = document.createElement("h3");
      title.textContent = "请求：" + entry.action + " " + entry.toolName;
      card.appendChild(title);

      var identity = document.createElement("p");
      identity.textContent = "发起 Agent：" + entry.ownerAgentInstanceId +
        "｜任务：" + entry.taskIdentifier +
        "｜当前版本 r" + entry.requestRevision;
      card.appendChild(identity);

      var preview = entry.preview || {};
      var details = document.createElement("dl");
      function appendDetail(labelText, valueText) {
        if (valueText === undefined || valueText === null || valueText === "") {
          return;
        }
        var term = document.createElement("dt");
        term.textContent = labelText;
        var description = document.createElement("dd");
        description.textContent = String(valueText);
        details.appendChild(term);
        details.appendChild(description);
      }
      appendDetail("目标", preview.targetPathRelative);
      appendDetail("影响范围", preview.impactScope);
      appendDetail("内容长度", preview.contentLength);
      appendDetail("文件数", preview.fileCount);
      appendDetail("差异预览", preview.diffPreview);
      appendDetail("说明", preview.explanation || entry.toolName);
      card.appendChild(details);

      if (preview.requiresControlledDetail === true) {
        var controlled = document.createElement("p");
        controlled.setAttribute("role", "note");
        controlled.textContent =
          "该操作涉及敏感路径：界面只显示受控摘要，不显示内容与差异。" +
          "如无法据此判断，请改用受控详情流程，不要盲目批准。";
        card.appendChild(controlled);
      }

      var expiry = document.createElement("p");
      expiry.textContent = entry.expiresAtIso
        ? "有效期至：" + entry.expiresAtIso
        : "有效期：未设置";
      card.appendChild(expiry);

      var actions = document.createElement("div");
      [["allowed-once", "批准本次（仅这一次）"], ["denied", "拒绝"]].forEach(function (pair) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = pair[1];
        button.addEventListener("click", function () {
          decidePermissionAsk(entry, pair[0], button);
        });
        actions.appendChild(button);
      });
      card.appendChild(actions);

      item.appendChild(card);
      permissionAsksElement.appendChild(item);
    });
  }
  function refreshPermissionAsks() {
    fetch("/permission-asks", { headers: { accept: "application/json" } })
      .then(function (response) { return response.json(); })
      .then(function (payload) { renderPermissionAsks(payload.entries || []); })
      .catch(function () {});
  }
  function decidePermissionAsk(entry, decision, button) {
    button.disabled = true;
    fetch("/commands/permission-ask-decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        ownerAgentInstanceId: entry.ownerAgentInstanceId,
        askIdentifier: entry.askIdentifier,
        decision: decision,
        expectedRequestRevision: entry.requestRevision,
        expectedOperationFingerprint: entry.operationFingerprint,
      }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { isOk: response.ok, status: response.status, payload: payload };
        });
      })
      .then(function (outcome) {
        button.disabled = false;
        if (outcome.isOk) {
          permissionAskResultElement.textContent =
            decision === "allowed-once"
              ? "已批准本次请求（仅这一次）。"
              : "已拒绝该请求。";
        } else if (outcome.status === 409) {
          permissionAskResultElement.textContent =
            "该请求已变化或已被处理，请刷新后重新裁决（" + outcome.payload.error + "）。";
        } else if (outcome.status === 403) {
          permissionAskResultElement.textContent =
            "裁决未被接受：" + outcome.payload.error;
        } else {
          permissionAskResultElement.textContent =
            "裁决失败：" + (outcome.payload.error || String(outcome.status));
        }
        refreshPermissionAsks();
      })
      .catch(function () {
        button.disabled = false;
        permissionAskResultElement.textContent = "裁决失败：无法连接本地服务。";
      });
  }
  document.getElementById("refresh-permission-asks").addEventListener("click", refreshPermissionAsks);
  /**
   * GUI-02-02 专用流程（2026-10-12）：**待安装询问**的呈现与回答。
   *
   * 与上方权限询问**并列但独立** —— 安装门禁自带完整判定，普通授权卡**不能**替代它。
   * 设计要点：**不默认选中**；两阶段分别作答；展示**精确安装计划**供判断；
   * 未回答 ⇒ 超时 ⇒ 门禁 fail-closed（界面无需也不应"默认同意"）。
   */
  var installationInquiriesElement = document.getElementById("installation-inquiries");
  var installationInquiryResultElement = document.getElementById("installation-inquiry-result");
  function renderInstallationInquiries(entries) {
    installationInquiriesElement.textContent = "";
    if (entries.length === 0) {
      var emptyItem = document.createElement("li");
      emptyItem.textContent = "无待决安装询问";
      installationInquiriesElement.appendChild(emptyItem);
      return;
    }
    entries.forEach(function (entry) {
      var item = document.createElement("li");
      var card = document.createElement("article");
      card.setAttribute("aria-label", "安装询问 " + entry.inquiryIdentifier);

      var title = document.createElement("h3");
      title.textContent =
        entry.stage === "existing-resource" ? "阶段 1：是否已有可用资源" : "阶段 2：是否允许本次安装";
      card.appendChild(title);

      var summary = document.createElement("p");
      summary.textContent = entry.summary + "｜当前版本 r" + entry.revision;
      card.appendChild(summary);

      if (entry.installationPlan) {
        var plan = document.createElement("dl");
        var planFields = [
          ["包/仓库", entry.installationPlan.packageOrRepositoryIdentifier],
          ["版本", entry.installationPlan.pinnedVersionOrCommit || "未固定"],
          ["目标", entry.installationPlan.targetPathOrScope],
          ["包管理器", entry.installationPlan.packageManager],
          ["预计变更", entry.installationPlan.expectedChangesSummary],
          ["需要网络", entry.installationPlan.requiresNetwork ? "是" : "否"],
          ["含安装脚本", entry.installationPlan.hasInstallScripts ? "是" : "否"],
        ];
        planFields.forEach(function (pair) {
          var term = document.createElement("dt");
          term.textContent = pair[0];
          var description = document.createElement("dd");
          description.textContent = String(pair[1]);
          plan.appendChild(term);
          plan.appendChild(description);
        });
        card.appendChild(plan);
      }

      if (entry.stage === "existing-resource") {
        var referenceInput = document.createElement("input");
        referenceInput.type = "text";
        referenceInput.setAttribute("aria-label", "已有资源引用");
        referenceInput.placeholder = "已有资源引用（选择「已有」时必填）";
        card.appendChild(referenceInput);

        var hasResourceButton = document.createElement("button");
        hasResourceButton.type = "button";
        hasResourceButton.textContent = "已有资源（填上面的引用）";
        hasResourceButton.addEventListener("click", function () {
          decideInstallationInquiry(
            entry,
            { answerKind: "has-resource", resourceReference: referenceInput.value },
            hasResourceButton,
          );
        });
        card.appendChild(hasResourceButton);

        var noResourceButton = document.createElement("button");
        noResourceButton.type = "button";
        noResourceButton.textContent = "没有，需要安装";
        noResourceButton.addEventListener("click", function () {
          decideInstallationInquiry(entry, { answerKind: "no-resource" }, noResourceButton);
        });
        card.appendChild(noResourceButton);
      } else {
        var allowButton = document.createElement("button");
        allowButton.type = "button";
        allowButton.textContent = "允许本次安装（仅这一次）";
        allowButton.addEventListener("click", function () {
          decideInstallationInquiry(
            entry,
            { allowOnceDecision: "allow-once" },
            allowButton,
          );
        });
        card.appendChild(allowButton);

        var denyButton = document.createElement("button");
        denyButton.type = "button";
        denyButton.textContent = "拒绝安装";
        denyButton.addEventListener("click", function () {
          decideInstallationInquiry(entry, { allowOnceDecision: "deny" }, denyButton);
        });
        card.appendChild(denyButton);
      }

      var actions = document.createElement("p");
      actions.textContent = "未回答即视为拒绝（不会自动安装）。";
      card.appendChild(actions);
      item.appendChild(card);
      installationInquiriesElement.appendChild(item);
    });
  }
  function refreshInstallationInquiries() {
    fetch("/installation-inquiries", { headers: { accept: "application/json" } })
      .then(function (response) { return response.json(); })
      .then(function (payload) { renderInstallationInquiries(payload.entries || []); })
      .catch(function () {});
  }
  function decideInstallationInquiry(entry, answer, button) {
    button.disabled = true;
    fetch("/commands/installation-inquiry-decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        inquiryIdentifier: entry.inquiryIdentifier,
        expectedRevision: entry.revision,
        stage: entry.stage,
        ...answer,
      }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { isOk: response.ok, status: response.status, payload: payload };
        });
      })
      .then(function (outcome) {
        button.disabled = false;
        if (outcome.isOk) {
          installationInquiryResultElement.textContent = "已记录你的回答。";
        } else if (outcome.status === 409) {
          installationInquiryResultElement.textContent =
            "该询问已变化或已被处理，请刷新后重新回答（" + outcome.payload.error + "）。";
        } else {
          installationInquiryResultElement.textContent =
            "回答失败：" + (outcome.payload.error || String(outcome.status));
        }
        refreshInstallationInquiries();
      })
      .catch(function () {
        button.disabled = false;
        installationInquiryResultElement.textContent = "回答失败：无法连接本地服务。";
      });
  }
  document
    .getElementById("refresh-installation-inquiries")
    .addEventListener("click", refreshInstallationInquiries);
  refreshSettings();
  refreshRecovery();
  refreshVerifications();
  refreshPermissionAsks();
  var source = new EventSource("/events");
  source.onopen = function () { statusElement.textContent = "已连接"; };
  source.onerror = function () { statusElement.textContent = "重连中…"; };
  source.onmessage = function (messageEvent) {
    try {
      var parsed = JSON.parse(messageEvent.data);
      // 2026-10-10 修复（真实用户人工体验发现）：重连后服务端先回**完整快照**
      // （eventType "snapshot"，内含 snapshot.tasks）。此前只处理 task-status /
      // task-finished，于是 snapshot 被**静默丢弃** ⇒ 断线重连后任务列表
      // **保留旧会话的陈旧内容**、既不清空也不更新
      // （用户实测："任务列表未清空，也没有显示重连等提示"）。
      // 修法：收到 snapshot 立即 refreshState()，以 /state 的**权威快照替换**界面内容
      // （refreshState 是幂等替换、不是追加 ⇒ 不会产生重复条目）。
      if (
        parsed.eventType === "snapshot" ||
        parsed.eventType === "task-status" ||
        parsed.eventType === "task-finished"
      ) {
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

  /**
   * SMART-01-04：读取指令窗口（可选能力）。
   * 缺失或读取失败 → 空窗口：**不伪造指令**，也不让 /state 与 SSE 快照因此失败。
   */
  async function readInstructionWindow(sessionId: string): Promise<
    | {
        windowCapacity: number;
        activeInstructions: Array<{
          instructionIdentifier: string;
          instructionText: string;
          state: string;
          admittedAtIso: string;
        }>;
        queuedInstructions: Array<{
          instructionIdentifier: string;
          instructionText: string;
          state: string;
          admittedAtIso: string;
        }>;
      }
    | undefined
  > {
    const query = options.applicationService.queryInstructionWindow;
    if (query === undefined) {
      return undefined;
    }
    try {
      return await query({ sessionId });
    } catch {
      return undefined;
    }
  }

  /** 组 `buildGuiSnapshot` 的可选入参（缺失时不含该键 ⇒ 快照返回空窗口）。 */
  async function readInstructionWindowOrDefault(): Promise<{
    instructionWindow?: Awaited<ReturnType<typeof readInstructionWindow>>;
  }> {
    const instructionWindow = await readInstructionWindow(options.sessionId);
    return instructionWindow === undefined ? {} : { instructionWindow };
  }

  /**
   * PROJECT-01-04：读取跨项目授权（可选能力）。
   * 缺失或读取失败 → 不含该键（快照返回空列表）：**不伪造授权**，也不让快照失败。
   */
  async function readCrossProjectOrDefault(): Promise<{
    crossProject?: {
      authorizations: Array<{
        authorizationIdentifier: string;
        sourceProjectIdentifier: string;
        targetProjectIdentifier: string;
        operationKind: string;
        state: string;
        taskIdentifier: string;
      }>;
      copyReceipts: Array<{
        receiptIdentifier: string;
        sourceProjectIdentifier: string;
        sourceRevision: number;
        targetProjectIdentifier: string;
        sourceResourcePath: string;
        targetResourcePath: string;
      }>;
    };
  }> {
    const listAuthorizations = options.applicationService.listCrossProjectAuthorizations;
    if (listAuthorizations === undefined) {
      return {};
    }
    try {
      const authorizations = await listAuthorizations();
      return {
        crossProject: {
          authorizations: authorizations.map((record) => ({
            authorizationIdentifier: record.authorizationIdentifier,
            sourceProjectIdentifier: record.sourceProjectIdentifier,
            targetProjectIdentifier: record.targetProjectIdentifier,
            operationKind: record.operationKind,
            state: record.state,
            taskIdentifier: record.taskIdentifier,
          })),
          // 副本回执由跨项目存储另行提供；此处只读视图不猜、不伪造。
          copyReceipts: [],
        },
      };
    } catch {
      return {};
    }
  }

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

  /**
   * TOOLKIT-01-04：读取工具包版本与升级差异（只读）。
   *
   * 与跨项目视图同口径：端口**未提供**或缺省实现缺失时返回 `{}`（视图回落为空），
   * 绝不让 `/state` 因缺少该能力而 500 —— 否则一个可选能力会把整个界面打挂。
   */
  async function readToolPackagesOrDefault(): Promise<{
    toolPackages?: {
      versions: Array<{
        toolPackageId: string;
        version: number;
        contentHash: string;
        revision: number;
        scope: string;
        status: string;
        readableName: string;
        sourceProjectIdentifier: string;
        enabledProjectIdentifiers: string[];
      }>;
      upgradeDifferences: Array<{
        toolPackageId: string;
        fromVersion: number;
        toVersion: number;
        addedSideEffects: string[];
        removedSideEffects: string[];
        dependencyDifferences: string[];
        permissionDifferences: string[];
        requiresReauthorization: boolean;
      }>;
    };
  }> {
    const listToolPackages = options.applicationService.listToolPackages;
    if (listToolPackages === undefined) {
      return {};
    }
    try {
      const snapshot = await listToolPackages();
      return {
        toolPackages: {
          versions: snapshot.versions.map((version) => ({
            toolPackageId: version.toolPackageId,
            version: version.version,
            contentHash: version.contentHash,
            revision: version.revision,
            scope: version.scope,
            status: version.status,
            readableName: version.readableName,
            sourceProjectIdentifier: version.sourceProjectIdentifier,
            enabledProjectIdentifiers: [...version.enabledProjectIdentifiers],
          })),
          upgradeDifferences: snapshot.upgradeDifferences.map((difference) => ({
            toolPackageId: difference.toolPackageId,
            fromVersion: difference.fromVersion,
            toVersion: difference.toVersion,
            addedSideEffects: [...difference.addedSideEffects],
            removedSideEffects: [...difference.removedSideEffects],
            dependencyDifferences: [...difference.dependencyDifferences],
            permissionDifferences: [...difference.permissionDifferences],
            requiresReauthorization: difference.requiresReauthorization,
          })),
        },
      };
    } catch {
      return {};
    }
  }

  /**
   * MERGE-01-03：读取参数授权设置（**只读、失败即返回 undefined**）。
   *
   * 为什么失败要回落成 `undefined` 而不是默认值：卡内要求 GUI/TUI/CLI/SDK 一致，
   * 而"默认开启"会被误读成"用户没改过"。缺失时视图如实显示"未知"。
   */
  async function readParameterAuthorizationSettingsOrUndefined(): Promise<
    | {
        isParameterAuthorizationEnabled: boolean;
        isParameterRulesEnabled: boolean;
        configurationRevision: number;
        ruleCount: number;
      }
    | undefined
  > {
    const readSettings = options.applicationService.queryParameterAuthorizationSettings;
    if (readSettings === undefined) {
      return undefined;
    }
    try {
      /**
       * **必须绑定接收者**：`readSettings` 是从对象上取下的方法，
       * 直接 `readSettings()` 会让 `this` 变成 undefined
       * （实测症状：门面方法内部访问 `this.stateDirectory` 抛错被吞掉，
       * GUI 于是**静默显示"未知"**，看起来像"没有这个能力"）。
       */
      return await readSettings.call(options.applicationService);
    } catch {
      return undefined;
    }
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
      response.end(
          renderPage({
            sessionId: options.sessionId,
            mode: options.mode,
            csrfToken,
          }),
        );
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
            ...(await readInstructionWindowOrDefault()),
            ...(await readCrossProjectOrDefault()),
            ...(await readToolPackagesOrDefault()),
            parameterAuthorizationSettings:
              await readParameterAuthorizationSettingsOrUndefined(),
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
            ...(await readInstructionWindowOrDefault()),
            ...(await readCrossProjectOrDefault()),
            ...(await readToolPackagesOrDefault()),
            parameterAuthorizationSettings:
              await readParameterAuthorizationSettingsOrUndefined(),
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
    /**
     * SMART-01-04 / OBS 入口补做：只读可观测性概览（性能/用量/诊断/跨项目）。
     *
     * 纪律：仅 GET；**严格只读**（只读已落盘样本与账目，不写盘、不注入任务、不联网）；
     * 无法测量时如实回传 isReportable=false 与原因，**不报 0**。
     */
    if (requestUrl.pathname === "/observability") {
      const observabilityStateDirectory = options.observabilityStateDirectory;
      if (observabilityStateDirectory === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      if (request.method !== "GET") {
        writeJsonResponse(response, 405, { error: "只读端点仅接受 GET" });
        return;
      }
      const { PerfEventStore, queryPerfOverview } = await import(
        "../../../core/src/orchestration/perf-event-store.js"
      );
      const { UsageLedgerStore, queryUsageOverview } = await import(
        "../../../core/src/orchestration/usage-ledger-store.js"
      );
      const { DiagnosticEventStore, queryDiagnosticSummary } = await import(
        "../../../core/src/orchestration/diagnostic-event-store.js"
      );
      const { CrossProjectAuthorizationStore, summarizeCopyReceipts } = await import(
        "../../../core/src/orchestration/cross-project-authorization-store.js"
      );

      const performance = await queryPerfOverview({
        store: new PerfEventStore({ baseDirectory: observabilityStateDirectory }),
      });
      const usage = await queryUsageOverview({
        store: new UsageLedgerStore({ baseDirectory: observabilityStateDirectory }),
      });
      const diagnostics = await queryDiagnosticSummary({
        store: new DiagnosticEventStore({ baseDirectory: observabilityStateDirectory }),
      });
      const crossProjectStore = new CrossProjectAuthorizationStore({
        baseDirectory: observabilityStateDirectory,
      });
      const crossProject = {
        authorizations: await crossProjectStore.listAuthorizations(),
        copyReceipts: await summarizeCopyReceipts({ store: crossProjectStore }),
      };

      writeJsonResponse(response, 200, {
        isReadOnly: true,
        performance,
        usage,
        diagnostics,
        crossProject,
      });
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
        /**
         * **2026-10-10 修复**：条目已失效（节点非关闭态）属**业务冲突**，
         * 此前未映射 ⇒ 直接 rethrow ⇒ 用户看到 HTTP 500 `internal-error`。
         * 与 `stale-revision` 同为 409（状态冲突），并给出稳定错误码供界面显示。
         */
        if (errorCode === "verification-entry-stale") {
          writeJsonResponse(response, 409, { error: "verification-entry-stale" });
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
    /**
     * GUI-02-02 片2（2026-10-11）：**待授权列表**。
     *
     * 只读端点：不触发模型调用、不注入上下文、不自动恢复任务；查看不等于裁决。
     * 视图**不含原始 `argumentsJson`**（只给安全预览），避免长内容/敏感值进入前端。
     */
    if (request.method === "GET" && requestUrl.pathname === "/permission-asks") {
      const applicationService = options.applicationService;
      if (applicationService.listPendingPermissionAsks === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      writeJsonResponse(response, 200, {
        entries: await applicationService.listPendingPermissionAsks(),
      });
      return;
    }
    /**
     * GUI-02-02 片2（2026-10-11）：**裁决入口**。
     *
     * **只接受请求锚点与裁决**：不接受前端提交的新参数（工具名/路径/参数一律由服务器
     * 从本地权威记录取）。CSRF 由**全局状态变更门禁**（`x-csrf-token`）先行校验，
     * 此处不再重复实现授权规则 —— 授权判定复用核心同一服务。
     */
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/commands/permission-ask-decision"
    ) {
      const applicationService = options.applicationService;
      if (applicationService.decidePermissionAsk === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        ownerAgentInstanceId?: unknown;
        askIdentifier?: unknown;
        decision?: unknown;
        expectedRequestRevision?: unknown;
        expectedOperationFingerprint?: unknown;
      };
      const ownerAgentInstanceId = parsedBody.ownerAgentInstanceId;
      const askIdentifier = parsedBody.askIdentifier;
      const decision = parsedBody.decision;
      const expectedRequestRevision = parsedBody.expectedRequestRevision;
      const expectedOperationFingerprint = parsedBody.expectedOperationFingerprint;
      if (
        typeof ownerAgentInstanceId !== "string" ||
        ownerAgentInstanceId === "" ||
        typeof askIdentifier !== "string" ||
        askIdentifier === "" ||
        (decision !== "allowed-once" && decision !== "denied") ||
        typeof expectedRequestRevision !== "number" ||
        !Number.isInteger(expectedRequestRevision) ||
        typeof expectedOperationFingerprint !== "string" ||
        expectedOperationFingerprint === ""
      ) {
        writeJsonResponse(response, 400, { error: "invalid-arguments" });
        return;
      }
      try {
        const result = await applicationService.decidePermissionAsk({
          ownerAgentInstanceId,
          askIdentifier,
          decision,
          expectedRequestRevision,
          expectedOperationFingerprint,
        });
        writeJsonResponse(response, 200, result);
      } catch (error) {
        const errorCode = readApplicationErrorCode(error);
        // 状态冲突（陈旧 revision / 指纹不符 / 已裁决 / 已过期）→ 409，供界面提示刷新。
        if (
          errorCode === "permission-ask-stale-revision" ||
          errorCode === "permission-ask-fingerprint-mismatch" ||
          errorCode === "permission-ask-already-decided" ||
          errorCode === "permission-ask-expired" ||
          errorCode === "permission-ask-revoked"
        ) {
          writeJsonResponse(response, 409, { error: errorCode });
          return;
        }
        if (errorCode === "permission-ask-not-found") {
          writeJsonResponse(response, 404, { error: errorCode });
          return;
        }
        // 鉴权类失败（CSRF / 未认证 / 不可见 / 无裁决权）→ 403。
        if (
          errorCode === "permission-ask-csrf-required" ||
          errorCode === "permission-ask-unauthenticated" ||
          errorCode === "permission-ask-not-visible" ||
          errorCode === "permission-ask-not-authorized"
        ) {
          writeJsonResponse(response, 403, { error: errorCode });
          return;
        }
        if (errorCode === "permission-ask-invalid") {
          writeJsonResponse(response, 400, { error: errorCode });
          return;
        }
        throw error;
      }
      return;
    }
    /**
     * GUI-02-02 专用流程（2026-10-12）：**待决安装询问**（只读）。
     *
     * 与 `/permission-asks` **并列但独立** —— 安装门禁自带完整判定，
     * 普通授权卡的裁决**不会**替代它；此端点只让界面看到"门禁正在等用户回答什么"。
     */
    if (request.method === "GET" && requestUrl.pathname === "/installation-inquiries") {
      const applicationService = options.applicationService;
      if (applicationService.listPendingInstallationInquiries === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      writeJsonResponse(response, 200, {
        entries: await applicationService.listPendingInstallationInquiries(),
      });
      return;
    }
    /**
     * GUI-02-02 专用流程（2026-10-12）：**安装询问的独立裁决入口**。
     *
     * 只接受**询问锚点 + revision + 回答**；不接受前端提交的新参数
     * （安装计划由门禁生成并已登记，界面只能对它作答）。
     * CSRF 由**全局状态变更门禁**先行校验，此处不重复实现授权规则。
     */
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/commands/installation-inquiry-decision"
    ) {
      const applicationService = options.applicationService;
      if (applicationService.decideInstallationInquiry === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        inquiryIdentifier?: unknown;
        expectedRevision?: unknown;
        stage?: unknown;
        answerKind?: unknown;
        resourceReference?: unknown;
        allowOnceDecision?: unknown;
      };
      const inquiryIdentifier = parsedBody.inquiryIdentifier;
      const expectedRevision = parsedBody.expectedRevision;
      const stage = parsedBody.stage;
      const answerKind = parsedBody.answerKind;
      const allowOnceDecision = parsedBody.allowOnceDecision;
      if (
        typeof inquiryIdentifier !== "string" ||
        inquiryIdentifier === "" ||
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        (stage !== "existing-resource" && stage !== "allow-once")
      ) {
        writeJsonResponse(response, 400, { error: "invalid-arguments" });
        return;
      }
      if (stage === "existing-resource") {
        if (answerKind !== "has-resource" && answerKind !== "no-resource") {
          writeJsonResponse(response, 400, { error: "invalid-arguments" });
          return;
        }
        // 声称"已有资源"却不给引用 ⇒ 无意义回答，拒绝（避免形成空授权凭据）。
        if (
          answerKind === "has-resource" &&
          (typeof parsedBody.resourceReference !== "string" ||
            parsedBody.resourceReference === "")
        ) {
          writeJsonResponse(response, 400, { error: "invalid-arguments" });
          return;
        }
      } else if (allowOnceDecision !== "allow-once" && allowOnceDecision !== "deny") {
        writeJsonResponse(response, 400, { error: "invalid-arguments" });
        return;
      }
      try {
        const result = await applicationService.decideInstallationInquiry({
          inquiryIdentifier,
          expectedRevision,
          stage,
          ...(typeof answerKind === "string"
            ? { answerKind: answerKind as "has-resource" | "no-resource" }
            : {}),
          ...(typeof parsedBody.resourceReference === "string"
            ? { resourceReference: parsedBody.resourceReference }
            : {}),
          ...(typeof allowOnceDecision === "string"
            ? { allowOnceDecision: allowOnceDecision as "allow-once" | "deny" }
            : {}),
        });
        writeJsonResponse(response, 200, result);
      } catch (error) {
        const errorCode = readApplicationErrorCode(error);
        if (errorCode === "installation-inquiry-not-found") {
          writeJsonResponse(response, 404, { error: errorCode });
          return;
        }
        // 状态冲突（已变化/已回答/阶段不符）→ 409，供界面提示刷新。
        if (
          errorCode === "installation-inquiry-stale-revision" ||
          errorCode === "installation-inquiry-already-answered" ||
          errorCode === "installation-inquiry-stage-mismatch"
        ) {
          writeJsonResponse(response, 409, { error: errorCode });
          return;
        }
        if (errorCode === "installation-inquiry-invalid") {
          writeJsonResponse(response, 400, { error: errorCode });
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
