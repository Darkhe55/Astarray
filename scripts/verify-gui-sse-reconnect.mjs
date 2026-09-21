#!/usr/bin/env node
/**
 * GUI-01-R-04b 附加校验：**安装产物级** GUI 提交路径与 SSE 首帧/重连契约。
 *
 * 用法：node scripts/verify-gui-sse-reconnect.mjs [<安装后的 dist/cli.js 路径>]
 * 覆盖（全部无需模型）：
 *  1) `GET /` 200 并下发 HttpOnly/SameSite=Strict 的 CSRF cookie；
 *  2) `POST /commands/submit` 无 CSRF → 403 csrf-required（协议级拒绝）；
 *  3) 带 CSRF 提交两次 → 202 受理回执（taskIdentifier + missionIdentifier）；
 *  4) `GET /state` 反映真实提交的任务与任务链；
 *  5) `GET /events` 首帧是完整快照（eventType=snapshot、isReconnect=false）且与 /state 一致；
 *  6) 带 `last-event-id` 重连首帧仍是完整快照（isReconnect=true），任务/任务链不重复；
 *  7) 终止后端口释放。
 * 说明：浏览器 EventSource 自动重连与视觉/键盘/中文/缩放体验仍属人工项（见
 * docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md §4）。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliEntryPath =
  process.argv[2] ?? path.join(repositoryRootDirectory, "dist", "cli.js");
const verificationDirectoryPath = path.join(
  repositoryRootDirectory,
  ".tmp",
  "gui-sse-verify",
  randomUUID(),
);
mkdirSync(verificationDirectoryPath, { recursive: true });

const checkResults = [];
function recordCheck(checkName, isPassed, detail) {
  checkResults.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
}

function httpRequest({ port, requestPath, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, method, headers },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: responseBody,
          });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("HTTP 请求超时")));
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });
}

/** 读取 SSE 首帧后立即断开（模拟页面刷新/重连）。 */
function readFirstSseFrame(port, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/events", headers: { ...extraHeaders } },
      (response) => {
        let bufferedText = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          bufferedText += chunk;
          const frameEndIndex = bufferedText.indexOf("\n\n");
          if (frameEndIndex >= 0) {
            const rawFrame = bufferedText.slice(0, frameEndIndex);
            response.destroy();
            resolve({
              statusCode: response.statusCode,
              contentType: response.headers["content-type"],
              rawFrame,
            });
          }
        });
        response.on("error", () => {});
      },
    );
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("SSE 首帧超时")));
  });
}

function parseSseFrame(rawFrame) {
  const dataLine = rawFrame
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (dataLine === undefined) {
    throw new Error(`SSE 首帧缺少 data 行: ${rawFrame.slice(0, 120)}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}

/**
 * 快照身份一致性：任务/任务链标识与会话字段必须一致。
 * 不断言整份 JSON 全等——mock 任务会在两次请求之间推进状态（status/revision 变化），
 * 首帧仍是"完整快照"，只是内容更新到读取时刻。
 */
function hasSameSnapshotIdentity(leftSnapshot, rightSnapshot) {
  return (
    leftSnapshot.sessionId === rightSnapshot.sessionId &&
    leftSnapshot.mode === rightSnapshot.mode &&
    JSON.stringify(leftSnapshot.tasks.map((task) => task.taskIdentifier).sort()) ===
      JSON.stringify(rightSnapshot.tasks.map((task) => task.taskIdentifier).sort()) &&
    JSON.stringify([...leftSnapshot.missions].sort()) ===
      JSON.stringify([...rightSnapshot.missions].sort())
  );
}

function describeTaskStatuses(snapshot) {
  return snapshot.tasks.map((task) => `${task.taskIdentifier}:${task.status}`).join(",");
}

function readCsrfToken(setCookieHeader) {
  const rawCookie = Array.isArray(setCookieHeader)
    ? setCookieHeader.join("; ")
    : String(setCookieHeader ?? "");
  const matched = rawCookie.match(/gui_csrf=([^;]+)/);
  return matched === null ? null : matched[1];
}

function waitForLoopbackUrl(childProcess, timeoutMilliseconds) {
  return new Promise((resolve, reject) => {
    let stdoutText = "";
    const deadlineMilliseconds = Date.now() + timeoutMilliseconds;
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => {
      stdoutText += chunk;
      const matched = stdoutText.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (matched !== null) {
        resolve(Number.parseInt(matched[1], 10));
      }
    });
    const pollForExit = setInterval(() => {
      if (childProcess.exitCode !== null) {
        clearInterval(pollForExit);
        reject(new Error(`GUI 进程提前退出（code=${childProcess.exitCode}）`));
      } else if (Date.now() > deadlineMilliseconds) {
        clearInterval(pollForExit);
        reject(new Error("等待 GUI loopback URL 超时"));
      }
    }, 100);
  });
}

const guiChildProcess = spawn(
  process.execPath,
  [cliEntryPath, "gui", "--port", "0", "--no-open"],
  { cwd: verificationDirectoryPath, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let guiStderrText = "";
guiChildProcess.stderr.setEncoding("utf8");
guiChildProcess.stderr.on("data", (chunk) => {
  guiStderrText += chunk;
});

let port = null;
try {
  port = await waitForLoopbackUrl(guiChildProcess, 60_000);
  recordCheck("GUI 打印 loopback URL", Number.isInteger(port) && port > 0, `port=${port}`);

  const pageResponse = await httpRequest({ port, requestPath: "/" });
  const csrfToken = readCsrfToken(pageResponse.headers["set-cookie"]);
  recordCheck(
    "GET / 200 且下发 CSRF cookie（HttpOnly + SameSite=Strict）",
    pageResponse.statusCode === 200 &&
      typeof csrfToken === "string" &&
      csrfToken.length > 0 &&
      /HttpOnly/i.test(String(pageResponse.headers["set-cookie"])) &&
      /SameSite=Strict/i.test(String(pageResponse.headers["set-cookie"])),
    `status=${pageResponse.statusCode} hasToken=${typeof csrfToken === "string"}`,
  );

  const submitBody = (prompt, idempotencyKey) =>
    JSON.stringify({ prompt, idempotencyKey });
  const rejectedSubmit = await httpRequest({
    port,
    requestPath: "/commands/submit",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: submitBody("无 CSRF 提交", `sse-verify-no-csrf-${randomUUID()}`),
  });
  recordCheck(
    "无 CSRF 的提交被拒绝（403 csrf-required）",
    rejectedSubmit.statusCode === 403 &&
      JSON.parse(rejectedSubmit.body).error === "csrf-required",
    `status=${rejectedSubmit.statusCode} body=${rejectedSubmit.body.slice(0, 80)}`,
  );

  const firstSubmit = await httpRequest({
    port,
    requestPath: "/commands/submit",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: submitBody("SSE 契约校验任务一", `sse-verify-a-${randomUUID()}`),
  });
  const firstSubmitResult = JSON.parse(firstSubmit.body);
  recordCheck(
    "带 CSRF 提交返回 202 受理回执",
    firstSubmit.statusCode === 202 &&
      typeof firstSubmitResult.taskIdentifier === "string" &&
      typeof firstSubmitResult.missionIdentifier === "string",
    `status=${firstSubmit.statusCode} body=${firstSubmit.body.slice(0, 160)}`,
  );

  const secondSubmit = await httpRequest({
    port,
    requestPath: "/commands/submit",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: submitBody("SSE 契约校验任务二", `sse-verify-b-${randomUUID()}`),
  });
  const secondSubmitResult = JSON.parse(secondSubmit.body);
  recordCheck(
    "第二次提交同样被受理（用于验证快照不重复）",
    secondSubmit.statusCode === 202 &&
      typeof secondSubmitResult.taskIdentifier === "string",
    `status=${secondSubmit.statusCode}`,
  );

  const stateResponse = await httpRequest({ port, requestPath: "/state" });
  const stateSnapshot = JSON.parse(stateResponse.body);
  const submittedTaskIdentifiers = [
    firstSubmitResult.taskIdentifier,
    secondSubmitResult.taskIdentifier,
  ];
  recordCheck(
    "GET /state 反映两次真实提交（tasks 含两条、missions 含对应任务链）",
    stateResponse.statusCode === 200 &&
      submittedTaskIdentifiers.every((taskIdentifier) =>
        stateSnapshot.tasks.some((task) => task.taskIdentifier === taskIdentifier),
      ) &&
      stateSnapshot.missions.includes(firstSubmitResult.missionIdentifier) &&
      stateSnapshot.missions.includes(secondSubmitResult.missionIdentifier),
    JSON.stringify({
      tasks: stateSnapshot.tasks.length,
      missions: stateSnapshot.missions.length,
    }),
  );

  const firstFrame = await readFirstSseFrame(port);
  const firstEvent = parseSseFrame(firstFrame.rawFrame);
  recordCheck(
    "GET /events 返回 text/event-stream 且首帧为完整快照（isReconnect=false）",
    firstFrame.statusCode === 200 &&
      String(firstFrame.contentType).includes("text/event-stream") &&
      firstEvent.eventType === "snapshot" &&
      firstEvent.isReconnect === false &&
      hasSameSnapshotIdentity(firstEvent.snapshot, stateSnapshot),
    JSON.stringify({
      eventType: firstEvent.eventType,
      isReconnect: firstEvent.isReconnect,
      firstFrameStatuses: describeTaskStatuses(firstEvent.snapshot),
      stateStatuses: describeTaskStatuses(stateSnapshot),
    }),
  );

  const reconnectFrame = await readFirstSseFrame(port, {
    "last-event-id": "snapshot-seed",
  });
  const reconnectEvent = parseSseFrame(reconnectFrame.rawFrame);
  recordCheck(
    "重连首帧仍是完整快照（isReconnect=true）且与 /state 一致",
    reconnectEvent.eventType === "snapshot" &&
      reconnectEvent.isReconnect === true &&
      hasSameSnapshotIdentity(reconnectEvent.snapshot, stateSnapshot),
    JSON.stringify({
      eventType: reconnectEvent.eventType,
      isReconnect: reconnectEvent.isReconnect,
      reconnectStatuses: describeTaskStatuses(reconnectEvent.snapshot),
      stateStatuses: describeTaskStatuses(stateSnapshot),
    }),
  );
  recordCheck(
    "重连不产生重复任务/任务链",
    reconnectEvent.snapshot.tasks.length === stateSnapshot.tasks.length &&
      reconnectEvent.snapshot.missions.length === stateSnapshot.missions.length &&
      JSON.stringify(reconnectEvent.snapshot.tasks.map((task) => task.taskIdentifier)) ===
        JSON.stringify(stateSnapshot.tasks.map((task) => task.taskIdentifier)),
    JSON.stringify({
      tasks: reconnectEvent.snapshot.tasks.length,
      missions: reconnectEvent.snapshot.missions.length,
    }),
  );

  // 场景补充：取消命令后快照收敛（公共入口真实调用控制器 → 任务状态变化）
  const cancelResponse = await httpRequest({
    port,
    requestPath: "/commands/cancel",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ taskIdentifier: firstSubmitResult.taskIdentifier }),
  });
  recordCheck(
    "取消命令返回 200 且报 cancelled",
    cancelResponse.statusCode === 200 &&
      JSON.parse(cancelResponse.body).status === "cancelled",
    `status=${cancelResponse.statusCode} body=${cancelResponse.body.slice(0, 120)}`,
  );

  let observedStatusAfterCancel = null;
  const statusDeadlineMilliseconds = Date.now() + 8_000;
  while (Date.now() < statusDeadlineMilliseconds) {
    const latestState = JSON.parse((await httpRequest({ port, requestPath: "/state" })).body);
    const trackedTask = latestState.tasks.find(
      (task) => task.taskIdentifier === firstSubmitResult.taskIdentifier,
    );
    observedStatusAfterCancel = trackedTask === undefined ? null : trackedTask.status;
    if (observedStatusAfterCancel === "cancelled") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  recordCheck(
    "取消后 /state 收敛为 cancelled",
    observedStatusAfterCancel === "cancelled",
    `observed=${observedStatusAfterCancel}`,
  );

  const cancelReconnectFrame = await readFirstSseFrame(port, {
    "last-event-id": "snapshot-after-cancel",
  });
  const cancelReconnectEvent = parseSseFrame(cancelReconnectFrame.rawFrame);
  const cancelledTaskInSnapshot = cancelReconnectEvent.snapshot.tasks.find(
    (task) => task.taskIdentifier === firstSubmitResult.taskIdentifier,
  );
  recordCheck(
    "取消后重连快照同样反映 cancelled",
    cancelledTaskInSnapshot !== undefined &&
      cancelledTaskInSnapshot.status === "cancelled",
    JSON.stringify({
      frameStatus: cancelledTaskInSnapshot === undefined ? null : cancelledTaskInSnapshot.status,
      isReconnect: cancelReconnectEvent.isReconnect,
    }),
  );

  // 场景补充：设置写入（上下文预算）——真实控制器 + 持久化读取收敛 + 陈旧 revision 拒绝
  const settingsBefore = JSON.parse(
    (await httpRequest({ port, requestPath: "/settings" })).body,
  );
  const baselineBudgetRevision = settingsBefore.context.budgetPolicyRevision;
  const baselineMaximumTokens =
    settingsBefore.context.configuredMaximumGlobalContextTokenCount;
  recordCheck(
    "GET /settings 返回上下文预算与 revision",
    typeof baselineBudgetRevision === "number" &&
      typeof baselineMaximumTokens === "number",
    JSON.stringify({ baselineBudgetRevision, baselineMaximumTokens }),
  );

  const updatedMaximumTokens = baselineMaximumTokens + 1234;
  const budgetUpdateResponse = await httpRequest({
    port,
    requestPath: "/commands/set-context-budget",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      expectedRevision: baselineBudgetRevision,
      configuredMaximumGlobalContextTokenCount: updatedMaximumTokens,
    }),
  });
  const budgetUpdateResult = JSON.parse(budgetUpdateResponse.body);
  recordCheck(
    "预算写入成功且 revision 递增",
    budgetUpdateResponse.statusCode === 200 &&
      budgetUpdateResult.context.configuredMaximumGlobalContextTokenCount ===
        updatedMaximumTokens &&
      budgetUpdateResult.context.budgetPolicyRevision === baselineBudgetRevision + 1,
    `status=${budgetUpdateResponse.statusCode} body=${budgetUpdateResponse.body.slice(0, 160)}`,
  );

  const settingsAfter = JSON.parse(
    (await httpRequest({ port, requestPath: "/settings" })).body,
  );
  recordCheck(
    "重新读取 /settings 反映持久化结果（非内存回显）",
    settingsAfter.context.configuredMaximumGlobalContextTokenCount ===
      updatedMaximumTokens &&
      settingsAfter.context.budgetPolicyRevision === baselineBudgetRevision + 1,
    JSON.stringify({
      revision: settingsAfter.context.budgetPolicyRevision,
      tokens: settingsAfter.context.configuredMaximumGlobalContextTokenCount,
    }),
  );

  const staleBudgetResponse = await httpRequest({
    port,
    requestPath: "/commands/set-context-budget",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      expectedRevision: baselineBudgetRevision,
      configuredMaximumGlobalContextTokenCount: updatedMaximumTokens + 999,
    }),
  });
  recordCheck(
    "陈旧 revision 写入被拒绝（409 stale-revision，不静默覆盖）",
    staleBudgetResponse.statusCode === 409 &&
      JSON.parse(staleBudgetResponse.body).error === "stale-revision",
    `status=${staleBudgetResponse.statusCode} body=${staleBudgetResponse.body.slice(0, 100)}`,
  );

  const invalidBudgetResponse = await httpRequest({
    port,
    requestPath: "/commands/set-context-budget",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      expectedRevision: baselineBudgetRevision + 1,
      configuredMaximumGlobalContextTokenCount: -1,
    }),
  });
  recordCheck(
    "非法预算参数被拒绝（400 invalid-arguments）",
    invalidBudgetResponse.statusCode === 400 &&
      JSON.parse(invalidBudgetResponse.body).error === "invalid-arguments",
    `status=${invalidBudgetResponse.statusCode} body=${invalidBudgetResponse.body.slice(0, 100)}`,
  );

  const budgetWithoutCsrfResponse = await httpRequest({
    port,
    requestPath: "/commands/set-context-budget",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: baselineBudgetRevision + 1,
      configuredMaximumGlobalContextTokenCount: updatedMaximumTokens,
    }),
  });
  recordCheck(
    "无 CSRF 的预算写入被拒绝（403 csrf-required）",
    budgetWithoutCsrfResponse.statusCode === 403 &&
      JSON.parse(budgetWithoutCsrfResponse.body).error === "csrf-required",
    `status=${budgetWithoutCsrfResponse.statusCode}`,
  );

  const settingsAfterRejections = JSON.parse(
    (await httpRequest({ port, requestPath: "/settings" })).body,
  );
  recordCheck(
    "被拒绝的写入未改变已持久化的预算",
    settingsAfterRejections.context.configuredMaximumGlobalContextTokenCount ===
      updatedMaximumTokens,
    JSON.stringify({
      tokens: settingsAfterRejections.context.configuredMaximumGlobalContextTokenCount,
    }),
  );
} catch (error) {
  recordCheck(
    "GUI 提交与 SSE 契约校验执行未抛异常",
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  guiChildProcess.kill("SIGKILL");
  await new Promise((resolve) => {
    const killTimer = setTimeout(resolve, 5_000);
    guiChildProcess.on("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
}

if (port !== null) {
  let isPortReleased = false;
  try {
    await httpRequest({ port, requestPath: "/state" });
  } catch (error) {
    isPortReleased = error.code === "ECONNREFUSED" || error.code === "ECONNRESET";
  }
  recordCheck("终止后端口释放", isPortReleased, `port=${port} released=${isPortReleased}`);
}

const failedChecks = checkResults.filter((checkResult) => !checkResult.isPassed);
const summary = {
  cliEntryPath,
  stateDirectory: path.join(verificationDirectoryPath, ".astarray"),
  checkCount: checkResults.length,
  checks: checkResults,
  guiStderrExcerpt: guiStderrText.slice(0, 300),
  isPassed: failedChecks.length === 0,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failedChecks.length > 0) {
  process.stderr.write(
    `GUI 提交与 SSE 契约校验失败：${failedChecks.map((check) => check.checkName).join("; ")}\n`,
  );
  process.exit(1);
}
process.stdout.write("GUI 提交与 SSE 首帧/重连契约校验通过 ✓\n");
