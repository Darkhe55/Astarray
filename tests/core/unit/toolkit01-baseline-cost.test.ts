/**
 * TOOLKIT-01-01/02 反例（2026-10-10）：**隔离 fixture 与基线成本记录**。
 *
 * 卡内检查点 01 要求："核查……选一个**真实重复流程**作**隔离 fixture**，
 * **记录基线成本**"；检查点 02 要求配方链路"证明复用不是只 import"；
 * §2 要求记录"预计复用次数、单次节省、构建/验证/维护成本及不确定性"。
 *
 * 现状缺口：本卡此前**没有任何真实重复流程的基线记录** ⇒ "记录基线成本"无落地，
 * 上一轮的收益判断也只有**手写数字**，没有可复现的实测证据。
 *
 * 本片钉住的语义（**关键：不得伪造精确度**）：
 *  - 同时实测"按步骤手工调用"与"按配方执行"两条路径，**结构计量**（工具调用次数、
 *    入参/出参字节）必须**完全可复现**，属 `measured`；
 *  - 墙上时钟耗时**依赖本机**，必须标注为 `machine-specific`，**不得**当作可移植结论；
 *  - 无法测量的项必须**显式标为未记录**（`not-measured`），**不得**悄悄填 0；
 *  - 配方路径的工具调用次数**必须少于**手工路径（否则"沉淀为配方"没有结构性收益，
 *    应如实报告而非美化）；
 *  - 手工路径的步骤与配方步骤必须**语义等价**（同样的工具、同样的参数），
 *    否则对比不成立 —— 等价性由参数序列逐项核对。
 *
 * 只跑本地隔离临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBenefitEvidenceFromBaseline,
  buildReadListReportFixtureInput,
  buildReadListReportFixtureManualSteps,
  buildReadListReportFixtureRecipe,
  measureBaselineCost,
  READ_LIST_REPORT_FIXTURE_IDENTIFIER,
} from "../../../packages/core/src/toolkit/baseline-cost-measurement.js";
import { evaluateToolBenefit } from "../../../packages/core/src/toolkit/tool-benefit-evaluation.js";
import type { WorkflowRecipeDefinition } from "../../../packages/core/src/toolkit/workflow-recipe-engine.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit-baseline-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * 隔离 fixture 对应的**真实重复流程**：读取源文件 → 列出目录 → 写出报告。
 * 这是仓库里反复出现的小流程（读取+目录+新建），因此适合作为首个 fixture。
 */
const fixtureRecipe: WorkflowRecipeDefinition = {
  recipeIdentifier: "read-list-report",
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

/** 手工路径：逐步调用同样三个工具、同样参数（语义等价）。 */
const fixtureManualSteps = [
  { toolName: "readFile", arguments: { filePath: "sample.txt" } },
  { toolName: "listDirectory", arguments: { directoryPath: "." } },
  {
    toolName: "createProjectFile",
    arguments: { filePath: ".tmp/report.md", content: "# report\n" },
  },
];

function buildRecordingToolPort() {
  const callLog: Array<{ toolName: string; argumentsJson: string }> = [];
  return {
    callLog,
    toolPort: {
      async execute(toolName: string, argumentsJson: string) {
        callLog.push({ toolName, argumentsJson });
        return {
          kind: "success" as const,
          callId: "call-" + String(callLog.length),
          toolName,
          outputText: "output-for:" + toolName,
          isSideEffectFree: true,
        };
      },
    },
  };
}

const fixtureInput = {
  filePath: "sample.txt",
  directoryPath: ".",
  reportPath: ".tmp/report.md",
  reportContent: "# report\n",
};

describe("TOOLKIT-01：基线成本记录（结构计量可复现）", () => {
  it("① 同时实测手工路径与配方路径，结构计量必须完全一致（可复现）", async () => {
    const first = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    const second = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    expect(first.manualPath.toolCallCount).toBe(second.manualPath.toolCallCount);
    expect(first.recipePath.toolCallCount).toBe(second.recipePath.toolCallCount);
    expect(first.manualPath.argumentBytes).toBe(second.manualPath.argumentBytes);
    expect(first.recipePath.argumentBytes).toBe(second.recipePath.argumentBytes);
    // 结构计量的来源必须是 measured
    expect(first.manualPath.structuralMeasurementSource).toBe("measured");
    expect(first.recipePath.structuralMeasurementSource).toBe("measured");
  });

  it("② 墙上时钟耗时必须标注 machine-specific，不得当作可移植结论", async () => {
    const record = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    expect(record.wallClockMeasurementSource).toBe("machine-specific");
    expect(typeof record.manualPath.wallClockMilliseconds).toBe("number");
    expect(typeof record.recipePath.wallClockMilliseconds).toBe("number");
  });

  it("③ 两条路径必须语义等价（同工具、同参数序列），否则明确报告不等价", async () => {
    const equivalent = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    expect(equivalent.arePathsSemanticallyEquivalent).toBe(true);

    // 手工路径少一步 ⇒ 不等价，必须如实报告（不得仍然给出"节省"结论）
    const notEquivalent = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps.slice(0, 2),
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    expect(notEquivalent.arePathsSemanticallyEquivalent).toBe(false);
    expect(notEquivalent.isStructuralSavingUsable).toBe(false);
    expect(String(notEquivalent.reason)).toMatch(/不等价|等价|不可比/);
  });

  it("④ 配方路径的工具调用次数必须少于手工路径，否则如实报告无结构收益", async () => {
    const record = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    // 手工路径每步一次调用（3 次）；配方路径同样 3 步 —— 本 fixture 的收益不在"次数"
    expect(record.manualPath.toolCallCount).toBe(3);
    expect(record.recipePath.toolCallCount).toBe(3);
    /**
     * 关键：本 fixture **没有**调用次数收益，必须如实说"结构性收益为 0/无"，
     * 不得编造"减少 N 次调用"。
     */
    expect(record.savedToolCallCount).toBe(0);
    expect(record.isStructuralSavingReported).toBe(true);
  });

  it("⑤ 无法测量的项必须显式标为未记录，不得悄悄填 0", async () => {
    const record = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    // 本 fixture 未测量"人工判断耗时/维护成本"，必须显式未记录
    expect(record.notMeasuredItems.length).toBeGreaterThan(0);
    expect(record.notMeasuredItems).toContain("人工判断与沟通耗时");
    // 未测量项不得出现在"已测量节省"里被当成 0
    expect(record.measuredSavingMinutes).toBe(0);
    expect(record.measuredSavingMinutesSource).toBe("measured");
  });

  it("⑥ 记录必须给出可复现的入参/出参字节与步骤序列，供人工核对", async () => {
    const record = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    expect(record.manualPath.argumentBytes).toBeGreaterThan(0);
    expect(record.recipePath.argumentBytes).toBeGreaterThan(0);
    expect(record.manualStepSummaries).toHaveLength(3);
    expect(record.recipeStepIdentifiers).toEqual(["step-read", "step-list", "step-write"]);
    // 逐步骤可核对：工具名与参数都要在记录里
    expect(record.manualStepSummaries[0]?.toolName).toBe("readFile");
    expect(String(record.manualStepSummaries[0]?.argumentsJson)).toContain("sample.txt");
  });

  it("⑧ 导出的规范 fixture 必须与测试内联定义**测出同一记录**（避免两套不一致）", async () => {
    const fromExportedFixture = await measureBaselineCost({
      fixtureIdentifier: READ_LIST_REPORT_FIXTURE_IDENTIFIER,
      manualSteps: buildReadListReportFixtureManualSteps(),
      recipe: buildReadListReportFixtureRecipe(),
      recipeInput: buildReadListReportFixtureInput(),
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    const fromInlineFixture = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    // 结构计量与等价性必须完全一致（墙上时钟不比较：它是 machine-specific）
    expect(fromExportedFixture.manualPath.toolCallCount).toBe(
      fromInlineFixture.manualPath.toolCallCount,
    );
    expect(fromExportedFixture.recipePath.toolCallCount).toBe(
      fromInlineFixture.recipePath.toolCallCount,
    );
    expect(fromExportedFixture.manualPath.argumentBytes).toBe(
      fromInlineFixture.manualPath.argumentBytes,
    );
    expect(fromExportedFixture.recipePath.argumentBytes).toBe(
      fromInlineFixture.recipePath.argumentBytes,
    );
    expect(fromExportedFixture.savedToolCallCount).toBe(
      fromInlineFixture.savedToolCallCount,
    );
    expect(fromExportedFixture.arePathsSemanticallyEquivalent).toBe(true);
  });
  it("⑦ 实测记录必须能接到收益判断：未测量项进不确定性说明，且时间来源克制", async () => {
    const record = await measureBaselineCost({
      fixtureIdentifier: "read-list-report",
      manualSteps: fixtureManualSteps,
      recipe: fixtureRecipe,
      recipeInput: fixtureInput,
      toolPort: buildRecordingToolPort().toolPort,
      cancellationSignal: new AbortController().signal,
    });
    const evidence = buildBenefitEvidenceFromBaseline({
      record,
      // 复用次数仍是**预测**（本 harness 无法实测未来复用次数）
      expectedReuseCountRange: { minimum: 30, maximum: 50 },
      /** 单次节省来自实测结构计量（本 fixture 为 0 ⇒ 不得凭空给正数）。 */
      savedMinutesPerUseFromMeasurement: { minimum: 0, maximum: 0 },
      buildCostMinutes: 60,
      verificationCostMinutes: 30,
      maintenanceCostMinutesPerUse: 2,
    });
    // 未测量项必须出现在不确定性说明里（不得被静默丢掉）
    expect(
      evidence.uncertaintyNotes.some((note) => note.includes("人工判断与沟通耗时")),
    ).toBe(true);
    // 墙上时钟是 machine-specific ⇒ 必须作为不确定性被记录
    expect(
      evidence.uncertaintyNotes.some((note) => note.includes("machine-specific")),
    ).toBe(true);

    const outcome = evaluateToolBenefit(evidence);
    // 本 fixture 单次节省实测为 0 ⇒ 下限口径不可能为正，必须不做
    expect(outcome.netSavedMinutes).toBeLessThanOrEqual(0);
    expect(outcome.recommendation).toBe("do-not-adopt");
  });
});
