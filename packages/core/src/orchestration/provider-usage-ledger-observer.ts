/**
 * 把"单次 Provider 请求的真实用量观测"落到**用量账目**（2026-10-06 接线）。
 *
 * 为什么需要它：观测端口在 `measurement`，写入实现在编排层，保持依赖方向
 * `orchestration → measurement`；运行时只上报事实，不认识账目或状态目录。
 *
 * 纪律（沿用 usage-ledger-store 的既有契约）：
 *  - 未知用量记 `null` 并给 `missingUsageReason`，**不补 0**；
 *  - 真实用量 `isEstimated = false`（估算不得用于账单结论）；
 *  - **观测失败不得阻塞业务**（与 `perfSampleSink` 的既定纪律一致）：
 *    账目写入异常只上报给 `onError`，不影响本轮 Provider 调用结果。
 */
import type {
  ProviderRequestUsageObservation,
  ProviderRequestUsageObserverPort,
} from "../measurement/provider-request-usage-observation.js";
import type { UsageLedgerEntry, UsageLedgerStore } from "./usage-ledger-store.js";

export function createProviderUsageLedgerObserver(input: {
  store: UsageLedgerStore;
  onError?: (error: unknown) => void;
}): ProviderRequestUsageObserverPort {
  return {
    recordProviderRequestUsage: async (
      observation: ProviderRequestUsageObservation,
    ): Promise<void> => {
      const missingUsageReason = observation.missingUsageReason;
      const entry: UsageLedgerEntry = {
        requestIdentifier: observation.requestIdentifier,
        requestRevision: 1,
        missionIdentifier: observation.missionIdentifier,
        taskIdentifier: observation.taskIdentifier,
        sourceAgentInstanceId: observation.sourceAgentInstanceId,
        /**
         * 注意：当前产品路径里该字段取**运行时 Provider 标识**
         * （如 `anthropic-messages`），不是 provider-catalog 的 profile id；
         * 二者尚未打通，已在文档中登记为已知限制。
         */
        providerProfileId: observation.providerIdentifier,
        modelIdentifier: observation.modelIdentifier,
        recordedAtIso: observation.observedAtIso,
        inputTokenCount: observation.inputTokenCount,
        outputTokenCount: observation.outputTokenCount,
        cachedTokenCount: observation.cachedInputTokenCount,
        isEstimated: false,
        inputHash: observation.requestInputHash,
        attribution: { kind: "total", parentRequestIdentifier: null },
        ...(missingUsageReason === undefined ? {} : { missingUsageReason }),
      };
      try {
        await input.store.append(entry);
      } catch (error) {
        input.onError?.(error);
      }
    },
  };
}
