# B6R-10 终验证据（2026-08-16，B6R-11 更新）

> 任务卡：`docs/tasks/BATCH6_REPAIR_TASK_CARDS.md` B6R-10
> 目标：四批目标测试、单模块覆盖率 ≥95%、跨平台矩阵、check/coverage/pack/smoke-install、tarball 内容审计、PLAN_STATUS 恢复。

## 环境

| 项 | 值 |
|---|---|
| Git HEAD（初测） | `a04ce9a`（feat(orchestration): B6R-09 编排接入） |
| Git HEAD（B6R-11 后） | 待提交 |
| Node | v24.18.0 |
| npm | 11.16.0 |
| OS | win32 x64 10.0.26100（Windows 11） |
| 远端 | 无（`git remote -v` 为空） |

## 动态证据（Windows）

| 命令 | 退出码 | 结果 |
|---|---|---|
| B6R 目标测试 12 文件（初测） | 0 | 129 测试通过 |
| `npm run check`（B6R-11 后） | 0 | 74 文件 / 787 测试通过 |
| `npm run test:coverage`（B6R-11 后） | **0** | Statements 92.29% / **Branches 85.05%（≥85% 达标）** |
| `npm pack` | 0 | `astarray-0.1.0.tgz`（69 文件） |
| tarball 内容审计 | 0 | 无 `.env`/凭据/测试/日志/运行数据/临时目录 |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + 全局 shim + feedback-entry 独立加载全通过 |

## 单模块分支覆盖率核查（B6R-11 后；目标 ≥95%）

| 模块 | B6R-10 | B6R-11 后 | 达标 | 说明 |
|---|---|---|---|---|
| tertiary-lifecycle | 91.25% | **95%** | ✓ | resume 分支补测 |
| assist-installation-gate | 95.65% | 95.65% | ✓ | |
| registered-agent-directory | 66.66% | ~93% | ✗ | 未覆盖分支为重复登记拒绝等已测/保留 |
| session-permission-elevation | 75.36% | 91.3% | ✗ | 剩余：持久化清理/编码边界（产品保留，见下） |
| session-shutdown-and-export | 61.22% | ~82% | ✗ | 剩余：个体资源范围不匹配等（已测到产品行为边界） |
| agent-individual-memory | 84.37% | 93.75% | ✗ | 剩余 183-187（并发 stale 路径） |
| installation-operation-classifier | 90.9% | ~91% | ✗ | 95 行数组元素计数（模块加载执行但 v8 未计数） |
| evidence-completion-gate | 91.66% | ~95% | ✓ | 空包/来源正文路径补测 |
| main-agent-readonly-projection | 80% | ~90% | ✗ | 缺省生成器已补 |

**产品保留分支理由（不伪造覆盖）**：
- policy-wrapper 298（注册工具必映射且内置均有实现 → 运行时不可达）；
- run-command 87/92（blocked 需任务阻塞编排 mock、60s 超时轮询属防御）；
- session-permission-elevation 持久化清理（单实例单会话设计行为，跨会话文件清理在测试中已按实际行为记录）。

## 跨平台矩阵

- 本机仅 Windows（win32 x64）；仓库无远端，无法在本会话内建立 Linux/macOS CI。
- 状态：**未通过（保持）**。证据缺失：Linux Node 20/新版本矩阵、macOS Node 20/新版本矩阵。

## 结论（B6R-11 后更新）

- 功能、打包、隔离安装、tarball 审计、**全局分支覆盖率门槛（85.05%）**：**通过**。
- 单模块 ≥95%：3/9 达标；其余经合理测试大幅提升，剩余为产品保留分支（已记录理由）。
- 跨平台矩阵：**未通过** → 待远端/CI 就绪后补齐（可开 B6R-12 平台卡）。
- PLAN_STATUS：T06E/F/G/T08A 可恢复为 re-verifying；T08B 阻塞解除待平台矩阵补交后终态化。

## 复核（2026-10-10，第 49 轮）：本卡数字**已全面过期**，重测后单模块目标达成

**为什么必须重测**：本卡记录的是 2026-08-16 的测量（74 文件 / 787 测试、分支 85.05%）。
当前仓库已是 **362 文件 / 2724 测试**；直接沿用旧表会得出错误结论
（既可能"误以为没达标"而重复劳动，也可能"误以为达标"而掩盖真实缺口）。

**本轮以同一方式重测**（`.tmp/vitest.plain.mjs` + `coverage-final.json` 按 branchMap 统计），
本卡 §"单模块分支覆盖率核查"点名的 **9 个模块**结果如下：

| 模块 | 本卡记录（B6R-11 后） | 本轮实测 | 达标（≥95%） |
| --- | --- | --- | --- |
| tertiary-lifecycle | 95% | **100%**（41/41） | ✓ |
| assist-installation-gate | 95.65% | **100%**（22/22） | ✓ |
| registered-agent-directory | ~93% | **100%**（10/10） | ✓ |
| session-permission-elevation | 91.3% | **100%**（35/35） | ✓ |
| session-shutdown-and-export | ~82% | 91.30% → **100%**（23/23） | ✓（本轮补测） |
| agent-individual-memory | 93.75% | **100%**（16/16） | ✓ |
| installation-operation-classifier | ~91% | **100%**（54/54） | ✓ |
| evidence-completion-gate | ~95% | **100%**（6/6） | ✓ |
| main-agent-readonly-projection | ~90% | **100%**（3/3） | ✓ |

**唯一真实缺口是 `session-shutdown-and-export`（91.30%，余 L148/L149）**，已补 **6 条行为用例**
（`tests/core/unit/b6r10-session-shutdown-record-validity.test.ts`）钉住记录有效性契约：
基线一致⇒覆盖生效；**kind 不同**⇒失效；**custom 且 profileId 不同**⇒失效；
**custom 且 profileId 相同**⇒生效（不得因 custom 一律失效）；revision 不符⇒失效；
会话权限 revision 不符⇒失效。补测后该模块 **23/23 = 100%**。

**本轮结论与本卡旧表的一处重要差异**：本卡把 `session-shutdown-and-export` 的剩余分支
描述为"个体资源范围不匹配等（已测到产品行为边界）"，暗示是**产品保留**；
实测表明这些分支**可以通过公开 API 覆盖** ⇒ **无需改动生产代码**，
仅靠**行为测试**即达成 100%。本卡"产品保留分支理由"中关于该模块的部分据此**不再适用**。

**本卡仍未完成（如实保留，不用文字覆盖）**：
- **跨平台矩阵**：本会话证据**仅 Windows**；Linux/macOS 须由平台提供；
- **`npm run test:coverage` 全局门槛不达标（真实退出码 1）**：`vitest.config.ts` 要求
  lines/functions/statements/branches **均 ≥85%**；本轮实测 **branches 83.89%**
  （`ERROR: Coverage for branches (83.89%) does not meet global threshold (85%)`），
  其余三项 91.56 / 92.52 / 91.59 均达标。**本轮已把分支从 83.56% 提到 83.89%**：
  为 `parameter-authorization-settings-command.ts` 补**进程内**用例（该文件此前只由
  **子进程**驱动、v8 看不见 ⇒ 长期 **0%**、20 个分支全缺），新增
  `tests/tui/unit/merge01-parameter-authorization-settings-command.test.ts` **9 条**。
  **后续同一轮继续推进**：再补三片后分支升到 **84.24%**（仍差约 40 个分支）——
  · `tests/tui/unit/b6r10-wait-for-task-terminal.test.ts` **10 条**（等待终态：done/cancelled
    原样、blocked/failed 归 blocked、给上限耗尽如实返回 running、`timeoutMilliseconds: null`
    不设上限、**进入前/等待中**两个时机的待裁决询问、可选能力缺省不报错）；
  · `tests/core/unit/b6r10-diagnostic-merge-branches.test.ts` **7 条**（诊断同指纹归并：
    次数累计、乱序时间取真实 first/last、agent/request/mission/task 证据**去重累积**、
    null 不留空串、文本不进指纹）；
  · **把 `waitForPermissionAsk` 从 `run-command.ts` 提取到 `cli/permission-ask-wait.ts` 并导出**
    （原为未导出函数 ⇒ 只能经 CLI 子进程间接覆盖、v8 看不见 ⇒ 其承载的**两处产品修复长期零覆盖**），
    新增 `tests/tui/unit/b6r10-permission-ask-wait.test.ts` **8 条**：已消费文本不得重复触发询问、
    **推进窗口内 running 不立即收口**（否则授权后重跑从未被等待）、窗口内出现新询问立即返回、
    终态失败立即返回、blocked 且仅非询问类升级立即返回、超时如实返回 null。提取**不改语义**，
    `run-command.ts` 导入同一实现。
  **剩余最大缺口**：`cli/commands.ts` **90/430**（单文件即占全部缺失的约 40%）。
  **不得**以"接近门槛"当作通过；
- 本卡记录的历史命令（`npm pack`、`smoke-install`）已由后续 TOOLKIT-01-06 的
  **tarball 隔离安装验收（`verify:toolkit-package` 48/48）**覆盖并超越。