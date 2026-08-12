import { describe, expect, it } from "vitest";

import {
  ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES,
  DEFAULT_BACKOFF_RESET_SECONDS,
} from "../../../packages/core/src/core/types.js";
import {
  hashToolArguments,
  PermissionDecider,
  PermissionPolicy,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";

const NOW_UNIX_SECONDS = 1_800_000_000;
const TTL_SECONDS = ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES * 60;

describe("PermissionPolicy 表驱动矩阵：模式 × 工具类别 × 授权状态", () => {
  const cases: Array<{
    mode: "ponder" | "assist" | "devolve";
    category: "readonly" | "restricted" | "forbidden";
    isSessionAuthorized: boolean;
    expected: "allow" | "ask" | "deny";
  }> = [
    // Ponder：一律 deny
    { mode: "ponder", category: "readonly", isSessionAuthorized: false, expected: "deny" },
    { mode: "ponder", category: "restricted", isSessionAuthorized: false, expected: "deny" },
    { mode: "ponder", category: "restricted", isSessionAuthorized: true, expected: "deny" },
    { mode: "ponder", category: "forbidden", isSessionAuthorized: false, expected: "deny" },
    // Assist：readonly allow；restricted 看授权；forbidden deny
    { mode: "assist", category: "readonly", isSessionAuthorized: false, expected: "allow" },
    { mode: "assist", category: "readonly", isSessionAuthorized: true, expected: "allow" },
    { mode: "assist", category: "restricted", isSessionAuthorized: false, expected: "ask" },
    { mode: "assist", category: "restricted", isSessionAuthorized: true, expected: "allow" },
    { mode: "assist", category: "forbidden", isSessionAuthorized: false, expected: "deny" },
    { mode: "assist", category: "forbidden", isSessionAuthorized: true, expected: "deny" },
    // Devolve：注册工具一律 allow（工作区/系统边界由 T06 包装层约束）
    { mode: "devolve", category: "readonly", isSessionAuthorized: false, expected: "allow" },
    { mode: "devolve", category: "restricted", isSessionAuthorized: false, expected: "allow" },
    { mode: "devolve", category: "restricted", isSessionAuthorized: true, expected: "allow" },
    { mode: "devolve", category: "forbidden", isSessionAuthorized: false, expected: "allow" },
  ];

  it.each(cases)(
    "mode=$mode category=$category authorized=$isSessionAuthorized → $expected",
    ({ mode, category, isSessionAuthorized, expected }) => {
      const policy = new PermissionPolicy();
      expect(
        policy.evaluate(category, mode, isSessionAuthorized),
      ).toBe(expected);
    },
  );
});

describe("SessionAuthorizationManager", () => {
  it("授予后参数一致且在 TTL 内有效", () => {
    const manager = new SessionAuthorizationManager();
    const argumentHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", argumentHash, NOW_UNIX_SECONDS);
    expect(
      manager.isAuthorized("writeFile", argumentHash, NOW_UNIX_SECONDS),
    ).toBe(true);
  });

  it("未授予的工具不授权", () => {
    const manager = new SessionAuthorizationManager();
    expect(
      manager.isAuthorized(
        "writeFile",
        hashToolArguments('{"path":"a.txt"}'),
        NOW_UNIX_SECONDS,
      ),
    ).toBe(false);
  });

  it("参数变更后必须二次鉴权（参数哈希不一致）", () => {
    const manager = new SessionAuthorizationManager();
    const originalArgumentsHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", originalArgumentsHash, NOW_UNIX_SECONDS);
    const changedArgumentsHash = hashToolArguments('{"path":"b.txt"}');
    expect(
      manager.isAuthorized("writeFile", changedArgumentsHash, NOW_UNIX_SECONDS),
    ).toBe(false);
  });

  it("TTL 过期后授权失效", () => {
    const manager = new SessionAuthorizationManager();
    const argumentHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", argumentHash, NOW_UNIX_SECONDS);
    const afterExpiry = NOW_UNIX_SECONDS + TTL_SECONDS + 1;
    expect(
      manager.isAuthorized("writeFile", argumentHash, afterExpiry),
    ).toBe(false);
  });

  it("TTL 边界内（过期时刻前 1 秒）仍有效，恰达过期时刻即失效", () => {
    const manager = new SessionAuthorizationManager();
    const argumentHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", argumentHash, NOW_UNIX_SECONDS);
    const justBeforeBoundary = NOW_UNIX_SECONDS + TTL_SECONDS - 1;
    expect(
      manager.isAuthorized("writeFile", argumentHash, justBeforeBoundary),
    ).toBe(true);
    const atBoundary = NOW_UNIX_SECONDS + TTL_SECONDS;
    expect(
      manager.isAuthorized("writeFile", argumentHash, atBoundary),
    ).toBe(false);
  });

  it("revokeAll 清除全部授权", () => {
    const manager = new SessionAuthorizationManager();
    const argumentHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", argumentHash, NOW_UNIX_SECONDS);
    manager.revokeAll();
    expect(
      manager.isAuthorized("writeFile", argumentHash, NOW_UNIX_SECONDS),
    ).toBe(false);
  });
});

describe("PermissionDecider（实时读取当前模式）", () => {
  it("降级后下一次调用使用新策略：Assist 授权 → Ponder 立即 deny", () => {
    const machine = new ModeMachine("assist");
    const manager = new SessionAuthorizationManager();
    const decider = new PermissionDecider(machine, manager);
    const argumentHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", argumentHash, NOW_UNIX_SECONDS);

    expect(
      decider.decide(
        { toolName: "writeFile", category: "restricted", argumentsJson: '{"path":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("allow");

    machine.transition("ponder", "degrade");
    expect(
      decider.decide(
        { toolName: "writeFile", category: "restricted", argumentsJson: '{"path":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("deny");
  });

  it("Assist 下受限工具授权后为 allow，未授权为 ask", () => {
    const machine = new ModeMachine("assist");
    const manager = new SessionAuthorizationManager();
    const decider = new PermissionDecider(machine, manager);

    expect(
      decider.decide(
        { toolName: "writeFile", category: "restricted", argumentsJson: '{"path":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("ask");

    const argumentHash = hashToolArguments('{"path":"a.txt"}');
    manager.grant("writeFile", argumentHash, NOW_UNIX_SECONDS);
    expect(
      decider.decide(
        { toolName: "writeFile", category: "restricted", argumentsJson: '{"path":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("allow");
  });

  it("Assist 下只读工具无需询问，禁止工具一律拒绝", () => {
    const machine = new ModeMachine("assist");
    const decider = new PermissionDecider(machine, new SessionAuthorizationManager());
    expect(
      decider.decide(
        { toolName: "readFile", category: "readonly", argumentsJson: '{"path":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("allow");
    expect(
      decider.decide(
        { toolName: "deleteFile", category: "forbidden", argumentsJson: '{"path":"a.txt"}' },
        NOW_UNIX_SECONDS,
      ),
    ).toBe("deny");
  });

  it("会话授权重置行为与冻结常量一致", () => {
    expect(DEFAULT_BACKOFF_RESET_SECONDS).toBe(2);
  });
});
