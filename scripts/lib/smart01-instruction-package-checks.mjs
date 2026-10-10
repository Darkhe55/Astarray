/**
 * SMART-01-04 **包级验收判定逻辑**（纯函数，2026-10-10）。
 *
 * 为什么单独成模块（沿用本仓既有教训）：`scripts/lib/t07d-r2-04-acceptance-decision.mjs`
 * 的诞生就是因为内联判定曾导致"零判据通过"。包级验收的判据必须是**可测试的不变量**，
 * 且**缺省即失败**（fail-closed），不得因"没观测到"而跳过。
 *
 * 判据（对应卡内 SMART-01-04 验收）：
 *  ① 上限 3：第 4 条必须 `queued`（不是 `admitted`、更不是丢弃），且容量确为 3；
 *  ② 列表：窗口内 3 条 + 排队 1 条，且窗口内不得出现 `completed`（本流程未完成任何指令）；
 *  ③ 期限内：不得报超期、`isWorkCompleted=false`；
 *  ④ 超期：必须 `overdue-not-dispatched` 且 `isTruthfulTimeout=true`、`isWorkCompleted=false`
 *    （"超期如实报超时、不伪报已派发/完成"）；
 *  ⑤ 未知幂等键：必须**非 0 退出码**（响亮失败，不伪造指令）。
 *
 * 输入是**已捕获的观测**（退出码 + stdout 文本），因此本模块不接触进程与文件系统，可单测。
 */

/** 解析首个完整 JSON 对象（多行 `--json` 输出；配平大括号并忽略字符串内括号）。 */
export function parseJsonObjectFromOutput(stdoutText) {
  if (typeof stdoutText !== "string") {
    return null;
  }
  const startIndex = stdoutText.indexOf("{");
  if (startIndex < 0) {
    return null;
  }
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;
  let endIndex = -1;
  for (let index = startIndex; index < stdoutText.length; index += 1) {
    const character = stdoutText[index];
    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === '"') {
        isInsideString = false;
      }
      continue;
    }
    if (character === '"') {
      isInsideString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
    }
  }
  if (endIndex < 0) {
    return null;
  }
  try {
    return JSON.parse(stdoutText.slice(startIndex, endIndex + 1));
  } catch {
    return null;
  }
}

function readNumber(record, key) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 生成包级验收判据清单。**任何观测缺失都产生失败项**（不跳过），
 * 因此调用方只要检查 `checks.every(c => c.passed)` 即可，不存在"零判据通过"。
 */
export function buildInstructionPackageChecks(observation) {
  const checks = [];
  const record = (name, passed, detail) => checks.push({ name, passed, detail });

  // ① 单条准入
  const admit = parseJsonObjectFromOutput(observation?.admitResult?.stdoutText);
  const isAdmitExitOk = observation?.admitResult?.exitCode === 0;
  record(
    "入口：instruction accept --json（单条准入）",
    isAdmitExitOk &&
      admit !== null &&
      admit["admissionOutcome"] === "admitted" &&
      readNumber(admit, "windowCapacity") === 3,
    `exit=${String(observation?.admitResult?.exitCode)} outcome=${String(admit?.["admissionOutcome"])} capacity=${String(admit?.["windowCapacity"])}`,
  );

  // ② 上限 3：第 4 条必须排队
  const fourth = parseJsonObjectFromOutput(observation?.fourthAdmit?.stdoutText);
  const isFourthExitOk = observation?.fourthAdmit?.exitCode === 0;
  const fourthCapacity = readNumber(fourth, "windowCapacity");
  const fourthActiveCount = readNumber(fourth, "activeInstructionCount");
  const fourthQueuedCount = readNumber(fourth, "queuedInstructionCount");
  record(
    "上限 3：第 4 条必须排队（queued，不丢弃、不超容）",
    isFourthExitOk &&
      fourth !== null &&
      fourth["admissionOutcome"] === "queued" &&
      fourthCapacity === 3 &&
      fourthActiveCount === 3 &&
      fourthQueuedCount === 1,
    `exit=${String(observation?.fourthAdmit?.exitCode)} outcome=${String(fourth?.["admissionOutcome"])} active=${String(fourthActiveCount)} queued=${String(fourthQueuedCount)}`,
  );

  // ③ 列表：窗口内 3 + 排队 1；窗口内不得出现 completed（本流程未完成任何指令）
  const listRecord = parseJsonObjectFromOutput(observation?.listResult?.stdoutText);
  const activeInstructions = Array.isArray(listRecord?.["activeInstructions"])
    ? listRecord["activeInstructions"]
    : null;
  const queuedInstructions = Array.isArray(listRecord?.["queuedInstructions"])
    ? listRecord["queuedInstructions"]
    : null;
  const isListExitOk = observation?.listResult?.exitCode === 0;
  record(
    "入口：instruction list --json（窗口内 3 + 排队 1）",
    isListExitOk &&
      listRecord !== null &&
      activeInstructions !== null &&
      activeInstructions.length === 3 &&
      queuedInstructions !== null &&
      queuedInstructions.length === 1,
    `exit=${String(observation?.listResult?.exitCode)} active=${String(activeInstructions?.length)} queued=${String(queuedInstructions?.length)}`,
  );
  record(
    "列表：窗口内指令不得被标为 completed（未发生成果完成）",
    activeInstructions !== null &&
      activeInstructions.every((instruction) => instruction?.["state"] !== "completed"),
    activeInstructions === null
      ? "缺少 activeInstructions（fail-closed）"
      : "states=" + activeInstructions.map((instruction) => String(instruction?.["state"])).join(","),
  );

  // ④ 期限内：不得报超期
  const withinDeadline = parseJsonObjectFromOutput(observation?.withinDeadline?.stdoutText);
  record(
    "期限：未到三分钟不得报超期（且不得标为成果完成）",
    observation?.withinDeadline?.exitCode === 0 &&
      withinDeadline !== null &&
      withinDeadline["kind"] !== "overdue-not-dispatched" &&
      withinDeadline["isTruthfulTimeout"] === false &&
      withinDeadline["isWorkCompleted"] === false,
    `exit=${String(observation?.withinDeadline?.exitCode)} kind=${String(withinDeadline?.["kind"])}`,
  );

  // ⑤ 超期：必须如实报超时，且不得伪报已派发/完成
  const overdue = parseJsonObjectFromOutput(observation?.overdueDeadline?.stdoutText);
  record(
    "指定到期输入：超过三分钟必须如实报超时（overdue + isTruthfulTimeout=true，且 isWorkCompleted=false）",
    observation?.overdueDeadline?.exitCode === 0 &&
      overdue !== null &&
      overdue["kind"] === "overdue-not-dispatched" &&
      overdue["isTruthfulTimeout"] === true &&
      overdue["isWorkCompleted"] === false,
    `exit=${String(observation?.overdueDeadline?.exitCode)} kind=${String(overdue?.["kind"])} truthful=${String(overdue?.["isTruthfulTimeout"])} completed=${String(overdue?.["isWorkCompleted"])}`,
  );

  // ⑥ 未知幂等键：必须非 0 退出码
  const unknownExitCode = observation?.unknownKey?.exitCode;
  record(
    "未知幂等键：必须非 0 退出码（响亮失败，不伪造指令）",
    typeof unknownExitCode === "number" && unknownExitCode !== 0,
    `exit=${String(unknownExitCode)}`,
  );

  return checks;
}

/**
 * PROJECT-01-04 包级判据：跨项目**只读**与**副本导入**入口在同一次 tarball 验收内也必须成立。
 *
 * 与指令窗口同一纪律：**观测缺失即失败**（fail-closed），且"回执成立"不等于"落实"——
 * 只读必须以真的读到（`didRead`）为准，导入必须以真的写出（`didWriteTarget`）为准。
 */
export function buildCrossProjectPackageChecks(observation) {
  const checks = [];
  const record = (name, passed, detail) => checks.push({ name, passed, detail });

  // ① 有效授权只读：exit 0 + 真的读到 + 来源零写入（前后哈希相等）
  const readAllowed = parseJsonObjectFromOutput(observation?.readAllowed?.stdoutText);
  record(
    "跨项目只读：有效授权 ⇒ exit 0 且真实读取（didRead=true）",
    observation?.readAllowed?.exitCode === 0 &&
      readAllowed !== null &&
      readAllowed["outcome"] === "read-allowed" &&
      readAllowed["didRead"] === true &&
      typeof readAllowed["content"] === "string" &&
      readAllowed["content"].length > 0,
    `exit=${String(observation?.readAllowed?.exitCode)} outcome=${String(readAllowed?.["outcome"])} didRead=${String(readAllowed?.["didRead"])}`,
  );
  record(
    "跨项目只读：来源零写入（读取前后哈希相等，且未修改来源）",
    readAllowed !== null &&
      readAllowed["didModifySource"] === false &&
      typeof readAllowed["sourceContentHashBefore"] === "string" &&
      readAllowed["sourceContentHashBefore"] === readAllowed["sourceContentHashAfter"],
    `before=${String(readAllowed?.["sourceContentHashBefore"])} after=${String(readAllowed?.["sourceContentHashAfter"])}`,
  );

  // ② 未授权只读：必须非 0 且不得回显内容
  const readUnauthorized = parseJsonObjectFromOutput(observation?.readUnauthorized?.stdoutText);
  record(
    "跨项目只读：未授权 ⇒ 非 0 退出码且不回显来源内容",
    typeof observation?.readUnauthorized?.exitCode === "number" &&
      observation.readUnauthorized.exitCode !== 0 &&
      readUnauthorized !== null &&
      readUnauthorized["didRead"] !== true &&
      (readUnauthorized["content"] === null || readUnauthorized["content"] === undefined),
    `exit=${String(observation?.readUnauthorized?.exitCode)} didRead=${String(readUnauthorized?.["didRead"])}`,
  );

  // ③ 有效授权导入：exit 0 + 真的写出 + 回执标记为副本
  const importAllowed = parseJsonObjectFromOutput(observation?.importAllowed?.stdoutText);
  record(
    "跨项目导入：有效授权 ⇒ exit 0 且真实写出目标（didWriteTarget=true）",
    observation?.importAllowed?.exitCode === 0 &&
      importAllowed !== null &&
      importAllowed["outcome"] === "imported-copy" &&
      importAllowed["didWriteTarget"] === true &&
      importAllowed["receipt"] !== null &&
      importAllowed["receipt"]?.["isCopyOfExternalSource"] === true,
    `exit=${String(observation?.importAllowed?.exitCode)} outcome=${String(importAllowed?.["outcome"])} didWriteTarget=${String(importAllowed?.["didWriteTarget"])}`,
  );

  // ④ 目标被人工占用且无基线：必须拒绝覆盖（非 0）且不得落定回执
  const importStaleRejected = parseJsonObjectFromOutput(
    observation?.importStaleRejected?.stdoutText,
  );
  record(
    "跨项目导入：目标被人工占用且无基线 ⇒ 拒绝覆盖（非 0，且不落定回执）",
    typeof observation?.importStaleRejected?.exitCode === "number" &&
      observation.importStaleRejected.exitCode !== 0 &&
      importStaleRejected !== null &&
      importStaleRejected["outcome"] === "target-stale-rejected" &&
      importStaleRejected["didWriteTarget"] !== true &&
      (importStaleRejected["receipt"] === null ||
        importStaleRejected["receipt"] === undefined),
    `exit=${String(observation?.importStaleRejected?.exitCode)} outcome=${String(importStaleRejected?.["outcome"])}`,
  );

  return checks;
}
