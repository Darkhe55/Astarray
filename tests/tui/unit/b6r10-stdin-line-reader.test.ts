/**
 * B6R-10 覆盖率 + 行为（2026-10-10）：stdin **行切分器**的跨 chunk 拼接契约。
 *
 * 被测对象是 `createStdinLineReader()`（导出）。它承载一条**真实修复**（2026-10-02
 * 真实 CLI 端到端复现）：**不能把"一次 data 事件"当成一行** —— 管道里多行裁决会
 * 一次性到达（`printf 'allow-once\nallow-once\n' | …`），按 chunk 读会把整段当成一行
 * 而**误判为拒绝**。此前的测试只通过子进程驱动，而 v8 **看不见子进程** ⇒
 * 该切分逻辑的分支长期零覆盖。
 *
 * 本片直接驱动该读取器，钉住它的语义：
 *  - 一个 chunk 含多行 ⇒ **逐行**产出（不是整段一行）；
 *  - **跨 chunk 的半行**必须被缓存，直到换行到达才产出；
 *  - **CRLF**（Windows 管道）必须去掉尾部 `\r`；
 *  - `end` 时**残留半行**仍须产出（不得丢最后一行）；
 *  - `end` 之后无数据 ⇒ 如实返回 `null`（调用方据此按"无裁决输入"收口）；
 *  - **先读后到**：先请求行、后给 data ⇒ 挂起的请求必须被兑现（不得丢行）。
 *
 * 只跑本地 EventEmitter 与内存缓冲；不联网、不用凭据。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStdinLineReader } from "../../../packages/tui/src/cli/permission-ask-adjudication.js";

/**
 * 记录本文件注册到 `process.stdin` 的监听器，用例结束后逐个移除，
 * 避免污染同进程内其它用例（stdin 是全局单例）。
 */
/**
 * 事件监听器的通用签名：`node:events` 的重载在这里用不上，
 * 用**最小结构化类型**代替 `any`（本仓禁止 `any`）。
 */
type AnyEventListener = (...argumentsList: unknown[]) => void;

let registeredListeners: Array<{ event: string; listener: AnyEventListener }> = [];

beforeEach(() => {
  registeredListeners = [];
  const stdinWithLooseOn = process.stdin as unknown as {
    on: (event: string, listener: AnyEventListener) => unknown;
  };
  const originalOn = stdinWithLooseOn.on.bind(process.stdin) as (
    event: string,
    listener: AnyEventListener,
  ) => unknown;
  stdinWithLooseOn.on = (event, listener) => {
    registeredListeners.push({ event, listener });
    return originalOn(event, listener);
  };
});

afterEach(() => {
  for (const registered of registeredListeners) {
    process.stdin.removeListener(registered.event, registered.listener as never);
  }
  registeredListeners = [];
});

describe("B6R-10：stdin 行切分（跨 chunk / CRLF / end 残留）", () => {
  it("① 一个 chunk 含多行 ⇒ 逐行产出（不得把整段当成一行）", async () => {
    const readLine = createStdinLineReader();
    process.stdin.emit("data", "allow-once\ndeny\n");
    expect(await readLine()).toBe("allow-once");
    expect(await readLine()).toBe("deny");
  });

  it("② 跨 chunk 的半行必须被缓存到换行到达", async () => {
    const readLine = createStdinLineReader();
    process.stdin.emit("data", "allow");
    process.stdin.emit("data", "-once\n");
    expect(await readLine()).toBe("allow-once");
  });

  it("③ CRLF（Windows 管道）⇒ 去掉尾部 \\r", async () => {
    const readLine = createStdinLineReader();
    process.stdin.emit("data", "allow-once\r\n");
    expect(await readLine()).toBe("allow-once");
  });

  it("④ end 时**残留半行**仍须产出（不得丢最后一行）", async () => {
    const readLine = createStdinLineReader();
    process.stdin.emit("data", "allow-once");
    process.stdin.emit("end");
    expect(await readLine()).toBe("allow-once");
    // 之后必须如实返回 null
    expect(await readLine()).toBeNull();
  });

  it("⑤ end 之后无数据 ⇒ 如实返回 null（不挂起、不伪造裁决）", async () => {
    const readLine = createStdinLineReader();
    process.stdin.emit("end");
    expect(await readLine()).toBeNull();
  });

  it("⑥ **先读后到**：先请求行、后给 data ⇒ 挂起的请求必须被兑现", async () => {
    const readLine = createStdinLineReader();
    // 先发起读取（此刻无缓冲、未 end）⇒ 进入挂起路径
    const pendingLine = readLine();
    // 再喂一行 ⇒ 必须兑现上面那个挂起请求（而不是塞进缓冲导致永久挂起）
    process.stdin.emit("data", "allow-once\n");
    expect(await pendingLine).toBe("allow-once");
  });

  it("⑦ stdin error ⇒ 视为结束（如实返回 null，不无限等待）", async () => {
    const readLine = createStdinLineReader();
    process.stdin.emit("error", new Error("注入的 stdin 错误"));
    expect(await readLine()).toBeNull();
  });
});
