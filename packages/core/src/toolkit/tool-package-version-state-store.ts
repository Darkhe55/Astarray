/**
 * TOOLKIT-01-04：工具包版本状态的**持久化**存储（2026-10-10）。
 *
 * 为什么需要它：`ToolPackageVersionController` 是纯内存判定器，
 * 而 CLI 是**独立进程**（每次调用一个新进程），因此"锁定/启用/停用/回滚/历史"
 * 必须落盘才能被后续进程看到 —— 否则"停用阻止新运行"与"回滚"在真实使用路径上不可达。
 *
 * 本模块只做读写与状态搬运：判定逻辑全部复用控制器，**不复制**任何规则，
 * 避免出现"存储层和判定层结论不一致"。
 */

import { ToolPackageVersionController } from "./tool-package-version-controller.js";
import type {
  ToolPackageCallRecord,
  ToolPackageVersionLifecycleStatus,
  ToolPackageVersionRegistration,
} from "./tool-package-version-controller.js";

export const TOOL_PACKAGE_VERSION_STATE_SCHEMA_VERSION =
  "ASTARRAY_TOOL_PACKAGE_VERSION_STATE_V1";

const STATE_FILE_NAME = "tool-package-version-state.json";

export interface ToolPackageVersionStateSnapshot {
  schemaVersion: string;
  versions: Array<{
    registration: ToolPackageVersionRegistration;
    status: ToolPackageVersionLifecycleStatus;
  }>;
  projectLocks: Array<{
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
    isEnabled: boolean;
    revision: number;
  }>;
  callHistory: ToolPackageCallRecord[];
  pendingSwitches: Array<{
    projectIdentifier: string;
    toolPackageId: string;
    intendedVersion: number;
    intendedContentHash: string;
  }>;
}

export interface ToolPackageVersionStateStoreOptions {
  stateDirectory: string;
}

export class ToolPackageVersionStateStore {
  private readonly stateDirectory: string;

  constructor(options: ToolPackageVersionStateStoreOptions) {
    this.stateDirectory = options.stateDirectory;
  }

  private get stateFilePath(): string {
    return `${this.stateDirectory}/${STATE_FILE_NAME}`;
  }

  private get backupFilePath(): string {
    return `${this.stateFilePath}.backup`;
  }

  /** 读取快照；文件不存在 ⇒ 返回空快照（**不创建文件**）。 */
  async readSnapshot(): Promise<ToolPackageVersionStateSnapshot> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.stateFilePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return this.buildEmptySnapshot();
    }
    const raw = readResult.content as ToolPackageVersionStateSnapshot;
    if (raw === null || typeof raw !== "object" || !Array.isArray(raw.versions)) {
      throw new Error("工具包版本状态文件非法（请修正或删除）");
    }
    return {
      schemaVersion: TOOL_PACKAGE_VERSION_STATE_SCHEMA_VERSION,
      versions: raw.versions,
      projectLocks: raw.projectLocks ?? [],
      callHistory: raw.callHistory ?? [],
      pendingSwitches: raw.pendingSwitches ?? [],
    };
  }

  /** 载入一个已恢复状态的控制器（供判定与变更）。 */
  async loadController(): Promise<ToolPackageVersionController> {
    const snapshot = await this.readSnapshot();
    const controller = new ToolPackageVersionController();
    controller.restoreFromSnapshot(snapshot);
    return controller;
  }

  /** 把控制器当前状态落盘（原子写 + 备份）。 */
  async saveController(controller: ToolPackageVersionController): Promise<void> {
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    const snapshot: ToolPackageVersionStateSnapshot = {
      schemaVersion: TOOL_PACKAGE_VERSION_STATE_SCHEMA_VERSION,
      versions: controller.listRegisteredVersions(),
      projectLocks: controller.listProjectLocks(),
      callHistory: controller.listAllCallRecords(),
      pendingSwitches: controller.listPendingSwitches(),
    };
    await backupExistingFile(this.stateFilePath, this.backupFilePath);
    await writeAtomicJson(this.stateFilePath, snapshot);
  }

  /* ────────── 便捷方法：读-改-写（每次变更都原子落盘） ────────── */

  async registerVersion(registration: ToolPackageVersionRegistration): Promise<void> {
    const controller = await this.loadController();
    controller.registerVersion(registration);
    await this.saveController(controller);
  }

  async registerVersions(registrations: ToolPackageVersionRegistration[]): Promise<void> {
    const controller = await this.loadController();
    for (const registration of registrations) {
      controller.registerVersion(registration);
    }
    await this.saveController(controller);
  }

  async lockProjectToVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
  }): Promise<ReturnType<ToolPackageVersionController["lockProjectToVersion"]>> {
    const controller = await this.loadController();
    const outcome = controller.lockProjectToVersion(input);
    await this.saveController(controller);
    return outcome;
  }

  async enableForProject(input: {
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
  }): Promise<ReturnType<ToolPackageVersionController["enableForProject"]>> {
    const controller = await this.loadController();
    const outcome = controller.enableForProject(input);
    await this.saveController(controller);
    return outcome;
  }

  async upgradeProjectVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    toVersion: number;
    isReauthorized: boolean;
  }): Promise<ReturnType<ToolPackageVersionController["upgradeProjectVersion"]>> {
    const controller = await this.loadController();
    const outcome = controller.upgradeProjectVersion(input);
    await this.saveController(controller);
    return outcome;
  }

  async disableForProject(input: {
    projectIdentifier: string;
    toolPackageId: string;
  }): Promise<ReturnType<ToolPackageVersionController["disableForProject"]>> {
    const controller = await this.loadController();
    const outcome = controller.disableForProject(input);
    await this.saveController(controller);
    return outcome;
  }

  async rollbackProjectVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    toVersion: number;
  }): Promise<ReturnType<ToolPackageVersionController["rollbackProjectVersion"]>> {
    const controller = await this.loadController();
    const outcome = controller.rollbackProjectVersion(input);
    await this.saveController(controller);
    return outcome;
  }

  async describeUpgradeDifferences(input: {
    toolPackageId: string;
    fromVersion: number;
    toVersion: number;
  }): Promise<ReturnType<ToolPackageVersionController["describeUpgradeDifferences"]>> {
    const controller = await this.loadController();
    return controller.describeUpgradeDifferences(input);
  }

  private buildEmptySnapshot(): ToolPackageVersionStateSnapshot {
    return {
      schemaVersion: TOOL_PACKAGE_VERSION_STATE_SCHEMA_VERSION,
      versions: [],
      projectLocks: [],
      callHistory: [],
      pendingSwitches: [],
    };
  }
}
