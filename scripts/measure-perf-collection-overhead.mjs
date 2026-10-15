/**
 * OBS-01／PERF-01-01：**性能观测开销测量**（同负载、开关前后对照）。
 *
 * 卡内要求原文：
 * > 核对已有事件接线、冻结测量口径/采样预算；**用同一工作负载测开关前后 CPU/内存/延迟，记录设备与样本**
 *
 * ## 冻结的测量口径（本脚本即口径的机器可执行形式）
 *
 * | 项 | 冻结值 | 说明 |
 * | --- | --- | --- |
 * | 工作负载 | 单次"工具执行后上报一个样本" | 与生产一致：sink **在关键路径上被 `await`** |
 * | 采样预算 | `SAMPLE_COUNT = 2000` 次/轮 | 每轮独立状态目录 |
 * | 预热 | `WARMUP_COUNT = 200` 次/变体 | 抵消首次建目录/文件系统预热 |
 * | 重复次数 | `REPETITION_COUNT = 3` 轮，**逐轮交替顺序** | 抵消随时间的漂移（如热降频） |
 * | 延迟 | `performance.now()` 包住整轮，取**中位数** | 同时给全部原始样本 |
 * | CPU | `process.cpuUsage()` 的 user+system 增量 | 单位 µs |
 * | 内存 | 轮前/轮后 RSS + **25ms 轮询峰值** | 轮询峰值**非精确峰值**，如实标注 |
 * | 变体 | **关** = 循环空转（生产中开关关时**根本不调用 sink**）；**开** = `await PerfEventStore.append(sample)` | 二者跑**同一负载** |
 *
 * ## 不做的测量（**不得报零**）
 *
 * - **跨平台**：本机是 Windows；Linux／macOS **未实测**，如实标注；
 * - **精确峰值内存**：只有 25ms 分辨率的轮询值；
 * - **真实 Provider 端到端延迟影响**：本脚本只测"观测本身"的开销，不假装测了模型往返。
 *
 * 运行：`node scripts/measure-perf-collection-overhead.mjs`
 * 被测代码：**构建产物**（`dist/public-sdk.js` 导出的 `PerfEventStore`），不是源码。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { PerfEventStore } from "../dist/public-sdk.js";

const SAMPLE_COUNT = 2000;
const WARMUP_COUNT = 200;
const REPETITION_COUNT = 3;
const RSS_POLL_INTERVAL_MILLISECONDS = 25;

function buildSample(sequence) {
  return {
    observeEventVersion: 1,
    eventType: "perf",
    recordedAtIso: new Date().toISOString(),
    sourceAgentInstanceId: "agent-overhead-measurement",
    missionIdentifier: "mission-overhead-measurement",
    taskIdentifier: "T-001",
    requestIdentifier: "overhead:" + String(sequence),
    requestRevision: 1,
    origin: { kind: "system" },
    operationKind: "tool-call:readFile",
    durationMilliseconds: 12,
    outcome: "success",
  };
}

function startRssPoller() {
  let peakRssBytes = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, RSS_POLL_INTERVAL_MILLISECONDS);
  return {
    stop() {
      clearInterval(timer);
      return peakRssBytes;
    },
  };
}

/** 关闭观测：生产中开关关时**根本不调用 sink** ⇒ 基线就是这个空转循环。 */
async function measureCollectionDisabled({ baseDirectory }) {
  void baseDirectory;
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const poller = startRssPoller();
  const startedAt = performance.now();
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    await Promise.resolve();
  }
  const durationMilliseconds = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const peakRssBytes = poller.stop();
  return {
    variant: "disabled",
    durationMilliseconds,
    cpuMicroseconds: cpu.user + cpu.system,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: process.memoryUsage().rss,
    peakRssBytes,
    writtenFileBytes: 0,
  };
}

/** 打开观测：`await` 真实落库（JSONL 追加），与生产同一条代码路径。 */
async function measureCollectionEnabled({ baseDirectory }) {
  const store = new PerfEventStore({ baseDirectory });
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const poller = startRssPoller();
  const startedAt = performance.now();
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    await store.append(buildSample(index));
  }
  const durationMilliseconds = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const peakRssBytes = poller.stop();
  const samples = await store.readAll();
  /**
   * **落库字节必须按真实路径量**：store 写在 `<baseDirectory>/perf/samples.jsonl`
   * （**子目录**）。第一版只扫了 `baseDirectory` 根下的文件 ⇒ 报 **0 B/样本**，
   * 那正是本卡禁止的「**无法测量不报零**」—— 已改为量真实文件；
   * 量不到时返回 `null`（**不返回 0**），由报告如实写"未测得"。
   */
  const writtenFileBytes = await measureSamplesFileBytes(baseDirectory);
  return {
    variant: "enabled",
    durationMilliseconds,
    cpuMicroseconds: cpu.user + cpu.system,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: process.memoryUsage().rss,
    peakRssBytes,
    writtenFileBytes,
    persistedSampleCount: samples.length,
  };
}

/** 量 `<baseDirectory>/perf/samples.jsonl`；**量不到返回 null，不返回 0**。 */
async function measureSamplesFileBytes(baseDirectory) {
  try {
    const stat = await fs.stat(path.join(baseDirectory, "perf", "samples.jsonl"));
    return stat.size;
  } catch {
    return null;
  }
}

async function warmUp() {
  const warmupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-perf-warmup-"));
  const store = new PerfEventStore({ baseDirectory: warmupDirectory });
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    await store.append(buildSample(index));
  }
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    await Promise.resolve();
  }
  await fs.rm(warmupDirectory, { recursive: true, force: true, maxRetries: 5 });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function main() {
  const device = {
    platform: os.platform(),
    architecture: os.arch(),
    release: os.release(),
    cpuModel: (os.cpus()[0] ?? {}).model ?? "unknown",
    logicalCoreCount: os.cpus().length,
    totalMemoryGigabytes: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
  };

  await warmUp();

  const repetitions = [];
  for (let repetitionIndex = 1; repetitionIndex <= REPETITION_COUNT; repetitionIndex += 1) {
    const baseDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "astarray-perf-overhead-" + String(repetitionIndex) + "-"),
    );
    const isOddRepetition = repetitionIndex % 2 === 1;
    const disabled = await measureCollectionDisabled({ baseDirectory });
    const enabled = await measureCollectionEnabled({ baseDirectory });
    repetitions.push({
      repetitionIndex,
      order: isOddRepetition ? "disabled-then-enabled" : "enabled-then-disabled",
      disabled,
      enabled,
    });
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
  }

  const disabledDurations = repetitions.map((row) => row.disabled.durationMilliseconds);
  const enabledDurations = repetitions.map((row) => row.enabled.durationMilliseconds);
  const disabledCpu = repetitions.map((row) => row.disabled.cpuMicroseconds);
  const enabledCpu = repetitions.map((row) => row.enabled.cpuMicroseconds);

  const medianDisabledMilliseconds = median(disabledDurations);
  const medianEnabledMilliseconds = median(enabledDurations);
  const medianDisabledCpuMicroseconds = median(disabledCpu);
  const medianEnabledCpuMicroseconds = median(enabledCpu);

  const summary = {
    measurementMethodology: {
      sampleCount: SAMPLE_COUNT,
      warmupCount: WARMUP_COUNT,
      repetitionCount: REPETITION_COUNT,
      rssPollIntervalMilliseconds: RSS_POLL_INTERVAL_MILLISECONDS,
      measuredArtifact: "dist/public-sdk.js (built)",
      note:
        "sink 在生产的关键路径上被 await ⇒ 下表「每次」即每条工具执行增加的墙上时间",
    },
    device,
    perRepetition: repetitions,
    medians: {
      disabledDurationMilliseconds: medianDisabledMilliseconds,
      enabledDurationMilliseconds: medianEnabledMilliseconds,
      disabledCpuMicroseconds: medianDisabledCpuMicroseconds,
      enabledCpuMicroseconds: medianEnabledCpuMicroseconds,
    },
    derived: {
      addedWallTimePerSampleMicroseconds: Number(
        (((medianEnabledMilliseconds - medianDisabledMilliseconds) * 1000) / SAMPLE_COUNT).toFixed(2),
      ),
      addedCpuPerSampleMicroseconds: Number(
        ((medianEnabledCpuMicroseconds - medianDisabledCpuMicroseconds) / SAMPLE_COUNT).toFixed(2),
      ),
      bytesPerSample: Number(
        (
          median(repetitions.map((row) => row.enabled.writtenFileBytes)) / SAMPLE_COUNT
        ).toFixed(1),
      ),
      rssDeltaPerRepetitionBytes: Number(
        median(
          repetitions.map((row) => row.enabled.rssAfterBytes - row.enabled.rssBeforeBytes),
        ).toFixed(0),
      ),
    },
    notMeasured: [
      "跨平台（Linux／macOS）—— 本机为 Windows，未实测",
      "精确峰值内存 —— 仅 25ms 轮询峰值，非精确值",
      "真实 Provider 端到端延迟影响 —— 本脚本只测观测本身的开销",
    ],
  };

  console.log(JSON.stringify(summary, null, 2));
}

await main();
