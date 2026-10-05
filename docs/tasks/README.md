# Astarray 任务卡索引

2026-10-05 新增 [COMM-01 上层明确寻址与执行层唯一上级](./COMM01_ADDRESSABLE_UPPER_LAYER_AND_SINGLE_PARENT_TASK_CARD.md)：状态 pending；按契约审计 → 路由与关系接线 → 公共入口及 tarball 验收推进。同项目主/次级默认全连接；跨项目按需连接，由目标项目有权主 Agent 或用户授权。三级/四级仅通过唯一直属上级通信；旧的下级通信转交改为上级代理。与在途反馈、SDK、恢复改动串行集成，不将设计图视为实现通过。

2026-09-13新增 [摘要与运行中引导四组任务卡](./SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md)：SUM-01动态摘要 → SUM-02跨模型预算与可靠性 → GUIDE-01安全点引导 → EVENT-01紧急仲裁恢复。摘要总长度无固定硬上限，单次读取及模型注入预算独立执行；前驱见卡内说明。

> 本文件用于帮助定位任务卡；实际任务状态以根目录 `PLAN_STATUS.md` 和各任务卡中的动态验收证据为准。

COMM-01 补充边界：跨项目始终只读，可经授权同层查询和提出建议，不得直接或借自动转发修改对方项目；采纳与执行由目标项目自行按权限处理。最低级 Agent 的跨项目协作仍经唯一上级代理。

## 当前实施入口（2026-09-10）

新一批九张卡及其共同验收规则见 [产品接线实施顺序](./PRODUCT_INTEGRATION_ROLLOUT.md)。推荐顺序：INT-00 → T07D-R1 → T07D-R2 → T09A-R1 → T12A-R1 → E2E-01；随后BRIDGE-01与GUI-01-R，最后WB-00。每轮只执行一个检查点；当前首项为INT-00-01，全部新卡尚待执行。以下旧偏序保留作历史记录，冲突时以本批规则为准。

## 当前高风险设计任务

| 任务 | 任务卡 | 当前定位 |
|---|---|---|
| T08C / T07C | `T08C_T07C_AGENT_ROUTING_AND_MODEL_POLICY_TASK_CARDS.md` | 四层 Agent 路由、模型/Provider 目录与策略 |
| T08D | `T08D_CRAFTSMAN_TERTIARY_PRESET_TASK_CARD.md` | 阶段性“工匠”三级 Agent预设 |
| T07D | `T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md` | 主流 Provider 协议、真实流式、产品装配、Public SDK 与独立工作助手闭环 |
| T05D | `T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD.md` | 人工与 Agent 并行编码、变化保护、冲突协调和次级受控合并 |
| T07E | `T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD.md` | 每 Agent默认10个项目内容文件工作集、拆分与范围化扩展 |
| T09A | `T09A_CONTEXT_NODE_CLOSURE_AND_RECALL_TASK_CARD.md` | 全局决策提升、局部上下文偏序关闭、分级回访和缓存效率指标 |
| T12A | `T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD.md` | 中断后统一检查点、外部状态对账、身份/任务安全恢复 |
| T12 | `T12_SECURITY_HARDENING_TASK_CARD.md` | T12A 后的综合安全加固（跨进程并发写保护/孤儿收口/只读一致性/静态门禁） |
| GUI-01 | `GUI_MVP_CODING_TASK_CARD.md` | 本地浏览器 GUI MVP |

当前有效偏序为：

```text
T08C ─┬→ T08D → T07C ───────────┐
      ├→ T05D ──────────────────┼→ T07D → T12A → T12 → T13 → T14
      └→ T07E ──────────────────┘
```

现有 T12A/T12 已完成实现后新增 T09A，因此当前增量顺序为：

```text
T05C + T07A + T07B + T08A + T09 + T12A
  → T09A
  → T12A/T12 恢复与安全回归
  → T13/T14 最终打包与文档验收
```

GUI-01 使用自己的前驱和验收门禁，不得与 T07D 的 Provider 生产化合批。

## Batch 6 返修与验收卡

| 文件 | 用途 |
|---|---|
| `B6R00_BASELINE.md` | 返修基线 |
| `BATCH6_REPAIR_TASK_CARDS.md` | Batch 6 高风险返修序列 |
| `B6R-04b-TUI-PERMISSION-PROFILES.md` | TUI 权限组补充返修 |
| `B6R-11-COVERAGE-SPRINT.md` | 覆盖率补强 |
| `B6R10_FINAL_ACCEPTANCE.md` | 当前终验证据与未决平台项 |

## 使用规则

- OpenCode 每轮默认只执行一张高风险任务卡中的一个检查点。
- 开始前必须读取 `AGENTS.md` 规定的四份根目录文档以及目标任务卡引用的 ADR。
- 任务卡状态不能代替动态测试、覆盖率、tarball 隔离安装和人工门禁证据。
- 生产变量和函数使用完整可读名称；时间量必须包含单位。
- 删除、文字删减、替换、截断或覆盖必须由执行工具在变更前自动备份。
- Assist 下的依赖、代码库、SDK、运行时、插件和工具链安装必须先询问是否已有资源，再经过独立开关和本次精确授权。
- T09A 每轮只执行一个可独立验收检查点，预计不超过3小时；不得与 Provider、GUI、T12综合安全或最终打包合批。
