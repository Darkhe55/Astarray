# 公共 SDK 的独立反馈进程接线缺口（发现与部分修复，2026-09-22）

> 依据：AGENTS.md —— "反馈工具为独立进程，不得退化为进程内定时器或协程。"
> 状态：**缺口已复现；能力与诊断面已修复；默认值与产品入口开启待用户裁决 + 官方门禁复验**（本轮审批通道连续 3 次 600s 停滞，无法运行完整官方门禁）。

## 1. 缺口（修复前）

`packages/core/src/public-sdk.ts`（`AstarrayApplicationFacade.create`）把运行时选项**硬编码**为：

```ts
useFeedbackProcess: false,
...
feedbackProcessModulePath: null,
```

后果：

1. **所有 SDK 消费者**（CLI `run`、嵌入方、以 SDK 为基础的入口）都拿不到独立反馈进程；`application-runtime` 在 `useFeedbackProcess === false` 时把 `createNoopFeedbackTransport()` 交给 `MainController`，反馈传输退化为进程内 noop——直接违反上述规则。
2. **潜在悬空路径**：`FeedbackProcessSupervisor` 的默认入口解析是 `dirname(模块文件)/feedback-process-entry.js`，源码运行时（vitest/tsx）该目录下并没有编译产物 → 即便开启也会 fork 一个不存在的文件。TUI 侧靠自己的 `resolveFeedbackEntryPath()`（回退 `cwd/dist/`）绕过了这个坑，SDK 侧没有。
3. 公开面**没有**任何诊断可以确认反馈传输是否为独立进程。

## 2. 本轮已修复（无默认行为变更，零回归面）

1. `packages/core/src/feedback-process/process-supervisor.ts`：导出 `resolveFeedbackProcessEntryPath()`，按 [模块目录入口, `cwd/dist` 入口] 顺序解析，并作为 supervisor 的默认值——**修复了默认悬空路径**（任何调用方都受益，不再依赖各入口自己复制解析逻辑）。
2. `packages/core/src/public-sdk.ts`：`PublicApplicationOptions` 新增 `useFeedbackProcess?: boolean`（缺省仍 false，嵌入方自担进程拓扑）与 `feedbackProcessModulePath?: string | null`，透传给 `createApplicationRuntime`。
3. `packages/core/src/application/application-runtime.ts`：`ApplicationRuntime` 新增只读字段 `isFeedbackProcessIndependent`、`requiresCompletionControlEvent`；`AstarrayApplicationFacade.getRuntimeDiagnostics()` 公开暴露（无秘密、只读）。

## 3. 证据

- **红**：新增 `tests/core/integration/feedback-process-production-wiring.test.ts` 在修复前 `3 failed`（`getRuntimeDiagnostics is not a function`、`resolveFeedbackProcessEntryPath is not a function`）。
- **绿（受限沙箱内已验）**：
  - 默认（mock）诊断如实报告 `isFeedbackProcessIndependent === false`；
  - 入口解析返回绝对路径且 basename 为 `feedback-process-entry.js`（dist 回退生效）；
  - `tsc --noEmit` = 0、`eslint .` = 0（全量）。
- **待官方门禁复验**：第 2 例"显式启用 → 独立进程"需要 fork（受限沙箱 `spawn EPERM`）。该用例与既有 TUI `bootstrap useFeedbackProcess:true` 用例机制相同（同样的解析 + fork 路径），在完整访问下应当通过；本轮因审批通道停滞未能复跑。
- 受限沙箱内 threads 全量：**213/235 文件通过**，失败集合为已知的 spawn/cwd 依赖套件（git、反馈进程、CLI 子进程、e2e01），另有两处环境性失败（`tool-registry` 的 Windows 临时目录 `ENOTEMPTY`、`e2e01-vertical-rework` 超时），与本改动无关。

## 4. 本轮**刻意未做**（需用户裁决 + 可验证窗口）

1. **默认值**：未把 `useFeedbackProcess` 在 SDK 缺省改为 true。原因：会改变所有 provider 集成测试的进程拓扑（`tests/**` 有 8 处 `runtime: "provider"` 的 SDK 用法），且本轮无法用官方门禁验证。
2. **CLI `run` 开启**：曾实现 `useFeedbackProcess: runConfig.runtime !== "mock"`，但受限沙箱内既有 `tests/tui/integration/run-provider-entry.test.ts` 会因 `spawn EPERM` 失败，无法在提交前证明其通过，故**已回退**，留待官方门禁可用时一并提交（同一检查点）。
3. 同一 SDK 路径上的相邻可疑项（本轮仅记录，未改）：`backupDeletionControlPort: null`、`installationUserPort: null`（协同模式删除/安装的逐次授权面缺失）、`authenticatedUserId: "sdk-user"`（合成审计身份，会写进授权回执的 `approvedByUserId`）。

## 5. 需要你决定

- 是否把"产品入口（CLI `run` / GUI / SDK 默认）必须使用独立反馈进程"作为硬约束落地（我倾向：CLI/GUI 开启、SDK 保持可配置并在文档标注）？
- SDK 路径是否要补齐删除/安装的逐次授权端口，并以真实认证用户标识取代 `"sdk-user"`？
