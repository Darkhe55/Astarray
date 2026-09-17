/**
 * READ-FORMAT-03b：HTML 与 Vue/Svelte 混合文件区段分派（ADR-0042）。
 *
 * - HTML：<!-- --> 注释按需省略；<script src>/<link href> 静态资源标签可省略；
 * - Vue/Svelte/HTML：<template>/<script>/<style> 顶层区段分别按 markup/脚本/样式策略处理；
 * - 嵌入代码不会被当 HTML 注释误删；区段内容行号通过偏移对齐到源文件。
 */
import {
  consumeQuotedString,
  scanReadView,
  type ImportStatementMatch,
  type ReadFormatScanProfile,
  type ReadViewBuildResult,
  type ReadViewLineRange,
  type StringScanResult,
} from "./read-format-scanner.js";
import { scanFrontendScriptView } from "./read-format-frontend-script.js";
import { scanStyleSheetView } from "./read-format-frontend-styles.js";

type SectionName = "template" | "script" | "style";

interface MarkupSection {
  name: SectionName;
  startIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  closeTagEndIndex: number;
  languageHint: string | null;
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

function identityLineMap(sourceLineCount: number) {
  if (sourceLineCount === 0) {
    return [];
  }
  return [
    { returnedStartLine: 1, sourceStartLine: 1, lineCount: sourceLineCount },
  ];
}

/** 返回标签结束位置（`>` 之后的下标）；未找到返回 -1。 */
function findTagEnd(sourceText: string, tagStartIndex: number): number {
  let cursor = tagStartIndex;
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (character === "\"" || character === "'") {
      const stringResult = consumeQuotedString({
        sourceText,
        startIndex: cursor,
        quote: character,
        supportsEscapes: false,
      });
      if (stringResult.isUnterminated) {
        return -1;
      }
      cursor = stringResult.endIndex;
      continue;
    }
    if (character === ">") {
      return cursor + 1;
    }
    cursor += 1;
  }
  return -1;
}

function findTopLevelSections(sourceText: string): MarkupSection[] {
  const sections: MarkupSection[] = [];
  const openTagPattern = /<(template|script|style)(?=[\s>])/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = openTagPattern.exec(sourceText)) !== null) {
    if (match.index < cursor) {
      continue;
    }
    const name = (match[1] as string).toLowerCase() as SectionName;
    const startIndex = match.index;
    const openTagEndIndex = findTagEnd(sourceText, startIndex);
    if (openTagEndIndex === -1) {
      break;
    }
    const closeTagPattern = new RegExp("</" + name + "\\s*>", "i");
    const closeMatch = closeTagPattern.exec(sourceText.slice(openTagEndIndex));
    if (closeMatch === null) {
      continue;
    }
    const contentEndIndex = openTagEndIndex + closeMatch.index;
    const closeTagEndIndex = contentEndIndex + closeMatch[0].length;
    const openTagText = sourceText.slice(startIndex, openTagEndIndex);
    // 带 src 的 script/style 是资源引用标签，不是可承载代码的区段（避免与后续 </script> 错配）。
    if (name !== "template" && /(?:^|\s)src\s*=/i.test(openTagText)) {
      cursor = openTagEndIndex;
      openTagPattern.lastIndex = openTagEndIndex;
      continue;
    }
    const languageHintMatch = /\blang\s*=\s*["']?([\w-]+)/i.exec(openTagText);
    sections.push({
      name,
      startIndex,
      contentStartIndex: openTagEndIndex,
      contentEndIndex,
      closeTagEndIndex,
      languageHint: languageHintMatch === null ? null : (languageHintMatch[1] as string).toLowerCase(),
    });
    cursor = closeTagEndIndex;
    openTagPattern.lastIndex = closeTagEndIndex;
  }
  return sections;
}

function scanMarkupString(sourceText: string, index: number): StringScanResult | null {
  const character = sourceText[index] as string;
  if (character === "\"" || character === "'") {
    return consumeQuotedString({
      sourceText,
      startIndex: index,
      quote: character,
      supportsEscapes: false,
    });
  }
  return null;
}

/** <script src>/<link href> 静态资源标签：可按需省略（同行有其他代码则保留并标注）。 */
function matchResourceTagImport(
  sourceText: string,
  index: number,
): ImportStatementMatch | null {
  const lineEndIndex = sourceText.indexOf("\n", index);
  const lineText = sourceText.slice(
    index,
    lineEndIndex === -1 ? sourceText.length : lineEndIndex,
  );
  if (!/^\s*<(?:script|link)\b/i.test(lineText)) {
    return null;
  }
  if (!/\b(?:src|href)\s*=/i.test(lineText)) {
    return null;
  }
  const tagEndIndex = findTagEnd(sourceText, index);
  if (tagEndIndex === -1) {
    return null;
  }
  const trailingLineIndex = sourceText.indexOf("\n", tagEndIndex);
  const trailingRawText = sourceText.slice(
    tagEndIndex,
    trailingLineIndex === -1 ? sourceText.length : trailingLineIndex,
  );
  // 同一行内闭合的资源标签（如 <script src="…"></script>）：整段一起省略。
  const inlineCloseMatch = /^<\/(?:script|link)\s*>/i.exec(trailingRawText.trimStart());
  if (inlineCloseMatch !== null) {
    const afterCloseIndex =
      tagEndIndex + (trailingRawText.length - trailingRawText.trimStart().length) + inlineCloseMatch[0].length;
    const afterCloseLineIndex = sourceText.indexOf("\n", afterCloseIndex);
    const afterCloseText = sourceText
      .slice(
        afterCloseIndex,
        afterCloseLineIndex === -1 ? sourceText.length : afterCloseLineIndex,
      )
      .trim();
    if (afterCloseText !== "") {
      return {
        endIndex: index,
        isSafeToOmit: false,
        kind: "import-statement",
        retainedConstruct: "import-with-inline-code",
      };
    }
    return {
      endIndex: afterCloseLineIndex === -1 ? sourceText.length : afterCloseLineIndex + 1,
      isSafeToOmit: true,
      kind: "import-statement",
    };
  }
  const trailingText = trailingRawText.trim();
  if (trailingText !== "" && !trailingText.startsWith("<!--")) {
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

function buildMarkupProfile(): ReadFormatScanProfile {
  return {
    strategyId: "html",
    policyVersion: 1,
    lineCommentTokens: [],
    blockComment: { start: "<!--", end: "-->", nested: false },
    scanString: scanMarkupString,
    matchImportStatement: matchResourceTagImport,
  };
}

export function scanMarkupView(input: {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
}): ReadViewBuildResult {
  return scanReadView({
    profile: buildMarkupProfile(),
    sourceText: input.sourceText,
    shouldIncludeComments: input.shouldIncludeComments,
    shouldIncludeImports: input.shouldIncludeImports,
  });
}

export interface SectionedScanOptions {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
  isScriptJsx: boolean;
  styleLanguageHint?: string | null;
}

export function scanSectionedView(
  options: SectionedScanOptions,
): ReadViewBuildResult {
  const sourceText = options.sourceText;
  const sections = findTopLevelSections(sourceText);
  if (sections.length === 0) {
    return scanMarkupView({
      sourceText,
      shouldIncludeComments: options.shouldIncludeComments,
      shouldIncludeImports: options.shouldIncludeImports,
    });
  }
  const outputParts: string[] = [];
  const omittedKinds = new Set<string>();
  const omittedLineRanges: ReadViewLineRange[] = [];
  const retainedConstructs = new Set<string>();
  const limitations: string[] = [];
  let didOmit = false;
  let hasParseError = false;
  let hasPartiallyFiltered = false;
  let currentLine = 1;

  const mergeSubView = (subView: ReadViewBuildResult, lineOffset: number): void => {
    if (subView.filterStatus === "parse-error") {
      hasParseError = true;
      return;
    }
    if (!subView.isViewComplete) {
      didOmit = true;
    }
    if (subView.filterStatus === "partially-filtered") {
      hasPartiallyFiltered = true;
    }
    for (const omittedKind of subView.omittedKinds) {
      omittedKinds.add(omittedKind);
    }
    for (const range of subView.omittedLineRanges) {
      omittedLineRanges.push({
        kind: range.kind,
        startLine: range.startLine + lineOffset,
        endLine: range.endLine + lineOffset,
      });
    }
    for (const retainedConstruct of subView.retainedConstructs) {
      retainedConstructs.add(retainedConstruct);
    }
    for (const limitation of subView.limitations) {
      if (!limitations.includes(limitation)) {
        limitations.push(limitation);
      }
    }
  };

  const appendSegment = (segmentText: string): void => {
    if (segmentText === "") {
      return;
    }
    const segmentView = scanMarkupView({
      sourceText: segmentText,
      shouldIncludeComments: options.shouldIncludeComments,
      shouldIncludeImports: options.shouldIncludeImports,
    });
    mergeSubView(segmentView, currentLine - 1);
    outputParts.push(segmentView.viewText);
    currentLine += countNewlines(segmentText);
  };

  const buildSectionContentView = (section: MarkupSection, contentText: string): ReadViewBuildResult => {
    if (section.name === "script") {
      return scanFrontendScriptView({
        sourceText: contentText,
        shouldIncludeComments: options.shouldIncludeComments,
        shouldIncludeImports: options.shouldIncludeImports,
        supportsJsx: options.isScriptJsx,
      });
    }
    if (section.name === "style") {
      const languageHint = section.languageHint ?? options.styleLanguageHint ?? null;
      return scanStyleSheetView({
        sourceText: contentText,
        shouldIncludeComments: options.shouldIncludeComments,
        shouldIncludeImports: options.shouldIncludeImports,
        hasLineComments:
          languageHint === "scss" || languageHint === "less" || languageHint === "sass",
      });
    }
    return scanMarkupView({
      sourceText: contentText,
      shouldIncludeComments: options.shouldIncludeComments,
      shouldIncludeImports: options.shouldIncludeImports,
    });
  };

  let cursor = 0;
  for (const section of sections) {
    appendSegment(sourceText.slice(cursor, section.startIndex));
    const openTagText = sourceText.slice(section.startIndex, section.contentStartIndex);
    outputParts.push(openTagText);
    currentLine += countNewlines(openTagText);
    const contentText = sourceText.slice(section.contentStartIndex, section.contentEndIndex);
    const contentView = buildSectionContentView(section, contentText);
    mergeSubView(contentView, currentLine - 1);
    outputParts.push(contentView.viewText);
    currentLine += countNewlines(contentText);
    const closeTagText = sourceText.slice(section.contentEndIndex, section.closeTagEndIndex);
    outputParts.push(closeTagText);
    currentLine += countNewlines(closeTagText);
    cursor = section.closeTagEndIndex;
  }
  appendSegment(sourceText.slice(cursor));

  if (hasParseError) {
    return {
      viewText: sourceText,
      filterStatus: "parse-error",
      omittedKinds: [],
      omittedLineRanges: [],
      retainedConstructs: [...retainedConstructs],
      lineMap: identityLineMap(countLines(sourceText)),
      isViewComplete: false,
      limitations: ["parse-error: 区段扫描未完成，已原样返回全文"],
    };
  }

  const filterStatus = didOmit
    ? retainedConstructs.size > 0 || hasPartiallyFiltered
      ? "partially-filtered"
      : "filtered"
    : "not-filtered";
  omittedLineRanges.sort((left, right) => left.startLine - right.startLine);
  return {
    viewText: outputParts.join(""),
    filterStatus,
    omittedKinds: [...omittedKinds],
    omittedLineRanges,
    retainedConstructs: [...retainedConstructs],
    lineMap: identityLineMap(countLines(sourceText)),
    isViewComplete: !didOmit,
    limitations,
  };
}
