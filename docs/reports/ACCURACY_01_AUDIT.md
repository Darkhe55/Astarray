# ACCURACY-01 签收/完成链路审计与冻结 — 证据

> 检查点：ACCURACY-01（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md，**未跟踪用户文件：只读取、未修改未暂存**）
> 前驱：AUTH-SCOPE 三检查点完成（`98d0f8c` 已推送）。日期：2026-09-16
> 契约冻结：docs/adr/0040-accuracy-tiers-budget-and-skip-status.md

## 1. 现有链路审计（只读）

| 环节 | 现有实现 | 已具备 | 缺口 |
| --- | --- | --- | --- |
| 完成控制事件 | `packages/core/src/core/completion-protocol.ts`（`ASTARRAY_TASK_COMPLETION_V1`） | 防重放 `completionAttemptId`、**`taskSequenceRevision` 陈旧拒绝**、末行/宽限解析、blocked 事件 | 事件**无验收条目 ID、无产物/测试回执、无证据来源字段** |
| 工作者完成门禁 | `packages/core/src/orchestration/worker-agent.ts` | 未解决的可变工具失败（`MUTATING_TOOL_NAMES`）→ 不得 done；Provider 必须给完成控制事件 | 未校验"必需验收条目覆盖"与证据覆盖 |
| 人工签收/否决 | `human-verification-controller.ts` + 延迟核验任务 | 签收绑定上下文图 revision（陈旧拒绝）、否决重开节点、延迟任务（待追认） | 与**完成声明**未绑定；无"条目 → 证据"映射 |
| 证据包 | `tools/evidence-bundle-builder.ts` + `core/schemas.ts` | 空条目拒绝、覆盖说明（`computeCoverageNotes`）、规范化哈希 | 只在 `factVerification` 流程使用；未接入任务完成门禁 |
| 交付证据校验 | `scripts/e2e01-acceptance.mjs`（`validateEvidenceBundle`） | 版本/运行 ID/commit/tarball/配置/Provider/签名人工项校验 | 属交付脚本，非任务级完成校验 |
| 证据优先级/高严谨性 | `factVerification` 工具 + ADR-0016 | 资料搜索 > 本地实验 > 纯推理；报告来源/覆盖/冲突/局限 | 未与"检查档位/预算/跳过状态"关联 |
| 档位/预设/跳过状态 | **不存在**（全仓无 `quality-check-skipped` 等语义；"跳过"命中均为协议/目录/敏感路径处理） | — | **完全缺失**（档位、预算、跳过状态、降级拒绝） |
| 部分完成 | 任务链状态可 `blocked`；进度可报告 | 部分完成不自动结案（既有门禁） | 无"进度 vs 结案"的显式准确性检查条目 |

**结论**：完成声明目前**只有任务标识与序列 revision**，没有任何"验收条目 → 证据"绑定、没有档位/预算/跳过状态，
也没有"必需条目覆盖"检查。缺口真实存在，ACCURACY-02 需在既有完成门禁之上补齐，而不是新建调度。

## 2. 三类反例的当前行为（先证明缺口）

| 反例类 | 任务卡要求 | 当前行为 | 结论 |
| --- | --- | --- | --- |
| **未来 revision** | 核查未来 revision | `taskSequenceRevision` 只做"陈旧拒绝"（小于当前被拒）；**大于**当前的可疑值没有显式反例测试 | ⚠ 缺口：需补"未来 revision 拒绝"与既有陈旧拒绝的成对测试 |
| **漏报必需节点** | 必需节点未报告不得视为完成 | 完成事件只列 `completedTaskIdentifiers`，不列必需验收条目；门禁不检查覆盖 | ❌ 缺口：需"条目 → 证据"映射与覆盖校验 |
| **空证据** | 空证据不得通过 | `EvidenceBundleBuilder` 拒绝空条目，但完成门禁不消费证据包 | ❌ 缺口：完成声明必须引用非空证据 |
| **部分完成** | 部分完成不得结案 | 未解决问题会使任务 `blocked`/不 done；但"已完成 X/Y"与结案判定无显式绑定 | ⚠ 缺口：需显式"结案要求全部必需条目"检查 |

## 3. 冻结结果（档位/预算/跳过状态）

见 ADR-0040 §1–§8：`fast`/`standard`/`strict` 三档（standard 默认）、认证用户可配且 Agent 不得自行降级、
检查预算有界（数值在 02 冻结）、`quality-check-skipped` 为独立状态（不得写成通过）、
完成声明绑定稳定验收条目 ID + 真实产物/测试回执 + 版本 + 必需条目覆盖 + 证据来源。

## 4. 命令与退出码

| 项 | 结果 |
| --- | --- |
| 本检查点性质 | **审计/冻结：无产品代码变更**，不新增测试、不跑全量门禁（与 AUTH-SCOPE-01、WB-00-01 同类判定） |
| 最近一次全量门禁（同一代码基线 `98d0f8c`） | build 0；`test --maxWorkers=6` **206 文件/1669 用例全通过**；coverage exit 0（93.25/85.48/92.21/93.31） |
| 未执行 | 未运行任何真实 Provider/安装/外部软件操作 |

## 5. 提交与推送

- 实现提交：`7c79539` `docs(accuracy): ACCURACY-01 签收/完成链路审计与档位冻结`（3 文件，+109/−1；仅暂存本检查点文件，用户并行改动保持未暂存）。
- 推送：`git push` **第 1 次成功**（`98d0f8c..7c79539`，网络自 AUTH-SCOPE-02 阶段重置后已恢复）。
- 本检查点为审计/冻结（无产品代码变更），未新增测试；同一代码基线最近一次全量门禁为 206 文件/1669 用例全通过、覆盖率 93.25/85.48/92.21/93.31。

## 6. 下一检查点（ACCURACY-02 范围）

- 幂等签收（`completionAttemptId` 复用拒绝）、**可选理解确认**（standard 歧义时 / strict 必选）、
  **条目 → 证据覆盖**、复用原完成验收器（不新建）。
- 必测反例：错收件人、重复派发、旧/未来版本、伪造证据、陈旧产物、崩溃重启、空证据、必需条目漏报、部分完成结案尝试。
- 档位/预算/跳过状态的设置与公共入口接线属 **ACCURACY-03**（含增量 E2E：关闭后无新增模型审查或人工阻塞、状态诚实）。
