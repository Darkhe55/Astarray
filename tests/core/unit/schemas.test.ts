import { describe, expect, it } from "vitest";

import {
  agentWorkArchiveAttachmentSchema,
  agentWorkArchiveDocumentSchema,
  feedbackMessageSchema,
  runConfigSchema,
  taskChainSchema,
  toolDescriptorSchema,
} from "../../../packages/core/src/core/schemas.js";

describe("taskChainSchema", () => {
  const validTaskChain = {
    schemaVersion: 1,
    missionId: "mission-001",
    revision: 1,
    updatedAtIso: "2026-08-12T10:00:00.000Z",
    tasks: [
      {
        id: "T-001",
        description: "收集销售数据",
        dependsOn: [],
        taskType: "data",
        toolNames: ["search", "read"],
        assignedAgentId: "L3-A",
        status: "done",
        resultLocation: "data/raw.csv",
      },
      {
        id: "T-002",
        description: "清洗并统计",
        dependsOn: ["T-001"],
        taskType: "data",
        toolNames: ["read", "query"],
        assignedAgentId: "L3-B",
        status: "running",
        resultLocation: null,
      },
    ],
  };

  it("接受合法的任务链文档", () => {
    const parsed = taskChainSchema.safeParse(validTaskChain);
    expect(parsed.success).toBe(true);
  });

  it("拒绝 schemaVersion 为 0 的文档", () => {
    const invalid = { ...validTaskChain, schemaVersion: 0 };
    expect(taskChainSchema.safeParse(invalid).success).toBe(false);
  });

  it("拒绝 revision 为 0 的文档", () => {
    const invalid = { ...validTaskChain, revision: 0 };
    expect(taskChainSchema.safeParse(invalid).success).toBe(false);
  });

  it("拒绝非法任务状态", () => {
    const invalid = {
      ...validTaskChain,
      tasks: [
        { ...validTaskChain.tasks[0], status: "in-progress" },
        ...validTaskChain.tasks.slice(1),
      ],
    };
    expect(taskChainSchema.safeParse(invalid).success).toBe(false);
  });

  it("拒绝非 ISO 时间的 updatedAtIso", () => {
    const invalid = { ...validTaskChain, updatedAtIso: "2026/08/12" };
    expect(taskChainSchema.safeParse(invalid).success).toBe(false);
  });

  it("拒绝空 missionId", () => {
    const invalid = { ...validTaskChain, missionId: "" };
    expect(taskChainSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("toolDescriptorSchema", () => {
  const validToolDescriptor = {
    name: "readFile",
    summary: "读取文件内容",
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["doc", "data"],
    inputSchema: { type: "object" },
  };

  it("接受合法的工具描述", () => {
    expect(toolDescriptorSchema.safeParse(validToolDescriptor).success).toBe(
      true,
    );
  });

  it("拒绝空 supportedTaskTypes", () => {
    const invalid = { ...validToolDescriptor, supportedTaskTypes: [] };
    expect(toolDescriptorSchema.safeParse(invalid).success).toBe(false);
  });

  it("拒绝非法工具类别", () => {
    const invalid = { ...validToolDescriptor, category: "super" };
    expect(toolDescriptorSchema.safeParse(invalid).success).toBe(false);
  });

  it("拒绝未提供工具内自动备份的破坏性工具", () => {
    const invalid = {
      ...validToolDescriptor,
      name: "replaceText",
      category: "restricted",
      mutationKind: "replace",
      backupPolicy: "not-required",
    };
    expect(toolDescriptorSchema.safeParse(invalid).success).toBe(false);
  });

  it("接受声明工具内自动备份的破坏性工具", () => {
    const valid = {
      ...validToolDescriptor,
      name: "replaceText",
      category: "restricted",
      mutationKind: "replace",
      backupPolicy: "automatic-preimage",
    };
    expect(toolDescriptorSchema.safeParse(valid).success).toBe(true);
  });

  it("删除受保护备份只接受独立特权删除策略", () => {
    const baseDeleteBackupDescriptor = {
      ...validToolDescriptor,
      name: "deleteBackup",
      category: "restricted",
      mutationKind: "delete-protected-backup",
      authorizationPolicy: "backup-deletion",
    };
    expect(
      toolDescriptorSchema.safeParse({
        ...baseDeleteBackupDescriptor,
        backupPolicy: "automatic-preimage",
      }).success,
    ).toBe(false);
    expect(
      toolDescriptorSchema.safeParse({
        ...baseDeleteBackupDescriptor,
        backupPolicy: "protected-vault-deletion",
      }).success,
    ).toBe(true);
  });

  it("删除受保护备份拒绝标准授权策略", () => {
    expect(
      toolDescriptorSchema.safeParse({
        ...validToolDescriptor,
        name: "deleteBackup",
        category: "restricted",
        mutationKind: "delete-protected-backup",
        backupPolicy: "protected-vault-deletion",
        authorizationPolicy: "standard",
      }).success,
    ).toBe(false);
  });
});

describe("feedbackMessageSchema", () => {
  const baseMessage = {
    protocolVersion: 1,
    messageId: "a3f7e2c1-9f0b-4a1c-8d2e-6b5a4c3d2e1f",
    source: {
      sourceType: "agent",
      agentInstanceId: "worker-a-019ff3fa",
      agentRole: "tertiary",
    },
    recipientId: "scheduler-1",
    createdAtIso: "2026-08-12T10:05:00.000Z",
    idempotencyKey: "mission-001/worker-a/tool-read-3",
  };

  it("接受合法的 success 消息且优先级一致", () => {
    const message = {
      ...baseMessage,
      priority: "success",
      payload: { kind: "success", summary: "任务完成，产出在 data/raw.csv" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(true);
  });

  it("接受合法的 failure 消息", () => {
    const message = {
      ...baseMessage,
      priority: "failure",
      payload: {
        kind: "failure",
        failureReason: "read 工具连续失败 3 次",
        currentStateSummary: "已完成数据收集，未开始统计",
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(true);
  });

  it("接受合法的 ambiguous 消息", () => {
    const message = {
      ...baseMessage,
      priority: "ambiguous",
      payload: {
        kind: "ambiguous",
        unclearPoints: ["统计口径未指定"],
        requestedInformation: "请说明按季度还是按年度统计",
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(true);
  });

  it("接受合法的 instruction 消息", () => {
    const message = {
      ...baseMessage,
      source: {
        sourceType: "user",
        sourceIdentifier: "session-user",
      },
      priority: "instruction",
      payload: {
        kind: "instruction",
        instructionText: "用户已裁决：按年度统计继续执行",
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(true);
  });

  it("接受禁止会话记忆的备份删除警告", () => {
    const message = {
      ...baseMessage,
      priority: "backup-deletion-warning",
      payload: {
        kind: "backup-deletion-warning",
        authorizationRequestId: "b3f7e2c1-9f0b-4a1c-8d2e-6b5a4c3d2e1f",
        requestingAgentInstanceId: "worker-a-019ff3fa",
        backupIdentifiers: ["backup-001"],
        warningText: "删除备份会永久降低恢复能力，是否允许本次删除？",
        canRememberForSession: false,
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(true);
  });

  it("拒绝允许会话记忆的备份删除警告", () => {
    const message = {
      ...baseMessage,
      priority: "backup-deletion-warning",
      payload: {
        kind: "backup-deletion-warning",
        authorizationRequestId: "b3f7e2c1-9f0b-4a1c-8d2e-6b5a4c3d2e1f",
        requestingAgentInstanceId: "worker-a-019ff3fa",
        backupIdentifiers: ["backup-001"],
        warningText: "确认删除",
        canRememberForSession: true,
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝缺少信息来源的消息", () => {
    const message = {
      protocolVersion: baseMessage.protocolVersion,
      messageId: baseMessage.messageId,
      recipientId: baseMessage.recipientId,
      createdAtIso: baseMessage.createdAtIso,
      idempotencyKey: baseMessage.idempotencyKey,
      priority: "success",
      payload: { kind: "success", summary: "完成" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝缺少 Agent 层级的信息来源", () => {
    const message = {
      ...baseMessage,
      source: {
        sourceType: "agent",
        agentInstanceId: "worker-a-019ff3fa",
      },
      priority: "success",
      payload: { kind: "success", summary: "完成" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝只有 Agent 层级而没有具体个体标识的来源", () => {
    const message = {
      ...baseMessage,
      source: {
        sourceType: "agent",
        agentRole: "tertiary",
      },
      priority: "failure",
      payload: {
        kind: "failure",
        failureReason: "工具失败",
        currentStateSummary: "等待调度",
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝空的信息来源标识", () => {
    const message = {
      ...baseMessage,
      source: {
        sourceType: "user",
        sourceIdentifier: "",
      },
      priority: "instruction",
      payload: { kind: "instruction", instructionText: "继续执行" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝优先级与载荷类型不一致的消息", () => {
    const message = {
      ...baseMessage,
      priority: "success",
      payload: {
        kind: "failure",
        failureReason: "read 工具连续失败 3 次",
        currentStateSummary: "已完成数据收集",
      },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝非法 messageId", () => {
    const message = {
      ...baseMessage,
      messageId: "not-a-uuid",
      priority: "success",
      payload: { kind: "success", summary: "完成" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝空 recipientId", () => {
    const message = {
      ...baseMessage,
      recipientId: "",
      priority: "success",
      payload: { kind: "success", summary: "完成" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });

  it("拒绝空 idempotencyKey", () => {
    const message = {
      ...baseMessage,
      idempotencyKey: "",
      priority: "success",
      payload: { kind: "success", summary: "完成" },
    };
    expect(feedbackMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe("agentWorkArchiveDocumentSchema", () => {
  const validAgentWorkArchive = {
    schemaVersion: 1,
    missionId: "mission-001",
    agentInstanceId: "worker-a-019ff3fa",
    agentRole: "tertiary",
    revision: 2,
    updatedAtIso: "2026-08-12T10:06:00.000Z",
    entries: [
      {
        archiveEntryId: "archive-entry-001",
        recordedAtIso: "2026-08-12T10:05:00.000Z",
        taskId: "T-001",
        entryType: "result",
        summary: "完成数据收集并生成原始数据文件",
        artifactReferences: ["data/raw.csv"],
      },
    ],
  };

  it("接受具体次级或三级 Agent 的合法工作存档", () => {
    expect(
      agentWorkArchiveDocumentSchema.safeParse(validAgentWorkArchive).success,
    ).toBe(true);
  });

  it("拒绝主 Agent 工作存档", () => {
    expect(
      agentWorkArchiveDocumentSchema.safeParse({
        ...validAgentWorkArchive,
        agentRole: "main",
      }).success,
    ).toBe(false);
  });

  it("拒绝没有具体 Agent 个体标识的工作存档", () => {
    expect(
      agentWorkArchiveDocumentSchema.safeParse({
        ...validAgentWorkArchive,
        agentInstanceId: "",
      }).success,
    ).toBe(false);
  });

  it("接受上级选择性附加的存档快照引用", () => {
    expect(
      agentWorkArchiveAttachmentSchema.safeParse({
        archiveOwnerAgentInstanceId: "worker-a-019ff3fa",
        archiveRevision: 2,
        selectedArchiveEntries: validAgentWorkArchive.entries,
        selectionReason: "继续处理上次生成的数据文件",
        contentHash:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }).success,
    ).toBe(true);
  });

  it("拒绝没有选中条目的存档附加请求", () => {
    expect(
      agentWorkArchiveAttachmentSchema.safeParse({
        archiveOwnerAgentInstanceId: "worker-a-019ff3fa",
        archiveRevision: 2,
        selectedArchiveEntries: [],
        selectionReason: "继续任务",
        contentHash:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }).success,
    ).toBe(false);
  });
});

describe("runConfigSchema", () => {
  it("空输入使用默认值：assist、并发 4、阈值 3、mock", () => {
    const config = runConfigSchema.parse({});
    expect(config.mode).toBe("assist");
    expect(config.concurrency).toBe(4);
    expect(config.toolFailureThreshold).toBe(3);
    expect(config.runtime).toBe("mock");
    expect(config.missionId).toBeNull();
  });

  it("接受边界并发 1 与 32", () => {
    expect(runConfigSchema.safeParse({ concurrency: 1 }).success).toBe(true);
    expect(runConfigSchema.safeParse({ concurrency: 32 }).success).toBe(true);
  });

  it("拒绝并发 0 与 33", () => {
    expect(runConfigSchema.safeParse({ concurrency: 0 }).success).toBe(false);
    expect(runConfigSchema.safeParse({ concurrency: 33 }).success).toBe(false);
  });

  it("拒绝非法模式", () => {
    expect(runConfigSchema.safeParse({ mode: "explore" }).success).toBe(false);
  });

  it("拒绝阈值 0", () => {
    expect(
      runConfigSchema.safeParse({ toolFailureThreshold: 0 }).success,
    ).toBe(false);
  });
});
