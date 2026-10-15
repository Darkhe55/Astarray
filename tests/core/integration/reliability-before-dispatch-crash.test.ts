/**
 * RELIABILITY-01 反例（2026-10-10）：**派发前崩溃**（矩阵最后一项未验证时点）。
 *
 * 卡内 §"故障注入矩阵"点名时点："**派发前、已持久化未执行**、执行中……"，
 * 并要求覆盖"父进程退出"，且"禁止用过窄真实计时窗口证明正确"。
 *
 * 现状：矩阵中 `before-dispatch-crash` **如实标为未验证**；既有
 * `reliability-sdk-idempotency.test.ts` ② 的"重启"走的是 **优雅 shutdown**
 * （claim 已结算、missionIdentifier 非空），**并未**覆盖"claim 已落盘但任务尚未创建"
 * 时进程**硬退出**的形态。
 *
 * 本片做**真实跨进程硬杀**注入（不是模拟、不用计时窗口）：
 * 子进程在**派发前**被 `SIGKILL`/`taskkill` 强杀（父进程直接终止子进程），
 * 随后父进程用同一状态目录重新打开应用，检查：
 *  - **同键同参不得被再次执行**（否则就是重复副作用）；
 *  - 既不能假定"已成功"（fail-closed），也要把未结算状态**如实暴露**；
 *  - **异参同键必须继续被拒**（不得因崩溃而放宽冲突检查）。
 *
 * 只跑本地临时目录与真实子进程；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/*
 * 超时预算（2026-10-13，纵深防御）：本文件使用**子进程**，此前**未设置** `testTimeout`
 * ⇒ 沿用 vitest 默认 **5_000ms**。本批文件隔离实测均远低于该值（本文件最慢单例见
 * docs/reports/FEEDBACK_SHUTDOWN_DUPLICATE_5S_2026-10-13.md §12 的实测表），
 * 但满载争用系数实测约 1.4-3x —— 同类文件已因此出现过 `Test timed out in 5000ms`。
 * 故按仓库既有约定显式给预算（另有 30+ 文件同样用 60_000）；**断言一律不放宽**。
 */
vi.setConfig({ testTimeout: 60_000 });


import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-predispatch-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * 子进程：登记一次带幂等键的任务提交，**但在任务被创建前**由父进程强杀。
 *
 * 为了让"派发前"这个相位可复现而**不依赖计时窗口**，子进程通过 **stdin 握手**告知
 * "我即将调用 submitTask"，父进程收到握手的**下一 tick 立即强杀**；
 * 子进程同时把"已进入 submitTask"写入一个标记文件，父进程据此确认相位。
 */
const childProcessScript = `
import { promises as fs, writeSync } from "node:fs";
import path from "node:path";
import { AstarrayApplicationFacade } from __SDK_MODULE_URL__;

const stateDirectory = process.argv[2];
const phaseMarkerPath = process.argv[3];
const ledgerPath = path.join(stateDirectory, "task-idempotency-ledger.json");

const application = await AstarrayApplicationFacade.create({
  stateDirectory,
  mode: "assist",
  statusPollIntervalMilliseconds: 10,
});
application.createSession({ sessionId: "session-crash", mode: "assist" });

// 握手：告诉父进程"我马上要派发了"。
process.stdout.write("READY_TO_DISPATCH\\n");
// 标记文件：证明已进入派发路径（父进程据此确认相位）。
await fs.writeFile(phaseMarkerPath, "entered", "utf8");

// 真实派发（**不 await**）：让它在后台推进到"已认领、尚未返回"。
const dispatchPromise = application.submitTask({
  sessionId: "session-crash",
  taskIdentifier: "task-predispatch",
  prompt: "同一逻辑任务（派发前崩溃）",
  idempotencyKey: "idem-key-predispatch",
});

/**
 * 观测"派发**已开始且未返回**"的本地证据：账目里出现本幂等键的认领记录。
 * 认领是**派发过程中**写入的 ⇒ 看到它即证明已进入派发、且尚未返回。
 */
async function readClaimState() {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const entry = entries.find(
      (candidate) => candidate.idempotencyKey === "idem-key-predispatch",
    );
    if (entry === undefined) {
      return { exists: false, isPendingClaim: false };
    }
    return {
      exists: true,
      isPendingClaim:
        entry.missionIdentifier === null || entry.missionIdentifier === undefined,
    };
  } catch {
    return { exists: false, isPendingClaim: false };
  }
}

const claimDeadlineMilliseconds = Date.now() + 8_000;
let claimState = { exists: false, isPendingClaim: false };
while (Date.now() < claimDeadlineMilliseconds) {
  claimState = await readClaimState();
  if (claimState.exists) break;
  await new Promise((resolve) => setTimeout(resolve, 2));
}

if (claimState.exists) {
  /**
   * **同步**写标记（writeSync）：紧接着就要自终止，异步写可能来不及落盘。
   */
  writeSync(
    1,
    "DISPATCH_CLAIM_OBSERVED pending=" + String(claimState.isPendingClaim) + "\\n",
  );
  /**
   * **在派发中自终止**（硬杀、无任何清理；Windows 上映射为 TerminateProcess）。
   *
   * 2026-11-08（第 81 轮）：这是把注入从"**概率**"改为"**确定性**"的关键 ——
   * 终止时点由**子进程**自己按"已观测到派发认领"决定，
   * **不再依赖父进程事件循环被及时调度**（原实现正是栽在这里）。
   */
  process.kill(process.pid, "SIGKILL");
  // 兜底：确保不再往下执行（正常不会到达）。
  await new Promise(() => {});
}

// 异常路径（30s 内未观测到认领）：走完派发，交父进程裁决（会被有界重试）。
await dispatchPromise;
process.stdout.write("DISPATCH_RETURNED\\n");
`;

interface CrashedChildOutcome {
  wasReadyToDispatch: boolean;
  /** 是否在派发返回前就被杀（即真的是"派发前/派发中"崩溃）。 */
  wasKilledBeforeDispatchReturned: boolean;
  phaseMarkerExists: boolean;
  /**
   * 退出前子进程是否**已观测到派发认领** —— 即崩溃是否**确实落在派发过程中**。
   * （这是确定性注入带来的**新证据**：旧的概率式注入无法证明这一点。）
   */
  claimObservedBeforeExit: boolean;
  /** 观测到认领的**那一刻**是否仍是"已认领但未分配 mission"（仅作诊断，不作断言）。 */
  isPendingClaimAtCrash: boolean;
  /** 为取得该相位实际尝试了几次（1 = 首次即命中）。 */
  attemptCount: number;
}

/**
 * ⚠️ 2026-11-08（第 71 轮）：**相位是"概率事件"，必须当前提来处理（有界重试）**。
 *
 * ## 为什么需要重试（实测）
 *
 * 一次满载全量中 ① 翻红：
 *
 * ```
 * AssertionError: expected false to be true
 *   （wasKilledBeforeDispatchReturned）
 * ```
 *
 * **机制（读代码即明确）**：父进程在 `stdout` 收到 `READY_TO_DISPATCH` 的那个 chunk 里
 * 就地判断 `!stdoutBuffer.includes("DISPATCH_RETURNED")` 然后 `SIGKILL`。
 * 而"杀掉"这一动作**依赖父进程事件循环被及时调度**：
 * 满载下父进程的 `data` 回调可能被推迟，而子进程已经跑完 `submitTask`
 * 并写出 `DISPATCH_RETURNED` ⇒ 判据当场为假（分块合并也会造成同样结果）。
 * 这与本卡修过的 `cli-anthropic-protocol` 是**镜像同类**：那边是"第一块就已满足判据 ⇒
 * 过早 kill"，这边是"一块里已含完成标记 ⇒ 相位判据失效"。
 *
 * ## 为什么"重试"而不是"改判据"
 *
 * **无法**从外部把"派发返回前被杀"做成确定：它本质上取决于父进程被调度的时点，
 * 而父进程无法在 JS 里做到"零延迟中止另一个进程"。**任何把判据放宽的改法
 * （例如不再要求杀在派发返回前、或干脆不打印完成标记）都会让本用例
 * 失去"注入相位是真的"这一意义** —— 那是**削弱**，本仓明确禁止。
 *
 * 故正解是：**把该相位当作"前提"来建立** —— 有界重试（每次清空状态目录，
 * 保证是**全新**的"未使用幂等键"，
 * 否则重试会变成"同键重放"而不再是首次派发），
 * 直到相位真正成立；**若若干次都成立不了，最后一次的真实结果照常交给断言失败**
 * （即"从未成立"不会被掩盖，只是不再被一次调度抖动误报）。
 * 这与本卡既有的"有界等待前提"做法一致（断言不放宽，只让前提确定）。
 */
async function runCrashingChildProcess(): Promise<CrashedChildOutcome> {
  /**
   * ⚠️ **5 次不够 —— 这是实测反证**（2026-11-08 第 72 轮）：
   * 本修复（`e00db17`）上线后跑了 5 轮全量，其中**一轮仍红在 ①**，
   * 报的正是 `AssertionError: expected false to be true`
   * ⇒ **满载下 5 次尝试全部落空**。
   *
   * 机制上说得通：每次尝试**都跑同一场竞速**（父进程 `data` 回调被推迟 vs
   * 子进程跑完 `submitTask`），故重试**并不能提高父进程被及时调度的概率**；
   * 在 CPU 饱和时单次命中率会掉到很低，5 次不足以兜住。
   *
   * 故按证据把上限抬到 **12**（每次约 0.3–1s，最坏约 12s，仍远低于
   * 本文件 `testTimeout: 60_000`）。
   *
   * **✅ 2026-11-08（第 81 轮）：确定性方向已落地，重试降级为兜底。**
   * 注入改为**子进程观测到派发认领后自终止**（见 `childProcessScript` 的说明）
   * ⇒ 终止时点**不再依赖父进程事件循环被及时调度**，
   * 且新增可断言证据 `claimObservedBeforeExit`（证明崩溃**确实落在派发过程中**，
   * 这是旧的概率式注入**无法证明**的）。
   * 有界重试**保留**，但只作为异常路径兜底（例如 30s 内未观测到认领）；`attemptCount` 可核。
   */
  const maximumAttemptCount = 12;
  /**
   * **墙钟上限**（第 81 轮补）：异常路径下若一直落空，也必须**在预算内**以
   * **清晰的断言失败**收场，而不是拖到 `testTimeout` 报含糊的 `Test timed out`。
   * 最坏 ≈ 30s（重试预算）+ 单次尝试（≤ 8s 认领等待 + 余量）< 本文件 60s 预算。
   */
  const retryBudgetMilliseconds = 30_000;
  const retryStartedAtMilliseconds = Date.now();
  let lastOutcome: CrashedChildOutcome | null = null;
  for (let attemptIndex = 1; attemptIndex <= maximumAttemptCount; attemptIndex += 1) {
    const outcome = await runCrashingChildProcessOnce(attemptIndex);
    lastOutcome = outcome;
    if (
      outcome.wasReadyToDispatch &&
      outcome.wasKilledBeforeDispatchReturned &&
      /**
       * 2026-11-08（第 81 轮）：重试条件**收紧** —— 还要求崩溃**确实落在派发过程中**
       * （子进程已观测到派发认领）。仅"被杀在返回前"可能是**还没开始派发**就被杀，
       * 那种情形不再被接受。
       */
      outcome.claimObservedBeforeExit
    ) {
      return outcome;
    }
    // 超出重试预算 ⇒ 立即停手，交由断言给出**清晰失败**（不拖到 testTimeout）
    if (Date.now() - retryStartedAtMilliseconds > retryBudgetMilliseconds) {
      break;
    }
    // 本轮错过相位：清空状态目录，使下一次仍是"全新幂等键的首次派发"
    await fs.rm(stateDirectory, { recursive: true, force: true });
    await fs.mkdir(stateDirectory, { recursive: true });
  }
  return lastOutcome as CrashedChildOutcome;
}

async function runCrashingChildProcessOnce(
  attemptIndex: number,
): Promise<CrashedChildOutcome> {
  const scriptDirectory = path.resolve(".tmp", "predispatch-injection");
  await fs.mkdir(scriptDirectory, { recursive: true });
  const scriptPath = path.join(scriptDirectory, "crash-before-dispatch.mjs");
  const phaseMarkerPath = path.join(scriptDirectory, "phase-marker.txt");
  await fs.rm(phaseMarkerPath, { force: true });
  await fs.writeFile(
    scriptPath,
    childProcessScript.replace(
      "__SDK_MODULE_URL__",
      JSON.stringify(pathToFileURL(path.resolve("dist/public-sdk.js")).href),
    ),
    "utf8",
  );

  return await new Promise<CrashedChildOutcome>((resolve) => {
    const child = spawn(process.execPath, [scriptPath, stateDirectory, phaseMarkerPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdoutBuffer = "";
    let wasReadyToDispatch = false;
    let hasDispatchReturned = false;
    let claimObservedBeforeExit = false;
    let isPendingClaimAtCrash = false;
    let hasFallbackKilled = false;
    /**
     * **兜底强杀**（2026-11-08 第 81 轮）：注入已改为**子进程自终止**，
     * 父进程正常**不再需要**动手；但万一子进程既未自终止、也未走完派发
     * （例如派发持续 30s 以上），必须有兜底，否则用例会挂到 `testTimeout`。
     * 该上限（15s）**远大于**子进程自己的 8s 认领等待 ⇒ 不会提前干预注入。
     */
    const fallbackKillTimer = setTimeout(() => {
      hasFallbackKilled = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      if (!wasReadyToDispatch && stdoutBuffer.includes("READY_TO_DISPATCH")) {
        wasReadyToDispatch = true;
      }
      const claimMarkerMatch =
        /DISPATCH_CLAIM_OBSERVED pending=(true|false)/.exec(stdoutBuffer);
      if (claimMarkerMatch !== null) {
        claimObservedBeforeExit = true;
        isPendingClaimAtCrash = claimMarkerMatch[1] === "true";
      }
      if (stdoutBuffer.includes("DISPATCH_RETURNED")) {
        hasDispatchReturned = true;
      }
    });
    child.on("close", async () => {
      clearTimeout(fallbackKillTimer);
      let isPhaseMarkerPresent: boolean;
      try {
        await fs.access(phaseMarkerPath);
        isPhaseMarkerPresent = true;
      } catch {
        isPhaseMarkerPresent = false;
      }
      resolve({
        wasReadyToDispatch,
        /**
         * 按 **close 时的最终缓冲**判定（旧实现是在第一个 READY 分块里就地判定 ⇒
         * 受 **stdout 分块合并**影响，那正是第 70 轮那个失败的直接机制）。
         * 语义不变：子进程**没有走完派发就消失** ⇒ 崩溃落在"派发返回前"。
         */
        wasKilledBeforeDispatchReturned: !hasDispatchReturned,
        phaseMarkerExists: isPhaseMarkerPresent,
        claimObservedBeforeExit,
        isPendingClaimAtCrash,
        attemptCount: attemptIndex,
      });
    });
    void hasFallbackKilled;
  });
}

/** 读取账目文件里该键的原始记录（不做任何"友好化"处理）。 */
async function readRawLedgerEntry(idempotencyKey: string): Promise<Record<string, unknown> | null> {
  const ledgerPath = path.join(stateDirectory, "task-idempotency-ledger.json");
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as {
      entries?: Array<Record<string, unknown>>;
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return (
      entries.find(
        (entry) => String(entry["idempotencyKey"] ?? "") === idempotencyKey,
      ) ?? null
    );
  } catch {
    return null;
  }
}

async function openApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    statusPollIntervalMilliseconds: 10,
  });
}

describe("RELIABILITY-01：派发前崩溃（真实跨进程硬杀，不用计时窗口）", () => {
  it("① 子进程确实在**派发返回前**被强杀（注入相位成立）", async () => {
    const outcome = await runCrashingChildProcess();
    expect(outcome.wasReadyToDispatch).toBe(true);
    expect(outcome.phaseMarkerExists).toBe(true);
    expect(outcome.wasKilledBeforeDispatchReturned).toBe(true);
    /**
     * 2026-11-08（第 81 轮）**加强**的断言：崩溃必须**确实落在派发过程中** ——
     * 子进程在自终止前已观测到**派发认领**（认领是派发过程中写入的）。
     * 旧的概率式注入只能证明"没走完派发"，**证明不了"已经开始派发"**；
     * 现在这条由确定性注入提供。
     */
    expect(
      outcome.claimObservedBeforeExit,
      "崩溃必须落在派发过程中（子进程应已观测到派发认领）；" +
        "实际 pending=" +
        String(outcome.isPendingClaimAtCrash) +
        "、尝试次数=" +
        String(outcome.attemptCount),
    ).toBe(true);
  });

  it("② 重启后同键同参**不得被再次执行**，且未结算状态必须如实暴露", async () => {
    const crashOutcome = await runCrashingChildProcess();
    expect(crashOutcome.wasKilledBeforeDispatchReturned).toBe(true);

    const rawLedgerEntry = await readRawLedgerEntry("idem-key-predispatch");
    const hasPendingClaim =
      rawLedgerEntry !== null && rawLedgerEntry["missionIdentifier"] === null;

    const application = await openApplication();
    try {
      application.createSession({ sessionId: "session-crash", mode: "assist" });
      let didResubmitExecute = false;
      let rejectionCode: string | null = null;
      let replayedMissionIdentifier: string | null = null;
      try {
        const resubmitted = await application.submitTask({
          sessionId: "session-crash",
          taskIdentifier: "task-predispatch",
          prompt: "同一逻辑任务（派发前崩溃）",
          idempotencyKey: "idem-key-predispatch",
        });
        replayedMissionIdentifier = resubmitted.missionIdentifier;
        didResubmitExecute = true;
      } catch (error) {
        rejectionCode = String(
          (error as { code?: unknown }).code ?? (error as Error).message,
        );
      }

      if (hasPendingClaim) {
        /**
         * 关键不变量：claim 已落盘但未结算 ⇒ **不得再次执行**，
         * 且必须 fail-closed（既不能假定成功，也不能静默重跑）。
         */
        expect(didResubmitExecute).toBe(false);
        expect(String(rejectionCode)).toMatch(/claim-pending|进行中|未重复执行/);
      } else {
        /**
         * 若 claim 尚未落盘（被杀得更早），重试是**允许**的（没有副作用承诺），
         * 但也必须给出明确结果而不是静默什么都不做。
         */
        expect(didResubmitExecute).toBe(true);
        expect(String(replayedMissionIdentifier).length).toBeGreaterThan(0);
      }
    } finally {
      await application.shutdown();
    }
  });

  it("③ 异参同键必须**继续被拒**（崩溃不得放宽冲突检查）", async () => {
    /**
     * 为什么这里**直接构造** pending claim 而不依赖刚才那次硬杀：
     *
     * 硬杀的落点会在"claim 尚未落盘"与"claim 已落盘未结算"之间浮动 ——
     * 前者没有 key 可冲突，于是"异参同键被拒"的断言会**偶发失败**。
     * 卡内明令"禁止用过窄真实计时窗口证明正确"，因此这里改为
     * **确定性地植入**"已持久化未执行"的 claim（也就是崩溃**之后**磁盘上应有的形态），
     * 再验证冲突检查照旧生效。真实硬杀相位由用例 ①② 覆盖。
     */
    await fs.writeFile(
      path.join(stateDirectory, "task-idempotency-ledger.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            sessionIdentifier: "session-crash",
            idempotencyKey: "idem-key-predispatch",
            inputHash: "sha256:" + "a".repeat(64),
            taskIdentifier: "task-predispatch",
            missionIdentifier: null,
            claimedAtIso: "2026-10-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const application = await openApplication();
    try {
      application.createSession({ sessionId: "session-crash", mode: "assist" });
      // 无论 claim 是否结算，异参同键都不得被接受
      await expect(
        application.submitTask({
          sessionId: "session-crash",
          taskIdentifier: "task-predispatch",
          prompt: "完全不同的任务内容",
          idempotencyKey: "idem-key-predispatch",
        }),
      ).rejects.toThrowError(/idempotency-key-conflict|不同参数|拒绝复用/);
    } finally {
      await application.shutdown();
    }
  });

  it("④ 派发前崩溃（claim 未落盘）⇒ 重试**允许**，但必须给出明确结果", async () => {
    const crashOutcome = await runCrashingChildProcess();
    expect(crashOutcome.wasKilledBeforeDispatchReturned).toBe(true);

    const rawLedgerEntry = await readRawLedgerEntry("idem-key-predispatch");
    const hasPendingClaim =
      rawLedgerEntry !== null && rawLedgerEntry["missionIdentifier"] === null;

    const application = await openApplication();
    try {
      application.createSession({ sessionId: "session-crash", mode: "assist" });
      if (hasPendingClaim) {
        // 已 claim 未结算：不得重跑
        await expect(
          application.submitTask({
            sessionId: "session-crash",
            taskIdentifier: "task-predispatch",
            prompt: "同一逻辑任务（派发前崩溃）",
            idempotencyKey: "idem-key-predispatch",
          }),
        ).rejects.toThrowError(/claim-pending|进行中|未重复执行/);
      } else {
        // 完全没有副作用承诺 ⇒ 重试允许，且必须真的执行出结果
        const replayed = await application.submitTask({
          sessionId: "session-crash",
          taskIdentifier: "task-predispatch",
          prompt: "同一逻辑任务（派发前崩溃）",
          idempotencyKey: "idem-key-predispatch",
        });
        expect(String(replayed.missionIdentifier).length).toBeGreaterThan(0);
      }
    } finally {
      await application.shutdown();
    }
  });
});
