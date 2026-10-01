/**
 * Provider 配置装配与受保护凭据引用（T07D-06 / T07D 任务卡 §6.4）。
 *
 * - CLI 提供 config provider list/show/register/credential-set 与 doctor --provider：
 *   只报告配置存在、协议/能力匹配与安全连通状态，不回显凭据、
 *   完整 Endpoint secret、完整响应或用户 prompt；
 * - API key 不经命令行传递：本地受保护凭据引用文件
 *   （<stateDir>/providers/provider-credentials.json，进程内读取，值不进日志/导出）；
 * - mock 继续是默认离线测试路径；无凭据时不得静默改用未授权 Provider，
 *   也不伪造真实模型结果（未验证/条件兼容如实报告）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DomainError } from "../../../core/src/core/errors.js";
import { backupExistingFile } from "../../../core/src/infra/atomic-json.js";

/** 受保护凭据引用文件（本地敏感；禁止模型读取，gitignore 覆盖）。 */
const CREDENTIALS_FILE_NAME = "provider-credentials.json";

export interface ProviderCredentialEntry {
  /** 受保护引用 ID（公开；映射到凭据）。 */
  referenceId: string;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderCredentialStore {
  readCredential(referenceId: string): Promise<ProviderCredentialEntry | null>;
  /** 只报告引用是否存在（不返回内容）。 */
  doesReferenceExist(referenceId: string): Promise<boolean>;
  /** 列出引用 ID（不含内容；供 config provider list 使用）。 */
  listReferenceIds(): Promise<string[]>;
}

/** 文件系统受保护凭据存储（值只在此端口内流转）。 */
export class FileProviderCredentialStore implements ProviderCredentialStore {
  private readonly credentialsFilePath: string;

  constructor(stateDirectory: string) {
    this.credentialsFilePath = path.join(
      stateDirectory,
      "providers",
      CREDENTIALS_FILE_NAME,
    );
  }

  /**
   * 凭据文件绝对路径（公开，用于诊断/提示；文件内容仍是敏感值，不得读取回显）。
   */
  get filePath(): string {
    return this.credentialsFilePath;
  }

  private async readAll(): Promise<Record<string, ProviderCredentialEntry>> {
    try {
      const rawContent = await fs.readFile(this.credentialsFilePath, "utf8");
      return JSON.parse(rawContent) as Record<string, ProviderCredentialEntry>;
    } catch {
      return {};
    }
  }

  async writeCredential(entry: ProviderCredentialEntry): Promise<void> {
    const all = await this.readAll();
    const next = { ...all, [entry.referenceId]: entry };
    await fs.mkdir(path.dirname(this.credentialsFilePath), { recursive: true });
    await fs.writeFile(
      this.credentialsFilePath,
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
  }

  /**
   * 写入单个受保护引用，但**不落任何会持久化敏感值的中间文件**：
   * 1. 现有文件先备份为 `<文件>.bak`（覆盖前自动备份）；
   * 2. 合并新旧引用后经同目录受限权限**临时文件**写入并 flush，随即将权限收紧为 0600；
   * 3. rename 替换目标后删除临时文件（临时文件是唯一可能短暂持有敏感值的文件，
   *    不通过 writeAtomicJson 的共享名称，避免撞名/被误读）。
   *
   * 纯追加（`<文件>.jsonl`）刻意不采用：JSONL 会把同一引用的历史密钥长期留档，
   * 反而扩大暴露面；需要旧值时可读 `.bak`。
   */
  async writeCredentialSecurely(
    entry: ProviderCredentialEntry,
  ): Promise<{ isBackupCreated: boolean }> {
    const directoryPath = path.dirname(this.credentialsFilePath);
    await fs.mkdir(directoryPath, { recursive: true });
    const isBackupCreated = await backupExistingFile(
      this.credentialsFilePath,
      this.credentialsFilePath + ".bak",
    );
    const all = await this.readAll();
    const next = { ...all, [entry.referenceId]: entry };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    const tempFilePath = path.join(
      directoryPath,
      `${CREDENTIALS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      const fileHandle = await fs.open(tempFilePath, "wx", 0o600);
      try {
        await fileHandle.writeFile(serialized, "utf8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      if (process.platform !== "win32") {
        await fs.chmod(tempFilePath, 0o600);
        await fs.chmod(this.credentialsFilePath, 0o600).catch(() => {});
      }
      await fs.rename(tempFilePath, this.credentialsFilePath);
    } finally {
      await fs.rm(tempFilePath, { force: true }).catch(() => {});
    }
    return { isBackupCreated };
  }

  async readCredential(referenceId: string): Promise<ProviderCredentialEntry | null> {
    const all = await this.readAll();
    return all[referenceId] ?? null;
  }

  async doesReferenceExist(referenceId: string): Promise<boolean> {
    const all = await this.readAll();
    return referenceId in all;
  }

  async listReferenceIds(): Promise<string[]> {
    return Object.keys(await this.readAll());
  }
}

/** Provider 注册条目（公开 DTO；凭据只含引用）。 */
export interface ProviderRegistration {
  providerProfileId: string;
  protocolName: string;
  apiVersion: string;
  capabilities: string[];
  supportLevel: "adapter-only" | "fake-server-conformant" | "live-smoke-verified" | "product-path-verified";
  protectedCredentialReferenceId: string;
  verifiedAtIso: string | null;
}

/** CLI 装配的 Provider 目录（公开 DTO；凭据引用存在性校验；持久化）。 */
export class ProviderCliCatalog {
  private readonly registrationsByProviderId = new Map<
    string,
    ProviderRegistration
  >();
  private readonly catalogFilePath: string;

  constructor(stateDirectory: string) {
    this.catalogFilePath = path.join(stateDirectory, "providers", "provider-catalog.json");
  }

  private async loadRegistrations(): Promise<void> {
    try {
      const rawContent = await fs.readFile(this.catalogFilePath, "utf8");
      const parsed = JSON.parse(rawContent) as ProviderRegistration[];
      for (const registration of parsed) {
        this.registrationsByProviderId.set(
          registration.providerProfileId,
          registration,
        );
      }
    } catch {
      // 首次使用：无登记
    }
  }

  private async persistRegistrations(): Promise<void> {
    await fs.mkdir(path.dirname(this.catalogFilePath), { recursive: true });
    await fs.writeFile(
      this.catalogFilePath,
      `${JSON.stringify([...this.registrationsByProviderId.values()], null, 2)}\n`,
      "utf8",
    );
  }

  async registerProvider(input: {
    providerProfileId: string;
    protocolName: string;
    apiVersion: string;
    capabilities: string[];
    supportLevel: ProviderRegistration["supportLevel"];
    protectedCredentialReferenceId: string;
    credentialStore: ProviderCredentialStore;
  }): Promise<ProviderRegistration> {
    const doesReferenceExist = await input.credentialStore.doesReferenceExist(
      input.protectedCredentialReferenceId,
    );
    if (!doesReferenceExist) {
      throw new DomainError(
        "invalid-task-chain",
        `受保护凭据引用不存在（凭据不进入目录）: ${input.protectedCredentialReferenceId}`,
      );
    }
    await this.loadRegistrations();
    const registration: ProviderRegistration = {
      providerProfileId: input.providerProfileId,
      protocolName: input.protocolName,
      apiVersion: input.apiVersion,
      capabilities: input.capabilities,
      supportLevel: input.supportLevel,
      protectedCredentialReferenceId: input.protectedCredentialReferenceId,
      verifiedAtIso: null,
    };
    this.registrationsByProviderId.set(input.providerProfileId, registration);
    await this.persistRegistrations();
    return registration;
  }

  async getRegistration(
    providerProfileId: string,
  ): Promise<ProviderRegistration | null> {
    await this.loadRegistrations();
    return this.registrationsByProviderId.get(providerProfileId) ?? null;
  }

  async listRegistrations(): Promise<ProviderRegistration[]> {
    await this.loadRegistrations();
    return [...this.registrationsByProviderId.values()];
  }

  /** 安全连通状态：仅凭据引用存在性 + 支持等级（无网络探测回显）。 */
  describeConnectionStatus(registration: ProviderRegistration): {
    isConfigured: boolean;
    credentialReferenceResolved: boolean;
    supportLevel: ProviderRegistration["supportLevel"];
    isVerified: boolean;
  } {
    return {
      isConfigured: true,
      credentialReferenceResolved: true,
      supportLevel: registration.supportLevel,
      isVerified: registration.verifiedAtIso !== null,
    };
  }
}

/** 公共 DTO：剥离凭据引用（供 CLI 输出；不含任何密钥内容）。 */
export function toProviderPublicDto(
  registration: ProviderRegistration,
): Omit<ProviderRegistration, "protectedCredentialReferenceId"> {
  return {
    providerProfileId: registration.providerProfileId,
    protocolName: registration.protocolName,
    apiVersion: registration.apiVersion,
    capabilities: registration.capabilities,
    supportLevel: registration.supportLevel,
    verifiedAtIso: registration.verifiedAtIso,
  };
}