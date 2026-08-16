/**
 * T06E 单测：Assist 安装门禁（ADR-0019）。
 * 覆盖：安装效果分类（包管理器/系统包/git clone/插件/生命周期/lockfile/
 * 包装不可绕）、开关默认关与 revision/备份、已有资源询问（只读验证/
 * 不可自动安装）、allow-once 授权（绑定字段/复检/消费/重放/过期/参数漂移/
 * 模式切换/revision 变化全部 fail-closed）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InstallationOperationClassifier,
} from "../../../packages/core/src/tools/installation-operation-classifier.js";
import {
  AssistInstallationSettingsStore,
  ExistingResourceInquiryController,
  AssistInstallationAuthorizationController,
  assistInstallationSettingsFilePath,
} from "../../../packages/core/src/tools/assist-installation-gate.js";
import type { ExistingResourceInquiryReceipt } from "../../../packages/core/src/tools/assist-installation-gate.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06e-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeSettingsStore(): AssistInstallationSettingsStore {
  return new AssistInstallationSettingsStore({ baseDirectory: temporaryDirectory });
}

/** 生成"没有可用资源"的询问回执（B6R-01：创建授权请求的前置条件）。 */
async function makeNoResourceReceipt(
  overrides: { agent?: string; task?: string } = {},
): Promise<ExistingResourceInquiryReceipt> {
  const inquiryController = new ExistingResourceInquiryController(null);
  const agent = overrides.agent ?? "agent-a";
  const task = overrides.task ?? "task-1";
  const inquiry = inquiryController.createInquiry({
    authenticatedUserId: "user-1",
    requestingAgentInstanceId: agent,
    taskExecutionId: task,
    requiredCapabilitySummary: "需要依赖 X",
    intendedUse: "功能 Y",
    compatibleCandidateTypes: [],
  });
  const result = await inquiryController.handleAnswer({
    inquiry,
    authenticatedUserId: "user-1",
    requestingAgentInstanceId: agent,
    taskExecutionId: task,
    answer: { answer: "no-resource" },
  });
  if (result.outcome !== "proceed-to-switch-check") {
    throw new Error("回执应生成");
  }
  const receipt = inquiryController.readReceipt(inquiry.inquiryId);
  if (receipt === null) {
    throw new Error("回执缺失");
  }
  return receipt;
}

describe("InstallationOperationClassifier", () => {
  const classifier = new InstallationOperationClassifier();

  it("包管理器安装一致识别（npm/pnpm/yarn/pip/poetry/cargo）", () => {
    const cases = [
      { commandName: "npm", arguments: ["install", "lodash"] },
      { commandName: "npm", arguments: ["ci"] },
      { commandName: "pnpm", arguments: ["add", "-D", "typescript"] },
      { commandName: "yarn", arguments: ["add", "react"] },
      { commandName: "pip", arguments: ["install", "requests"] },
      { commandName: "poetry", arguments: ["add", "fastapi"] },
      { commandName: "cargo", arguments: ["install", "ripgrep"] },
    ];
    for (const input of cases) {
      expect(classifier.classifyCommand({ ...input, workingDirectoryPath: null }).isInstallationAttempt).toBe(true);
    }
    // 精确版本提取
    const withVersion = classifier.classifyCommand({
      commandName: "npm",
      arguments: ["install", "lodash@4.17.21"],
      workingDirectoryPath: null,
    });
    expect(withVersion.pinnedVersionOrCommit).toBe("4.17.21");
  });

  it("系统包管理器/运行时工具链/插件安装识别", () => {
    for (const input of [
      { commandName: "apt-get", arguments: ["install", "nginx"] },
      { commandName: "brew", arguments: ["install", "jq"] },
      { commandName: "rustup", arguments: ["install", "stable"] },
      { commandName: "nvm", arguments: ["install", "20"] },
      { commandName: "code", arguments: ["--install-extension", "esbenp.prettier"] },
      { commandName: "gh", arguments: ["extension", "install", "x/y"] },
    ]) {
      expect(classifier.classifyCommand({ ...input, workingDirectoryPath: null }).isInstallationAttempt).toBe(true);
    }
  });

  it("git clone / 归档下载识别为安装", () => {
    expect(
      classifier.classifyCommand({
        commandName: "git",
        arguments: ["clone", "-b", "v1.2.3", "https://github.com/x/y.git"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({
      isInstallationAttempt: true,
      effectKind: "repository-clone",
      pinnedVersionOrCommit: "v1.2.3",
    });
    // 无 -b 的 clone：pinnedVersionOrCommit 为 null（默认分支）
    expect(
      classifier.classifyCommand({
        commandName: "git",
        arguments: ["clone", "https://github.com/x/y.git"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({
      isInstallationAttempt: true,
      effectKind: "repository-clone",
      pinnedVersionOrCommit: null,
    });
    expect(
      classifier.classifyCommand({
        commandName: "curl",
        arguments: ["-L", "https://github.com/x/y/archive/refs/tags/v1.tar.gz"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({ isInstallationAttempt: true, effectKind: "repository-clone" });
  });

  it("生命周期脚本与 lockfile 改写识别", () => {
    expect(
      classifier.classifyCommand({
        commandName: "postinstall",
        arguments: ["node scripts/postinstall.js"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    expect(
      classifier.classifyCommand({
        commandName: "package-lock.json",
        arguments: [],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({
      isInstallationAttempt: true,
      effectKind: "vendor-or-lockfile-mutation",
    });
  });

  it("非安装命令与普通文件操作不误报", () => {
    expect(
      classifier.classifyCommand({
        commandName: "git",
        arguments: ["status"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    expect(
      classifier.classifyCommand({
        commandName: "npm",
        arguments: ["run", "build"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    expect(
      classifier.classifyCommand({
        commandName: "ls",
        arguments: ["-la"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
  });

  it("包装/别名/自述不可绕过：子命令拼接到命令名仍被识别", () => {
    // 包装 shell：把 install 塞进命令名（分类按规范化参数效果，不信任自述）
    const wrapped = classifier.classifyCommand({
      commandName: "sh",
      arguments: ["-c", "npm install lodash"],
      workingDirectoryPath: null,
    });
    expect(wrapped.isInstallationAttempt).toBe(true);
    expect(wrapped.effectKind).toBe("dependency-resolution-change");
    // powershell -Command 与 cmd /c 包装同样识别
    const powershellWrapped = classifier.classifyCommand({
      commandName: "powershell",
      arguments: ["-Command", "pip install requests"],
      workingDirectoryPath: null,
    });
    expect(powershellWrapped.isInstallationAttempt).toBe(true);
    const cmdWrapped = classifier.classifyCommand({
      commandName: "cmd",
      arguments: ["/c", "apt-get install nginx"],
      workingDirectoryPath: null,
    });
    expect(cmdWrapped.isInstallationAttempt).toBe(true);
    // 包装脚本为非安装命令（如 dir）→ 不误报
    expect(
      classifier.classifyCommand({
        commandName: "cmd",
        arguments: ["/c", "dir"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    // powershell 无 -Command 参数：解释器副作用无法确定 → fail-closed（安装尝试）
    expect(
      classifier.classifyCommand({
        commandName: "powershell",
        arguments: ["-NoProfile"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 空命令名 fail-closed 视为安装尝试
    expect(
      classifier.classifyCommand({
        commandName: "",
        arguments: [],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 未知命令 fail-closed（B6R-01：副作用无法确定时不得放行）
    expect(
      classifier.classifyCommand({
        commandName: "totally-unknown-cmd",
        arguments: [],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
  });

  it("B6R-01 失败反例：未知命令/绝对路径可执行/大小写/多命令脚本 fail-closed", () => {
    // 未知非空命令：副作用无法确定 → fail-closed（视为安装尝试，由门禁决定）
    expect(
      classifier.classifyCommand({
        commandName: "mystery-tool-xyz",
        arguments: ["run"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 可执行文件绝对路径
    expect(
      classifier.classifyCommand({
        commandName: "C:\\tools\\installer.exe",
        arguments: ["--silent"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    expect(
      classifier.classifyCommand({
        commandName: "/usr/local/bin/setup.sh",
        arguments: [],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 大小写变体（NPM INSTALL）
    expect(
      classifier.classifyCommand({
        commandName: "NPM",
        arguments: ["INSTALL", "lodash"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 多命令脚本：任一段包含安装 → 整体安装尝试
    expect(
      classifier.classifyCommand({
        commandName: "sh",
        arguments: ["-c", "git status; npm install lodash"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 别名/间接脚本：包装后仍按效果分类
    expect(
      classifier.classifyCommand({
        commandName: "bash",
        arguments: ["-c", "alias ni='npm install'; ni react"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 空/纯分隔符脚本 → 无有效段 → fail-closed（不得误判为非安装）
    expect(
      classifier.classifyCommand({
        commandName: "sh",
        arguments: ["-c", ";;"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    expect(
      classifier.classifyCommand({
        commandName: "powershell",
        arguments: ["-Command", "  "],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // powershell 纯分隔符脚本 → 无有效段 → fail-closed
    expect(
      classifier.classifyCommand({
        commandName: "powershell",
        arguments: ["-Command", ";;"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // powershell 白名单命令脚本 → 非安装
    expect(
      classifier.classifyCommand({
        commandName: "powershell",
        arguments: ["-Command", "dir"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    // 白名单普通命令包装（cmd /c dir 已测）与直接白名单命令
    expect(
      classifier.classifyCommand({
        commandName: "ls",
        arguments: ["-la"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
  });
});

describe("AssistInstallationSettingsStore", () => {
  it("默认开关关闭（false）且 revision 0", async () => {
    const store = makeSettingsStore();
    const settings = await store.readSettings();
    expect(settings.isAssistInstallationEnabled).toBe(false);
    expect(settings.revision).toBe(0);
  });

  it("认证用户更新开关：revision 单调、写入自动备份、损坏可恢复", async () => {
    const store = makeSettingsStore();
    await store.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    expect((await store.readSettings()).isAssistInstallationEnabled).toBe(true);
    expect((await store.readSettings()).revision).toBe(1);
    // 自动备份存在
    const settingsPath = assistInstallationSettingsFilePath(temporaryDirectory);
    await expect(fs.access(`${settingsPath}.bak`)).resolves.toBeUndefined();
    // revision 不匹配拒绝
    await expect(
      store.updateInstallationEnabled({
        expectedRevision: 0,
        isAssistInstallationEnabled: false,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    // 损坏主文件从备份恢复
    await fs.writeFile(settingsPath, "{ 损坏", "utf8");
    expect((await store.readSettings()).isAssistInstallationEnabled).toBe(true);
    // 合法 JSON 但缺字段（schema 校验失败）→ journal-corrupted
    await fs.writeFile(settingsPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    await fs.writeFile(`${settingsPath}.bak`, JSON.stringify({ schemaVersion: 1 }), "utf8");
    await expect(store.readSettings()).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });
});

describe("ExistingResourceInquiryController", () => {
  it("安装前发起询问；用户答已有且验证通过 → 复用（不安装）", async () => {
    const controller = new ExistingResourceInquiryController({
      verifyResource: async () => ({
        isValid: true,
        differences: [],
        verifiedAtIso: "2026-08-13T00:00:00.000Z",
      }),
    });
    const inquiry = controller.createInquiry({
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      requiredCapabilitySummary: "需要 Node.js 20 运行时",
      intendedUse: "运行测试",
      compatibleCandidateTypes: ["node-runtime"],
    });
    expect(inquiry.inquiryId).toMatch(/^inquiry-/);
    const result = await controller.handleAnswer({
      inquiry,
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      answer: {
        answer: "has-resource",
        resourceReference: "C:/apps/node20",
        providedResourceType: "node-runtime",
      },
    });
    expect(result.outcome).toBe("resource-accepted");
  });

  it("用户提供资源但验证失败 → 返回差异继续等待，不自动安装", async () => {
    const controller = new ExistingResourceInquiryController({
      verifyResource: async () => ({
        isValid: false,
        differences: ["版本 18 不满足 ≥20", "缺少 npm 10"],
        verifiedAtIso: "2026-08-13T00:00:00.000Z",
      }),
    });
    const inquiry = controller.createInquiry({
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      requiredCapabilitySummary: "需要 Node.js 20",
      intendedUse: "构建",
      compatibleCandidateTypes: ["node-runtime"],
    });
    const result = await controller.handleAnswer({
      inquiry,
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      answer: {
        answer: "has-resource",
        resourceReference: "C:/apps/node18",
        providedResourceType: "node-runtime",
      },
    });
    expect(result.outcome).toBe("resource-rejected-with-differences");
    if (result.outcome === "resource-rejected-with-differences") {
      expect(result.verification.differences.length).toBeGreaterThan(0);
    }
  });

  it("用户明确回答没有资源 → 进入开关检查；验证端口未装配时不可确认", async () => {
    const controller = new ExistingResourceInquiryController(null);
    const inquiry = controller.createInquiry({
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      requiredCapabilitySummary: "需要依赖 X",
      intendedUse: "功能 Y",
      compatibleCandidateTypes: [],
    });
    const noResource = await controller.handleAnswer({
      inquiry,
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      answer: { answer: "no-resource" },
    });
    expect(noResource.outcome).toBe("proceed-to-switch-check");
    expect(controller.readReceipt(inquiry.inquiryId)?.answer).toEqual({ answer: "no-resource" });
    const unverifiable = await controller.handleAnswer({
      inquiry,
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      answer: {
        answer: "has-resource",
        resourceReference: "x",
        providedResourceType: "y",
      },
    });
    expect(unverifiable.outcome).toBe("resource-rejected-with-differences");
  });
});

describe("AssistInstallationAuthorizationController", () => {
  let clockMilliseconds: number;

  beforeEach(() => {
    clockMilliseconds = 1_000_000;
  });

  function makeController() {
    return new AssistInstallationAuthorizationController({
      settingsStore: makeSettingsStore(),
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
  }

  it("开关默认关闭：开启开关前创建请求被拒绝（denied-settings-disabled）", async () => {
    const controller = makeController();
    const result = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    expect(result.outcome).toBe("denied-settings-disabled");
  });

  it("开启开关后：请求绑定精确计划，allow-once 授权复检通过并消费", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
    const requestResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    expect(requestResult.outcome).toBe("request-created");
    if (requestResult.outcome !== "request-created") {
      return;
    }
    const request = requestResult.request;
    expect(request.nonce).toMatch(/^nonce-/);
    const decision = await controller.authorizeAllowOnce({
      request,
      decision: "allow-once",
    });
    expect(decision).not.toBeNull();
    // 复检通过 → 消费授权
    const verification = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
    });
    expect(verification).toEqual({ allowed: true, reason: null });
    // 重放：同 nonce 再复检 → 拒绝
    const replay = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
    });
    expect(replay.allowed).toBe(false);
  });

  it("绑定字段漂移/设置 revision 变化/模式切换/过期 → 全部 fail-closed", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
    const requestResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    if (requestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const request = requestResult.request;
    await controller.authorizeAllowOnce({ request, decision: "allow-once" });
    // 参数漂移（版本变化）
    const drifted = await controller.verifyAndConsumeAuthorization({
      request: { ...request, pinnedVersionOrCommit: "5.0.0" },
      currentMode: "assist",
    });
    expect(drifted).toEqual({ allowed: false, reason: expect.stringContaining("参数已变化") });
    // 模式切换
    const wrongMode = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "devolve",
    });
    expect(wrongMode.allowed).toBe(false);
    // 设置 revision 变化
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 1,
      isAssistInstallationEnabled: false,
    });
    const revisionChanged = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
    });
    expect(revisionChanged.allowed).toBe(false);
    // 过期（需要重新授权）
    const secondRequestResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: false,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    if (secondRequestResult.outcome === "denied-settings-disabled") {
      return; // 开关被关闭后拒绝属预期
    }
    if (secondRequestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const secondRequest = secondRequestResult.request;
    await controller.authorizeAllowOnce({
      request: secondRequest,
      decision: "allow-once",
    });
    clockMilliseconds += 400_000;
    const expired = await controller.verifyAndConsumeAuthorization({
      request: secondRequest,
      currentMode: "assist",
    });
    expect(expired.allowed).toBe(false);
  });

  it("deny 决定不产生授权", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
    });
    const requestResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    if (requestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const denied = await controller.authorizeAllowOnce({
      request: requestResult.request,
      decision: "deny",
    });
    expect(denied).toBeNull();
    const verification = await controller.verifyAndConsumeAuthorization({
      request: requestResult.request,
      currentMode: "assist",
    });
    expect(verification).toEqual({ allowed: false, reason: expect.stringContaining("无对应授权") });
  });

  it("B6R-01：回执无效（未回答/非 no-resource/Agent 不匹配）→ 不能创建授权请求", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
    });
    // 已有资源回答的回执 → 拒绝
    const inquiryController = new ExistingResourceInquiryController(null);
    const inquiry = inquiryController.createInquiry({
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      requiredCapabilitySummary: "需要依赖",
      intendedUse: "功能",
      compatibleCandidateTypes: [],
    });
    await inquiryController.handleAnswer({
      inquiry,
      authenticatedUserId: "user-1",
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      answer: {
        answer: "has-resource",
        resourceReference: "C:/apps/node",
        providedResourceType: "node",
      },
    });
    const hasResourceReceipt = inquiryController.readReceipt(inquiry.inquiryId)!;
    const invalidResult = await controller.createAuthorizationRequest({
      inquiryReceipt: hasResourceReceipt,
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "u1",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    expect(invalidResult.outcome).toBe("denied-invalid-inquiry-receipt");
    // 回执 Agent 与请求 Agent 不匹配 → 拒绝
    const otherAgentReceipt = await makeNoResourceReceipt({ agent: "agent-b" });
    const agentMismatch = await controller.createAuthorizationRequest({
      inquiryReceipt: otherAgentReceipt,
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "u1",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    expect(agentMismatch.outcome).toBe("denied-invalid-inquiry-receipt");
  });

  it("B6R-01：同一 nonce 只被原 Agent/任务的原计划消费；双 Agent/双任务隔离", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
    });
    const requestAgentA = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt({ agent: "agent-a", task: "task-1" }),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    if (requestAgentA.outcome !== "request-created") {
      throw new Error("请求 A 应创建成功");
    }
    const requestA = requestAgentA.request;
    await controller.authorizeAllowOnce({ request: requestA, decision: "allow-once" });
    // Agent B 修改字段借用 nonce → 参数哈希不匹配 → 拒绝
    const hijacked = await controller.verifyAndConsumeAuthorization({
      request: { ...requestA, requestingAgentInstanceId: "agent-b" },
      currentMode: "assist",
    });
    expect(hijacked.allowed).toBe(false);
    // 任务字段修改 → 拒绝
    const taskDrifted = await controller.verifyAndConsumeAuthorization({
      request: { ...requestA, taskExecutionId: "task-other" },
      currentMode: "assist",
    });
    expect(taskDrifted.allowed).toBe(false);
    // 用户裁决引用修改 → 拒绝
    const decisionDrifted = await controller.verifyAndConsumeAuthorization({
      request: { ...requestA, userDecisionReference: "user-decision-evil" },
      currentMode: "assist",
    });
    expect(decisionDrifted.allowed).toBe(false);
    // 原 Agent/任务/计划 → 允许一次
    const consumed = await controller.verifyAndConsumeAuthorization({
      request: requestA,
      currentMode: "assist",
    });
    expect(consumed.allowed).toBe(true);
    // 重放 → 拒绝
    const replay = await controller.verifyAndConsumeAuthorization({
      request: requestA,
      currentMode: "assist",
    });
    expect(replay.allowed).toBe(false);
    // 并发消费：两个同时复检同一 nonce → 只有一个成功
    const concurrentRequest = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt({ agent: "agent-a", task: "task-1" }),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-2",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    if (concurrentRequest.outcome !== "request-created") {
      throw new Error("并发请求应创建成功");
    }
    const concurrent = concurrentRequest.request;
    await controller.authorizeAllowOnce({ request: concurrent, decision: "allow-once" });
    const results = await Promise.all([
      controller.verifyAndConsumeAuthorization({
        request: concurrent,
        currentMode: "assist",
      }),
      controller.verifyAndConsumeAuthorization({
        request: concurrent,
        currentMode: "assist",
      }),
    ]);
    expect(results.filter((result) => result.allowed).length).toBe(1);
  });

  it("B6R-01：开关关闭后已授权请求立即失效（复检读取可信设置存储）", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
    });
    const requestResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    if (requestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const request = requestResult.request;
    await controller.authorizeAllowOnce({ request, decision: "allow-once" });
    // 开关关闭（revision 变化）→ 复检拒绝（即使 nonce 未过期）
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 1,
      isAssistInstallationEnabled: false,
    });
    const disabled = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
    });
    expect(disabled).toEqual({ allowed: false, reason: expect.stringContaining("开关已关闭") });
  });

  it("B6R-01：开关仍开启但 revision 变化/过期/已消费授权全部 fail-closed", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
    const requestResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-1",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    if (requestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const request = requestResult.request;
    await controller.authorizeAllowOnce({ request, decision: "allow-once" });
    // 开关仍开启但 revision 变化（重新保存）→ 拒绝
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 1,
      isAssistInstallationEnabled: true,
    });
    const revisionChanged = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
    });
    expect(revisionChanged).toEqual({
      allowed: false,
      reason: expect.stringContaining("revision 已变化"),
    });
    // 新请求：授权后消费 → 已消费 nonce 再次授权返回 null；过期 → 拒绝
    const secondResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-2",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: false,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    if (secondResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const secondRequest = secondResult.request;
    await controller.authorizeAllowOnce({
      request: secondRequest,
      decision: "allow-once",
    });
    await controller.verifyAndConsumeAuthorization({
      request: secondRequest,
      currentMode: "assist",
    });
    // 已消费 nonce 再次 authorize → null
    const reAuthorize = await controller.authorizeAllowOnce({
      request: secondRequest,
      decision: "allow-once",
    });
    expect(reAuthorize).toBeNull();
    // 过期
    const thirdResult = await controller.createAuthorizationRequest({
      inquiryReceipt: await makeNoResourceReceipt(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      userDecisionReference: "user-decision-3",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: false,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    if (thirdResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const thirdRequest = thirdResult.request;
    await controller.authorizeAllowOnce({
      request: thirdRequest,
      decision: "allow-once",
    });
    clockMilliseconds += 400_000;
    const expired = await controller.verifyAndConsumeAuthorization({
      request: thirdRequest,
      currentMode: "assist",
    });
    expect(expired).toEqual({ allowed: false, reason: expect.stringContaining("过期") });
  });
});
