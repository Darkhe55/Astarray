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
