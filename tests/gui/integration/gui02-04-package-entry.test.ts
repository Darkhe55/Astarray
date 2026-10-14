/**
 * GUI-02-04（2026-11-08）：**包级可交付性**反例（先红后绿）。
 *
 * ## 卡内检查点原文
 *
 * > **GUI-02-04** | **重启与包级验收** —— 重启后界面不误导（明确"会话视图为空"≠数据丢失）；
 * > 恢复须显式 + 先对账 + 重新鉴权；**隔离 tarball 打开 GUI 复验**
 * > | `verify-package` / `smoke-install` exit 0；重启与恢复的真实操作证据
 *
 * ## 本文件钉住的前提条件（**先决于**"tarball 打开 GUI"）
 *
 * 实测发现：`tsup.config.ts` 的 entry 只有 `cli`／`feedback-process-entry`／`public-sdk`
 * ⇒ `packages/gui` 的代码只被打进一个**内部 chunk**（`dist/gui-server-*.js`），
 * **没有公开入口、也不在 `package.json` 的 `exports` 里**。
 * 后果：消费者**装上 tarball 也拿不到 GUI** ⇒ 卡内要求的"隔离 tarball 打开 GUI 复验"
 * **在本轮之前根本无法成立**。
 *
 * 故先钉住"GUI 有公开入口且真的可用"这件前提，再谈重启/恢复证据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui0204-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("GUI-02-04：GUI 必须有**公开包入口**（否则 tarball 里根本打不开）", () => {
  it("① `package.json` 的 `exports` 必须暴露一个 GUI 入口", async () => {
    const packageJsonText = await fs.readFile(path.resolve("package.json"), "utf8");
    const packageJson = JSON.parse(packageJsonText) as {
      exports?: Record<string, unknown>;
      files?: string[];
    };

    const exportKeys = Object.keys(packageJson.exports ?? {});
    // 至少有一个 GUI 入口（形如 "./gui"）
    const guiExportKey = exportKeys.find((key) => key === "./gui");
    expect(
      guiExportKey,
      "package.json exports 里缺少 GUI 入口（现有：" + exportKeys.join(", ") + "）",
    ).toBeDefined();
    // 且该入口指向 dist 下的产物
    const guiExport = packageJson.exports?.["./gui"] as { import?: string } | undefined;
    expect(typeof guiExport?.import).toBe("string");
    expect(String(guiExport?.import)).toMatch(/^\.\/dist\//);
  });

  it("② 构建产物里必须真的生成该入口文件（不是只在 exports 里写个名字）", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      exports?: { "./gui"?: { import?: string } };
    };
    const entryRelativePath = packageJson.exports?.["./gui"]?.import;
    expect(typeof entryRelativePath).toBe("string");

    // **必须真的存在**（否则消费者 require 时才会炸，而那时已经晚了）
    await expect(fs.access(path.resolve(String(entryRelativePath)))).resolves.toBeUndefined();
  });

  it("③ 从**构建产物**真实加载该入口，并确认 `startGuiServer` 可用", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      exports?: { "./gui"?: { import?: string } };
    };
    const entryPath = path.resolve(String(packageJson.exports?.["./gui"]?.import));
    const loadedModule = (await import(pathToFileURL(entryPath).href)) as {
      startGuiServer?: unknown;
    };

    expect(typeof loadedModule.startGuiServer).toBe("function");
  });

  it("④ 用**构建产物**真起一次 GUI 服务并取到页面（闭合「tarball 打开 GUI」的前提）", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      exports?: { "./gui"?: { import?: string } };
    };
    const entryPath = path.resolve(String(packageJson.exports?.["./gui"]?.import));
    const guiModule = (await import(pathToFileURL(entryPath).href)) as {
      startGuiServer: (input: {
        applicationService: unknown;
        stateDirectory?: string;
        sessionId?: string;
        mode?: string;
      }) => Promise<{ port: number; close(): Promise<void> }>;
    };

    const startedServer = await guiModule.startGuiServer({
      stateDirectory: temporaryDirectory,
      sessionId: "session-gui0204",
      mode: "assist",
      applicationService: {
        subscribe: () => ({ unsubscribe: () => {} }),
        submitTask: async () => ({ taskIdentifier: "t", missionIdentifier: null, status: "accepted" }),
        cancelTask: async () => {},
      },
    });
    try {
      /**
       * 2026-11-08（第 59 轮）：**先把"端口是不是可用端口"这件事查清楚**。
       *
       * 本条曾在**全量默认并发**下偶发（隔离单跑 8 次全绿）：
       *   `TypeError: fetch failed` / `Caused by: Error: bad port`
       * 而 `bad port` 只会在**地址里的端口不是有效端口**时出现
       * （`fetch` 侧表现为"端口非法"）。原始报错**完全看不出端口是多少**，
       * 所以我当时**没法归因**（这一轮我已因"没落盘完整输出"吃过一次亏）。
       *
       * 故这里显式断言端口是**有效端口**，并把**真实取值**写进失败消息 ——
       * 下次再出现就能立刻区分"句柄返回了 0/未定义"还是"端口被回收/耗尽"。
       */
      expect(
        Number.isInteger(startedServer.port) && startedServer.port > 0 && startedServer.port <= 65_535,
        "startGuiServer 返回了不可用的端口：" + JSON.stringify(startedServer.port),
      ).toBe(true);

      const response = await fetch("http://127.0.0.1:" + String(startedServer.port) + "/");
      expect(response.status).toBe(200);
      const pageText = await response.text();
      // 真的是 GUI 页面（不是错误页）
      expect(pageText).toContain("Astarray");
      expect(pageText).toContain('lang="zh-CN"');
    } finally {
      await startedServer.close();
    }
  });
});
