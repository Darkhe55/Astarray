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

import { ToolPackageReauthorizationRecordStore } from "./tool-package-reauthorization-record-store.js";
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
  /** 在途调用（取消后必须仍可见，待按安全点收敛）。 */
  inFlightCalls: Array<{
    runIdentifier: string;
    stepIdentifier: string;
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    argumentHash: string;
  }>;
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
  /**
   * 重新授权记录存储（2026-10-13）：升级门禁的授权依据。
   * 与版本状态**分开落盘**，避免状态回滚把授权历史一起带走。
   */
  readonly reauthorizationRecordStore: ToolPackageReauthorizationRecordStore;

  constructor(options: ToolPackageVersionStateStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.reauthorizationRecordStore = new ToolPackageReauthorizationRecordStore({
      stateDirectory: options.stateDirectory,
    });
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
      inFlightCalls: raw.inFlightCalls ?? [],
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
      inFlightCalls: controller.listAllInFlightCalls(),
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

  /**
   * 升级项目版本（**唯一**门禁入口，2026-10-13 安全修正）。
   *
   * 入参不再接受"是否已重新授权"的**裸布尔**，改为要求给出**重新授权记录标识**；
   * 本方法按差异判定自行核验该记录（本地签发、操作绑定、未消费），核验通过后
   * 才向控制器传入 `hasVerifiedReauthorizationGrant: true`。
   *
   * 无记录 / 记录不存在 / 与本次差异不匹配 / 已被消费 ⇒ 一律**拒绝**（fail-closed），
   * 不存在"调用方顺手传 true 就放行"的路径。
   */
  async upgradeProjectVersion(input: {
    projectIdentifier: string;
    toolPackageId: string;
    toVersion: number;
    reauthorizationRecordIdentifier?: string;
  }): Promise<ReturnType<ToolPackageVersionController["upgradeProjectVersion"]>> {
    const controller = await this.loadController();

    const currentLockedVersion = controller
      .listProjectLocks()
      .find(
        (lock) =>
          lock.projectIdentifier === input.projectIdentifier &&
          lock.toolPackageId === input.toolPackageId,
      )?.version;
    const differences = controller.describeUpgradeDifferences({
      toolPackageId: input.toolPackageId,
      fromVersion: currentLockedVersion ?? input.toVersion,
      toVersion: input.toVersion,
    });

    if (differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;
      if (recordIdentifier === undefined || recordIdentifier === "") {
        return {
          isApplied: false,
          revision: 0,
          reason:
            "目标版本含**新增副作用**，须提供该操作的重新授权记录标识" +
            "（新增副作用: " + differences.addedSideEffects.join(",") + "）" +
            "：不接受调用方自述的布尔值",
        };
      }
      const consumeOutcome = await this.reauthorizationRecordStore.consumeRecordForOperation({
        recordIdentifier,
        scope: {
          projectIdentifier: input.projectIdentifier,
          toolPackageId: input.toolPackageId,
          fromVersion: currentLockedVersion ?? -1,
          toVersion: input.toVersion,
          addedSideEffects: [...differences.addedSideEffects],
        },
      });
      if (!consumeOutcome.isConsumed) {
        return {
          isApplied: false,
          revision: 0,
          reason: "重新授权核验未通过：" + String(consumeOutcome.reason ?? ""),
        };
      }
    }

    const outcome = controller.upgradeProjectVersion({
      projectIdentifier: input.projectIdentifier,
      toolPackageId: input.toolPackageId,
      toVersion: input.toVersion,
      hasVerifiedReauthorizationGrant: differences.requiresReauthorization,
    });
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
      inFlightCalls: [],
      pendingSwitches: [],
    };
  }
}
