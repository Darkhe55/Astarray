# 完成协议扩展：产物/验收对账（2026-10-02）

> 用户指令："开始"（承接 `CLI_E2E_FORENSICS_AND_RESIDUAL_GAPS_2026-10-02.md` §3.2 的结构性缺口）。
> 纪律：先写行为反例 → 实现 → `npm run check`（+覆盖率）→ 只暂存本检查点文件 → 本地提交 → push。

## 1. 缺口（复述）

`LocalCompletionVerifier` 有第 4 项"产物存在性 + 验收门禁证据"，但**从未接入生产路径**
（`grep` 显示仅测试调用）。`worker.verifyCompletionControlEvent()` 只做"解析 + 任务 ID"，
因此出现**产物未生成却结案 `done`**（真实 CLI 复现，见 §3.2）。

## 2. 本检查点实现

| 件 | 内容 |
| --- | --- |
| `packages/core/src/orchestration/artifact-verification.ts`（新） | ① `extractArtifactPathFromToolCall`：只从**写类工具的参数**取目标路径（`filePath`/`path`/`fileName`/`targetPath`/`directoryPath`）；② `verifyArtifactExistence`：逐条核对（必须存在且**是文件**），拒绝绝对路径与 `..` 越界路径，产出 `{gateName, passed}` 证据 |
| `packages/core/src/orchestration/worker-agent.ts` | 写类工具**成功**时登记其目标路径（本地确定性事实，非模型自述）；结案前对账"已登记路径 + 完成事件声明的产物"，任一缺失 → 判 `failure`，原因含"验收缺失，不得结案" |
| `packages/core/src/core/completion-protocol.ts` | 版本化扩展：`declaredArtifacts?: string[]`（≤64，可选，向后兼容；空串/非数组视为无合法完成事件） |
| `packages/core/src/runtime/tool-loop.ts` | 完成协议重述补充 `declaredArtifacts` 用法与"本地逐条核对存在性，缺失即拒绝结案" |
| 新选项 `artifactWorkspaceRootPath` | 对账工作区根，缺省 `process.cwd()`（与产品路径一致；测试可注入临时目录） |

**边界（刻意不做）**：模型**文字里出现的路径不得**作为产物依据——自述不是本地事实。
纯只读任务不产生任何产物要求（避免误拦正常完成）。

## 3. 反例（先写、先失败，再实现）

| 文件 | 用例 |
| --- | --- |
| `tests/core/integration/artifact-verification.test.ts`（7） | 路径提取（写类/只读/不可解析）、存在→通过、缺失→不通过、目录不算产物、越界路径一律不通过、重复去重 |
| `tests/core/integration/worker-artifact-completion-gate.test.ts`（4） | ① 产物存在 → **接受**（不误拦）；② 写成功后产物消失 → **判失败**（验收缺失）；③ 完成事件声明从未创建的产物 → **判失败**；④ 声明越界路径 → **判失败**（拒绝工作区外路径） |
| `tests/core/unit/completion-protocol.test.ts`（+2） | `declaredArtifacts` 合法解析 / 缺省为 `undefined`（向后兼容）/ 空串与非数组 → 无合法完成事件 |

## 4. 门禁

- `npm run check`：**252 文件 / 1957 用例** exit 0（36.26s）。
- 覆盖率：`tests/core tests/tui --coverage` 通过 85 阈值（exit 0）。
- **本机负载敏感性（实测，记录备查）**：同一份代码的 `tests/core tests/tui` 全量墙钟在
  **36s–70s** 间波动（40–90% 差异）；慢窗口下会出现 1–4 个 30s/60s 级超时用例，
  且**每次命中的用例不同**（`provider-fake-server`、`gui-verification-decision`、
  `cli-commands`、`e2e01-vertical-rework`、`context-node-lifecycle`、`guidance-product-entry` 等），
  全部**独立运行通过**。故此类失败按"环境负载"处理，不作为功能回归；已用同一时间窗 A/B
  复核（含/不含本改动）交叉验证。

## 5. 仍未完成（下一检查点）

`CLI_E2E_FORENSICS_AND_RESIDUAL_GAPS_2026-10-02.md` §3.1：`allow-once` 后重跑仍可能命中
`auth-scope-replay-rejected`（被拒尝试消费了作用域指纹记录）→ 产物不会生成。
本检查点让这种情形**不再被误判为完成**（产物对账会拒绝结案），但**根因未修**：
需要专门收敛"作用域记录 vs 逻辑预留"的消费语义，并同步更新受影响的既有测试。
