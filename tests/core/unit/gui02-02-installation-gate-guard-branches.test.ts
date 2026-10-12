/**
 * GUI-02-02 专用流程：**安装门禁的通道缺失路径**（2026-10-12）。
 *
 * 背景：GUI 侧此前 `installationUserPort` 为 `null` ⇒ 安装一律被拒
 * （「无可信交互通道，安装被拒绝（fail-closed）」）。本文件把这条**安全性质**钉住：
 * **没有可信用户通道时，安装尝试一律拒绝**，且拒绝发生在**任何授权动作之前**。
 *
 * 同时这也补上门禁中该分支的覆盖（此前只有真实用户通道路径被测）。
 */
import { describe, expect, it } from "vitest";

import {
  AssistInstallationAuthorizationController,
  ExistingResourceInquiryController,
} from "../../../packages/core/src/tools/assist-installation-gate.js";
import { InstallationGateGuard } from "../../../packages/core/src/tools/installation-gate-guard.js";
import { InstallationOperationClassifier } from "../../../packages/core/src/tools/installation-operation-classifier.js";

function buildGuard(options: {
  userPort: ConstructorParameters<typeof InstallationGateGuard>[0]["userPort"];
  authenticatedUserId?: string | null;
  mode?: "ponder" | "assist" | "devolve";
}): InstallationGateGuard {
  const inquiryController = new ExistingResourceInquiryController(null);
  const authorizationController = new AssistInstallationAuthorizationController({
    settingsStore: {
      readSettings: async () => ({
        schemaVersion: 1,
        isAssistInstallationEnabled: true,
        revision: 1,
        updatedAtIso: new Date().toISOString(),
      }),
      updateInstallationEnabled: async () => {},
    } as unknown as ConstructorParameters<
      typeof AssistInstallationAuthorizationController
    >[0]["settingsStore"],
  });
  return new InstallationGateGuard({
    classifier: new InstallationOperationClassifier(),
    inquiryController,
    authorizationController,
    userPort: options.userPort,
    /**
     * **不能用 `??`**：`null ?? "user-1"` 会把"显式传入 null（未认证）"替换成默认值，
     * 让用例② 实际测到的是**已认证**路径（我因此一度误判为产品缺陷）。
     * 用 `undefined` 判断才能保留显式 `null`。
     */
    authenticatedUserId:
      options.authenticatedUserId === undefined
        ? "user-1"
        : options.authenticatedUserId,
    getCurrentMode: () => options.mode ?? "assist",
  });
}

describe("GUI-02-02 专用流程：安装门禁的通道缺失与模式约束", () => {
  it("① **无用户通道 ⇒ 安装被拒**（fail-closed，且理由指明通道缺失）", async () => {
    const guard = buildGuard({ userPort: null });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "package-x"],
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) { return; }
    expect(decision.reason).toContain("无可信交互通道");
  });

  it("② **缺少认证身份 ⇒ 安装被拒**（无法形成可追责授权）", async () => {
    const guard = buildGuard({
      userPort: {
        askExistingResource: async () => ({ answer: "no-resource" }),
        askAllowOnce: async () => "allow-once",
      },
      authenticatedUserId: null,
    });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "package-x"],
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) { return; }
    expect(decision.reason).toContain("可信认证身份");
  });

  it("③ **非 assist 模式 ⇒ 安装被拒**（门禁只约束 Assist）", async () => {
    const guard = buildGuard({
      userPort: {
        askExistingResource: async () => ({ answer: "no-resource" }),
        askAllowOnce: async () => "allow-once",
      },
      mode: "devolve",
    });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "package-x"],
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
    });
    expect(decision.allowed).toBe(false);
  });

  it("④ **非安装命令 ⇒ 直接放行**（门禁不误伤普通命令）", async () => {
    const guard = buildGuard({ userPort: null });
    const decision = await guard.assertInstallationAllowed({
      commandName: "node",
      arguments: ["--version"],
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
    });
    expect(decision.allowed).toBe(true);
  });
});
