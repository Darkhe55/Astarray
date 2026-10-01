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

export interface PermissionAsk {
  taskIdentifier: string;
  toolName: string;
  /** 精确参数（授权哈希绑定用；不得改写、不得截断）。 */
  argumentsJson: string;
  explanation: string;
}

export type PermissionAskDecision =
  | "allowed-once"
  | "denied"
  | "requires-human-resubmission";

/** 裁决执行需要的最小应用面（避免依赖 facade 具体类型）。 */
export interface PermissionAskApplicationPort {
  grantSessionAuthorization(
    toolName: string,
    argumentsJson: string,
    nowUnixSeconds: number,
  ): Promise<void>;
  /**
   * 重新登记作用域一次性授权（被询问拦下的那次会消耗它；缺失实现时跳过，
   * 由调用方在结果上如实反映）。
   */
  grantScopeAuthorizationForToolCall?(input: {
    toolName: string;
    argumentsJson: string;
  }): Promise<{ receiptIdentifier: string; operationFingerprint: string } | null>;
  sendSchedulerInstruction(missionId: string, instructionText: string): void;
}

export interface PermissionAskDecisionPort {
  /** 是否具备可信交互通道（TTY）。false 时必须 fail-closed。 */
  isInteractive(): boolean;
  /** 询问用户；返回 null 表示无裁决（fail-closed）。 */
  readDecision(ask: PermissionAsk): Promise<"allow-once" | "deny" | null>;
}

/**
 * 匹配形态（**不锚定结尾**）：真实升级文本的参数 JSON 键序不定
 * （实测 `{"content": ..., "filePath": ...}`），且可能带尾随换行。
 */
const ESCALATION_PATTERN =
  /任务\s+(\S+)\s+需要权限调用\s+(\S+?)\s*[（(]([\s\S]*?)[）)]，参数:\s*(\{[\s\S]*\})\s*$/;

/**
 * 从调度层升级文本解析结构化询问。
 * 来源：`mission-orchestrator` 的 permission-ask 分支（同一字符串即 ADR-0011 要求送达用户的内容）。
 * 解析失败返回 null：调用方必须退化为"需人工重提"，不得猜测工具或参数。
 */
export function buildPermissionAskFromEscalation(
  escalationText: string,
): PermissionAsk | null {
  const normalizedText = escalationText.trim();
  const matched = ESCALATION_PATTERN.exec(normalizedText);
  if (matched === null) {
    return null;
  }
  const taskIdentifier = matched[1];
  const toolName = matched[2];
  const explanation = matched[3];
  const argumentsJson = matched[4];
  if (
    taskIdentifier === undefined ||
    toolName === undefined ||
    explanation === undefined ||
    argumentsJson === undefined
  ) {
    return null;
  }
  try {
    // 逐字保留原始 JSON（授权按参数哈希绑定），此处只做可解析性校验。
    JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  return {
    taskIdentifier,
    toolName,
    argumentsJson,
    explanation: explanation.trim(),
  };
}

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
}): Promise<PermissionAskDecision> {
  const ask = options.ask;
  const writePrompt = options.interactOutput ?? logToStderr;
  if (ask === null || options.missionIdentifier === null) {
    writePrompt(
      "需要权限的调用已阻断，但未能确认被请求的工具与参数：请人工检查并重新提交任务。",
    );
    return "requires-human-resubmission";
  }
  if (!options.isInteractive) {
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
    `已按精确参数 allow-once 授权 ${ask.toolName}（作用域授权: ${scopeGrantOutcome}），` +
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
    this.readLine =
      options.readLine ??
      (() =>
        new Promise<string | null>((resolve) => {
          process.stdin.setEncoding("utf8");
          const onData = (chunk: string): void => {
            process.stdin.off("data", onData);
            resolve(chunk.trim());
          };
          process.stdin.once("data", onData);
        }));
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
