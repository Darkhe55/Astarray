# 真实 Provider 工具循环消息协议修复（400 invalid msg role: function，2026-10-01）

> 触发：T07D-R2-04「小型受控改动」真实调用返回 `Provider 返回非 2xx: 400 Bad Request`。
> 基线：`HEAD == origin/main == 96ad431`（本检查点改动代码）。

## 1. 根因（可复现）

工具循环把工具结果回填为 OpenAI **已废弃** 的 `role: "function"`，且**不补回** assistant 的
`tool_calls` 消息。续发请求因此形如：

```
messages: system, user, function
```

用捕获到的真实请求体打真实端点，服务端直接给出原因：

| 请求形态 | 端点响应 |
| --- | --- |
| 运行时实际发出（`role=function`） | **400** `{"error":{"message":"invalid msg role: function","type":"request_params_invalid"}}` |
| 同一请求改写为 `system,user,assistant(tool_calls),tool` | **200 OK** |
| 第 1 个请求（`system,user`，无工具结果） | 200 OK（因此**纯文本任务侥幸通过**，掩盖了该缺陷） |

结论：**只要模型发起任何工具调用，真实 OpenAI 兼容 Provider 的第二个请求必然 400**——
即"真实 Provider 上做实际工作"此前不可达。

### 1.1 复现方法与工具（可复用，已入库）

| 脚本 | 用途 | 是否联网 |
| --- | --- | --- |
| `scripts/verify-provider-tool-protocol.mjs`（`npm run verify:provider-tool-protocol`） | 本地拦截代理驱动完整工具循环，断言续发请求的规范形态 | **否**（零额度） |
| `scripts/verify-provider-request-against-endpoint.mjs`（`npm run verify:provider-live-request`） | 把捕获/构造的请求体按变体发给真实端点做 A/B 对照 | 是，**需显式 `--allow-live-request`**，`--count` 上限 3 |

反例（修复前）：新增 `tests/core/unit/runtime.test.ts` 用例
「工具结果回填为 OpenAI 规范消息序列：assistant(tool_calls) + role=tool（不得用 role=function）」→ **失败**
（第 2 次迭代只带回 1 条消息）。

## 2. 修复

- `packages/core/src/runtime/tool-loop.ts`
  - 新增 provider 中立的续发消息类型：`AssistantToolCallMessage` / `ToolRoleResultMessage` /
    `GuidanceInjectionMessage` 与联合 `ProviderConversationMessage`（核心领域禁 `any`）；
  - 每轮工具执行后**先**回填 `assistant.tool_calls`（id/type/function.name/function.arguments），
    **再**逐条回填 `role="tool"` + `tool_call_id`；`buildToolResultMessage` 保留为 provider 适配覆盖点；
  - 新增导出 `toToolResultContent()` 统一结果文本（成功原文 / `错误(code): message`）。
- `packages/core/src/core/types.ts`：`AgentRunInput.toolResultMessages` 注释由
  "OpenAI 兼容：role=function 消息" 更正为规范序列说明。
- 既有断言更新（行为确实变化，非放宽）：
  - `tests/core/integration/local-readonly-tools-production-wiring.test.ts`：过滤条件 `role==="function"` → `role==="tool"`；
  - `tests/core/integration/provider-tool-loop.test.ts`：原断言 `not.toContain("whoami")` 因修复后
    assistant 消息**如实记录**模型自述的 `tool_calls` 参数而失效 → 收紧为
    「工具结果消息唯一、`tool_call_id` 对应、结果内容含 `tool-not-found` 且**不含**被拒命令输出」。

## 3. 证据

- **反例 → 绿**：`tests/core/unit/runtime.test.ts` 17/17（含新增规范序列用例）。
- **官方门禁**：`npm run check` exit 0 —— 全量 **243 文件 / 1909 用例**通过。
- **覆盖率**（`npx vitest run --coverage --maxWorkers=6`）：**93.15 / 85.44 / 93.40 / 93.17**（阈值 85）。
- **安全关键模块**：`node scripts/verify-security-coverage.mjs` → **22/22 达标**。
- **离线协议验收**：`npm run verify:provider-tool-protocol` exit 0 —— 5/5 断言
  （assistant.tool_calls、role=tool 一一对应、无 role=function、保留 tools/tool_choice、消息顺序 `system,user,assistant,tool`）。
- **真实端点 A/B**：修复后捕获的续发请求打真实 `api.stepfun.com` → **200 OK**（修复前同形态 400）。
- **安装产物回归**：tarball sha256 `cf9d277e838a1a473bb8712257e0048858ca64fae8683d647131661692bcd484`
  → `verify-package` ✅（217 文件）、`verify:entry-runtime-selection` ✅ 23/23、`smoke-install` ✅。

## 4. 仍未达成与其独立原因（**不要把本修复当成写任务已通过**）

真实写任务（`createProjectFile`）在**协议修复后仍然 blocked，但原因完全不同**：

```
astarray: [需要用户] 任务 T-001 需要权限调用 createProjectFile（执行任务需要调用工具 createProjectFile），参数: {...}
```

- `PolicyWrapper` 对受限工具按当前权限档返回 `ask` → 抛 `permission-ask-pending`
  （`packages/core/src/tools/policy-wrapper.ts:157-163`）；
- 裁决授予 API **已存在**：`PolicyWrapper.grantConfigurableSessionAuthorization({toolName, argumentsJson})`
  （`policy-wrapper.ts:263`，绑定 profile revision）；
- 但**CLI 没有把"ask"变成可操作的用户裁决**（无交互裁决通道，`--json` 模式下更无从恢复），
  任务只能停在 blocked。属独立检查点候选，需先与用户确定裁决语义：
  逐次询问？`allow-once` 绑定参数？还是 CLI 输出裁决命令由用户二次执行？

## 5. 真实测试副产物（安全）

- 为定位 404，模型上下文曾读取受保护凭据文件 → 用户已于 2026-10-01 轮换 key
  （核对：新旧 key 不同、长度 65 vs 64），并确认旧 key 在 `.astarray/` 状态产物中**零残留**。
- 所有临时探针目录（`.tmp/live-write-probe`、`.tmp/captures`、`.tmp/diagnose-*`、`.tmp/replay-*`）均在 `.tmp/`（gitignore）内，
  未进入提交；`.astarray/` 全程未暂存。
