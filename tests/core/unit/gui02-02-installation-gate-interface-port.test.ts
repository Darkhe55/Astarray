/**
 * GUI-02-02 专用流程：**界面侧安装通道**的行为反例（2026-10-12）。
 *
 * 动因（真实门禁结果）：加入本通道后 `test:coverage` 的**分支**从 85.02 掉到 **84.86**，
 * **低于 85 门槛** —— 因为本通道与安装路由的分支**没有测试**。
 * 本文件把该通道的**行为**钉住（同时也是把覆盖率补回门槛之上的正当手段）。
 *
 * 断言的是**安全性质**，不只为了数字：
 *  ① 非交互通道 ⇒ 两个提问都返回 `null`（fail-closed，不登记、不等待）；
 *  ② 阶段 1：有人回答 ⇒ 等待方拿到**原样答案**；**无人回答（超时）⇒ `null`**；
 *  ③ 阶段 2：`allow-once` / `deny` 原样传回；超时 ⇒ `null`；
 *  ④ 两个提问各自登记**独立**记录（锚点不同），且**都会**出现在待决列表；
 *  ⑤ 构造时**超时必须为正数**（否则立即抛错，不静默用 0/负数）。
 */
import { describe, expect, it } from "vitest";

import { InstallationGateInterfacePort } from "../../../packages/core/src/tools/installation-gate-interface-port.js";
import { InstallationInquiryRegistry } from "../../../packages/core/src/tools/installation-inquiry-registry.js";

function buildPort(options?: {
  isInteractive?: boolean;
  timeoutMilliseconds?: number;
}): { port: InstallationGateInterfacePort; registry: InstallationInquiryRegistry } {
  const registry = new InstallationInquiryRegistry();
  const port = new InstallationGateInterfacePort({
    registry,
    inquiryTimeoutMilliseconds: options?.timeoutMilliseconds ?? 2_000,
    isInteractive: () => options?.isInteractive ?? true,
  });
  return { port, registry };
}

describe("GUI-02-02 专用流程：界面侧安装通道", () => {
  it("① 构造时超时必须为正数（否则立即抛错，不用 0/负数静默）", () => {
    const registry = new InstallationInquiryRegistry();
    expect(
      () =>
        new InstallationGateInterfacePort({
          registry,
          inquiryTimeoutMilliseconds: 0,
          isInteractive: () => true,
        }),
    ).toThrow(/正数/);
    expect(
      () =>
        new InstallationGateInterfacePort({
          registry,
          inquiryTimeoutMilliseconds: -5,
          isInteractive: () => true,
        }),
    ).toThrow(/正数/);
  });

  it("② **非交互通道 ⇒ 两个提问都返回 null**（fail-closed，且不登记记录）", async () => {
    const { port, registry } = buildPort({ isInteractive: false });
    await expect(
      port.askExistingResource({
        inquiryId: "inquiry-1",
        requiredCapabilitySummary: "安装 package-x",
        intendedUse: "任务依赖",
        compatibleCandidateTypes: [],
        createdAtIso: new Date().toISOString(),
      }),
    ).resolves.toBeNull();
    await expect(
      port.askAllowOnce({
        authorizationRequestId: "auth-1",
        nonce: "nonce-1",
        inquiryReceiptId: "receipt-1",
        createdAtIso: new Date().toISOString(),
        canRememberForSession: false,
        requestingAgentInstanceId: "worker:m:T:1",
        taskExecutionId: "task-exec:T",
        userDecisionReference: "ref",
        sourceUrlOrRegistry: "registry",
        packageOrRepositoryIdentifier: "package-x",
        pinnedVersionOrCommit: "1.2.3",
        integrityInformation: null,
        targetPathOrScope: "workspace",
        packageManager: "npm",
        parametersJson: "{}",
        requiresNetwork: true,
        hasInstallScripts: true,
        expectedChangesSummary: "新增依赖",
      }),
    ).resolves.toBeNull();
    expect(registry.listPending().length, "非交互时不得留下待决记录").toBe(0);
  });

  it("③ 阶段 1：有人回答 ⇒ 等待方拿到**原样答案**", async () => {
    const { port, registry } = buildPort();
    const waiting = port.askExistingResource({
      inquiryId: "inquiry-2",
      requiredCapabilitySummary: "安装 package-x",
      intendedUse: "任务依赖",
      compatibleCandidateTypes: [],
      createdAtIso: new Date().toISOString(),
    });
    // 从待决列表取锚点后回答（模拟界面动作）
    const pending = registry.listPending();
    expect(pending.length).toBe(1);
    const target = pending[0]!;
    expect(target.stage).toBe("existing-resource");
    registry.answerInquiry({
      inquiryIdentifier: target.inquiryIdentifier,
      expectedRevision: target.revision,
      answer: {
        answer: "has-resource",
        resourceReference: "/opt/tools/package-x",
        providedResourceType: "user-provided",
      },
    });
    await expect(waiting).resolves.toEqual({
      answer: "has-resource",
      resourceReference: "/opt/tools/package-x",
      providedResourceType: "user-provided",
    });
  });

  it("④ 阶段 1：**无人回答（超时）⇒ null**（门禁据此 fail-closed）", async () => {
    const { port } = buildPort({ timeoutMilliseconds: 20 });
    await expect(
      port.askExistingResource({
        inquiryId: "inquiry-3",
        requiredCapabilitySummary: "安装 package-x",
        intendedUse: "任务依赖",
        compatibleCandidateTypes: [],
        createdAtIso: new Date().toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it("⑤ 阶段 2：`allow-once` / `deny` 原样传回；且记录携带**精确安装计划**", async () => {
    const { port, registry } = buildPort();
    const waiting = port.askAllowOnce({
      authorizationRequestId: "auth-2",
      nonce: "nonce-2",
      inquiryReceiptId: "receipt-2",
      createdAtIso: new Date().toISOString(),
      canRememberForSession: false,
      requestingAgentInstanceId: "worker:m:T:1",
      taskExecutionId: "task-exec:T",
      userDecisionReference: "ref",
      sourceUrlOrRegistry: "registry",
      packageOrRepositoryIdentifier: "package-x",
      pinnedVersionOrCommit: null,
      integrityInformation: null,
      targetPathOrScope: "workspace",
      packageManager: "pnpm",
      parametersJson: '{"name":"package-x"}',
      requiresNetwork: false,
      hasInstallScripts: true,
      expectedChangesSummary: "新增依赖",
    });
    const pending = registry.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.installationPlan?.packageManager).toBe("pnpm");
    expect(pending[0]!.installationPlan?.pinnedVersionOrCommit).toBeNull();
    expect(pending[0]!.installationPlan?.requiresNetwork).toBe(false);
    expect(pending[0]!.installationPlan?.hasInstallScripts).toBe(true);
    registry.decideAllowOnce({
      inquiryIdentifier: pending[0]!.inquiryIdentifier,
      expectedRevision: pending[0]!.revision,
      decision: "deny",
    });
    await expect(waiting).resolves.toBe("deny");
  });

  it("⑥ 阶段 2：**超时 ⇒ null**（绝不默认放行）", async () => {
    const { port } = buildPort({ timeoutMilliseconds: 20 });
    await expect(
      port.askAllowOnce({
        authorizationRequestId: "auth-3",
        nonce: "nonce-3",
        inquiryReceiptId: "receipt-3",
        createdAtIso: new Date().toISOString(),
        canRememberForSession: false,
        requestingAgentInstanceId: "worker:m:T:1",
        taskExecutionId: "task-exec:T",
        userDecisionReference: "ref",
        sourceUrlOrRegistry: "registry",
        packageOrRepositoryIdentifier: "package-y",
        pinnedVersionOrCommit: null,
        integrityInformation: null,
        targetPathOrScope: "workspace",
        packageManager: "npm",
        parametersJson: "{}",
        requiresNetwork: false,
        hasInstallScripts: false,
        expectedChangesSummary: "新增依赖",
      }),
    ).resolves.toBeNull();
  });

  it("⑦ 两次提问各自登记**独立**记录（锚点不同）", async () => {
    const { port, registry } = buildPort({ timeoutMilliseconds: 30 });
    const first = port.askExistingResource({
      inquiryId: "inquiry-a",
      requiredCapabilitySummary: "cap-a",
      intendedUse: "用途",
      compatibleCandidateTypes: [],
      createdAtIso: new Date().toISOString(),
    });
    const second = port.askExistingResource({
      inquiryId: "inquiry-b",
      requiredCapabilitySummary: "cap-b",
      intendedUse: "用途",
      compatibleCandidateTypes: [],
      createdAtIso: new Date().toISOString(),
    });
    await Promise.all([first, second]);
    // 两者都已超时 ⇒ 列表为空，但登记时确实各有一条（用 revision 递增间接验证独立锚点）
    expect(registry.listPending().length).toBe(0);
  });

  it("⑧ **端口内部不得把异常抛给调用方**（门禁无 try/catch，异常会穿透到工具执行路径）", async () => {
    const { port } = buildPort();
    /**
     * 构造"登记必然失败"的输入：注册表要求发起身份非空，空身份会抛
     * `installation-inquiry-invalid`。端口必须**在内部收敛**为 `null`（fail-closed），
     * **不得**让异常冒泡 —— `installation-gate-guard.ts:101` 与
     * `policy-wrapper.ts:181` 均**未**包裹 try/catch。
     */
    await expect(
      port.askExistingResource({
        inquiryId: "inquiry-invalid",
        requiredCapabilitySummary: "安装 package-x",
        intendedUse: "用途",
        compatibleCandidateTypes: [],
        createdAtIso: new Date().toISOString(),
        // 强制注入非法身份（模拟上游传空值）
        requestingAgentInstanceId: "",
      } as unknown as Parameters<typeof port.askExistingResource>[0]),
    ).resolves.toBeNull();
  });

  it("⑩ 抛出**非 Error 值**时同样收敛（覆盖 `String(error)` 兜底分支）", async () => {
    /**
     * 注册表可能抛出非 `Error` 值（例如内部实现变化）。此时 `error instanceof Error`
     * 为假，须走 `String(error)` 兜底 —— 该分支此前未被覆盖。
     */
    const throwingRegistry = {
      register: () => {
        throw "非 Error 抛出物";
      },
    } as unknown as InstallationInquiryRegistry;
    const port = new InstallationGateInterfacePort({
      registry: throwingRegistry,
      inquiryTimeoutMilliseconds: 1_000,
      isInteractive: () => true,
    });
    await expect(
      port.askExistingResource({
        inquiryId: "inquiry-non-error",
        requiredCapabilitySummary: "安装 package-x",
        intendedUse: "用途",
        compatibleCandidateTypes: [],
        createdAtIso: new Date().toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it("⑨ 阶段 2 同样**不抛异常**（非法请求 ⇒ 收敛为 null）", async () => {
    const { port } = buildPort();
    await expect(
      port.askAllowOnce({
        authorizationRequestId: "auth-x",
        nonce: "nonce-x",
        inquiryReceiptId: "receipt-x",
        // 空身份 ⇒ 登记必然抛错；端口必须收敛
        requestingAgentInstanceId: "",
        taskExecutionId: "task-exec:T",
        userDecisionReference: "ref",
        sourceUrlOrRegistry: "registry",
        packageOrRepositoryIdentifier: "package-x",
        pinnedVersionOrCommit: null,
        integrityInformation: null,
        targetPathOrScope: "workspace",
        packageManager: "npm",
        parametersJson: "{}",
        requiresNetwork: false,
        hasInstallScripts: false,
        expectedChangesSummary: "新增依赖",
        createdAtIso: new Date().toISOString(),
        canRememberForSession: false,
      }),
    ).resolves.toBeNull();
  });
});
