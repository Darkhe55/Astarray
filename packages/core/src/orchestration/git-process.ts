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
  /**
   * 受控可执行文件路径；默认 "git"。仅供装配与测试注入可控夹具
   * （如可握手、可回收的常驻子进程），不接受模型输入或任意用户参数。
   */
  executablePath?: string;
  /** 追加在可执行文件之前的固定参数（例如夹具脚本路径）。 */
  executableArgumentsPrefix?: readonly string[];
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
  private readonly executablePath: string;
  private readonly executableArgumentsPrefix: readonly string[];

  constructor(options: GitProcessOptions = {}) {
    this.timeoutSeconds = options.gitCommandTimeoutSeconds ?? 60;
    this.executablePath = options.executablePath ?? "git";
    this.executableArgumentsPrefix = options.executableArgumentsPrefix ?? [];
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
      const childProcess = spawn(
        this.executablePath,
        [...this.executableArgumentsPrefix, ...gitArguments],
        {
          cwd: workingDirectoryPath,
          windowsHide: true,
          /**
           * RELIABILITY-01-02（2026-10-10 Linux 实测修复）：在 POSIX 上让子进程
           * **自成一个进程组**，超时才可能**整组收口**。
           *
           * 此前只 `childProcess.kill("SIGKILL")` 杀**直接子进程**，它派生的孙进程
           * 会被 init 收养并**继续运行**（继续写盘/占句柄）。该缺陷在 Windows 上
           * 观察不到（Windows 无进程组语义、且树形终止方式不同），
           * 因此**只有 Linux/macOS 证据才能发现** —— 本会话在 WSL 中复现：
           * `reliability-git-process-tree.test.ts` ① 确定性失败（心跳持续增长）。
           *
           * `detached: true` 只影响进程组归属，**不** detach 生命周期：
           * 未调用 `unref()`，stdio 仍是管道，父进程照常等 `close`。
           */
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "echo",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
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
        /**
         * **整棵进程树**收口，而不是只杀直接子进程（见上方 spawn 处说明）。
         *
         * - POSIX：子进程已是进程组首进程 ⇒ 用 `process.kill(-pid)` 对**整组**发
         *   SIGKILL，孙进程一并收口。若进程已退出（`ESRCH`）则忽略。
         * - Windows：用 `taskkill /T /F` 递归终止（无进程组语义）。
         */
        if (process.platform !== "win32") {
          try {
            process.kill(-childProcess.pid!, "SIGKILL");
          } catch {
            /** 进程组已不存在（`ESRCH`）⇒ 已经收口，无需处理。 */
          }
        } else {
          try {
            spawn("taskkill", ["/pid", String(childProcess.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          } catch {
            /** taskkill 不可用时退回仅杀直接子进程（下方仍会执行）。 */
          }
        }
        /** 兜底：即便整组收口失败，也要保证直接子进程被终止。 */
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
