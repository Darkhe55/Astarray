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
  buildGuiMissionHistoryListView,
  buildGuiRecoveryMissionPageView,
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
export interface GuiApplicationPort {  subscribe(listener: (event: PublicAstarrayEvent) => void): {
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
  /**
   * GUI-02-03（2026-11-08）：**历史列表与详情**（可选能力；缺失时服务端显式 501，
   * **不静默降级**为空气泡）。
   *
   * 与公共门面 `queryMissionHistory({ pageSize, pageIndex, afterMissionIdentifier })` 对齐：
   * 只读、分页按需、历史状态与运行状态分离。
   */
  queryMissionHistory?(input: {
    pageSize?: number;
    pageIndex?: number;
    afterMissionIdentifier?: string;
  }): Promise<GuiMissionHistoryPageView>;
  /**
   * GUI-02-04（2026-11-08）：**恢复执行入口**（可选能力；缺失时服务端显式 501）。
   *
   * 与公共门面 `resumeRecoveredMission({ missionIdentifier, hasExplicitUserConfirmation })` 对齐：
   * **必须**显式确认；对账/鉴权由服务端与核心强制。
   */
  resumeRecoveredMission?(input: {
    missionIdentifier: string;
    hasExplicitUserConfirmation: boolean;
  }): Promise<{
    outcome: string;
    missionIdentifier: string;
    detail?: string;
    requiredReauthorizationTypes?: string[];
    blockedDecisionItems?: string[];
  }>;
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

/**
 * GUI-02-03（2026-11-08）：历史视图条目。
 *
 * 与门面 `MissionHistoryEntry` 对齐，但**只暴露界面需要的字段**：
 * - `recordedStatus` 是**历史状态**（磁盘上"当时"的记录）；
 * - `runtimeState` / `isActivelyRunning` 是**运行状态**（现在是否真在跑）；
 *   二者**分开呈现**，故"重启前 running"不会被显示成运行中。
 * - `projectIdentifier` 为 `null` 表示**没有项目信息**（不伪造）。
 */
export interface GuiMissionHistoryEntryView {
  missionIdentifier: string;
  prompt: string | null;
  mode: string | null;
  projectIdentifier: string | null;
  createdAtIso: string | null;
  recordedStatus: string | null;
  runtimeState: string;
  isActivelyRunning: boolean;
  isCorrupted: boolean;
}

export interface GuiMissionHistoryPageView {
  entries: GuiMissionHistoryEntryView[];
  pageIndex: number;
  effectivePageSize: number;
  totalMissionCount: number;
  hasMorePages: boolean;
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
    <!--
      GUI-02-04：会话视图为空时的说明位。
      进程重启后本会话任务列表必然为空 —— 必须明确"这不代表数据丢失"，
      否则用户会误以为历史与磁盘状态也没了（卡内禁止的界面误导）。
    -->
    <p id="tasks-empty" role="status" aria-live="polite" hidden>
      本会话视图为空：这不代表数据丢失。进程重启后当前会话没有任务，
      历史任务与磁盘状态仍在——请在下方「恢复中心」核对 mission 与检查点后再决定是否恢复。
    </p>
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
    <p>
      本区为只读：核对 mission、检查点与对账状态，不会自动恢复任何任务。
      恢复必须同时满足三道门 —— ① 由你显式确认（不提供「点开即恢复」）、
      ② 先完成对账（未知状态不得当成已恢复）、③ 重新鉴权（重启后旧会话授权不被默认信任）。
    </p>
    <button id="refresh-recovery" type="button">刷新</button>
    <!--
      GUI-02-03/04：分页控件。恢复中心曾一次铺开 103 条（可恢复项仅 1 条）⇒ 用户找不到。
      现在一页只渲染当页，并把**可恢复项排在最前**（服务端已排好）。
    -->
    <div>
      <button id="recovery-previous-page" type="button" disabled>上一页</button>
      <button id="recovery-next-page" type="button" disabled>下一页</button>
      <span id="recovery-paging" role="status" aria-live="polite">未加载</span>
      <span id="recovery-recoverable-count"></span>
    </div>
    <ul id="recovery" aria-live="polite"></ul>
    <p id="recovery-resume-result" role="status" aria-live="polite"></p>
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
  <!--
    GUI-02-03（2026-11-08）：历史列表及详情（三视图）。

    只读：这里没有任何恢复/模型/上下文注入入口；数据一律来自 GET /mission-history。
    三视图分别是 列表 / 详情 / 原始，由 data-history-view 属性切换。
  -->
  <section aria-labelledby="history-heading">
    <h2 id="history-heading">历史任务（只读）</h2>
    <p>
      查看历史**不会**恢复任务、**不会**调用模型、**不会**注入上下文。
      历史状态是"当时记录"，运行状态是"现在是否真的在跑"——两者分开显示：
      重启前写着「运行中」的任务会显示为「已中断，待对账」。
    </p>
    <div id="history-view-switcher" role="group" aria-label="历史视图切换">
      <button id="history-show-list" type="button" aria-pressed="true">列表</button>
      <button id="history-show-detail" type="button" aria-pressed="false" disabled>详情</button>
      <button id="history-show-raw" type="button" aria-pressed="false" disabled>原始</button>
      <button id="history-back-to-list" type="button" hidden>返回列表</button>
    </div>

    <div id="history-list" class="history-view" data-history-view="list">
      <div>
        <button id="history-previous-page" type="button" disabled>上一页</button>
        <button id="history-next-page" type="button" disabled>下一页</button>
        <span id="history-paging" role="status" aria-live="polite">未加载</span>
      </div>
      <table>
        <caption>历史任务列表（每页按需加载，不一次读取全部）</caption>
        <thead>
          <tr>
            <th scope="col">任务目标</th>
            <th scope="col">项目</th>
            <th scope="col">时间</th>
            <th scope="col">最后状态（当时记录）</th>
            <th scope="col">运行状态（现在）</th>
          </tr>
        </thead>
        <tbody id="history-rows"></tbody>
      </table>
      <p id="history-empty" role="status" aria-live="polite" hidden></p>
    </div>

    <div id="history-detail" class="history-view" data-history-view="detail" hidden>
      <dl id="history-detail-fields"></dl>
      <p id="history-detail-corrupted" class="history-corrupted" hidden>记录损坏</p>
    </div>

    <div id="history-raw" class="history-view" data-history-view="raw" hidden>
      <p>以下为**未归一**的原样记录，供核对（不做任何标签替换）。</p>
      <pre id="history-raw-text"></pre>
    </div>
    <p id="history-result" role="status" aria-live="polite"></p>
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
  var tasksEmptyElement = document.getElementById("tasks-empty");
  var resultElement = document.getElementById("submit-result");
  /**
   * GUI-02-04（2026-11-08）：**空会话视图必须解释自己**。
   *
   * /state 的任务列表是"本会话视图"，重启后必然为空。此前这里对空数组
   * **只清空列表、不写任何文字** ⇒ 用户会以为"数据丢了"（卡内禁止的界面误导）。
   * 现改为：为空时显示明确说明（指向"恢复中心"核对），非空时**不显示**该说明。
   */
  function renderTasks(tasks) {
    tasksElement.textContent = "";
    var taskList = tasks || [];
    taskList.forEach(function (task) {
      var item = document.createElement("li");
      item.textContent = task.taskIdentifier + " · " + task.status + " · r" + task.revision;
      tasksElement.appendChild(item);
    });
    if (tasksEmptyElement) {
      tasksEmptyElement.hidden = taskList.length > 0;
    }
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
    fetch("/recovery?pageIndex=" + String(recoveryPageIndex), {
      headers: { accept: "application/json" },
    })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        recoveryElement.textContent = "";
        var missions = payload.rows || [];
        /**
         * GUI-02-03/04：分页计数与可用性提示。
         *
         * 用户实测时一次铺开 103 条、可恢复项仅 1 条 ⇒ 找不到。
         * 现在把"共几条 / 其中几条可恢复 / 第几页"直接写在界面上，
         * 用户不必自己数。
         */
        var totalMissionCount = payload.totalMissionCount || 0;
        var recoverableMissionCount = payload.recoverableMissionCount || 0;
        var effectivePageSize = payload.effectivePageSize || 20;
        var pageCount = totalMissionCount === 0
          ? 0
          : Math.ceil(totalMissionCount / effectivePageSize);
        recoveryPagingElement.textContent =
          totalMissionCount === 0
            ? "共 0 条"
            : "第 " + String(recoveryPageIndex + 1) + " / " + String(pageCount) +
              " 页（共 " + String(totalMissionCount) + " 条）";
        recoveryRecoverableCountElement.textContent =
          recoverableMissionCount === 0
            ? "（其中可恢复：0 条）"
            : "（其中可恢复：" + String(recoverableMissionCount) + " 条，已排在最前）";
        recoveryPreviousPageButton.disabled = recoveryPageIndex <= 0;
        recoveryNextPageButton.disabled =
          payload.isOutOfRange === true || recoveryPageIndex + 1 >= pageCount;

        if (missions.length === 0) {
          var emptyItem = document.createElement("li");
          emptyItem.textContent = payload.isOutOfRange === true
            ? "本页超出范围（请回到上一页）"
            : "无可恢复 mission";
          recoveryElement.appendChild(emptyItem);
          return;
        }
        missions.forEach(function (mission) {
          var item = document.createElement("li");
          item.textContent = mission.missionIdentifier + " · " + (mission.status || "未知") +
            (mission.isCorrupted ? " · 损坏" : "") +
            (mission.isLeaseActive ? " · 租约活跃" : "") +
            (mission.hasTrustedCheckpoint ? " · 有可信检查点" : "");
          /**
           * GUI-02-04：**逐 mission** 的恢复按钮（**没有批量恢复入口**）。
           *
           * 硬约束：
           * - **不默认选中、不自动恢复**：必须用户**主动点击**；
           * - 不可恢复的**禁用**并写明"还差什么"；
           * - 点击后带 hasExplicitUserConfirmation: true（**该值只能来自这次点击**）。
           *
           * ⚠️ 判定与原因**一律用服务端给的** isRecoverable / blockedReasonText，
           * 页面脚本**不再自己算一遍**（否则会出现第二套规则，迟早与读模型走样）。
           */
          var resumeButton = document.createElement("button");
          resumeButton.type = "button";
          resumeButton.textContent = "请求恢复（需显式确认）";
          var isRecoverable = mission.isRecoverable === true;
          resumeButton.disabled = !isRecoverable;
          if (!isRecoverable) {
            resumeButton.title = "暂不可恢复：" + String(mission.blockedReasonText || "原因未知");
          }
          resumeButton.addEventListener("click", function () {
            requestMissionResume(mission.missionIdentifier);
          });
          item.appendChild(document.createTextNode(" "));
          item.appendChild(resumeButton);
          if (!isRecoverable) {
            item.appendChild(
              document.createTextNode("（暂不可恢复：" + resumeButton.title + "）"),
            );
          }
          recoveryElement.appendChild(item);
        });
      })
      .catch(function () {});
  }
  document.getElementById("refresh-recovery").addEventListener("click", refreshRecovery);
  var recoveryResumeResultElement = document.getElementById("recovery-resume-result");
  var recoveryPagingElement = document.getElementById("recovery-paging");
  var recoveryRecoverableCountElement =
    document.getElementById("recovery-recoverable-count");
  var recoveryPreviousPageButton = document.getElementById("recovery-previous-page");
  var recoveryNextPageButton = document.getElementById("recovery-next-page");
  /** 恢复中心当前页（从 0 起；服务端按页返回，界面不一次渲染全部）。 */
  var recoveryPageIndex = 0;
  recoveryPreviousPageButton.addEventListener("click", function () {
    if (recoveryPageIndex > 0) {
      recoveryPageIndex -= 1;
      refreshRecovery();
    }
  });
  recoveryNextPageButton.addEventListener("click", function () {
    recoveryPageIndex += 1;
    refreshRecovery();
  });
  /**
   * GUI-02-04：**恢复请求**（只在用户点击时调用 —— 绝不自动触发）。
   *
   * 服务端拒绝时**把理由呈现给用户**（outcome + detail），
   * 不静默失败：否则用户只会看到"点了没反应"，更糟的是可能误以为已经恢复。
   */
  function requestMissionResume(missionIdentifier) {
    recoveryResumeResultElement.textContent = "正在请求恢复 " + missionIdentifier + " …";
    return fetch("/commands/recovery-resume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        missionIdentifier: missionIdentifier,
        // **显式确认**：该值只来自这次用户点击，不是脚本默认。
        hasExplicitUserConfirmation: true,
      }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { isOk: response.ok, payload: payload };
        });
      })
      .then(function (outcome) {
        if (!outcome.isOk) {
          recoveryResumeResultElement.textContent =
            "恢复未获准（" + String(outcome.payload.errorCode || "unknown") + "）：" +
            String(outcome.payload.message || "");
          return;
        }
        if (outcome.payload.outcome === "resumed") {
          recoveryResumeResultElement.textContent =
            "已恢复 " + missionIdentifier +
            "；需重新鉴权项：" +
            ((outcome.payload.requiredReauthorizationTypes || []).join("、") || "无");
        } else {
          recoveryResumeResultElement.textContent =
            "未恢复（" + String(outcome.payload.outcome) + "）：" +
            String(outcome.payload.detail || "") +
            ((outcome.payload.blockedDecisionItems || []).length > 0
              ? "；阻塞项：" + outcome.payload.blockedDecisionItems.join("、")
              : "");
        }
        refreshRecovery();
      })
      .catch(function (error) {
        recoveryResumeResultElement.textContent = "恢复请求失败：" + String(error);
      });
  }
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
   * GUI-02-03（2026-11-08）：**历史三视图**（列表 / 详情 / 原始）。
   *
   * 硬约束（与读模型、路由同口径 —— 三处必须一致，任一处走样都是缺陷）：
   * ── 只读：只 GET /mission-history；没有恢复/模型/上下文注入的任何入口；
   * ── 分页按需：只在翻页时取那一页，绝不把全部历史一次取回；
   * ── 历史状态与运行状态分列：recordedStatusText（当时记录）与
   *    runtimeStateText（现在）分别渲染 —— 重启前写着「运行中（当时记录）」的任务，
   *    运行列显示「已中断，待对账」，不会看起来还在跑；
   * - **损坏明确标注**：行上标「记录损坏」，且条目**不隐藏**；
   * - **原始视图用 textContent**（不是"以 HTML 方式插入"）⇒ 原样文本不会被当作标签执行。
   */
  var historyRowsElement = document.getElementById("history-rows");
  var historyEmptyElement = document.getElementById("history-empty");
  var historyPagingElement = document.getElementById("history-paging");
  var historyResultElement = document.getElementById("history-result");
  var historyDetailFieldsElement = document.getElementById("history-detail-fields");
  var historyDetailCorruptedElement = document.getElementById("history-detail-corrupted");
  var historyRawTextElement = document.getElementById("history-raw-text");
  var historyPreviousPageButton = document.getElementById("history-previous-page");
  var historyNextPageButton = document.getElementById("history-next-page");
  var historyShowDetailButton = document.getElementById("history-show-detail");
  var historyShowRawButton = document.getElementById("history-show-raw");
  var historyBackToListButton = document.getElementById("history-back-to-list");
  var historyViewElements = document.querySelectorAll("[data-history-view]");

  var HISTORY_PAGE_SIZE = 10;
  var historyPageIndex = 0;
  var historyEntriesInCurrentPage = [];
  var historySelectedEntry = null;

  function showHistoryView(viewName) {
    for (var index = 0; index < historyViewElements.length; index += 1) {
      var element = historyViewElements[index];
      element.hidden = element.getAttribute("data-history-view") !== viewName;
    }
    historyBackToListButton.hidden = viewName === "list";
    historyShowDetailButton.setAttribute("aria-pressed", String(viewName === "detail"));
    historyShowRawButton.setAttribute("aria-pressed", String(viewName === "raw"));
  }

  function appendHistoryCell(row, text, className) {
    var cell = document.createElement("td");
    cell.textContent = text;
    if (className) {
      cell.className = className;
    }
    row.appendChild(cell);
    return cell;
  }

  function renderHistoryRows(rows) {
    historyRowsElement.textContent = "";
    for (var index = 0; index < rows.length; index += 1) {
      var entry = rows[index];
      var row = document.createElement("tr");
      appendHistoryCell(row, entry.promptText);
      appendHistoryCell(row, entry.projectText);
      appendHistoryCell(row, entry.createdAtText);
      // **历史状态**列（当时记录）
      appendHistoryCell(row, entry.recordedStatusText);
      // **运行状态**列（现在）—— 与上一列分开，重启前的 running 在这里是"已中断，待对账"
      appendHistoryCell(row, entry.runtimeStateText);
      if (entry.isCorrupted) {
        var corruptedCell = appendHistoryCell(row, entry.corruptedText || "记录损坏");
        corruptedCell.className = "history-corrupted";
      }
      var actionCell = document.createElement("td");
      var detailButton = document.createElement("button");
      detailButton.type = "button";
      detailButton.textContent = "查看详情";
      detailButton.addEventListener(
        "click",
        (function (capturedEntry) {
          return function () {
            historySelectedEntry = capturedEntry;
            renderHistoryDetail(capturedEntry);
            historyShowRawButton.disabled = false;
            showHistoryView("detail");
          };
        })(entry),
      );
      actionCell.appendChild(detailButton);
      row.appendChild(actionCell);
      historyRowsElement.appendChild(row);
    }
  }

  function renderHistoryDetail(entry) {
    historyDetailFieldsElement.textContent = "";
    var fields = [
      ["任务标识", entry.missionIdentifier],
      ["任务目标", entry.promptText],
      ["项目", entry.projectText],
      ["时间", entry.createdAtText],
      ["最后状态（当时记录）", entry.recordedStatusText],
      ["运行状态（现在）", entry.runtimeStateText],
    ];
    for (var index = 0; index < fields.length; index += 1) {
      var term = document.createElement("dt");
      term.textContent = fields[index][0];
      var description = document.createElement("dd");
      description.textContent = fields[index][1];
      historyDetailFieldsElement.appendChild(term);
      historyDetailFieldsElement.appendChild(description);
    }
    historyDetailCorruptedElement.hidden = !entry.isCorrupted;
  }

  function renderHistoryRaw(entry) {
    /**
     * 原始视图：用 textContent 原样呈现「未归一」记录。
     * 刻意采用"纯文本赋值"而非"以 HTML 方式插入" —— 原始文本不得被当作标签执行。
     */
    historyRawTextElement.textContent = JSON.stringify(
      {
        missionIdentifier: entry.missionIdentifier,
        prompt: entry.promptText,
        projectIdentifier: entry.projectText,
        createdAtIso: entry.createdAtText,
        recordedStatus: entry.recordedStatusText,
        runtimeState: entry.runtimeStateText,
        isActivelyRunning: entry.isActivelyRunning,
        isCorrupted: entry.isCorrupted,
      },
      null,
      2,
    );
  }

  function refreshHistory() {
    // 只取**当前这一页**（分页按需；不存在"一次取全部"的路径）。
    return fetch(
      "/mission-history?pageSize=" + String(HISTORY_PAGE_SIZE) + "&pageIndex=" + String(historyPageIndex),
      { headers: { accept: "application/json" } },
    )
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + String(response.status));
        }
        return response.json();
      })
      .then(function (page) {
        historyEntriesInCurrentPage = page.rows || [];
        renderHistoryRows(historyEntriesInCurrentPage);
        historyEmptyElement.hidden = historyEntriesInCurrentPage.length > 0;
        historyEmptyElement.textContent = historyEntriesInCurrentPage.length > 0 ? "" : "暂无历史任务。";
        historyPagingElement.textContent = page.pagingLabel + " · " + page.totalMissionCountText;
        historyPreviousPageButton.disabled = historyPageIndex <= 0;
        historyNextPageButton.disabled = page.isMoreAvailable !== true;
        historyResultElement.textContent = "";
        showHistoryView("list");
      })
      .catch(function (error) {
        historyResultElement.textContent = "历史加载失败：" + String(error.message);
      });
  }

  historyPreviousPageButton.addEventListener("click", function () {
    if (historyPageIndex > 0) {
      historyPageIndex -= 1;
      refreshHistory();
    }
  });
  historyNextPageButton.addEventListener("click", function () {
    historyPageIndex += 1;
    refreshHistory();
  });
  document.getElementById("history-show-list").addEventListener("click", function () {
    showHistoryView("list");
  });
  historyBackToListButton.addEventListener("click", function () {
    showHistoryView("list");
  });
  historyShowRawButton.addEventListener("click", function () {
    if (historySelectedEntry) {
      renderHistoryRaw(historySelectedEntry);
      showHistoryView("raw");
    }
  });
  refreshHistory();
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
      /**
       * GUI-02-03/04（2026-11-08）：**分页 + 可恢复项优先**。
       *
       * ## 为什么要改（真实人工体验暴露，不是推测）
       *
       * 用户实测时本路由一次返回 **103** 条，其中**仅 1 条可恢复**（102:1），
       * 且它按字典序埋在中间 ⇒ 用户**肉眼找不到**，回报"所有项目都暂不可恢复"。
       * 卡片 L60/L77 明文要求「**分页、按需加载**：不得一次读取全部 97 个 mission」。
       *
       * ## 视图在**服务端**构建（与 `/mission-history` 同一纪律）
       *
       * 排序与"是否可恢复"的判定一律来自 `buildGuiRecoveryMissionPageView`，
       * 客户端**不自己拼** —— 否则页面脚本里会出现第二套判定，迟早与读模型走样。
       *
       * ## ⚠️ 一处**如实说明的残留**（未夸大已是"按需加载"）
       *
       * 核心门面 `queryRecoveryOverview()` **本身仍是全量**（它没有分页入参）。
       * 故本路由是"**全量取一次 → 服务端只把一页交给浏览器**"：
       * **界面侧不再一次渲染 103 条**（可用性问题已解决），
       * 但**核心层的一次全量列举仍在**。要彻底满足"不得一次读取全部"，
       * 需要给恢复概览也加**按页列举**（核心改动，另行处理）。
       */
      const rawRecoveryPageSize = requestUrl.searchParams.get("pageSize");
      const rawRecoveryPageIndex = requestUrl.searchParams.get("pageIndex");
      let requestedRecoveryPageSize: number | undefined;
      let requestedRecoveryPageIndex = 0;
      if (rawRecoveryPageSize !== null) {
        requestedRecoveryPageSize = Number(rawRecoveryPageSize);
        if (!Number.isInteger(requestedRecoveryPageSize) || requestedRecoveryPageSize < 1) {
          writeJsonResponse(response, 400, {
            errorCode: "recovery-page-size-invalid",
            message: "pageSize 必须为正整数",
          });
          return;
        }
      }
      if (rawRecoveryPageIndex !== null) {
        const parsedRecoveryPageIndex = Number(rawRecoveryPageIndex);
        if (!Number.isInteger(parsedRecoveryPageIndex) || parsedRecoveryPageIndex < 0) {
          writeJsonResponse(response, 400, {
            errorCode: "recovery-page-index-invalid",
            message: "pageIndex 必须为非负整数",
          });
          return;
        }
        requestedRecoveryPageIndex = parsedRecoveryPageIndex;
      }
      const recoveryOverview = await applicationService.queryRecoveryOverview();
      const recoveryPageView = buildGuiRecoveryMissionPageView({
        missions: recoveryOverview.missions.map((mission) => ({
          missionIdentifier: mission.missionIdentifier,
          status: mission.status,
          isCorrupted: mission.isCorrupted,
          hasTrustedCheckpoint: mission.hasTrustedCheckpoint,
          isLeaseActive: mission.isLeaseActive,
        })),
        pageIndex: requestedRecoveryPageIndex,
        ...(requestedRecoveryPageSize === undefined
          ? {}
          : { pageSize: requestedRecoveryPageSize }),
      });
      writeJsonResponse(response, 200, recoveryPageView);
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
    /**
     * GUI-02-03（2026-11-08）：**历史列表与详情**（只读）。
     *
     * - 只支持 `GET`（查看历史**从不**产生副作用：不恢复、不调模型、不注入上下文）；
     * - **分页按需**：`pageSize` / `pageIndex` 透传，页大小上限由核心层强制；
     * - 非法分页参数 ⇒ **400**（不静默夹到"全部"）；
     * - 能力缺失 ⇒ **501**（不静默降级）。
     */
    if (request.method === "GET" && requestUrl.pathname === "/mission-history") {
      const applicationService = options.applicationService;
      if (applicationService.queryMissionHistory === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const rawPageSize = requestUrl.searchParams.get("pageSize");
      const rawPageIndex = requestUrl.searchParams.get("pageIndex");
      const afterMissionIdentifier = requestUrl.searchParams.get("afterMissionIdentifier");
      let requestedPageSize: number | undefined;
      let requestedPageIndex: number | undefined;
      if (rawPageSize !== null) {
        requestedPageSize = Number(rawPageSize);
        if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1) {
          writeJsonResponse(response, 400, {
            errorCode: "mission-history-page-size-invalid",
            message: "pageSize 必须为正整数",
          });
          return;
        }
      }
      if (rawPageIndex !== null) {
        requestedPageIndex = Number(rawPageIndex);
        if (!Number.isInteger(requestedPageIndex) || requestedPageIndex < 0) {
          writeJsonResponse(response, 400, {
            errorCode: "mission-history-page-index-invalid",
            message: "pageIndex 必须为非负整数",
          });
          return;
        }
      }
      const page = await applicationService.queryMissionHistory({
        ...(requestedPageSize === undefined ? {} : { pageSize: requestedPageSize }),
        ...(requestedPageIndex === undefined ? {} : { pageIndex: requestedPageIndex }),
        ...(afterMissionIdentifier === null || afterMissionIdentifier === ""
          ? {}
          : { afterMissionIdentifier }),
      });
      /**
       * **视图在服务端构建**（单一事实来源）：运行态/历史态的展示文案一律来自
       * `gui-read-model`，客户端**不自己拼标签** —— 否则页面脚本里会再出现一套
       * 状态映射，迟早与读模型/核心层走样（那正是"三处必须一致"最难守的地方）。
       */
      const listView = buildGuiMissionHistoryListView(page);
      writeJsonResponse(response, 200, {
        ...listView,
        pageIndex: page.pageIndex,
        effectivePageSize: page.effectivePageSize,
        totalMissionCount: page.totalMissionCount,
      });
      return;
    }

    /**
     * GUI-02-04（2026-11-08）：**恢复执行**（显式 + 先对账 + 重新鉴权）。
     *
     * 只接受 `POST`；**必须**带 `hasExplicitUserConfirmation: true` ——
     * 缺它即视为"未显式确认"，入口层直接 400，**不进核心**（不提供"点开即恢复"）。
     * 对账/鉴权由门面与核心判定；核心拒绝时**原样回报**（不美化成已恢复）。
     */
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/commands/recovery-resume"
    ) {
      const applicationService = options.applicationService;
      if (applicationService.resumeRecoveredMission === undefined) {
        writeCapabilityUnavailable(response);
        return;
      }
      const parsedBody = JSON.parse((await readBody(request)) || "{}") as {
        missionIdentifier?: unknown;
        hasExplicitUserConfirmation?: unknown;
      };
      if (
        typeof parsedBody.missionIdentifier !== "string" ||
        parsedBody.missionIdentifier.length === 0
      ) {
        writeJsonResponse(response, 400, {
          errorCode: "recovery-mission-identifier-invalid",
          message: "需要提供 missionIdentifier",
        });
        return;
      }
      if (parsedBody.hasExplicitUserConfirmation !== true) {
        writeJsonResponse(response, 400, {
          errorCode: "recovery-not-explicitly-confirmed",
          message: "恢复必须由你显式确认（不提供点开即恢复）",
        });
        return;
      }
      const resumeResult = await applicationService.resumeRecoveredMission({
        missionIdentifier: parsedBody.missionIdentifier,
        hasExplicitUserConfirmation: true,
      });
      writeJsonResponse(response, 200, resumeResult);
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
