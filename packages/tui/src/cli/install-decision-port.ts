/**
 * CLI 安装门禁交互端口（B6R-02 / ADR-0019）。
 * 提供已有资源询问与 allow-once 授权交互；非 TTY（无可信交互通道）
 * 一律 fail-closed：返回 null（由守卫拒绝），`--yes`、环境变量与
 * 模型文字不能放行。
 */
import type {
  AssistInstallationRequest,
  ExistingResourceAnswer,
  ExistingResourceInquiry,
} from "../../../core/src/tools/assist-installation-gate.js";
import type { InstallationGateUserPort } from "../../../core/src/tools/installation-gate-guard.js";

export interface InteractiveInstallationGatePortOptions {
  /** 交互输出（默认 process.stderr，保持 stdout 仅 JSON）。 */
  interactOutput?: NodeJS.WritableStream;
  /** 是否可交互（TTY）；false 时 fail-closed。 */
  isInteractive: () => boolean;
  /** 用户回答输入（默认 process.stdin）。 */
  readLine?: () => Promise<string | null>;
}

/**
 * 交互端口：非 TTY 时所有询问返回 null（fail-closed）。
 * TTY 下逐次询问并等待用户明确输入 yes/no；不做会话记忆。
 */
export class InteractiveInstallationGatePort implements InstallationGateUserPort {
  private readonly interactOutput: NodeJS.WritableStream;
  private readonly isInteractive: () => boolean;
  private readonly readLine: () => Promise<string | null>;

  constructor(options: InteractiveInstallationGatePortOptions) {
    this.interactOutput = options.interactOutput ?? process.stderr;
    this.isInteractive = options.isInteractive;
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

  async askExistingResource(
    inquiry: ExistingResourceInquiry,
  ): Promise<ExistingResourceAnswer | null> {
    if (!this.isInteractive()) {
      return null; // fail-closed：无交互通道
    }
    this.interactOutput.write(
      `[安装门禁] 需要能力: ${inquiry.requiredCapabilitySummary}\n` +
        `用途: ${inquiry.intendedUse}\n` +
        `是否已有满足任务的资源？（已有请输入资源引用；没有请输入 no）\n`,
    );
    const answer = await this.readLine();
    if (answer === null || answer.toLowerCase() === "no" || answer.trim() === "") {
      if (answer === null || answer.trim() === "") {
        return null;
      }
      return { answer: "no-resource" };
    }
    return {
      answer: "has-resource",
      resourceReference: answer.trim(),
      providedResourceType: "user-provided",
    };
  }

  async askAllowOnce(
    request: AssistInstallationRequest,
  ): Promise<"allow-once" | "deny" | null> {
    if (!this.isInteractive()) {
      return null; // fail-closed
    }
    this.interactOutput.write(
      `[安装门禁] 精确安装计划:\n` +
        `  包/仓库: ${request.packageOrRepositoryIdentifier}\n` +
        `  版本: ${request.pinnedVersionOrCommit ?? "未固定"}\n` +
        `  目标: ${request.targetPathOrScope}\n` +
        `  包管理器: ${request.packageManager}\n` +
        `  预计变更: ${request.expectedChangesSummary}\n` +
        `仅允许本次安装？(yes/no)\n`,
    );
    const answer = await this.readLine();
    if (answer === null) {
      return null;
    }
    return answer.toLowerCase() === "yes" ? "allow-once" : "deny";
  }
}
