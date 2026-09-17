/**
 * READ-FORMAT-04a：配置/文档读取策略（JSON/JSONC、YAML、TOML、Markdown、纯文本）。
 *
 * - JSONC 支持行注释与块注释；JSON 无语义注释（能力 unsupported，不虚报已过滤）；
 * - YAML/TOML 使用 # 注释（YAML 的 # 需位于行首或空白之后，URL 片段不误删）；
 * - Markdown 围栏代码块整体保留，仅过滤 <!-- --> 注释；
 * - 这些格式没有静态导入概念：imports 能力标 unsupported（不适用，不是失败）。
 */
import {
  consumeQuotedString,
  scanReadView,
  type ReadFormatScanProfile,
  type ReadViewBuildResult,
  type StringScanResult,
} from "./read-format-scanner.js";

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

function consumeSimpleQuotedString(
  sourceText: string,
  index: number,
): StringScanResult | null {
  const character = sourceText[index] as string;
  if (character === "\"" || character === "'") {
    return consumeQuotedString({
      sourceText,
      startIndex: index,
      quote: character,
      supportsEscapes: true,
    });
  }
  return null;
}

/** 无静态导入概念的格式：按需追加"imports 不适用"说明。 */
export function appendUnsupportedImportNotice(
  result: ReadViewBuildResult,
  shouldIncludeImports: boolean,
): ReadViewBuildResult {
  if (shouldIncludeImports) {
    return result;
  }
  return {
    ...result,
    limitations: [
      ...result.limitations,
      "imports-unsupported: 该格式没有静态导入概念，未执行导入省略",
    ],
  };
}

export function scanJsonLikeView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
  hasComments: boolean;
  hasLineComments: boolean;
}): ReadViewBuildResult {
  const profile: ReadFormatScanProfile = {
    strategyId: input.hasComments ? "jsonc" : "json",
    policyVersion: 1,
    lineCommentTokens: input.hasLineComments ? ["//"] : [],
    blockComment: input.hasComments ? { start: "/*", end: "*/", nested: false } : null,
    scanString: consumeSimpleQuotedString,
    matchImportStatement: () => null,
  };
  const result = scanReadView({
    profile,
    sourceText: input.sourceText,
    shouldIncludeComments: input.hasComments && input.shouldIncludeComments,
    shouldIncludeImports: false,
  });
  const withNotice = appendUnsupportedImportNotice(result, input.shouldIncludeImports);
  if (!input.hasComments && input.shouldIncludeComments === false) {
    return {
      ...withNotice,
      limitations: [
        ...withNotice.limitations,
        "comments-unsupported: JSON 没有语义注释，未执行注释省略",
      ],
    };
  }
  return withNotice;
}

export function scanHashCommentDocumentView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
  isYaml: boolean;
}): ReadViewBuildResult {
  const profile: ReadFormatScanProfile = {
    strategyId: input.isYaml ? "yaml" : "toml",
    policyVersion: 1,
    lineCommentTokens: ["#"],
    blockComment: null,
    scanString: consumeSimpleQuotedString,
    matchImportStatement: () => null,
    shouldTreatAsLineComment: input.isYaml
      ? (sourceText, index) => {
          if (index === 0) {
            return true;
          }
          const previousCharacter = sourceText[index - 1] as string;
          return previousCharacter === " " || previousCharacter === "\t" || previousCharacter === "\n";
        }
      : undefined,
  };
  const result = scanReadView({
    profile,
    sourceText: input.sourceText,
    shouldIncludeComments: input.shouldIncludeComments,
    shouldIncludeImports: false,
  });
  return appendUnsupportedImportNotice(result, input.shouldIncludeImports);
}

export function scanMarkdownView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  const sourceText = input.sourceText;
  const outputParts: string[] = [];
  const omittedLines: number[] = [];
  let didOmit = false;
  let parseErrorReason: string | null = null;
  let index = 0;
  let currentLine = 1;
  let fenceMarker: string | null = null;

  while (index < sourceText.length) {
    const isAtLineStart = index === 0 || sourceText[index - 1] === "\n";
    if (isAtLineStart) {
      const newlineIndex = sourceText.indexOf("\n", index);
      const lineEndIndex = newlineIndex === -1 ? sourceText.length : newlineIndex + 1;
      const lineText = sourceText.slice(index, lineEndIndex);
      const trimmedLine = lineText.trimStart();
      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmedLine);
      if (fenceMarker !== null) {
        outputParts.push(lineText);
        currentLine += countNewlines(lineText);
        index = lineEndIndex;
        if (
          fenceMatch !== null &&
          trimmedLine.startsWith(fenceMarker) &&
          trimmedLine.slice(fenceMarker.length).trim() === ""
        ) {
          fenceMarker = null;
        }
        continue;
      }
      if (fenceMatch !== null) {
        fenceMarker = fenceMatch[1] as string;
        outputParts.push(lineText);
        currentLine += countNewlines(lineText);
        index = lineEndIndex;
        continue;
      }
    }
    if (
      input.shouldIncludeComments === false &&
      sourceText.startsWith("<!--", index)
    ) {
      const commentEndIndex = sourceText.indexOf("-->", index + 4);
      if (commentEndIndex === -1) {
        parseErrorReason = "unterminated-comment";
        break;
      }
      const skippedText = sourceText.slice(index, commentEndIndex + 3);
      const skippedNewlineCount = countNewlines(skippedText);
      const endsWithNewline = skippedText.endsWith("\n");
      const startLine = currentLine;
      const endLine = currentLine + skippedNewlineCount - (endsWithNewline ? 1 : 0);
      for (let line = startLine; line <= endLine; line += 1) {
        omittedLines.push(line);
      }
      didOmit = true;
      outputParts.push("\n".repeat(skippedNewlineCount));
      currentLine += skippedNewlineCount;
      index = commentEndIndex + 3;
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
      retainedConstructs: [],
      lineMap: identityLineMap(countLines(sourceText)),
      isViewComplete: false,
      limitations: [
        "parse-error(" + parseErrorReason + "): 扫描未完成，已原样返回全文",
      ],
    };
  }
  const omittedLineRanges = (() => {
    const sortedLines = [...new Set(omittedLines)].sort((left, right) => left - right);
    const ranges: Array<{ kind: string; startLine: number; endLine: number }> = [];
    let rangeStart: number | null = null;
    let previousLine: number | null = null;
    for (const line of sortedLines) {
      if (rangeStart === null || previousLine === null) {
        rangeStart = line;
      } else if (line !== previousLine + 1) {
        ranges.push({ kind: "comment", startLine: rangeStart, endLine: previousLine });
        rangeStart = line;
      }
      previousLine = line;
    }
    if (rangeStart !== null && previousLine !== null) {
      ranges.push({ kind: "comment", startLine: rangeStart, endLine: previousLine });
    }
    return ranges;
  })();
  const result: ReadViewBuildResult = {
    viewText: outputParts.join(""),
    filterStatus: didOmit ? "filtered" : "not-filtered",
    omittedKinds: didOmit ? ["comment"] : [],
    omittedLineRanges,
    retainedConstructs: [],
    lineMap: identityLineMap(countLines(sourceText)),
    isViewComplete: !didOmit,
    limitations: didOmit ? ["view-omits-content: 改动前按需补读原文对应行"] : [],
  };
  return appendUnsupportedImportNotice(result, input.shouldIncludeImports);
}

export function scanPlainTextView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  const limitations: string[] = [];
  if (input.shouldIncludeComments === false) {
    limitations.push("comments-unsupported: 纯文本没有注释语法，未执行注释省略");
  }
  const result: ReadViewBuildResult = {
    viewText: input.sourceText,
    filterStatus: "not-filtered",
    omittedKinds: [],
    omittedLineRanges: [],
    retainedConstructs: [],
    lineMap: identityLineMap(countLines(input.sourceText)),
    isViewComplete: true,
    limitations,
  };
  return appendUnsupportedImportNotice(result, input.shouldIncludeImports);
}
