/**
 * 安装操作效果分类器（T06E / ADR-0019 §1）。
 * 按实际效果识别安装尝试，不依赖可绕过的命令字符串：
 * - 代码库 clone/download/vendor；
 * - 项目依赖新增/更新（npm/pnpm/yarn/pip/uv/poetry/cargo 等）；
 * - 运行时/编译器/浏览器、插件/技能/模型、工具链与系统包安装；
 * - 生命周期安装脚本（preinstall/postinstall）、lockfile/vendor 改写
 *   和依赖解析变化。
 * 包装 shell/脚本/别名不能绕过：分类基于规范化参数效果判定，
 * 未知/不确定一律 fail-closed（按安装尝试处理）。
 */
export const INSTALLATION_RULES_VERSION = 1;

export type InstallationEffectKind =
  | "package-manager-install"
  | "repository-clone"
  | "vendor-or-lockfile-mutation"
  | "plugin-skill-model-install"
  | "runtime-toolchain-install"
  | "system-package-install"
  | "lifecycle-script"
  | "dependency-resolution-change"
  | "not-installation";

export interface InstallationClassification {
  isInstallationAttempt: boolean;
  effectKind: InstallationEffectKind;
  /** 识别到的关键目标（包名/仓库/命令）。 */
  detectedTarget: string | null;
  /** 精确版本/commit（可得时）。 */
  pinnedVersionOrCommit: string | null;
  rulesVersion: number;
}

/** 包管理器安装子命令（规范化小写比较）。 */
const PACKAGE_MANAGER_INSTALL_COMMANDS = new Map<string, Set<string>>([
  ["npm", new Set(["install", "i", "ci", "add"])],
  ["pnpm", new Set(["install", "i", "add"])],
  ["yarn", new Set(["add", "install"])],
  ["pip", new Set(["install"])],
  ["pip3", new Set(["install"])],
  ["uv", new Set(["pip", "add", "sync"])],
  ["poetry", new Set(["add", "install"])],
  ["cargo", new Set(["install", "add"])],
  ["gem", new Set(["install"])],
  ["composer", new Set(["install", "require", "update"])],
  ["nuget", new Set(["install", "add"])],
]);

/** 系统包管理器（影响系统范围）。 */
const SYSTEM_PACKAGE_MANAGERS = new Set([
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "brew",
  "pacman",
  "choco",
  "winget",
  "scoop",
]);

/** 生命周期安装脚本（npm/pnpm/yarn 钩子）。 */
const LIFECYCLE_SCRIPT_PATTERNS = [
  /(^|[/\\])(preinstall|postinstall|install)$/i,
  /package[\\/]?\.json["']?\s*$/i,
];

/** 已知明确非安装的普通/只读命令（白名单；其余一律 fail-closed）。 */
const KNOWN_NON_INSTALLATION_COMMANDS = new Set([
  "ls",
  "dir",
  "cat",
  "type",
  "echo",
  "pwd",
  "cd",
  "rm",
  "del",
  "mkdir",
  "cp",
  "copy",
  "mv",
  "move",
  "touch",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "node",
  "nodejs",
  "npm",
  "pnpm",
  "yarn",
  "tsc",
  "eslint",
  "vitest",
  "jest",
  "prettier",
  "git",
  "date",
  "whoami",
  "env",
  "printenv",
  "uname",
  "hostname",
  "ps",
  "tasklist",
  "sleep",
  "timeout",
]);

export class InstallationOperationClassifier {
  /**
   * 分类一条命令（argv 形式，已由调用方安全拆分——不经 shell 拼接）。
   * 效果判定优先于名称匹配；未知命令按 fail-closed 安装尝试处理
   * （由后续门禁拒绝或询问，而非静默放行）。
   */
  classifyCommand(input: {
    commandName: string;
    arguments: string[];
    workingDirectoryPath: string | null;
  }): InstallationClassification {
    const normalizedName = input.commandName.trim().toLowerCase();
    const target = input.arguments.find((argument) => !argument.startsWith("-")) ?? null;
    // 1) 包管理器安装
    const installSubcommand = PACKAGE_MANAGER_INSTALL_COMMANDS.get(normalizedName);
    if (installSubcommand !== undefined) {
      const subcommand = input.arguments[0]?.toLowerCase();
      if (subcommand !== undefined && installSubcommand.has(subcommand)) {
        const pinnedVersion = this.extractPinnedVersion(input.arguments);
        return {
          isInstallationAttempt: true,
          effectKind: "package-manager-install",
          detectedTarget: target ?? normalizedName,
          pinnedVersionOrCommit: pinnedVersion,
          rulesVersion: INSTALLATION_RULES_VERSION,
        };
      }
    }
    // 2) 系统包管理器
    if (SYSTEM_PACKAGE_MANAGERS.has(normalizedName)) {
      const subcommand = input.arguments[0]?.toLowerCase();
      if (
        subcommand === "install" ||
        subcommand === "add" ||
        subcommand === "upgrade" ||
        subcommand === "update"
      ) {
        return {
          isInstallationAttempt: true,
          effectKind: "system-package-install",
          detectedTarget: target ?? normalizedName,
          pinnedVersionOrCommit: null,
          rulesVersion: INSTALLATION_RULES_VERSION,
        };
      }
    }
    // 3) git clone / download / vendor
    if (normalizedName === "git" && input.arguments[0]?.toLowerCase() === "clone") {
      return {
        isInstallationAttempt: true,
        effectKind: "repository-clone",
        detectedTarget: target ?? null,
        pinnedVersionOrCommit: this.extractGitCloneRevision(input.arguments),
        rulesVersion: INSTALLATION_RULES_VERSION,
      };
    }
    if (
      (normalizedName === "download" ||
        normalizedName === "curl" ||
        normalizedName === "wget") &&
      input.arguments.some(
        (argument) =>
          /\.(zip|tar\.gz|tgz|whl|vsix)$/i.test(argument) ||
          argument.includes("/archive/") ||
          argument.includes("github.com/"),
      )
    ) {
      return {
        isInstallationAttempt: true,
        effectKind: "repository-clone",
        detectedTarget: target ?? null,
        pinnedVersionOrCommit: null,
        rulesVersion: INSTALLATION_RULES_VERSION,
      };
    }
    // 4) 插件/技能/模型/工具链安装（扩展安装命令）
    if (normalizedName === "code" || normalizedName === "code-insiders") {
      if (input.arguments[0] === "--install-extension") {
        return {
          isInstallationAttempt: true,
          effectKind: "plugin-skill-model-install",
          detectedTarget: target ?? normalizedName,
          pinnedVersionOrCommit: null,
          rulesVersion: INSTALLATION_RULES_VERSION,
        };
      }
    }
    if (normalizedName === "gh" || normalizedName === "glab") {
      if (input.arguments[0]?.toLowerCase() === "extension" && input.arguments[1] === "install") {
        return {
          isInstallationAttempt: true,
          effectKind: "plugin-skill-model-install",
          detectedTarget: target ?? normalizedName,
          pinnedVersionOrCommit: null,
          rulesVersion: INSTALLATION_RULES_VERSION,
        };
      }
    }
    if (/^(rustup|nvm|fnm|volta|sdkman)$/i.test(normalizedName)) {
      const subcommand = input.arguments[0]?.toLowerCase();
      if (subcommand === "install" || subcommand === "use") {
        return {
          isInstallationAttempt: true,
          effectKind: "runtime-toolchain-install",
          detectedTarget: target ?? normalizedName,
          pinnedVersionOrCommit: null,
          rulesVersion: INSTALLATION_RULES_VERSION,
        };
      }
    }
    // 4b) 包装 shell 的 -c/-Command 内嵌脚本：递归解析内容，别名/包装不可绕
    if (
      (normalizedName === "sh" ||
        normalizedName === "bash" ||
        normalizedName === "zsh" ||
        normalizedName === "cmd") &&
      (input.arguments[0] === "-c" || input.arguments[0] === "/c")
    ) {
      const scriptContent = input.arguments[1];
      if (typeof scriptContent === "string" && scriptContent.trim() !== "") {
        // 多命令脚本：按 ; 与 && 分段，任一段含安装 → 整体安装尝试
        const segments = scriptContent.split(/[;&|]+/);
        let hasEffectiveSegment = false;
        for (const segment of segments) {
          const segmentArguments = segment.trim().split(/\s+/);
          const segmentCommandName = segmentArguments.shift() ?? "";
          if (segmentCommandName === "") {
            continue;
          }
          hasEffectiveSegment = true;
          const nestedClassification = this.classifyCommand({
            commandName: segmentCommandName,
            arguments: segmentArguments,
            workingDirectoryPath: input.workingDirectoryPath,
          });
          if (nestedClassification.isInstallationAttempt) {
            return {
              ...nestedClassification,
              effectKind: "dependency-resolution-change",
            };
          }
        }
        // 全部段均明确非安装 → 非安装；无有效段（空/纯分隔符）→ fail-closed
        if (hasEffectiveSegment) {
          return {
            isInstallationAttempt: false,
            effectKind: "not-installation",
            detectedTarget: null,
            pinnedVersionOrCommit: null,
            rulesVersion: INSTALLATION_RULES_VERSION,
          };
        }
      }
    }
    if (normalizedName === "powershell" || normalizedName === "pwsh") {
      const commandIndex = input.arguments.indexOf("-Command");
      if (commandIndex !== -1) {
        const scriptContent = input.arguments[commandIndex + 1];
        if (typeof scriptContent === "string" && scriptContent.trim() !== "") {
          const segments = scriptContent.split(/[;&|]+/);
          let hasEffectiveSegment = false;
          for (const segment of segments) {
            const segmentArguments = segment.trim().split(/\s+/);
            const segmentCommandName = segmentArguments.shift() ?? "";
            if (segmentCommandName === "") {
              continue;
            }
            hasEffectiveSegment = true;
            const nestedClassification = this.classifyCommand({
              commandName: segmentCommandName,
              arguments: segmentArguments,
              workingDirectoryPath: input.workingDirectoryPath,
            });
            if (nestedClassification.isInstallationAttempt) {
              return {
                ...nestedClassification,
                effectKind: "dependency-resolution-change",
              };
            }
          }
          if (hasEffectiveSegment) {
            return {
              isInstallationAttempt: false,
              effectKind: "not-installation",
              detectedTarget: null,
              pinnedVersionOrCommit: null,
              rulesVersion: INSTALLATION_RULES_VERSION,
            };
          }
        }
      }
    }
    // 5) lockfile/vendor 改写与生命周期脚本（直接执行的脚本名）
    if (LIFECYCLE_SCRIPT_PATTERNS.some((pattern) => pattern.test(normalizedName))) {
      return {
        isInstallationAttempt: true,
        effectKind: "lifecycle-script",
        detectedTarget: normalizedName,
        pinnedVersionOrCommit: null,
        rulesVersion: INSTALLATION_RULES_VERSION,
      };
    }
    // 6) 依赖解析变化（yarn.lock/package-lock.json/pnpm-lock.yaml/vendor 目录写入）
    if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock)$/i.test(input.commandName)) {
      return {
        isInstallationAttempt: true,
        effectKind: "vendor-or-lockfile-mutation",
        detectedTarget: input.commandName,
        pinnedVersionOrCommit: null,
        rulesVersion: INSTALLATION_RULES_VERSION,
      };
    }
    // 7) 已知普通/只读命令：明确不是安装（白名单）。
    if (
      KNOWN_NON_INSTALLATION_COMMANDS.has(normalizedName) ||
      (normalizedName === "git" && !input.arguments[0]?.startsWith("-"))
    ) {
      return {
        isInstallationAttempt: false,
        effectKind: "not-installation",
        detectedTarget: null,
        pinnedVersionOrCommit: null,
        rulesVersion: INSTALLATION_RULES_VERSION,
      };
    }
    // 8) 其余未知命令（含绝对路径可执行文件、大小写变体、间接脚本）：
    //    副作用无法确定 → fail-closed 按安装尝试处理，由门禁拒绝或询问。
    //    （B6R-01：未知非空命令不得返回 not-installation。）
    return {
      isInstallationAttempt: true,
      effectKind: "dependency-resolution-change",
      detectedTarget: input.commandName,
      pinnedVersionOrCommit: null,
      rulesVersion: INSTALLATION_RULES_VERSION,
    };
  }

  /** 从参数提取精确版本（@x.y.z / ==x.y.z / :commit）。 */
  private extractPinnedVersion(arguments_: string[]): string | null {
    for (const argument of arguments_) {
      const versionMatch = argument.match(/[@=:]([0-9][0-9.]*([.-][0-9a-zA-Z]+)?)$/);
      if (versionMatch !== null) {
        return versionMatch[1]!;
      }
    }
    return null;
  }

  /** git clone 的 -b <branch>/--branch 或 commit 参数。 */
  private extractGitCloneRevision(arguments_: string[]): string | null {
    for (let index = 0; index < arguments_.length - 1; index++) {
      const argument = arguments_[index]!;
      if (argument === "-b" || argument === "--branch") {
        return arguments_[index + 1] ?? null;
      }
    }
    return null;
  }
}
