/**
 * GUI-02-02 专用流程反例：**待决安装询问注册表**（先红后绿）。
 *
 * 背景（审计结论，2026-10-12）：
 * - 安装门禁（`InstallationGateGuard`）**自己**完成完整判定
 *   （询问已有资源 → 独立开关 → `askAllowOnce` → 授权 → **执行前复检**），
 *   普通权限询问的批准**不参与**该判定 ⇒ 安装**不可被普通授权卡绕过**；
 * - 但 `InstallationGateUserPort` 需要**可信交互通道**，而 GUI 此前传 `null`
 *   ⇒ GUI 中安装一律被判「无可信交互通道，安装被拒绝（fail-closed）」⇒ **走不通**。
 *
 * 本注册表为 GUI/CLI 提供该通道的**本地权威记录**，必须满足：
 *  ① 只登记**具体**发起个体（空身份即拒）；
 *  ② 只读列表**不含已回答/已失效**项（待办与历史分离）；
 *  ③ 回答必须匹配**询问自身 revision**（过期/重复回答被拒 ⇒ 不复用旧回答）；
 *  ④ **阶段必须匹配**（阶段 1 的回答不能用于阶段 2）；
 *  ⑤ **超时/取消 ⇒ 返回 null**（fail-closed，绝不默认放行）；
 *  ⑥ 两阶段可分别得到回答，且答案原样传回等待方。
 */
import { describe, expect, it } from "vitest";

import {
  InstallationInquiryRegistry,
  type InstallationInquiryAnswer,
} from "../../../packages/core/src/tools/installation-inquiry-registry.js";

function buildRegistry(nowMilliseconds = 1_700_000_000_000): InstallationInquiryRegistry {
  return new InstallationInquiryRegistry(() => nowMilliseconds);
}

describe("GUI-02-02 专用流程：待决安装询问注册表", () => {
  it("① 登记阶段 1 询问：返回锚点与 revision，且进入待决列表", () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    expect(record.inquiryIdentifier.length).toBeGreaterThan(0);
    expect(record.revision).toBe(1);
    expect(record.status).toBe("pending");
    expect(record.stage).toBe("existing-resource");
    expect(record.installationPlan).toBeNull();
    expect(registry.listPending().length).toBe(1);
  });

  it("② 空发起身份 ⇒ 拒绝登记（不得形成不可追责的询问）", () => {
    const registry = buildRegistry();
    expect(() =>
      registry.register({
        stage: "existing-resource",
        requestingAgentInstanceId: "",
        taskExecutionId: "task-exec:T-001",
        summary: "安装 package-x",
      }),
    ).toThrow();
  });

  it("③ 阶段 2 记录携带**精确安装计划**（供用户判断）", () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
      installationPlan: {
        packageOrRepositoryIdentifier: "package-x",
        pinnedVersionOrCommit: "1.2.3",
        targetPathOrScope: "workspace",
        packageManager: "npm",
        expectedChangesSummary: "新增依赖 package-x@1.2.3",
        requiresNetwork: true,
        hasInstallScripts: true,
        parametersJson: '{"name":"package-x"}',
      },
    });
    expect(record.installationPlan?.pinnedVersionOrCommit).toBe("1.2.3");
    expect(record.installationPlan?.hasInstallScripts).toBe(true);
  });

  it("④ 回答阶段 1 ⇒ 等待方拿到**原样答案**，记录转为已回答并移出待决列表", async () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    const waiting = registry.waitForAnswer(record.inquiryIdentifier, 5_000);
    const answer: InstallationInquiryAnswer = {
      answer: "has-resource",
      resourceReference: "本地已有 /opt/tools/package-x",
      providedResourceType: "user-provided",
    };
    const answered = registry.answerInquiry({
      inquiryIdentifier: record.inquiryIdentifier,
      expectedRevision: record.revision,
      answer,
    });
    expect(answered.status).toBe("answered");
    expect(answered.revision).toBe(2);
    await expect(waiting).resolves.toEqual(answer);
    expect(registry.listPending().length).toBe(0);
  });

  it("⑤ 过期/重复回答被拒（**不复用**旧回答）", () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    registry.answerInquiry({
      inquiryIdentifier: record.inquiryIdentifier,
      expectedRevision: 1,
      answer: { answer: "no-resource" },
    });
    // 用陈旧 revision 再答
    expect(() =>
      registry.answerInquiry({
        inquiryIdentifier: record.inquiryIdentifier,
        expectedRevision: 1,
        answer: { answer: "no-resource" },
      }),
    ).toThrow(/已变化|已被回答|失效/);
  });

  it("⑤b **陈旧 revision 被拒**（隔离 revision 分支：状态仍为 pending）", () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    /**
     * **2026-10-12 补**：用例 ⑤ 无法真正覆盖 revision 分支 —— 它先答一次，
     * 第二次会因 `status !== "pending"` 先抛"已被回答"，`revision` 判定**根本不执行**。
     * （已用"临时移除 revision 校验后 ⑤ 仍通过"自检证实这是**假覆盖**。）
     * 故这里构造"状态仍为 pending、仅 revision 不匹配"的隔离场景：
     * 通过 `cancel` 之外的路径无法直接改 revision，故用**登记后手工失效再登记**的方式
     * 无法达成 —— 改为断言 `requirePending` 的 revision 分支：
     * 先回答（revision→2），再以 revision=2 之外的值回答处于 pending 的新记录。
     */
    const pending = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-y",
    });
    expect(pending.revision).toBe(1);
    expect(() =>
      registry.answerInquiry({
        inquiryIdentifier: pending.inquiryIdentifier,
        expectedRevision: 99,
        answer: { answer: "no-resource" },
      }),
    ).toThrow(/已变化|失效/);
    // 且该记录仍待决（拒绝陈旧回答**不得**改变状态）
    expect(registry.read(pending.inquiryIdentifier)?.status).toBe("pending");
    expect(
      registry
        .listPending()
        .some((entry) => entry.inquiryIdentifier === pending.inquiryIdentifier),
    ).toBe(true);
    // 用**正确** revision 仍可正常回答（证明上一条失败确实来自 revision，而非其它校验）
    const answered = registry.answerInquiry({
      inquiryIdentifier: pending.inquiryIdentifier,
      expectedRevision: 1,
      answer: { answer: "no-resource" },
    });
    expect(answered.status).toBe("answered");
    void record;
  });

  it("⑥ **阶段必须匹配**：阶段 1 的回答不得用于阶段 2", () => {
    const registry = buildRegistry();
    const allowOnce = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    expect(() =>
      registry.answerInquiry({
        inquiryIdentifier: allowOnce.inquiryIdentifier,
        expectedRevision: allowOnce.revision,
        answer: { answer: "no-resource" },
      }),
    ).toThrow(/阶段/);
  });

  it("⑦ **超时 ⇒ null**（fail-closed，绝不默认放行），且记录转为 expired", async () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    // 极短超时且无人回答
    await expect(registry.waitForAnswer(record.inquiryIdentifier, 20)).resolves.toBeNull();
    expect(registry.read(record.inquiryIdentifier)?.status).toBe("expired");
    expect(registry.listPending().length).toBe(0);
  });

  it("⑧ 未知锚点 ⇒ 等待返回 null、读取返回 null、回答抛错", async () => {
    const registry = buildRegistry();
    await expect(registry.waitForAnswer("install-inquiry-unknown", 50)).resolves.toBeNull();
    expect(registry.read("install-inquiry-unknown")).toBeNull();
    expect(() =>
      registry.answerInquiry({
        inquiryIdentifier: "install-inquiry-unknown",
        expectedRevision: 1,
        answer: { answer: "no-resource" },
      }),
    ).toThrow();
  });

  it("⑨ 阶段 2 决定 `allow-once` / `deny` 原样传回等待方", async () => {
    const registry = buildRegistry();
    const first = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    const waitingFirst = registry.waitForAnswer(first.inquiryIdentifier, 5_000);
    registry.decideAllowOnce({
      inquiryIdentifier: first.inquiryIdentifier,
      expectedRevision: first.revision,
      decision: "deny",
    });
    await expect(waitingFirst).resolves.toBe("deny");

    const second = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    const waitingSecond = registry.waitForAnswer(second.inquiryIdentifier, 5_000);
    registry.decideAllowOnce({
      inquiryIdentifier: second.inquiryIdentifier,
      expectedRevision: second.revision,
      decision: "allow-once",
    });
    await expect(waitingSecond).resolves.toBe("allow-once");
  });

  it("⑩ **取消 ⇒ 等待方得到 null**（fail-closed），且记录不再待决", async () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    const waiting = registry.waitForAnswer(record.inquiryIdentifier, 5_000);
    registry.cancel(record.inquiryIdentifier);
    await expect(waiting).resolves.toBeNull();
    expect(registry.listPending().length).toBe(0);
  });

  it("⑪ **取消未知锚点 ⇒ 静默无操作**（不抛错、不影响其它记录）", () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    expect(() => registry.cancel("install-inquiry-unknown")).not.toThrow();
    // 既有记录**不受影响**（仍在待决）
    expect(registry.read(record.inquiryIdentifier)?.status).toBe("pending");
    expect(registry.listPending().length).toBe(1);
  });

  it("⑫ **等待非待决记录**（已回答）⇒ 立即 null（不挂起、不复用旧回答）", async () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    registry.decideAllowOnce({
      inquiryIdentifier: record.inquiryIdentifier,
      expectedRevision: record.revision,
      decision: "allow-once",
    });
    // 已回答之后再等待：不得再拿到那次回答（**不复用**），而是立即 null
    await expect(
      registry.waitForAnswer(record.inquiryIdentifier, 5_000),
    ).resolves.toBeNull();
  });

  it("⑬ **无等待方时回答**（界面先答、门禁尚未开始等）⇒ 不抛错且记录已落定", () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "existing-resource",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    // 没有调用 waitForAnswer（模拟无等待方的边界）
    expect(() =>
      registry.answerInquiry({
        inquiryIdentifier: record.inquiryIdentifier,
        expectedRevision: record.revision,
        answer: { answer: "no-resource" },
      }),
    ).not.toThrow();
    expect(registry.read(record.inquiryIdentifier)?.status).toBe("answered");
  });

  it("⑭ **已有等待方的记录被取消后再等待** ⇒ 等待方得 null，后续回答不复用", async () => {
    const registry = buildRegistry();
    const record = registry.register({
      stage: "allow-once",
      requestingAgentInstanceId: "worker:mission-install:T-001:1",
      taskExecutionId: "task-exec:T-001",
      summary: "安装 package-x",
    });
    const waiting = registry.waitForAnswer(record.inquiryIdentifier, 5_000);
    registry.cancel(record.inquiryIdentifier);
    // 等待方已拿到 null（fail-closed）
    await expect(waiting).resolves.toBeNull();
    // 取消后记录为 cancelled ⇒ 再等待**立即 null**（外部可观察：不挂起、不复用）
    await expect(
      registry.waitForAnswer(record.inquiryIdentifier, 5_000),
    ).resolves.toBeNull();
    // 且不得再用该记录回答（状态已非 pending）
    expect(() =>
      registry.decideAllowOnce({
        inquiryIdentifier: record.inquiryIdentifier,
        expectedRevision: record.revision,
        decision: "allow-once",
      }),
    ).toThrow();
  });
});
