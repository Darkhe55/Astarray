/**
 * TOOLKIT-01-05 反例（2026-10-10）：受控**确定性程序工具**与隔离边界门禁。
 *
 * 卡内检查点 05："受控确定性程序工具与通用包验证；先实现一个无外部副作用转换器，
 * 验证**沙箱/broker 边界**；未支持环境**明确拒绝**，不自动扩大到任意程序执行。"
 * 卡内 §7 另明确：
 *  - "程序工具**不能凭 `readOnly` 自声明成为安全工具**"；
 *  - "纯转换优先通过**显式输入数据和隔离输出**运行"；
 *  - "涉及**文件/进程/网络**必须经过**可强制执行的沙箱与受控 broker**，不能仅靠提示词或静态扫描"；
 *  - "若目标平台**无法兑现所需隔离**，**拒绝启用**程序工具并报告不支持，保留已有工具配方路径；
 *    首版**不增加任意脚本后备入口**"；
 *  - 运行时"有界依赖深度/执行预算"。
 *
 * 现状缺口：本仓此前的三类产物里，`recipe`（工作流配方）已实现，
 * 但**确定性程序工具这一层的启用门禁完全不存在** —— "未支持环境明确拒绝"无判定点，
 * 于是只要有人声明 `readOnly: true` 就会被当成安全工具。
 *
 * 本片钉住的语义：
 *  - **纯转换**（无文件/进程/网络副作用）在具备隔离沙箱时**可启用**；
 *  - **`readOnly` 自声明不构成信任**：声明的副作用与实际声明不一致、或声明与实际冲突时拒绝；
 *  - 涉及文件/进程/网络：**必须**同时具备可强制执行的沙箱与受控 broker，缺一即**拒绝**；
 *  - 平台无法兑现所需隔离 ⇒ **拒绝并报告不支持**（且提示保留配方路径）；
 *  - **绝不**回退到"任意脚本后备入口"；
 *  - 依赖深度与执行预算必须有界（越界即拒绝）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateProgramToolEnablement,
  type ProgramToolDeclaration,
  type SandboxCapabilityProfile,
} from "../../../packages/core/src/toolkit/program-tool-isolation-gate.js";

function buildDeclaration(
  overrides: Partial<ProgramToolDeclaration> = {},
): ProgramToolDeclaration {
  return {
    toolPackageId: "csv-to-json",
    version: 1,
    contentHash: "sha256:" + "a".repeat(64),
    /** 作者自声明（**不构成信任**）。 */
    readOnlySelfDeclaration: true,
    requiredCapabilities: [],
    declaredSideEffects: ["none"],
    dependencyDepth: 1,
    executionBudgetMilliseconds: 5_000,
    ...overrides,
  };
}

function buildPlatform(
  overrides: Partial<SandboxCapabilityProfile> = {},
): SandboxCapabilityProfile {
  return {
    platformIdentifier: "win32-x64",
    hasEnforceableSandbox: true,
    hasControlledBroker: true,
    supportedCapabilities: [],
    maximumDependencyDepth: 4,
    maximumExecutionBudgetMilliseconds: 30_000,
    ...overrides,
  };
}

describe("TOOLKIT-01-05：纯转换可启用", () => {
  it("① 无外部副作用的纯转换器在具备沙箱时可启用", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
    });
    expect(outcome.isEnabled).toBe(true);
    expect(outcome.reason).toBeNull();
  });

  it("② 纯转换器即使平台不支持 broker 也可启用（不涉及文件/进程/网络）", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration(),
      platform: buildPlatform({ hasControlledBroker: false }),
    });
    expect(outcome.isEnabled).toBe(true);
  });
});

describe("TOOLKIT-01-05：readOnly 自声明不构成信任", () => {
  it("③ 自声明 readOnly 但声明了文件副作用 ⇒ 必须拒绝（不得靠自声明成安全工具）", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        // 自声明只读，却同时声明/申请了文件能力 ⇒ 矛盾（本用例的核心）
        readOnlySelfDeclaration: true,
        declaredSideEffects: ["file-read"],
        requiredCapabilities: ["file-read"],
      }),
      platform: buildPlatform({ supportedCapabilities: ["file-read"] }),
    });
    expect(outcome.isEnabled).toBe(false);
    expect(String(outcome.reason)).toMatch(/readOnly|自声明|不构成|矛盾/);
  });

  it("④ 声明无副作用却申请了进程能力 ⇒ 必须拒绝（声明自相矛盾）", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        declaredSideEffects: ["none"],
        requiredCapabilities: ["process-execute"],
      }),
      platform: buildPlatform({ supportedCapabilities: ["process-execute"] }),
    });
    expect(outcome.isEnabled).toBe(false);
    expect(String(outcome.reason)).toMatch(/矛盾|不一致|副作用/);
  });
});

describe("TOOLKIT-01-05：文件/进程/网络必须沙箱 + broker 双备", () => {
  const sensitiveCapabilities = ["file-read", "file-write", "process-execute", "network-access"] as const;

  it("⑤ 涉及文件/进程/网络时缺沙箱或缺 broker 一律拒绝", () => {
    for (const capability of sensitiveCapabilities) {
      const withoutSandbox = evaluateProgramToolEnablement({
        declaration: buildDeclaration({
          // 涉及文件/进程/网络者**不是**只读工具，不得自声明 readOnly
          readOnlySelfDeclaration: false,
          declaredSideEffects: [capability],
          requiredCapabilities: [capability],
        }),
        platform: buildPlatform({
          hasEnforceableSandbox: false,
          supportedCapabilities: [capability],
        }),
      });
      expect(
        withoutSandbox.isEnabled,
        capability + " 缺沙箱必须拒绝",
      ).toBe(false);

      const withoutBroker = evaluateProgramToolEnablement({
        declaration: buildDeclaration({
          // 涉及文件/进程/网络者**不是**只读工具，不得自声明 readOnly
          readOnlySelfDeclaration: false,
          declaredSideEffects: [capability],
          requiredCapabilities: [capability],
        }),
        platform: buildPlatform({
          hasControlledBroker: false,
          supportedCapabilities: [capability],
        }),
      });
      expect(withoutBroker.isEnabled, capability + " 缺 broker 必须拒绝").toBe(false);
    }
  });

  it("⑥ 沙箱与 broker 双备、且平台支持该能力时可启用", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        readOnlySelfDeclaration: false,
        declaredSideEffects: ["file-read"],
        requiredCapabilities: ["file-read"],
      }),
      platform: buildPlatform({ supportedCapabilities: ["file-read"] }),
    });
    expect(outcome.isEnabled).toBe(true);
  });

  it("⑦ 平台不支持所需能力 ⇒ 拒绝并报告不支持，且提示保留配方路径", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        readOnlySelfDeclaration: false,
        declaredSideEffects: ["network-access"],
        requiredCapabilities: ["network-access"],
      }),
      platform: buildPlatform({ supportedCapabilities: [] }),
    });
    expect(outcome.isEnabled).toBe(false);
    expect(outcome.unsupportedCapabilities).toEqual(["network-access"]);
    expect(String(outcome.reason)).toMatch(/不支持|保留.*配方|配方路径/);
  });

  it("⑦b 能力不支持**优先于**沙箱缺失被报告（否则用户看到的是次要原因）", () => {
    /**
     * 同时满足"平台不支持该能力"与"缺沙箱"时，应报告**不支持**并给出
     * `unsupportedCapabilities`（卡内："未支持环境明确拒绝"）。
     * 若先报沙箱，用户会以为"补个沙箱就行"，而实际上该平台根本不支持该能力。
     */
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        readOnlySelfDeclaration: false,
        declaredSideEffects: ["network-access"],
        requiredCapabilities: ["network-access"],
      }),
      platform: buildPlatform({
        hasEnforceableSandbox: false,
        hasControlledBroker: false,
        supportedCapabilities: [],
      }),
    });
    expect(outcome.isEnabled).toBe(false);
    expect(outcome.unsupportedCapabilities).toEqual(["network-access"]);
    expect(String(outcome.reason)).toMatch(/不支持/);
  });
  it("⑧ 绝不回退到任意脚本后备入口", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        readOnlySelfDeclaration: false,
        declaredSideEffects: ["process-execute"],
        requiredCapabilities: ["process-execute"],
      }),
      platform: buildPlatform({
        hasEnforceableSandbox: false,
        hasControlledBroker: false,
      }),
    });
    expect(outcome.isEnabled).toBe(false);
    // 结果必须**明确**表示"不启用"，不得给出任何"降级为直接执行脚本"的路径
    expect(outcome.fallbackPath).toBe("recipe-only");
    expect(outcome.isArbitraryScriptFallbackAllowed).toBe(false);
  });
});

describe("TOOLKIT-01-05：有界依赖深度与执行预算", () => {
  it("⑨ 依赖深度超出平台上限 ⇒ 拒绝", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({ dependencyDepth: 9 }),
      platform: buildPlatform({ maximumDependencyDepth: 4 }),
    });
    expect(outcome.isEnabled).toBe(false);
    expect(String(outcome.reason)).toMatch(/依赖深度|depth/);
  });

  it("⑩ 执行预算超出平台上限 ⇒ 拒绝", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({ executionBudgetMilliseconds: 60_000 }),
      platform: buildPlatform({ maximumExecutionBudgetMilliseconds: 30_000 }),
    });
    expect(outcome.isEnabled).toBe(false);
    expect(String(outcome.reason)).toMatch(/预算|budget/);
  });

  it("⑪ 边界值（恰好等于上限）必须被接受（不得用 > 与 >= 混淆导致误拒）", () => {
    const outcome = evaluateProgramToolEnablement({
      declaration: buildDeclaration({
        dependencyDepth: 4,
        executionBudgetMilliseconds: 30_000,
      }),
      platform: buildPlatform({
        maximumDependencyDepth: 4,
        maximumExecutionBudgetMilliseconds: 30_000,
      }),
    });
    expect(outcome.isEnabled).toBe(true);
  });
});
