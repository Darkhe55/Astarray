/**
 * T12-05：破坏性文件 API 静态架构守卫。
 *
 * 目标：生产源码（packages/core/src、packages/tui/src）中的破坏性文件操作
 * （删除/覆盖/改名/复制覆盖）只允许出现在逐项说明理由的白名单模块内，
 * 且每个文件只允许使用其声明的最小令牌集（rm/rmSync/unlink/unlinkSync/
 * writeFile/writeFileSync/copyFile/copyFileSync/rename）。truncate 不在列
 * （本地文本截断函数与 fs 无关）。扫描器自带单测，证明新增违规会被捕获。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type AllowedTokens = string[];

const TOKEN_PATTERN = new RegExp(
  `\\b(rm|rmSync|unlink|unlinkSync|writeFile|writeFileSync|copyFile|copyFileSync|rename)\\s*\\(`,
  "g",
);

/** 相对 packages/ 路径 → 允许的破坏性令牌（理由见注释/任务卡盘点表）。 */
const ALLOWED_MODULES: Record<string, { tokens: AllowedTokens; reason: string }> = {
  "core/src/infra/atomic-json.ts": {
    tokens: ["writeFile", "rm", "rename", "copyFile"],
    reason: "底层原子写/备份/陈旧临时文件清理白名单模块（atomic temp→rename、.bak copy、.tmp rm）",
  },
  "core/src/infra/mission-lease-store.ts": {
    tokens: ["writeFile", "rm"],
    reason: "跨进程租约：排他创建内容写入 + 瞬时租约文件释放 rm（T12-01，非用户内容）",
  },
  "core/src/tools/backup-vault.ts": {
    tokens: ["writeFile", "rm"],
    reason: "特权备份保管库自身（pre-image/恢复/隔离文件读写），受 ProtectedStoragePolicy 保护",
  },
  "core/src/tools/builtins.ts": {
    tokens: ["writeFile"],
    reason: "内置工具文件写入：wx 排他创建或经自动 pre-image 后的受控写；无删除/改名",
  },
  "core/src/tools/permission-profile-store.ts": {
    tokens: ["copyFile", "rm"],
    reason: "权限组存储管理自身 .bak 与清理；正文写入走原子写（此文件仅 copy/rm）",
  },
  "core/src/tools/session-permission-elevation.ts": {
    tokens: ["rm", "writeFile"],
    reason: "会话提升记录持久化（writeFile + 失效记录清理 rm）",
  },
  "core/src/tools/session-shutdown-and-export.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "权限导出覆盖前 .bak 备份后写入（copyFile→writeFile）",
  },
  "core/src/tools/tool-documentation-recall.ts": {
    tokens: ["writeFile"],
    reason: "工具说明回执存储写入（单文件内容写入）",
  },
  "core/src/orchestration/agent-individual-memory.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "个体记忆归档写入：.bak 复制后写入",
  },
  "core/src/orchestration/main-agent-report-archive.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "主 Agent 报告索引写入：.bak 复制后写入",
  },
  "core/src/orchestration/project-reconnaissance-digest-store.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "侦察摘要存储：备份后写入",
  },
  "core/src/orchestration/craftsman-disclosure-store.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "工匠披露存储：备份后写入",
  },
  "core/src/orchestration/tertiary-lifecycle.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "三级生命周期阶段存储：备份后写入",
  },
  "core/src/orchestration/task-chain-cumulative-budget.ts": {
    tokens: ["writeFile"],
    reason: "任务链累计预算持久化写入",
  },
  "core/src/orchestration/stale-write-guard.ts": {
    tokens: ["writeFile"],
    reason: "陈旧写入保全（patch 保留内容写入）",
  },
  "core/src/orchestration/human-worktree-observer.ts": {
    tokens: ["writeFile"],
    reason: "人工变化 journal 写入",
  },
  "core/src/orchestration/recovery-checkpoint-store.ts": {
    tokens: ["writeFile", "copyFile", "rename"],
    reason: "检查点原子写（临时文件→rename）+ 损坏回退 .bak copy",
  },
  "core/src/orchestration/git-recovery-point-service.ts": {
    tokens: ["copyFile", "writeFile"],
    reason: "Git 恢复点 pre-image 保存（copyFile→writeFile）",
  },
  "tui/src/cli/commands.ts": {
    tokens: ["writeFile", "rm", "copyFile"],
    reason: "CLI：doctor 探针 wx 创建/唯一名清理、config init 写入、导出前 .bak 复制",
  },
  "tui/src/cli/provider-cli.ts": {
    tokens: ["writeFile"],
    reason: "Provider 配置文件写入（经受控备份路径）",
  },
};

export function detectDestructiveFileApiCalls(sourceCode: string): Set<string> {
  const found = new Set<string>();
  for (const match of sourceCode.matchAll(TOKEN_PATTERN)) {
    const capturedToken = match[1];
    if (capturedToken !== undefined) {
      found.add(capturedToken);
    }
  }
  return found;
}

async function collectSourceFiles(): Promise<string[]> {
  const roots = [
    path.join(process.cwd(), "packages", "core", "src"),
    path.join(process.cwd(), "packages", "tui", "src"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        files.push(...(await collectUnder(root, entry.name)));
      } else if (entry.name.endsWith(".ts")) {
        files.push(path.join(root, entry.name));
      }
    }
  }
  return files;
}

async function collectUnder(root: string, relativeDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const directoryPath = path.join(root, relativeDirectory);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectUnder(root, `${relativeDirectory}/${entry.name}`)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("破坏性文件 API 静态架构守卫（T12-05）", () => {
  it("扫描器能捕获新引入的违规调用（rmSync/unlink/writeFile 覆盖）", () => {
    const dirtySource =
      "import { rmSync } from 'node:fs';\nrmSync('/tmp/x');\nawait fs.unlink('/tmp/y');\nawait fs.writeFile('/tmp/z', 'x');\n";
    const found = detectDestructiveFileApiCalls(dirtySource);
    expect(found.has("rmSync")).toBe(true);
    expect(found.has("unlink")).toBe(true);
    expect(found.has("writeFile")).toBe(true);
    const cleanLocalFunctionSource =
      "function truncate(text: string) { return text.slice(0, 100); }";
    expect(detectDestructiveFileApiCalls(cleanLocalFunctionSource).size).toBe(0);
  });

  it("全部生产源码的破坏性调用都落在带理由的白名单模块内，且未使用超集令牌", async () => {
    const sourceFiles = await collectSourceFiles();
    const violations: string[] = [];
    for (const sourceFile of sourceFiles) {
      const relativePath = sourceFile.replace(path.join(process.cwd(), "packages") + path.sep, "").split(path.sep).join("/");
      const foundTokens = detectDestructiveFileApiCalls(
        await fs.readFile(sourceFile, "utf8"),
      );
      if (foundTokens.size === 0) {
        continue;
      }
      const allowEntry = ALLOWED_MODULES[relativePath];
      if (allowEntry === undefined) {
        violations.push(
          `${relativePath}: 不在白名单却使用破坏性 API ${[...foundTokens].join(",")}`,
        );
        continue;
      }
      const allowedSet = new Set(allowEntry.tokens);
      const unexpected = [...foundTokens].filter((token) => !allowedSet.has(token));
      if (unexpected.length > 0) {
        violations.push(
          `${relativePath}: 使用白名单外的令牌 ${unexpected.join(",")}（允许: ${[...allowedSet].join(",")}）`,
        );
      }
    }
    expect(violations).toEqual([]);
  }, 60_000);
});
