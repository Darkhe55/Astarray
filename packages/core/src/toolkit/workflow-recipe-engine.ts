/**
 * TOOLKIT-01-02：工作流配方的**有界偏序执行**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §2/§3 与检查点 02。
 *
 * 卡内定位："工作流配方 = **已有工具可完成的稳定多步操作**"，
 * 实现为"**有界偏序步骤与输入输出映射**，通过**现有工具执行网关**调用"，
 * 且必须"完整保留来源和**逐步骤回执**"，并"证明复用**不是只 import**"。
 *
 * 本模块纪律：
 *  - **不新增执行通道**：所有步骤都经注入的 `ToolPort`（现有受控网关）执行；
 *  - **不引入新工具**：步骤只能使用配方 `usedToolReferences` 已声明的工具；
 *  - 定义校验 **fail-closed**：环、未知依赖、未知工具、未声明工具、引用未声明输入一律拒绝；
 *  - 参数映射**只能**取自配方输入（`$input.<name>`）或字面量；
 *    引用**已完成步骤**的输出需要显式依赖（本版只支持输入与字面量，避免隐式时序耦合）；
 *  - 依赖失败的步骤**跳过**（不带着坏输入硬跑）；
 *  - 顶层必选步骤失败 ⇒ 整体 `isSuccessful=false`（**不声称成功**）。
 */
import type { ToolPort } from "../core/types.js";
import { ToolPackageRegistry } from "./tool-package-registry.js";

/** 参数映射值：`$input.<name>` 引用配方输入，其它字符串视为字面量。 */
export type RecipeArgumentMappingValue = string;

export interface WorkflowRecipeStep {
  stepIdentifier: string;
  /** 必须是配方 `usedToolReferences` 中已声明的工具（不得引入新工具）。 */
  toolName: string;
  /** 偏序：必须先完成的步骤。 */
  dependsOnStepIdentifiers: string[];
  argumentMapping: Record<string, RecipeArgumentMappingValue>;
}

export interface WorkflowRecipeDefinition {
  recipeIdentifier: string;
  version: number;
  /** 配方组合的**已有**工具（含 revision）。 */
  usedToolReferences: Array<{ toolId: string; toolRevision: number }>;
  steps: WorkflowRecipeStep[];
  /** 声明本配方允许的输入名（`$input.<name>` 只能引用其中之一）。 */
  declaredInputNames?: string[];
}

export interface RecipeDefinitionValidation {
  isValid: boolean;
  reason: string | null;
}

const INPUT_REFERENCE_PREFIX = "$input.";

/**
 * 校验配方定义（**纯函数**，不执行任何工具）。
 *
 * 拒绝：空步骤、重复步骤 ID、未知依赖、**依赖环**、未在 `usedToolReferences`
 * 声明的工具、引用未声明输入。
 */
export function validateRecipeDefinition(
  recipe: WorkflowRecipeDefinition,
): RecipeDefinitionValidation {
  if (recipe.steps.length === 0) {
    return { isValid: false, reason: "配方至少需要一个步骤" };
  }
  const stepIdentifiers = new Set<string>();
  for (const step of recipe.steps) {
    if (stepIdentifiers.has(step.stepIdentifier)) {
      return { isValid: false, reason: "步骤 ID 重复: " + step.stepIdentifier };
    }
    stepIdentifiers.add(step.stepIdentifier);
  }
  const declaredToolIds = new Set(
    recipe.usedToolReferences.map((reference) => reference.toolId),
  );
  for (const step of recipe.steps) {
    if (!declaredToolIds.has(step.toolName)) {
      return {
        isValid: false,
        reason:
          "步骤使用了未在 usedToolReferences 声明的工具（不得引入新工具）: " +
          step.toolName,
      };
    }
    for (const dependency of step.dependsOnStepIdentifiers) {
      if (!stepIdentifiers.has(dependency)) {
        return {
          isValid: false,
          reason: "步骤依赖不存在的步骤: " + dependency,
        };
      }
      if (dependency === step.stepIdentifier) {
        return { isValid: false, reason: "步骤不能依赖自身: " + step.stepIdentifier };
      }
    }
  }
  // 引用未声明输入
  const declaredInputNames = recipe.declaredInputNames ?? [];
  for (const step of recipe.steps) {
    for (const mappingValue of Object.values(step.argumentMapping)) {
      if (!mappingValue.startsWith(INPUT_REFERENCE_PREFIX)) {
        continue;
      }
      const inputName = mappingValue.slice(INPUT_REFERENCE_PREFIX.length);
      // 未显式声明输入名时，允许任何输入键（由调用方在运行时提供）；一旦声明则严格。
      if (declaredInputNames.length > 0 && !declaredInputNames.includes(inputName)) {
        return {
          isValid: false,
          reason: "参数映射引用了未声明的输入: " + inputName,
        };
      }
    }
  }
  // 依赖环检测（Kahn）
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of recipe.steps) {
    inDegree.set(step.stepIdentifier, step.dependsOnStepIdentifiers.length);
    for (const dependency of step.dependsOnStepIdentifiers) {
      const list = dependents.get(dependency) ?? [];
      list.push(step.stepIdentifier);
      dependents.set(dependency, list);
    }
  }
  const readyQueue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([stepIdentifier]) => stepIdentifier);
  let processedStepCount = 0;
  while (readyQueue.length > 0) {
    const current = readyQueue.shift() as string;
    processedStepCount += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        readyQueue.push(dependent);
      }
    }
  }
  if (processedStepCount !== recipe.steps.length) {
    return { isValid: false, reason: "步骤依赖存在环（无法确定执行顺序）" };
  }
  return { isValid: true, reason: null };
}

export type RecipeStepStatus = "succeeded" | "failed" | "skipped-dependency-failed";

export interface RecipeStepReceipt {
  recipeIdentifier: string;
  recipeVersion: number;
  stepIdentifier: string;
  toolName: string;
  argumentsJson: string;
  status: RecipeStepStatus;
  outputText: string | null;
  failureReason: string | null;
}

export interface RecipeExecutionOutcome {
  recipeIdentifier: string;
  recipeVersion: number;
  isSuccessful: boolean;
  stepReceipts: RecipeStepReceipt[];
}

export interface RecipeExecutionEngineOptions {
  /** **现有**受控工具网关；配方不新增执行通道。 */
  toolPort: ToolPort;
}

/**
 * 有界偏序执行器。
 *
 * 执行顺序：反复选取"依赖全部已完成"的步骤；依赖失败/被跳过的步骤一律
 * `skipped-dependency-failed`（**不带着坏输入硬跑**）。
 */
export class RecipeExecutionEngine {
  private readonly toolPort: ToolPort;

  constructor(options: RecipeExecutionEngineOptions) {
    this.toolPort = options.toolPort;
  }

  async execute(input: {
    recipe: WorkflowRecipeDefinition;
    input: Record<string, unknown>;
    cancellationSignal: AbortSignal;
  }): Promise<RecipeExecutionOutcome> {
    const validation = validateRecipeDefinition(input.recipe);
    if (!validation.isValid) {
      throw new Error("配方定义非法: " + String(validation.reason));
    }
    const statusByStepIdentifier = new Map<string, RecipeStepStatus>();
    const receipts: RecipeStepReceipt[] = [];
    let callSequence = 0;

    const remainingSteps = [...input.recipe.steps];
    while (remainingSteps.length > 0) {
      const executableIndex = remainingSteps.findIndex((step) =>
        step.dependsOnStepIdentifiers.every(
          (dependency) => statusByStepIdentifier.get(dependency) === "succeeded",
        ),
      );
      const skippedIndex = remainingSteps.findIndex((step) =>
        step.dependsOnStepIdentifiers.some((dependency) => {
          const dependencyStatus = statusByStepIdentifier.get(dependency);
          return (
            dependencyStatus === "failed" ||
            dependencyStatus === "skipped-dependency-failed"
          );
        }),
      );

      if (executableIndex >= 0) {
        const step = remainingSteps.splice(executableIndex, 1)[0] as WorkflowRecipeStep;
        const argumentsJson = buildStepArgumentsJson(step, input.input);
        callSequence += 1;
        const toolResult = await this.toolPort.execute(
          step.toolName,
          argumentsJson,
          "recipe-" + input.recipe.recipeIdentifier + "-" + String(callSequence),
          input.cancellationSignal,
        );
        if (toolResult.kind === "success") {
          statusByStepIdentifier.set(step.stepIdentifier, "succeeded");
          receipts.push({
            recipeIdentifier: input.recipe.recipeIdentifier,
            recipeVersion: input.recipe.version,
            stepIdentifier: step.stepIdentifier,
            toolName: step.toolName,
            argumentsJson,
            status: "succeeded",
            outputText: toolResult.outputText,
            failureReason: null,
          });
        } else {
          statusByStepIdentifier.set(step.stepIdentifier, "failed");
          receipts.push({
            recipeIdentifier: input.recipe.recipeIdentifier,
            recipeVersion: input.recipe.version,
            stepIdentifier: step.stepIdentifier,
            toolName: step.toolName,
            argumentsJson,
            status: "failed",
            outputText: null,
            failureReason:
              typeof toolResult.errorCode === "string"
                ? toolResult.errorCode
                : "工具执行失败",
          });
        }
        continue;
      }

      if (skippedIndex >= 0) {
        const step = remainingSteps.splice(skippedIndex, 1)[0] as WorkflowRecipeStep;
        statusByStepIdentifier.set(step.stepIdentifier, "skipped-dependency-failed");
        receipts.push({
          recipeIdentifier: input.recipe.recipeIdentifier,
          recipeVersion: input.recipe.version,
          stepIdentifier: step.stepIdentifier,
          toolName: step.toolName,
          argumentsJson: buildStepArgumentsJson(step, input.input),
          status: "skipped-dependency-failed",
          outputText: null,
          failureReason: "依赖步骤未成功，跳过（不得带坏输入硬跑）",
        });
        continue;
      }

      // 理论上不可达：校验已排除环，且"依赖全部完成"或"存在失败依赖"必有一个成立。
      throw new Error("配方执行进入不可判定状态（依赖图无可用步骤）");
    }

    const isSuccessful = receipts.every((receipt) => receipt.status === "succeeded");
    return {
      recipeIdentifier: input.recipe.recipeIdentifier,
      recipeVersion: input.recipe.version,
      isSuccessful,
      stepReceipts: receipts,
    };
  }
}

/** 把步骤的参数映射解析为实际参数 JSON（`$input.<name>` 取配方输入，其余为字面量）。 */
function buildStepArgumentsJson(
  step: WorkflowRecipeStep,
  recipeInput: Record<string, unknown>,
): string {
  const resolved: Record<string, unknown> = {};
  for (const [parameterName, mappingValue] of Object.entries(step.argumentMapping)) {
    if (mappingValue.startsWith(INPUT_REFERENCE_PREFIX)) {
      const inputName = mappingValue.slice(INPUT_REFERENCE_PREFIX.length);
      resolved[parameterName] = recipeInput[inputName];
      continue;
    }
    resolved[parameterName] = mappingValue;
  }
  return JSON.stringify(resolved);
}

/* ────────────────────────── 草案 → 独立验证 → 登记/启用 → 发现 → 调用 ────────────────────────── */

export type RecipeDraftStatus = "draft" | "validated" | "rejected";

export interface RecipeDraftRecord {
  draftIdentifier: string;
  recipe: WorkflowRecipeDefinition;
  authorAgentInstanceId: string;
  sourceProjectIdentifier: string;
  status: RecipeDraftStatus;
  validatorAgentInstanceId: string | null;
  /** 验证期**真实执行过**的工具名（用于"复用不是只 import"的判定）。 */
  validatedExecutedToolNames: string[];
}

export interface RecipeLifecycle {
  submitRecipeDraft(input: {
    recipe: WorkflowRecipeDefinition;
    authorAgentInstanceId: string;
    sourceProjectIdentifier: string;
  }): Promise<RecipeDraftRecord>;
  recordIndependentValidation(input: {
    draftIdentifier: string;
    validatorAgentInstanceId: string;
    /** 验证期**真实经工具网关执行**的工具名。 */
    executedToolNames: string[];
    isExecutionSuccessful: boolean;
  }): Promise<RecipeDraftRecord>;
  registerAndEnable(input: {
    draftIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
  }): Promise<{ toolPackageId: string; version: number; isEnabledInProject: boolean }>;
  listDiscoverableRecipes(input: {
    projectIdentifier: string;
  }): Array<{ toolPackageId: string; version: number }>;
  executeRegisteredRecipe(input: {
    toolPackageId: string;
    version: number;
    projectIdentifier: string;
    input: Record<string, unknown>;
    cancellationSignal: AbortSignal;
    recipeExecutionEngine: RecipeExecutionEngine;
    recipe: WorkflowRecipeDefinition;
  }): Promise<RecipeExecutionOutcome | null>;
}

/**
 * 创建配方生命周期（检查点 02 点名的链路）。
 *
 * 与 `ToolPackageRegistry`（TOOLKIT-01-01）组合：登记/启用的作用域、不可变与
 * "未启用不可调用"仍由注册表判定，本层只补"草案 → 独立验证"这段。
 *
 * **"独立验证"的两层硬约束**：
 *  1. 验证者与作者必须是**不同** `agentInstanceId`（沿用 T08D"作者不能自验"）；
 *  2. 验证者必须**真实执行过配方声明的全部工具**，否则判为未验证 ——
 *     这正是卡内"**证明复用不是只 import**"的可执行形式：
 *     仅 import 一个函数不会产生任何工具执行记录。
 */
export function createRecipeLifecycle(options?: {
  toolPackageRegistry?: ToolPackageRegistry;
}): RecipeLifecycle {
  const registry = options?.toolPackageRegistry ?? new ToolPackageRegistry();
  const drafts = new Map<string, RecipeDraftRecord>();
  let nextDraftSequence = 1;

  const requireDraft = (draftIdentifier: string): RecipeDraftRecord => {
    const draft = drafts.get(draftIdentifier);
    if (draft === undefined) {
      throw new Error("配方草案不存在: " + draftIdentifier);
    }
    return draft;
  };

  return {
    async submitRecipeDraft(input) {
      const validation = validateRecipeDefinition(input.recipe);
      if (!validation.isValid) {
        throw new Error("配方草案定义非法: " + String(validation.reason));
      }
      if (input.authorAgentInstanceId === "") {
        throw new Error("草案必须记录作者的具体 agentInstanceId");
      }
      const draft: RecipeDraftRecord = {
        draftIdentifier: "draft-" + String(nextDraftSequence),
        recipe: input.recipe,
        authorAgentInstanceId: input.authorAgentInstanceId,
        sourceProjectIdentifier: input.sourceProjectIdentifier,
        status: "draft",
        validatorAgentInstanceId: null,
        validatedExecutedToolNames: [],
      };
      nextDraftSequence += 1;
      drafts.set(draft.draftIdentifier, draft);
      return { ...draft };
    },

    async recordIndependentValidation(input) {
      const draft = requireDraft(input.draftIdentifier);
      if (input.validatorAgentInstanceId === draft.authorAgentInstanceId) {
        throw new Error(
          "验证者必须是**不同**的 agentInstanceId（作者不能自验）：" +
            input.validatorAgentInstanceId,
        );
      }
      if (!input.isExecutionSuccessful) {
        throw new Error("验证期配方执行失败 ⇒ 不得登记为 validated");
      }
      /**
       * "复用不是只 import"的可执行判定：验证期必须真实经工具网关执行过
       * 配方声明的**全部**工具。只 import 不会产生任何执行记录。
       */
      const declaredToolIds = draft.recipe.usedToolReferences.map(
        (reference) => reference.toolId,
      );
      const executed = new Set(input.executedToolNames);
      const notExecutedToolIds = declaredToolIds.filter(
        (toolId) => !executed.has(toolId),
      );
      if (notExecutedToolIds.length > 0) {
        throw new Error(
          "验证期未执行配方声明的全部工具（复用不是只 import）：" +
            notExecutedToolIds.join(","),
        );
      }
      draft.status = "validated";
      draft.validatorAgentInstanceId = input.validatorAgentInstanceId;
      draft.validatedExecutedToolNames = [...input.executedToolNames];
      return { ...draft };
    },

    async registerAndEnable(input) {
      const draft = requireDraft(input.draftIdentifier);
      if (draft.status !== "validated") {
        throw new Error("只有已独立验证的草案可登记启用（当前状态: " + draft.status + "）");
      }
      if (draft.validatorAgentInstanceId === null) {
        throw new Error("缺少验收者记录，不得登记启用");
      }
      registry.register({
        toolPackageId: input.toolPackageId,
        version: input.version,
        contentHash: input.contentHash,
        schemaVersion: "ASTARRAY_TOOL_PACKAGE_V1",
        packageKind: "recipe",
        readableName: input.toolPackageId,
        purposeSummary: draft.recipe.recipeIdentifier,
        applicableConditions: [],
        sourceProjectIdentifier: draft.sourceProjectIdentifier,
        generatorAgentInstanceId: draft.authorAgentInstanceId,
        acceptorAgentInstanceId: draft.validatorAgentInstanceId,
        evidenceReferences: [],
        supportedActions: draft.recipe.usedToolReferences.map(
          (reference) => reference.toolId,
        ),
        scope: "project",
      });
      registry.enable({
        toolPackageId: input.toolPackageId,
        version: input.version,
        targetProjectIdentifier: draft.sourceProjectIdentifier,
      });
      return {
        toolPackageId: input.toolPackageId,
        version: input.version,
        isEnabledInProject: true,
      };
    },

    listDiscoverableRecipes(input) {
      return registry
        .listDiscoverable({ projectIdentifier: input.projectIdentifier })
        .map((registration) => ({
          toolPackageId: registration.toolPackageId,
          version: registration.version,
        }));
    },

    async executeRegisteredRecipe(input) {
      // 未启用包只能被查看、不能调用（由注册表判定，跨项目不继承）
      const resolved = registry.resolveForExecution({
        toolPackageId: input.toolPackageId,
        version: input.version,
        projectIdentifier: input.projectIdentifier,
      });
      if (resolved === null) {
        return null;
      }
      return input.recipeExecutionEngine.execute({
        recipe: input.recipe,
        input: input.input,
        cancellationSignal: input.cancellationSignal,
      });
    },
  };
}
