import { describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import type { ModeTransitionTrigger } from "../../../packages/core/src/core/mode-machine.js";

describe("ModeMachine", () => {
  it("初始默认 assist 模式", () => {
    const machine = new ModeMachine();
    expect(machine.getCurrentMode()).toBe("assist");
  });

  it("可指定初始模式", () => {
    const machine = new ModeMachine("ponder");
    expect(machine.getCurrentMode()).toBe("ponder");
  });

  it("同模式迁移为无操作，不抛错", () => {
    const machine = new ModeMachine("assist");
    expect(machine.transition("assist", "user-request")).toBe("assist");
  });

  const legalTransitions: Array<{
    from: "ponder" | "assist" | "devolve";
    to: "ponder" | "assist" | "devolve";
    trigger: ModeTransitionTrigger;
  }> = [
    { from: "ponder", to: "assist", trigger: "user-request" },
    { from: "ponder", to: "assist", trigger: "tool-requirement" },
    { from: "ponder", to: "devolve", trigger: "user-request" },
    { from: "assist", to: "ponder", trigger: "user-request" },
    { from: "assist", to: "ponder", trigger: "degrade" },
    { from: "assist", to: "ponder", trigger: "completion" },
    { from: "assist", to: "devolve", trigger: "user-request" },
    { from: "assist", to: "devolve", trigger: "permission-requirement" },
    { from: "assist", to: "devolve", trigger: "complexity" },
    { from: "devolve", to: "ponder", trigger: "user-request" },
    { from: "devolve", to: "ponder", trigger: "degrade" },
    { from: "devolve", to: "assist", trigger: "user-request" },
    { from: "devolve", to: "assist", trigger: "degrade" },
  ];

  it.each(legalTransitions)(
    "合法迁移: $from → $to（$trigger）",
    ({ from, to, trigger }) => {
      const machine = new ModeMachine(from);
      expect(machine.transition(to, trigger)).toBe(to);
    },
  );

  const illegalTransitions: Array<{
    from: "ponder" | "assist" | "devolve";
    to: "ponder" | "assist" | "devolve";
    trigger: ModeTransitionTrigger;
  }> = [
    { from: "ponder", to: "devolve", trigger: "tool-requirement" },
    { from: "ponder", to: "assist", trigger: "permission-requirement" },
    { from: "assist", to: "devolve", trigger: "tool-requirement" },
    { from: "assist", to: "devolve", trigger: "degrade" },
    { from: "devolve", to: "assist", trigger: "completion" },
    { from: "devolve", to: "ponder", trigger: "permission-requirement" },
  ];

  it.each(illegalTransitions)(
    "非法迁移抛 DomainError: $from → $to（$trigger）",
    ({ from, to, trigger }) => {
      const machine = new ModeMachine(from);
      expect(() => machine.transition(to, trigger)).toThrowError(
        DomainError,
      );
    },
  );

  it("非法迁移抛出稳定 errorCode invalid-mode-transition", () => {
    const machine = new ModeMachine("devolve");
    try {
      machine.transition("assist", "completion");
      throw new Error("应当抛出但未抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).errorCode).toBe(
        "invalid-mode-transition",
      );
    }
  });

  it("非法迁移不会改变当前模式", () => {
    const machine = new ModeMachine("assist");
    expect(() => machine.transition("devolve", "tool-requirement")).toThrow();
    expect(machine.getCurrentMode()).toBe("assist");
  });
});
