/**
 * 交互式删除备份授权通道（S5，审计整改）。
 * 协同模式下：向用户打印警告 → 暂停发起 Agent → 逐次读取用户决定（allow-once / deny）→ 返回决定。
 * 不使用会话记忆；非交互环境（stdin 非 TTY）一律拒绝（fail-closed）。
 */
import { createInterface } from "node:readline";

import type {
  BackupDeletionAuthorizationControlPort,
  BackupDeletionAuthorizationDecision,
  BackupDeletionAuthorizationRequest,
} from "../../../core/src/core/types.js";

export interface InteractiveBackupDeletionAuthorizationPortOptions {
  /** 交互输入流（默认 process.stdin）；测试可注入带 isTTY 的伪流。 */
  input?: { isTTY: boolean };
  /** 警告输出（默认 process.stderr，JSON 模式保持 stdout 干净）。 */
  warnOutput?: { write(text: string): void };
}

export class InteractiveBackupDeletionAuthorizationPort
  implements BackupDeletionAuthorizationControlPort
{
  private readonly warnOutput: { write(text: string): void };

  constructor(private readonly options: InteractiveBackupDeletionAuthorizationPortOptions = {}) {
    this.warnOutput = options.warnOutput ?? process.stderr;
  }

  async requestAuthorization(
    request: BackupDeletionAuthorizationRequest,
  ): Promise<BackupDeletionAuthorizationDecision> {
    const inputStream = this.options.input ?? process.stdin;
    if (!inputStream.isTTY) {
      this.warnOutput.write(
        "astarray: 非交互环境无法取得删除备份授权，删除被拒绝（fail-closed）。\n",
      );
      return {
        authorizationRequestId: request.authorizationRequestId,
        requestingAgentInstanceId: request.requestingAgentInstanceId,
        decision: "deny",
        authorizedBackupIdentifiers: [],
        expectedVaultRevision: 1,
        expiresAtIso: new Date().toISOString(),
      };
    }
    this.warnOutput.write(
      [
        "",
        "⚠ 删除备份授权请求（仅本次生效，不记忆）：",
        `  请求方: ${request.requestingAgentInstanceId}`,
        `  涉及备份: ${request.backupIdentifiers.join(", ")}`,
        `  警告: ${request.warningText}`,
        "  输入 [yes] 允许一次删除，其他输入视为拒绝。",
        "",
      ].join("\n"),
    );

    const readlineInterface = createInterface({
      input: inputStream as unknown as NodeJS.ReadableStream,
      terminal: false,
    });
    try {
      const answer = await readAnswer(readlineInterface);
      const isAllowed = answer.trim().toLowerCase() === "yes";
      if (!isAllowed) {
        this.warnOutput.write(`astarray: 用户拒绝删除备份（输入: ${answer.trim()}）。\n`);
      }
      return {
        authorizationRequestId: request.authorizationRequestId,
        requestingAgentInstanceId: request.requestingAgentInstanceId,
        decision: isAllowed ? "allow-once" : "deny",
        authorizedBackupIdentifiers: isAllowed ? request.backupIdentifiers : [],
        expectedVaultRevision: 1,
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
      };
    } finally {
      readlineInterface.close();
    }
  }
}

function readAnswer(readlineInterface: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve) => {
    readlineInterface.question("授权删除备份? [yes/其他拒绝] ", (answer) => {
      resolve(answer);
    });
  });
}
