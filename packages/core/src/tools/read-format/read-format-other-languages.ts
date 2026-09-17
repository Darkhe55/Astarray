/**
 * READ-FORMAT-04b：Go、Shell、SQL 读取策略（ADR-0042）。
 *
 * - Go：// 与块注释；解释字符串/原始反引号字符串/符文不被误删；import 单条与 import (…) 块可省略；
 * - Shell：# 注释（需行首或空白后）；单/双引号与反引号保护；heredoc 整体保留；
 *   source/. 仅静态路径可省略，动态（$VAR/命令替换/通配）保留并标注 dynamic-import；
 * - SQL：-- 与块注释；单引号字符串（'' 转义）与双引号标识符保护；imports 能力 unsupported。
 */
import {
  consumeQuotedString,
  scanReadView,
  type ImportStatementMatch,
  type ReadFormatScanProfile,
  type ReadViewBuildResult,
  type StringScanResult,
} from "./read-format-scanner.js";
import { appendUnsupportedImportNotice } from "./read-format-config-documents.js";

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

function identityLineMap(sourceLineCount: number) {
  if (sourceLineCount === 0) {
    return [];
  }
  return [
    { returnedStartLine: 1, sourceStartLine: 1, lineCount: sourceLineCount },
  ];
}

function buildOmittedLineRanges(
  omittedLinesByKind: Map<string, number[]>,
) {
  const ranges: Array<{ kind: string; startLine: number; endLine: number }> = [];
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

function scanGoString(sourceText: string, index: number): StringScanResult | null {
  const character = sourceText[index] as string;
  if (character === "\"" || character === "'") {
    return consumeQuotedString({
      sourceText,
      startIndex: index,
      quote: character,
      supportsEscapes: true,
    });
  }
  if (character === "`") {
    const endIndex = sourceText.indexOf("`", index + 1);
    if (endIndex === -1) {
      return { endIndex: sourceText.length, isUnterminated: true };
    }
    return { endIndex: endIndex + 1, isUnterminated: false };
  }
  return null;
}

function matchGoImportStatement(
  sourceText: string,
  index: number,
): ImportStatementMatch | null {
  const lineEndIndex = sourceText.indexOf("\n", index);
  const lineText = sourceText.slice(
    index,
    lineEndIndex === -1 ? sourceText.length : lineEndIndex,
  );
  if (!/^\s*import\b/.test(lineText)) {
    return null;
  }
  if (!/^\s*import\s*\(/.test(lineText)) {
    return {
      endIndex: lineEndIndex === -1 ? sourceText.length : lineEndIndex + 1,
      isSafeToOmit: true,
      kind: "import-statement",
    };
  }
  let cursor = index;
  let depth = 0;
  let blockEndIndex = -1;
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (character === "\"" || character === "'" || character === "`") {
      const stringResult = scanGoString(sourceText, cursor);
      if (stringResult === null || stringResult.isUnterminated) {
        return null;
      }
      cursor = stringResult.endIndex;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        blockEndIndex = cursor + 1;
        break;
      }
    }
    cursor += 1;
  }
  if (blockEndIndex === -1) {
    return null;
  }
  const trailingLineIndex = sourceText.indexOf("\n", blockEndIndex);
  const trailingText = sourceText
    .slice(blockEndIndex, trailingLineIndex === -1 ? sourceText.length : trailingLineIndex)
    .trim();
  if (trailingText !== "" && !trailingText.startsWith("//")) {
    return {
      endIndex: index,
      isSafeToOmit: false,
      kind: "import-statement",
      retainedConstruct: "import-with-inline-code",
    };
  }
  return {
    endIndex: trailingLineIndex === -1 ? sourceText.length : trailingLineIndex + 1,
    isSafeToOmit: true,
    kind: "import-statement",
  };
}

export function scanGoView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  const profile: ReadFormatScanProfile = {
    strategyId: "go",
    policyVersion: 1,
    lineCommentTokens: ["//"],
    blockComment: { start: "/*", end: "*/", nested: false },
    scanString: scanGoString,
    matchImportStatement: matchGoImportStatement,
  };
  return scanReadView({
    profile,
    sourceText: input.sourceText,
    shouldIncludeComments: input.shouldIncludeComments,
    shouldIncludeImports: input.shouldIncludeImports,
  });
}

function scanSqlString(sourceText: string, index: number): StringScanResult | null {
  const quoteCharacter = sourceText[index] as string;
  if (quoteCharacter !== "'" && quoteCharacter !== "\"") {
    return null;
  }
  const doubledQuote = quoteCharacter + quoteCharacter;
  let cursor = index + 1;
  while (cursor < sourceText.length) {
    if (sourceText.startsWith(doubledQuote, cursor)) {
      cursor += 2;
      continue;
    }
    const character = sourceText[cursor] as string;
    if (character === quoteCharacter) {
      return { endIndex: cursor + 1, isUnterminated: false };
    }
    if (character === "\n") {
      return { endIndex: sourceText.length, isUnterminated: true };
    }
    cursor += 1;
  }
  return { endIndex: sourceText.length, isUnterminated: true };
}

export function scanSqlView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  const profile: ReadFormatScanProfile = {
    strategyId: "sql",
    policyVersion: 1,
    lineCommentTokens: ["--"],
    blockComment: { start: "/*", end: "*/", nested: false },
    scanString: scanSqlString,
    matchImportStatement: () => null,
  };
  const result = scanReadView({
    profile,
    sourceText: input.sourceText,
    shouldIncludeComments: input.shouldIncludeComments,
    shouldIncludeImports: false,
  });
  const withNotice = appendUnsupportedImportNotice(result, input.shouldIncludeImports);
  if (input.shouldIncludeComments === false) {
    return {
      ...withNotice,
      limitations: [
        ...withNotice.limitations,
        "dialect-comment-variants: 未处理方言特有注释（如 MySQL # 注释）",
      ],
    };
  }
  return withNotice;
}

/** 读 heredoc 起始（<<、<<-、带引号定界符）；返回 null 表示不是 heredoc，endIndex 为 -1 表示未闭合。 */
function tryReadHeredoc(sourceText: string, index: number): { endIndex: number } | null {
  if (!sourceText.startsWith("<<", index)) {
    return null;
  }
  const previousCharacter = index === 0 ? "" : (sourceText[index - 1] as string);
  if (previousCharacter === "<" || /[A-Za-z0-9_]/.test(previousCharacter)) {
    return null;
  }
  const isTabStripping = sourceText.startsWith("<<-", index);
  let cursor = index + (isTabStripping ? 3 : 2);
  while (sourceText[cursor] === " " || sourceText[cursor] === "\t") {
    cursor += 1;
  }
  const delimiterStartCharacter = sourceText[cursor] ?? "";
  if (!/[A-Za-z_'"]/.test(delimiterStartCharacter)) {
    return null;
  }
  let quoteCharacter = "";
  if (delimiterStartCharacter === "\"" || delimiterStartCharacter === "'") {
    quoteCharacter = delimiterStartCharacter;
    cursor += 1;
  }
  let delimiter = "";
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (quoteCharacter !== "" ? character === quoteCharacter : !/[A-Za-z0-9_]/.test(character)) {
      break;
    }
    delimiter += character;
    cursor += 1;
  }
  if (delimiter === "") {
    return null;
  }
  if (quoteCharacter !== "") {
    if (sourceText[cursor] !== quoteCharacter) {
      return null;
    }
    cursor += 1;
  }
  let lineStart = cursor;
  while (lineStart <= sourceText.length) {
    const newlineIndex = sourceText.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? sourceText.length : newlineIndex;
    const lineText = sourceText.slice(lineStart, lineEnd);
    const comparisonLine = isTabStripping ? lineText.replace(/^\t+/, "") : lineText;
    if (comparisonLine.trimEnd() === delimiter) {
      return { endIndex: newlineIndex === -1 ? sourceText.length : newlineIndex + 1 };
    }
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }
  return { endIndex: -1 };
}

function matchShellImportStatement(
  sourceText: string,
  index: number,
): ImportStatementMatch | null {
  const lineEndIndex = sourceText.indexOf("\n", index);
  const lineText = sourceText.slice(
    index,
    lineEndIndex === -1 ? sourceText.length : lineEndIndex,
  );
  const importMatch = /^\s*(source|\.)(\s+)(.*)$/.exec(lineText);
  if (importMatch === null) {
    return null;
  }
  const argumentText = (importMatch[3] ?? "").replace(/\s+#.*$/, "").trim();
  if (argumentText === "") {
    return null;
  }
  const dynamicArgumentCharacters = ["$", "`", "(", ")", "*", "?", "[", "]", "{", "}"];
  if (
    dynamicArgumentCharacters.some((dynamicCharacter) =>
      argumentText.includes(dynamicCharacter),
    )
  ) {
    return {
      endIndex: index,
      isSafeToOmit: false,
      kind: "import-statement",
      retainedConstruct: "dynamic-import",
    };
  }
  return {
    endIndex: lineEndIndex === -1 ? sourceText.length : lineEndIndex + 1,
    isSafeToOmit: true,
    kind: "import-statement",
  };
}

/** 消费单引号（无转义，可跨行）/双引号（反斜杠转义）/反引号（命令替换）。 */
function scanShellQuotedSpan(
  sourceText: string,
  startIndex: number,
): StringScanResult {
  const quoteCharacter = sourceText[startIndex] as string;
  const supportsEscapes = quoteCharacter === "\"" || quoteCharacter === "`";
  let cursor = startIndex + 1;
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (supportsEscapes && character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quoteCharacter) {
      return { endIndex: cursor + 1, isUnterminated: false };
    }
    cursor += 1;
  }
  return { endIndex: sourceText.length, isUnterminated: true };
}

export function scanShellView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  const sourceText = input.sourceText;
  const outputParts: string[] = [];
  const omittedKinds = new Set<string>();
  const omittedLinesByKind = new Map<string, number[]>();
  const retainedConstructs = new Set<string>();
  const limitations: string[] = [];
  let parseErrorReason: string | null = null;
  let didOmit = false;
  let index = 0;
  let currentLine = 1;

  const markOmitted = (startLine: number, endLine: number, kind: string): void => {
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
    const character = sourceText[index] as string;
    if (character === "<" && sourceText[index + 1] === "<") {
      const heredocResult = tryReadHeredoc(sourceText, index);
      if (heredocResult !== null) {
        if (heredocResult.endIndex === -1) {
          parseErrorReason = "unterminated-heredoc";
          break;
        }
        const spanText = sourceText.slice(index, heredocResult.endIndex);
        outputParts.push(spanText);
        currentLine += countNewlines(spanText);
        index = heredocResult.endIndex;
        continue;
      }
    }
    if (input.shouldIncludeImports === false && isAtLineStart()) {
      const importMatch = matchShellImportStatement(sourceText, index);
      if (importMatch !== null) {
        if (!importMatch.isSafeToOmit) {
          retainedConstructs.add(importMatch.retainedConstruct ?? "dynamic-import");
        } else {
          const omittedText = sourceText.slice(index, importMatch.endIndex);
          const omittedNewlineCount = countNewlines(omittedText);
          const endsWithNewline = omittedText.endsWith("\n");
          markOmitted(
            currentLine,
            currentLine + omittedNewlineCount - (endsWithNewline ? 1 : 0),
            "import-statement",
          );
          outputParts.push("\n".repeat(omittedNewlineCount));
          currentLine += omittedNewlineCount;
          index = importMatch.endIndex;
          continue;
        }
      }
    }
    if (
      input.shouldIncludeComments === false &&
      character === "#" &&
      (index === 0 || /[\s;|&(]/.test(sourceText[index - 1] as string))
    ) {
      const newlineIndex = sourceText.indexOf("\n", index);
      markOmitted(currentLine, currentLine, "comment");
      index = newlineIndex === -1 ? sourceText.length : newlineIndex;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      const quotedResult = scanShellQuotedSpan(sourceText, index);
      if (quotedResult.isUnterminated) {
        parseErrorReason = "unterminated-quoted-string";
        break;
      }
      const spanText = sourceText.slice(index, quotedResult.endIndex);
      outputParts.push(spanText);
      currentLine += countNewlines(spanText);
      index = quotedResult.endIndex;
      continue;
    }
    outputParts.push(character);
    if (character === "\n") {
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
      lineMap: identityLineMap(countLines(sourceText)),
      isViewComplete: false,
      limitations: [
        "parse-error(" + parseErrorReason + "): 扫描未完成，已原样返回全文",
      ],
    };
  }
  if (didOmit) {
    limitations.push("view-omits-content: 改动前按需补读原文对应行");
  }
  if (retainedConstructs.has("dynamic-import")) {
    limitations.push("dynamic-import: 动态加载（变量/命令替换/通配）保留，不冒充静态导入");
  }
  if (retainedConstructs.has("import-with-inline-code")) {
    limitations.push("import-with-inline-code: 同一行含其他代码，未删除该导入");
  }
  return {
    viewText: outputParts.join(""),
    filterStatus: didOmit
      ? retainedConstructs.size > 0
        ? "partially-filtered"
        : "filtered"
      : "not-filtered",
    omittedKinds: [...omittedKinds],
    omittedLineRanges: buildOmittedLineRanges(omittedLinesByKind),
    retainedConstructs: [...retainedConstructs],
    lineMap: identityLineMap(countLines(sourceText)),
    isViewComplete: !didOmit,
    limitations,
  };
}
