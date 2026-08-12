/**
 * 模式状态机（T02）。
 * 迁移规则对应 agent-main-architecture.md §6.1 切换规则表。
 */
import { DomainError } from "./errors.js";
import type { AgentMode } from "./types.js";

export type ModeTransitionTrigger =
  | "user-request"
  | "tool-requirement"
  | "permission-requirement"
  | "complexity"
  | "degrade"
  | "completion";

const MODE_TRANSITION_RULES: Record<
  AgentMode,
  Partial<Record<AgentMode, ModeTransitionTrigger[]>>
> = {
  ponder: {
    assist: ["user-request", "tool-requirement"],
    devolve: ["user-request"],
  },
  assist: {
    ponder: ["user-request", "degrade", "completion"],
    devolve: ["user-request", "permission-requirement", "complexity"],
  },
  devolve: {
    ponder: ["user-request", "degrade", "completion"],
    assist: ["user-request", "degrade"],
  },
};

export class ModeMachine {
  private currentMode: AgentMode;

  constructor(initialMode: AgentMode = "assist") {
    this.currentMode = initialMode;
  }

  getCurrentMode(): AgentMode {
    return this.currentMode;
  }

  /**
   * 切换到目标模式。同模式为无操作；非法迁移抛出 DomainError。
   * 切换后所有后续工具调用按新模式重新鉴权（冻结决策：安全降级）。
   */
  transition(nextMode: AgentMode, trigger: ModeTransitionTrigger): AgentMode {
    if (nextMode === this.currentMode) {
      return this.currentMode;
    }
    const allowedTriggers = MODE_TRANSITION_RULES[this.currentMode]?.[nextMode];
    if (allowedTriggers === undefined || !allowedTriggers.includes(trigger)) {
      throw new DomainError(
        "invalid-mode-transition",
        `非法模式迁移: ${this.currentMode} → ${nextMode}（触发: ${trigger}）`,
      );
    }
    this.currentMode = nextMode;
    return this.currentMode;
  }
}
