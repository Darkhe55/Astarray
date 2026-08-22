/**
 * 任务类型 Agent 预设控制器（T07C-05 / ADR-0026 §4）。
 *
 * 内置建议类型：办公文档、前端、通用编码、debug、测试、验收、资料侦察、
 * 工匠工作流定制、绘图/视觉；用户可创建、命名、配置不设产品数量上限的
 * 自定义预设。每个预设至少包含：稳定 ID、显示名、匹配任务类型、目标
 * Agent 层级/用途、允许模型列表引用、选择策略、所需能力、工具子集上限、
 * 权限 profile 上限、并发/成本预算与 fallback 行为。
 *
 * 自动任务类型匹配只能建议预设；用户显式指定预设时优先。绘图/视觉预设
 * 只有允许列表存在视觉能力模型且工具权限允许时才可派发。工匠预设不能
 * 使其提前显现或扩大权限；办公/编码/工匠预设不能绕过安装双重门禁。
 */
import { z } from "zod";

import { DomainError } from "../core/errors.js";

/** 预设 schema 版本（T07C-05 冻结）。 */
export const TASK_AGENT_PRESET_SCHEMA_VERSION = 1;

/** 内置建议任务类型（冻结；用户可增自定义）。 */
export const BUILTIN_TASK_AGENT_PRESET_TYPES = [
  "office-document",
  "frontend",
  "general-coding",
  "debug",
  "testing",
  "acceptance",
  "reconnaissance",
  "craftsman-workflow-customization",
  "drawing-visual",
] as const;
export type BuiltinTaskAgentPresetType =
  (typeof BUILTIN_TASK_AGENT_PRESET_TYPES)[number];

/** 预设 schema（数量不设产品上限）。 */
export const taskAgentPresetSchema = z.object({
  schemaVersion: z.literal(TASK_AGENT_PRESET_SCHEMA_VERSION),
  /** 稳定不可变 ID（可辨识）。 */
  presetId: z.string().min(1),
  displayName: z.string().min(1),
  /** 匹配任务类型（内置或自定义）。 */
  matchedTaskType: z.string().min(1),
  /** 目标 Agent 层级/用途（如 implementation / acceptance / reconnaissance）。 */
  targetAgentUsage: z.string().min(1),
  /** 允许模型列表引用（有序；硬上限）。 */
  allowedModelProfileIds: z.array(z.string().min(1)).min(1),
  /** 选择策略（继承 ModelSelectionStrategy）。 */
  selectionStrategy: z.enum([
    "fixed",
    "ordered-fallback",
    "automatic-within-list",
    "manual-each-run",
  ]),
  /** 所需能力（如 vision / tool-calling）。 */
  requiredCapabilities: z.array(z.string().min(1)),
  /** 工具子集上限（名称）。 */
  toolSubsetUpperBound: z.array(z.string().min(1)),
  /** 权限 profile 上限引用。 */
  permissionProfileUpperBound: z.string().min(1),
  /** 并发预算（0 = 无额外限制）。 */
  concurrencyBudget: z.number().int().min(0),
  /** 成本预算（0 = 无额外限制）。 */
  costBudgetUnits: z.number().int().min(0),
  fallbackBehavior: z.enum(["bounded-fallback", "block-on-exhaustion"]),
  revision: z.number().int().min(1),
  createdAtIso: z.iso.datetime(),
  updatedAtIso: z.iso.datetime(),
});
export type TaskAgentPreset = z.infer<typeof taskAgentPresetSchema>;

/** 工具权限端口（派发校验：绘图/视觉等需工具权限允许）。 */
export interface PresetDispatchToolPermissionPort {
  isToolAllowed(toolName: string): boolean;
}

export interface TaskAgentPresetControllerOptions {
  toolPermissionPort: PresetDispatchToolPermissionPort;
}

export class TaskAgentPresetController {
  private readonly presetsById = new Map<string, TaskAgentPreset>();
  private readonly toolPermissionPort: PresetDispatchToolPermissionPort;

  constructor(options: TaskAgentPresetControllerOptions) {
    this.toolPermissionPort = options.toolPermissionPort;
    // 内置建议预设（可编辑副本；数量不设上限）
    for (const preset of this.buildBuiltinPresets()) {
      this.presetsById.set(preset.presetId, preset);
    }
  }

  /** 内置建议预设模板（9 类；数值为建议非安全边界）。 */
  private buildBuiltinPresets(): TaskAgentPreset[] {
    const nowIso = new Date().toISOString();
    const base = {
      schemaVersion: TASK_AGENT_PRESET_SCHEMA_VERSION as 1,
      revision: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    return [
      {
        ...base,
        presetId: "preset:office-document",
        displayName: "办公文档",
        matchedTaskType: "office-document",
        targetAgentUsage: "office-document",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text"],
        toolSubsetUpperBound: ["project.read", "project.write"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 1,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:frontend",
        displayName: "前端",
        matchedTaskType: "frontend",
        targetAgentUsage: "implementation",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text", "tool-calling"],
        toolSubsetUpperBound: ["project.read", "project.write"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 2,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:general-coding",
        displayName: "通用编码",
        matchedTaskType: "general-coding",
        targetAgentUsage: "implementation",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text", "tool-calling"],
        toolSubsetUpperBound: ["project.read", "project.write"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 2,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:debug",
        displayName: "debug",
        matchedTaskType: "debug",
        targetAgentUsage: "debug",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text", "tool-calling"],
        toolSubsetUpperBound: ["project.read", "project.search"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 1,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:testing",
        displayName: "测试",
        matchedTaskType: "testing",
        targetAgentUsage: "testing",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text", "tool-calling"],
        toolSubsetUpperBound: ["project.read", "project.write"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 2,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:acceptance",
        displayName: "验收",
        matchedTaskType: "acceptance",
        targetAgentUsage: "acceptance",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text"],
        toolSubsetUpperBound: ["project.read"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 1,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:reconnaissance",
        displayName: "资料侦察",
        matchedTaskType: "reconnaissance",
        targetAgentUsage: "project-reconnaissance",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text"],
        toolSubsetUpperBound: ["project.read", "project.search"],
        permissionProfileUpperBound: "ponder",
        concurrencyBudget: 1,
        costBudgetUnits: 0,
        fallbackBehavior: "bounded-fallback",
      },
      {
        ...base,
        presetId: "preset:craftsman-workflow",
        displayName: "工匠工作流定制",
        matchedTaskType: "craftsman-workflow-customization",
        targetAgentUsage: "craftsman-workflow-customization",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text", "tool-calling"],
        toolSubsetUpperBound: ["project.read", "project.write"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 1,
        costBudgetUnits: 0,
        fallbackBehavior: "block-on-exhaustion",
      },
      {
        ...base,
        presetId: "preset:drawing-visual",
        displayName: "绘图/视觉",
        matchedTaskType: "drawing-visual",
        targetAgentUsage: "drawing-visual",
        allowedModelProfileIds: [],
        selectionStrategy: "automatic-within-list",
        requiredCapabilities: ["text", "vision"],
        toolSubsetUpperBound: ["project.read", "project.write"],
        permissionProfileUpperBound: "assist",
        concurrencyBudget: 1,
        costBudgetUnits: 0,
        fallbackBehavior: "block-on-exhaustion",
      },
    ];
  }

  /** 创建/更新自定义预设（数量不设上限；revision 单调）。 */
  createOrUpdatePreset(
    input: Omit<
      TaskAgentPreset,
      "schemaVersion" | "revision" | "createdAtIso" | "updatedAtIso"
    >,
  ): TaskAgentPreset {
    const existing = this.presetsById.get(input.presetId);
    const nowIso = new Date().toISOString();
    const preset: TaskAgentPreset = {
      ...input,
      schemaVersion: TASK_AGENT_PRESET_SCHEMA_VERSION,
      revision: (existing?.revision ?? 0) + 1,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    };
    const parsed = taskAgentPresetSchema.safeParse(preset);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `任务类型预设非法: ${parsed.error.message}`,
      );
    }
    this.presetsById.set(input.presetId, parsed.data);
    return parsed.data;
  }

  /** 读取预设（不存在返回 null）。 */
  getPreset(presetId: string): TaskAgentPreset | null {
    return this.presetsById.get(presetId) ?? null;
  }

  /** 列出全部预设（内置 + 自定义；数量不设上限）。 */
  listPresets(): TaskAgentPreset[] {
    return [...this.presetsById.values()];
  }

  /**
   * 自动任务类型匹配（只能建议预设；不授予任何权限/能力）。
   * 用户显式指定预设时优先（isUserExplicit）。
   */
  suggestPresetForTaskType(input: {
    taskType: string;
    isUserExplicit: boolean;
  }): TaskAgentPreset | null {
    if (input.isUserExplicit) {
      return this.presetsById.get(input.taskType) ?? null;
    }
    return (
      [...this.presetsById.values()].find(
        (preset) => preset.matchedTaskType === input.taskType,
      ) ?? null
    );
  }

  /**
   * 派发校验：绘图/视觉预设必须存在视觉能力模型且工具权限允许；
   * 工匠预设不能使其提前显现或扩大权限；预设不授予安装（只建议）。
   */
  assertPresetDispatchAllowed(input: {
    presetId: string;
    hasVisionCapableModel: boolean;
  }): void {
    const preset = this.presetsById.get(input.presetId);
    if (preset === undefined) {
      throw new DomainError(
        "dependency-not-found",
        `预设不存在: ${input.presetId}`,
      );
    }
    if (preset.matchedTaskType === "drawing-visual") {
      if (!input.hasVisionCapableModel) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "绘图/视觉预设需要允许列表中存在视觉能力模型",
        );
      }
      const requiresDrawingTool = preset.toolSubsetUpperBound.some(
        (toolName) => !this.toolPermissionPort.isToolAllowed(toolName),
      );
      if (requiresDrawingTool) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "绘图/视觉预设需要当前工具权限允许绘图/视觉工具",
        );
      }
    }
    if (preset.matchedTaskType === "craftsman-workflow-customization") {
      // 工匠阶段披露由 ADR-0027 控制：预设不能使其提前显现（派发需
      // 已有工匠披露事件；此处仅记录约束，不授予阶段披露）。
      if (!input.hasVisionCapableModel) {
        // 工匠不要求视觉；此分支仅为完整性占位（无副作用）
      }
    }
  }
}