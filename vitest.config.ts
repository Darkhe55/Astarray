import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    /**
     * 2026-11-08（第 68 轮）：**全局超时预算 5_000ms → 60_000ms**。
     *
     * ## 依据（实证，不是推测）
     *
     * 本仓的 vitest 默认单例上限是 **5000ms**（已实测确认：一个睡 6 秒的探针用例
     * 在 5000ms 超时）。满载下大量用例**并非逻辑错误**却撞上它：
     *
     * - 连续两次 `npm run check` 各翻红**一个不同文件**，且都是
     *   `Error: Test timed out in 5000ms.`：
     *   `tests/core/unit/application-sdk-results-cancel.test.ts`（已单独补预算）
     *   与 `tests/tui/unit/t12a06-cli-wiring.test.ts`（读 `dist` 大文件）；
     * - 本仓已记录满载争用可达 **30–200×**（见
     *   `docs/reports/RELIABILITY_SHUTDOWN_FIX_AND_FLAKE_QUANTIFICATION_2026-11-08.md`）；
     * - 可靠性卡**早就提示正确做法**：「宜**一次性处理（全局 `testTimeout` 或
     *   逐文件补预算）而非逐次补**」。
     *
     * ## 与既有"活的规则"的关系（**不冲突**）
     *
     * `tests/architecture/subprocess-test-timeout-budget.test.ts` 断言
     * "真的起子进程/起服务的文件**必须在文件文本里**显式给出预算" ——
     * 本改动**不动**该要求（那些文件仍保有各自的显式预算，更强更清楚）。
     *
     * ## 取舍（如实）
     *
     * - 收益：整类"满载下非逻辑性超时"一次性消除，不必逐文件追（本轮已证明会
     *   一个接一个地冒出来）；
     * - 代价：若真有**卡死**的用例，报错会从 5 秒变成 60 秒才出现（更慢，但仍会报）。
     *   本仓另有活规则保证"内部截止时间**严格小于** `testTimeout`"，故卡死仍会
     *   以明确的 `Test timed out` 呈现，而不是伪装成状态断言失败。
     */
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/tui/src/**/*.ts", "packages/tui/src/**/*.tsx"],
      exclude: [
        "packages/tui/src/cli.tsx",
        "packages/tui/src/ui/**",
        "packages/gui/**",
        "packages/core/src/feedback-process/child-bootstrap.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85,
      },
    },
  },
});
