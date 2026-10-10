# 状态补丁：E2E-01-04 覆盖率门禁达标 + Windows rename 抖动根因修复

- 任务：`E2E-01-04：质量与交付声明`
- 日期：2026-10-09
- 提交基线：`9f9b175`（本补丁随代码修复一起提交）

> 说明：`PLAN_STATUS.md` 当前存在**用户并行编辑**，按 `AGENTS.md`（并行冲突规则）本补丁不修改该文件，
> 以独立文件交付；**待用户确认后由用户合并进 `PLAN_STATUS.md` 当前有效表**，我不覆盖他人修改。

## 1. 覆盖率门禁：**达标**（仓库口径 exit 0）

`npm run test:coverage`（**仓库配置**、默认并发、阈值 85）实测：

| 项 | 值 |
| --- | --- |
| 退出码 | **0**（此前因用例抖动为 1） |
| 用例 | **307 文件 / 2346 用例通过**（2 skipped） |
| 行 / 分支 / 函数 / 语句 | **92.66 / 85.05 / 92.62 / 92.7**（均 ≥85） |

补充口径（临时 json reporter 配置、`--maxWorkers=6`）：分支 8014/9422 = **85.05%**，
起点 83.29%（需补 161 条）→ 本冲刺**全局净增约 166 条**。
`L0`（无位置信息）未覆盖 216（无法定向补测）；可定位池未覆盖 1192。

## 2. 根因修复：Windows `rename` 瞬时锁导致整测试套件偶发失败

**真实证据**（默认并发跑 `npm run test:coverage` 抓到）：

```
EPERM: operation not permitted, rename
  '…\missions\mission-6f0c8d5d\.summary.json.43784.….tmp' -> '…\missions\mission-6f0c8d5d\summary.json'
```

**根因**：`packages/core/src/infra/atomic-json.ts` 的原子写做「临时文件 → rename」，
Windows 下目标文件被瞬时占用（杀软/索引器/并发读句柄）会使 rename 抛 EPERM。
原重试预算仅 **3 次 × 50ms（约 150ms）**，默认并发下会被耗尽并抛出——
因此偶发失败、隔离运行从不复现，并连带使 `smoke-install` 的 `prepack → npm run check` 失败。

**修复**：改为**有界指数退避**——7 次、25→800ms（合计约 1.6 秒）；
非可重试错误码（如 ENOENT）**立即抛出**；预算耗尽后照旧抛出最后一次错误（不静默吞掉、不无限重试）。

**确定性验证**（不靠"再跑一遍看看"）：新增 `tests/core/unit/atomic-json-rename-retry.test.ts`，
mock `fs.rename` 断言三条契约——瞬时 EPERM 必须重试并在随后成功（3 次失败 + 第 4 次成功）、
EPERM 持续必须**恰好 7 次**有界失败、ENOENT 必须**只尝试 1 次**立即抛出。3/3 通过。

## 3. 仍未达标/未做的部分（不掩盖）

1. **人工体验结论**、**Linux/macOS 平台证据**仍缺 —— 只能由用户或平台提供，故 `E2E-01-04` 保持
   `in_progress`（卡内明文"未决必选项不得done"）。真实 Provider 场景已由 `E2E-01-03` 覆盖。
2. **超时型抖动仍属独立风险**：本轮另一次默认并发运行中 `run-command-gaps` 曾以
   `Test timed out in 60000ms` 失败（隔离复跑 5.4s 通过）。本次修复针对 EPERM，**不覆盖**该类超时抖动；
   该用例的超时预算是下一轮的候选处理项。
3. `smoke-install.mjs` 在本次修复后**复跑仍 exit 1**（`.tmp/session-r2-04/smoke-after-fix.log`）。
   已知：失败发生在它内部的**不带 `--ignore-scripts` 的 `npm pack` → `prepack` → `npm run check`**，
   报错为 `Command failed: npm pack …`。
   **尚未定位这次运行的具体失败用例**（本轮只确认到 `npm pack` 命令失败）——不做猜测，
   留待下一轮抓取其内部 `npm run check` 的 FAIL 明细后再判定是"同一抖动"还是"另有原因"。
   注意：`npm run check` 本身在 **默认并发** 下本轮并未复现 EPERM（`test:coverage` exit 0），
   故 `smoke-install` 的失败**很可能另有其因**（例如它自身的打包/安装步骤或超时型抖动）。
