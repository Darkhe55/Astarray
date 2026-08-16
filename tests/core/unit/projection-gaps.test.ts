/**
 * B6R-11：main-agent-readonly-projection 缺口分支单测
 * （缺省 agentInstanceId 生成器，UUID 格式且不可复用）。
 */
import { describe, expect, it } from "vitest";

import { SecondaryAgentSessionController } from "../../../packages/core/src/tools/main-agent-readonly-projection.js";

describe("SecondaryAgentSessionController 缺省生成器", () => {
  it("不注入生成器：缺省 UUID 实例 ID，连续创建不重复", () => {
    const controller = new SecondaryAgentSessionController();
    const first = controller.createSecondaryAgentBinding({
      sessionId: "session-1",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
    });
    const second = controller.createSecondaryAgentBinding({
      sessionId: "session-1",
      baseProfileReference: { kind: "builtin", profileId: "assist" },
      baseProfileRevision: 1,
      catalogVersion: 1,
    });
    expect(first.agentInstanceId).toMatch(/^secondary-[0-9a-f-]{36}$/);
    expect(second.agentInstanceId).not.toBe(first.agentInstanceId);
    expect(first.sessionPermissionRevision).toBe(0);
  });
});
