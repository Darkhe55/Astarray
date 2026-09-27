# Ponder 任务入口虚报受理与崩溃（缺陷发现与修复，2026-09-22）

> 发现方式：核查"生产装配缺口"时的模式探针（`astarray run --mode ponder` 与 SDK `submitTask`）。
> 状态：**已复现、已修复**。修复提交见 §5。

## 1. 症状（修复前实测）

CLI（`astarray run "只读问题" --mode ponder --runtime mock --json`）：

```
astarray: （主 Agent 应答）任务已受理。          <- 先声称受理
DomainError: 任务不存在: ponder                   <- 随后未捕获异常 + 栈
    at MissionManager.getMissionStatus
    at AstarrayApplicationFacade.queryTask
```

- 无 JSON 输出、非零退出；错误原文与调用栈直接暴露给用户（违反稳定错误码/不泄露内部细节）。
- SDK：`submitTask({mode:"ponder"})` → `{status:"accepted", missionIdentifier:"ponder"}`；紧接着 `queryTask` → `mission-not-found`。
- 对照：assist / devolve 同一流程正常（`mission-xxxx` → `done`）。

## 2. 根因

| 位置 | 事实 |
| --- | --- |
| `packages/core/src/orchestration/main-controller.ts:196-201` | Ponder 走 `respondInPonderMode(message)` 后 **返回字面量 `"ponder"`**（设计上 Ponder 不产生 mission，正文经 streamOutput 送达） |
| `packages/core/src/public-sdk.ts:2156-2172` | `submitTask` 把这个返回值直接当作 `missionIdentifier` 写入任务记录，并回 `status:"accepted"` → **虚报受理**；随后任何 `queryTask` 必然 `mission-not-found` |
| `main-controller.ts:236-241` | 既有约定：Ponder 的 mission 操作应抛 `invalid-mode-transition`（`resumeMission` 已如此），任务入口却未对齐 |

## 3. 修复

1. `public-sdk.submitTask`：Ponder 模式**明确拒绝**并指向直接问答入口——
   `PublicApplicationError("invalid-mode-transition", "Ponder 模式为本地只读问答，不产生 mission；请使用 handleUserMessage 获取直接回答")`。
2. `packages/tui/src/cli/run-command.ts`：Ponder 分支改为调用 `handleUserMessage` 并输出
   `{mode:"ponder", status:"done", answer, prompt}`，退出码 0；**不再进入任务轮询**。
   `answer` 取自 `streamOutput` 的正文流（`handleUserMessage` 的返回值是内部哨兵，不能当正文；首版修复曾误用该哨兵，已修正并由测试锁定）。

## 4. 验证（先红后绿）

- **红**：新增/扩展用例在修复前失败——`tests/core/unit/ponder-task-entry.test.ts`（submitTask 拒绝）与 `tests/tui/unit/run-command-gaps.test.ts` 的 Ponder JSON 用例（`5 failed | 1 passed`，其中 3 项为 threads 池下 cwd 依赖套件的已知环境失败）。
- **绿（官方门禁，完整访问 + 默认 forks 池）**：构建成功；全量 **231 文件 / 1866 用例**；覆盖率 **93.11 / 85.34 / 93.22 / 93.13**；安全关键模块 **22/22**。
- **端到端（真实 dist CLI）**：

```
$ node dist/cli.js run "只读问题" --mode ponder --runtime mock --json ; echo $?
{ "mode": "ponder", "status": "done", "answer": "（主 Agent 应答）任务已受理。", "prompt": "只读问题" }
0
```

（`answer` 为 mock 运行时的固定台词；换真实 Provider 时即模型回答。测试断言 `answer` 非空且**不等于哨兵 `"ponder"`**。）

## 5. 提交

见本会话对应提交（`fix(ponder): 任务入口拒绝 Ponder 并返回直接问答结果`）；涉及 `public-sdk.ts`、`run-command.ts` 与两个测试文件。

## 6. 残留（未纳入本次修复）

- `localToolPolicyEngine` 与 `ponderGitRepositoryPath` 仍未注入 builtins 上下文（`policy-wrapper.ts` 选项存在但生产未传）——当前无 Ponder 专属工具，故表现为 fail-closed；若后续为 Ponder 增加只读文件/检索工具，需要单独检查点接线。
- Ponder 目前是"直接问答、无 mission、无工具执行"的最小形态；Ponder 下的只读工具执行（ADR-0014 白名单）尚未在公共入口落地。
