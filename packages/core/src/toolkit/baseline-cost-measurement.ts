/**
 * TOOLKIT-01-01/02：**隔离 fixture 与基线成本记录**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md`
 * 检查点 01（"选一个**真实重复流程**作**隔离 fixture**，**记录基线成本**"）、
 * 检查点 02 与 §2（"记录预计复用次数、单次节省、构建/验证/维护成本及不确定性"）。
 *
 * 计量纪律（沿用本仓 ADR-0035 的**来源标注**约定，避免伪造精确度）：
 *  - **结构计量**（工具调用次数、入参/出参字节、步骤序列）是**确定性、可复现**的
 *    ⇒ 标为 `measured`，可作为跨机器结论；
 *  - **墙上时钟耗时**依赖本机负载与硬件 ⇒ 标为 `machine-specific`，
 *    **不得**当作可移植结论用于决策；
 *  - 本 harness **无法测量**的项（人工判断与沟通耗时、真实维护成本）
 *    ⇒ 必须进 `notMeasuredItems` **显式标为未记录**，**绝不**悄悄填 0；
 *  - 两条路径若**语义不等价**（工具/参数序列不一致）⇒ 对比不成立，
 *    必须 `isStructuralSavingUsable: false` 并说明原因，**不得**仍给出"节省"结论。
 *
 * 本模块只做**本地确定性判定与计量**：不执行真实文件操作（工具经注入端口执行）、
 * 不联网、不读凭据。
 */

import {
  RecipeExecutionEngine,
  validateRecipeDefinition,
  type WorkflowRecipeDefinition,
} from "./workflow-recipe-engine.js";
import type { ToolBenefitEvidence } from "./tool-benefit-evaluation.js";
import type { ToolPort } from "../core/types.js";

/** 计量来源：确定性可复现 vs 依赖本机。 */
export type MeasurementSourceKind = "measured" | "machine-specific" | "not-measured";

export interface BaselineManualStep {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface BaselinePathMeasurement {
  toolCallCount: number;
  argumentBytes: number;
  outputBytes: number;
  wallClockMilliseconds: number;
  /** 结构计量（次数/字节）的来源。 */
  structuralMeasurementSource: MeasurementSourceKind;
}

export interface BaselineCostRecord {
  fixtureIdentifier: string;
  manualPath: BaselinePathMeasurement;
  recipePath: BaselinePathMeasurement;
  /** 墙上时钟计量的来源（恒为 `machine-specific`）。 */
  wallClockMeasurementSource: MeasurementSourceKind;
  /** 两条路径是否语义等价（同工具、同参数序列）。 */
  arePathsSemanticallyEquivalent: boolean;
  /** 不等价时对比不成立 ⇒ 结构收益不可用。 */
  isStructuralSavingUsable: boolean;
  /** 保存的工具调用次数（手工 − 配方）；可为 0 或负数（如实报告）。 */
  savedToolCallCount: number;
  /** 是否**如实报告**了结构性收益（含"无收益"）。 */
  isStructuralSavingReported: boolean;
  /** 已**实测**的节省分钟数（本 harness 只测结构，故为 0）。 */
  measuredSavingMinutes: number;
  /** 实测节省的来源（恒为 `measured`）。 */
  measuredSavingMinutesSource: MeasurementSourceKind;
  /** 本 harness **未测量**的项（必须显式列出，不得填 0 冒充）。 */
  notMeasuredItems: string[];
  manualStepSummaries: Array<{ toolName: string; argumentsJson: string }>;
  recipeStepIdentifiers: string[];
  reason: string | null;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** 把参数对象规范化为确定性 JSON（键序稳定），使字节计量可复现。 */
function stableArgumentsJson(argumentsValue: Record<string, unknown>): string {
  const sortedKeys = Object.keys(argumentsValue).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = argumentsValue[key];
  }
  return JSON.stringify(sorted);
}

/** 手工路径：逐步经注入端口调用（与配方路径用**同一个**端口口径）。 */
async function measureManualPath(input: {
  manualSteps: BaselineManualStep[];
  toolPort: ToolPort;
  signal: AbortSignal;
}): Promise<{
  measurement: BaselinePathMeasurement;
  stepSummaries: Array<{ toolName: string; argumentsJson: string }>;
}> {
  let argumentBytes = 0;
  let outputBytes = 0;
  const stepSummaries: Array<{ toolName: string; argumentsJson: string }> = [];
  const startedAtMilliseconds = Date.now();
  for (let index = 0; index < input.manualSteps.length; index += 1) {
    const step = input.manualSteps[index] as BaselineManualStep;
    const argumentsJson = stableArgumentsJson(step.arguments);
    argumentBytes += utf8ByteLength(argumentsJson);
    stepSummaries.push({ toolName: step.toolName, argumentsJson });
    const result = await input.toolPort.execute(
      step.toolName,
      argumentsJson,
      "manual-" + String(index + 1),
      input.signal,
    );
    outputBytes +=
      result.kind === "success" && typeof result.outputText === "string"
        ? utf8ByteLength(result.outputText)
        : 0;
  }
  return {
    measurement: {
      toolCallCount: input.manualSteps.length,
      argumentBytes,
      outputBytes,
      wallClockMilliseconds: Date.now() - startedAtMilliseconds,
      structuralMeasurementSource: "measured",
    },
    stepSummaries,
  };
}

/** 配方路径：经配方执行引擎（同样走注入端口）。 */
async function measureRecipePath(input: {
  recipe: WorkflowRecipeDefinition;
  recipeInput: Record<string, unknown>;
  toolPort: ToolPort;
  signal: AbortSignal;
}): Promise<BaselinePathMeasurement> {
  const engine = new RecipeExecutionEngine({ toolPort: input.toolPort });
  const startedAtMilliseconds = Date.now();
  const outcome = await engine.execute({
    recipe: input.recipe,
    input: input.recipeInput,
    cancellationSignal: input.signal,
  });
  const wallClockMilliseconds = Date.now() - startedAtMilliseconds;
  let argumentBytes = 0;
  let outputBytes = 0;
  for (const receipt of outcome.stepReceipts) {
    argumentBytes += utf8ByteLength(receipt.argumentsJson);
    if (typeof receipt.outputText === "string") {
      outputBytes += utf8ByteLength(receipt.outputText);
    }
  }
  return {
    toolCallCount: outcome.stepReceipts.length,
    argumentBytes,
    outputBytes,
    wallClockMilliseconds,
    structuralMeasurementSource: "measured",
  };
}

/**
 * 实测基线成本：同一隔离 fixture 下,分别跑"手工步骤"与"配方"两条路径。
 *
 * 注意：**不等价即不可比** —— 若两条路径的工具/参数序列不一致，
 * 本函数不会给出任何"节省"结论（`isStructuralSavingUsable: false`）。
 */
export async function measureBaselineCost(input: {
  fixtureIdentifier: string;
  manualSteps: BaselineManualStep[];
  recipe: WorkflowRecipeDefinition;
  recipeInput: Record<string, unknown>;
  toolPort: ToolPort;
  cancellationSignal: AbortSignal;
}): Promise<BaselineCostRecord> {
  const manual = await measureManualPath({
    manualSteps: input.manualSteps,
    toolPort: input.toolPort,
    signal: input.cancellationSignal,
  });
  const recipePath = await measureRecipePath({
    recipe: input.recipe,
    recipeInput: input.recipeInput,
    toolPort: input.toolPort,
    signal: input.cancellationSignal,
  });

  /**
   * 语义等价判定：把配方步骤解析为"工具 + 实际参数 JSON"，
   * 与手工步骤逐项比较（顺序一致）。只有等价才能谈"节省"。
   */
  const recipeStepArguments = input.recipe.steps.map((step) => {
    const resolved: Record<string, unknown> = {};
    for (const [parameterName, mappingValue] of Object.entries(step.argumentMapping)) {
      if (mappingValue.startsWith("$input.")) {
        const inputName = mappingValue.slice("$input.".length);
        resolved[parameterName] = input.recipeInput[inputName];
        continue;
      }
      resolved[parameterName] = mappingValue;
    }
    return { toolName: step.toolName, argumentsJson: stableArgumentsJson(resolved) };
  });
  const arePathsSemanticallyEquivalent =
    recipeStepArguments.length === manual.stepSummaries.length &&
    recipeStepArguments.every((recipeStep, index) => {
      const manualStep = manual.stepSummaries[index];
      return (
        manualStep !== undefined &&
        manualStep.toolName === recipeStep.toolName &&
        manualStep.argumentsJson === recipeStep.argumentsJson
      );
    });

  const savedToolCallCount =
    manual.measurement.toolCallCount - recipePath.toolCallCount;

  return {
    fixtureIdentifier: input.fixtureIdentifier,
    manualPath: manual.measurement,
    recipePath,
    wallClockMeasurementSource: "machine-specific",
    arePathsSemanticallyEquivalent,
    isStructuralSavingUsable: arePathsSemanticallyEquivalent,
    savedToolCallCount: arePathsSemanticallyEquivalent ? savedToolCallCount : 0,
    isStructuralSavingReported: true,
    /** 本 harness 只测结构计量，不测人工时间 ⇒ 实测节省为 0（不得猜）。 */
    measuredSavingMinutes: 0,
    measuredSavingMinutesSource: "measured",
    /**
     * **未测量项**：卡内 §2 要求记录不确定性；这些项本 harness 无法测量，
     * 必须显式列出（**不得填 0 冒充已测量**）。
     */
    notMeasuredItems: [
      "人工判断与沟通耗时",
      "真实维护成本（跨版本升级投入）",
      "跨机器/跨平台的耗时可比性",
    ],
    manualStepSummaries: manual.stepSummaries,
    recipeStepIdentifiers: input.recipe.steps.map((step) => step.stepIdentifier),
    reason: arePathsSemanticallyEquivalent
      ? null
      : "两条路径不等价（工具或参数序列不一致）⇒ 对比不成立，结构收益不可用",
  };
}

/**
 * 把**实测基线记录**装配为收益判断证据（TOOLKIT-01 §2 的落地闭环）。
 *
 * 为什么需要这一层：上一轮的收益判断吃的是**手写数字**；本函数把
 * "**实测到的**结构计量"与"**预测/估算的**项目"分开：
 *  - 单次节省由调用方按**实测结构收益**给出（本 harness 不测人工时间，
 *    因此通常为 0 —— 本项目宁可判"不做"也不凭空给正数）；
 *  - 复用次数是**预测**（未来事件无法实测），仍按区间记录；
 *  - 记录里的 `notMeasuredItems` 与 `machine-specific` 墙上时钟口径
 *    **必须**进入不确定性说明，避免被静默丢掉后当成确定结论。
 */
export function buildBenefitEvidenceFromBaseline(input: {
  record: BaselineCostRecord;
  expectedReuseCountRange: { minimum: number; maximum: number };
  savedMinutesPerUseFromMeasurement: { minimum: number; maximum: number };
  buildCostMinutes: number;
  verificationCostMinutes: number;
  maintenanceCostMinutesPerUse: number;
}): ToolBenefitEvidence {
  const uncertaintyNotes: string[] = [];
  for (const notMeasuredItem of input.record.notMeasuredItems) {
    uncertaintyNotes.push("未测量：" + notMeasuredItem);
  }
  uncertaintyNotes.push(
    "墙上时钟耗时口径为 machine-specific（依赖本机），不得作为跨机器结论",
  );
  if (input.record.savedToolCallCount === 0) {
    uncertaintyNotes.push(
      "本 fixture 的工具调用次数无结构收益（手工与配方同为 " +
        String(input.record.manualPath.toolCallCount) +
        " 次）",
    );
  }
  if (!input.record.arePathsSemanticallyEquivalent) {
    uncertaintyNotes.push(
      "两条路径不等价 ⇒ 基线对比不成立，单次节省不可采信",
    );
  }
  return {
    candidateIdentifier: input.record.fixtureIdentifier,
    discoverySource: "user-request",
    expectedReuseCountRange: input.expectedReuseCountRange,
    savedMinutesPerUse: input.savedMinutesPerUseFromMeasurement,
    buildCostMinutes: input.buildCostMinutes,
    verificationCostMinutes: input.verificationCostMinutes,
    maintenanceCostMinutesPerUse: input.maintenanceCostMinutesPerUse,
    uncertaintyNotes,
    agentPriorityTier: 1,
  };
}
/**
 * 首个**隔离 fixture**：本仓反复出现的"读取源文件 → 列出目录 → 写出报告"小流程。
 *
 * 为什么选它：该流程在真实任务里反复出现，且只用到**已授权的基础只读+新建工具**，
 * 因此适合作为 TOOLKIT-01-01 要求的"真实重复流程"样本。
 *
 * 注意（**不美化**）：本 fixture 的手工路径与配方路径**工具调用次数相同**（均为 3 次），
 * 即"沉淀为配方"在此流程上**没有调用次数上的结构收益**；
 * 其价值在于**步骤序列被固定下来**（可复用、可独立验证），而不是减少调用。
 * 该结论由 `measureBaselineCost` 如实报告（`savedToolCallCount: 0`）。
 */
export const READ_LIST_REPORT_FIXTURE_IDENTIFIER = "read-list-report";

export function buildReadListReportFixtureRecipe(): WorkflowRecipeDefinition {
  return {
    recipeIdentifier: READ_LIST_REPORT_FIXTURE_IDENTIFIER,
    version: 1,
    declaredInputNames: ["filePath", "directoryPath", "reportPath", "reportContent"],
    usedToolReferences: [
      { toolId: "readFile", toolRevision: 1 },
      { toolId: "listDirectory", toolRevision: 1 },
      { toolId: "createProjectFile", toolRevision: 1 },
    ],
    steps: [
      {
        stepIdentifier: "step-read",
        toolName: "readFile",
        dependsOnStepIdentifiers: [],
        argumentMapping: { filePath: "$input.filePath" },
      },
      {
        stepIdentifier: "step-list",
        toolName: "listDirectory",
        dependsOnStepIdentifiers: ["step-read"],
        argumentMapping: { directoryPath: "$input.directoryPath" },
      },
      {
        stepIdentifier: "step-write",
        toolName: "createProjectFile",
        dependsOnStepIdentifiers: ["step-list"],
        argumentMapping: {
          filePath: "$input.reportPath",
          content: "$input.reportContent",
        },
      },
    ],
  };
}

export function buildReadListReportFixtureManualSteps(): BaselineManualStep[] {
  return [
    { toolName: "readFile", arguments: { filePath: "sample.txt" } },
    { toolName: "listDirectory", arguments: { directoryPath: "." } },
    {
      toolName: "createProjectFile",
      arguments: { filePath: ".tmp/report.md", content: "# report\n" },
    },
  ];
}

export function buildReadListReportFixtureInput(): Record<string, unknown> {
  return {
    filePath: "sample.txt",
    directoryPath: ".",
    reportPath: ".tmp/report.md",
    reportContent: "# report\n",
  };
}
/* ────────── TOOLKIT-01-06：**更大样本**的多轮复用实测 ────────── */

/** 单轮执行结果（供多轮统计）。 */
interface ReuseRoundOutcome {
  isSuccessful: boolean;
  toolCallCount: number;
}

export interface RecipeReuseAcrossRoundsOutcome {
  recipeIdentifier: string;
  /** **实测**完成的轮数（真的执行成功）。 */
  completedRoundCount: number;
  /** **实测**失败的轮数（失败不得算成节省）。 */
  failedRoundCount: number;
  /** 每轮的工具调用数（逐轮实测值，供核对"单轮成本是否增长"）。 */
  perRoundToolCallCounts: number[];
  /** 单轮工具调用数（各轮一致时即该值；不一致时取**最大**值，保守）。 */
  toolCallCountPerRound: number;
  /** 全部轮次累计的工具调用数。 */
  executedToolCallCount: number;
  /** 单轮成本是否**不随轮数增长**（false ⇒ 复用是假的）。 */
  isPerRoundCostStable: boolean;
  isReuseFullySuccessful: boolean;
  /** **一次性**成本（构建配方 + 定义验证），与轮数无关。 */
  buildCost: {
    recipeBuildStepCount: number;
    validationStepCount: number;
    isOneTimeCost: true;
  };
  /** **按轮发生**的成本。 */
  recurringCost: {
    toolCallCountPerRound: number;
    isOneTimeCost: false;
  };
  /**
   * **预测**的复用次数（用户/Agent 的估计）。
   *
   * 与 `completedRoundCount`（**实测**）**分开**：卡内要求记录不确定性，
   * 预测**不得**冒充实测。
   */
  projectedReuseCount: number | null;
  /**
   * 本 harness 实测节省分钟数。
   *
   * **恒为 0**：本 harness 只测**结构计量**，不测人工时间；
   * 卡内"无真实 usage 标为未测，**不杜撰节省**"。
   */
  measuredSavingMinutes: 0;
  /** **未测量项**（不得因样本变大就填 0 冒充已测）。 */
  notMeasuredItems: string[];
}

/**
 * 用**同一配方**跑多轮**不同输入**，实测复用次数与成本结构（TOOLKIT-01-06）。
 *
 * 为什么需要它：`measureBaselineCost()` 只做**单次**结构计量 ⇒ 卡内点名的
 * "**更大样本**"没有判定点。本函数把"复用"从**声称**变成**可核对的数据**：
 *  - 每轮都真的执行配方（不是只 import）；
 *  - 总调用数必须等于"单轮调用数 × 轮数"（结构性守恒）；
 *  - 逐轮调用数一并返回 ⇒ 可核对"单轮成本不随轮数增长"；
 *  - 失败轮单独计数 ⇒ 失败**不得**算成节省。
 *
 * 工具执行经**注入的** `ToolPort`（默认使用确定性内存端口），
 * 不引入新的执行通道、不联网、不读凭据。
 */
export async function measureRecipeReuseAcrossRounds(input: {
  recipe: WorkflowRecipeDefinition;
  roundInputs: Array<Record<string, unknown>>;
  /** 预测复用次数（可选）；与实测轮数**分开**记录。 */
  projectedReuseCount?: number;
  /** 可注入的受控工具端口（缺省用确定性内存端口）。 */
  toolPort?: ToolPort;
}): Promise<RecipeReuseAcrossRoundsOutcome> {
  /** 一次性成本之一：**定义验证**（与轮数无关）。 */
  const validation = validateRecipeDefinition(input.recipe);
  if (!validation.isValid) {
    throw new Error("配方定义非法: " + String(validation.reason));
  }
  const toolPort = input.toolPort ?? buildDeterministicInMemoryToolPort();
  const engine = new RecipeExecutionEngine({ toolPort });

  const roundOutcomes: ReuseRoundOutcome[] = [];
  for (const roundInput of input.roundInputs) {
    const controller = new AbortController();
    try {
      const outcome = await engine.execute({
        recipe: input.recipe,
        input: roundInput,
        cancellationSignal: controller.signal,
      });
      roundOutcomes.push({
        isSuccessful: outcome.isSuccessful,
        toolCallCount: outcome.stepReceipts.length,
      });
    } catch {
      /** 单轮异常**不得**中断整批统计：如实计入失败轮。 */
      roundOutcomes.push({ isSuccessful: false, toolCallCount: 0 });
    }
  }

  const successfulRounds = roundOutcomes.filter((round) => round.isSuccessful);
  const completedRoundCount = successfulRounds.length;
  const failedRoundCount = roundOutcomes.length - completedRoundCount;
  const perRoundToolCallCounts = successfulRounds.map((round) => round.toolCallCount);
  /**
   * 单轮成本取**最大**值（保守）：若某轮调用数偏高，不应被平均值掩盖
   * （卡内要求记录**不确定性**，不是取好看的数字）。
   */
  const toolCallCountPerRound =
    perRoundToolCallCounts.length === 0
      ? 0
      : Math.max(...perRoundToolCallCounts);
  const executedToolCallCount = perRoundToolCallCounts.reduce(
    (total, count) => total + count,
    0,
  );
  const isPerRoundCostStable =
    perRoundToolCallCounts.length > 0 &&
    perRoundToolCallCounts.every((count) => count === toolCallCountPerRound);

  return {
    recipeIdentifier: input.recipe.recipeIdentifier,
    completedRoundCount,
    failedRoundCount,
    perRoundToolCallCounts,
    toolCallCountPerRound,
    executedToolCallCount,
    isPerRoundCostStable,
    isReuseFullySuccessful: failedRoundCount === 0 && completedRoundCount > 0,
    buildCost: {
      recipeBuildStepCount: input.recipe.steps.length,
      validationStepCount: 1,
      isOneTimeCost: true,
    },
    recurringCost: {
      toolCallCountPerRound,
      isOneTimeCost: false,
    },
    projectedReuseCount: input.projectedReuseCount ?? null,
    measuredSavingMinutes: 0,
    notMeasuredItems: [
      "真实 token / 模型请求消耗（无真实 usage 数据）",
      "人工判断与沟通耗时",
      "真实维护成本（跨版本升级投入）",
      "跨机器/跨平台的耗时可比性",
    ],
  };
}

/**
 * 确定性**内存**工具端口（仅供结构计量使用）。
 *
 * 为什么不复用生产 PolicyWrapper：收益的**结构计量**只关心"调了几次、顺序如何"，
 * 用真实文件系统会让计量随机器/磁盘状态漂移。生产装配路径由
 * `toolkit01-workflow-recipe-engine.test.ts` 单独覆盖（使用真实 PolicyWrapper）。
 */
function buildDeterministicInMemoryToolPort(): ToolPort {
  return {
    async execute(toolName, _argumentsJson, callId) {
      return {
        kind: "success",
        callId,
        outputText: "deterministic-output:" + toolName,
        isSideEffectFree: toolName !== "createProjectFile",
      };
    },
  };
}