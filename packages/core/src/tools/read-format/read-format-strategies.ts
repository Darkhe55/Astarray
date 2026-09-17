/**
 * READ-FORMAT-02：C 系、Python、Rust 读取策略与回执（ADR-0042）。
 *
 * - 语言感知扫描（字符串/注释状态机），不用通用正则跨语言删除；
 * - 语义内容默认保留：C 宏/预处理控制、Python 文档字符串、Rust 属性/宏；
 * - 同族按后缀选择具体语言（C/C++/Objective-C/C#/Java）；
 * - 未支持格式返回原文并显式标注 unsupported，不虚报成功。
 */
import {
  computeSourceHash,
  consumeQuotedString,
  extensionOf,
  scanReadView,
  type ImportStatementMatch,
  type ReadCapabilityLevel,
  type ReadFilterStatus,
  type ReadFormatScanProfile,
  type ReadViewBuildResult,
  type ReadViewLineMapEntry,
  type ReadViewLineRange,
  type StringScanResult,
} from "./read-format-scanner.js";
import { scanFrontendScriptView } from "./read-format-frontend-script.js";
import { scanStyleSheetView } from "./read-format-frontend-styles.js";
import { scanSectionedView } from "./read-format-frontend-markup.js";
import { scanLatexView } from "./read-format-latex.js";
import {
  scanHashCommentDocumentView,
  scanJsonLikeView,
  scanMarkdownView,
  scanPlainTextView,
} from "./read-format-config-documents.js";
import {
  scanGoView,
  scanShellView,
  scanSqlView,
} from "./read-format-other-languages.js";

export type {
  ReadFilterStatus,
  ReadCapabilityLevel,
} from "./read-format-scanner.js";

export interface ReadFormatStrategyCapabilities {
  comments: ReadCapabilityLevel;
  imports: ReadCapabilityLevel;
  commentSyntaxFamily: string | null;
}

export interface ReadFormatStrategyMatchInput {
  fileName: string;
  extension: string;
  contentSample: string;
}

export interface ReadFormatStrategy {
  strategyId: string;
  policyVersion: number;
  match(input: ReadFormatStrategyMatchInput): {
    isMatch: boolean;
    specificity: number;
  };
  capabilities: ReadFormatStrategyCapabilities;
  buildView(input: {
    fileName: string;
    extension: string;
    sourceText: string;
    shouldIncludeComments: boolean;
    shouldIncludeImports: boolean;
  }): ReadViewBuildResult;
}

export interface ReadViewReceipt {
  filePath: string;
  sourceRevisionKind: "content-hash";
  sourceRevision: string;
  sourceHash: string;
  policyVersion: number;
  strategyId: string;
  capabilities: ReadFormatStrategyCapabilities;
  viewParameters: {
    shouldIncludeComments: boolean;
    shouldIncludeImports: boolean;
  };
  filterStatus: ReadFilterStatus;
  omittedKinds: string[];
  omittedLineRanges: ReadViewLineRange[];
  retainedConstructs: string[];
  lineMap: ReadViewLineMapEntry[];
  isViewComplete: boolean;
  isFilterable: boolean;
  limitations: string[];
  sensitiveCheckAppliedBeforeView: boolean;
  measurementKind: "utf-8-bytes";
  measuredUnits: number;
  budgetImpact: "same-file";
  viewText: string;
}

const C_FAMILY_EXTENSIONS = [
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".hh",
  ".m",
  ".mm",
  ".cs",
  ".java",
];
const PYTHON_EXTENSIONS = [".py", ".pyi"];
const RUST_EXTENSIONS = [".rs"];

type CFamilyLanguageKind = "c" | "cpp" | "objc" | "csharp" | "java";

function resolveCFamilyLanguageKind(extension: string): CFamilyLanguageKind {
  switch (extension) {
    case ".cs":
      return "csharp";
    case ".java":
      return "java";
    case ".m":
    case ".mm":
      return "objc";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hh":
      return "cpp";
    default:
      return "c";
  }
}

function buildLineImportMatch(
  sourceText: string,
  index: number,
  pattern: RegExp,
  kind: string,
): ImportStatementMatch | null {
  const newlineIndex = sourceText.indexOf("\n", index);
  const lineEnd = newlineIndex === -1 ? sourceText.length : newlineIndex;
  const lineText = sourceText.slice(index, lineEnd);
  const match = pattern.exec(lineText);
  if (match === null) {
    return null;
  }
  return {
    endIndex: newlineIndex === -1 ? sourceText.length : newlineIndex + 1,
    isSafeToOmit: true,
    kind,
  };
}

function buildImportWithInlineCodeMatch(
  sourceText: string,
  index: number,
): ImportStatementMatch {
  const newlineIndex = sourceText.indexOf("\n", index);
  void sourceText.slice(index, newlineIndex === -1 ? sourceText.length : newlineIndex);
  return {
    endIndex: index,
    isSafeToOmit: false,
    kind: "import-statement",
    retainedConstruct: "import-with-inline-code",
  };
}

const CP_PATTERNS = [
  /^\s*#\s*(?:include|import)\b[^\n]*$/,
];

function scanCFamilyString(
  sourceText: string,
  index: number,
  languageKind: CFamilyLanguageKind,
): StringScanResult | null {
  // C++ 原始字符串：R"delim(...)delim"
  if (languageKind === "cpp" || languageKind === "c") {
    const rawPrefixes = ['u8R"', 'LR"', 'uR"', 'UR"', 'R"'];
    const previousCharacter = index === 0 ? "" : (sourceText[index - 1] as string);
    if (!/[A-Za-z0-9_]/.test(previousCharacter)) {
      for (const rawPrefix of rawPrefixes) {
        if (sourceText.startsWith(rawPrefix, index)) {
          const delimiterStart = index + rawPrefix.length;
      const openParenthesisIndex = sourceText.indexOf("(", delimiterStart);
      if (openParenthesisIndex === -1) {
        return { endIndex: sourceText.length, isUnterminated: true };
      }
      const delimiter = sourceText.slice(delimiterStart, openParenthesisIndex);
      const terminator = ")" + delimiter + '"';
      const terminatorIndex = sourceText.indexOf(terminator, openParenthesisIndex + 1);
      if (terminatorIndex === -1) {
        return { endIndex: sourceText.length, isUnterminated: true };
      }
      return {
        endIndex: terminatorIndex + terminator.length,
        isUnterminated: false,
      };
    }
      }
    }
  }
  // C# verbatim（@"..."，"" 为转义）与 $@" 组合
  if (languageKind === "csharp") {
    const verbatimPrefixes = ['$@"', '@$"', '@"'];
    for (const prefix of verbatimPrefixes) {
      if (sourceText.startsWith(prefix, index)) {
        let cursor = index + prefix.length;
        while (cursor < sourceText.length) {
          if (sourceText.startsWith('""', cursor)) {
            cursor += 2;
            continue;
          }
          if (sourceText[cursor] === '"') {
            return { endIndex: cursor + 1, isUnterminated: false };
          }
          cursor += 1;
        }
        return { endIndex: sourceText.length, isUnterminated: true };
      }
    }
  }
  // C# 原始字符串 / Java 文本块：""" ... """
  if (languageKind === "csharp" || languageKind === "java") {
    if (sourceText.startsWith('"""', index)) {
      const terminatorIndex = sourceText.indexOf('"""', index + 3);
      if (terminatorIndex === -1) {
        return { endIndex: sourceText.length, isUnterminated: true };
      }
      return { endIndex: terminatorIndex + 3, isUnterminated: false };
    }
  }
  const quote = sourceText[index];
  if (quote === '"' || quote === "'") {
    return consumeQuotedString({
      sourceText,
      startIndex: index,
      quote,
      supportsEscapes: true,
    });
  }
  return null;
}

function buildCFamilyProfile(
  languageKind: CFamilyLanguageKind,
): ReadFormatScanProfile {
  return {
    strategyId: "c-family",
    policyVersion: 1,
    lineCommentTokens: ["//"],
    blockComment: { start: "/*", end: "*/", nested: false },
    // 预处理指令（#define/#if/#pragma 等）整行保留：宏与预处理控制不得误删。
    isCommentFilterExemptLine: (sourceText, lineStartIndex) => {
      const newlineIndex = sourceText.indexOf("\n", lineStartIndex);
      const lineText = sourceText.slice(
        lineStartIndex,
        newlineIndex === -1 ? sourceText.length : newlineIndex,
      );
      if (!/^\s*#/.test(lineText)) {
        return { isExempt: false, retainedConstruct: null };
      }
      const hasCommentMarker =
        lineText.includes("//") || lineText.includes("/*");
      return {
        isExempt: true,
        retainedConstruct: hasCommentMarker ? "preprocessor-directive" : null,
      };
    },
    scanString: (sourceText, index) =>
      scanCFamilyString(sourceText, index, languageKind),
    matchImportStatement: (sourceText, index) => {
      if (languageKind === "csharp") {
        const usingMatch = buildLineImportMatch(
          sourceText,
          index,
          /^\s*using\s+(?!\()([A-Za-z_][\w.]*(?:\s*=\s*[^;\n]+)?)\s*;\s*(?:\/\/[^\n]*)?$/,
          "import-statement",
        );
        if (usingMatch !== null) {
          return usingMatch;
        }
        const usingLineText = sourceText.slice(
          index,
          sourceText.indexOf("\n", index) === -1
            ? sourceText.length
            : sourceText.indexOf("\n", index),
        );
        // `using (…)` 与 `using var …` 是语句而非导入指令，不得当作待过滤导入。
        return /^\s*using\s+(?!\(|var\b)/.test(usingLineText) &&
          usingLineText.includes(";")
          ? buildImportWithInlineCodeMatch(sourceText, index)
          : null;
      }
      if (languageKind === "java") {
        const javaImportMatch = buildLineImportMatch(
          sourceText,
          index,
          /^\s*import\s+(?:static\s+)?[\w.*]+\s*;\s*(?:\/\/[^\n]*)?$/,
          "import-statement",
        );
        if (javaImportMatch !== null) {
          return javaImportMatch;
        }
        const javaLineText = sourceText.slice(
          index,
          sourceText.indexOf("\n", index) === -1
            ? sourceText.length
            : sourceText.indexOf("\n", index),
        );
        return /^\s*import\b/.test(javaLineText)
          ? buildImportWithInlineCodeMatch(sourceText, index)
          : null;
      }
      for (const pattern of CP_PATTERNS) {
        const includeMatch = buildLineImportMatch(
          sourceText,
          index,
          pattern,
          "include-directive",
        );
        if (includeMatch !== null) {
          return includeMatch;
        }
      }
      return null;
    },
  };
}

function createCFamilyStrategy(): ReadFormatStrategy {
  return {
    strategyId: "c-family",
    policyVersion: 1,
    capabilities: {
      comments: "full",
      imports: "full",
      commentSyntaxFamily: "c-family",
    },
    match: (input) => {
      if (C_FAMILY_EXTENSIONS.includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) => {
      const languageKind = resolveCFamilyLanguageKind(input.extension);
      return scanReadView({
        profile: buildCFamilyProfile(languageKind),
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      });
    },
  };
}

function pythonPrefixAt(
  sourceText: string,
  index: number,
): { prefix: string; quoteIndex: number } | null {
  const previousCharacter = index === 0 ? "" : (sourceText[index - 1] as string);
  if (/[A-Za-z0-9_]/.test(previousCharacter)) {
    return null;
  }
  let cursor = index;
  while (
    cursor < sourceText.length &&
    cursor - index < 2 &&
    /[rRbBuUfF]/.test(sourceText[cursor] as string)
  ) {
    cursor += 1;
  }
  if (sourceText[cursor] === '"' || sourceText[cursor] === "'") {
    return { prefix: sourceText.slice(index, cursor), quoteIndex: cursor };
  }
  return null;
}

function scanPythonString(
  sourceText: string,
  index: number,
): StringScanResult | null {
  if (sourceText[index] === '"' || sourceText[index] === "'") {
    const quote = sourceText[index] as string;
    if (sourceText.startsWith(quote.repeat(3), index)) {
      return consumeTripleQuoted(sourceText, index, quote.repeat(3), false);
    }
    return consumeQuotedString({
      sourceText,
      startIndex: index,
      quote,
      supportsEscapes: true,
    });
  }
  const prefixInfo = pythonPrefixAt(sourceText, index);
  if (prefixInfo === null) {
    return null;
  }
  const isRaw = prefixInfo.prefix.toLowerCase().includes("r");
  if (
    sourceText.startsWith(
      (sourceText[prefixInfo.quoteIndex] as string).repeat(3),
      prefixInfo.quoteIndex,
    )
  ) {
    const tripleQuote = (
      sourceText[prefixInfo.quoteIndex] as string
    ).repeat(3);
    return consumeTripleQuoted(
      sourceText,
      prefixInfo.quoteIndex,
      tripleQuote,
      isRaw,
      index,
    );
  }
  return consumeQuotedString({
    sourceText,
    startIndex: prefixInfo.quoteIndex,
    quote: sourceText[prefixInfo.quoteIndex] as string,
    supportsEscapes: !isRaw,
  });
}

function consumeTripleQuoted(
  sourceText: string,
  quoteStartIndex: number,
  tripleQuote: string,
  isRaw: boolean,
  viewStartIndex?: number,
): StringScanResult {
  let cursor = quoteStartIndex + tripleQuote.length;
  while (cursor < sourceText.length) {
    if (!isRaw && sourceText[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (sourceText.startsWith(tripleQuote, cursor)) {
      return {
        endIndex: cursor + tripleQuote.length,
        isUnterminated: false,
      };
    }
    cursor += 1;
  }
  void viewStartIndex;
  return { endIndex: sourceText.length, isUnterminated: true };
}

function buildPythonProfile(): ReadFormatScanProfile {
  return {
    strategyId: "python",
    policyVersion: 1,
    lineCommentTokens: ["#"],
    blockComment: null,
    scanString: scanPythonString,
    matchImportStatement: (sourceText, index) => {
      const newlineIndex = sourceText.indexOf("\n", index);
      const lineEnd = newlineIndex === -1 ? sourceText.length : newlineIndex;
      const lineText = sourceText.slice(index, lineEnd);
      if (/^\s*import\s+[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*\s*$/.test(lineText)) {
        return {
          endIndex: newlineIndex === -1 ? sourceText.length : newlineIndex + 1,
          isSafeToOmit: true,
          kind: "import-statement",
        };
      }
      if (/^\s*from\s+[\w.\s]+\s+import\s+/.test(lineText)) {
        const statementEnd = findPythonImportStatementEnd(sourceText, index);
        if (statementEnd === null) {
          return null;
        }
        const statementText = sourceText.slice(index, statementEnd);
        if (statementText.includes(";")) {
          return buildImportWithInlineCodeMatch(sourceText, index);
        }
        return {
          endIndex: statementEnd,
          isSafeToOmit: true,
          kind: "import-statement",
        };
      }
      if (/^\s*import\b/.test(lineText)) {
        return buildImportWithInlineCodeMatch(sourceText, index);
      }
      return null;
    },
  };
}

/** 返回 `from ... import ...` 逻辑语句结束位置（含换行）；括号未闭合返回 null。 */
function findPythonImportStatementEnd(
  sourceText: string,
  startIndex: number,
): number | null {
  let index = startIndex;
  let bracketDepth = 0;
  let isEscapedContinuation = false;
  while (index < sourceText.length) {
    const character = sourceText[index] as string;
    if (character === "\\") {
      isEscapedContinuation = true;
      index += 2;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      bracketDepth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      bracketDepth -= 1;
    } else if (character === "\n") {
      if (bracketDepth === 0 && !isEscapedContinuation) {
        return index + 1;
      }
      isEscapedContinuation = false;
    } else if (character !== " " && character !== "\t") {
      isEscapedContinuation = false;
    }
    index += 1;
  }
  return bracketDepth === 0 ? sourceText.length : null;
}

function createPythonStrategy(): ReadFormatStrategy {
  return {
    strategyId: "python",
    policyVersion: 1,
    capabilities: {
      comments: "full",
      imports: "full",
      commentSyntaxFamily: "python",
    },
    match: (input) => {
      if (PYTHON_EXTENSIONS.includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      const contentSample = input.contentSample;
      if (
        input.extension === "" &&
        /^\s*(?:import\s+\w|from\s+[\w.]+\s+import|def\s+\w+\s*\(|class\s+\w+)/.test(
          contentSample,
        )
      ) {
        return { isMatch: true, specificity: 5 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) =>
      scanReadView({
        profile: buildPythonProfile(),
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

function scanRustString(
  sourceText: string,
  index: number,
): StringScanResult | null {
  const previousCharacter = index === 0 ? "" : (sourceText[index - 1] as string);
  if (/[A-Za-z0-9_]/.test(previousCharacter)) {
    return null;
  }
  // 原始/字节原始字符串：r#"..."#、br#"..."#
  const rawPrefixMatch = /^(?:b?r)(#*)"/.exec(sourceText.slice(index));
  if (rawPrefixMatch !== null) {
    const hashes = rawPrefixMatch[1] ?? "";
    const contentStart = index + rawPrefixMatch[0].length;
    const terminator = '"' + hashes;
    const terminatorIndex = sourceText.indexOf(terminator, contentStart);
    if (terminatorIndex === -1) {
      return { endIndex: sourceText.length, isUnterminated: true };
    }
    return {
      endIndex: terminatorIndex + terminator.length,
      isUnterminated: false,
    };
  }
  if (sourceText.startsWith('b"', index)) {
    return consumeQuotedString({
      sourceText,
      startIndex: index + 1,
      quote: '"',
      supportsEscapes: true,
    });
  }
  if (sourceText[index] === '"') {
    return consumeQuotedString({
      sourceText,
      startIndex: index,
      quote: '"',
      supportsEscapes: true,
    });
  }
  // 生命周期 vs 字符字面量：''' 转义或 'x' 视为字符字面量，其余视为生命周期
  if (sourceText[index] === "'") {
    if (sourceText[index + 1] === "\\") {
      return consumeQuotedString({
        sourceText,
        startIndex: index,
        quote: "'",
        supportsEscapes: true,
      });
    }
    if (sourceText[index + 2] === "'") {
      return { endIndex: index + 3, isUnterminated: false };
    }
    return null;
  }
  if (sourceText.startsWith("b'", index)) {
    return null;
  }
  return null;
}

function buildRustProfile(): ReadFormatScanProfile {
  return {
    strategyId: "rust",
    policyVersion: 1,
    lineCommentTokens: ["//"],
    blockComment: { start: "/*", end: "*/", nested: true },
    scanString: scanRustString,
    matchImportStatement: (sourceText, index) => {
      const newlineIndex = sourceText.indexOf("\n", index);
      const lineEnd = newlineIndex === -1 ? sourceText.length : newlineIndex;
      const lineText = sourceText.slice(index, lineEnd);
      if (!/^\s*(?:use|extern\s+crate)\s+/.test(lineText)) {
        return null;
      }
      let cursor = index;
      let depth = 0;
      while (cursor < sourceText.length) {
        const character = sourceText[cursor] as string;
        if (character === "{" || character === "(" || character === "[") {
          depth += 1;
        } else if (character === "}" || character === ")" || character === "]") {
          depth -= 1;
        } else if (character === ";" && depth === 0) {
          const statementEnd = cursor + 1;
          const trailingLineIndex = sourceText.indexOf("\n", statementEnd);
          const trailingText = sourceText.slice(
            statementEnd,
            trailingLineIndex === -1 ? sourceText.length : trailingLineIndex,
          );
          if (trailingText.trim() !== "") {
            return buildImportWithInlineCodeMatch(sourceText, index);
          }
          return {
            endIndex:
              trailingLineIndex === -1 ? sourceText.length : trailingLineIndex + 1,
            isSafeToOmit: true,
            kind: "import-statement",
          };
        }
        cursor += 1;
      }
      return null;
    },
  };
}

function createRustStrategy(): ReadFormatStrategy {
  return {
    strategyId: "rust",
    policyVersion: 1,
    capabilities: {
      comments: "full",
      imports: "full",
      commentSyntaxFamily: "rust",
    },
    match: (input) => {
      if (RUST_EXTENSIONS.includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) =>
      scanReadView({
        profile: buildRustProfile(),
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

const FRONTEND_SCRIPT_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
];

function createFrontendScriptStrategy(): ReadFormatStrategy {
  return {
    strategyId: "frontend-script",
    policyVersion: 1,
    capabilities: {
      comments: "full",
      imports: "full",
      commentSyntaxFamily: "c-family",
    },
    match: (input) => {
      if (FRONTEND_SCRIPT_EXTENSIONS.includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) =>
      scanFrontendScriptView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        supportsJsx: input.extension === ".jsx" || input.extension === ".tsx",
      }),
  };
}

const STYLE_SHEET_EXTENSIONS = [".css", ".scss", ".less", ".sass"];

function createStyleSheetStrategy(): ReadFormatStrategy {
  return {
    strategyId: "style-sheet",
    policyVersion: 1,
    capabilities: {
      comments: "full",
      imports: "full",
      commentSyntaxFamily: "c-family",
    },
    match: (input) => {
      if (STYLE_SHEET_EXTENSIONS.includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) =>
      scanStyleSheetView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        hasLineComments: input.extension !== ".css",
      }),
  };
}

interface MarkupStrategyDefinition {
  strategyId: string;
  extensions: string[];
  isScriptJsx: boolean;
}

const MARKUP_STRATEGY_DEFINITIONS: MarkupStrategyDefinition[] = [
  { strategyId: "html", extensions: [".html", ".htm"], isScriptJsx: false },
  { strategyId: "vue", extensions: [".vue"], isScriptJsx: false },
  { strategyId: "svelte", extensions: [".svelte"], isScriptJsx: false },
];

function createMarkupStrategy(
  definition: MarkupStrategyDefinition,
): ReadFormatStrategy {
  return {
    strategyId: definition.strategyId,
    policyVersion: 1,
    capabilities: {
      comments: "full",
      imports: "full",
      commentSyntaxFamily: "html",
    },
    match: (input) => {
      if (definition.extensions.includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) =>
      scanSectionedView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        isScriptJsx: definition.isScriptJsx,
        styleLanguageHint: null,
      }),
  };
}

function createLatexStrategy(): ReadFormatStrategy {
  return {
    strategyId: "latex",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "full", commentSyntaxFamily: "latex" },
    match: (input) => {
      if ([".tex", ".sty", ".cls"].includes(input.extension)) {
        return { isMatch: true, specificity: 10 };
      }
      return { isMatch: false, specificity: 0 };
    },
    buildView: (input) =>
      scanLatexView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

function createJsoncStrategy(): ReadFormatStrategy {
  return {
    strategyId: "jsonc",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "unsupported", commentSyntaxFamily: "c-family" },
    match: (input) =>
      input.extension === ".jsonc"
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanJsonLikeView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        hasComments: true,
        hasLineComments: true,
      }),
  };
}

function createJsonStrategy(): ReadFormatStrategy {
  return {
    strategyId: "json",
    policyVersion: 1,
    capabilities: { comments: "unsupported", imports: "unsupported", commentSyntaxFamily: null },
    match: (input) =>
      input.extension === ".json"
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanJsonLikeView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        hasComments: false,
        hasLineComments: false,
      }),
  };
}

function createYamlStrategy(): ReadFormatStrategy {
  return {
    strategyId: "yaml",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "unsupported", commentSyntaxFamily: "hash" },
    match: (input) =>
      [".yaml", ".yml"].includes(input.extension)
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanHashCommentDocumentView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        isYaml: true,
      }),
  };
}

function createTomlStrategy(): ReadFormatStrategy {
  return {
    strategyId: "toml",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "unsupported", commentSyntaxFamily: "hash" },
    match: (input) =>
      input.extension === ".toml"
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanHashCommentDocumentView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
        isYaml: false,
      }),
  };
}

function createMarkdownStrategy(): ReadFormatStrategy {
  return {
    strategyId: "markdown",
    policyVersion: 1,
    capabilities: { comments: "partial", imports: "unsupported", commentSyntaxFamily: "html" },
    match: (input) =>
      [".md", ".markdown"].includes(input.extension)
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanMarkdownView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

function createPlainTextStrategy(): ReadFormatStrategy {
  return {
    strategyId: "plain-text",
    policyVersion: 1,
    capabilities: { comments: "unsupported", imports: "unsupported", commentSyntaxFamily: null },
    match: (input) =>
      input.extension === ".txt"
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanPlainTextView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

function createGoStrategy(): ReadFormatStrategy {
  return {
    strategyId: "go",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "full", commentSyntaxFamily: "c-family" },
    match: (input) =>
      input.extension === ".go"
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanGoView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

function createShellStrategy(): ReadFormatStrategy {
  return {
    strategyId: "shell",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "full", commentSyntaxFamily: "hash" },
    match: (input) =>
      [".sh", ".bash", ".zsh"].includes(input.extension)
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanShellView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

function createSqlStrategy(): ReadFormatStrategy {
  return {
    strategyId: "sql",
    policyVersion: 1,
    capabilities: { comments: "full", imports: "unsupported", commentSyntaxFamily: "sql" },
    match: (input) =>
      input.extension === ".sql"
        ? { isMatch: true, specificity: 10 }
        : { isMatch: false, specificity: 0 },
    buildView: (input) =>
      scanSqlView({
        sourceText: input.sourceText,
        shouldIncludeComments: input.shouldIncludeComments,
        shouldIncludeImports: input.shouldIncludeImports,
      }),
  };
}

export const DEFAULT_READ_FORMAT_STRATEGIES: ReadFormatStrategy[] = [
  createCFamilyStrategy(),
  createPythonStrategy(),
  createRustStrategy(),
  createFrontendScriptStrategy(),
  createStyleSheetStrategy(),
  ...MARKUP_STRATEGY_DEFINITIONS.map((definition) =>
    createMarkupStrategy(definition),
  ),
  createLatexStrategy(),
  createJsoncStrategy(),
  createJsonStrategy(),
  createYamlStrategy(),
  createTomlStrategy(),
  createMarkdownStrategy(),
  createPlainTextStrategy(),
  createGoStrategy(),
  createShellStrategy(),
  createSqlStrategy(),
];

export class ReadFormatStrategyRegistry {
  private readonly strategies: ReadFormatStrategy[];

  constructor(strategies: ReadFormatStrategy[] = DEFAULT_READ_FORMAT_STRATEGIES) {
    this.strategies = [...strategies];
  }

  listStrategies(): ReadFormatStrategy[] {
    return [...this.strategies];
  }

  resolve(input: {
    fileName: string;
    extension?: string;
    contentSample?: string;
  }): ReadFormatStrategy | null {
    const extension = input.extension ?? extensionOf(input.fileName);
    const contentSample = input.contentSample ?? "";
    let selected: ReadFormatStrategy | null = null;
    let selectedSpecificity = -1;
    for (const strategy of this.strategies) {
      const matchResult = strategy.match({
        fileName: input.fileName,
        extension,
        contentSample,
      });
      if (
        matchResult.isMatch &&
        matchResult.specificity > selectedSpecificity
      ) {
        selected = strategy;
        selectedSpecificity = matchResult.specificity;
      }
    }
    return selected;
  }

  /** 生成读取回执；未支持格式返回原文并显式标注 unsupported。 */
  buildReadView(request: {
    filePath: string;
    sourceText: string;
    shouldIncludeComments?: boolean;
    shouldIncludeImports?: boolean;
    isSensitiveCheckApplied?: boolean;
  }): ReadViewReceipt {
    const shouldIncludeComments = request.shouldIncludeComments ?? true;
    const shouldIncludeImports = request.shouldIncludeImports ?? true;
    const extension = extensionOf(request.filePath);
    const sourceHash = computeSourceHash(request.sourceText);
    const strategy = this.resolve({
      fileName: request.filePath,
      extension,
      contentSample: request.sourceText.slice(0, 400),
    });
    const baseReceipt = {
      filePath: request.filePath,
      sourceRevisionKind: "content-hash" as const,
      sourceRevision: sourceHash,
      sourceHash,
      viewParameters: { shouldIncludeComments, shouldIncludeImports },
      sensitiveCheckAppliedBeforeView: request.isSensitiveCheckApplied === true,
      measurementKind: "utf-8-bytes" as const,
      budgetImpact: "same-file" as const,
    };
    if (strategy === null) {
      return {
        ...baseReceipt,
        policyVersion: 0,
        strategyId: "unsupported",
        capabilities: {
          comments: "unsupported",
          imports: "unsupported",
          commentSyntaxFamily: null,
        },
        filterStatus: "unsupported",
        omittedKinds: [],
        omittedLineRanges: [],
        retainedConstructs: [],
        lineMap: [],
        isViewComplete: true,
        isFilterable: false,
        limitations: ["format-unsupported: 无匹配读取策略，已返回原文"],
        measuredUnits: Buffer.byteLength(request.sourceText, "utf8"),
        viewText: request.sourceText,
      };
    }
    const viewResult = strategy.buildView({
      fileName: request.filePath,
      extension,
      sourceText: request.sourceText,
      shouldIncludeComments,
      shouldIncludeImports,
    });
    const isFilterable =
      viewResult.filterStatus !== "unsupported" &&
      viewResult.filterStatus !== "parse-error";
    return {
      ...baseReceipt,
      policyVersion: strategy.policyVersion,
      strategyId: strategy.strategyId,
      capabilities: strategy.capabilities,
      filterStatus: viewResult.filterStatus,
      omittedKinds: [...viewResult.omittedKinds],
      omittedLineRanges: [...viewResult.omittedLineRanges],
      retainedConstructs: [...viewResult.retainedConstructs],
      lineMap: [...viewResult.lineMap],
      isViewComplete: viewResult.isViewComplete,
      isFilterable,
      limitations: [...viewResult.limitations],
      measuredUnits: Buffer.byteLength(viewResult.viewText, "utf8"),
      viewText: viewResult.viewText,
    };
  }
}

export const defaultReadFormatStrategyRegistry = new ReadFormatStrategyRegistry();