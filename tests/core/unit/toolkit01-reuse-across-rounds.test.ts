/**
 * TOOLKIT-01-06 反例（2026-10-10）：**更大样本的复用次数与构建成本实测**。
 *
 * 卡内 §2 明文："收益判断**不设机械重复次数门槛**：记录**预计复用次数、单次节省、
 * 构建/验证/维护成本及不确定性**"；§"资源收益"要求"相同 fixture 对比原流程/工具化流程，
 * 报告**工具调用数**、模型请求/token、延迟、失败/返修率及**构建成本**；
 * **无真实 usage 标为未测，不杜撰节省**"。
 *
 * 现状缺口（本轮实测）：`measureBaselineCost()` 只做**单次**结构计量
 * （`savedToolCallCount`），且 `measuredSavingMinutes: 0` + 三项 `notMeasuredItems`。
 * **没有任何"多轮复用"的实测记录** ⇒ 卡内点名的"**更大样本**"没有判定点，
 * `PLAN_STATUS` 只能写"缺更大样本收益实测"。
 *
 * 本片钉住的语义（全部**实测**，不猜）：
 *  - 多轮复用必须**真的执行**相应次数（不得只 import 就宣称复用）；
 *  - 复用总调用数必须 = **单轮实际调用数 × 轮数**（结构性守恒，可核对）；
 *  - **单轮成本不随轮数增长**（否则复用是假的：每轮都退化回手工）；
 *  - 统计**失败轮数**（失败不能算成节省）；
 *  - 构建/验证成本必须作为**一次性成本**与**按轮发生的成本**分开记录；
 *  - 本 harness 无法测量的项（真实 token、人工时间）必须仍在 `notMeasuredItems`，
 *    **不得**因为"轮数大了"就填 0 或编造。
 *
 * 只跑本地纯函数与假工具网关；不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import { measureRecipeReuseAcrossRounds } from "../../../packages/core/src/toolkit/baseline-cost-measurement.js";
import { buildReadListReportFixtureRecipe } from "../../../packages/core/src/toolkit/baseline-cost-measurement.js";

describe("TOOLKIT-01-06：多轮复用实测（更大样本）", () => {
  it("① 多轮复用必须**真的执行**相应次数（不得只 import 就宣称复用）", async () => {
    const reuseOutcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [
        { filePath: "a.txt", directoryPath: "." },
        { filePath: "b.txt", directoryPath: "." },
        { filePath: "c.txt", directoryPath: "." },
      ],
    });
    expect(reuseOutcome.completedRoundCount).toBe(3);
    expect(reuseOutcome.executedToolCallCount).toBeGreaterThan(0);
  });

  it("② 复用总调用数必须 = 单轮调用数 × 轮数（结构性守恒）", async () => {
    const roundInputs = [
      { filePath: "a.txt", directoryPath: "." },
      { filePath: "b.txt", directoryPath: "." },
      { filePath: "c.txt", directoryPath: "." },
      { filePath: "d.txt", directoryPath: "." },
    ];
    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs,
    });
    expect(outcome.executedToolCallCount).toBe(
      outcome.toolCallCountPerRound * outcome.completedRoundCount,
    );
  });

  it("③ **单轮成本不随轮数增长**（否则复用是假的：每轮都退化回手工）", async () => {
    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [
        { filePath: "a.txt", directoryPath: "." },
        { filePath: "b.txt", directoryPath: "." },
      ],
    });
    // 每轮调用数完全一致 ⇒ 标准差为 0
    expect(outcome.perRoundToolCallCounts).toEqual(
      outcome.perRoundToolCallCounts.map(() => outcome.toolCallCountPerRound),
    );
    expect(outcome.isPerRoundCostStable).toBe(true);
  });

  it("④ 失败轮数必须如实统计（失败不得算成节省）", async () => {
    /**
     * 用**注入的失败端口**制造确定性的失败轮（比"故意缺参数"可靠：
     * 缺参数并不必然失败，实测中它仍会成功 —— 我最初的假设是错的）。
     * 第 2 次调用起返回 error ⇒ 第 1 轮成功、第 2 轮失败。
     */
    let callCount = 0;
    const failingPort = {
      async execute(toolName: string, _argumentsJson: string, callId: string) {
        callCount += 1;
        if (callCount > 3) {
          return {
            kind: "error" as const,
            callId,
            errorCode: "probe-injected-failure",
            errorMessage: "注入的失败",
            isIdempotencyConfirmed: false,
          };
        }
        return {
          kind: "success" as const,
          callId,
          outputText: "ok:" + toolName,
          isSideEffectFree: toolName !== "createProjectFile",
        };
      },
    } as unknown as Parameters<typeof measureRecipeReuseAcrossRounds>[0]["toolPort"];

    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [
        { filePath: "a.txt", directoryPath: ".", reportPath: "r.md", reportContent: "x" },
        { filePath: "b.txt", directoryPath: ".", reportPath: "r.md", reportContent: "x" },
      ],
      toolPort: failingPort,
    });
    expect(outcome.failedRoundCount).toBeGreaterThan(0);
    expect(outcome.completedRoundCount + outcome.failedRoundCount).toBe(2);
    expect(outcome.isReuseFullySuccessful).toBe(false);
    // 失败轮**不得**把调用数算进节省统计
    expect(outcome.executedToolCallCount).toBe(
      outcome.perRoundToolCallCounts.reduce((total, count) => total + count, 0),
    );
  });

  it("⑤ 构建/验证成本必须与**按轮成本**分开记录（一次性 vs 重复）", async () => {
    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [
        { filePath: "a.txt", directoryPath: "." },
        { filePath: "b.txt", directoryPath: "." },
      ],
    });
    // 一次性成本：构建与验证（与轮数无关）
    expect(outcome.buildCost.recipeBuildStepCount).toBeGreaterThan(0);
    expect(outcome.buildCost.validationStepCount).toBeGreaterThan(0);
    expect(outcome.buildCost.isOneTimeCost).toBe(true);
    // 按轮成本：每轮的工具调用
    expect(outcome.recurringCost.toolCallCountPerRound).toBe(
      outcome.toolCallCountPerRound,
    );
    expect(outcome.recurringCost.isOneTimeCost).toBe(false);
  });

  it("⑥ 无法测量的项必须**仍标为未测**（不得因轮数大就填 0 或编造）", async () => {
    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [
        { filePath: "a.txt", directoryPath: "." },
        { filePath: "b.txt", directoryPath: "." },
        { filePath: "c.txt", directoryPath: "." },
      ],
    });
    // 真实 token / 人工时间本 harness 测不到 ⇒ 必须显式列出
    expect(outcome.notMeasuredItems.length).toBeGreaterThan(0);
    expect(outcome.notMeasuredItems.join("|")).toMatch(/token|人工|维护/);
    // 节省分钟数仍须为 0（不因样本变大而猜）
    expect(outcome.measuredSavingMinutes).toBe(0);
  });

  it("⑦ 预计复用次数与**实测**次数必须分开（预测不得冒充实测）", async () => {
    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [
        { filePath: "a.txt", directoryPath: "." },
        { filePath: "b.txt", directoryPath: "." },
      ],
      projectedReuseCount: 50,
    });
    expect(outcome.projectedReuseCount).toBe(50);
    expect(outcome.completedRoundCount).toBe(2);
    expect(outcome.completedRoundCount).not.toBe(outcome.projectedReuseCount);
  });

  it("⑧ 空轮次输入 ⇒ 如实报 0 轮（不得伪造复用）", async () => {
    const outcome = await measureRecipeReuseAcrossRounds({
      recipe: buildReadListReportFixtureRecipe(),
      roundInputs: [],
    });
    expect(outcome.completedRoundCount).toBe(0);
    expect(outcome.executedToolCallCount).toBe(0);
    expect(outcome.isReuseFullySuccessful).toBe(false);
  });
});
