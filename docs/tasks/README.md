# Astarray 任务卡索引

> 本文件用于帮助定位任务卡；实际任务状态以根目录 `PLAN_STATUS.md` 和各任务卡中的动态验收证据为准。

## 当前高风险设计任务

| 任务 | 任务卡 | 当前定位 |
|---|---|---|
| T08C / T07C | `T08C_T07C_AGENT_ROUTING_AND_MODEL_POLICY_TASK_CARDS.md` | 四层 Agent 路由、模型/Provider 目录与策略 |
| T08D | `T08D_CRAFTSMAN_TERTIARY_PRESET_TASK_CARD.md` | 阶段性“工匠”三级 Agent预设 |
| T07D | `T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md` | 主流 Provider 协议、真实流式、产品装配、Public SDK 与独立工作助手闭环 |
| T05D | `T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD.md` | 人工与 Agent 并行编码、变化保护、冲突协调和次级受控合并 |
| T07E | `T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD.md` | 每 Agent默认10个项目内容文件工作集、拆分与范围化扩展 |
| T12A | `T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD.md` | 中断后统一检查点、外部状态对账、身份/任务安全恢复 |
| GUI-01 | `GUI_MVP_CODING_TASK_CARD.md` | 本地浏览器 GUI MVP |

当前有效偏序为：

```text
T08C ─┬→ T08D → T07C ───────────┐
      ├→ T05D ──────────────────┼→ T07D → T12A → T12 → T13 → T14
      └→ T07E ──────────────────┘
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
