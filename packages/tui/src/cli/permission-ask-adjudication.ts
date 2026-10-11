/**
 * permission-ask 的 headless CLI 裁决线（ADR-0011 / ADR-0003 优先级）。
 *
 * 语义（既有定论，本模块只做接线，不新造规则）：
 * - 受限工具按当前权限档返回 `ask` → Worker 升级 `permission-ask-pending`；
 * - 询问必须**结构化送达认证用户**，由用户本人裁决 `allow-once`；
 * - 授权绑定工具名 + 精确参数（哈希），参数变化即失效需二次鉴权；
 * - 用户裁决后以 instruction 下发 `unblock`，任务继续；不自动重跑、不代答、不记忆。
 *
 * 非交互（`--json` 管道、无 TTY）一律 fail-closed：不授权、不 unblock，
 * 只输出结构化询问，由用户显式重提。
 */
import { logToStderr } from "./json-output.js";
/**
 * **2026-10-11（GUI-02-01）提取**：以下契约与纯判定已移至核心
 * `packages/core/src/orchestration/permission-ask-contract.ts`，本文件**从核心再导出**
 * 以保持公开 API 不变（消费方与既有测试的导入路径无需改动）。
 *
 * 依赖方向：**TUI → core，单向**；核心不反向依赖 TUI 类型或终端交互。
 */
import {
  buildPermissionAskFromEscalation,
  shouldReusePreviousApproval,
  type PermissionAsk,
  type PermissionAskApplicationPort,
  type PermissionAskDecision,
  type PermissionAskDecisionPort,
  type PreviousApprovalRecord,
} from "../../../core/src/orchestration/permission-ask-contract.js";

export type {
  ApprovalReuseDecision,
  PermissionAsk,
  PermissionAskApplicationPort,
  PermissionAskDecision,
  PermissionAskDecisionPort,
  PreviousApprovalRecord,
} from "../../../core/src/orchestration/permission-ask-contract.js";

export { buildPermissionAskFromEscalation, shouldReusePreviousApproval };



/**
 * 执行一次裁决：**只有**交互式用户明确 `allow-once` 才会授权；
 * 其余情形（无 TTY、无裁决、拒绝、无询问上下文）绝不授权。
 */
export async function runPermissionAskAdjudication(options: {
  ask: PermissionAsk | null;
  missionIdentifier: string | null;
  isInteractive: boolean;
  readDecision: (ask: PermissionAsk) => Promise<"allow-once" | "deny" | null>;
  application: PermissionAskApplicationPort;
  /** 交互提示输出（默认 stderr，保持 stdout 仅 JSON）。 */
  interactOutput?: (message: string) => void;
  /**
   * 本授权周期内上一次已批准的操作（方案 B，2026-10-02）：
   * 同工具 + 同目标路径且尚无副作用 → **自动复用**，不再重复询问用户；
   * 该路径已成功写入过 → 判 `requires-human-resubmission`（重放保护不放宽）。
   */
  previousApproval?: PreviousApprovalRecord | null;
}): Promise<PermissionAskDecision> {
  const ask = options.ask;
  const writePrompt = options.interactOutput ?? logToStderr;
  if (ask === null || options.missionIdentifier === null) {
    writePrompt(
      "需要权限的调用已阻断，但未能确认被请求的工具与参数：请人工检查并重新提交任务。",
    );
    return "requires-human-resubmission";
  }
  // 方案 B：同一次授权周期内，参数抖动（结尾换行/键序）不重复打扰用户。
  const reuseDecision = shouldReusePreviousApproval({
    pendingAsk: ask,
    previousApproval: options.previousApproval ?? null,
  });
  if (reuseDecision === "already-executed") {
    writePrompt(
      `同一目标路径已成功写入过：不再自动授权 ${ask.toolName}（如需再次执行请重新提交任务）。`,
    );
    return "requires-human-resubmission";
  }
  const isAutoReused = reuseDecision === "reuse-without-asking";
  if (isAutoReused) {
    writePrompt(
      `同一逻辑操作（${ask.toolName} → ${ask.argumentsJson}）已在本次授权内批准且尚无副作用：` +
        "自动复用该批准，不再重复询问。",
    );
  } else if (!options.isInteractive) {
    // 非交互：输出结构化询问（ADR-0011 载荷形态），不授权、不 unblock。
    writePrompt(
      "需要用户裁决（非交互环境，未授权）：" +
        JSON.stringify({
          kind: "permission-ask",
          taskId: ask.taskIdentifier,
          toolName: ask.toolName,
          argumentsJson: ask.argumentsJson,
          explanation: ask.explanation,
          resumeInstruction: JSON.stringify({
            action: "unblock",
            taskId: ask.taskIdentifier,
          }),
        }),
    );
    return "requires-human-resubmission";
  }
  if (!isAutoReused) {
    writePrompt(
      `[权限裁决] 任务 ${ask.taskIdentifier} 请求调用受限工具 ${ask.toolName}\n` +
        `  说明: ${ask.explanation}\n` +
        `  参数: ${ask.argumentsJson}\n` +
        "  allow-once = 仅本次按上述精确参数授权；参数变化将失效需要重新裁决。\n" +
        "  输入 allow-once 授权 / 其他任意输入拒绝：",
    );
    const decision = await options.readDecision(ask);
    if (decision === null) {
      // 有界等待耗尽（管道已无输入）→ fail-closed，任务保持 blocked 待人工处理。
      writePrompt(
        `未在等待上限内收到裁决输入（或输入通道已关闭）：未授权、未继续任务，${ask.toolName} 保持等待人工裁决。`,
      );
      return "requires-human-resubmission";
    }
    if (decision !== "allow-once") {
      writePrompt(`已拒绝权限调用 ${ask.toolName}（未授权、未继续任务）。`);
      return "denied";
    }
  }
  const nowUnixSeconds = Math.floor(Date.now() / 1000);
  // 顺序要紧：先登记两类授权，再下发 unblock（unblock 会立即重新派发任务）。
  // 权限引擎授权：让受限工具在重跑时被判 allow。
  await options.application.grantSessionAuthorization(
    ask.toolName,
    ask.argumentsJson,
    nowUnixSeconds,
  );
  // 作用域一次性授权：被询问拦下的那次已把它消费，重跑需重新登记一次。
  let scopeGrantOutcome = "unsupported";
  if (typeof options.application.grantScopeAuthorizationForToolCall === "function") {
    try {
      const scopeGrant = await options.application.grantScopeAuthorizationForToolCall({
        toolName: ask.toolName,
        argumentsJson: ask.argumentsJson,
      });
      scopeGrantOutcome = scopeGrant === null ? "not-scope-gated" : "granted";
    } catch (error) {
      scopeGrantOutcome = "failed:" + (error as Error).message;
    }
  }
  options.application.sendSchedulerInstruction(
    options.missionIdentifier,
    JSON.stringify({ action: "unblock", taskId: ask.taskIdentifier }),
  );
  writePrompt(
    (isAutoReused
      ? `已复用本次授权（同逻辑操作、尚无副作用）授权 ${ask.toolName}`
      : `已按精确参数 allow-once 授权 ${ask.toolName}`) +
      `（作用域授权: ${scopeGrantOutcome}），` +
      `并下发 unblock（任务 ${ask.taskIdentifier}）。`,
  );
  return "allowed-once";
}

/**
 * 是否存在用户裁决输入通道：
 * - TTY 交互终端；或
 * - stdin 已被重定向/管道（用户显式提供的输入，例如 `echo allow-once | astarray run …`）。
 *
 * 两者都要求用户**明确输入** `allow-once`；无输入即 fail-closed（不授权）。
 * 不含任何"配置文件开关"--yes/环境变量"的自动放行路径。
 */
export function hasDecisionInputChannel(): boolean {
  // TTY 交互终端 → 可询问；stdin 非 TTY（管道/重定向/关闭）→ 视为显式输入通道。
  return process.stdin.isTTY !== true;
}

/**
 * 按**换行**切分的 stdin 行读取器。
 *
 * 不能把"一次 data 事件"当成一行：管道里多行裁决会一次性到达
 * （`printf 'allow-once\nallow-once\n' | …`），按 chunk 读会把整段当成一行而误判为拒绝
 * （2026-10-02 真实 CLI 端到端复现）。此处缓存跨 chunk 的半行并逐行产出。
 */
export function createStdinLineReader(): () => Promise<string | null> {
  const pendingLines: string[] = [];
  const pendingResolvers: Array<(line: string | null) => void> = [];
  let remainder = "";
  let isEnded = false;

  const flushLine = (line: string): void => {
    const resolver = pendingResolvers.shift();
    if (resolver === undefined) {
      pendingLines.push(line);
      return;
    }
    resolver(line);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const combined = remainder + chunk;
    const segments = combined.split("\n");
    remainder = segments.pop() ?? "";
    for (const segment of segments) {
      flushLine(segment.replace(/\r$/, ""));
    }
  });
  process.stdin.on("end", () => {
    isEnded = true;
    if (remainder !== "") {
      flushLine(remainder);
      remainder = "";
    }
  });
  process.stdin.on("error", () => {
    isEnded = true;
  });

  return () =>
    new Promise<string | null>((resolve) => {
      const buffered = pendingLines.shift();
      if (buffered !== undefined) {
        resolve(buffered);
        return;
      }
      if (isEnded) {
        resolve(null);
        return;
      }
      pendingResolvers.push(resolve);
    });
}

/** 交互裁决端口（默认实现：TTY 或管道显式输入；逐次询问，无会话记忆）。 */
export class InteractivePermissionAskDecisionPort implements PermissionAskDecisionPort {
  private readonly isInteractiveFlag: () => boolean;
  private readonly hasInputChannelFlag: () => boolean;
  private readonly readLine: () => Promise<string | null>;
  private readonly readTimeoutMilliseconds: number;

  constructor(options: {
    isInteractive?: () => boolean;
    /** 是否存在用户输入通道（默认 TTY 或管道/重定向 stdin）。 */
    hasDecisionInput?: () => boolean;
    /** 读取一行（默认 process.stdin）；测试可注入。 */
    readLine?: () => Promise<string | null>;
    /**
     * 裁决输入等待上限（毫秒，默认 120_000）。管道输入在上一轮被消费后，
     * 若再无输入必须**有界中止**并 fail-closed，不得永久挂起进程。
     */
    readTimeoutMilliseconds?: number;
  } = {}) {
    this.isInteractiveFlag =
      options.isInteractive ?? (() => process.stdin.isTTY === true);
    this.hasInputChannelFlag = options.hasDecisionInput ?? hasDecisionInputChannel;
    this.readTimeoutMilliseconds = options.readTimeoutMilliseconds ?? 120_000;
    this.readLine = options.readLine ?? createStdinLineReader();
  }

  /** 当前裁决输入等待上限（毫秒；供调用方与测试断言有界性）。 */
  getReadTimeoutMilliseconds(): number {
    return this.readTimeoutMilliseconds;
  }

  isInteractive(): boolean {
    return this.isInteractiveFlag() || this.hasInputChannelFlag();
  }

  async readDecision(_ask: PermissionAsk): Promise<"allow-once" | "deny" | null> {
    if (!this.isInteractiveFlag() && !this.hasInputChannelFlag()) {
      return null;
    }
    // 有界等待：无输入即 fail-closed（返回 null → 不授权、不 unblock）。
    const answer = await Promise.race([
      this.readLine(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), this.readTimeoutMilliseconds);
      }),
    ]);
    if (answer === null) {
      return null;
    }
    return answer.trim().toLowerCase() === "allow-once" ? "allow-once" : "deny";
  }
}
