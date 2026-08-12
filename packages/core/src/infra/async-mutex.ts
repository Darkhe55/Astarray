/**
 * 进程内异步互斥锁（T03）。
 * 用于 mission 级串行化读写，保证同一任务链不被并发更新交错。
 */

export class AsyncMutex {
  private tailPromise: Promise<void> = Promise.resolve();

  /** 串行执行互斥任务，返回任务结果；释放由内部保证。 */
  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previousTail = this.tailPromise;
    let releaseLock: (() => void) | undefined;
    this.tailPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousTail;
    try {
      return await task();
    } finally {
      releaseLock?.();
    }
  }
}
