/**
 * CLI 引导（T11）：解析界面层交互端口与反馈入口路径，委托公共应用运行时装配。
 * 装配实现见 packages/core/src/application/application-runtime.ts（T07D-R1-01 提取）。
 */
import path from "node:path";

import { resolveHostUserIdentifier } from "../../../core/src/core/host-user-context.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createApplicationRuntime,
  type ApplicationRuntime,
  type ApplicationRuntimeOptions,
} from "../../../core/src/application/application-runtime.js";
import { InteractiveBackupDeletionAuthorizationPort } from "./backup-deletion-port.js";
import { InteractiveInstallationGatePort } from "./install-decision-port.js";

export type CliBootstrap = ApplicationRuntime;
export type BootstrapOptions = ApplicationRuntimeOptions;

export async function bootstrapCli(options: BootstrapOptions): Promise<CliBootstrap> {
  return createApplicationRuntime({
    ...options,
    backupDeletionControlPort: new InteractiveBackupDeletionAuthorizationPort({
      warnOutput: process.stderr,
    }),
    installationUserPort: new InteractiveInstallationGatePort({
      isInteractive: () => process.stdin.isTTY === true,
    }),
    // 检查点 B：身份来自可信宿主用户上下文；主 Agent 实例 ID 逐运行时唯一（不再固定）
    authenticatedUserId: resolveHostUserIdentifier(),
    feedbackProcessModulePath: resolveFeedbackEntryPath(),
  });
}

function resolveFeedbackEntryPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "feedback-process-entry.js"),
    path.join(
      moduleDirectory,
      "..",
      "..",
      "..",
      "..",
      "dist",
      "feedback-process-entry.js",
    ),
    path.join(process.cwd(), "dist", "feedback-process-entry.js"),
  ];
  return (
    candidates.find((candidatePath) => existsSync(candidatePath)) ?? candidates[0]!
  );
}
