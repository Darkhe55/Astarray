/**
 * TOOLKIT-01-05：**真实可运行**的确定性转换器与受控执行入口（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md`
 * 检查点 05 与 §7。
 *
 * 卡内要求："先实现一个**无外部副作用转换器**，验证沙箱/broker 边界；
 * 未支持环境明确拒绝，不自动扩大到任意程序执行"。
 *
 * 本模块的边界（逐条对应卡内）：
 *  - **纯转换**：只吃**显式输入字符串**、只产出值 —— 不读写文件、不起进程、不联网；
 *  - **确定性**：同输入必得同输出（键序按表头顺序稳定）；
 *  - **非法输入明确失败**：列数不一致、空输入、只有表头都**不得**产出伪记录；
 *  - **有界**：超出声明上限的输入一律拒绝（避免不可控大输入变成资源问题）；
 *  - **执行入口先过隔离门禁**：门禁不通过 ⇒ **绝不执行**（`isEnabledByGate:false`）；
 *  - **取消即不执行**；执行预算越界不执行。
 */

import {
  evaluateProgramToolEnablement,
  type ProgramToolCapability,
  type SandboxCapabilityProfile,
} from "./program-tool-isolation-gate.js";

export interface DeterministicProgramToolDeclaration {
  toolPackageId: string;
  version: number;
  contentHash: string;
  /** 该工具**自声明**只读（不构成信任，仍需门禁交叉校验）。 */
  readOnlySelfDeclaration: boolean;
  requiredCapabilities: ProgramToolCapability[];
  declaredSideEffects: ProgramToolCapability[] | ["none"];
  dependencyDepth: number;
  executionBudgetMilliseconds: number;
  /** 允许的**显式输入**字节上限（有界）。 */
  maximumInputBytes: number;
  /** 输出记录条数上限（有界）。 */
  maximumOutputRecordCount: number;
}

/**
 * 本批唯一实现的确定性程序工具：**CSV → JSON 记录数组**。
 *
 * 它是"纯转换"的典型：输入与输出都是**显式数据**，
 * 因此 `requiredCapabilities` 为空、副作用为 `none`，无需文件/进程/网络隔离。
 */
export const DETERMINISTIC_CSV_TO_JSON_CONVERTER: DeterministicProgramToolDeclaration = {
  toolPackageId: "csv-to-json",
  version: 1,
  contentHash: "sha256:" + "5".repeat(64),
  readOnlySelfDeclaration: true,
  requiredCapabilities: [],
  declaredSideEffects: ["none"],
  dependencyDepth: 1,
  executionBudgetMilliseconds: 5_000,
  maximumInputBytes: 256 * 1024,
  maximumOutputRecordCount: 10_000,
};

export interface DeterministicProgramRunOutcome {
  /** 是否**通过隔离门禁**（未通过则根本没有执行）。 */
  isEnabledByGate: boolean;
  isSucceeded: boolean;
  /** 成功时的输出（显式值，不落盘）。 */
  outputText: string | null;
  failureReason: string | null;
}

function buildFailure(
  reason: string,
  isEnabledByGate: boolean,
): DeterministicProgramRunOutcome {
  return { isEnabledByGate, isSucceeded: false, outputText: null, failureReason: reason };
}

/**
 * 受控执行入口。
 *
 * **顺序即纪律**：先门禁 → 再取消检查 → 再预算/输入上限 → 最后才转换。
 * 任何一步不通过都**不执行**转换，并给出**可读原因**。
 */
export async function runDeterministicProgramTool(input: {
  declaration: DeterministicProgramToolDeclaration;
  platform: SandboxCapabilityProfile;
  inputText: string;
  cancellationSignal: AbortSignal;
}): Promise<DeterministicProgramRunOutcome> {
  /** ① 隔离门禁（未通过 ⇒ 绝不执行）。 */
  const enablement = evaluateProgramToolEnablement({
    declaration: input.declaration,
    platform: input.platform,
  });
  if (!enablement.isEnabled) {
    return buildFailure(
      "隔离门禁拒绝执行: " + String(enablement.reason),
      false,
    );
  }

  /** ② 已取消 ⇒ 不执行。 */
  if (input.cancellationSignal.aborted) {
    return buildFailure("调用已取消（取消后不得执行）", true);
  }

  /** ③ 执行预算与输入上限（有界）。 */
  if (
    input.declaration.executionBudgetMilliseconds >
    input.platform.maximumExecutionBudgetMilliseconds
  ) {
    return buildFailure(
      "执行预算 " +
        String(input.declaration.executionBudgetMilliseconds) +
        "ms 超出平台上限 " +
        String(input.platform.maximumExecutionBudgetMilliseconds) +
        "ms",
      true,
    );
  }
  const inputByteLength = Buffer.byteLength(input.inputText, "utf8");
  if (inputByteLength > input.declaration.maximumInputBytes) {
    return buildFailure(
      "输入 " +
        String(inputByteLength) +
        " 字节超出上限 " +
        String(input.declaration.maximumInputBytes) +
        " 字节（有界，拒绝不可控大输入）",
      true,
    );
  }

  /** ④ 转换（纯函数）。 */
  const conversion = convertCsvToJsonRecords({
    inputText: input.inputText,
    maximumOutputRecordCount: input.declaration.maximumOutputRecordCount,
  });
  if (!conversion.isSucceeded) {
    return buildFailure(String(conversion.failureReason), true);
  }
  return {
    isEnabledByGate: true,
    isSucceeded: true,
    outputText: conversion.outputText,
    failureReason: null,
  };
}

/**
 * CSV → JSON 记录数组（**纯函数**，确定性）。
 *
 * 支持的 CSV 形态：引号包裹字段、字段内逗号与换行、`""` 转义双引号。
 * 明确失败：空输入、只有表头、列数与表头不一致、记录数超上限。
 */
export function convertCsvToJsonRecords(input: {
  inputText: string;
  maximumOutputRecordCount: number;
}): {
  isSucceeded: boolean;
  outputText: string | null;
  failureReason: string | null;
} {
  const rows = parseCsvRows(input.inputText);
  if (rows.length === 0) {
    return { isSucceeded: false, outputText: null, failureReason: "输入为空（无可转换内容）" };
  }
  const headerFields = rows[0] as string[];
  if (headerFields.length === 0 || headerFields.every((field) => field === "")) {
    return { isSucceeded: false, outputText: null, failureReason: "表头为空（无可转换内容）" };
  }
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return {
      isSucceeded: false,
      outputText: null,
      failureReason: "只有表头、没有数据行（不得产出伪记录）",
    };
  }
  if (dataRows.length > input.maximumOutputRecordCount) {
    return {
      isSucceeded: false,
      outputText: null,
      failureReason:
        "记录数 " +
        String(dataRows.length) +
        " 超出上限 " +
        String(input.maximumOutputRecordCount),
    };
  }
  const records: Array<Record<string, string>> = [];
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const fieldValues = dataRows[rowIndex] as string[];
    if (fieldValues.length !== headerFields.length) {
      return {
        isSucceeded: false,
        outputText: null,
        failureReason:
          "第 " +
          String(rowIndex + 2) +
          " 行列数 " +
          String(fieldValues.length) +
          " 与表头列数 " +
          String(headerFields.length) +
          " 不一致（拒绝静默丢字段或补空值）",
      };
    }
    const record: Record<string, string> = {};
    for (let fieldIndex = 0; fieldIndex < headerFields.length; fieldIndex += 1) {
      // 键序按表头顺序稳定写入（保证输出确定性）。
      record[headerFields[fieldIndex] as string] = fieldValues[fieldIndex] as string;
    }
    records.push(record);
  }
  return { isSucceeded: true, outputText: JSON.stringify(records), failureReason: null };
}

/**
 * CSV 行/字段解析（纯函数）。
 *
 * 逐字符状态机：引号内允许逗号与换行；`""` 表示一个字面双引号。
 */
function parseCsvRows(inputText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let isInsideQuotedField = false;
  let hasAnyContent = false;
  let index = 0;
  while (index < inputText.length) {
    const character = inputText[index] as string;
    if (isInsideQuotedField) {
      if (character === '"') {
        // `""` ⇒ 字面双引号；单个 `"` ⇒ 引号段结束。
        if (inputText[index + 1] === '"') {
          currentField += '"';
          index += 2;
          continue;
        }
        isInsideQuotedField = false;
        index += 1;
        continue;
      }
      currentField += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      isInsideQuotedField = true;
      hasAnyContent = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      currentRow.push(currentField);
      currentField = "";
      hasAnyContent = true;
      index += 1;
      continue;
    }
    if (character === "\n") {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = "";
      hasAnyContent = false;
      index += 1;
      continue;
    }
    if (character === "\r") {
      index += 1;
      continue;
    }
    currentField += character;
    hasAnyContent = true;
    index += 1;
  }
  // 末行（无结尾换行时）仍需收口；空输入不得产出"空行记录"。
  if (hasAnyContent || currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  return rows;
}
