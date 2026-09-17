/**
 * READ-FORMAT-03a：前端脚本读取策略（JS/TS/JSX/TSX，ADR-0042）。
 *
 * 语言感知状态机（不使用通用正则跨语言删除）：
 * - 字符串/模板字符串（含 ${} 嵌套代码）、正则字面量、JSX 文本与属性中的注释标记不误删；
 * - JSX 表达式容器内的块注释按需省略；
 * - 静态 import / export-from / require 可按需省略；**动态 import() 保留并标注**（副作用不误删）；
 * - 未闭合模板字符串/块注释 → parse-error（原样返回）；视图行号与源一致。
 */
import type {
  ReadViewBuildResult,
  ReadViewLineRange,
} from "./read-format-scanner.js";

type FrontendScanMode = "code" | "template" | "jsxText" | "jsxTag";

interface ScriptContext {
  kind: "template" | "jsxExpression";
  braceDepth: number;
}

const REGEX_ALLOWED_SYMBOLS = new Set([
  "=", "(", "[", "{", ",", ";", ":", "?", "!", "&", "|", "+", "-", "*", "%",
  "^", "~", "<", ">", "",
]);
const REGEX_ALLOWED_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
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

/** 消费简单引号字符串（支持反斜杠转义；换行视为未闭合）。 */
function consumeSimpleString(
  sourceText: string,
  startIndex: number,
  quote: string,
): { endIndex: number; isUnterminated: boolean } {
  let index = startIndex + 1;
  while (index < sourceText.length) {
    const character = sourceText[index] as string;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") {
      return { endIndex: sourceText.length, isUnterminated: true };
    }
    if (character === quote) {
      return { endIndex: index + 1, isUnterminated: false };
    }
    index += 1;
  }
  return { endIndex: sourceText.length, isUnterminated: true };
}

/** 尝试消费正则字面量；失败返回 null（按除号处理）。 */
function tryConsumeRegexLiteral(
  sourceText: string,
  startIndex: number,
): { endIndex: number } | null {
  let index = startIndex + 1;
  let isInCharacterClass = false;
  while (index < sourceText.length) {
    const character = sourceText[index] as string;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") {
      return null;
    }
    if (character === "[") {
      isInCharacterClass = true;
    } else if (character === "]") {
      isInCharacterClass = false;
    } else if (character === "/" && !isInCharacterClass) {
      let flagsIndex = index + 1;
      while (flagsIndex < sourceText.length && /[a-z]/i.test(sourceText[flagsIndex] as string)) {
        flagsIndex += 1;
      }
      return { endIndex: flagsIndex };
    }
    index += 1;
  }
  return null;
}

/** 消费块注释（不嵌套）；未闭合返回 null。 */
function consumeScriptBlockComment(
  sourceText: string,
  startIndex: number,
): { endIndex: number } | null {
  const terminatorIndex = sourceText.indexOf("*/", startIndex + 2);
  if (terminatorIndex === -1) {
    return null;
  }
  return { endIndex: terminatorIndex + 2 };
}

/** 返回 import/export-from/require 逻辑语句结束位置；null 表示不是可省略的静态导入。 */
function findStaticImportStatementEnd(
  sourceText: string,
  startIndex: number,
): { endIndex: number; isDynamicImport: boolean } | null {
  const lineEndIndex = sourceText.indexOf("\n", startIndex);
  const lineText = sourceText.slice(
    startIndex,
    lineEndIndex === -1 ? sourceText.length : lineEndIndex,
  );
  const isImportKeyword = /^\s*import\b/.test(lineText);
  const isExportFrom = /^\s*export\b/.test(lineText) && /\bfrom\b/.test(lineText);
  const isRequire =
    /^\s*require\s*\(/.test(lineText) ||
    /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/.test(lineText);
  if (!isImportKeyword && !isExportFrom && !isRequire) {
    return null;
  }
  // 动态 import() / import.meta 不是静态导入：保留并标注
  if (isImportKeyword && /^\s*import\s*(\(|\.)/.test(lineText)) {
    return { endIndex: startIndex, isDynamicImport: true };
  }
  let cursor = startIndex;
  let depth = 0;
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (character === "\"" || character === "'" || character === "`") {
      const stringResult = consumeSimpleString(sourceText, cursor, character);
      if (stringResult.isUnterminated) {
        return null;
      }
      cursor = stringResult.endIndex;
      continue;
    }
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
    } else if (character === ";" && depth === 0) {
      return { endIndex: cursor + 1, isDynamicImport: false };
    }
    cursor += 1;
  }
  return null;
}

export interface FrontendScriptScanOptions {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
  supportsJsx: boolean;
}

export function scanFrontendScriptView(
  options: FrontendScriptScanOptions,
): ReadViewBuildResult {
  const { sourceText, supportsJsx } = options;
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
  let mode: FrontendScanMode = "code";
  let contextStack: ScriptContext[] = [];
  let jsxTagBraceDepth = 0;
  let jsxTagIsClosing = false;
  let lastSignificantCharacter = "";
  let lastWord = "";

  const markOmitted = (startLine: number, endLine: number, kind: string): void => {
    didOmit = true;
    omittedKinds.add(kind);
    const lines = omittedLinesByKind.get(kind) ?? [];
    for (let line = startLine; line <= endLine; line += 1) {
      lines.push(line);
    }
    omittedLinesByKind.set(kind, lines);
  };

  const copySpan = (start: number, end: number): void => {
    const spanText = sourceText.slice(start, end);
    outputParts.push(spanText);
    currentLine += countNewlines(spanText);
  };

  const isAtLineStart = (): boolean => {
    const previousNewlineIndex = sourceText.lastIndexOf("\n", index - 1);
    return sourceText.slice(previousNewlineIndex + 1, index).trim() === "";
  };

  const closeContext = (): FrontendScanMode => {
    const currentContext = contextStack[contextStack.length - 1];
    if (currentContext === undefined) {
      return "code";
    }
    contextStack = contextStack.slice(0, -1);
    return currentContext.kind === "template" ? "template" : "jsxText";
  };

  const isRegexAllowedPosition = (): boolean => {
    if (lastWord !== "" && REGEX_ALLOWED_KEYWORDS.has(lastWord)) {
      return true;
    }
    return REGEX_ALLOWED_SYMBOLS.has(lastSignificantCharacter);
  };

  const isJsxStartPosition = (): boolean => {
    const nextCharacter = sourceText[index + 1] ?? "";
    if (!/[A-Za-z>/!]/.test(nextCharacter)) {
      return false;
    }
    return !/[A-Za-z0-9_$]/.test(lastSignificantCharacter);
  };

  const omitImportStatement = (endIndex: number): void => {
    const omittedText = sourceText.slice(index, endIndex);
    const omittedNewlineCount = countNewlines(omittedText);
    const endsWithNewline = omittedText.endsWith("\n");
    markOmitted(
      currentLine,
      currentLine + omittedNewlineCount - (endsWithNewline ? 1 : 0),
      "import-statement",
    );
    outputParts.push("\n".repeat(omittedNewlineCount));
    currentLine += omittedNewlineCount;
    index = endIndex;
  };

  while (index < sourceText.length) {
    const character = sourceText[index] as string;

    if (mode === "template") {
      if (character === "\\") {
        copySpan(index, index + 2);
        index += 2;
        continue;
      }
      if (character === "`") {
        outputParts.push(character);
        index += 1;
        mode = "code";
        lastSignificantCharacter = "`";
        continue;
      }
      if (character === "$" && sourceText[index + 1] === "{") {
        outputParts.push("${");
        contextStack = [...contextStack, { kind: "template", braceDepth: 0 }];
        index += 2;
        mode = "code";
        continue;
      }
      copySpan(index, index + 1);
      index += 1;
      continue;
    }

    if (mode === "jsxText") {
      if (character === "{") {
        contextStack = [...contextStack, { kind: "jsxExpression", braceDepth: 0 }];
        outputParts.push(character);
        index += 1;
        mode = "code";
        continue;
      }
      if (character === "<") {
        outputParts.push(character);
        index += 1;
        mode = "jsxTag";
        jsxTagBraceDepth = 0;
        jsxTagIsClosing = sourceText[index] === "/";
        continue;
      }
      copySpan(index, index + 1);
      index += 1;
      continue;
    }

    if (mode === "jsxTag") {
      if (character === "\"" || character === "'") {
        const stringResult = consumeSimpleString(sourceText, index, character);
        if (stringResult.isUnterminated) {
          parseErrorReason = "unterminated-string-literal";
          break;
        }
        copySpan(index, stringResult.endIndex);
        index = stringResult.endIndex;
        continue;
      }
      if (character === "{") {
        jsxTagBraceDepth += 1;
        outputParts.push(character);
        index += 1;
        continue;
      }
      if (character === "}") {
        jsxTagBraceDepth -= 1;
        outputParts.push(character);
        index += 1;
        continue;
      }
      if (character === ">" && jsxTagBraceDepth === 0) {
        const isSelfClosing = sourceText[index - 1] === "/";
        outputParts.push(character);
        index += 1;
        mode = isSelfClosing || jsxTagIsClosing ? "code" : "jsxText";
        jsxTagIsClosing = false;
        lastSignificantCharacter = ">";
        continue;
      }
      copySpan(index, index + 1);
      index += 1;
      continue;
    }

    if (options.shouldIncludeImports === false && isAtLineStart()) {
      const importMatch = findStaticImportStatementEnd(sourceText, index);
      if (importMatch !== null) {
        if (importMatch.isDynamicImport) {
          retainedConstructs.add("dynamic-import");
        } else {
          const trailingLineIndex = sourceText.indexOf("\n", importMatch.endIndex);
          const trailingText = sourceText.slice(
            importMatch.endIndex,
            trailingLineIndex === -1 ? sourceText.length : trailingLineIndex,
          );
          const trimmedTrailingText = trailingText.trim();
          if (
            trimmedTrailingText !== "" &&
            !trimmedTrailingText.startsWith("//")
          ) {
            retainedConstructs.add("import-with-inline-code");
          } else {
            omitImportStatement(importMatch.endIndex);
            continue;
          }
        }
      }
    }

    // 动态 import() 出现在任意位置：保留并标注（副作用导入不误删）。
    if (
      options.shouldIncludeImports === false &&
      sourceText.startsWith("import", index) &&
      !/[A-Za-z0-9_$]/.test(sourceText[index - 1] ?? "")
    ) {
      const followingText = sourceText.slice(index + "import".length);
      if (/^\s*\(/.test(followingText)) {
        retainedConstructs.add("dynamic-import");
        copySpan(index, index + "import".length);
        index += "import".length;
        lastWord = "import";
        continue;
      }
    }

    if (options.shouldIncludeComments === false) {
      if (sourceText.startsWith("//", index)) {
        const newlineIndex = sourceText.indexOf("\n", index);
        markOmitted(currentLine, currentLine, "comment");
        index = newlineIndex === -1 ? sourceText.length : newlineIndex;
        continue;
      }
      if (sourceText.startsWith("/*", index)) {
        const blockResult = consumeScriptBlockComment(sourceText, index);
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

    if (character === "\"" || character === "'") {
      const stringResult = consumeSimpleString(sourceText, index, character);
      if (stringResult.isUnterminated) {
        parseErrorReason = "unterminated-string-literal";
        break;
      }
      copySpan(index, stringResult.endIndex);
      index = stringResult.endIndex;
      lastSignificantCharacter = character;
      lastWord = "";
      continue;
    }
    if (character === "`") {
      outputParts.push(character);
      index += 1;
      mode = "template";
      lastWord = "";
      continue;
    }
    if (character === "/" && isRegexAllowedPosition()) {
      const regexResult = tryConsumeRegexLiteral(sourceText, index);
      if (regexResult !== null) {
        copySpan(index, regexResult.endIndex);
        index = regexResult.endIndex;
        lastSignificantCharacter = "/";
        lastWord = "";
        continue;
      }
    }
    if (supportsJsx && character === "<" && isJsxStartPosition()) {
      outputParts.push(character);
      index += 1;
      mode = "jsxTag";
      jsxTagBraceDepth = 0;
      jsxTagIsClosing = sourceText[index] === "/";
      lastWord = "";
      continue;
    }
    if (character === "{") {
      const currentContext = contextStack[contextStack.length - 1];
      if (currentContext !== undefined) {
        currentContext.braceDepth += 1;
      }
      outputParts.push(character);
      index += 1;
      lastSignificantCharacter = character;
      lastWord = "";
      continue;
    }
    if (character === "}") {
      const currentContext = contextStack[contextStack.length - 1];
      if (currentContext !== undefined && currentContext.braceDepth === 0) {
        outputParts.push(character);
        index += 1;
        mode = closeContext();
        lastSignificantCharacter = character;
        lastWord = "";
        continue;
      }
      if (currentContext !== undefined) {
        currentContext.braceDepth -= 1;
      }
      outputParts.push(character);
      index += 1;
      lastSignificantCharacter = character;
      lastWord = "";
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(character)) {
      lastWord = /[A-Za-z_$]/.test(character) ? lastWord + character : "";
    } else {
      lastWord = "";
    }
    copySpan(index, index + 1);
    if (character.trim() !== "") {
      lastSignificantCharacter = character;
    }
    index += 1;
  }

  if (
    mode === "template" ||
    contextStack.some((context) => context.kind === "template")
  ) {
    parseErrorReason = parseErrorReason ?? "unterminated-template-literal";
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
    if (retainedConstruct === "dynamic-import") {
      limitations.push("dynamic-import: 动态 import() 保留（副作用不误删）");
    } else if (retainedConstruct === "import-with-inline-code") {
      limitations.push("import-with-inline-code: 同一行含其他代码，未删除该导入");
    } else {
      limitations.push("retained-construct: " + retainedConstruct);
    }
  }
  const filterStatus = didOmit
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
