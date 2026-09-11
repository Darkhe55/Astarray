/**
 * 全局上下文预算策略存储（T09A-R1-02 / ADR-0031 §11.1）。
 * 默认 4096；可调高/调低/设为 0（0 表示保留决策库但本轮不自动注入）；
 * revision 单调 + expected-revision CAS；设置变化从下一轮提示词装配生效。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { backupExistingFile, readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import {
  globalContextBudgetPolicySchema,
  type GlobalContextBudgetPolicy,
} from "./context-closure-schemas.js";

export const DEFAULT_GLOBAL_CONTEXT_BUDGET_TOKENS = 4096;

export interface GlobalContextBudgetStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
}

export interface UpdateGlobalContextBudgetInput {
  expectedRevision: number;
  configuredMaximumGlobalContextTokenCount: number;
  updatedByUserId: string;
}

export class GlobalContextBudgetStore {
  private readonly policyFilePath: string;
  private readonly backupFilePath: string;
  private readonly nowMilliseconds: () => number;
  private readonly storeLock = new AsyncMutex();

  constructor(options: GlobalContextBudgetStoreOptions) {
    const directoryPath = path.join(options.baseDirectory, "global-context");
    this.policyFilePath = path.join(directoryPath, "budget-policy.json");
    this.backupFilePath = path.join(directoryPath, "budget-policy.json.bak");
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  /** 读取当前策略；缺失返回默认 4096（revision 1）。 */
  async readPolicy(): Promise<GlobalContextBudgetPolicy> {
    const readResult = await readJsonWithBackupRecovery(
      this.policyFilePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return this.buildDefaultPolicy();
    }
    const parsed = globalContextBudgetPolicySchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        "全局上下文预算策略非法: " + parsed.error.message,
      );
    }
    return parsed.data;
  }

  /** 更新预算（CAS + 单调 revision + 自动备份）。 */
  async updatePolicy(
    input: UpdateGlobalContextBudgetInput,
  ): Promise<GlobalContextBudgetPolicy> {
    return this.storeLock.runExclusive(async () => {
      const current = await this.readPolicy();
      if (current.globalContextBudgetPolicyRevision !== input.expectedRevision) {
        throw new DomainError(
          "stale-revision",
          "预算策略 revision 不匹配: 现有 " +
            current.globalContextBudgetPolicyRevision +
            "，期望 " +
            input.expectedRevision,
        );
      }
      const next: GlobalContextBudgetPolicy = {
        schemaVersion: current.schemaVersion,
        configuredMaximumGlobalContextTokenCount:
          input.configuredMaximumGlobalContextTokenCount,
        globalContextBudgetPolicyRevision:
          current.globalContextBudgetPolicyRevision + 1,
        updatedByUserId: input.updatedByUserId,
        updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
      };
      const parsed = globalContextBudgetPolicySchema.safeParse(next);
      if (!parsed.success) {
        throw new DomainError(
          "invalid-task-chain",
          "预算策略非法（必须为非负整数）: " + parsed.error.message,
        );
      }
      await writeAtomicJson(this.policyFilePath, parsed.data);
      await backupExistingFile(this.policyFilePath, this.backupFilePath);
      return parsed.data;
    });
  }

  private buildDefaultPolicy(): GlobalContextBudgetPolicy {
    return {
      schemaVersion: 1,
      configuredMaximumGlobalContextTokenCount: DEFAULT_GLOBAL_CONTEXT_BUDGET_TOKENS,
      globalContextBudgetPolicyRevision: 1,
      updatedByUserId: "system-default",
      updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
    };
  }
}
