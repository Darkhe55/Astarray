/**
 * T09A-R1-04：真实装配事件 → 相同版本稳定复用、变化精准失效、指标可读。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createContextPromptProvider } from "../../../packages/core/src/orchestration/context-prompt-assembler.js";
import { ContextRuntimeEventStore } from "../../../packages/core/src/orchestration/context-runtime-event-store.js";
import { computeContextRuntimeMetrics } from "../../../packages/core/src/orchestration/context-runtime-metrics.js";
import { GlobalDecisionStore } from "../../../packages/core/src/orchestration/global-decision-store.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { executeContextMetricsCommand } from "../../../packages/tui/src/cli/commands.js";

vi.setConfig({ testTimeout: 40_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-metrics-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T09A-R1-04：装配事件与缓存指标", () => {
  it("相同版本命中、revision 变化精准失效，并经 CLI 复算指标", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory: stateDirectory });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "METRICS-DECISION",
      keyRationale: "指标样本",
      appliesToScope: "T-001",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });
    let policy = {
      configuredMaximumGlobalContextTokenCount: 4096,
      globalContextBudgetPolicyRevision: 1,
    };
    const events: unknown[] = [];
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore: new LocalContextGraphStore({ baseDirectory: stateDirectory }),
      maximumGlobalContextTokenCount: 4096,
      budgetPolicyProvider: async () => policy,
      runtimeEventSink: (event) => {
        events.push(event);
        return new ContextRuntimeEventStore({ baseDirectory: stateDirectory }).append(event);
      },
      nowIso: () => "2026-09-10T00:00:00.000Z",
    });
    const input = {
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: { id: "T-001", description: "probe", dependsOn: [], taskType: "data", toolNames: [] } as never,
    };

    await provider(input);
    await provider(input);
    policy = { configuredMaximumGlobalContextTokenCount: 2048, globalContextBudgetPolicyRevision: 2 };
    await provider(input);

    const typed = events as Array<{ cacheStatus: string; invalidationReason: string | null }>;
    expect(typed.map((event) => event.cacheStatus)).toEqual(["miss", "hit", "miss"]);
    expect(typed[2]?.invalidationReason).toBe("budget-policy-revision-change");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const storedEvents = await new ContextRuntimeEventStore({
      baseDirectory: stateDirectory,
    }).readAll();
    const metrics = computeContextRuntimeMetrics({ assemblyEvents: storedEvents });
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.denominators.hitCount).toBe(1);
    expect(metrics.invalidationReasonCounts["budget-policy-revision-change"]).toBe(1);

    const outputs: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    });
    const exitCode = await executeContextMetricsCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(outputs.join("")).toContain("sample: 3");
    expect(outputs.join("")).toContain("provider-cache-usage: unavailable");
  });

  it("产品任务运行会写入真实装配事件（事件存储可读）", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "指标事件探针",
    });
    let status = "accepted";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      status = (await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })).status;
    }
    await application.shutdown();
    expect(status).toBe("done");

    const storedEvents = await new ContextRuntimeEventStore({
      baseDirectory: stateDirectory,
    }).readAll();
    expect(storedEvents.length).toBeGreaterThanOrEqual(1);
    expect(storedEvents[0]).toMatchObject({
      schemaVersion: 1,
      eventType: "context-assembly",
      effectiveBudgetTokens: 4096,
    });
  });
});
