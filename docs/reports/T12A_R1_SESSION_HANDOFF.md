# 会话收尾与交接（T12A-R1 产品接线返修）

> 收尾时间：2026-09-10
> 当前 HEAD：`d59cc74`（`origin/main` 同步，无未推送提交）
> 目标：goal-20b28d68-310d-486e-b0a8-6a92c84586ff（按 PRODUCT_INTEGRATION_ROLLOUT 顺序推进）

## 1. 本会话已完成（按推荐顺序）

| 顺序 | 卡/检查点 | 状态 | 关键提交 |
| --- | --- | --- | --- |
| 1 | INT-00 产品路径矩阵与状态对账 | done | 早期提交（docs/reports/INT00_*） |
| 2 | T07D-R1 应用装配与公开 SDK | done | 早期提交（docs/reports/T07D_R1_*） |
| 3 | T07D-R2-01/02/03 Provider 产品接线 | done | 早期提交（docs/reports/T07D_R2_*） |
| 4 | T07D-R2-04 真实 Provider 证据 | **blocked** | 缺真实凭据与费用授权，card 保持 in_progress |
| 5 | T09A-R1 上下文运行时接线（-01..-04） | done | `4f7e815`…`eedc2db` |
| 6 | T12A-R1-01 恢复命令到应用服务 | done | `7582dad` + 补记 `dcb0288` |
| 7 | T12A-R1-02 副作用与权限对账 | done | `daf7cd1` + 补记 `d59cc74` |

证据报告：`docs/reports/`（每个检查点一份，含公共入口命令、退出码、行为反例与门禁结果）。

## 2. 门禁基线（最后一次全量运行）

- `npm run check`：exit 0，167 文件 / 1467 用例通过。
- `npm run test:coverage`：exit 0，全局 93.62% stmts / 86.75% branch / 91.34% funcs / 93.69% lines（≥85% branch 阈值）。
- `npm run build` 产物中恢复模块可达性由 `tests/tui/unit/t12a06-cli-wiring.test.ts` 断言。

## 3. 下一轮起点

- **T12A-R1-03 上下文事务恢复**（前驱 T12A-R1-02 已通过）：联测关闭胶囊、全局记录、延后片段、人工签字与补充核验任务的部分提交；验证缓存失效、预算与图 revision 保持；签字不跨 revision 复用；补充核验不重复不丢失；预算不因重启清零。
- 其后：T12A-R1-04（安装包恢复与进程收口）→ E2E-01 → BRIDGE-01 → GUI-01-R → WB-00。
- GAP（-02 记录）：检查点生产端尚未写入 `gitStateRecovery`；恢复后任务重新派发与 tarball 重启证据待 -03/-04/E2E-01。

## 4. 工作树与并行改动

以下改动**有意保持未暂存**（用户并行改动/既有未提交项），收尾时未触碰：

- `IMPLEMENTATION_PLAN.md`、`PLAN_STATUS.md`、`docs/tasks/README.md`（M）
- `tests/core/unit/application-sdk-task-events.test.ts`（M；既有超时放宽改动）
- 未跟踪卡：BRIDGE01、E2E01、GUI01_R、PRODUCT_INTEGRATION_ROLLOUT、WB00

## 5. 接手要点

- 每轮只领一个检查点：先写行为反例 → 验证公共入口真实调用控制器 → 跑相关测试与 `npm run check`（覆盖率相关加 `test:coverage`）→ 按 AGENTS.md 本地提交并尝试 push（≤5 次）→ 另起一次提交补记提交哈希与推送结果。
- 沙箱限制：`npm run check`/`test:coverage`/`npm pack`/`git push` 需要 `danger-full-access` 升级；未升级时可用 `npx tsc --noEmit`、`npx eslint .`、`npx vitest run --configLoader runner --config .tmp/vitest.plain.mjs --pool=threads` 做定向验证（threads 模式下 fork/spawn 类用例会因沙箱 EPERM 失败，属已知限制）。
- 恢复目标：认领 goal `goal-20b28d68-310d-486e-b0a8-6a92c84586ff` 并 `resume`，从 T12A-R1-03 继续。
