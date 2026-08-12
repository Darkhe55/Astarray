/**
 * 敏感信息脱敏层（T02）。
 * 用于日志、错误消息、快照与交付报告；API key、Authorization 和用户 secret 一律替换为占位符。
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export const REDACTED_PLACEHOLDER = "[REDACTED]";

export function createDefaultRedactionRules(): RedactionRule[] {
  return [
    {
      name: "authorization-header",
      pattern:
        /(Authorization[ \t]*:[ \t]*(?:Bearer|Basic)[ \t]+)[A-Za-z0-9._~+/=:-]+/gi,
      replacement: `$1${REDACTED_PLACEHOLDER}`,
    },
    {
      name: "openai-style-api-key",
      pattern: /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
      replacement: REDACTED_PLACEHOLDER,
    },
    {
      name: "aws-access-key-id",
      pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
      replacement: REDACTED_PLACEHOLDER,
    },
    {
      name: "json-credential-field",
      pattern:
        /("(?:api[_-]?key|apikey|secret|token|password|access[_-]?key)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
      replacement: `$1${REDACTED_PLACEHOLDER}`,
    },
    {
      name: "generic-credential-assignment",
      pattern:
        /((?:api[_-]?key|apikey|secret|token|password|access[_-]?key)\s*=\s*)[A-Za-z0-9._~+/=-]{8,}/gi,
      replacement: `$1${REDACTED_PLACEHOLDER}`,
    },
  ];
}

export class Redactor {
  constructor(private readonly rules: RedactionRule[] = createDefaultRedactionRules()) {}

  redact(input: string): string {
    let output = input;
    for (const rule of this.rules) {
      output = output.replace(rule.pattern, rule.replacement);
    }
    return output;
  }

  /** 断言式校验：包含任一敏感模式即视为脱敏失败（供测试与审计使用）。 */
  containsSensitivePattern(input: string): boolean {
    // 先剔除已替换的占位符，避免规则与其自身输出自匹配
    const withoutPlaceholders = input.split(REDACTED_PLACEHOLDER).join("");
    return this.rules.some((rule) => {
      rule.pattern.lastIndex = 0;
      return rule.pattern.test(withoutPlaceholders);
    });
  }
}
