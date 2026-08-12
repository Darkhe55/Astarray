/**
 * 流式输出节流（T10）：约 30–50ms 批量刷新，不逐 token 重渲染整屏。
 */
export class ThrottledTextCollector {
  private pendingText = "";
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flushCallback: (text: string) => void,
    private readonly flushIntervalMilliseconds = 40,
  ) {}

  append(deltaText: string): void {
    this.pendingText += deltaText;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.pendingText.length > 0) {
          const flushedText = this.pendingText;
          this.pendingText = "";
          this.flushCallback(flushedText);
        }
      }, this.flushIntervalMilliseconds);
    }
  }

  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingText.length > 0) {
      const flushedText = this.pendingText;
      this.pendingText = "";
      this.flushCallback(flushedText);
    }
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
