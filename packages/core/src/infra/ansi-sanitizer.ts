/**
 * ANSI/OSC 控制序列清洗（T10/T12）。
 * 来自模型与工具输出的控制序列必须清洗，防止终端注入。
 */

const ANSI_OSC_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B](?:[[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

export function stripAnsiControlSequences(input: string): string {
  return input.replace(ANSI_OSC_PATTERN, "");
}

export function containsAnsiControlSequences(input: string): boolean {
  ANSI_OSC_PATTERN.lastIndex = 0;
  return ANSI_OSC_PATTERN.test(input);
}
