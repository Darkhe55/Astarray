# SDK 默认反馈进程 + Provider 公开入口（检查点 A，2026-09-28）

> 依据用户指令："SDK 正式任务运行路径默认启用独立反馈进程，诊断接口保留；测试显式隔离不能替代默认路径集成验收。"

## 1. 修复前缺口

| # | 缺口 | 证据 |
| --- | --- | --- |
| 1 | 公共 SDK **硬编码** `useFeedbackProcess: false` → 正式任务运行路径没有独立反馈进程 | 新用例 `feedback-process-default-path` 反例：`expected false to be true` |
| 2 | `runtime: "provider"` 在**打包产物上不可用**：`ProviderRuntimeRegistry`、`createOpenAiCompatibleProviderRegistration`、`OPENAI_COMPATIBLE_PROVIDER_ID` 都不在公开 exports 里（消费者只能走内部路径） | 新用例 `public-sdk-provider-exports` 反例：2 failed |

## 2. 实现

1. `packages/core/src/public-sdk.ts`：`useFeedbackProcess` 缺省改为 **`runtimeKind === "provider"`**（正式任务运行路径默认独立进程；mock 离线路径保持进程内；嵌入方可显式覆盖）。`getRuntimeDiagnostics()` 保留。
2. 同一文件新增 Provider 公开入口导出：`ProviderRuntimeRegistry` / `ProviderConfigurationError` / `ProviderRuntimeRegistration` / `ProviderRuntimeConfig` / `ResolvedProviderRuntime` / `PROVIDER_RUNTIME_CAPABILITIES` / `OPENAI_COMPATIBLE_PROVIDER_ID` / `OPENAI_COMPATIBLE_PROTOCOL` / `OPENAI_COMPATIBLE_PROTOCOL_VERSION` / `createOpenAiCompatibleProviderRegistration`。
3. 既有 provider 用例（9 处）**显式隔离** `useFeedbackProcess: false`，并注明默认路径由新用例验收（用户明确允许显式隔离，但不得替代默认路径验收）。
4. 新增交付级验收脚本 `scripts/verify-sdk-default-path.mjs`：用本次 tarball 隔离安装，消费者**只用公开 exports**（`import { AstarrayApplicationFacade, ProviderRuntimeRegistry, createOpenAiCompatibleProviderRegistration, OPENAI_COMPATIBLE_PROVIDER_ID } from "astarray"`），不显式传反馈进程参数，断言诊断 + 真实任务到 done + 干净关闭。

## 3. 证据

- **红**：`feedback-process-default-path`（默认路径 `expected false to be true`）、`public-sdk-provider-exports`（2 failed）。
- **绿（官方门禁，完整访问 + 默认 forks 池）**：构建成功；全量 **237 文件 / 1881 用例**；覆盖率 **93.13 / 85.46 / 93.33 / 93.15**；安全关键模块 **22/22**。
- **tarball 公开 SDK 入口验收**：tarball sha256 `f4791ca1fb935f053f92e0c204c146fed1c2c5d8a1bd5d88f980f840892f2837`；消费者输出
  `{ "diagnostics": { "isFeedbackProcessIndependent": true, "requiresCompletionControlEvent": true }, "status": "done" }` → **通过**。

## 4. 环境说明（不改变结论）

`npm pack` 的 prepack 会跑 `npm run check`；本轮两次被同一个**偶发竞态**（`ENOENT mkdir …/missions/mission-…`，源自**用户并行修改**的 `tests/core/unit/application-sdk-task-events.test.ts`）打断。因此：门禁（构建/全量/覆盖率/安全）**单独运行且全绿**，打包验收以 `--skip-prepack` 生成 tarball；该竞态单独复跑通过、全量复跑无错误，判定为偶发，未改动用户文件。
