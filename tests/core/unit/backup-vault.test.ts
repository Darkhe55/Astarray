/**
 * T06A：工具内破坏性变更备份层测试。
 * 覆盖：自动 pre-image、list/read/restore、两阶段 quarantine+purge、
 * 协同模式逐次授权（allow-once/deny/revision 校验）、放权模式 HIGH 审计链。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import type {
  BackupDeletionAuthorizationDecision,
  BackupDeletionAuthorizationRequest,
} from "../../../packages/core/src/core/types.js";
import {
  BackupDeletionAuditLog,
  BackupDeletionAuthorizationController,
  BackupVault,
} from "../../../packages/core/src/tools/backup-vault.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-vault-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

async function makeVault(): Promise<BackupVault> {
  const vault = new BackupVault({ baseDirectory: temporaryDirectory });
  await vault.initialize();
  return vault;
}

describe("BackupVault 自动 pre-image", () => {
  it("破坏性变更前自动保存完整 pre-image，可读取与恢复", async () => {
    const vault = await makeVault();
    const targetPath = path.join(temporaryDirectory, "target.txt");
    await fs.writeFile(targetPath, "原始内容", "utf8");

    const receipt = await vault.createPreMutationBackup({
      toolName: "replaceFileContent",
      targetPath,
      mutationKind: "overwrite",
    });
    expect(receipt.backupIdentifier).toMatch(/^backup-/);
    expect(receipt.targetFingerprintBeforeMutation).toMatch(/^[a-f0-9]{64}$/);

    // 目标被修改后，备份仍持有原始内容（显式编码 + 媒体类型）
    await fs.writeFile(targetPath, "新内容", "utf8");
    const backedUpContent = await vault.readBackup(receipt.backupIdentifier);
    expect(backedUpContent.content).toBe("原始内容");
    expect(backedUpContent.encoding).toBe("utf-8");
    expect(backedUpContent.mediaType).toContain("text/plain");

    const restored = await vault.restoreBackup(receipt.backupIdentifier);
    expect(restored.restoredPath).toBe(targetPath);
    expect(await fs.readFile(targetPath, "utf8")).toBe("原始内容");
  });

  it("listBackups 只返回元数据，不含 pre-image 内容", async () => {
    const vault = await makeVault();
    await vault.createPreMutationBackup({
      toolName: "replaceFileContent",
      targetPath: path.join(temporaryDirectory, "a.txt"),
      mutationKind: "replace",
    });
    const entries = await vault.listBackups(null);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "replaceFileContent", status: "active" });
    expect(JSON.stringify(entries[0])).not.toContain("原始内容");
  });

  it("不存在的备份 read/restore 报错；purged 备份不可读", async () => {
    const vault = await makeVault();
    await expect(vault.readBackup("backup-ghost")).rejects.toThrow();
    const targetPath = path.join(temporaryDirectory, "b.txt");
    await fs.writeFile(targetPath, "内容", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath,
      mutationKind: "delete-resource",
    });
    await vault.quarantineBackups([receipt.backupIdentifier]);
    await vault.purgeQuarantinedBackups([receipt.backupIdentifier]);
    await expect(vault.readBackup(receipt.backupIdentifier)).rejects.toThrow();
  });

  it("两阶段删除：先隔离后清除，purged 后 list 不再出现", async () => {
    const vault = await makeVault();
    const targetPath = path.join(temporaryDirectory, "c.txt");
    await fs.writeFile(targetPath, "内容", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath,
      mutationKind: "delete-resource",
    });
    const quarantined = await vault.quarantineBackups([receipt.backupIdentifier]);
    expect(quarantined).toEqual([receipt.backupIdentifier]);
    expect((await vault.listBackups(null))[0]?.status).toBe("quarantined");
    const purged = await vault.purgeQuarantinedBackups([receipt.backupIdentifier]);
    expect(purged).toEqual([receipt.backupIdentifier]);
    expect(await vault.listBackups(null)).toHaveLength(0);
    // 重复清除幂等
    expect(await vault.purgeQuarantinedBackups([receipt.backupIdentifier])).toEqual([]);
  });

  it("manifest revision 随写入单调递增", async () => {
    const vault = await makeVault();
    const initialRevision = vault.getManifestRevision();
    const targetPath = path.join(temporaryDirectory, "d.txt");
    await fs.writeFile(targetPath, "x", "utf8");
    await vault.createPreMutationBackup({
      toolName: "replaceFileContent",
      targetPath,
      mutationKind: "overwrite",
    });
    expect(vault.getManifestRevision()).toBeGreaterThan(initialRevision);
  });

  it("二进制文件 pre-image 可完整恢复（审计 S3）", async () => {
    const vault = await makeVault();
    const targetPath = path.join(temporaryDirectory, "binary.dat");
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x00, 0x00]);
    await fs.writeFile(targetPath, binaryContent);
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath,
      mutationKind: "delete-resource",
    });
    await fs.writeFile(targetPath, Buffer.from([0x99, 0x99]));
    await vault.restoreBackup(receipt.backupIdentifier);
    const restored = await fs.readFile(targetPath);
    expect(Buffer.compare(restored, binaryContent)).toBe(0);
  });

  it("目录快照可递归恢复（含子目录与二进制文件，跳过符号链接）", async () => {
    const vault = await makeVault();
    const targetDirectory = path.join(temporaryDirectory, "data-dir");
    await fs.mkdir(path.join(targetDirectory, "sub"), { recursive: true });
    await fs.writeFile(path.join(targetDirectory, "a.txt"), "文本A", "utf8");
    await fs.writeFile(path.join(targetDirectory, "sub", "b.bin"), Buffer.from([0x00, 0xab]));
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath: targetDirectory,
      mutationKind: "delete-resource",
    });
    // 目录被删除后整体恢复
    await fs.rm(targetDirectory, { recursive: true, force: true });
    await vault.restoreBackup(receipt.backupIdentifier);
    expect(await fs.readFile(path.join(targetDirectory, "a.txt"), "utf8")).toBe("文本A");
    const binaryRestored = await fs.readFile(path.join(targetDirectory, "sub", "b.bin"));
    expect(Buffer.compare(binaryRestored, Buffer.from([0x00, 0xab]))).toBe(0);
  });

  it("restoreBackup 恢复前自动备份当前版本（恢复可撤销，审计 S3）", async () => {
    const vault = await makeVault();
    const targetPath = path.join(temporaryDirectory, "undo.txt");
    await fs.writeFile(targetPath, "v1", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "replaceFileContent",
      targetPath,
      mutationKind: "overwrite",
    });
    await fs.writeFile(targetPath, "v2", "utf8");
    await vault.restoreBackup(receipt.backupIdentifier);
    expect(await fs.readFile(targetPath, "utf8")).toBe("v1");
    // 恢复动作本身产生了一条新备份（v2 的 pre-image），可以再撤销一次恢复
    const entries = await vault.listBackups(null);
    expect(entries).toHaveLength(2);
    await vault.restoreBackup(entries[1]!.backupIdentifier);
    expect(await fs.readFile(targetPath, "utf8")).toBe("v2");
  });

  it("purge 物理删除失败时保持 quarantined 并抛错（审计 S3）", async () => {
    const vault = await makeVault();
    const targetPath = path.join(temporaryDirectory, "purge.txt");
    await fs.writeFile(targetPath, "内容", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath,
      mutationKind: "delete-resource",
    });
    await vault.quarantineBackups([receipt.backupIdentifier]);
    // 用目录占用数据文件位置，使 rm 失败
    const dataFilePath = path.join(
      temporaryDirectory,
      "backup-vault",
      "data",
      receipt.backupIdentifier,
    );
    await fs.rm(dataFilePath, { force: true });
    await fs.mkdir(dataFilePath);
    await expect(
      vault.purgeQuarantinedBackups([receipt.backupIdentifier]),
    ).rejects.toThrow();
    const entries = await vault.listBackups(null);
    expect(entries[0]?.status).toBe("quarantined");
    await fs.rm(dataFilePath, { recursive: true, force: true });
  });

  it("verifyTargetUnchanged：目标被修改返回 false，未修改返回 true（审计 S3）", async () => {
    const vault = await makeVault();
    const targetPath = path.join(temporaryDirectory, "verify.txt");
    await fs.writeFile(targetPath, "原始", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "replaceFileContent",
      targetPath,
      mutationKind: "overwrite",
    });
    expect(
      await vault.verifyTargetUnchanged(targetPath, receipt.targetFingerprintBeforeMutation),
    ).toBe(true);
    await fs.writeFile(targetPath, "改了", "utf8");
    expect(
      await vault.verifyTargetUnchanged(targetPath, receipt.targetFingerprintBeforeMutation),
    ).toBe(false);
  });
});

describe("BackupDeletionAuthorizationController", () => {
  it("放权模式：不提示用户，直接授权并写 HIGH 审计记录", async () => {
    const modeMachine = new ModeMachine("devolve");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const controller = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: null,
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const vault = await makeVault();
    const decision = await controller.requestDeletionAuthorization({
      requestingAgentInstanceId: "agent-devolve",
      toolCallId: "call-1",
      backupIdentifiers: ["backup-1", "backup-2"],
      warningText: "警告",
      expectedVaultRevision: vault.getManifestRevision(),
    });
    expect(decision.decision).toBe("allow-once");
    const records = await auditLog.readAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      mode: "devolve",
      outcome: "authorized",
      reviewPriority: "high",
      backupIdentifiers: ["backup-1", "backup-2"],
    });
    expect(records[0]?.recordHash).toMatch(/^[a-f0-9]{64}$/);
    expect(records[0]?.previousRecordHash).toBeNull();
  });

  it("审计记录形成哈希链", async () => {
    const modeMachine = new ModeMachine("devolve");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const controller = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: null,
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const vault = await makeVault();
    await controller.requestDeletionAuthorization({
      requestingAgentInstanceId: "a1",
      toolCallId: "c1",
      backupIdentifiers: ["b1"],
      warningText: "w",
      expectedVaultRevision: vault.getManifestRevision(),
    });
    await controller.requestDeletionAuthorization({
      requestingAgentInstanceId: "a2",
      toolCallId: "c2",
      backupIdentifiers: ["b2"],
      warningText: "w",
      expectedVaultRevision: vault.getManifestRevision(),
    });
    const records = await auditLog.readAllRecords();
    expect(records).toHaveLength(2);
    expect(records[1]?.previousRecordHash).toBe(records[0]?.recordHash);
  });

  it("协同模式：用户 allow-once 后授权，授权请求携带警告且禁止会话记忆", async () => {
    const modeMachine = new ModeMachine("assist");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const receivedRequests: BackupDeletionAuthorizationRequest[] = [];
    const controller = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: {
        requestAuthorization: async (request) => {
          receivedRequests.push(request);
          return {
            authorizationRequestId: request.authorizationRequestId,
            requestingAgentInstanceId: request.requestingAgentInstanceId,
            decision: "allow-once",
            authorizedBackupIdentifiers: request.backupIdentifiers,
            expectedVaultRevision: 1,
            expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const vault = await makeVault();
    const decision = await controller.requestDeletionAuthorization({
      requestingAgentInstanceId: "agent-assist",
      toolCallId: "call-x",
      backupIdentifiers: ["backup-1"],
      warningText: "即将永久删除 1 个备份",
      expectedVaultRevision: vault.getManifestRevision(),
    });
    expect(decision.decision).toBe("allow-once");
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]).toMatchObject({
      backupIdentifiers: ["backup-1"],
      warningText: "即将永久删除 1 个备份",
      canRememberForSession: false,
    });
    const records = await auditLog.readAllRecords();
    expect(records[0]?.outcome).toBe("authorized");
  });

  it("协同模式：用户 deny 时拒绝并写审计", async () => {
    const modeMachine = new ModeMachine("assist");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const controller = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: {
        requestAuthorization: async (request) => ({
          authorizationRequestId: request.authorizationRequestId,
          requestingAgentInstanceId: request.requestingAgentInstanceId,
          decision: "deny",
          authorizedBackupIdentifiers: [],
          expectedVaultRevision: 1,
          expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const vault = await makeVault();
    await expect(
      controller.requestDeletionAuthorization({
        requestingAgentInstanceId: "agent-assist",
        toolCallId: "call-y",
        backupIdentifiers: ["backup-1"],
        warningText: "警告",
        expectedVaultRevision: vault.getManifestRevision(),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    const records = await auditLog.readAllRecords();
    expect(records[0]?.outcome).toBe("rejected");
  });

  it("协同模式：vault revision 变化时授权作废", async () => {
    const modeMachine = new ModeMachine("assist");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const controller = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: {
        requestAuthorization: async (request) => {
          const decision: BackupDeletionAuthorizationDecision = {
            authorizationRequestId: request.authorizationRequestId,
            requestingAgentInstanceId: request.requestingAgentInstanceId,
            decision: "allow-once",
            authorizedBackupIdentifiers: request.backupIdentifiers,
            expectedVaultRevision: 999,
            expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
          };
          return decision;
        },
      },
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const vault = await makeVault();
    await expect(
      controller.requestDeletionAuthorization({
        requestingAgentInstanceId: "agent-assist",
        toolCallId: "call-z",
        backupIdentifiers: ["backup-1"],
        warningText: "警告",
        expectedVaultRevision: vault.getManifestRevision(),
      }),
    ).rejects.toMatchObject({ errorCode: "mission-locked" });
  });

  it("协同模式缺少授权通道时拒绝并写审计", async () => {
    const modeMachine = new ModeMachine("assist");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const controller = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: null,
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const vault = await makeVault();
    await expect(
      controller.requestDeletionAuthorization({
        requestingAgentInstanceId: "agent-assist",
        toolCallId: "call-w",
        backupIdentifiers: ["backup-1"],
        warningText: "警告",
        expectedVaultRevision: vault.getManifestRevision(),
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    const records = await auditLog.readAllRecords();
    expect(records[0]?.outcome).toBe("rejected");
  });

  describe("S4：授权绑定严格校验", () => {
    function makeController(
      modeMachine: ModeMachine,
      decisionFactory: (request: BackupDeletionAuthorizationRequest) => BackupDeletionAuthorizationDecision,
      revisionProvider: () => number = () => 1,
    ) {
      const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
      const controller = new BackupDeletionAuthorizationController({
        mode: () => modeMachine.getCurrentMode(),
        controlPort: {
          requestAuthorization: async (request) => decisionFactory(request),
        },
        auditLog,
        readCurrentVaultRevision: revisionProvider,
      });
      return { controller, auditLog };
    }

    function baseDecision(request: BackupDeletionAuthorizationRequest): BackupDeletionAuthorizationDecision {
      return {
        authorizationRequestId: request.authorizationRequestId,
        requestingAgentInstanceId: request.requestingAgentInstanceId,
        decision: "allow-once",
        authorizedBackupIdentifiers: request.backupIdentifiers,
        expectedVaultRevision: 1,
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
      };
    }

    it("授权请求 ID 不匹配时拒绝", async () => {
      const modeMachine = new ModeMachine("assist");
      const { controller, auditLog } = makeController(modeMachine, (request) => ({
        ...baseDecision(request),
        authorizationRequestId: "伪造-request-id",
      }));
      await expect(
        controller.requestDeletionAuthorization({
          requestingAgentInstanceId: "agent-1",
          toolCallId: "c1",
          backupIdentifiers: ["b1"],
          warningText: "w",
          expectedVaultRevision: 1,
        }),
      ).rejects.toMatchObject({ errorCode: "mission-locked" });
      expect((await auditLog.readAllRecords())[0]?.outcome).toBe("failed");
    });

    it("发起 Agent ID 不匹配时拒绝", async () => {
      const modeMachine = new ModeMachine("assist");
      const { controller } = makeController(modeMachine, (request) => ({
        ...baseDecision(request),
        requestingAgentInstanceId: "其他-agent",
      }));
      await expect(
        controller.requestDeletionAuthorization({
          requestingAgentInstanceId: "agent-1",
          toolCallId: "c1",
          backupIdentifiers: ["b1"],
          warningText: "w",
          expectedVaultRevision: 1,
        }),
      ).rejects.toMatchObject({ errorCode: "mission-locked" });
    });

    it("授权备份 ID 集合不精确一致时拒绝（多删/漏删/换 ID）", async () => {
      const modeMachine = new ModeMachine("assist");
      const tamperedDecision = (request: BackupDeletionAuthorizationRequest) => ({
        ...baseDecision(request),
        authorizedBackupIdentifiers: [...request.backupIdentifiers, "额外备份"],
      });
      const { controller } = makeController(modeMachine, tamperedDecision);
      await expect(
        controller.requestDeletionAuthorization({
          requestingAgentInstanceId: "agent-1",
          toolCallId: "c1",
          backupIdentifiers: ["b1", "b2"],
          warningText: "w",
          expectedVaultRevision: 1,
        }),
      ).rejects.toMatchObject({ errorCode: "mission-locked" });
    });

    it("授权已过期时拒绝", async () => {
      const modeMachine = new ModeMachine("assist");
      const expiredDecision = (request: BackupDeletionAuthorizationRequest) => ({
        ...baseDecision(request),
        expiresAtIso: new Date(Date.now() - 1_000).toISOString(),
      });
      const { controller } = makeController(modeMachine, expiredDecision);
      await expect(
        controller.requestDeletionAuthorization({
          requestingAgentInstanceId: "agent-1",
          toolCallId: "c1",
          backupIdentifiers: ["b1"],
          warningText: "w",
          expectedVaultRevision: 1,
        }),
      ).rejects.toMatchObject({ errorCode: "mission-locked" });
    });

    it("等待授权后备份库最新 revision 与授权绑定不一致时作废", async () => {
      const modeMachine = new ModeMachine("assist");
      // 授权返回 revision 1，但等待期间 vault 已推进到 2
      const { controller, auditLog } = makeController(
        modeMachine,
        (request) => baseDecision(request),
        () => 2,
      );
      await expect(
        controller.requestDeletionAuthorization({
          requestingAgentInstanceId: "agent-1",
          toolCallId: "c1",
          backupIdentifiers: ["b1"],
          warningText: "w",
          expectedVaultRevision: 1,
        }),
      ).rejects.toMatchObject({ errorCode: "mission-locked" });
      expect((await auditLog.readAllRecords())[0]?.outcome).toBe("failed");
    });
  });
});
