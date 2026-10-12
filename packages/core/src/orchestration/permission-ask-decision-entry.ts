/**
 * 权限询问的**裁决入口公共服务**（GUI-02-01，2026-10-11 用户指定）。
 *
 * 用户原文边界（逐条落地）：
 * > 裁决入口校验 **CSRF、认证主体、项目/会话可见性和裁决权限**。
 * > 裁决入口接收**请求 ID、决定及预期 revision／指纹**；服务器从**本地权威记录**
 * > 取原始参数，重新校验主体、权限、期限和当前状态。
 * > **不得接受前端提交的新参数替换原请求**，也不得**把知道请求 ID 或指纹当作有权批准**。
 * > **重复点击不重复执行**；**多个页面并发裁决只能有一个有效结果**。
 * > **执行前仍重新鉴权**。关闭页面或重启不等于批准；旧一次性批准不自动恢复。
 * > CLI 保留终端输入输出适配，**GUI 使用同一服务，不复制授权规则**。
 *
 * 设计要点：
 * - **入参没有参数位**：只有请求 ID、决定、预期 revision、预期指纹与认证上下文；
 *   参数只能来自本地权威记录（`PermissionAskRequestStore`）。
 * - **校验顺序**固定：CSRF → 认证主体 → 项目/会话可见性 → 裁决权 →
 *   请求存在 → 期限 → 状态 → revision → 指纹。任一失败即拒绝且**不改状态**
 *   （"过期"例外：需落 `expired` 终态，由 store 负责）。
 * - **并发只有一个有效结果**：同一 `askIdentifier` 的裁决经 `AsyncMutex` **串行化**，
 *   第二个进入者读到的已是终态 ⇒ `permission-ask-already-decided`。
 * - **可见性与裁决权经端口注入**：不硬绑具体权限引擎，也不让本模块反向依赖界面层；
 *   CLI/GUI 各自提供认证与可见性事实，**规则不在本模块或界面里各写一份**。
 * - 成功时**返回事件**（`permission-ask`），供 SSE 广播与多页面同步。
 */
import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { buildPermissionAskEvent, type PermissionAskPublicEvent } from "./permission-ask-event.js";
import type {
  PermissionAskRequestRecord,
  PermissionAskRequestStore,
} from "./permission-ask-request-store.js";

/** 可见性与裁决权端口：由调用方（CLI/GUI 的认证层）提供客观事实。 */
export interface PermissionAskAuthorityPort {
  isProjectVisibleTo(
    agentInstanceId: string,
    projectIdentifier: string,
  ): Promise<boolean>;
  isSessionVisibleTo(
    agentInstanceId: string,
    sessionIdentifier: string,
  ): Promise<boolean>;
  hasAdjudicationAuthority(
    agentInstanceId: string,
    projectIdentifier: string,
  ): Promise<boolean>;
}

export interface PermissionAskDecisionEntryOptions {
  requestStore: PermissionAskRequestStore;
  authorityPort: PermissionAskAuthorityPort;
  projectRootPath: string;
  matchSensitivePathName?: (filePath: string) => string | null;
}

/** 裁决结果：已迁移的记录 + 可供广播的事件。 */
export interface PermissionAskDecisionOutcome {
  record: PermissionAskRequestRecord;
  event: PermissionAskPublicEvent;
}

export class PermissionAskDecisionEntryService {
  private readonly requestStore: PermissionAskRequestStore;
  private readonly authorityPort: PermissionAskAuthorityPort;
  private readonly projectRootPath: string;
  private readonly matchSensitivePathName:
    | ((filePath: string) => string | null)
    | undefined;
  /** 按 askIdentifier 串行化，保证并发裁决只有一个有效结果。 */
  private readonly decisionLocks = new Map<string, AsyncMutex>();

  constructor(options: PermissionAskDecisionEntryOptions) {
    this.requestStore = options.requestStore;
    this.authorityPort = options.authorityPort;
    this.projectRootPath = options.projectRootPath;
    this.matchSensitivePathName = options.matchSensitivePathName;
  }

  private lockFor(askIdentifier: string): AsyncMutex {
    const existing = this.decisionLocks.get(askIdentifier);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AsyncMutex();
    this.decisionLocks.set(askIdentifier, created);
    return created;
  }

  /**
   * 裁决一次权限询问。
   *
   * **注意**：本方法**不接受**任何参数值（如 `argumentsJson`）——
   * 这是用户"不得接受前端提交的新参数替换原请求"的直接落法。
   */
  async decidePermissionAsk(input: {
    /** 请求 ID。 */
    askIdentifier: string;
    decision: "allowed-once" | "denied";
    /** 预期 revision（拒绝陈旧裁决）。 */
    expectedRequestRevision: number;
    /** 预期操作指纹（参数变化不得复用批准）。 */
    expectedOperationFingerprint: string;
    /** 调用方持有的 CSRF 令牌。 */
    csrfToken: string;
    /** 服务端期望的 CSRF 令牌（由宿主生成并随页面下发）。 */
    expectedCsrfToken: string;
    /** 认证主体（不可复用个体身份）。 */
    authenticatedAgentInstanceId: string;
    projectIdentifier: string;
    sessionIdentifier: string;
  }): Promise<PermissionAskDecisionOutcome> {
    // ① CSRF
    if (
      input.expectedCsrfToken.trim() === "" ||
      input.csrfToken !== input.expectedCsrfToken
    ) {
      throw new DomainError(
        "permission-ask-csrf-required",
        "缺少或错误的 CSRF 令牌，拒绝裁决",
      );
    }
    // ② 认证主体
    const authenticatedAgentInstanceId = input.authenticatedAgentInstanceId.trim();
    if (authenticatedAgentInstanceId === "") {
      throw new DomainError(
        "permission-ask-unauthenticated",
        "缺少认证主体，拒绝裁决",
      );
    }
    // ③ 项目/会话可见性
    const isProjectVisible = await this.authorityPort.isProjectVisibleTo(
      authenticatedAgentInstanceId,
      input.projectIdentifier,
    );
    const isSessionVisible = await this.authorityPort.isSessionVisibleTo(
      authenticatedAgentInstanceId,
      input.sessionIdentifier,
    );
    if (!isProjectVisible || !isSessionVisible) {
      throw new DomainError(
        "permission-ask-not-visible",
        "项目或会话对当前主体不可见，拒绝裁决",
      );
    }
    // ④ 裁决权（**知道 ID/指纹不构成批准权**）
    const hasAuthority = await this.authorityPort.hasAdjudicationAuthority(
      authenticatedAgentInstanceId,
      input.projectIdentifier,
    );
    if (!hasAuthority) {
      throw new DomainError(
        "permission-ask-not-authorized",
        "当前主体无裁决权，拒绝裁决: " + authenticatedAgentInstanceId,
      );
    }

    /**
     * ⑤–⑨ 请求存在 / 期限 / 状态 / revision / 指纹 与状态迁移，
     * 全部由 store 依据**本地权威记录**完成；此处**串行化**以保证并发只有一个有效结果。
     */
    const record = await this.lockFor(input.askIdentifier).runExclusive(async () =>
      this.requestStore.decideRequest({
        askIdentifier: input.askIdentifier,
        decision: input.decision,
        expectedRequestRevision: input.expectedRequestRevision,
        expectedOperationFingerprint: input.expectedOperationFingerprint,
        deciderAgentInstanceId: authenticatedAgentInstanceId,
        hasAdjudicationAuthority: true,
      }),
    );

    const event = buildPermissionAskEvent({
      record,
      projectIdentifier: input.projectIdentifier,
      sessionIdentifier: input.sessionIdentifier,
      projectRootPath: this.projectRootPath,
      ...(this.matchSensitivePathName === undefined
        ? {}
        : { matchSensitivePathName: this.matchSensitivePathName }),
    });
    return { record, event };
  }
}
