# T07D-R2-04 受控在线小样本证据（真实 Provider，2026-10-01）

> 检查点：`docs/tasks/T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md` §T07D-R2-04（此前 `blocked`）。
> 前置：用户 2026-10-01 提供真实 Provider 凭据与费用授权（模型 `step-3.7-flash`、最多 3 次真实请求、单次超时 60s）。
> 基线：`HEAD == origin/main == d17ff61`；本检查点未改动仓库代码（仅新增本文档 + 写状态目录）。

## 1. 资源与凭据（不泄漏 key）

| 项 | 值 |
| --- | --- |
| Provider 端点主机 | `api.stepfun.com`（阶跃星辰，OpenAI 兼容） |
| 协议 | `generic-openai-compatible`，API 版本 `2024-06-01`（本地声明） |
| 模型 | `step-3.7-flash`（用户提供；用户另说明支持图片/视频理解） |
| 受保护凭据引用 | `prov-live-1` → `.astarray/providers/provider-credentials.json`（`.gitignore` 第 8 行 `.astarray/` 覆盖） |
| 档案 ID | `live-provider-1`（`.astarray/providers/provider-catalog.json`） |
| 费用授权 | 最多 **3 次**真实请求；实际使用 **3 次**，其中 1 次被服务端拒绝（无 token 计费） |
| 支持等级变更 | `adapter-only` → `live-smoke-verified`（本检查点，含证据） |

## 2. 三次受控调用（全部真实、上限内、无默认套件联网）

| # | 命令（要点） | 退出码 | 状态 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `run --runtime openai-compatible --provider-model step-3.7-flash --provider-credential-reference prov-live-1 --timeout-seconds 60 --json` | 1 | `blocked` | **Provider 返回 404**；原因：凭据 baseUrl 写成 `https://api.stepfun.com/step_fun/v1/chat/completions`（多了 `step_fun` 段）。运行时把 baseUrl **原样**作为 POST 目标（`openai-compatible-runtime.ts:62`），不补全路径 |
| 2 | 同命令（baseUrl 修正后） | 1 | `blocked` | **真实响应成功**（模型返回正文），但未输出 `ASTARRAY_TASK_COMPLETION_V1` 完成控制事件 → 本地完成门禁拒绝宣布成功（按设计 fail-closed） |
| 3 | 同命令，提示词显式给出完成控制事件格式 | **0** | **`done`** | 真实 Provider + 完成门禁闭环成立 |

### 2.1 第 1 次的 404 与修正

- 修正前：`https://api.stepfun.com/step_fun/v1/chat/completions`
- 修正后：`https://api.stepfun.com/v1/chat/completions`
- 修正方式：本地改写受保护凭据文件的 `baseUrl`（**未触碰 key**），原值备份至 `provider-credentials.json.bak`；
  修正后 `doctor --provider live-provider-1 --json` 仍报告 `credentialReferenceResolved: true`。
- 服务端 404 属请求被拒，**未产生 token 计费**。

### 2.2 第 3 次成功调用的原始输出

```json
{ "missionId": "mission-a4154061", "mode": "assist", "status": "done", "prompt": "只读探针…（要求最后一行原样输出完成控制事件）" }
```

- 退出码：**0**；`status`：**done**；`mode`：`assist`。
- 状态目录：`.astarray/missions/mission-a4154061/`（`task-chain.json`、`summary.json`、`agents/worker~003a…/work-archive.json`）。

## 3. usage / 费用范围（如实标记）

- 上下文装配事件（`.astarray/context-runtime/events.jsonl`，第 3 条）：
  `estimatedInjectedTokenCount: 41`、`effectiveBudgetTokens: 4096`、`cacheStatus: "miss"`、
  `recordedAtIso: "2026-10-01T02:37:41.205Z"`、`agentInstanceId: "worker:mission-a4154061:T-001:1"`。
- **Provider 侧 usage（prompt/completion tokens）未采集** —— 与 `T09A-R1-04` 既有口径一致，如实标记 `unavailable`，
  不估算、不冒充真实计费数字。
- 费用范围：调用上限 3 次（实际 3 次，其中 1 次 404 无计费）；单次超时 60s；未产生其他网络出口
  （三次调用均只指向 `api.stepfun.com`，本地协议服务器未参与）。

## 4. 验收对照（T07D-R2-04）

| 卡内验收 | 结果 | 证据 |
| --- | --- | --- |
| 至少一个真实服务成功完成**读任务** | ✅ 达成 | §2 第 3 次：`status=done`，提示为只读探针（未修改任何文件） |
| 至少一个真实服务成功完成**小型受控改动** | ⛔ **未达成** | 需在人工工作树产生真实文件改动（并配合陈旧写入/恢复验收），属 E2E-01-03，需要新的额度与用户现场配合 |
| 记录模型/协议/日期/版本/usage/产物/限制 | ✅ 本文档 §1–§3 + §5 | — |
| CLI/TUI/SDK 用同一配置 | ⚠️ **部分** | `run` 入口已用 `--provider-credential-reference prov-live-1` + 同模型；`gui` / `mcp serve` 尚未在**真实** Provider 上启动（此前仅在隔离安装产物上用本地协议服务器验证）。因为该模型需要人来提供完成控制事件，长驻入口的真实任务闭环无法给出确定性断言 |
| 未选其他 Provider 不得宣称产品可用 | 遵守 | 仅声明 `stepfun / step-3.7-flash / api.stepfun.com` 的实测结论 |

## 5. 发现的差异与限制（如实记录）

1. **baseUrl 必须是与 `chat/completions` 完全对齐的完整 URL**：运行时不做路径拼接，
   写错一段即 404。建议后续产品化：`credential-set` 增加**形态校验**（要求以 `/chat/completions` 结尾）
   或明确区分「endpoint 前缀」与「完整 URL」。
2. **模型不会自发输出完成控制事件**：第 2 次调用证明，即使任务成功完成，模型默认不输出
   `ASTARRAY_TASK_COMPLETION_V1`；必须在提示词中显式给出格式才能通过门禁。
   这是"模型 × 完成协议"的真实兼容性事实，建议纳入支持矩阵（`条件兼容：需协议提示`）。
3. **Provider usage 未采集**：`stepfun` 的响应 usage 未进入上下文指标（与既有口径一致）。
4. **目录登记与运行时仍未接通**：`live-provider-1` 的档案不参与运行时解析；模型与端点在每次调用时
   由 `--provider-model` + 受保护引用给出（详见 `docs/reports/PROVIDER_CONFIG_WRITE_SURFACE_2026-10-01.md` §残留）。
5. **图片/视频理解未验证**：用户说明该模型支持多模态，但本检查点只跑文本探针；
   多模态能力未验收，不得在支持矩阵中声明。

## 6. 凭据安全

- 调用期间为定位 404，**模型上下文曾读到该 API key**（受保护凭据文件被 read）。
  文件本身在 `.gitignore` 覆盖范围内，未进 Git、未进日志、未写入对话；
  仍建议**轮换该 key** 后以同一引用 ID 重新 `credential-set`。
- 状态目录 `.astarray/` 全程未被暂存；`git status` 仅含用户并行文件。
