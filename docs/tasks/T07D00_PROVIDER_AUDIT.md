# T07D-00 Provider 产品路径审计与文档纠偏（2026-08-22）

> 任务卡：`docs/tasks/T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md` T07D-00
> 只改文档、schema 与失败测试；不顺带实现 Provider。

## 1. 当前真实状态（审计结果）

| 项 | 真实状态 | 证据 |
|---|---|---|
| CLI runtime 门禁 | 仅接受 `mock`；非 mock 报"尚未支持（v0.1 仅 mock）" | `packages/tui/src/cli/run-command.ts:31` |
| bootstrap 装配 | 固定 `ScriptedRuntime`（mock）；无真实 Provider 产品路径 | `packages/tui/src/cli/bootstrap.ts` |
| 环境变量读取 | **无生产代码读取** `ASTARRAY_PROVIDER_*`（仅 README 示例） | `rg ASTARRAY_PROVIDER packages/core/src` 无匹配 |
| openai-compatible 运行时 | 存在 `OpenAiCompatibleRuntime`（SSE 缓冲 `response.text()` 后解析，非增量流）；仅单元级存在 | `packages/core/src/runtime/openai-compatible-runtime.ts` |
| 公开包导出 | package.json 无 `exports` 字段（仅 bin）；无 Public SDK | `package.json` |
| 固定任务分解 | v0.1 使用确定性单任务分解（T14 前不替换） | `main-controller.ts decomposePromptForScriptedRun` |

## 2. Provider 支持矩阵（当前）

| Provider/协议 | 支持等级 | 可宣称 |
|---|---|---|
| mock（ScriptedRuntime） | `product-path-verified`（CLI/TUI 默认离线路径，check/smoke-install 全绿） | 可用 |
| openai-compatible（OpenAiCompatibleRuntime） | `adapter-only`（仅代码存在，无 fake-server 契约、无增量流、无产品路径） | **不可以** |

## 3. 文档纠偏

- README "Provider 配置" 段声称"`openai-compatible` 运行时已实现…通过环境变量接入"——**与生产代码不符**（无环境变量读取、无产品路径），已改为"adapter-only 状态、未验证、不可用"。
- README "当前限制" 段已明确 headless `--runtime` 仅 `mock`。

## 4. 交付

- 新 schema：`packages/core/src/orchestration/provider-support-record.ts`（支持等级/认证方式/声明规则冻结）。
- 测试：`tests/core/unit/provider-support-record.test.ts`（schema 反例 + 声明规则断言）。
- 本审计确认：T07D-01 起按检查点实现协议端口/增量流/适配器；T07D-07 真实闭环待 T05D/T07E 通过。