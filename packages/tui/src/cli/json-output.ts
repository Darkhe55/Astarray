/**
 * Headless CLI JSON 输出与退出码约定（T11）。
 * --json 模式：stdout 只输出机器可解析结果；日志与警告写 stderr。
 */

export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE_ERROR: 2,
} as const;

export function printJson(output: unknown): void {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export function logToStderr(message: string): void {
  process.stderr.write(`astarray: ${message}\n`);
}

export function failWith(
  error: Error,
  exitCode: number = EXIT_CODES.FAILURE,
): never {
  logToStderr(error.message);
  process.exit(exitCode);
}
