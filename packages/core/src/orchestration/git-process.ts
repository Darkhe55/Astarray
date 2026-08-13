/**
 * Git 底层进程执行器（T05B）。
 * 职责：以受控方式执行 git 命令，返回结构化输出；禁止把任意用户输入拼进参数。
 * 本层只负责执行与输出收集；危险操作策略（备份、合并选边、强制移动等）由
 * GitRecoveryPointService 与 GitIntegrationCoordinator 在调用前/后执行，
 * 本层不开放任意参数透传。
 */
import { spawn } from "node:child_process";

export interface GitProcessOptions {
  /** 单条命令超时（秒），默认 60。 */
  gitCommandTimeoutSeconds?: number;
}

export interface GitCommandResult {
  commandDescription: string;
  stdoutText: string;
  stderrText: string;
  exitCode: number;
  durationSeconds: number;
}

export class GitProcessError extends Error {
  constructor(
    message: string,
    readonly result: GitCommandResult,
  ) {
    super(message);
    this.name = "GitProcessError";
  }
}

export class GitProcess {
  private readonly timeoutSeconds: number;

  constructor(options: GitProcessOptions = {}) {
    this.timeoutSeconds = options.gitCommandTimeoutSeconds ?? 60;
  }

  /**
   * 执行 git 命令。所有参数必须由调用方（受控工具）构造，禁止透传模型输入。
   * 成功返回结构化结果；非零退出抛 GitProcessError（携带完整输出）。
   */
  async run(
    workingDirectoryPath: string,
    gitArguments: string[],
    commandDescription: string,
  ): Promise<GitCommandResult> {
    const startedAtMs = Date.now();
    const result = await new Promise<GitCommandResult>((resolve, reject) => {
      const childProcess = spawn("git", gitArguments, {
        cwd: workingDirectoryPath,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      let stdoutText = "";
      let stderrText = "";
      childProcess.stdout.setEncoding("utf8");
      childProcess.stderr.setEncoding("utf8");
      childProcess.stdout.on("data", (chunk: string) => {
        stdoutText += chunk;
      });
      childProcess.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
      });
      const timeoutMs = this.timeoutSeconds * 1000;
      let didTimeOut = false;
      const timeoutHandle = setTimeout(() => {
        didTimeOut = true;
        childProcess.kill("SIGKILL");
      }, timeoutMs);
      childProcess.on("error", (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
      childProcess.on("close", (exitCode) => {
        clearTimeout(timeoutHandle);
        const durationSeconds = (Date.now() - startedAtMs) / 1000;
        if (didTimeOut) {
          // 超时后 kill：等待子进程真正退出（释放句柄）再拒绝
          reject(
            new Error(
              `git 命令超时（${this.timeoutSeconds} 秒）: ${commandDescription}`,
            ),
          );
          return;
        }
        const commandResult: GitCommandResult = {
          commandDescription,
          stdoutText,
          stderrText,
          exitCode: exitCode ?? -1,
          durationSeconds,
        };
        if (commandResult.exitCode !== 0) {
          reject(new GitProcessError(commandDescription, commandResult));
        } else {
          resolve(commandResult);
        }
      });
    });
    return result;
  }

  /** 仅检查 git 是否可用（供装配/测试）。 */
  static async isGitAvailable(): Promise<boolean> {
    try {
      const process = new GitProcess({ gitCommandTimeoutSeconds: 10 });
      await process.run(".", ["--version"], "检查 git 可用性");
      return true;
    } catch {
      return false;
    }
  }
}
