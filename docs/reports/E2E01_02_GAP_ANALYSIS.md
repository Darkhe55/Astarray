# E2E-01-02 缺口分析与切片计划（路线修正）

> 检查点：E2E-01-02（docs/tasks/E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD.md）
> 状态：**in_progress**（切片 1 已交付；本轮为切片 2：能力探针与缺口分析）
> 日期：2026-09-10；证据代码：`tests/core/integration/e2e01-provider-write-probe.test.ts`

## 1. 本轮验证到的事实（可复现）

探针在真实装配下运行：`AstarrayApplicationFacade.create({runtime:"provider"})` + 本地协议服务器脚本化
`replaceFileContent` 调用，目标为 E2E-01-01 冻结 fixture 的 `project/src/summarize-tasks.mjs`。

观察结果（测试同时记录为"必须成立的不变量（it.fails）"与"当前行为特征"）：

| 观察项 | 结果 |
| --- | --- |
| 任务终态 | **done**（完成控制事件被本地门禁接受） |
| 目标文件 | **未变化**（仍为冻结桩 `E2E01_TARGET_NOT_IMPLEMENTED`） |
| 产物 | 无（没有实现文件、没有测试证据） |

两个独立事实：

- **缺口 1（权限可达性）——已在切片 3b 提供受控通道**（见 docs/reports/E2E01_02_CREATE_FILE_CHANNEL_EVIDENCE.md）：
  原状：worker 可用工具中唯一能写工作区文件的是 `replaceFileContent`（映射 `project.modify` +
  `project.destructive-mutate`，assist 默认 deny），`writeFileTemporary` 只能写临时目录。
  现新增 `createProjectFile`（仅新建、`project.create`：devolve 默认 allow、assist 默认 ask
  → 无应答方时 fail-closed）。
- **缺口 2（完成门禁缺陷）——已在切片 3 修复**（见 docs/reports/E2E01_02_COMPLETION_GATE_EVIDENCE.md）：
  修复前工具调用被拒且没有任何产物时任务仍以 **done** 收口；修复后未解决的写操作失败会拒绝结案
  并以 failure 升级给用户。

## 2. 尚未具备的纵向能力（缺口 3）

E2E-01-02 要求的"侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取"目前没有
产品级编排组合：

- 侦察：`ProjectReconnaissanceController` + `ProjectReconnaissanceDigestStore`（存在，未与纵向流程组合）。
- 实现/测试/验收：仅按"每任务一个 worker"派发（`AssistScheduler`/`DevolveScheduler`），
  没有按角色任命不同 `agentInstanceId` 的产品入口，也没有验收裁决回流。
- 返修：Git 侧有 `needs-rework`（`GitContributionVerifier`/`GitIntegrationCoordinator`），但没有
  "因测试失败而返修并重新派发"的产品编排。
- 次级集成/合并门禁：组件存在，未接入纵向流程。
- 主报告：`MainController.ingestTertiaryTerminalReport`/`listReportIndex` 存在（按需只读），
  但没有纵向流程末端写入。

## 3. 切片计划（每轮一个切片，均可构建/可测试）

| 切片 | 内容 | 验收 |
| --- | --- | --- |
| 1（已完成，`d5430d9`） | 本地协议服务器 + `run --runtime openai-compatible` 公共入口接线 | 真实请求到 done、缺端点/模型 fail-closed |
| 2（本轮） | 能力探针 + 缺口分析（本文档 + `e2e01-provider-write-probe`） | 不变量以 `it.fails` 记录；特征行为已固定；缺口可复现 |
| 3 | **完成门禁修复**：完成控制事件必须与本轮真实工具结果对账——存在未满足的权限/工具失败或声明中的完成任务无产物证据时，拒绝结案并给出可操作裁决；为 worker 提供受控的**新建项目文件**通道（`project.create` 语义，still ask/deny by default，需显式授权） | `it.fails` 变为普通 `it` 并通过；被拒后不得 done；授权后真实写入并留下产物 |
| 4 | 纵向编排：侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取，三角色身份不同、强制一次失败返修、拒绝未授权合并、主报告按需读取不被抢占 | 全流程实际产物 + 测试证据 + 身份/合并/报告证据 |
| 5 | 在 tarball 隔离安装下重复切片 4 场景；真实 Provider（E2E-01-03）待凭据与费用授权 | tarball 证据 + 平台记录；凭据缺失时保持 blocked |

## 4. 当前检查点结论

E2E-01-02 **未通过**（保持 in_progress）：无纵向编排，且已发现完成门禁缺陷与写入通道缺口。
不得用本轮探针或切片 1 的证据宣布该检查点完成；E2E-01-03 仍受真实凭据/费用授权阻塞。
