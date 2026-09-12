# E2E-01-02 切片 4b：合并门禁（验收 4）与主报告按需读取（验收 5）

> 检查点：E2E-01-02（仍为 **in_progress**：验收 1/2/3 见切片 4a；本切片覆盖 4/5）
> 前驱：切片 4a。日期：2026-09-10
> 证据代码：`tests/core/integration/e2e01-vertical-integration-report.test.ts`

## 1. 验收 4：拒绝未授权合并（真实 git 仓库）

真实仓库（`src/app.mjs` 允许、`docs/readme.md` 越界），单 worker worktree，绑定三级身份：

| 步骤 | 结果 |
| --- | --- |
| 越界提交（改 `docs/readme.md`） | 审查 **rejected**，拒绝原因含"越过允许路径"；目标分支 `main` **未变** |
| 合规提交（改 `src/app.mjs`，绑定身份） | 审查 **accepted** |
| `finalizeIntegration(isTargetBranchMergeAllowed: false)` | 目标分支 `main` **仍未变**（未授权不合入） |
| `finalizeIntegration(isTargetBranchMergeAllowed: true)` | 目标分支前进，`src/app.mjs` 内容为 `v2-implemented`（真实产物落地） |

## 2. 验收 5：主报告按需读取、不抢占主对话

通过 CLI 装配入口（`bootstrapCli`）取得运行时；先按 B6R-07 登记报告来源
（绑定 mission / 所属次级 / 任务包），再写入三级终态报告：

- `ingestTertiaryTerminalReport(...)` 后，`streamOutput` 捕获到的对话输出为 **0 条**（不唤醒主 Agent、不注入对话）；
- `listReportIndex("mission-vertical")` 按需只读返回该报告（`reportId`、`summaryPreview` 含"实现完成"）；
- 读取前后对话输出仍为 0 条。

## 3. 产品侧变更（小）

`ApplicationRuntime` 现在对外暴露 `registeredAgentDirectory`（B6R-09 报告来源登记入口）——
该目录此前已在装配内创建但未出现在运行时接口上，报告来源认证无法从公共装配入口使用。

## 4. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；176 文件 / 1499 用例通过 |
| `npm run test:coverage` | exit 0（第 3 次运行）；176 文件 / 1499 用例通过；全局 93.71% stmts / **86.54% branch** / 91.73% funcs / 93.75% lines |
| 聚焦 `e2e01-vertical-integration-report` | 2/2 通过（验收 5 亦可在受限环境单独运行） |

前两次覆盖率运行各出现一个不同的已知高负载偶发失败（`recovery-process-handoff`、
`provider-fake-server` 慢流）；`npm run check` 全程未复现。

## 5. 本检查点剩余

- **纵向编排产品化**：目前 step 间编排在验收流程内（各步均为真实产品执行）；若要成为产品能力，
  需在次级调度层显式编排 侦察→规划→实现→测试→验收→返修→集成→报告。
- **切片 5**：tarball 隔离安装下复现纵向场景 + 交付检查（`npm pack`/`verify-package`/`smoke-install`）。
- **E2E-01-03**：真实 Provider + 人工并发变化，仍待用户凭据与费用授权。
