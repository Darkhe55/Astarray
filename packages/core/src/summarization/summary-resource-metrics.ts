/**
 * SUM-01-04a：摘要读取的资源观测（磁盘读取字节、返回量、耗时、原文访问次数）。
 *
 * 只做观测，不做截断：资源不足时返回更小的**本次返回**（`isReturnBounded`），
 * 绝不裁剪清单、也不删除正文；指标随读取结果一起返回，便于"状态诚实"。
 */
export interface SummaryResourceMetrics {
  /** 清单文件字节数（本次读取实际读取的索引大小）。 */
  manifestFileBytes: number;
  /** 清单中的分块总数（总正文规模，不随单次返回变化）。 */
  chunkCount: number;
  /** 后台叙述字符数（模型/抽取式生成器的返回量近似）。 */
  narrativeCharacterCount: number;
  /** 本次返回的计量单位数。 */
  returnedUnitCount: number;
  /** 本次操作耗时（毫秒）。 */
  wallMilliseconds: number;
  /** 本次操作访问原文的次数（读取路径必须为 0）。 */
  sourceAccessCount: number;
  /** 本次操作的索引读取次数（正常读取为 1 次清单）。 */
  diskReadOperationCount: number;
  /** 本次返回是否因返回预算被裁剪。 */
  isReturnBounded: boolean;
}

export async function measureSummaryOperation<T>(input: {
  operation: () => Promise<T>;
  readManifestFileBytes: () => Promise<number>;
  extract: (result: T) => {
    chunkCount: number;
    narrativeCharacterCount: number;
    returnedUnitCount: number;
    sourceAccessCount: number;
    isReturnBounded: boolean;
    /** 本次实现实际发生的索引读取次数（调用方如实声明）。 */
    diskReadOperationCount: number;
  };
}): Promise<{ result: T; metrics: SummaryResourceMetrics }> {
  const startedAtMilliseconds = Date.now();
  const result = await input.operation();
  const wallMilliseconds = Date.now() - startedAtMilliseconds;
  const manifestFileBytes = await input.readManifestFileBytes();
  const extracted = input.extract(result);
  return {
    result,
    metrics: {
      manifestFileBytes,
      chunkCount: extracted.chunkCount,
      narrativeCharacterCount: extracted.narrativeCharacterCount,
      returnedUnitCount: extracted.returnedUnitCount,
      wallMilliseconds,
      sourceAccessCount: extracted.sourceAccessCount,
      diskReadOperationCount: extracted.diskReadOperationCount,
      isReturnBounded: extracted.isReturnBounded,
    },
  };
}
