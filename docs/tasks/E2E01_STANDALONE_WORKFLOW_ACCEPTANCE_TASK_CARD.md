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

- 状态：in_progress（切片 1：本地协议服务器 + Provider 运行时公共入口，docs/reports/E2E01_02_PROVIDER_ENTRY_SLICE_EVIDENCE.md；切片 2：能力探针与缺口分析，docs/reports/E2E01_02_GAP_ANALYSIS.md；切片 3：完成门禁与真实工具结果对账（缺口 2 修复），docs/reports/E2E01_02_COMPLETION_GATE_EVIDENCE.md；剩余：切片 3b 工作区写入通道、切片 4 纵向编排、切片 5 tarball 复现）。
- 工作：安装tarball，使用本地协议服务器从用户入口完成侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取。
- 验收：实际产物和测试证据；实现/测试/验收身份不同；强制一次测试失败验证返修；拒绝未授权合并；主对话不被后台报告抢占。
- 前驱：E2E-01-01。先通过前驱，再执行本节点。

### E2E-01-03：真实服务与并行中断

- 状态：pending。
- 工作：在获授权真实Provider上执行同场景，用户在人工工作树制造一次并发变化；再在工具调用边界中断恢复。
- 验收：陈旧写入被拒绝且人工修改保留；恢复无重复副作用；上下文预算/回访实际执行；CLI/SDK最终状态一致。
- 前驱：E2E-01-02。先通过前驱，再执行本节点。

### E2E-01-04：质量与交付声明

- 状态：pending。
- 工作：运行check、coverage、安全关键模块专项及tarball回归；绑定平台结果和人工体验结论，纠正支持矩阵。
- 验收：总体分支≥85%，适用安全关键模块≥95%；未跑平台明确未验证；mock/fake/真实及正式/待人工追认状态区分；未决必选项不得done。
- 前驱：E2E-01-03。先通过前驱，再执行本节点。

## 注意事项

全局覆盖率不能替代关键模块专项；人工体验/凭据阻塞只阻塞依赖项。开发工具链audit遗留须附影响、处置与复查范围，不能仅靠全绿测试抹去。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

- 当前提交/工作树基线：`4749e5d`（T12A-R1 收口）。用户并行改动（IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、docs/tasks/README.md 及 4 张未跟踪卡）保持未暂存。
- 本检查点实现与入口证据：E2E-01-01 见 docs/reports/E2E01_01_FIXTURE_EVIDENCE.md；E2E-01-02 切片 1 见 docs/reports/E2E01_02_PROVIDER_ENTRY_SLICE_EVIDENCE.md（本地协议服务器 + Provider 运行时公共入口）；切片 2 见 docs/reports/E2E01_02_GAP_ANALYSIS.md（缺口 1 工作区写入权限、缺口 2 完成门禁未对账真实产物、缺口 3 纵向编排缺失，含切片 3/4/5 计划）。
- 测试命令、退出码和产物哈希：`npm run check` exit 0（172 文件/1488 用例）；`npm run test:coverage` exit 0（全局 branch 86.58%）；`npm run verify:e2e01` exit 0；fixture fingerprint `sha256:6512b2a6322fb6b6730b68fb4029b622b8fc7f06e1f3adee0342b7d044e94c7c`（11 文件）；产物 `out/summary.json` sha256 `fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d`、`out/test-evidence.json` sha256 `ddbf68abff3dc115b418bf4edf306aa6b04bf7a2d055116d5258d77ba4f95db3`；tarball `astarray-0.1.0.tgz` sha256 `be07c8abf43173fa61e856d6a91bf9b9c9010877787716b0275869150bd90f6f`（621004 字节）；runIdentifier `e2e01-01-20260912T035944Z`。
- 人工/外部依赖及剩余风险：人工走查与真实 Provider 观察均为 `pending-manual`（证据包强制）；E2E-01-03 需用户真实 Provider 凭据与费用授权，当前缺失须保持 blocked/pending。
- 本地提交、推送尝试与结果：E2E-01-01 `23f38eb`、补记 `9eca588`；E2E-01-02 切片 1 `d5430d9`、补记 `48ea32d`；切片 2 `a900fc5`（均第 1 次推送成功）。

## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮只执行 E2E-01-01；先记录基线和失败场景，再完成该检查点。不要领取后继，未满足条件不得标记done。

