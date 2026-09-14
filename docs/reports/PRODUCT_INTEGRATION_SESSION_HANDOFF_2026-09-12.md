# 产品接线批次：会话收尾与交接（2026-09-12）

> 当前 HEAD / origin/main：`401196f`（BRIDGE-01-02 补记），无未推送提交。
> 目标：goal-20b28d68…（按 docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md 顺序推进），本轮结束时暂停。

## 1. 已完成（按推荐顺序）

| 顺序 | 卡片 / 检查点 | 状态 | 关键提交 |
| --- | --- | --- | --- |
| 1 | INT-00 产品路径审计 | done | （本会话前） |
| 2 | T07D-R1 应用装配与公开 SDK | done | （本会话前） |
| 3 | T07D-R2-01/02/03 Provider 产品接线 | done | （本会话前） |
| 3b | T07D-R2-04 真实 Provider 证据 | **blocked** | 缺用户凭据与费用授权 |
| 4 | T09A-R1 上下文运行时接线（-01..-04） | done | `4f7e815`…`eedc2db` |
| 5 | T12A-R1 恢复（-01..-04） | done | `7582dad`…`dcb0288`、`daf7cd1`…`d59cc74`、`e826e12`…`d4d6083`、`e710d56`…`4749e5d` |
| 6 | E2E-01-01 验收 fixture 与证据协议 | done | `23f38eb`…`9eca588` |
| 6 | E2E-01-02 确定性纵向闭环（切片 1–7） | done | `d5430d9`…`176dfd6`（切片 7 判定 done） |
| 6 | E2E-01-03 真实服务与并行中断 | **pending/blocked** | 需真实 Provider 凭据与费用授权 |
| 6 | E2E-01-04 质量与交付声明 | in_progress | 本地可证项 `68a8a40`；未决：人工体验、Linux/macOS、真实服务 |
| 7 | BRIDGE-01-01 目标与协议冻结（ADR-0032：MCP 2026-07-28 + stdio） | done | `175d40b`…`ca8acba` |
| 7 | BRIDGE-01-02 MCP 最小工具映射（桥接 + stdio 会话 + `astarray mcp serve`） | done | `b652109`…`401196f` |

## 2. 门禁基线（最后一次全量）

- `npm run check`：exit 0，**180 文件 / 1528 用例**。
- `npm run test:coverage`：exit 0，全局 93.7% stmts / **86.54% branch** / 91.9% funcs / 93.73% lines；`core/src/bridge` 目录 100% stmts/funcs/lines、88.49% branch。
- `npm run verify:security-coverage`：**22/22 关键安全模块 ≥95%**（AR-07 §1 清单，含分母）。
- 交付检查（E2E-01-04 本地项）：`smoke-install` exit 0；`npm pack` + `verify-package` exit 0（201 文件）；tarball sha256 `9bffc6442423c67f19139ac54bf36ac4eee0d276fcddbe4406f968a1e7a8c1a3`。
- E2E-01-02 的 tarball 纵向复现：产物 `out/summary.json` sha256 `fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d`（与冻结证据一致）。

## 3. 下一轮起点

1. **BRIDGE-01-03 边界与断连**：会话隔离、逐次权限复检、结果脱敏、断连重试、取消、服务关闭；
   协议层不得直接执行底层写工具；顺带收紧 `orchestration/external-harness-bridge-port.ts`
   的前缀式身份规则（BRIDGE-01-02 已记录该遗留）。
2. **BRIDGE-01-04 真实客户端消费**：需要真实 MCP 客户端（待确认依赖，按协同安装门禁先询问用户），
   并给出对外支持声明（绑定版本与平台）。
3. **GUI-01-R → WB-00**（GUI 基础依赖 T07D-R1 已满足；功能联测依赖 T09A-R1/T12A-R1 已满足）。
4. **E2E-01-03**：真实 Provider + 人工并发变化（缺凭据/费用授权时保持 blocked）。
5. **E2E-01-04 未决项**：人工体验结论、Linux/macOS 平台验证。

## 4. 工作树与并行改动（有意未暂存）

- `IMPLEMENTATION_PLAN.md`、`PLAN_STATUS.md`、`docs/tasks/README.md`（M，用户并行改动）
- `tests/core/unit/application-sdk-task-events.test.ts`（M，既有未提交的加固改动）
- 未跟踪卡：`GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md`、`PRODUCT_INTEGRATION_ROLLOUT.md`、`WB00_MICRO_EDIT_WORKBENCH_PROTOTYPE_TASK_CARD.md`

## 5. 环境与操作要点（供接手）

- `npm run check` / `test:coverage` / `npm pack` / `git push` 需要完整访问权限（沙箱受限通道下
  esbuild/forks/spawn 必失败）；审批通道偶发停滞（需重试 2–3 次，曾出现 `read` 上限导致的整文件写入截断，
  已用 `git checkout` 还原并改为定点编辑，教训：**不要用 read+write 整文件改写超过读取上限的文件**）。
- 覆盖率偶发（高负载下单点失败：`cli-commands`、`recovery-process-handoff`、`provider-fake-server` 等），
  复跑即绿；`npm run check` 全程未复现。
- 新增辅助命令：`npm run verify:e2e01`（fixture 闭环）、`npm run verify:security-coverage`
  （关键安全模块专项）、本地协议服务器 `scripts/e2e01-local-protocol-server.mjs`。
- 恢复目标：认领 goal `goal-20b28d68-310d-486e-b0a8-6a92c84586ff` 并 `resume`，从 BRIDGE-01-03 继续。
## 6. 门禁与推送补齐（2026-09-13，本轮）

- `npm run check` **exit 0**：typecheck + lint + build + test；187 文件 / 1566 用例全通过。
- `npm run test:coverage` **exit 0**（复跑；首跑仅 `cli-commands`、`run-command-gaps` 两个已知超时波动用例失败）：187 文件 / 1566 用例通过；全局 statements **93.61%** / branch **86.40%** / functions **91.98%** / lines **93.64%**（阈值 85）。
- `npm run verify:security-coverage` **exit 0**：关键安全模块 **22/22** 达标（单模块 ≥95%）。
- 打包验收：`npm pack` exit 0；`verify-package` exit 0（**207 文件**，shebang/BOM 正确，反馈进程入口已包含）；`smoke-install` exit 0（隔离安装 + `doctor --json` + `run --runtime mock` → done + 全局 shim 与反馈入口加载）；tarball sha256 `e709427a6d52c7bbd7ebae923f5755b7ff653c67236bac886d2edea02f7e7f7e`。
- 安装包 GUI 冒烟：从隔离安装的 `astarray.cmd gui --port 0 --no-open` 启动 → `GET /` 200（12415 字节，含设置/恢复/待追认面板），`GET /state` 返回脱敏快照，终止后端口释放（04b 的"从安装包打开 GUI"自动部分已补齐；人工视觉/键盘结论仍未做）。
- `git push` **exit 0**：`0946530..28705b2`（推送 GUI-01-R-02/03a/03b/04a 与 WB-00-01 等 8 个提交；`origin/main` = `28705b2`）。
- 并行改动仍全部未暂存；`docs/tasks/WB00_MICRO_EDIT_WORKBENCH_PROTOTYPE_TASK_CARD.md` 为未跟踪用户文件，本轮未修改未暂存（注意：第 4 节所述"未跟踪卡"里 GUI-01-R 卡已在 GUI-01-R-01 时入库）。
- 仍待人工/平台：GUI-01-R-04b 真实用户人工体验结论（键盘/中文/缩放/可访问性/断线恢复）与 Linux/macOS 证据；WB-00-02 实现需等 GUI-01-R 交付验收（本卡仅允许概念提前）。
## 7. 后续进度（2026-09-13，SUM 批次启动）

- **WB-00-01**（细节微淘能力边界）：ADR-0033 + `docs/reports/WB00_01_SCOPE_FREEZE.md`，提交 `28705b2`。WB-00-02 需等 GUI-01-R 交付验收。
- **SUM-01-01**（摘要清单/游标/动态详细度契约）：ADR-0034 + `packages/core/src/summarization/summary-manifest.ts`（原型）+ 7 个反例用例 + `docs/reports/SUM01_01_MANIFEST_CONTRACT.md`，提交 `33071ec`。
  - 门禁：`npm run check` exit 0（188 文件/1573 用例）；`test:coverage` exit 0（93.60/86.38/92.04/93.63）；`git push` 成功 `1103da4..33071ec`。
- **SUM-01-02**（增量索引受控保存与原子发布）：`summary-fact-extractor.ts`、`summary-index-store.ts`、`summary-generation-service.ts` + ADR-0034 §12–19 + `docs/reports/SUM01_02_ATOMIC_PUBLISH.md`，提交 `e606578`。
  - 门禁：`npm run check` exit 0（189 文件/1580 用例）；`test:coverage` exit 0（93.46/86.20/92.01/93.49）；`git push` `98c4297..e606578`。
  - 首轮被 `destructive-file-api-guard` 拦截（新模块直接 rm），改为底层 `removeJsonFileWithBackup`（先备份再删）后全绿——**不得靠扩白名单绕过**。
  - 已知：`summarization` 目录 branch 80.86%，待 SUM-01-03 读取分支补齐。
- **SUM-01-03**（默认摘要读取/章节展开/旁置索引）：`summary-read-service.ts`、`summary-sidecar-index.ts` + ADR-0034 §20–23 + `docs/reports/SUM01_03_READ_PATH.md`，提交 `b68c1bc`。
  - 门禁：`npm run check` exit 0（190 文件/1587 用例）；`test:coverage` exit 0（93.54/86.20/92.20/93.57；summarization 目录 91.76/81.64/96.47/91.64）；`git push` `5664aac..4c8993e`。
  - 附：`test(gui)` 提交 `4c8993e` 为既有 GUI 用例加整文件 30s 超时（覆盖率插桩下真实任务链路超 5s 默认值）。
- 下一轮：SUM-01-04（应用/CLI/TUI 接线、安装包消费与资源指标；接真实会话历史/工作存档/报告/延后文件来源）。
- 仍待用户/外部输入：GUI-01-R-04b 人工体验与 Linux/macOS；BRIDGE-01-04 真实 MCP 客户端；E2E-01-03 真实 Provider 凭据/费用授权；E2E-01-04 人工结论。
