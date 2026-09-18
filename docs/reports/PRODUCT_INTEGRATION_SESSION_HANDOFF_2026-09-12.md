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
- **SUM-01-04a**（摘要产品入口接线与资源观测）：`summary-source-adapters.ts`（工作存档→来源条目）、`summary-resource-metrics.ts`、门面 `summarizeArchivedMission/listSummarySources/readSummaryView/expandSummarySectionView` + ADR-0034 §24–27 + `docs/reports/SUM01_04A_PRODUCT_WIRING.md`，提交 `dae16e1`。
  - 门禁：`npm run check` exit 0（192 文件）；`test:coverage` exit 0（93.53/86.07/92.34/93.54；summarization 91.25/80.61/95.95/91.12）；`git push` `c40dc2f..ebd5aad`。
  - 附：`ebd5aad` 为既有 CLI/E2E 用例的 60s 超时加固（插桩+Windows 临时目录竞争下的真实 mission 链路；断言不变）。注意 `--pool=threads` 下 `process.chdir` 不可用，cwd 类用例只能以 forks 门禁为准。
- **SUM-01-04b**（摘要 CLI 接线与安装包消费）：`astarray summary list|build|show` + `scripts/verify-summary-package.mjs`（安装包公共 SDK 消费 2400 条大历史摘要、12 页分页、章节展开与资源观测）+ `docs/reports/SUM01_04B_PACKAGE_CONSUMPTION.md`，提交 `ca15e30`、`7315169`。
  - 门禁：`npm run check` exit 0（193 文件/1595 用例）；`test:coverage` exit 0（93.32/85.88/92.25/93.35；summarization 91.51/80.61/95.95/91.38）；`npm pack` sha256 `8ff87702…`；`verify-package` 209 文件 exit 0；`smoke-install` exit 0；`verify-summary-package` 8/8 检查通过。
  - 已知波动：`npm pack` 的 prepack 会重跑全量 check，本检查点两次命中既有 `e2e01-vertical-rework` 间歇失败；用有界重试（至多 2 次）通过，未跳过 prepack/测试、未放宽断言。
- SUM-01 四检查点（01~04a/b）就此收口。
- **SUM-02-01**（token 计量适配端口与来源 schema）：`packages/core/src/measurement/token-measurement.ts` + ADR-0035 + `docs/reports/SUM02_01_TOKEN_MEASUREMENT.md`，提交 `f620463`。
  - 门禁：`npm run check` exit 0（194 文件/1601 用例）；`test:coverage` exit 0（93.38/85.99/92.29/93.40；measurement 目录 100/94.11/100/100）；`git push` `067ab46..f620463`。
- **SUM-02-02**（完整请求计量与包装/输出预留）：`packages/core/src/measurement/request-budget.ts` + ADR-0035 §9–14 + `docs/reports/SUM02_02_REQUEST_BUDGET.md`，提交 `446a539`。
  - 规则：有效预算=min(全局配置,模型输入空间)−输出/包装预留；记录级选入、只分页不裁剪、必要约束 blocked、优先级全序、模型切换重新计量；并验证装配不改动已发布清单字节/revision。
  - 门禁：`npm run check` exit 0（195 文件/1608 用例）；`test:coverage` exit 0（93.41/85.94/92.40/93.44；measurement 100/89.24/100/100）；`git push` `d02b4eb..446a539`。
- **SUM-02-03**（摘要事实核验与重建）：`packages/core/src/measurement/summary-fact-verification.ts` + ADR-0036 + `docs/reports/SUM02_03_FACT_VERIFICATION.md`，提交 `36017d8`。
  - 规则：五类权威字段本地提取；引用存在≠语义正确（数值冲突/无出处数值断言/关键遗漏/引用错误分别报告）；拒绝摘要再摘要与无出处输入；重建叙述带来源指针并可被同一核验器判 supported。
  - 门禁：`npm run check` exit 0（196 文件/1615 用例）；`test:coverage` exit 0（93.46/85.93/92.41/93.48；measurement 99.55/88.05/100/99.54）；`git push` `6b0f2f5..36017d8`。
- **SUM-02-04**（缓存分离/usage 捕获/质量评估）：`measurement-cache.ts`、`provider-usage-capture.ts`、`quality-evaluation.ts`、公共 exports、`scripts/verify-measurement-package.mjs`、`scripts/evaluate-summary-quality.mjs` + ADR-0037 + `docs/reports/SUM02_04_CACHE_CAPTURE_QUALITY.md`，提交 `df03aa3`、`efe9eaa`（后者为既有用例超时加固）。
  - `npm run check` exit 0（199 文件/1625 用例）；打包链全绿（tarball sha256 `c0c383ac…`、verify/smoke/summary-package/**measurement-package 10/10**/quality CLI）。
  - **已补齐**：`npm run test:coverage` exit 0（199 文件/1625 用例，全局 93.43/85.88/92.44/93.47；measurement 目录 96.63/85.71/97.18/96.87）；`git push` `a483d28..9dd7b2b`（含既有用例超时加固 `efe9eaa`、`9dd7b2b`，断言不变）。
  - 遗留（不声称完成）：真实 Provider usage 捕获需凭据/费用授权（blocked）；真实人工标注样本未提供（工具已就绪并拒绝模型自评）。
- **SUM-02 四个检查点（01~04）至此全部收口**；累计门禁波动的既有用例超时加固集中在 `efe9eaa`、`9dd7b2b`（覆盖率插桩 + 并行门禁下的真实链路等待上限，断言未放宽）。
- **GUIDE-01-02**（控制队列与安全点应用）：`packages/core/src/runtime-guidance/guidance-control-queue.ts` + `runtime/tool-loop.ts` 安全点钩子 + ADR-0038 §10–16 + `docs/reports/GUIDE01_02_CONTROL_QUEUE.md`，提交 `04d6ff2`。
  - 规则：控制队列/普通报告双通道（均不唤醒主 Agent）、`before-model-call` 注入下一次模型输入、`before-tool-execution` 应用并在门禁档阻止该次工具执行（`guidance-gate-requested-pause`）、幂等与消费点丢弃（过期/跨作用域）。
  - **架构守卫真阳性**：新目录 `core/src/guidance` 的导入路径含 `../gui` 子串被守卫命中 → 目录更名为 `core/src/runtime-guidance`（未改守卫）。
  - **门禁与并行度**：默认并行度多次命中不同既有用例超时；`--maxWorkers=6` 下 typecheck/lint/build、全量 test（201 文件/1639 用例）与 coverage（93.45/86.05/92.34/93.50）**全部 exit 0**，`git push` `56f0df6..04d6ff2`。**后续门禁建议使用 `--maxWorkers=6` 并注明**。
- **GUIDE-01-03**（长工具检查点与协作取消）：`packages/core/src/runtime-guidance/long-tool-checkpoint.ts` + ADR-0038 §17–23 + `docs/reports/GUIDE01_03_LONG_TOOL_CANCELLATION.md`，提交 `946ee90`（**本地未推送**）。
  - 规则：检查点回执、取消仅检查点交付（不假定在途插入）、回执驱动终态、未知停止结果 `unknown-stop-outcome` 按 blocked、旧执行世声明 `stale-epoch-invalidated`、旧请求收敛 + 后继承接最新 revision、watchdog 在取消未收敛时一律不续跑。
  - 门禁：typecheck/lint/build 0；`npx vitest run --maxWorkers=6` **202 文件/1646 用例全通过**；`--coverage --maxWorkers=6` exit 0（93.43/85.92/92.34/93.49）。
  - **推送失败（网络）**：`Connection reset by 20.205.243.166 port 22`（TCP 可达、SSH 握手被重置）；已重试 2 次，累积待推送 `946ee90`（+ 本记录提交）。
- **GUIDE-01-04**（公共入口、跨进程状态与 CLI）：`guidance-submission-journal.ts` + 队列状态视图 + 队列经 MainController→Orchestrator→WorkerAgent 透传到 `runToolLoop` 安全点 + `public-sdk` 的 `submitRuntimeGuidance`/`queryGuidanceStatus` + `astarray guide submit|status` + ADR-0038 §24–30 + `docs/reports/GUIDE01_04_PRODUCT_ENTRY.md`，提交 `5e5a644`（**本地未推送**）。
  - 规则：提交落盘后受理；应用/丢弃 upsert 回写跨进程日志；未回写时 `isApplicationStatusKnown=false`；单进程 CLI 只排队（受理 ≠ 已应用）；主 Agent 工具投影不变；延迟 = appliedAt − submittedAt。
  - 已验证：`typecheck`/`lint` exit 0；触及区域 7 文件 **34 passed**（线程池）。
  - **未完成**：`build` + 全量 `test --maxWorkers=6` + `coverage --maxWorkers=6` 与 `git push`（升级审批通道两次 600s 超时未执行）。
- **收口完成（2026-09-16 轮 53）**：GUIDE-01-04 全量门禁补齐并推送 `d80461c..864b300`（build 0；`test --maxWorkers=6` 204 文件/1650 用例；coverage 93.33/85.69/92.21/93.39）。
- **新用户文档已完整读取并登记**：`docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md`（未跟踪，未修改）定义 5 组检查点：
  AUTH-SCOPE-01/02/03、ACCURACY-01/02/03、READ-FORMAT-01..05、GIT-PRESERVE-01/02/03、GUIDE 增量；
  其推荐顺序为"当前检查点收口 → AUTH-SCOPE-01 → ACCURACY-01 → 完成 AUTH-SCOPE → 完成 ACCURACY → GIT-PRESERVE → READ-FORMAT"。
  该文件同时要求：正式启用前统一修订治理文档/ADR/测试预期；新节点不抢占在途公共契约；待接入清单 6 项未勾选。
- **AUTH-SCOPE-01**（范围分类与裁决者矩阵冻结）：`docs/adr/0039-auth-scope-and-adjudication-matrix.md`（S1–S7 + 三模式矩阵 + 判定规则 + 迁移清单）+ `docs/reports/AUTH_SCOPE_01_SCOPE_FREEZE.md`（现有实现审计：仅 `WorkspaceBoundary` 根内检查与安装开关；范围判定/上级批准回执/逐级升级/执行前复检/外部软件能力均缺）。设计检查点，无产品代码变更。
- **AUTH-SCOPE-02**（范围判定、裁决矩阵与批准回执）：`packages/core/src/tools/scope-resolution.ts` + ADR-0039 §9–16 + `docs/reports/AUTH_SCOPE_02_SCOPE_RESOLUTION.md`，提交 `85456a8`（**本地未推送**）。
  - 规则：已登记项目根 + realpath 判定 S1–S7（未知即 S4；**不用 cwd/前缀/自述**）；三模式矩阵（deny 优先、安装开关、S7 专用流程、放权 S4 必须上级裁决）；回执绑定范围+操作指纹+authorizationRevision+有效期；执行前复检发现链接/根变化；升级路径有界不回派。
  - 门禁：build 0；`test --maxWorkers=6` **205 文件/1659 用例全通过**；coverage exit 0（93.24/85.46/92.15/93.30；core/src/tools 95.40/90.39/97.06/95.40）；`typecheck`/`lint` 0。
  - **推送失败（网络）**：本阶段 5 次尝试全部 `Connection reset by 20.205.243.166 port 22`；累积待推送 `cd37aa7`、`9868b4e`、`85456a8`。
- **AUTH-SCOPE-03**（执行前门禁与公共入口）：`packages/core/src/tools/scope-authorization-gate.ts` + 运行时包裹 Worker 工具端口 + `public-sdk` 四个入口 + ADR-0039 §17–23 + `docs/reports/AUTH_SCOPE_03_PRODUCT_ENTRY.md`，提交 `c435442`。
  - 规则：未授权不触达内层工具（`auth-scope-denied`/`awaiting-user-authorization`/`awaiting-superior-approval`/`replay-rejected`/`authorization-expired`）；单次授权 + 重放保护；显式登记工程根取代隐式 cwd；默认上级端口只自动批准 S1。
  - 门禁：build 0；`test --maxWorkers=6` **206 文件/1669 用例全通过**；coverage exit 0（93.25/85.48/92.21/93.31；core/src/tools 95.32/90.42/96.90/95.32）。
  - 推送：网络恢复后 `864b300..40df2ed` 已推送；本提交 `c435442` 随后推送。
- **AUTH-SCOPE 三检查点（01/02/03）完成并全部推送**（`98d0f8c`）。
- **ACCURACY-01**（签收/完成链路审计与冻结）：`docs/adr/0040-accuracy-tiers-budget-and-skip-status.md` + `docs/reports/ACCURACY_01_AUDIT.md`，提交见记录。
  - 审计结论：完成事件只有 `taskExecutionId/completionAttemptId/completedTaskIdentifiers/claimedStatus/taskSequenceRevision`（**无验收条目 ID/产物回执/证据来源**）；**档位/预算/跳过状态完全缺失**；证据包只在 factVerification 与交付脚本中使用，未接入完成门禁；worker 门禁只覆盖"未解决的可变工具失败"。
  - 冻结：fast/standard/strict（standard 默认、认证用户可配、Agent 不得自行降级）、检查预算有界、`quality-check-skipped` 为独立状态（不得写成通过）、完成声明绑定 条目 ID+真实回执+版本+必需条目覆盖+证据来源。
  - 未执行三项：未来 revision 显式反例、必需条目覆盖、空证据/部分完成结案 —— 均已登记为 ACCURACY-02 必测。
- **ACCURACY-02**（幂等签收、理解确认与条目→证据覆盖）：`packages/core/src/orchestration/task-accuracy-verifier.ts` + ADR-0040 §9–16 + `docs/reports/ACCURACY_02_IDEMPOTENT_ACCEPTANCE.md`，提交 `180d688`（已推送）。
  - 规则：同一 attemptId 幂等（跨重启可识别）、收件人/旧与未来版本拒绝、证据缺指纹或严格档模型自述视为伪造、陈旧产物、空证据、必需条目覆盖（部分完成只报进度）、快速档独立 `quality-check-skipped`、严格/歧义档要求理解确认。
  - 门禁：build 0；`test --maxWorkers=6` **207 文件/1679 用例全通过**；coverage exit 0（93.29/85.60/92.24/93.35；orchestration 94.08/87.32/93.81/94.14）；`git push` 第 1 次成功。
- **ACCURACY-03**（设置、预算与产品入口）：`packages/core/src/orchestration/accuracy-policy-store.ts`（策略存储/CAS/跨进程幂等日志/审计日志/预算/组合门）+ 运行时装配 + `public-sdk` 四个入口 + `astarray accuracy status|configure` + ADR-0040 §17–25 + `docs/reports/ACCURACY_03_PRODUCT_ENTRY.md`。
  - 规则：默认标准档 + 有限预算；仅认证用户可配置，**Agent 降级或关闭被拒绝**；`expectedRevision` CAS；任务级档位覆盖只影响点名任务；**关闭 ⇒ 不调用验收端口、不发起校验层、不新增人工阻塞**，返回独立 `quality-check-skipped(accuracy-disabled)`；预算耗尽记 `quality-check-budget-exhausted`（不是通过），额度**从审计日志跨进程恢复**；幂等优先于预算（重放不耗额度）；每次校验写审计 `isVerificationLayerInvoked`；**不改变权限路由**。
  - 门禁：typecheck/lint/build 0；`npx vitest run --maxWorkers=6` **210 文件/1695 用例全通过**；coverage exit 0（93.34/85.62/92.45/93.39；orchestration 94.17/87.32/94.08/94.22；新模块 96.80/85.89/100/96.80）；`verify:security-coverage` 22/22。
  - 提交 `b4f2f26`（已推送，`8e99b76..b4f2f26`）；前两次推送因审批通道停滞超时，第 3 次成功。
  - 未完成/外部依赖：真实 Provider 成本与时延 E2E、GUI/TUI 交互式档位设置、治理文档统一修订。
- **GIT-PRESERVE-01**（恢复点服务审计与本地保全冻结）：`docs/adr/0041-local-preservation-after-remote-sync-failure.md` + `docs/reports/GIT_PRESERVE_01_AUDIT.md`。设计/审计检查点，**无生产代码变更**。
  - 冻结：远端同步成功 / 本地保全点 / 破坏性操作恢复点 / BackupVault 四者互不等同；`remoteSyncStatus`（含 `failed-network`/`failed-authentication`/`failed-rejected`/`failed-no-remote`，恒不强推）与 `localPreservationStatus`（`not-required|pending|ready|incomplete|failed`）分离；网络失败**立即**保全不等 5 次重试；版本化清单含 index tree/未暂存/未跟踪（路径+大小+sha256）/删除重命名/显式排除清单/独立对象归档+sha256/完整性结果/代次；工作树之外受保护存储并自排除；原子发布且不完整不标 `ready`；默认恢复到新目录/隔离 worktree；不自动淘汰；跨设备灾备非目标。
  - 支持矩阵：普通仓库完整支持；无提交仓库支持（受限，须空树比较不静默为空）；浅克隆/LFS/子模块/附加工作树/稀疏检出受限并以显式标志标注缺失对象。
  - 关键缺口（已登记 02/03）：无远端同步状态机；无对象归档与清单哈希；**声称原子写实际直写**；staged/index 状态不还原；未跟踪复制失败静默跳过（`git-defensive-branches.test.ts` 固化该预期，需修订）；无提交仓库 `diff HEAD` 失败被静默当空；无指纹复用/代次；就地恢复覆盖工作树。
  - 本轮 5 次升级调用（基线测试）均在 600s 内未获审批 → 基线未运行，已按"未验证"标注（无生产代码变更，静态审计取证）。
  - 提交 `d780565`（已推送，`525781e..d780565`）；推送前两次升级调用因审批通道停滞超时，第 3 次成功。
- **GIT-PRESERVE-02**（同步失败接线与本地保全快照）：`packages/core/src/orchestration/local-preservation-service.ts` + 运行时 `localPreservationService` + ADR-0041 §11 + `docs/reports/GIT_PRESERVE_02_PRESERVATION_SNAPSHOT.md`（8 用例）。
  - 规则：五类同步失败立即触发保全（成功/未尝试/进行中不触发且不留目录）；版本化清单含引用、index tree + `diff --cached`、未暂存补丁、未跟踪（路径/大小/sha256）、删除/重命名；独立 `git bundle` 归档 + sha256 + `bundle verify`；工作树之外受保护目录、临时目录原子改名发布、独立 `manifest.sha256` 读取时重算校验（篡改报 `journal-corrupted`）；默认排除依赖缓存但显式记录被排除的未跟踪文件；无提交仓库走空树比较不静默为空；LFS/子模块/浅克隆/稀疏标注 `incomplete` 不宣称完整可恢复；读取/复制/仓库不可用记录失败不伪造成功；指纹复用已验证快照，重试不重复全量复制。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **211 文件/1705 用例全通过**；coverage exit 0（93.27/85.43/92.50/93.34；orchestration 93.97/86.78/94.12/94.03；新模块 90.97/77.63/95.00/91.22）；`verify:security-coverage` 22/22。
  - 架构守卫：新模块破坏性 API 令牌加入白名单（`writeFile`/`rename`，去掉非必要 `fs.rm`）。
  - 提交 `6eba68b`（已推送，`09462be..6eba68b`，第 1 次尝试成功）。
  - 未完成（登记 03）：恢复（restore）到新目录/隔离 worktree、崩溃后独立恢复演练、产品状态入口（CLI/门面）、旧 `GitRecoveryPointService` 静默复制失败统一。
- **GIT-PRESERVE-03**（崩溃恢复与独立恢复演练、产品状态入口）：`local-preservation-service.ts` 的 `restorePreservationPoint`/`verifyPreservationPointIntegrity`/`listIncompleteSnapshotDirectories`/并发改写检测 + 4 个稳定错误码 + `public-sdk` 五个入口 + `astarray preserve create|status|show|restore` + ADR-0041 §12 + `docs/reports/GIT_PRESERVE_03_INDEPENDENT_RESTORE.md`（14 用例）。
  - 规则：恢复到**新目录**（拒绝非空目标，不覆盖人工工作区）；**原仓库删除后仍可独立恢复**（bundle clone/init + index/未暂存/未跟踪），恢复后 index tree 与记录一致；强制 `autocrlf=false` 保证字节级；缺对象/哈希不一致如实报告并使恢复失败；`.tmp-*` 残留报告为不完整且永不 ready；并发改写检测降级为 `incomplete`；恢复不创建新快照、只回写 `restoredAtIso`。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **214 文件/1719 用例全通过**；coverage exit 0（93.17/85.26/92.60/93.22；orchestration 93.91/86.68/94.31/93.95；新模块 91.02/78.28/98.07/90.95）；`verify:security-coverage` 22/22。
  - 提交 `01c4fa0`（已推送，`ea15f9f..01c4fa0`，第 1 次尝试成功）。
  - 未验证：真实 ENOSPC/权限耗尽故障注入、真实远端网络故障注入（需外部环境）；旧 `GitRecoveryPointService` 静默复制失败未统一。
- **GIT-PRESERVE 三检查点（01/02/03）全部完成**。
- **READ-FORMAT-01**（解析依赖核对、策略接口、能力矩阵与公共回执冻结）：`docs/adr/0042-read-format-strategy-and-receipt.md` + `docs/reports/READ_FORMAT_01_STRATEGY_FREEZE.md`。设计/审计检查点，**无生产代码变更**。
  - 冻结：`readFile` 新增可选 `shouldIncludeComments`/`shouldIncludeImports`（默认 true）与**四种参数组合**；轻量策略注册表（显式覆盖 > 文件名 > 后缀 > 内容采样 > unsupported）与每族能力矩阵；**结构化读取回执**（源 revision/hash、policyVersion/strategyId、filterStatus、省略行区间、lineMap、isViewComplete/isFilterable、limitations、sensitiveCheckAppliedBeforeView、measuredUnits、budgetImpact=same-file）；`unsupported`/`parse-error`/`partially-filtered` 都返回**原文**并显式标注，不报错、不虚报；视图不修改源文件/不执行代码/不解析导入；敏感检查必须对**完整原文**先执行；反自指参数哈希扩展为 (路径, 范围, 两参数, policyVersion)；工作集预算沿用规范身份（不同视图同一文件一个槽，切换参数不重置总调用预算）。
  - 依赖核对：**无任何语言解析依赖**（仅 commander/ink/react/zod）；如新增必须走当时有效的两阶段安装门禁（ADR-0019）并离线可用，禁止运行时自动安装/隐式下载。
  - 回归基线（02 起必须复用、不得放宽）：`builtins.test.ts`、`read-suppression-and-guard.test.ts`、`sensitive-content-access.test.ts`、`local-tool-policy.test.ts`。本轮为审计/冻结，**未运行测试**（静态阅读取证，标"未运行"）。
  - 提交 `948edef`（已推送，`333eb16..948edef`，第 1 次尝试成功）。
- **READ-FORMAT-02**（C 系、Python、Rust 读取策略）：`packages/core/src/tools/read-format/{read-format-scanner,read-format-strategies}.ts` + `tests/fixtures/read-format/**`（8 真实夹具）+ `tests/core/unit/read-format-strategies.test.ts`（12 用例）+ ADR-0042 §12 + `docs/reports/READ_FORMAT_02_C_FAMILY_PYTHON_RUST.md`。
  - 规则：语言感知状态机（字符串/注释/嵌套块注释/原始与逐字字符串）；C 宏与预处理指令**整行保留**；C++ `R"(…)"`、C# `@"…"`/`"""…"""`、Python 文档字符串、Rust `r#"…"#` 与生命周期不被误删；Python 多行 `from … import (…)` 整段省略；同行 `import os; x = 1` 保留并记 `import-with-inline-code`（partially-filtered）；未闭合字符串/注释 → `parse-error` 原样返回；未支持后缀 → `unsupported` 原样返回；省略 span 补回换行保证行号恒等。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **215 文件/1731 用例全通过**；coverage exit 0（93.05/85.08/92.71/93.09；tools/read-format 89.68/81.67/97.78/89.60；orchestration 93.91/86.64/94.31/93.95）；`verify:security-coverage` 22/22。
  - 边界：**未接线 `readFile`**（参数/receipt/敏感检查接线/时间锁键属 READ-FORMAT-05）；`readFile` 现行为不变。
  - 提交 `3eaf596`（已推送，`b814d15..3eaf596`，第 1 次尝试成功）。
- **READ-FORMAT-03a**（前端脚本 JS/TS/JSX/TSX 读取策略）：`packages/core/src/tools/read-format/read-format-frontend-script.ts` + 策略注册（`frontend-script`）+ `tests/fixtures/read-format/frontend/**`（4 夹具）+ `tests/core/unit/read-format-frontend.test.ts`（11 用例）+ ADR-0042 §13 + `docs/reports/READ_FORMAT_03A_FRONTEND_SCRIPT.md`。
  - 规则：字符串/模板 `${}`/正则/JSX 文本与属性里的注释标记不误删；JSX 表达式容器内注释按需省略；静态 import/export-from/require 可省略；**动态 `import()` 保留并标注**；未闭合模板/块注释 → `parse-error` 原样返回；仅保留而无省略时状态诚实为 `not-filtered` + limitation。
  - 支撑修复：Windows 目录 rename 瞬时 EPERM/EBUSY/EACCES 有界重试（仍失败即抛错），修复 coverage 门禁波动（独立提交）。
  - tsconfig：`exclude` 增加 `tests/fixtures`（夹具是数据，`incomplete.tsx` 故意未闭合）。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **216 文件/1742 用例全通过**；coverage exit 0（93.04/85.14/92.74/93.08；tools/read-format 91.08/84.43/97.01/91.01；frontend-script 92.60/88.07/94.73/92.53）；`verify:security-coverage` 22/22。
  - 提交 3b5a9dd（rename 重试修复）、2787be4（实现）（已推送，46b0054..2787be4，第 1 次尝试成功）。
- **READ-FORMAT-03b**（CSS/SCSS/Less、HTML 与 Vue/Svelte 区段分派）：`read-format-frontend-styles.ts` + `read-format-frontend-markup.ts` + 策略注册（`style-sheet`/`html`/`vue`/`svelte`）+ `tests/fixtures/read-format/frontend/**`（新增 5 夹具）+ `tests/core/unit/read-format-frontend-mixed.test.ts`（9 用例）+ ADR-0042 §14 + `docs/reports/READ_FORMAT_03B_STYLES_MARKUP.md`。
  - 规则：CSS 块注释/SCSS 行注释按需省略、`url(...)` 与字符串里的注释标记不误删；`@import`/`@use`/`@forward` 可省略；HTML `<!-- -->` 与 `<script src>`/`<link href>` 可省略；`<template>/<script>/<style>` 顶层区段分别按 markup/脚本/样式策略处理并做行号偏移；带 `src` 的 script/style 视为资源标签而非区段；任一子视图 parse-error → 整视图 parse-error 返回原文。
  - 门禁（补跑完成）：typecheck/lint 0；build 0；`test --maxWorkers=6` **217 文件/1755 用例全通过**；coverage exit 0（92.92/85.07/92.77/92.95；read-format 90.63/84.26/97.80/90.56；frontend-styles 85.00/84.12/100/85.00；frontend-markup 89.79/79.06/100/89.72）；`verify:security-coverage` 22/22。
  - 过程：升级审批通道曾连续 5 次停滞导致门禁未跑；通道恢复后全部补跑通过（详见证据文档）。
  - 提交 `d57ec34`（实现，已推送 `2e2ca12..d57ec34`）；门禁补跑与记录见后续 docs 提交。
- **READ-FORMAT-04a**（LaTeX 与配置/文档）：`read-format-latex.ts` + `read-format-config-documents.ts` + 扫描器 `shouldTreatAsLineComment` 钩子 + 策略注册（`latex`/`jsonc`/`json`/`yaml`/`toml`/`markdown`/`plain-text`）+ 6 夹具 + `tests/core/unit/read-format-config-documents.test.ts`（10 用例）+ ADR-0042 §15 + `docs/reports/READ_FORMAT_04A_LATEX_CONFIG.md`。
  - 规则：LaTeX 转义 `\%` 不算注释、逐字环境（verbatim/lstlisting/minted）整体保留、未闭合逐字环境 parse-error；YAML `#` 仅行首/空白后成立（URL 片段不误删）；JSONC 行/块注释；TOML `#`；Markdown 仅过滤 `<!-- -->` 且围栏代码块整体保留；JSON/纯文本标注 `comments-unsupported`，无导入概念格式标注 `imports-unsupported`（不适用，不是失败）。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **218 文件/1765 用例全通过**；coverage exit 0（92.98/85.09/92.92/93.01；read-format 91.73/84.67/98.55/91.65；latex 92.90/78.02/100/92.75；config-documents 98.19/92.50/100/98.16）；`verify:security-coverage` 22/22。
  - 提交 `7114f39`（已推送，`1aad551..7114f39`，第 1 次尝试成功）。
- **READ-FORMAT-04b**（Go、Shell、SQL）：`read-format-other-languages.ts` + 策略注册（`go`/`shell`/`sql`）+ 3 夹具 + `tests/core/unit/read-format-other-languages.test.ts`（11 用例）+ ADR-0042 §16 + `docs/reports/READ_FORMAT_04B_OTHER_LANGUAGES.md`。
  - 规则：Go 原始/符文/转义字符串不误删，import 单条与块可省略；Shell `#` 需行首/空白后、heredoc 整体保留、`source`/`.` 仅纯路径可省略（动态加载保留并记 `dynamic-import`）；SQL `--`/块注释与 `''`/`""` 转义、方言局限显式标注 `dialect-comment-variants`。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **219 文件/1776 用例全通过**；coverage exit 0（93.01/85.11/93.01/93.04；read-format 92.23/84.75/98.80/92.15；other-languages 93.67/84.06/100/93.58）；`verify:security-coverage` 22/22。
  - 过程：首轮覆盖率 branch 84.95% < 85% 阈值失败；补边界用例后回到 85.11%，未放宽阈值。
  - 提交 `38a78a2`（已推送，`a0b612c..38a78a2`，第 1 次尝试成功）。
- **READ-FORMAT-04 全卡（LaTeX、配置/文档、其他语言）收口**。
- **READ-FORMAT-05a**（readFile 视图产品入口与视图感知时间锁）：`builtins.ts`（视图参数、公共回执、完整原文敏感检查优先）+ `read-suppression-ledger.ts`（`buildReadViewParameterHash`、账本键纳入参数哈希、默认哈希路径无关）+ `tests/core/integration/read-file-view.test.ts`（7 用例）+ ADR-0042 §17 + `docs/reports/READ_FORMAT_05A_READ_FILE_ENTRY.md`。
  - 规则：默认参数逐字节原文（兼容既有行为）；过滤/不支持/解析失败前置公共回执（status/strategy/省略范围/局限，不静默声称成功）；敏感检查始终先于视图；视图参数哈希不含路径（资源身份由账本规范身份负责，别名/大小写不能绕过）；内容指纹基于完整原文；不同视图不同键可补读，同视图窗口内仍抑制；跨 Agent 隔离。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **220 文件/1783 用例全通过**；coverage exit 0（93.01/85.12/92.97/93.04；builtins 87.67/80.37/100/87.58；read-suppression-ledger 95.45/100/92.30/95.34）；`verify:security-coverage` 22/22。
  - 提交 `b0b3d38`（已推送，`a84c075..b0b3d38`，第 1 次尝试成功）。
- **READ-FORMAT-05b**（安装包离线可用与资源测量）：`scripts/verify-read-format-package.mjs` + `public-sdk` 读取策略导出 + `tests/core/unit/read-format-resource-metrics.test.ts` + `package.json` `verify:read-format-package` + ADR-0042 §18 + `docs/reports/READ_FORMAT_05B_PACKAGE_AND_METRICS.md`。
  - 验证：`npm pack` → **`npm install --offline`** 隔离安装（41 包，无网络）→ 从安装包公共 SDK 校验过滤/回执/unsupported/parse-error，并测量（源级 26 夹具×4 组合×20 轮：2080 视图 354ms、0.17ms/视图、峰值堆 +22.6MB；安装包 5 夹具×200 轮：1000 视图 15ms、+6.3MB）；`scripts/verify-package.mjs` 213 文件通过。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **221 文件/1784 用例全通过**；coverage exit 0（93.01/85.14/92.97/93.04；read-format 92.29/85.03/98.80/92.21）；`verify:security-coverage` 22/22。
  - 提交 `9cf7689`（已推送，`41704b4..9cf7689`，第 1 次尝试成功）。
- **READ-FORMAT-01..05 全卡完成**（01 冻结、02 C/Python/Rust、03a/03b 前端与混合、04a/04b LaTeX/配置/其他语言、05a/05b 产品入口与打包测量）。
- **GUIDE 增量 02a**（追加/修订/新建任务变更意图）：`guidance-change-intent.ts` + `guidance-change-intent-journal.ts` + 运行时/公共入口/CLI + ADR-0038 §31–38 + `docs/reports/GUIDE_02A_CHANGE_INTENT.md`（12+5+3 用例）。
  - 规则：必须显式选择 append/revise/new-task（未明确 → 澄清，不静默替换旧目标）；append/revise revision 单调 +1 且历史全部保留；revise 必须指明受影响产物/验收条目，仅这些失效；旧完成声明（revision 落后）失效；new-task 不提升 Agent 派生优先级（用户层级 0、Agent ≥1 且 ≤上限）；并发 revision 不一致拒绝；同标识同 revision 幂等去重；状态落盘 `guidance/change-intent.json` 跨进程可读；接受后复用 GUIDE-01 控制队列（受理 ≠ 已应用）。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **224 文件/1804 用例全通过**；coverage exit 0（93.00/85.08/93.05/93.03；guidance-change 98.88/85.88/100/98.85）；`verify:security-coverage` 22/22。
  - 提交 `2324916`（已推送，`7c118b1..2324916`，第 1 次尝试成功）。
  - 未接入（诚实声明）：**新任务插入任务偏序集**属 GUIDE 增量 02b。
- **GUIDE 增量 02b**（新任务插入任务偏序集）：`public-sdk.ts` 的 `insertionTarget`/`insertedSequenceRevision` + `tests/core/integration/guidance-change-poset-insertion.test.ts`（4 用例）+ ADR-0038 §39–43 + `docs/reports/GUIDE_02B_POSET_INSERTION.md`。
  - 规则：new-task 必须携带插入目标（次级 agentInstanceId + 序列 + 观察 revision + 锚点），缺失 → 澄清；插入复用 `TaskSequenceManageController.insertTask`（偏序/优先级/审计），用户来源层级 0；**插入先于登记**，插入失败（并发 revision/重复标识/未知锚点）→ `task-insertion-failed` 且不登记变更意图、不改历史；序列 revision 单调前进。
  - 门禁：typecheck/lint/build 0；`test --maxWorkers=6` **225 文件/1808 用例全通过**；coverage exit 0（93.02/85.09/93.05/93.04；public-sdk 90.00/80.06/90.32/90.21）；`verify:security-coverage` 22/22。
  - 提交 `744a08f`（已推送，`ec4c3be..744a08f`，第 1 次尝试成功）。
  - 未验证（诚实声明）：真实长任务中途追加/撤销的运行端到端演练（需真实 Provider/长任务）。
- **GUIDE 增量（用户文档 §6）至此收口**（02a 变更意图与产品入口 + 02b 偏序集插入）。
- **GOV-01**（治理规则迁移范围冻结与冲突清单）：`docs/adr/0043-governance-rule-migration-and-unification.md` + `docs/reports/GOV_01_MIGRATION_AUDIT.md`。设计/审计检查点，无生产代码变更。
  - 冻结：安装/外部软件**范围优先**（S1–S7 → ADR-0039 矩阵），保留独立安装开关（默认关闭、关闭即拒绝）、已有资源询问/选择回执、精确参数绑定、一次性 nonce、revision 与执行前复检；`deny` 优先；S4 不得把用户离线当同意；旧表述必须改写为引用或标注「已被 ADR-0039/0043 替代」，不得保留同时生效的矛盾描述，历史记录保留。
  - 冲突清单：AGENTS.md 第 29 行、ADR-0019/0020、architecture.md、历史任务卡/验收记录、以及 `assist-installation-gate.test.ts`（24 处）与 `installation-gate-execution.test.ts`（15 处）旧语义断言；用户并行脏文件（IMPLEMENTATION_PLAN.md/PLAN_STATUS.md/agent-main-architecture.md/docs/tasks/README.md/application-sdk-task-events.test.ts）明确列入不可触碰范围。
  - 后续：**GOV-02a** 文档改写（并行文件落定后）→ **GOV-02b** 测试期望修订 + 安装门禁按范围分流（先行为反例，不得放宽）。
  - 提交 `d530c86`（已推送，`055d2ac..d530c86`，第 1 次尝试成功）。
- 下一轮候选：**GOV-02a**（治理文件/ADR 改写）或 **WB-00-02**（前驱 GUI-01-R-04b 未满足，暂不可领）；外部依赖项与真实服务验证仍待补齐。
- **GUIDE-01-01**（运行中指导事件契约）：`packages/core/src/runtime-guidance/runtime-guidance.ts` + ADR-0038 + `docs/reports/GUIDE01_01_GUIDANCE_CONTRACT.md`，提交 `6414329`（含 `ca188eb` 测试超时加固）。
  - 规则：来源注册表（伪造/超额档位拒绝）、sequence/revision 单调、重放去重、作用域精确匹配与显式依赖传播、有效期、取消能力契约（`canCancelInFlight=false`、不支持在途插入）；**紧急等级不得篡改 priorityTier**（层级 0 写入即 `priority-tier-tampering`）。
  - 门禁：`npm run check` exit 0（200 文件/1633 用例）；`test:coverage` exit 0（93.45/86.00/92.42/93.48）；`git push` `553cff6..6414329`。
  - 环境注意：全量套件多轮出现**不同**既有用例超时波动（隔离运行全部通过）；本轮与上一轮共为 5 个既有用例提高等待上限（`efe9eaa`、`9dd7b2b`、`6414329`、`ca188eb` 等），**未跳过测试、未放宽断言**。下一轮若再遇同名波动，优先隔离复跑取证而不是继续放宽。
- 仍待用户/外部输入：GUI-01-R-04b 人工体验与 Linux/macOS；BRIDGE-01-04 真实 MCP 客户端；E2E-01-03 真实 Provider 凭据/费用授权；E2E-01-04 人工结论。