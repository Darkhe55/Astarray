/**
 * T07C-05 测试：TaskAgentPreset 内置建议类型与无限自定义类型。
 * 验收：9 类内置建议；自定义数量不限；自动匹配只建议；绘图/视觉
 * 需视觉模型与工具权限；工匠预设不提前显现。
 */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_TASK_AGENT_PRESET_TYPES,
  TaskAgentPresetController,
} from "../../../packages/core/src/orchestration/task-agent-preset-controller.js";

function makePresetInput(overrides: Record<string, unknown> = {}) {
  return {
    presetId: "preset:custom-1",
    displayName: "自定义文档",
    matchedTaskType: "document-conversion",
    targetAgentUsage: "office-document",
    allowedModelProfileIds: ["openai/gpt-4o"],
    selectionStrategy: "automatic-within-list" as const,
    requiredCapabilities: ["text"],
    toolSubsetUpperBound: ["project.read"],
    permissionProfileUpperBound: "assist",
    concurrencyBudget: 1,
    costBudgetUnits: 0,
    fallbackBehavior: "bounded-fallback" as const,
    ...overrides,
  };
}

function makeController(options: { allowedTools?: string[] } = {}) {
  const allowedTools = new Set(options.allowedTools ?? ["project.read", "project.write"]);
  return new TaskAgentPresetController({
    toolPermissionPort: {
      isToolAllowed: (toolName) => allowedTools.has(toolName),
    },
  });
}

describe("内置建议预设", () => {
  it("9 类内置建议类型全部存在", () => {
    const controller = makeController();
    const presets = controller.listPresets();
    expect(presets).toHaveLength(9);
    expect(BUILTIN_TASK_AGENT_PRESET_TYPES).toHaveLength(9);
    for (const presetType of BUILTIN_TASK_AGENT_PRESET_TYPES) {
      const preset = controller.suggestPresetForTaskType({
        taskType: presetType,
        isUserExplicit: false,
      });
      expect(preset).not.toBeNull();
    }
  });

  it("工匠预设 fallback 为 block-on-exhaustion（不活锁）", () => {
    const controller = makeController();
    const preset = controller.suggestPresetForTaskType({
      taskType: "craftsman-workflow-customization",
      isUserExplicit: false,
    });
    expect(preset?.fallbackBehavior).toBe("block-on-exhaustion");
  });
});

describe("自定义预设（数量不设上限）", () => {
  it("创建自定义预设：revision 1；重复创建 revision 递增", () => {
    const controller = makeController();
    const created = controller.createOrUpdatePreset(makePresetInput());
    expect(created.revision).toBe(1);
    const updated = controller.createOrUpdatePreset(
      makePresetInput({ displayName: "重命名" }),
    );
    expect(updated.revision).toBe(2);
    expect(updated.displayName).toBe("重命名");
  });

  it("创建 25 个自定义预设无上限", () => {
    const controller = makeController();
    for (let index = 0; index < 25; index++) {
      controller.createOrUpdatePreset(
        makePresetInput({
          presetId: `preset:custom-${index}`,
          matchedTaskType: `type-${index}`,
          displayName: `自定义 ${index}`,
        }),
      );
    }
    expect(controller.listPresets()).toHaveLength(9 + 25);
  });

  it("预设 schema 非法（空模型列表）→ 拒绝", () => {
    const controller = makeController();
    expect(() =>
      controller.createOrUpdatePreset(
        makePresetInput({ allowedModelProfileIds: [] }),
      ),
    ).toThrowError(/任务类型预设非法/);
  });
});

describe("自动匹配与派发校验", () => {
  it("自动匹配只建议预设（不授予权限）；用户显式指定优先", () => {
    const controller = makeController();
    const suggested = controller.suggestPresetForTaskType({
      taskType: "debug",
      isUserExplicit: false,
    });
    expect(suggested?.presetId).toBe("preset:debug");
    // 用户显式指定自定义类型
    controller.createOrUpdatePreset(
      makePresetInput({ matchedTaskType: "special-task" }),
    );
    const explicit = controller.suggestPresetForTaskType({
      taskType: "preset:custom-1",
      isUserExplicit: true,
    });
    expect(explicit?.presetId).toBe("preset:custom-1");
  });

  it("绘图/视觉预设：缺视觉模型 → 拒绝派发", () => {
    const controller = makeController();
    expect(() =>
      controller.assertPresetDispatchAllowed({
        presetId: "preset:drawing-visual",
        hasVisionCapableModel: false,
      }),
    ).toThrowError(/视觉能力模型/);
  });

  it("绘图/视觉预设：工具权限不允许 → 拒绝派发", () => {
    const controller = makeController({ allowedTools: ["project.read"] });
    expect(() =>
      controller.assertPresetDispatchAllowed({
        presetId: "preset:drawing-visual",
        hasVisionCapableModel: true,
      }),
    ).toThrowError(/工具权限允许/);
  });

  it("绘图/视觉预设：视觉模型 + 工具权限齐备 → 派发允许", () => {
    const controller = makeController({
      allowedTools: ["project.read", "project.write"],
    });
    expect(() =>
      controller.assertPresetDispatchAllowed({
        presetId: "preset:drawing-visual",
        hasVisionCapableModel: true,
      }),
    ).not.toThrow();
  });

  it("未知预设派发 → 拒绝", () => {
    const controller = makeController();
    expect(() =>
      controller.assertPresetDispatchAllowed({
        presetId: "preset:ghost",
        hasVisionCapableModel: true,
      }),
    ).toThrowError(/预设不存在/);
  });
});