/**
 * READ-FORMAT-03b：CSS/SCSS/Less 读取策略（ADR-0042）。
 *
 * - 注释：CSS 仅块注释；SCSS/Less 支持行注释与块注释；
 * - url(...) 中的 // 与 /* 不被当注释（含引号与转义）；
 * - @import/@use/@forward 可按需省略，语句内字符串保留。
 */
import {
  consumeQuotedString,
  scanReadView,
  type ImportStatementMatch,
  type ReadFormatScanProfile,
  type ReadViewBuildResult,
  type StringScanResult,
} from "./read-format-scanner.js";

function scanStyleSheetString(
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
  if (sourceText.slice(index, index + 4).toLowerCase() === "url(") {
    const previousCharacter = index === 0 ? "" : (sourceText[index - 1] as string);
    if (/[A-Za-z0-9_-]/.test(previousCharacter)) {
      return null;
    }
    let cursor = index + 4;
    let depth = 1;
    while (cursor < sourceText.length) {
      const currentCharacter = sourceText[cursor] as string;
      if (currentCharacter === "\\") {
        cursor += 2;
        continue;
      }
      if (currentCharacter === "\"" || currentCharacter === "'") {
        const stringResult = consumeQuotedString({
          sourceText,
          startIndex: cursor,
          quote: currentCharacter,
          supportsEscapes: true,
        });
        if (stringResult.isUnterminated) {
          return { endIndex: sourceText.length, isUnterminated: true };
        }
        cursor = stringResult.endIndex;
        continue;
      }
      if (currentCharacter === "(") {
        depth += 1;
      } else if (currentCharacter === ")") {
        depth -= 1;
        if (depth === 0) {
          return { endIndex: cursor + 1, isUnterminated: false };
        }
      } else if (currentCharacter === "\n") {
        return { endIndex: sourceText.length, isUnterminated: true };
      }
      cursor += 1;
    }
    return { endIndex: sourceText.length, isUnterminated: true };
  }
  return null;
}

function matchStyleSheetImportStatement(
  sourceText: string,
  index: number,
): ImportStatementMatch | null {
  const lineEndIndex = sourceText.indexOf("\n", index);
  const lineText = sourceText.slice(
    index,
    lineEndIndex === -1 ? sourceText.length : lineEndIndex,
  );
  if (!/^\s*@(?:import|use|forward)\b/.test(lineText)) {
    return null;
  }
  let cursor = index;
  let depth = 0;
  while (cursor < sourceText.length) {
    const character = sourceText[cursor] as string;
    if (character === "\"" || character === "'") {
      const stringResult = consumeQuotedString({
        sourceText,
        startIndex: cursor,
        quote: character,
        supportsEscapes: true,
      });
      if (stringResult.isUnterminated) {
        return null;
      }
      cursor = stringResult.endIndex;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
    } else if (character === ";" && depth === 0) {
      const statementEnd = cursor + 1;
      const trailingLineIndex = sourceText.indexOf("\n", statementEnd);
      const trailingText = sourceText.slice(
        statementEnd,
        trailingLineIndex === -1 ? sourceText.length : trailingLineIndex,
      ).trim();
      if (trailingText !== "" && !trailingText.startsWith("/*") && !trailingText.startsWith("//")) {
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
    cursor += 1;
  }
  return null;
}

export interface StyleSheetScanOptions {
  sourceText: string;
  shouldIncludeComments: boolean;
  shouldIncludeImports: boolean;
  hasLineComments: boolean;
}

export function scanStyleSheetView(
  options: StyleSheetScanOptions,
): ReadViewBuildResult {
  const profile: ReadFormatScanProfile = {
    strategyId: options.hasLineComments ? "scss" : "css",
    policyVersion: 1,
    lineCommentTokens: options.hasLineComments ? ["//"] : [],
    blockComment: { start: "/*", end: "*/", nested: false },
    scanString: scanStyleSheetString,
    matchImportStatement: matchStyleSheetImportStatement,
  };
  return scanReadView({
    profile,
    sourceText: options.sourceText,
    shouldIncludeComments: options.shouldIncludeComments,
    shouldIncludeImports: options.shouldIncludeImports,
  });
}
