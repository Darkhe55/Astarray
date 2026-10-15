/**
 * GUI-02-02 反例（2026-11-08）：**CLI 的生产接线不得自己调自己**。
 *
 * ## 由来（真实用户实测发现，不是推测）
 *
 * 用户用真实 Provider 起 GUI 时，终端立刻刷出：
 *
 * ```
 * Exception in PromiseRejectCallback: ... dist/cli.js:3249
 * RangeError: Maximum call stack size exceeded
 * ```
 *
 * 我实测确认：**`GET /installation-inquiries` 返回 500**，而 `/permission-asks` 正常 200。
 * 也就是说「**待安装询问**」这个区块**一直是坏的** —— 页面脚本的 `.catch(function(){})`
 * 把失败吞了，所以浏览器里只看到一片空白，**几轮人工体验都没发现**。
 *
 * ## 根因
 *
 * `packages/tui/src/cli/commands.ts` 里：
 *
 * ```js
 * Object.assign(application, {
 *   listPendingInstallationInquiries: async () =>
 *     (await application.listPendingInstallationInquiries()).map(...)  // ← 自己调自己
 * })
 * ```
 *
 * `Object.assign` 赋值后，`application.listPendingInstallationInquiries` **就是这段箭头函数**，
 * 于是调用它 = 调自己 ⇒ 无限递归 ⇒ 栈溢出。
 * 同块里另外三个覆盖项都调**不同名**的方法，只有这一个**撞名**。
 *
 * ## ⚠️ 为什么既有测试没拦住（本文件要补的正是这个洞）
 *
 * `gui02-02-installation-not-bypassable.test.ts` **自己复制了一份接线**，
 * 且在赋值**之前**就把原始方法 `bind` 出来了（`…FromFacade`），所以它测的是**正确写法**；
 * 它注释里写的"与 commands.ts 生产接线一致"**与事实不符** ⇒ 测试绿、生产红。
 *
 * 故本文件的两个反例**不复制接线**：
 * ① 真起 **CLI**（生产入口）并打该路由 —— 端到端证明接线可用；
 * ② 静态守卫：扫描生产接线块，**不允许**出现"覆盖项调用同名方法"。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 真起子进程 + 起服务 ⇒ 按本仓**活的规则**必须显式给超时预算
 * （`subprocess-test-timeout-budget.test.ts`）；否则默认 5s 会在负载下超时。
 */
vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;
let runningChildren: Array<{ kill: () => void }>;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui-cli-wiring-"));
  runningChildren = [];
});

afterEach(async () => {
  for (const child of runningChildren) {
    child.kill();
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 起真实 CLI 的 `gui` 命令（生产入口），返回它实际监听的端口。 */
function startCliGui(): Promise<{ port: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.resolve("dist/cli.js"), "gui", "--runtime", "mock", "--port", "0", "--no-open"],
      { cwd: stateDirectory, timeout: 80_000 },
      (error) => {
        if (error !== null) {
          reject(error);
        }
      },
    );
    runningChildren.push({ kill: () => child.kill() });
    let buffered = "";
    const onData = (chunk: string): void => {
      buffered += chunk;
      // CLI 启动后打印：Astarray GUI 已启动：http://127.0.0.1:<port>/
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(buffered);
      if (match !== null) {
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve({ port: Number(match[1]), kill: () => child.kill() });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
  });
}

function getJson(port: number, requestPath: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: requestPath, headers: { host: "127.0.0.1:" + String(port) } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
        },
      )
      .on("error", reject);
  });
}

describe("GUI-02-02：CLI 生产接线不得自己调自己", () => {
  it("① 经**真实 CLI** 起 GUI 后，安装询问路由必须可用（不得 500）", async () => {
    const { port } = await startCliGui();

    const installationResponse = await getJson(port, "/installation-inquiries");
    // 用户实测时这里是 500（无限递归）
    expect(installationResponse.statusCode).toBe(200);
    expect(installationResponse.body).toContain("entries");

    // 对照：权限询问路由本来就是好的 —— 证明不是"整站都坏"
    const permissionResponse = await getJson(port, "/permission-asks");
    expect(permissionResponse.statusCode).toBe(200);
  });

  it("② 静态守卫：生产接线块里**不得**出现'覆盖项调用同名方法'", async () => {
    const sourceText = await fs.readFile(
      path.resolve("packages/tui/src/cli/commands.ts"),
      "utf8",
    );

    /**
     * ⚠️ 提取必须**自校验**：`Object.assign(application` 在本文件里可能出现**多次** ——
     * 实测就有 2 处，**第一处是我自己写在注释里举的例子**（块长仅 32 字符、0 个方法键），
     * 若直接取第一处，守卫会抽出 0 个名字（首版就是这样，被下面那条"防空转"断言拦下）。
     *
     * 故：遍历**所有**出现处，只保留"确实是接线块"的（方法键 > 2 个），并要求**恰好一个**。
     * 注释里的例子不可能包含方法定义，因此天然被排除。
     */
    const methodKeyPattern = /^\s+(\w+):\s+(?:async\s*)?\(/gm;
    const candidateBlocks: Array<{ names: string[]; text: string }> = [];
    for (const match of sourceText.matchAll(/Object\.assign\(application/g)) {
      const assignIndex = match.index ?? 0;
      const openIndex = sourceText.indexOf("{", assignIndex);
      if (openIndex < 0) continue;
      let depth = 0;
      let closeIndex = -1;
      for (let index = openIndex; index < sourceText.length; index += 1) {
        const character = sourceText[index];
        if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            closeIndex = index;
            break;
          }
        }
      }
      if (closeIndex <= openIndex) continue;
      const blockText = sourceText.slice(assignIndex, closeIndex + 1);
      const names = [...blockText.matchAll(methodKeyPattern)].map((entry) => entry[1]!);
      if (names.length > 2) {
        candidateBlocks.push({ names, text: blockText });
      }
    }

    expect(
      candidateBlocks.length,
      "未能唯一确定生产接线块（找到 " +
        String(candidateBlocks.length) +
        " 个候选）—— 守卫必须能自证找到了正确对象，否则会恒真",
    ).toBe(1);
    const wiringBlock = candidateBlocks[0]!;

    for (const name of wiringBlock.names) {
      const selfCallPattern = new RegExp("application\\." + name + "\\s*\\(");
      expect(
        selfCallPattern.test(wiringBlock.text),
        "覆盖项 " +
          name +
          " 调用了 application." +
          name +
          "() —— 那在 Object.assign 之后就是它自己 ⇒ 无限递归。" +
          "应在赋值**之前** bind 出原始方法再调用。",
      ).toBe(false);
    }
  });
});
