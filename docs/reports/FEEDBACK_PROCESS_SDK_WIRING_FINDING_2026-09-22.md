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
- **官方门禁（完整访问 + 默认 forks 池）已复验**：构建成功；全量 **235 文件 / 1877 用例**通过，其中第 2 例"显式启用 → 独立进程"在完整访问下通过（~5.2s，含 fork + 握手）。
- 受限沙箱内 threads 全量：**213/235 文件通过**，失败集合为已知的 spawn/cwd 依赖套件（git、反馈进程、CLI 子进程、e2e01），另有两处环境性失败（`tool-registry` 的 Windows 临时目录 `ENOTEMPTY`、`e2e01-vertical-rework` 超时），与本改动无关。

## 4. 后续进展（同日第二轮）：CLI 产品入口已开启 + 子进程 stdout 隔离

1. **CLI `run` 开启独立反馈进程**（`packages/tui/src/cli/run-command.ts`）：`useFeedbackProcess: runConfig.runtime !== "mock"`——真实 Provider 运行走独立进程，mock 离线路径保持进程内（避免测试期无谓 fork）。
2. **修复子进程 stdout 继承**（`process-supervisor.ts`）：原 `stdio: ["ignore","inherit","inherit","ipc"]` 让反馈子进程直接写父进程 stdout，违反 headless `run` 的"stdout 仅 JSON"契约；改为 `["ignore","pipe","inherit","ipc"]` 并把子进程 stdout 转发到父进程 stderr（输出不丢，stdout 保持干净）。
3. **测试预算调整**（`tests/tui/integration/run-provider-entry.test.ts`）：真实链路新增 fork + 握手（实测约 5s），按仓库既有风格改为 `vi.setConfig({ testTimeout: 60_000 })`，断言不变。
4. **官方门禁（完整访问 + 默认 forks 池）**：构建成功；全量 **235 文件 / 1877 用例**；覆盖率 **93.12 / 85.44 / 93.29 / 93.14**；安全关键模块 **22/22**；目标用例（`run-provider-entry` + 反馈进程接线）6/6 通过。首次全量出现 1 次未处理错误（任务链临时文件 ENOENT 竞态，位于**用户并行修改**的 `application-sdk-task-events.test.ts`），单独复跑通过、全量复跑无错误 → 判定偶发。

## 4b. 仍未做（需用户裁决）

1. **SDK 默认值**：未把 `useFeedbackProcess` 在 SDK 缺省改为 true。原因：会改变 `tests/**` 中 8 处 `runtime: "provider"` SDK 用法的进程拓扑；当前以"嵌入方显式开启 + 诊断面"交付。
2. 同一 SDK 路径上的相邻可疑项（仅记录，未改）：`backupDeletionControlPort: null`、`installationUserPort: null`（协同模式删除/安装的逐次授权面缺失）、`authenticatedUserId: "sdk-user"`（合成审计身份，会写进授权回执的 `approvedByUserId`）。

## 5. 需要你决定

- 是否把"产品入口（CLI `run` / GUI / SDK 默认）必须使用独立反馈进程"作为硬约束落地（我倾向：CLI/GUI 开启、SDK 保持可配置并在文档标注）？
- SDK 路径是否要补齐删除/安装的逐次授权端口，并以真实认证用户标识取代 `"sdk-user"`？
