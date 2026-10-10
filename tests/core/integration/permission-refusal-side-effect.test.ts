/**
 * 反例（"权限门禁拦截 = 确定无副作用"，2026-10-02 正向闭环阻断项）：
 *
 * 语义：工具调用**被权限门禁拦下**（`permission-ask-pending` / 被拒绝）时，
 * 该逻辑操作**未执行、无副作用**，因此：
 *  - 不得把预留结算为"待对账"（否则永久毒化重试）；
 *  - 用户 `allow-once` 之后的重跑必须能够真正执行（产物落盘、任务 done）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScopeAuthorizationGate } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { describeToolOperation } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { ScopeGatedToolPort } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { ToolPort } from "../../../packages/core/src/core/types.js";

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-refusal-"));
});

afterEach(async () => {
  try {
    await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function buildGate(): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      {
        projectIdentifier: "probe-project",
        rootPath: projectRootPath,
        registeredAtIso: "2026-10-02T00:00:00.000Z",
      },
    ],
    getConfiguredDecision: () => "ask",
    isInstallationEnabled: async () => false,
    getAuthorizationRevision: () => 1,
  });
}

/**
 * 真实 CLI 装配下的范围门禁形态：项目内写操作由范围裁决直接 `allow`（协同模式本地判定），
 * 随后由**内层权限引擎**决定是否 ask。③ 必须用这个形态才能复现真实时序。
 */
function buildAllowingGate(): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      {
        projectIdentifier: "probe-project",
        rootPath: projectRootPath,
        registeredAtIso: "2026-10-02T00:00:00.000Z",
      },
    ],
    getConfiguredDecision: () => "allow",
    isInstallationEnabled: async () => false,
    getAuthorizationRevision: () => 1,
  });
}

function buildWritingInnerPort(): ToolPort {
  return {
    execute: async (_toolName, argumentsJson, callId) => {
      const parsed = JSON.parse(argumentsJson) as { filePath: string; content: string };
      const absolutePath = path.isAbsolute(parsed.filePath)
        ? parsed.filePath
        : path.join(projectRootPath, parsed.filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, parsed.content, "utf8");
      return { kind: "success", callId, outputText: "已写入", isSideEffectFree: false };
    },
  } as ToolPort;
}

describe("权限门禁拦截 = 确定无副作用（不得毒化重试）", () => {
  it("① 权限询问拦截的调用，其结算不得是 requires-reconciliation", async () => {
    const gate = buildGate();
    const relativePath = "docs/REFUSAL.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# R\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();

    // 用户先授权（模拟 allow-once 之后的重跑场景）。
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    // 内层端口返回"被权限门禁拦下"的结果（未执行、无副作用）。
    const refusingInnerPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => ({
        kind: "error",
        callId,
        errorCode: "permission-ask-pending",
        errorMessage: "工具需要用户裁决",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      }),
    } as ToolPort;
    const gatedPort = new ScopeGatedToolPort(refusingInnerPort, gate);
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-refused",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");

    // 关键：拒绝不得毒化该操作——重跑必须仍能取得预留并执行。
    const rerun = await gate.reserveForExecution({
      operation: operation as NonNullable<typeof operation>,
      argumentsJson,
    });
    expect(rerun.status).toBe("reserved");
    expect(rerun.errorCode).not.toBe("operation-settlement-unknown");
  });

  it("② 拦截后重跑：工具必须真正执行并产出文件", async () => {
    const gate = buildGate();
    const relativePath = "docs/RERUN.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# RR\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    const innerPort = buildWritingInnerPort();
    let isFirstCall = true;
    const refusingThenWritingPort: ToolPort = {
      execute: async (toolName, argsJson, callId, signal) => {
        if (isFirstCall) {
          isFirstCall = false;
          return {
            kind: "error",
            callId,
            errorCode: "permission-ask-pending",
            errorMessage: "工具需要用户裁决",
            isIdempotencyConfirmed: true,
            sideEffectStatus: "none",
          };
        }
        return innerPort.execute(toolName, argsJson, callId, signal);
      },
    } as ToolPort;

    const gatedPort = new ScopeGatedToolPort(refusingThenWritingPort, gate);
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-1",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");

    // 重跑（用户已授权）：必须成功落盘。
    const rerun = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-2",
      new AbortController().signal,
    );
    expect(rerun.kind).toBe("success");
    expect(existsSync(path.join(projectRootPath, relativePath))).toBe(true);
  });

  /**
   * ③ 2026-10-10 真实 CLI 端到端定位（`cli-anthropic-protocol` ① 的根因）：
   * 装配顺序是 `ScopeGatedToolPort(PolicyWrapper(...))`，即**范围门禁在外、权限裁决在内**。
   * 于是"第一次真实尝试"的时序是：范围门禁先**授权并消费**该操作，随后内层权限引擎判 `ask`、
   * 抛 `permission-ask-pending` ⇒ 工具**从未执行**。
   *
   * 旧行为：`settleReservation(released)` 只恢复"逻辑操作授权快照"（此处本就为空），
   * **范围记录仍停在已消费**，于是用户 `allow-once` 并重新登记后，重跑依然恒得
   * `auth-scope-replay-rejected`（实测 6 连拒 + 任务 blocked；请求序列
   * permission-ask-pending → replay-rejected × N）。
   *
   * 期望语义：无副作用被拒的那次不得烧掉范围授权；用户裁决后的重跑必须真正执行；
   * 成功之后同一逻辑操作再次调用仍必须被拒（重放保护不放宽）。
   */
  it("③ 范围门禁先消费、内层权限引擎再 ask：用户裁决后重跑必须能执行（不得 replay-rejected）", async () => {
    const gate = buildAllowingGate();
    const relativePath = "docs/OUTER-SCOPE-INNER-ASK.md";
    const fileContent = "# OSIA\n";
    // 目标路径用**绝对路径**：真实 CLI 以项目根为 cwd 运行，范围解析基于进程 cwd；
    // 测试进程的 cwd 是仓库根，故须显式给出项目内绝对路径才能落在已登记项目根内。
    const absoluteTargetPath = path.join(projectRootPath, relativePath);
    const argumentsJson = JSON.stringify({ filePath: absoluteTargetPath, content: fileContent });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();

    // 内层端口 = 权限引擎：第 1 次 ask（未执行、无副作用），之后放行真正写入。
    const writingInnerPort = buildWritingInnerPort();
    let isFirstAttempt = true;
    const askThenWritePort: ToolPort = {
      execute: async (toolName, argsJson, callId, signal) => {
        if (isFirstAttempt) {
          isFirstAttempt = false;
          return {
            kind: "error",
            callId,
            errorCode: "permission-ask-pending",
            errorMessage: "工具 createProjectFile 需要用户裁决",
            isIdempotencyConfirmed: true,
            sideEffectStatus: "none",
          };
        }
        return writingInnerPort.execute(toolName, argsJson, callId, signal);
      },
    } as ToolPort;
    const gatedPort = new ScopeGatedToolPort(askThenWritePort, gate);

    // 第 1 次尝试：范围门禁授权并消费；内层 ask ⇒ 返回被拒（内层工具未执行）。
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-ask",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") {
      expect(refused.errorCode).toBe("permission-ask-pending");
    }

    // 用户 `allow-once` → 重新登记作用域授权（CLI 现有接线：grantUserAuthorization）。
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    // 重跑：必须真正执行并落盘（旧行为在此恒得 auth-scope-replay-rejected）。
    const rerun = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-rerun",
      new AbortController().signal,
    );
    expect(rerun.kind).toBe("success");
    expect(existsSync(path.join(projectRootPath, relativePath))).toBe(true);

    // 重放保护不放宽：同一逻辑操作（同参数）再次调用仍必须被拒。
    const replay = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-replay",
      new AbortController().signal,
    );
    expect(replay.kind).toBe("error");
    if (replay.kind === "error") {
      expect(replay.errorCode).toBe("auth-scope-replay-rejected");
    }
  });

  /**
   * ④ 同③但**不重新登记**：一次错误授权不得被"无副作用被拒"行为扩大为可用授权。
   * 没有用户裁决时，重跑必须仍是 fail-closed 的"等待用户授权"，绝不放行执行。
   */
  it("④ 无用户重新登记时：被拒一次后重跑仍必须 fail-closed（不得放行、不得变 replay-rejected）", async () => {    const gate = buildGate();
    const relativePath = "docs/NO-REGRANT.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# NR\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();

    const countingInnerPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => ({
        kind: "error",
        callId,
        errorCode: "permission-ask-pending",
        errorMessage: "需要用户裁决",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      }),
    } as ToolPort;
    const gatedPort = new ScopeGatedToolPort(countingInnerPort, gate);

    const first = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-1",
      new AbortController().signal,
    );
    expect(first.kind).toBe("error");
    if (first.kind === "error") {
      expect(first.errorCode).toBe("auth-scope-awaiting-user-authorization");
    }
    const second = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-2",
      new AbortController().signal,
    );
    expect(second.kind).toBe("error");
    if (second.kind === "error") {
      // 未获用户裁决 → 仍须等待用户授权（既不执行，也不得退化成"已消费的重放"误导文案）。
      expect(second.errorCode).toBe("auth-scope-awaiting-user-authorization");
    }
  });

  /**
   * ⑤ 2026-10-10 返修（RELIABILITY-01-02「提前拒绝结算」）：
   *
   * "**提前拒绝**"指工具在**执行之前**就被拒绝（未注册/不在 Worker 子集/安装门禁拒绝等）。
   * 这类拒绝**确定没有副作用**，因此门禁必须**释放**预留并恢复授权，使用户修正后重跑可行。
   *
   * 缺陷：`isExecutionRefusalErrorCode` 只列了
   * `permission-ask-pending` / `tool-permission-denied` / `auth-scope-awaiting-user-authorization`
   * / `auth-scope-denied`，**漏掉了同样"从未执行"的 `tool-not-found`**。
   * 于是未注册工具的调用被当作 `sideEffectStatus: "unknown"` 结算 ⇒ 预留进入
   * `requires-reconciliation` ⇒ 该逻辑操作**永久**无法重试（"需人工对账"），
   * 而实际从未发生过任何副作用。
   *
   * 期望：提前拒绝（从未执行）一律按"确定无副作用"结算 ⇒ 预留释放并可重试；
   * 成功的重放保护仍然不得放宽（见 ③）。
   */
  it("⑤ 提前拒绝（tool-not-found，从未执行）必须按无副作用结算 ⇒ 预约释放、重跑可行", async () => {
    const gate = buildAllowingGate();
    const relativePath = "docs/EARLY-REFUSAL.md";
    const argumentsJson = JSON.stringify({
      filePath: path.join(projectRootPath, relativePath),
      content: "# EARLY\n",
    });

    // 内层端口模拟"执行前就被拒"（未注册工具）：从未进入副作用通道。
    const earlyRefusingPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => ({
        kind: "error",
        callId,
        errorCode: "tool-not-found",
        errorMessage: "工具未注册: createProjectFile",
        isIdempotencyConfirmed: false,
        sideEffectStatus: "none",
      }),
    } as ToolPort;

    let isFirstAttempt = true;
    const earlyRefusalThenWritingPort: ToolPort = {
      execute: async (toolName, argsJson, callId, signal) => {
        if (isFirstAttempt) {
          isFirstAttempt = false;
          return earlyRefusingPort.execute(toolName, argsJson, callId, signal);
        }
        return buildWritingInnerPort().execute(toolName, argsJson, callId, signal);
      },
    } as ToolPort;

    const gatedPort = new ScopeGatedToolPort(earlyRefusalThenWritingPort, gate);
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-early-refused",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");

    // 重跑必须能真正执行（不得因"未知副作用"被判 requires-reconciliation 永久毒化）
    const rerun = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-rerun",
      new AbortController().signal,
    );
    expect(rerun.kind).toBe("success");
    expect(existsSync(path.join(projectRootPath, relativePath))).toBe(true);
  });

  /**
   * ⑥ 2026-10-10 返修（RELIABILITY-01-02「提前拒绝结算」的**变更前中止**同族缺陷）：
   *
   * `replaceFileContent` 在写入前会做自动备份 + TOCTOU 复检；若复检发现目标在备份后
   * 被第三方修改，实现会**抛出普通 `Error`**（"目标文件在备份后被修改"）。
   * 由于普通 Error 不带"确定无副作用"语义，`PolicyWrapper` 只能按
   * `sideEffectStatus: "unknown"` 结算 ⇒ 范围门禁的预留进入 `requires-reconciliation`
   * ⇒ 该逻辑操作**永久**无法重试（须人工对账），尽管**这次写入根本没有发生**。
   *
   * 注意同文件中"排他创建遇到已存在"本来就正确使用 `SideEffectNoneError`（见 builtins），
   * 说明该语义在本仓已有先例，此处属**漏用**。
   *
   * 期望：**变更前中止**（未写入任何字节）必须按"确定无副作用"结算 ⇒ 预留释放、重试可行；
   * 目标文件必须保持第三方修改后的内容不变。
   */
  it("⑥ 备份后复检失败而中止的覆盖：不得写入，且必须按无副作用结算（重试可行）", async () => {
    const { PolicyWrapper } = await import("../../../packages/core/src/tools/policy-wrapper.js");
    const { ToolRegistry } = await import("../../../packages/core/src/tools/registry.js");
    const { WorkspaceBoundary } = await import("../../../packages/core/src/tools/workspace-boundary.js");
    const { ProtectedStoragePolicy } = await import(
      "../../../packages/core/src/tools/protected-storage-policy.js"
    );
    const { ModeMachine } = await import("../../../packages/core/src/core/mode-machine.js");
    const { PermissionDecider, SessionAuthorizationManager } = await import(
      "../../../packages/core/src/core/permission-policy.js"
    );

    const relativePath = "docs/TOCTOU.md";
    const absolutePath = path.join(projectRootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const contentBeforeMutation = "# 第三方修改后的内容\n";
    await fs.writeFile(absolutePath, contentBeforeMutation, "utf8");

    const modeMachine = new ModeMachine("devolve");
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    // 覆盖前备份由工具自动完成；此处只让 TOCTOU 复检返回"目标已变"。
    const backupServicePort = {
      createPreMutationBackup: async () => ({
        backupIdentifier: "backup-1",
        targetFingerprintBeforeMutation: "sha256:whatever",
        createdAtIso: "2026-10-10T00:00:00.000Z",
      }),
      verifyTargetUnchanged: async () => false,
    };
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
      registry,
      workspaceBoundary: new WorkspaceBoundary(projectRootPath),
      temporaryDirectoryPath: path.join(projectRootPath, ".tmp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => modeMachine.getCurrentMode(),
      requestingAgentInstanceId: "agent-test",
      taskExecutionId: "task-test",
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: path.join(projectRootPath, ".astarray-test"),
      }),
      backupServicePort,
    } as never);

    const result = await wrapper.execute(
      "replaceFileContent",
      JSON.stringify({ filePath: relativePath, content: "# 新的内容\n" }),
      "call-toctou",
      new AbortController().signal,
    );

    // 未写入：第三方内容必须原样保留
    expect(await fs.readFile(absolutePath, "utf8")).toBe(contentBeforeMutation);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      // 变更前中止 ⇒ 确定无副作用（否则门禁预留被永久毒化为 requires-reconciliation）
      expect(result.sideEffectStatus).toBe("none");
    }
  });
});
