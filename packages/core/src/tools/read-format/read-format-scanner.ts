/**
 * READ-FORMAT-02：语言感知读取视图扫描器（ADR-0042）。
 *
 * 只做文本级呈现变换，**不修改源文件、不执行代码、不解析导入目标**：
 * - 逐字符扫描，字符串/注释状态机保证字符串里的注释标记不被误删；
 * - 省略整段时补回换行，保证行号与源文件一一对应（lineMap 恒等）；
 * - 未闭合字符串/块注释 → parse-error（原样返回，isFilterable=false）；
 * - 语义内容（宏/属性/Python 文档字符串等）按族策略默认保留。
 */
import { createHash } from "node:crypto";

export type ReadFilterStatus =
  | "not-filtered"
  | "filtered"
  | "partially-filtered"
  | "unsupported"
  | "parse-error";

export type ReadCapabilityLevel = "full" | "partial" | "unsupported";

export interface ReadViewLineRange {
  kind: string;
  startLine: number;
  endLine: number;
}

export interface ReadViewLineMapEntry {
  returnedStartLine: number;
  sourceStartLine: number;
  lineCount: number;
}

export interface ReadViewBuildResult {
  viewText: string;
  filterStatus: ReadFilterStatus;
  omittedKinds: string[];
  omittedLineRanges: ReadViewLineRange[];
  retainedConstructs: string[];
  lineMap: ReadViewLineMapEntry[];
  isViewComplete: boolean;
  limitations: string[];
}

export interface StringScanResult {
  endIndex: number;
  isUnterminated: boolean;
}

export interface ImportStatementMatch {
  endIndex: number;
  isSafeToOmit: boolean;
  kind: string;
  retainedConstruct?: string;
}

export interface ReadFormatScanProfile {
  strategyId: string;
  policyVersion: number;
  lineCommentTokens: string[];
  blockComment: { start: string; end: string; nested: boolean } | null;
  /** 注释过滤豁免行（如 C 预处理指令）：整行保留，不作为注释删除。 */
  isCommentFilterExemptLine?(
    sourceText: string,
    lineStartIndex: number,
  ): { isExempt: boolean; retainedConstruct: string | null };
  scanString(sourceText: string, index: number): StringScanResult | null;
  matchImportStatement(
    sourceText: string,
    index: number,
  ): ImportStatementMatch | null;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\n") {
      count += 1;
    }
  }
  return count;
}

function countLines(sourceText: string): number {
  if (sourceText === "") {
    return 0;
  }
  const newlineCount = countNewlines(sourceText);
  return sourceText.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeSourceHash(sourceText: string): string {
  return sha256(sourceText);
}

/** 逐字符扫描生成视图；省略 span 时补回内部换行以保证行号对齐。 */
export function scanReadView(input: {
  profile: ReadFormatScanProfile;
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  const { profile, sourceText } = input;
  const sourceLineCount = countLines(sourceText);
  const outputParts: string[] = [];
  const omittedKinds = new Set<string>();
  const omittedLinesByKind = new Map<string, number[]>();
  const retainedConstructs = new Set<string>();
  const limitations: string[] = [];
  let parseErrorReason: string | null = null;
  let didOmit = false;
  let index = 0;
  let currentLine = 1;

  const markOmitted = (
    startLine: number,
    endLine: number,
    kind: string,
  ): void => {
    didOmit = true;
    omittedKinds.add(kind);
    const lines = omittedLinesByKind.get(kind) ?? [];
    for (let line = startLine; line <= endLine; line += 1) {
      lines.push(line);
    }
    omittedLinesByKind.set(kind, lines);
  };

  const isAtLineStart = (): boolean => {
    const previousNewlineIndex = sourceText.lastIndexOf("\n", index - 1);
    return sourceText.slice(previousNewlineIndex + 1, index).trim() === "";
  };

  while (index < sourceText.length) {
    if (input.shouldIncludeImports === false && isAtLineStart()) {
      const importMatch = profile.matchImportStatement(sourceText, index);
      if (importMatch !== null) {
        if (importMatch.isSafeToOmit) {
          const omittedText = sourceText.slice(index, importMatch.endIndex);
          const omittedNewlineCount = countNewlines(omittedText);
          const endsWithNewline = omittedText.endsWith("\n");
          markOmitted(
            currentLine,
            currentLine +
              omittedNewlineCount -
              (endsWithNewline ? 1 : 0),
            importMatch.kind,
          );
          outputParts.push("\n".repeat(omittedNewlineCount));
          currentLine += omittedNewlineCount;
          index = importMatch.endIndex;
          continue;
        }
        retainedConstructs.add(
          importMatch.retainedConstruct ?? "import-with-inline-code",
        );
      }
    }

    if (
      input.shouldIncludeComments === false &&
      isAtLineStart() &&
      profile.isCommentFilterExemptLine !== undefined
    ) {
      const lineStartIndex = sourceText.lastIndexOf("\n", index - 1) + 1;
      const exemption = profile.isCommentFilterExemptLine(
        sourceText,
        lineStartIndex,
      );
      if (exemption.isExempt) {
        const newlineIndex = sourceText.indexOf("\n", index);
        const endIndex = newlineIndex === -1 ? sourceText.length : newlineIndex + 1;
        if (exemption.retainedConstruct !== null) {
          retainedConstructs.add(exemption.retainedConstruct);
        }
        outputParts.push(sourceText.slice(index, endIndex));
        if (newlineIndex !== -1) {
          currentLine += 1;
        }
        index = endIndex;
        continue;
      }
    }

    if (input.shouldIncludeComments === false) {
      const lineToken = profile.lineCommentTokens.find((token) =>
        sourceText.startsWith(token, index),
      );
      if (lineToken !== undefined) {
        const newlineIndex = sourceText.indexOf("\n", index);
        const endIndex = newlineIndex === -1 ? sourceText.length : newlineIndex;
        markOmitted(currentLine, currentLine, "comment");
        index = endIndex;
        continue;
      }
      if (
        profile.blockComment !== null &&
        sourceText.startsWith(profile.blockComment.start, index)
      ) {
        const blockResult = consumeBlockComment(
          sourceText,
          index,
          profile.blockComment,
        );
        if (blockResult === null) {
          parseErrorReason = "unterminated-block-comment";
          break;
        }
        const omittedText = sourceText.slice(index, blockResult.endIndex);
        const omittedNewlineCount = countNewlines(omittedText);
        const endsWithNewline = omittedText.endsWith("\n");
        markOmitted(
          currentLine,
          currentLine + omittedNewlineCount - (endsWithNewline ? 1 : 0),
          "comment",
        );
        outputParts.push("\n".repeat(omittedNewlineCount));
        currentLine += omittedNewlineCount;
        index = blockResult.endIndex;
        continue;
      }
    }

    const stringResult = profile.scanString(sourceText, index);
    if (stringResult !== null) {
      if (stringResult.isUnterminated) {
        parseErrorReason = "unterminated-string-literal";
        break;
      }
      const stringText = sourceText.slice(index, stringResult.endIndex);
      outputParts.push(stringText);
      currentLine += countNewlines(stringText);
      index = stringResult.endIndex;
      continue;
    }

    const currentCharacter = sourceText[index] as string;
    outputParts.push(currentCharacter);
    if (currentCharacter === "\n") {
      currentLine += 1;
    }
    index += 1;
  }

  if (parseErrorReason !== null) {
    return {
      viewText: sourceText,
      filterStatus: "parse-error",
      omittedKinds: [],
      omittedLineRanges: [],
      retainedConstructs: [...retainedConstructs],
      lineMap: identityLineMap(sourceLineCount),
      isViewComplete: false,
      limitations: [
        "parse-error(" + parseErrorReason + "): 扫描未完成，已原样返回全文",
      ],
    };
  }

  const omittedLineRanges = buildOmittedLineRanges(omittedLinesByKind);
  if (didOmit) {
    limitations.push("view-omits-content: 改动前按需补读原文对应行");
  }
  for (const retainedConstruct of retainedConstructs) {
    if (retainedConstruct === "import-with-inline-code") {
      limitations.push(
        "import-with-inline-code: 同一行含其他代码，未删除该导入",
      );
    } else {
      limitations.push("retained-construct: " + retainedConstruct);
    }
  }
  const filterStatus: ReadFilterStatus = didOmit
    ? retainedConstructs.size > 0
      ? "partially-filtered"
      : "filtered"
    : "not-filtered";

  return {
    viewText: outputParts.join(""),
    filterStatus,
    omittedKinds: [...omittedKinds],
    omittedLineRanges,
    retainedConstructs: [...retainedConstructs],
    lineMap: identityLineMap(sourceLineCount),
    isViewComplete: !didOmit,
    limitations,
  };
}

function identityLineMap(sourceLineCount: number): ReadViewLineMapEntry[] {
  if (sourceLineCount === 0) {
    return [];
  }
  return [
    { returnedStartLine: 1, sourceStartLine: 1, lineCount: sourceLineCount },
  ];
}

function buildOmittedLineRanges(
  omittedLinesByKind: Map<string, number[]>,
): ReadViewLineRange[] {
  const ranges: ReadViewLineRange[] = [];
  for (const [kind, lines] of omittedLinesByKind) {
    const sortedLines = [...new Set(lines)].sort((left, right) => left - right);
    let rangeStart: number | null = null;
    let previousLine: number | null = null;
    for (const line of sortedLines) {
      if (rangeStart === null || previousLine === null) {
        rangeStart = line;
      } else if (line !== previousLine + 1) {
        ranges.push({ kind, startLine: rangeStart, endLine: previousLine });
        rangeStart = line;
      }
      previousLine = line;
    }
    if (rangeStart !== null && previousLine !== null) {
      ranges.push({ kind, startLine: rangeStart, endLine: previousLine });
    }
  }
  ranges.sort((left, right) => left.startLine - right.startLine);
  return ranges;
}

/** 消费块注释（支持嵌套）；未闭合返回 null。 */
export function consumeBlockComment(
  sourceText: string,
  startIndex: number,
  blockComment: { start: string; end: string; nested: boolean },
): { endIndex: number } | null {
  let index = startIndex + blockComment.start.length;
  let depth = 1;
  while (index < sourceText.length) {
    if (
      blockComment.nested &&
      sourceText.startsWith(blockComment.start, index)
    ) {
      depth += 1;
      index += blockComment.start.length;
      continue;
    }
    if (sourceText.startsWith(blockComment.end, index)) {
      depth -= 1;
      index += blockComment.end.length;
      if (depth === 0) {
        return { endIndex: index };
      }
      continue;
    }
    index += 1;
  }
  return null;
}

/** 消费带反斜杠转义的简单引号字符串；换行或 EOF 视为未闭合。 */
export function consumeQuotedString(input: {
  sourceText: string;
  startIndex: number;
  quote: string;
  supportsEscapes: boolean;
}): StringScanResult {
  const { sourceText, startIndex, quote, supportsEscapes } = input;
  let index = startIndex + quote.length;
  while (index < sourceText.length) {
    const character = sourceText[index] as string;
    if (supportsEscapes && character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") {
      return { endIndex: sourceText.length, isUnterminated: true };
    }
    if (sourceText.startsWith(quote, index)) {
      return { endIndex: index + quote.length, isUnterminated: false };
    }
    index += 1;
  }
  return { endIndex: sourceText.length, isUnterminated: true };
}

export function extensionOf(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return "";
  }
  return fileName.slice(lastDotIndex).toLowerCase();
}
