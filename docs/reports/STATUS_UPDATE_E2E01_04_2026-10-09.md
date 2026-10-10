# 状态补丁：E2E-01-04 覆盖率门禁达标 + Windows rename 抖动根因修复

- 任务：`E2E-01-04：质量与交付声明`
- 日期：2026-10-09
- 提交基线：`9f9b175`（本补丁随代码修复一起提交）

> 说明：本补丁产生于 `PLAN_STATUS.md` 存在**用户并行编辑**期间，按 `AGENTS.md`（并行冲突规则）
> 未修改该共享文件。**2026-10-10 用户结束编辑后，本补丁内容已并入 `PLAN_STATUS.md`
> 顶部「2026-10-10 当前有效状态」表的 E2E-01-04 行与「E2E-01-04 证据链」小节**；
> 本文件保留为该轮次的详细记录。

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
3. `smoke-install.mjs` **已修复并实测 exit 0**（"冒烟测试全部通过 ✓"）。此前 exit 1 由**三个叠加原因**造成，
   已逐一定位并修掉（都不是"玄学抖动"）：

   | # | 真实原因 | 证据 | 修复 |
   | --- | --- | --- | --- |
   | 1 | Windows `rename` 瞬时锁 EPERM（重试预算仅 150ms） | `EPERM: … rename '….summary.json.<pid>.<uuid>.tmp' -> '…summary.json'` | 有界指数退避 7 次 / 25→800ms（`atomic-json.ts`） |
   | 2 | **我埋下的类型缺陷**（第 10 轮为该测试自造 `Record<string, unknown>` 形参） | `tsc`：`error TS2345`(L279)、`error TS2322`(L529) | 入参类型改为从 `ProviderRequestUsageObserverPort` 端口签名派生 |
   | 3 | `smoke-install.mjs` 解析 `npm pack --json` **过于脆弱** | `SyntaxError: Unexpected non-whitespace character after JSON at position 2`（`prepack` 输出混进 stdout，首 `[` 落在 check 输出里） | 从后往前逐候选起点尝试解析，取首个"数组且首元素含 filename" |

   **流程失误的教训（已记）**：#2 之所以潜伏多轮，是因为我当时**只跑了 `vitest` 与 `eslint`、没跑
   `npm run typecheck`**——vitest 不做类型检查，全绿掩盖了 `tsc` 失败。以后凡改 `tests/**` 或
   `packages/**` 的 TS，必须跑 `npm run typecheck`（或直接 `npm run check`）。

## 4. E2E-01-04 本地可证项现状（全部本地项现已通过）

| 项 | 结果 |
| --- | --- |
| `npm run check`（typecheck+lint+build+test） | **exit 0**（由 `smoke-install` 的 `prepack` 路径实测） |
| `npm run test:coverage`（仓库配置、默认并发、阈值 85） | **exit 0**，分支 **85.05%** 达标 |
| 安全关键模块专项 | **22/22 ≥95%** |
| E2E-01-01 fixture 复现 | 指纹 `6512b2a6…c7c` 与历史一致 |
| `npm pack` + `verify-package` | exit 0（239 文件，sha256 `8b175e31…`） |
| `smoke-install.mjs` | **exit 0（冒烟测试全部通过）** |

**仍未满足**：人工体验结论、Linux/macOS 平台证据（只能由用户或平台提供）→ `E2E-01-04` 保持 `in_progress`。
