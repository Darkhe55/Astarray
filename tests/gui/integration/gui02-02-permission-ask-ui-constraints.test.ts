/**
 * GUI-02-02 片3 反例：**授权界面必须满足的硬约束**（先红后绿）。
 *
 * 用户明确要求（2026-10-11）：
 * - 「待授权列表 + **独立详情卡**」；
 * - 「**不默认选中批准**」；
 * - 「**不提供一键批准全部**」；
 * - 「安装等专用流程**不能被普通授权卡绕过**」（本文件钉住"不出现批量入口"这一必要条件）；
 * - 必须同时给出「批准本次」与「拒绝」两个动作。
 *
 * 这些是**界面结构性约束**：一旦有人加了"全部批准"按钮或默认选中，
 * 本用例必须变红。故以**渲染出的页面文本**为断言对象（服务端渲染，可直接核对）。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { startGuiServer } from "../../../packages/gui/src/server/gui-server.js";

let stateDirectory: string;
let application: AstarrayApplicationFacade;
let handle: { close(): Promise<void> };

async function fetchPage(): Promise<string> {
  const port = (handle as unknown as { port: number }).port;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/" },
      (incoming) => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          text += chunk;
        });
        incoming.on("end", () => resolve(text));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-ui-"));
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  application = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory,
  });
  application.createSession({ sessionId: "session-ui", mode: "assist" });
  handle = await startGuiServer({
    applicationService: application,
    sessionId: "session-ui",
    mode: "assist",
  });
});

afterEach(async () => {
  await handle.close().catch(() => {});
  await application.shutdown().catch(() => {});
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

/** 取出"待授权"那一段 HTML（section 级），断言只在该段内进行。 */
function extractPermissionAskSection(page: string): string {
  const start = page.indexOf('id="permission-asks-heading"');
  expect(start, "页面必须渲染『待授权』区域").toBeGreaterThan(-1);
  const end = page.indexOf("</section>", start);
  return page.slice(start, end === -1 ? page.length : end);
}

describe("GUI-02-02 片3：授权界面硬约束", () => {
  it("① 存在『待授权』区域，且脚本给出**两个明确动作**：批准本次 / 拒绝", async () => {
    const page = await fetchPage();
    const section = extractPermissionAskSection(page);
    // 区域本身存在于服务端渲染的 HTML 中
    expect(section).toContain("待授权");
    expect(section).toContain('id="refresh-permission-asks"');
    /**
     * **动作按钮是客户端脚本动态创建的**（`renderPermissionAsks` 内 `createElement`），
     * 故不在静态 HTML 里 —— 断言对象是**页面脚本**而非该 section 的 HTML。
     * （此处为修正：初版我误把按钮文本断言在静态 HTML 上，属**断言越界**。）
     */
    expect(page).toMatch(/\[\["allowed-once", "批准本次（仅这一次）"\], \["denied", "拒绝"\]\]/);
    expect(page).toContain("function decidePermissionAsk");
  });

  it("② **不提供一键批准全部**：待授权区域内不得出现任何批量批准入口", async () => {
    const section = extractPermissionAskSection(await fetchPage());
    /**
     * 允许**声明性文案**（"不提供一键批准全部"）出现在说明里；
     * 但不得出现**批量批准的动作入口**。故检查：
     * - 不存在 id 形如 `approve-all` / `allow-all` 的按钮；
     * - 不存在"批准全部"作为**按钮文本**（`>批准全部<`）。
     */
    expect(section).not.toMatch(/id="[^"]*approve-all[^"]*"/i);
    expect(section).not.toMatch(/id="[^"]*allow-all[^"]*"/i);
    expect(section).not.toMatch(/>\s*批准全部\s*</);
    expect(section).not.toMatch(/>\s*全部批准\s*</);
  });

  it("③ **不默认选中批准**：区域内不得有预设选中的控件", async () => {
    const section = extractPermissionAskSection(await fetchPage());
    // 卡片以按钮（而非复选框/单选）呈现动作 ⇒ 不存在"预选"状态
    expect(section).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/i);
    expect(section).not.toMatch(/<input[^>]*type="radio"[^>]*checked/i);
    expect(section).not.toMatch(/checked\s*=/i);
    // 也不得把"批准"做成 select 的默认选项
    expect(section).not.toMatch(/<select/i);
  });

  it("④ 界面有用户可见声明：默认不选中、不提供一键批准全部", async () => {
    const section = extractPermissionAskSection(await fetchPage());
    expect(section).toContain("默认不会选中");
    expect(section).toContain("不提供一键批准全部");
  });

  it("⑤ 详情卡为**独立卡片**（article + aria-label），且**不展示原始参数**", async () => {
    const page = await fetchPage();
    // 客户端渲染函数必须存在，且用 article 承载独立卡片
    expect(page).toContain("function renderPermissionAsks");
    expect(page).toContain('createElement("article")');
    expect(page).toContain("待授权请求 ");
    // 界面代码不得直接渲染原始参数字段
    expect(page).not.toContain("entry.argumentsJson");
    expect(page).not.toContain("preview.argumentsJson");
  });

  it("⑥ 409 冲突时提示**刷新后重新裁决**（不复用旧批准）", async () => {
    const page = await fetchPage();
    expect(page).toContain("该请求已变化或已被处理，请刷新后重新裁决");
  });
});
