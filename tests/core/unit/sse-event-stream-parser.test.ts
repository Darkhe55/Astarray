/**
 * T07D-02 测试：增量 SSE 解析器。
 * 验收：不缓冲全流；任意 chunk 边界/CRLF/UTF-8 多字节拆分/注释/多 data 行/
 * 尾部无换行/断流/取消/缓冲上限。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_INCOMPLETE_SSE_BUFFER_BYTES,
  SseEventStreamParser,
  Utf8SafeChunkDecoder,
} from "../../../packages/core/src/runtime/sse-event-stream-parser.js";

async function collectEvents(chunks: string[], signal?: AbortSignal) {
  const parser = new SseEventStreamParser({
    cancellationSignal: signal ?? new AbortController().signal,
  });
  const events = [];
  for await (const event of parser.parseEventStream(async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  }())) {
    events.push(event);
  }
  return events;
}

describe("SseEventStreamParser 基础解析", () => {
  it("完整事件：单 data 行 + 空行分隔", async () => {
    const events = await collectEvents(['data: {"a":1}\n\n']);
    expect(events).toEqual([{ eventName: "message", data: '{"a":1}' }]);
  });

  it("任意 chunk 边界：事件被拆成多个 chunk 仍正确合并", async () => {
    const events = await collectEvents([
      'data: {"a":',
      '1,"b":2}\n',
      "\n",
    ]);
    expect(events).toEqual([{ eventName: "message", data: '{"a":1,"b":2}' }]);
  });

  it("多 data: 行合并为换行连接", async () => {
    const events = await collectEvents(["data: line1\ndata: line2\n\n"]);
    expect(events[0]?.data).toBe("line1\nline2");
  });

  it("CRLF 行结束（\\r\\n）正常解析", async () => {
    const events = await collectEvents(["data: hello\r\n\r\n"]);
    expect(events).toEqual([{ eventName: "message", data: "hello" }]);
  });

  it("SSE 注释跳过；event: 字段设置事件名", async () => {
    const events = await collectEvents([
      ": keep-alive comment\n",
      "event: tool-call\ndata: {\"t\":1}\n\n",
    ]);
    expect(events).toEqual([{ eventName: "tool-call", data: '{"t":1}' }]);
  });

  it("未知字段行跳过（不中断）；无 data 的事件块不产出", async () => {
    const events = await collectEvents(["id: 42\n: comment\n\n", "data: x\n\n"]);
    expect(events).toEqual([{ eventName: "message", data: "x" }]);
  });

  it("尾部无换行：剩余完整事件仍产出", async () => {
    const events = await collectEvents(["data: tail-event"]);
    expect(events).toEqual([{ eventName: "message", data: "tail-event" }]);
  });

  it("断流（流提前结束且无完整事件）→ 无事件产出", async () => {
    const events = await collectEvents(["data: incomplete"]);
    expect(events).toEqual([{ eventName: "message", data: "incomplete" }]);
  });
});

describe("SseEventStreamParser 取消与有界缓冲", () => {
it("AbortSignal 中止解析器", async () => {
    const controller = new AbortController();
    const parser = new SseEventStreamParser({ cancellationSignal: controller.signal });
    controller.abort();
    await expect(async () => {
      const collectedEvents = [];
      for await (const parsedEvent of parser.parseEventStream(
        (async function* () {
          yield "data: x\n\n";
        })(),
      )) {
        collectedEvents.push(parsedEvent);
      }
    }).rejects.toMatchObject({ errorCode: "provider-cancelled" });
  });

  it("未完成缓冲区超限 → provider-protocol-error", async () => {
    const parser = new SseEventStreamParser({
      cancellationSignal: new AbortController().signal,
    });
    const hugeChunk = "data: " + "x".repeat(MAX_INCOMPLETE_SSE_BUFFER_BYTES + 10);
    await expect(async () => {
      const collectedEvents = [];
      for await (const parsedEvent of parser.parseEventStream(
        (async function* () {
          yield hugeChunk;
        })(),
      )) {
        collectedEvents.push(parsedEvent);
      }
    }).rejects.toMatchObject({ errorCode: "provider-protocol-error" });
  });

  it("多个事件在一个 chunk 内逐个产出", async () => {
    const events = await collectEvents(["data: a\n\ndata: b\n\ndata: c\n\n"]);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.data)).toEqual(["a", "b", "c"]);
  });
});

describe("Utf8SafeChunkDecoder", () => {
  it("跨 chunk 的 UTF-8 多字节字符正确解码", () => {
    const decoder = new Utf8SafeChunkDecoder();
    // "中" = E4 B8 AD；拆到两个 chunk
    const first = decoder.decodeChunk(new Uint8Array([0xe4, 0xb8]));
    expect(first).toBe("");
    const second = decoder.decodeChunk(new Uint8Array([0xad, 0x0a]));
    expect(second).toBe("中\n");
    expect(decoder.flush()).toBe("");
  });

  it("单 chunk 完整多字节字符解码", () => {
    const decoder = new Utf8SafeChunkDecoder();
    const text = decoder.decodeChunk(new TextEncoder().encode("你好"));
    expect(text).toBe("你好");
  });
});
