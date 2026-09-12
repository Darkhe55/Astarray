# E2E-01-02 切片 7：纵向闭环运行器的公共入口（workflow run）

> 检查点：E2E-01-02（本切片补齐"纵向编排产品化"后，验收 1–5 均有直接证据）
> 前驱：切片 6b。日期：2026-09-10
> 证据代码：`tests/tui/integration/workflow-scenario-entry.test.ts`

## 1. 产品接线

- `ApplicationRuntime` 现在构造并暴露 `standaloneWorkflowRunner`
  （`packages/core/src/orchestration/standalone-workflow-runner.ts`，T07D-07 的纵向闭环运行器）。
- 新增公共入口 `workflow run`（`cli.tsx` + `executeWorkflowScenarioCommand`）：
  - `--scenario readonly-analysis --mission <id> --scope <text> --digest-file <path>`
  - `--scenario small-coding --task <id> --appointment <id> --implementation-agent <id>
    --testing-agent <id> --acceptance-agent <id> --commit <hash> [--task-revision <n>]`
  - 本地控制面在运行前登记本次派出的侦察三级/所属次级（非空字符串不是认证）。

## 2. 证据（三例）

| 用例 | 结果 |
| --- | --- |
| 场景 A（只读分析） | exit 0；步骤全部 passed；`digestReference=digest-workflow-1`；`mainAgentContextInjected=false`（项目全文/.env/私有记忆不进入主上下文） |
| 场景 B（小型代码任务） | exit 0；三身份任命 → 验收裁决 `merge-ready` → 合并门禁 `isMergeReady=true`；步骤全部 passed |
| 场景 B 反例（作者自验） | 实现者与验收者同一身份 → 任命被拒（`process.exit:1`），不得自验 |

## 3. E2E-01-02 验收证据汇总

| 验收条款 | 证据 |
| --- | --- |
| 实际产物与测试证据 | 切片 5（tarball 隔离安装 + 本地协议服务器）：实现→冻结测试失败→返修→测试通过，产物 `out/summary.json` sha256 `fc1328fb…` |
| 实现/测试/验收身份不同 | 切片 4a（三个产品 mission，三个不同 `agentInstanceId`）；本切片（三身份任命 + 自验拒绝） |
| 强制一次测试失败验证返修 | 切片 4a 与切片 5（第一版错误实现被冻结测试判失败 → 返修后通过） |
| 拒绝未授权合并 | 切片 4b（越界拒绝 + 未授权不合入 + 授权后合入） |
| 主对话不被后台报告抢占 | 切片 4b（报告只入索引、对话输出 0 条、按需只读） |
| 侦察→规划 | 切片 6/6b（只读侦察子集、PROJECT_CONTEXT_DIGEST_V1 按 mission 认证、任务插入提案层级规则） |
| 纵向编排产品化 | 本切片（`workflow run` 公共入口驱动 `StandaloneWorkflowRunner`） |
| 本地协议服务器 + tarball | 切片 1/5 |

## 4. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；178 文件 / 1504 用例通过 |
| `npm run test:coverage` | exit 0；178 文件 / 1504 用例通过；全局 93.73% stmts / **86.54% branch** / 91.89% funcs / 93.77% lines |
| 聚焦 `workflow-scenario-entry` | 3/3 通过 |

## 5. 范围说明与后续

- **E2E-01-02 结论**：五条验收条款与侦察/规划/编排产品化均有直接证据；本检查点判定 done。
  说明：`StandaloneWorkflowRunner` 的场景 B 以"记录门禁决策"的方式编排（真实 git 提交/审查/合并门禁
  由切片 4b 的真实仓库证据覆盖）；"单一命令内跑完整真实链条"与真实 Provider 场景分别属于
  E2E-01-03（真实服务，当前缺凭据/费用授权）与 E2E-01-04（质量与交付声明）。
- **E2E-01-03**：待用户凭据与费用授权，保持 pending/blocked。
- **E2E-01-04**：check/coverage/安全关键模块专项/tarball 回归 + 平台与人工结论。
