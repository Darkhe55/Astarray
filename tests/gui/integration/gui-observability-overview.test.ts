/**
 * SMART-01-04 / OBS 入口补做：GUI 只读「可观测性概览」端点反例。
 *
 * 卡内验收要求四入口（SDK/CLI/TUI/GUI）可用；本节补齐 **GUI** 入口。
 * 纪律：严格只读（GET 不得写盘、不得注入、不得联网）；无法测量时如实标注，不报 0。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";
import { PerfEventStore } from "../../../packages/core/src/orchestration/perf-event-store.js";

let baseDirectory: string;
const servers: Array<{ close: () => Promise<void> }> = [];
const applications: AstarrayApplicationFacade[] = [];

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-obs-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const application of applications.splice(0)) {
    await application.shutdown().catch(() => {});
  }
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function request(input: {
  port: number;
  method: string;
  path: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port: input.port, method: input.method, path: input.path },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => resolve({ statusCode: incoming.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function startServerWithObservability() {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: baseDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 20,
  });
  applications.push(application);
  application.createSession({ sessionId: "session-gui-obs", mode: "assist" });
  const handle = await startGuiServer({
    applicationService: application,
    sessionId: "session-gui-obs",
    mode: "assist",
    csrfTokenFactory: () => "csrf-token-obs",
    observabilityStateDirectory: baseDirectory,
  });
  servers.push(handle);
  return { port: handle.port };
}

describe("GUI 可观测性概览入口", () => {
  it("① 端点可用：返回四类概览（性能/用量/诊断/跨项目），字段齐备", async () => {
    const { port } = await startServerWithObservability();
    const response = await request({ port, method: "GET", path: "/observability" });
    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body) as {
      performance: { metrics: { sampleSize: number } };
      usage: { coverage: { totalEntryCount: number } };
      diagnostics: { isReportable: boolean };
      crossProject: { authorizations: unknown[] };
      isReadOnly: boolean;
    };
    expect(parsed.isReadOnly).toBe(true);
    expect(parsed.performance.metrics.sampleSize).toBe(0);
    expect(parsed.usage.coverage.totalEntryCount).toBe(0);
    expect(parsed.crossProject.authorizations).toEqual([]);
  });

  it("② 无法测量时如实标注（不报 0）：性能不可报告、诊断样本不足", async () => {
    const { port } = await startServerWithObservability();
    const response = await request({ port, method: "GET", path: "/observability" });
    const parsed = JSON.parse(response.body) as {
      performance: {
        metrics: {
          durationMilliseconds: { mean: number | null };
          isReportable: boolean;
          unreportableReason: string | null;
        };
      };
      diagnostics: { isReportable: boolean; unreportableReason: string | null };
    };
    expect(parsed.performance.metrics.isReportable).toBe(false);
    expect(parsed.performance.metrics.durationMilliseconds.mean).toBeNull();
    expect(parsed.performance.metrics.unreportableReason).toContain("样本");
    expect(parsed.diagnostics.isReportable).toBe(false);
    expect(parsed.diagnostics.unreportableReason).toContain("样本不足");
  });

  it("③ 严格只读：GET 之后状态目录文件集合与内容均不变", async () => {
    const perfStore = new PerfEventStore({ baseDirectory });
    await perfStore.append({
      observeEventVersion: 1,
      eventType: "perf",
      recordedAtIso: "2026-10-02T00:00:00.000Z",
      sourceAgentInstanceId: "worker:obs:1",
      missionIdentifier: "mission-obs",
      taskIdentifier: "T-001",
      requestIdentifier: "gui-obs-1",
      requestRevision: 1,
      origin: { kind: "local-estimate" },
      operationKind: "tool-call:readFile",
      durationMilliseconds: 12,
      outcome: "success",
    });
    const { port } = await startServerWithObservability();

    const beforeFiles = (await fs.readdir(baseDirectory, { recursive: true })).sort();
    const beforeSampleFile = await fs.readFile(
      path.join(baseDirectory, "perf", "samples.jsonl"),
      "utf8",
    );
    const response = await request({ port, method: "GET", path: "/observability" });
    expect(response.statusCode).toBe(200);
    const afterFiles = (await fs.readdir(baseDirectory, { recursive: true })).sort();
    const afterSampleFile = await fs.readFile(
      path.join(baseDirectory, "perf", "samples.jsonl"),
      "utf8",
    );
    expect(afterFiles).toEqual(beforeFiles);
    expect(afterSampleFile).toBe(beforeSampleFile);
  });

  it("④ 已落盘样本被真实计入（不是空壳端点）", async () => {
    const perfStore = new PerfEventStore({ baseDirectory });
    await perfStore.append({
      observeEventVersion: 1,
      eventType: "perf",
      recordedAtIso: "2026-10-02T00:00:00.000Z",
      sourceAgentInstanceId: "worker:obs:1",
      missionIdentifier: "mission-obs",
      taskIdentifier: "T-001",
      requestIdentifier: "gui-obs-2",
      requestRevision: 1,
      origin: { kind: "local-estimate" },
      operationKind: "tool-call:readFile",
      durationMilliseconds: 12,
      outcome: "success",
    });
    const { port } = await startServerWithObservability();
    const response = await request({ port, method: "GET", path: "/observability" });
    const parsed = JSON.parse(response.body) as {
      performance: { metrics: { sampleSize: number; isReportable: boolean } };
    };
    expect(parsed.performance.metrics.sampleSize).toBe(1);
    expect(parsed.performance.metrics.isReportable).toBe(true);
  });

  it("⑤ 非 GET 方法不得被接受（只读入口）", async () => {
    const { port } = await startServerWithObservability();
    const response = await request({ port, method: "POST", path: "/observability" });
    // 既有的 CSRF 门禁先于路由生效（403）；若过关则必须落到 405。
    // 两种情况都不得被执行——只读端点不接受非 GET。
    expect([403, 404, 405]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(200);
  });
});
