/**
 * T07D-R2-04 tarball 验收的**判定逻辑**（纯函数，2026-10-06）。
 *
 * 为什么单独成模块（实测缺陷）：
 * 原脚本把判定逻辑内联在 `const rounds = []; if (isDryRun) { ... }` 之后。
 * 由于**只有干跑分支会填充 rounds**，真实（live）模式下 rounds 恒为空 →
 * checks 为空 → failedChecks 为空 → 写出 `verdict: "passed"`，
 * 并在终端打印 "验收通过：产物正确 + 任务 done ✓"，而实际一次 Provider 请求都没发。
 * 这类"零判据通过"必须成为**可测试的不变量**，而不是靠人工看输出。
 *
 * 本模块的硬约束：
 *  ① 零轮次 → 必定 failed（不得通过）；
 *  ② 通过 → 每条判据都必须有据可查，且"无其他改动"这一项**不允许缺省跳过**（fail-closed）；
 *  ③ 只有 `isDryRun === false` 的通过才算真实验收证据。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { toComparableLines } from "./acceptance-output-parsing.mjs";

/**
 * 列出项目目录内**除目标产物与 CLI 状态目录之外**的条目（相对路径，已排序）。
 *
 * 用途：卡内五项判据之一的"无其他改动"。`.astarray/` 是 CLI 自己的状态目录
 * （凭证引用与用量账目），不属于模型产物，故排除。
 * 目录不存在时返回空清单（不抛错）。
 */
export function collectUnexpectedProjectEntries(input) {
  const projectDirectory = input.projectDirectory;
  if (!existsSync(projectDirectory)) {
    return [];
  }
  const expectedAbsolutePath = path.resolve(projectDirectory, input.outputFileRelativePath);
  const unexpectedEntryList = [];
  const walk = (directory, relativePrefix) => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const relativePath =
        relativePrefix === "" ? dirent.name : relativePrefix + "/" + dirent.name;
      // 顶层 `.astarray/`：CLI 状态目录（非模型产物）。
      if (relativePrefix === "" && dirent.name === ".astarray") {
        continue;
      }
      const absolutePath = path.join(directory, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (path.resolve(absolutePath) === expectedAbsolutePath) {
        continue;
      }
      unexpectedEntryList.push(relativePath);
    }
  };
  walk(projectDirectory, "");
  return unexpectedEntryList.sort();
}

/**
 * 由一次验收运行的**事实**推导判据与结论。
 *
 * 输入 rounds 每项：`{ roundName, roundKind, parsedResult, fileExists, actualContent, unexpectedEntryList }`
 *   - `roundKind: "success"`  → 按五项判据检查；
 *   - `roundKind: "rejection"` → 检查"缺产物时不得结案为 done"。
 */
export function buildAcceptanceChecks(input) {
  const checks = [];
  const record = (checkName, isPassed, detail) => {
    checks.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  };
  const expectedSha256 = createHash("sha256").update(input.expectedContent).digest("hex");

  if (input.rounds.length === 0) {
    record(
      "执行了至少一轮验收（不得零判据通过）",
      false,
      "rounds=0：脚本未执行任何轮次；真实模式必须真正执行任务，禁止据此写出通过记录",
    );
  }

  for (const round of input.rounds) {
    if (round.roundKind === "success") {
      const isContentMatched =
        round.actualContent !== null &&
        JSON.stringify(toComparableLines(round.actualContent)) ===
          JSON.stringify(toComparableLines(input.expectedContent));
      record(
        round.roundName + " / status=done",
        round.parsedResult?.status === "done",
        String(round.parsedResult?.status),
      );
      record(
        round.roundName + " / 权限裁决 allowed-once",
        round.parsedResult?.permissionAsk === "allowed-once",
        String(round.parsedResult?.permissionAsk),
      );
      record(round.roundName + " / 产物存在", round.fileExists === true, input.outputFileRelativePath);
      record(round.roundName + " / 产物逐行精确", isContentMatched, "期望 sha256=" + expectedSha256);
      /**
       * 第五项必须 fail-closed：调用方**没有提供扫描结果**时判失败，
       * 否则"漏扫"会静默变成"没有其他改动"。
       */
      const isEntryListProvided = Array.isArray(round.unexpectedEntryList);
      const unexpectedEntryList = isEntryListProvided ? round.unexpectedEntryList : [];
      record(
        round.roundName + " / 无其他改动",
        isEntryListProvided && unexpectedEntryList.length === 0,
        !isEntryListProvided
          ? "未提供改动清单（脚本未扫描，fail-closed 判失败）"
          : unexpectedEntryList.length === 0
            ? "无"
            : unexpectedEntryList.join(", "),
      );
      continue;
    }
    record(
      round.roundName + " / 不得结案为 done",
      round.parsedResult?.status !== "done",
      "status=" + String(round.parsedResult?.status),
    );
    record(round.roundName + " / 无产物", round.fileExists !== true, input.outputFileRelativePath);
  }

  const failedCheckNames = checks
    .filter((check) => !check.isPassed)
    .map((check) => check.checkName);
  const verdict = failedCheckNames.length > 0 ? "failed" : "passed";
  return {
    checks,
    failedCheckNames,
    verdict,
    expectedSha256,
    executedRoundCount: input.rounds.length,
    /** 只有"真实运行 + 通过"才能作为产品路径验收证据；干跑一律为 false。 */
    isRealAcceptanceEvidence: verdict === "passed" && input.isDryRun === false,
  };
}

/**
 * 汇总本地用量账目（只读，不落盘、不发请求）。
 *
 * 口径与产品侧 `aggregateUsageEntries` 一致的关键两条：
 *  - 只统计 `attribution.kind === "total"` 的条目（子量不得重复计入总量）；
 *  - 未知用量（null）**不补 0**：整体标记不完整并把总量置 null。
 */
export function summarizeUsageLedgerEntries(entries) {
  let inputTokenCount = 0;
  let outputTokenCount = 0;
  let hasIncompleteUsage = false;
  const byModel = {};
  let countedRequestCount = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    if (entry.attribution?.kind !== "total") {
      continue;
    }
    countedRequestCount += 1;
    if (entry.inputTokenCount === null || entry.outputTokenCount === null) {
      hasIncompleteUsage = true;
      continue;
    }
    inputTokenCount += entry.inputTokenCount;
    outputTokenCount += entry.outputTokenCount;
    const modelIdentifier = String(entry.modelIdentifier);
    const modelGroup = byModel[modelIdentifier] ?? {
      requestCount: 0,
      inputTokenCount: 0,
      outputTokenCount: 0,
    };
    modelGroup.requestCount += 1;
    modelGroup.inputTokenCount += entry.inputTokenCount;
    modelGroup.outputTokenCount += entry.outputTokenCount;
    byModel[modelIdentifier] = modelGroup;
  }
  return {
    ledgerEntryCount: entries.length,
    countedRequestCount,
    hasIncompleteUsage,
    // 不完整即不给出总量（不得用 0 冒充"没有用量"）。
    inputTokenCount: hasIncompleteUsage ? null : inputTokenCount,
    outputTokenCount: hasIncompleteUsage ? null : outputTokenCount,
    byModel,
  };
}

/** 读取并汇总项目目录内的用量账目；不存在或损坏时返回 null（不伪造用量）。 */
export function readUsageObservation(projectDirectory) {
  const ledgerFilePath = path.join(projectDirectory, ".astarray", "usage", "entries.json");
  if (!existsSync(ledgerFilePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(ledgerFilePath, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { ledgerFilePath, ...summarizeUsageLedgerEntries(entries) };
  } catch {
    return null;
  }
}
