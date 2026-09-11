/**
 * 上下文运行时事件存储（T09A-R1-04）：JSONL 追加，供指标复算与审计。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ContextAssemblyRuntimeEvent } from "./context-runtime-metrics.js";

export class ContextRuntimeEventStore {
  private readonly filePath: string;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(
      options.baseDirectory,
      "context-runtime",
      "events.jsonl",
    );
  }

  async append(event: ContextAssemblyRuntimeEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  async readAll(): Promise<ContextAssemblyRuntimeEvent[]> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const events: ContextAssemblyRuntimeEvent[] = [];
    for (const line of rawContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as ContextAssemblyRuntimeEvent);
      } catch {
        // 损坏行跳过（不阻塞其余事件）
      }
    }
    return events;
  }
}
