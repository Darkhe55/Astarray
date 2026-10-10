# E2E-01：独立工作助手纵向验收

> 状态：pending
> 创建日期：2026-09-10
> 类型：发布验收；高风险工作按检查点执行
> 来源：用户授权布置；本文件为Agent派生实施方案，运行态节点默认层级1或以下，不冒充用户层级0
> 前驱：T07D-R1、T07D-R2、T09A-R1、T12A-R1

## 执行契约

必须先读取 [本批实施顺序与共同验收规则](./PRODUCT_INTEGRATION_ROLLOUT.md) 及 AGENTS.md 指定的四份治理文档。该共同文件是本卡的一部分，包含批次、测试、证据、安装、Git及停止条件。原任务卡的未满足验收要求继续有效。

## 目标与范围

以真实安装包证明用户输入到实际产物的完整工作链可用；作为下一阶段独立工作助手的对外声明门槛。

## 检查点

### E2E-01-01：验收fixture与证据协议

- 状态：done（2026-09-10；证据 docs/reports/E2E01_01_FIXTURE_EVIDENCE.md；fixture fingerprint sha256:6512b2a6322fb6b6730b68fb4029b622b8fc7f06e1f3adee0342b7d044e94c7c）。
- 工作：冻结一个小型项目、目标功能、失败测试、权限设置、预算和预期产物；预置依赖，先收集资源情况；将自动和人工检查分开。
- 验收：fixture可重复运行，明确成功/失败标准；证据绑定tarball哈希、commit、配置、Provider/模型和运行ID。
- 前驱：本卡前驱。先通过前驱，再执行本节点。

### E2E-01-02：确定性纵向闭环

- 状态：done（2026-09-10；切片 7 补齐纵向编排产品化：`workflow run` 公共入口驱动 StandaloneWorkflowRunner，证据 docs/reports/E2E01_02_WORKFLOW_ENTRY_EVIDENCE.md，其中 §3 汇总五条验收条款证据）。
- 历史切片：切片 1：本地协议服务器 + Provider 运行时公共入口，docs/reports/E2E01_02_PROVIDER_ENTRY_SLICE_EVIDENCE.md；切片 2：能力探针与缺口分析，docs/reports/E2E01_02_GAP_ANALYSIS.md；切片 3：完成门禁对账（缺口 2 修复），docs/reports/E2E01_02_COMPLETION_GATE_EVIDENCE.md；切片 3b：受控新建文件通道 createProjectFile（缺口 1），docs/reports/E2E01_02_CREATE_FILE_CHANNEL_EVIDENCE.md；切片 4a：纵向 实现→测试→强制失败→返修→独立验收 + 三角色身份分离，docs/reports/E2E01_02_VERTICAL_REWORK_EVIDENCE.md；切片 4b：验收 4 合并门禁（越界拒绝/未授权不合入/授权后合入）与验收 5 主报告按需读取不抢占对话，docs/reports/E2E01_02_INTEGRATION_REPORT_EVIDENCE.md；切片 5：tarball 隔离安装下的纵向复现 + smoke-install/verify-package/隔离安装交付检查，docs/reports/E2E01_02_TARBALL_VERTICAL_EVIDENCE.md（验收 1–5 均已有证据）；切片 6：产品级侦察（PROJECT_CONTEXT_DIGEST_V1，含只读子集与来源认证）与规划（任务插入提案：用户层级 0 / Agent 不得占层级 0），docs/reports/E2E01_02_RECON_PLAN_EVIDENCE.md；切片 6b：侦察来源认证按 mission 校验（去掉写死的 mission-cli/bundle-cli），docs/reports/E2E01_02_RECON_SCOPE_EVIDENCE.md；剩余：纵向编排产品化）。
- 工作：安装tarball，使用本地协议服务器从用户入口完成侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取。
- 验收：实际产物和测试证据；实现/测试/验收身份不同；强制一次测试失败验证返修；拒绝未授权合并；主对话不被后台报告抢占。
- 前驱：E2E-01-01。先通过前驱，再执行本节点。

### E2E-01-03：真实服务与并行中断

- 状态：done（2026-10-09；四条验收均有**真实 Provider + tarball 隔离安装**证据：条款 1/2/4 见 `.tmp/e2e01-03/2026-10-09T13-08-12.367Z/acceptance-verdict.json` 与 `.tmp/e2e01-03-interrupt/<最新>/boundary-interrupt-verdict.json`（提交 `0b712b1`，均 `isRealAcceptanceEvidence=true`）；条款 3 的「上下文预算/回访实际执行」见 `.tmp/e2e01-03-recall/2026-10-09T13-59-08.716Z/context-recall-verdict.json`（提交 `0918a77`，8/8 判据、`sourceStatus=''`）。用户裁决：条款 3 的"回访"＝必修（已由**节点关闭→关闭胶囊（＝记忆）→回访真正执行并落账本**取证，脚本 `scripts/verify-e2e01-03-context-recall.mjs`）；"人工工作树"口径＝接受"同一工作树内用户亲手并发修改"，独立人工工作树接线不构成本节点门禁。汇总证据：docs/reports/E2E01_03_REAL_SERVICE_AND_PARALLEL_INTERRUPT_EVIDENCE.md）。
- 工作：在获授权真实Provider上执行同场景，用户在人工工作树制造一次并发变化；再在工具调用边界中断恢复。（用户裁决：本次"同一工作树内亲手并发修改"已满足并发语义，独立人工工作树接线不构成本节点门禁。）
- 验收：陈旧写入被拒绝且人工修改保留；恢复无重复副作用；上下文预算/回访实际执行；CLI/SDK最终状态一致。
- 前驱：E2E-01-02。先通过前驱，再执行本节点。

### E2E-01-04：质量与交付声明

- 状态：in_progress（**2026-10-10 刷新（最后一个 `it.skip` 已消除）**：全量 **308 文件 / 2353 用例通过、exit 0**，**skipped 0**（原 1 个即 `cli-anthropic-protocol` ①，本轮定位并修复后由 `it.skip` 改回 `it`）；`npm run test:coverage`（仓库配置、默认并发、阈值 85）**exit 0**，行/分支/函数/语句 = **92.66 / 85.05 / 92.62 / 92.7**（分支 **85.05% ≥ 阈值 85**，与上一轮持平无回归）；`npm run check`（typecheck+lint+build+test）**exit 0**。**仍未 done 的两条硬理由（保持不变）**：① 卡内"未决必选项不得done"——**人工体验结论**与 **Linux/macOS 平台**证据仍缺（只能由用户/平台提供）；② 超时型抖动（`tests/tui/unit/run-command-gaps.test.ts` 历史曾在默认并发下 60s 超时）本轮 13 次运行（隔离 8 + 全量 `--maxWorkers=12` 3 + check/coverage 各 1）**未复现**，故**不宣称已修复**；已把可证接缝（无 `timeoutSeconds` ⇒ `waitForTaskTerminal` 无 deadline 轮询）固化为确定性反例。**本节点已无本地可修的已知阻塞**——历史三项（`e2e01-vertical-rework`/`run-command-gaps` 抖动、`npm run test:coverage` exit 1、`smoke-install` prepack 失败）与最后 1 个 `it.skip` 均已消除；历史口径见 docs/reports/E2E01_04_LOCAL_REFRESH_2026-10-09.md、docs/reports/E2E01_04_LOCAL_REFRESH_2026-09-19.md 与 docs/reports/E2E01_04_QUALITY_STATEMENT.md）。
- 工作：运行check、coverage、安全关键模块专项及tarball回归；绑定平台结果和人工体验结论，纠正支持矩阵。
- 验收：总体分支≥85%，适用安全关键模块≥95%；未跑平台明确未验证；mock/fake/真实及正式/待人工追认状态区分；未决必选项不得done。
- 前驱：E2E-01-03。先通过前驱，再执行本节点。

## 注意事项

全局覆盖率不能替代关键模块专项；人工体验/凭据阻塞只阻塞依赖项。开发工具链audit遗留须附影响、处置与复查范围，不能仅靠全绿测试抹去。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

- 当前提交/工作树基线：`4749e5d`（T12A-R1 收口）。用户并行改动（IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、docs/tasks/README.md 及 4 张未跟踪卡）保持未暂存。
- 本检查点实现与入口证据：E2E-01-01 见 docs/reports/E2E01_01_FIXTURE_EVIDENCE.md；E2E-01-02 切片 1 见 docs/reports/E2E01_02_PROVIDER_ENTRY_SLICE_EVIDENCE.md（本地协议服务器 + Provider 运行时公共入口）；切片 2 见 docs/reports/E2E01_02_GAP_ANALYSIS.md（缺口 1 工作区写入权限、缺口 2 完成门禁未对账真实产物、缺口 3 纵向编排缺失）；切片 3 见 docs/reports/E2E01_02_COMPLETION_GATE_EVIDENCE.md（缺口 2 已修复：未解决的写操作失败不得以文本声明结案）；切片 3b 见 docs/reports/E2E01_02_CREATE_FILE_CHANNEL_EVIDENCE.md（缺口 1 已提供受控通道：createProjectFile，assist 默认 ask→fail-closed，devolve 默认 allow→真实落盘）；切片 4a 见 docs/reports/E2E01_02_VERTICAL_REWORK_EVIDENCE.md（实现→测试→强制失败→返修→独立验收，三角色身份互不相同，产物 sha256 与 E2E-01-01 一致）；切片 4b 见 docs/reports/E2E01_02_INTEGRATION_REPORT_EVIDENCE.md（验收 4 合并门禁：越界拒绝 + 未授权不合入 + 授权后合入；验收 5 报告只入索引、不抢占对话、按需只读）。
- 测试命令、退出码和产物哈希：`npm run check` exit 0（172 文件/1488 用例）；`npm run test:coverage` exit 0（全局 branch 86.58%）；`npm run verify:e2e01` exit 0；fixture fingerprint `sha256:6512b2a6322fb6b6730b68fb4029b622b8fc7f06e1f3adee0342b7d044e94c7c`（11 文件）；产物 `out/summary.json` sha256 `fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d`、`out/test-evidence.json` sha256 `ddbf68abff3dc115b418bf4edf306aa6b04bf7a2d055116d5258d77ba4f95db3`；tarball `astarray-0.1.0.tgz` sha256 `be07c8abf43173fa61e856d6a91bf9b9c9010877787716b0275869150bd90f6f`（621004 字节）；runIdentifier `e2e01-01-20260912T035944Z`。
- E2E-01-04 本地可证项刷新（2026-09-19）：在 LINUX-PORT-01 之后于 `6461690` 重跑——`tsc`/`eslint` 0、构建成功、全量 228 文件/1854 用例、覆盖率 93.09/85.24/93.13/93.11、安全关键模块 22/22、`npm pack`+verify-package（215 文件）+smoke-install exit 0（tarball sha256 `a45ae4da…d1f`）；`scripts/e2e01-acceptance.mjs fixture` 复现冻结 fingerprint `6512b2a6…`，基线与参考实现行为、两个产物 sha256 与 2026-09-10 记录逐字节一致。同轮修复脚本静默误报：受限沙箱下 spawn EPERM 原被吞掉只留两个 false，现输出 `[spawn EPERM]` 与 `failureDiagnostics`。证据 docs/reports/E2E01_04_LOCAL_REFRESH_2026-09-19.md。
- 人工/外部依赖及剩余风险：人工走查与真实 Provider 观察均为 `pending-manual`（证据包强制）；E2E-01-03 需用户真实 Provider 凭据与费用授权，当前缺失须保持 blocked/pending；E2E-01-04 本地可证项已通过（见 docs/reports/E2E01_04_QUALITY_STATEMENT.md），未决必选项为人工体验结论、Linux/macOS 平台与真实 Provider 场景。E2E-01-02 的验收 1–5 及侦察/规划/编排产品化均有直接证据（汇总见 docs/reports/E2E01_02_WORKFLOW_ENTRY_EVIDENCE.md §3）；StandaloneWorkflowRunner 场景 B 以记录门禁决策方式编排，真实 git 合并门禁由切片 4b 真实仓库证据覆盖。
- E2E-01-04 最后 1 个 `it.skip` 收口（2026-10-10）：`tests/tui/integration/cli-anthropic-protocol.test.ts` ① 由 `it.skip` 改回 `it` 并转绿（31.2s 恒 `blocked` → **0.85s `status=done`**，产物落盘且内容一致；`skipped` 1 → **0**）。**交接文档 §3① 的假设被实测证伪**：STDIN-TRACE 显示 `data len=11 value="allow-once\n"` 正常到达，**不是**"谁先消费了 stdin"，`createStdinLineReader()` 无需改动。真实根因两层：① **范围门禁先授权并消费范围记录、内层权限引擎随后才判 `ask`**（工具从未执行），而结算只恢复"逻辑操作授权快照"（范围裁决路径下本就为空）⇒ 范围记录永久停在已消费，重跑恒得 `auth-scope-replay-rejected`（实测请求序列 permission-ask-pending → replay-rejected ×6 + 任务 blocked）；修复＝把本次消费的范围记录指纹挂到预留上，并在"确定无副作用"的释放路径恢复它（成功后仍停在已消费，重放保护不放宽）；② `createProjectFile` 在父目录不存在时以 `wx` 直接打开目标文件 ⇒ `ENOENT`；修复＝补建父目录后仍以 `wx` 排他创建（"仅新建、不覆盖"语义不变）。回归反例：`tests/core/integration/permission-refusal-side-effect.test.ts` ③④（先红后绿）、`tests/core/unit/builtins.test.ts` 两条（先红后绿）、`tests/tui/integration/cli-anthropic-protocol.test.ts` ① 由 skip 转绿。本节点**已无本地可修的已知阻塞**；仍缺的只有人工体验结论与 Linux/macOS 平台证据（只能由用户/平台提供，如实保留 in_progress）。
- E2E-01-04 超时型抖动专项（2026-10-10）：`tests/tui/unit/run-command-gaps.test.ts` 曾在默认并发下 `Test timed out in 60000ms`。**本轮复现尝试：隔离 8 次 + 全量 `--maxWorkers=12` 3 次 + `check`/`coverage` 各 1 次，13 次运行全部通过，未复现**，故**不宣称已修复**（无失败样本可证因）。**可证接缝（确定性）**：该文件走真实 mission 的两个用例不传 `timeoutSeconds` ⇒ `executeRunCommand` → `waitForTaskTerminal(timeoutMilliseconds = null)` 以 50ms 轮询**且无 deadline** 等待终态（T07D-R2-03 既定契约"缺省不设固定上限"）；mission 长期停在非终态时（`mapMissionStatus` 在 `summary.status` 缺失时回退 `running`）等待会静默持续到框架超时，失败信息不含"卡在哪一步"。**处置**：新增确定性反例钉住该等待形状——预算给足但永不终态 ⇒ **有界**返回 `running`（不伪装 done）；零预算 ⇒ 立即返回且不空转；进入等待前有待裁决询问 ⇒ 立即返回 `blocked`。**不**无依据放大超时来掩盖竞态。
- 本地提交、推送尝试与结果：E2E-01-01 `23f38eb`、补记 `9eca588`；E2E-01-02 切片 1 `d5430d9`、补记 `48ea32d`；切片 2 `a900fc5`、补记 `09a4c8f`；切片 3 `3b3d2d9`、补记 `3c90b17`；切片 3b `b29d5cf`、补记 `3508113`；切片 4a `079d6df`、补记 `9d7bb03`；切片 4b `78f7927`、补记 `a6c6b46`；切片 5 `6b48330`、补记 `33ead10`；切片 6 `b04053d`、补记 `60871f0`；切片 6b `636c702`、补记 `2724729`；切片 7 `176dfd6`、补记 `61fbfe0`；E2E-01-04 本地可证项 `68a8a40`（均第 1 次推送成功；仅个别轮次曾因审批通道停滞重复尝试）。

## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮只执行 E2E-01-01；先记录基线和失败场景，再完成该检查点。不要领取后继，未满足条件不得标记done。

