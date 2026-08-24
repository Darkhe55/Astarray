/**
 * Agent 陈旧写入守卫与 patch 保全（T05D-03 / ADR-0028 §3）。
 *
 * Agent 每次实际写入前：
 * - 写入路径必须在编辑意图的 allowedWritePaths 内（路径边界）；
 * - 意图未过期（expiresAtIso）；
 * - 目标当前规范指纹与意图记录的基础指纹一致（人工变化 → stale-human-change）；
 * 任一不满足 → 拒绝写入（DomainError stale-human-change），
 * 并把 Agent 待写 patch 保全到 patch 保管库（可追溯、不丢失）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import { agentEditIntentSchema } from "./human-agent-concurrent-change-schemas.js";
import type { AgentEditIntent } from "./human-agent-concurrent-change-schemas.js";
import type { HumanFileFingerprintPort } from "./human-worktree-observer.js";

export interface StaleWriteGuardOptions {
  fingerprintPort: HumanFileFingerprintPort;
  /** patch 保管库目录（<base>/agent-patch-vault；拒绝时保全待写 patch）。 */
  patchVaultBaseDirectory: string;
  /** 当前时刻（毫秒；意图过期判定）。 */
  nowUnixMilliseconds?: () => number;
}

export interface GuardWriteInput {
  intent: AgentEditIntent;
  /** Agent 待写入的目标路径（必须属于 allowedWritePaths）。 */
  targetPath: string;
  /** Agent 待写内容（拒绝时保全为可追溯 patch）。 */
  pendingWriteContent: string;
}

export type GuardWriteResult =
  | { isAllowed: true }
  | { isAllowed: false; staleReason: string; preservedPatchPath: string };

export class StaleWriteGuard {
  private readonly fingerprintPort: HumanFileFingerprintPort;
  private readonly patchVaultRootDirectory: string;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: StaleWriteGuardOptions) {
    this.fingerprintPort = options.fingerprintPort;
    this.patchVaultRootDirectory = path.join(
      options.patchVaultBaseDirectory,
      "agent-patch-vault",
    );
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? Date.now;
  }

  /**
   * 守卫一次 Agent 写入：路径边界 → 意图过期 → 基线指纹一致。
   * 任一失败：拒绝（stale-human-change）并把待写内容保全为 patch。
   */
  async guardWrite(input: GuardWriteInput): Promise<GuardWriteResult> {
    const parsedIntent = agentEditIntentSchema.safeParse(input.intent);
    if (!parsedIntent.success) {
      throw new DomainError(
        "invalid-task-chain",
        `编辑意图非法: ${parsedIntent.error.message}`,
      );
    }
    const intent = parsedIntent.data;

    if (!intent.allowedWritePaths.includes(input.targetPath)) {
      return this.preserveRejectedWrite(input, `写入路径不在意图允许范围: ${input.targetPath}`);
    }
    if (new Date(intent.expiresAtIso).getTime() <= this.nowUnixMilliseconds()) {
      return this.preserveRejectedWrite(input, "编辑意图已过期");
    }
    const baselineFingerprint = intent.initialResourceFingerprintsByPath[input.targetPath];
    if (baselineFingerprint === undefined) {
      return this.preserveRejectedWrite(
        input,
        `目标路径不在意图基线指纹记录中: ${input.targetPath}`,
      );
    }
    let currentFingerprint: string;
    try {
      currentFingerprint =
        await this.fingerprintPort.computeFingerprint(input.targetPath);
    } catch {
      return this.preserveRejectedWrite(
        input,
        `目标文件当前不可读取（可能被人工删除/重命名）: ${input.targetPath}`,
      );
    }
    if (currentFingerprint !== baselineFingerprint) {
      return this.preserveRejectedWrite(
        input,
        `目标内容指纹变化（stale-human-change）：基线 ${baselineFingerprint} ≠ 当前 ${currentFingerprint}`,
      );
    }
    return { isAllowed: true };
  }

  /** 保全被拒绝的待写 patch（可追溯、不丢失），并返回拒绝结果。 */
  private async preserveRejectedWrite(
    input: GuardWriteInput,
    staleReason: string,
  ): Promise<GuardWriteResult> {
    const patchFileName = `${sanitizePathSegment(input.intent.editIntentIdentifier)}.patch`;
    const patchFilePath = path.join(this.patchVaultRootDirectory, patchFileName);
    await fs.mkdir(this.patchVaultRootDirectory, { recursive: true });
    const preservedContent =
      `# stale-human-change patch（T05D-03 保全；可追溯）\n` +
      `# editIntentIdentifier: ${input.intent.editIntentIdentifier}\n` +
      `# agentInstanceId: ${input.intent.agentInstanceId}\n` +
      `# targetPath: ${input.targetPath}\n` +
      `# baseCommitIdentifier: ${input.intent.baseCommitIdentifier}\n` +
      `# staleReason: ${staleReason}\n` +
      `--- ${input.targetPath}\n` +
      `+++ ${input.targetPath}\n` +
      `@@ 待应用内容 @@\n` +
      `${input.pendingWriteContent}\n`;
    await fs.writeFile(patchFilePath, preservedContent, "utf8");
    return { isAllowed: false, staleReason, preservedPatchPath: patchFilePath };
  }
}