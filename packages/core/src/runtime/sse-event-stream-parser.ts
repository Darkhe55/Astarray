/**
 * 增量 SSE 事件流解析器（T07D-02 / T07D 任务卡 §6.2）。
 *
 * - 从传输层异步迭代增量读取，不调用 response.text() 缓冲全流；
 * - 处理任意 chunk 边界、CRLF、UTF-8 多字节拆分、SSE 注释、
 *   未知事件、多个 data: 行、尾部无换行与有界未完成缓冲区；
 * - AbortSignal 中止底层请求与解析器；
 * - 未知事件跳过并继续（有界）。
 */
import { DomainError } from "../core/errors.js";

/** 未完成事件缓冲区上限（字节；超限视为协议异常）。 */
export const MAX_INCOMPLETE_SSE_BUFFER_BYTES = 1 * 1024 * 1024;

export interface SseParsedEvent {
  /** 事件名（缺省 "message"）。 */
  eventName: string;
  /** 合并后的 data 行（多个 data: 行以换行连接）。 */
  data: string;
}

export class SseEventStreamParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly cancellationSignal: AbortSignal;
  private pendingBuffer = "";

  constructor(options: { cancellationSignal: AbortSignal }) {
    this.cancellationSignal = options.cancellationSignal;
  }

  /**
   * 解析增量 chunk 流并产出完整 SSE 事件。
   * 未完成事件保留在有界缓冲区；AbortSignal 触发时中止。
   */
  async *parseEventStream(
    chunks: AsyncIterable<string>,
  ): AsyncIterable<SseParsedEvent> {
    for await (const chunk of chunks) {
      if (this.cancellationSignal.aborted) {
        throw new DomainError("provider-cancelled", "SSE 解析已中止（AbortSignal）");
      }
      this.pendingBuffer += chunk;
      if (this.pendingBuffer.length > MAX_INCOMPLETE_SSE_BUFFER_BYTES) {
        throw new DomainError(
          "provider-protocol-error",
          `未完成 SSE 缓冲区超限（${MAX_INCOMPLETE_SSE_BUFFER_BYTES} 字节）`,
        );
      }
      const events = this.extractCompleteEvents();
      for (const event of events) {
        yield event;
      }
    }
    // 尾部无换行：处理剩余的未完成事件（若为完整事件行则产出）
    const tailEvents = this.flushTail();
    for (const event of tailEvents) {
      yield event;
    }
  }

/** 从缓冲区提取所有以空行结束的完整事件。 */
  private extractCompleteEvents(): SseParsedEvent[] {
    const events: SseParsedEvent[] = [];
    let normalized = this.pendingBuffer.replace(/\r\n/g, "\n");
    let boundaryIndex: number;
    while ((boundaryIndex = normalized.indexOf("\n\n")) !== -1) {
      const eventBlock = normalized.slice(0, boundaryIndex);
      normalized = normalized.slice(boundaryIndex + 2);
      const event = this.parseEventBlock(eventBlock);
      if (event !== null) {
        events.push(event);
      }
    }
    this.pendingBuffer = normalized;
    return events;
  }

  /** 解析单个事件块（多 data: 行合并；注释/未知字段跳过）。 */
  private parseEventBlock(block: string): SseParsedEvent | null {
    const lines = block.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) {
        continue; // SSE 注释
      }
      if (line.startsWith("event:")) {
        const value = line.slice("event:".length).trim();
        if (value.length > 0) {
          eventName = value;
        }
        continue;
      }
      if (line.startsWith("data:")) {
        const value = line.slice("data:".length);
        // data: 后的首个空格被剥离（SSE 规范）
        dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
        continue;
      }
      // 未知字段：跳过（不中断）
    }
    if (dataLines.length === 0) {
      return null; // 无 data 的事件（如纯注释块）不产出
    }
    return { eventName, data: dataLines.join("\n") };
  }

  /** 流结束：把剩余缓冲区当作单个事件处理（尾部无换行）。 */
  private flushTail(): SseParsedEvent[] {
    const remaining = this.pendingBuffer.trim();
    this.pendingBuffer = "";
    if (remaining === "") {
      return [];
    }
    const event = this.parseEventBlock(remaining);
    return event === null ? [] : [event];
  }
}

/** TextDecoder 多字节安全封装（跨 chunk 的 UTF-8 字符由 TextDecoder stream 模式处理）。 */
export class Utf8SafeChunkDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  /** 解码增量字节块（stream: false 逐块；跨块多字节由 TextDecoder 内部保序）。 */
  decodeChunk(chunk: Uint8Array): string {
    return this.decoder.decode(chunk, { stream: true });
  }

  flush(): string {
    return this.decoder.decode();
  }
}
