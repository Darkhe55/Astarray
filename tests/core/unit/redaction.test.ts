import { describe, expect, it } from "vitest";

import { createDefaultRedactionRules, Redactor } from "../../../packages/core/src/infra/redaction.js";

describe("Redactor 默认规则", () => {
  const redactor = new Redactor();

  it("脱敏 Authorization Bearer 头", () => {
    const input = "Authorization: Bearer sk-abcdefghijklmnop123456";
    const output = redactor.redact(input);
    expect(output).toContain("Authorization: Bearer [REDACTED]");
    expect(output).not.toContain("sk-abcdefghijklmnop123456");
  });

  it("脱敏 OpenAI 风格 api key", () => {
    const input = "key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const output = redactor.redact(input);
    expect(output).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(output).toContain("[REDACTED]");
  });

  it("脱敏 JSON 中的凭据字段", () => {
    const input = '{"apiKey":"super-secret-key-value-12345","path":"a.txt"}';
    const output = redactor.redact(input);
    expect(output).not.toContain("super-secret-key-value-12345");
    expect(output).toContain('"apiKey":"[REDACTED]"');
    expect(output).toContain('"path":"a.txt"');
  });

  it("脱敏 Authorization Basic 头", () => {
    const input = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const output = redactor.redact(input);
    expect(output).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(output).toContain("[REDACTED]");
  });

  it("不误伤普通文本", () => {
    const input = "读取文件 a.txt，共 42 行，路径 tmp/data.csv";
    const output = redactor.redact(input);
    expect(output).toBe(input);
  });

  it("脱敏后 containsSensitivePattern 返回 false", () => {
    const input = 'apiKey=abcdefghijklmnopqrstuvwxyz123456';
    const output = redactor.redact(input);
    expect(redactor.containsSensitivePattern(input)).toBe(true);
    expect(redactor.containsSensitivePattern(output)).toBe(false);
  });

  it("自定义规则可覆盖默认规则", () => {
    const customRedactor = new Redactor([
      {
        name: "custom-secret",
        pattern: /\bSECRET-\d+\b/g,
        replacement: "[CUSTOM-REDACTED]",
      },
    ]);
    const output = customRedactor.redact("SECRET-123456 与 SECRET-999999");
    expect(output).toBe("[CUSTOM-REDACTED] 与 [CUSTOM-REDACTED]");
  });

  it("默认规则列表名称唯一", () => {
    const rules = createDefaultRedactionRules();
    const ruleNames = rules.map((rule) => rule.name);
    expect(new Set(ruleNames).size).toBe(ruleNames.length);
  });
});
