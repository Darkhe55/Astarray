/**
 * 反例（permission-ask 的 headless CLI 裁决线）：
 * ADR-0011 规定受限工具的 `permission-ask-pending` 必须结构化送达用户，
 * 由**认证用户本人**裁决 `allow-once` 后以 instruction 下发 unblock。
 * 现状：CLI 只把升级文本写到 stderr，用户无从裁决，任务永久 blocked。
 *
 * 本文件在 `permission-ask-adjudication.ts` 实现前必须失败。
 */
import { describe, expect, it, vi } from "vitest";

import {
  InteractivePermissionAskDecisionPort,
  buildPermissionAskFromEscalation,
  hasDecisionInputChannel,
  runPermissionAskAdjudication,
} from "../../../packages/tui/src/cli/permission-ask-adjudication.js";

const ESCALATION_MESSAGE =
  '任务 T-001 需要权限调用 createProjectFile（执行任务需要调用工具 createProjectFile），参数: {"filePath":"tasks/PROBE-001.md","content":"# 探针\\n"}';

describe("permission-ask 升级文本解析", () => {
  it("解析出工具名与精确参数（参数必须逐字保留，授权按哈希绑定）", () => {
    const ask = buildPermissionAskFromEscalation(ESCALATION_MESSAGE);
    expect(ask).not.toBeNull();
    expect(ask?.taskIdentifier).toBe("T-001");
    expect(ask?.toolName).toBe("createProjectFile");
    expect(ask?.argumentsJson).toBe(
      JSON.stringify({ filePath: "tasks/PROBE-001.md", content: "# 探针\n" }),
    );
    expect(ask?.explanation).toContain("需要调用工具 createProjectFile");
  });

  it("真实升级文本（参数 JSON 键序不定 + 尾随换行 + 多行内容）仍能解析且参数逐字保留", () => {
    // 2026-10-01 真实运行捕获的形态：content 在前、带换行与尾随换行。
    const realEscalationText =
      'astarray: [需要用户] 任务 T-001 需要权限调用 createProjectFile（执行任务需要调用工具 createProjectFile），参数: {"content": "# 受控改动探针 PROBE-001\\n- 目的：验证真实 Provider 下的小型受控改动\\n", "filePath": "tasks/PROBE-001.md"}\n';
    const ask = buildPermissionAskFromEscalation(realEscalationText);
    expect(ask).not.toBeNull();
    expect(ask?.taskIdentifier).toBe("T-001");
    expect(ask?.toolName).toBe("createProjectFile");
    expect(JSON.parse(ask?.argumentsJson ?? "{}")).toMatchObject({
      filePath: "tasks/PROBE-001.md",
    });
    // 授权按参数哈希绑定：必须逐字等于原文中的 JSON 片段。
    expect(ask?.argumentsJson).toBe(
      '{"content": "# 受控改动探针 PROBE-001\\n- 目的：验证真实 Provider 下的小型受控改动\\n", "filePath": "tasks/PROBE-001.md"}',
    );
  });

  it("非权限升级文本返回 null（不得误判为权限询问）", () => {
    expect(buildPermissionAskFromEscalation("任务 T-001 失败：运行时异常终止")).toBeNull();
    expect(buildPermissionAskFromEscalation("")).toBeNull();
  });
});

describe("headless 裁决执行", () => {
  function makeApplicationSpies() {
    const grantSessionAuthorization = vi.fn(async () => {});
    const sendSchedulerInstruction = vi.fn();
    return {
      grantSessionAuthorization,
      sendSchedulerInstruction,
      application: { grantSessionAuthorization, sendSchedulerInstruction },
    };
  }

  it("非交互（无 TTY）→ 不授权、不 unblock，返回需人工重提", async () => {
    const spies = makeApplicationSpies();
    const decision = await runPermissionAskAdjudication({
      ask: buildPermissionAskFromEscalation(ESCALATION_MESSAGE),
      missionIdentifier: "mission-1",
      isInteractive: false,
      readDecision: async () => "allow-once",
      application: spies.application,
    });
    expect(decision).toBe("requires-human-resubmission");
    expect(spies.grantSessionAuthorization).not.toHaveBeenCalled();
    expect(spies.sendSchedulerInstruction).not.toHaveBeenCalled();
  });

  it("交互 + allow-once → 按精确参数授权并下发 unblock 指令", async () => {
    const spies = makeApplicationSpies();
    const decision = await runPermissionAskAdjudication({
      ask: buildPermissionAskFromEscalation(ESCALATION_MESSAGE),
      missionIdentifier: "mission-1",
      isInteractive: true,
      readDecision: async () => "allow-once",
      application: spies.application,
    });
    expect(decision).toBe("allowed-once");
    expect(spies.grantSessionAuthorization).toHaveBeenCalledTimes(1);
    const [toolName, argumentsJson, nowUnixSeconds] =
      spies.grantSessionAuthorization.mock.calls[0] as unknown as [
        string,
        string,
        number,
      ];
    expect(toolName).toBe("createProjectFile");
    expect(argumentsJson).toBe(
      JSON.stringify({ filePath: "tasks/PROBE-001.md", content: "# 探针\n" }),
    );
    expect(Number.isInteger(nowUnixSeconds)).toBe(true);
    expect(spies.sendSchedulerInstruction).toHaveBeenCalledWith(
      "mission-1",
      JSON.stringify({ action: "unblock", taskId: "T-001" }),
    );
  });

  it("交互 + deny → 不授权、不 unblock，返回已拒绝", async () => {
    const spies = makeApplicationSpies();
    const decision = await runPermissionAskAdjudication({
      ask: buildPermissionAskFromEscalation(ESCALATION_MESSAGE),
      missionIdentifier: "mission-1",
      isInteractive: true,
      readDecision: async () => "deny",
      application: spies.application,
    });
    expect(decision).toBe("denied");
    expect(spies.grantSessionAuthorization).not.toHaveBeenCalled();
    expect(spies.sendSchedulerInstruction).not.toHaveBeenCalled();
  });

  it("无升级上下文（ask=null）→ 不授权，返回需人工重提", async () => {
    const spies = makeApplicationSpies();
    const decision = await runPermissionAskAdjudication({
      ask: null,
      missionIdentifier: "mission-1",
      isInteractive: true,
      readDecision: async () => "allow-once",
      application: spies.application,
    });
    expect(decision).toBe("requires-human-resubmission");
    expect(spies.grantSessionAuthorization).not.toHaveBeenCalled();
  });
});

describe("裁决输入通道判定", () => {
  it("stdin 非 TTY（管道/重定向）视为显式用户输入通道", () => {
    // vitest 下 process.stdin 不是 TTY，等价于管道场景：
    // `echo allow-once | astarray run …` 必须能授权。
    expect(process.stdin.isTTY).not.toBe(true);
    expect(hasDecisionInputChannel()).toBe(true);
  });

  it("注入端口时：无输入通道 → isInteractive=false（fail-closed，不读取、不授权）", async () => {
    const port = new InteractivePermissionAskDecisionPort({
      isInteractive: () => false,
      hasDecisionInput: () => false,
      readLine: async () => "allow-once",
    });
    expect(port.isInteractive()).toBe(false);
    expect(await port.readDecision({
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: "{}",
      explanation: "探针",
    })).toBeNull();
  });

  it("注入端口时：管道输入 allow-once → 授权；其他输入 → 拒绝", async () => {
    const ask = {
      taskIdentifier: "T-001",
      toolName: "createProjectFile",
      argumentsJson: "{}",
      explanation: "探针",
    };
    const allowPort = new InteractivePermissionAskDecisionPort({
      isInteractive: () => false,
      hasDecisionInput: () => true,
      readLine: async () => "allow-once",
    });
    expect(allowPort.isInteractive()).toBe(true);
    expect(await allowPort.readDecision(ask)).toBe("allow-once");

    const otherPort = new InteractivePermissionAskDecisionPort({
      isInteractive: () => false,
      hasDecisionInput: () => true,
      readLine: async () => "yes",
    });
    expect(await otherPort.readDecision(ask)).toBe("deny");

    const closedPort = new InteractivePermissionAskDecisionPort({
      isInteractive: () => false,
      hasDecisionInput: () => true,
      readLine: async () => null,
    });
    expect(await closedPort.readDecision(ask)).toBeNull();
  });
});
