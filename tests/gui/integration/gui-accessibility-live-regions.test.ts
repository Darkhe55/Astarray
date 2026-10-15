/**
 * 可访问性反例（2026-11-08）：**`aria-live` 不得挂在会被整块替换的列表容器上**。
 *
 * ## 由来（真实用户人工体验暴露，不是推测）
 *
 * 用户用屏幕阅读器翻恢复中心的页码时报：
 * 「翻页后，**直接读出了任务列表的内容，没有去读页面**」。
 *
 * ## 根因（已从代码确认）
 *
 * `#recovery` 是 `<ul id="recovery" aria-live="polite">`，里面有 20 个 `<li>`；
 * 翻页时 `refreshRecovery()` 把**整个 ul 的内容一次性替换**
 * （`recoveryElement.textContent = ""` 后重新 append）。
 * ⇒ 该 live region **整体突变** ⇒ 屏幕阅读器**把 20 条列表念一遍**，
 * 把真正该播报的「第 N / M 页（共 X 条）」（`#recovery-paging`）**淹没/排队**在后面。
 *
 * 这是 ARIA 的典型误用：**live region 只该覆盖"简短、会变、需要被念"的状态文本**，
 * 不该覆盖"会被整块替换的长列表"。
 *
 * ## ⚠️ 为什么既有守卫没拦住
 *
 * `gui-ux-accessibility.test.ts` 里那条断言是
 * `(page.match(/aria-live="polite"/g)).length >= 6`，并且把 `recovery`／`verifications`
 * 列进"应存在的 live 区"清单 ⇒ 它**只鼓励数量、不约束位置**，
 * 于是把这个错误设计**固化了**。本文件补上"位置"这一维。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import http from "node:http";

import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

let stateDirectory: string;
let servers: Array<{ close(): Promise<void> }>;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-a11y-live-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await server.close().catch(() => {});
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 最小只读端口：本文件只关心**页面标记**，不驱动任何业务。 */
function createMinimalPort(): never {
  return {
    subscribe: () => ({ unsubscribe: () => {} }),
    submitTask: async () => ({
      taskIdentifier: "t",
      missionIdentifier: null,
      status: "accepted",
    }),
    cancelTask: async () => {},
  } as never;
}

async function getPageHtml(): Promise<string> {
  const handle = await startGuiServer({
    applicationService: createMinimalPort(),
    sessionId: "session-a11y-live",
    mode: "assist",
    csrfTokenFactory: () => "csrf-token-a11y-live",
  });
  servers.push(handle);
  return new Promise<string>((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: "/",
          headers: { host: "127.0.0.1:" + String(handle.port) },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      )
      .on("error", reject);
  });
}

/** 取出某个 id 的**起始标签**（用于检查其属性）。 */
function openingTagForId(page: string, identifier: string): string {
  const pattern = new RegExp('<[^>]*id="' + identifier + '"[^>]*>');
  const match = pattern.exec(page);
  return match === null ? "" : match[0];
}

describe("可访问性：aria-live 的位置约束", () => {
  it("① 会被**整块替换**的列表容器**不得**是 live region", async () => {
    const page = await getPageHtml();

    /**
     * 这五个都是"清空后重新 append 整批条目"的容器。
     * 若它们是 live region，翻页/刷新会把整批条目念一遍，淹没真正的状态播报
     * —— 用户实测报的正是这个现象。
     */
    for (const bulkListIdentifier of [
      "recovery",
      "tasks",
      "verifications",
      "permission-asks",
      "installation-inquiries",
    ]) {
      const openingTag = openingTagForId(page, bulkListIdentifier);
      expect(openingTag, "#" + bulkListIdentifier + " 的容器标签未找到").not.toBe("");
      expect(
        openingTag.includes("aria-live"),
        "#" + bulkListIdentifier + " 是会被整块替换的列表容器，不得挂 aria-live",
      ).toBe(false);
    }
  });

  it("② 简洁的**状态文本**元素必须仍是 live region（否则什么都不会被播报）", async () => {
    const page = await getPageHtml();

    for (const statusIdentifier of [
      "submit-result",
      "recovery-paging",
      "history-paging",
      "recovery-resume-result",
      "verification-result",
      "permission-ask-result",
    ]) {
      const openingTag = openingTagForId(page, statusIdentifier);
      expect(openingTag, "#" + statusIdentifier + " 未找到").not.toBe("");
      expect(
        openingTag.includes('aria-live="polite"'),
        "#" + statusIdentifier + " 是状态文本，必须能被播报",
      ).toBe(true);
    }
  });

  it("③ 仍保留足够数量的 live 区（防止一刀切删光）", async () => {
    const page = await getPageHtml();
    expect((page.match(/aria-live="polite"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("④ 翻页时状态文本必须自带页码与总数（否则播报没有信息量）", async () => {
    const page = await getPageHtml();
    // 页面脚本里写出的播报文本必须含"第 N / M 页"与"共 X 条"
    expect(page).toContain("第 ");
    expect(page).toContain(" 页（共 ");
    expect(page).toContain(" 条）");
  });
});
