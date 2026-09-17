/**
 * READ-FORMAT-04a：LaTeX 读取策略（ADR-0042）。
 *
 * - 注释：% 到行尾；**转义 \% 不是注释**；
 * - verbatim/lstlisting/minted 等逐字环境整体保留（不执行宏、不删内容）；
 * - \usepackage/\input/\include 可按需省略；同行其他代码则保留并标注；
 * - 未闭合逐字环境 → parse-error（原样返回）。
 */
import type {
  ReadViewBuildResult,
  ReadViewLineRange,
} from "./read-format-scanner.js";

const VERBATIM_ENVIRONMENTS = new Set([
  "verbatim",
  "verbatim*",
  "Verbatim",
  "BVerbatim",
  "lstlisting",
  "minted",
  "alltt",
]);

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

/** 该位置的 % 是否被反斜杠转义（前面反斜杠数量为奇数则转义）。 */
function isEscapedPercent(sourceText: string, index: number): boolean {
  let backslashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && sourceText[cursor] === "\\") {
    backslashCount += 1;
    cursor -= 1;
  }
  return backslashCount % 2 === 1;
}

/** 消费命令名及其后续 [..]/[..] 参数组，返回命令结束位置。 */
function findCommandEnd(sourceText: string, startIndex: number): number {
  let cursor = startIndex + 1;
  while (
    cursor < sourceText.length &&
    /[A-Za-z@]/.test(sourceText[cursor] as string)
  ) {
    cursor += 1;
  }
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (character === " " || character === "\t") {
      cursor += 1;
      continue;
    }
    if (character !== "{" && character !== "[") {
      break;
    }
    const closingCharacter = character === "{" ? "}" : "]";
    let depth = 0;
    let innerCursor = cursor;
    while (innerCursor < sourceText.length) {
      const innerCharacter = sourceText[innerCursor] as string;
      if (innerCharacter === character) {
        depth += 1;
      } else if (innerCharacter === closingCharacter) {
        depth -= 1;
        if (depth === 0) {
          innerCursor += 1;
          break;
        }
      } else if (innerCharacter === "\n") {
        break;
      }
      innerCursor += 1;
    }
    cursor = innerCursor;
  }
  return cursor;
}

function matchLatexImportStatement(
  sourceText: string,
  index: number,
): { endIndex: number; isSafeToOmit: boolean } | null {
  const lineEndIndex = sourceText.indexOf("\n", index);
  const lineText = sourceText.slice(
    index,
    lineEndIndex === -1 ? sourceText.length : lineEndIndex,
  );
  if (!/^\s*\\(?:usepackage|RequirePackage|input|include)\b/.test(lineText)) {
    return null;
  }
  const commandEndIndex = findCommandEnd(sourceText, index);
  const trailingLineIndex = sourceText.indexOf("\n", commandEndIndex);
  const trailingText = sourceText
    .slice(commandEndIndex, trailingLineIndex === -1 ? sourceText.length : trailingLineIndex)
    .trim();
  if (trailingText !== "" && !trailingText.startsWith("%")) {
    return { endIndex: index, isSafeToOmit: false };
  }
  return {
    endIndex: trailingLineIndex === -1 ? sourceText.length : trailingLineIndex + 1,
    isSafeToOmit: true,
  };
}

export interface LatexScanOptions {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}

export function scanLatexView(options: LatexScanOptions): ReadViewBuildResult {
  const sourceText = options.sourceText;
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
    if (options.shouldIncludeImports === false && isAtLineStart()) {
      const importMatch = matchLatexImportStatement(sourceText, index);
      if (importMatch !== null) {
        if (!importMatch.isSafeToOmit) {
          retainedConstructs.add("import-with-inline-code");
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

    if (sourceText.startsWith("\\begin{", index)) {
      const nameEndIndex = sourceText.indexOf("}", index + "\\begin{".length);
      if (nameEndIndex !== -1) {
        const environmentName = sourceText.slice(index + "\\begin{".length, nameEndIndex);
        if (VERBATIM_ENVIRONMENTS.has(environmentName)) {
          const endMarker = "\\end{" + environmentName + "}";
          const endIndex = sourceText.indexOf(endMarker, nameEndIndex + 1);
          if (endIndex === -1) {
            parseErrorReason = "unterminated-verbatim-environment";
            break;
          }
          const verbatimText = sourceText.slice(index, endIndex + endMarker.length);
          outputParts.push(verbatimText);
          currentLine += countNewlines(verbatimText);
          index = endIndex + endMarker.length;
          continue;
        }
      }
    }

    if (
      options.shouldIncludeComments === false &&
      sourceText[index] === "%" &&
      !isEscapedPercent(sourceText, index)
    ) {
      const newlineIndex = sourceText.indexOf("\n", index);
      markOmitted(currentLine, currentLine, "comment");
      index = newlineIndex === -1 ? sourceText.length : newlineIndex;
      continue;
    }

    const character = sourceText[index] as string;
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
