# 任务卡 Backlog（2026-10-17，目标：逐渐推进完成所有任务卡）

## 0. 方法与**诚实的限制**

| 做法 | 结果 |
| --- | --- |
| 枚举 `docs/tasks/*.md` | **42 张卡**（`README.md` 与 `PRODUCT_INTEGRATION_ROLLOUT.md` 是索引/纲要，非卡） |
| 机器扫描 checkbox | 未勾选 **12 个**，集中在 2 张卡（`2026-09-16_INCREMENTAL_DESIGN` 6 个、`LESSON01` 6 个）|
| 读那 12 个 | **都是"检查点收口前的交付核对单"**（如"文件所有者已确认""所有状态保持 pending 直到真实完成"），**不是功能缺口** |
| 关键词扫"未完成/待办"（218 处） | 大量出现在**免责声明**里（"不代表已完成"）⇒ **不能据此判定状态** |

**⇒ 结论：42 张卡的真实状态无法靠机器判定，必须逐卡读"未完成/剩余"段落。**
本 backlog 因此分四层，Tier 3 是**逐轮消费的工作队列**。

---

## 1. Tier 1 —— 本会话已推进/闭合的卡（状态已变，卡内文字可能仍写"未做"）

| 卡 | 本会话的推进 | 依据 |
| --- | --- | --- |
| `T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD` | G1 三层贯通（门面→装配→控制器→编排器）+ 五门禁评估器（合并默认永不通过） | 总表 §21.6、§25、§32 |
| `TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD` | G4 工具说明回执端到端跑通（首次完整用法 / 同 revision 仅提醒 / 未登记不注入） | 总表 §32 |
| `T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD` | G2 进度守卫 + 任务链预算持久化；G5 有界续跑 | 总表 §13、§16.6 |
| `GUI01_R_PRODUCT_WORKBENCH_TASK_CARD` / `GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD` | G9 状态如实化 + G10 CLI 分发（`preset list` / `concurrent status` argv 级验收） | 总表 §5.7 |
| `E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD` | G10 argv 级 E2E（真实子进程跑 `dist/cli.js`） | 总表 §5.7 |
| `OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS` | 卡内已注明边界；本轮未新增 | 总表 §10.1 |
| `MERGE01_NODECTX01_TASK_CARDS` | 工具级 action 归并（MERGE-01-01/02）此前已闭合；本会话未改 | 总表 §5.x |

**⚠️ 注意**：这些卡**卡内文字未更新**（本会话只更新了总表与 `PLAN_STATUS`）。是否需要回填卡内状态，**需你确认**（改卡等于改权威文档，我不擅自动）。

## 2. Tier 2 —— 卡内已注明边界（无需处理，4 张）

`OBS01`、`T05D`、`T08C_T07C`、`TOOLKIT01`（见总表 §10.1）。

## 3. Tier 3 —— **逐轮消费的工作队列**（每轮只做 1 张、先读该卡"未完成/剩余"段）

| 顺序 | 卡 | 初判方向（**待读取确认**） |
| --- | --- | --- |
| 1 | `GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD` | 授权与历史视图；本会话只做了 CLI 分发，GUI 侧与人工体验仍未验 |
| 2 | `PROJECT01_ISOLATION_AND_CROSS_PROJECT_BORROWING_TASK_CARD` | 跨项目借用与 worktree 相关能力（与 G1 现状交叉） |
| 3 | `COMM01_ADDRESSABLE_UPPER_LAYER_AND_SINGLE_PARENT_TASK_CARD` | 可寻址上层与单父链；通信句柄转交 |
| 4 | `SESSION_SUMMARY_AND_STEERING_TASK_CARDS` | 会话摘要与驾驶 |
| 5 | `T09A_CONTEXT_NODE_CLOSURE_AND_RECALL_TASK_CARD` | 上下文节点闭合与召回 |
| 6 | `T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD` | 会话恢复与对账（与 G5 续跑交叉） |
| 7 | `T12_SECURITY_HARDENING_TASK_CARD` | 安全加固 |
| 8 | `SMART01_INSTRUCTION_WINDOW_AND_MAIN_RESPONSIVENESS_TASK_CARD` | 指令窗口与主 Agent 响应性 |
| 9 | `CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS` | 文件夹授权与入职 |
| 10 | `BRIDGE01_EXTERNAL_TOOL_MVP_TASK_CARD` | MCP/外部工具 MVP |
| 11 | `HISTORY01_LOCAL_RUN_HISTORY_AND_RESUME_VIEW_TASK_CARD` | 本地历史与恢复视图 |
| 12 | `EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS` | 工作流发现与历史维护 |
| 13 | `T08D_CRAFTSMAN_TERTIARY_PRESET_TASK_CARD` | 工匠预设（休眠三级预设） |
| 14 | `T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD` / `T07D_R1` / `T07D` / `T07D00` | Provider 产品接线与审计 |
| 15 | `WB00_MICRO_EDIT_WORKBENCH_PROTOTYPE_TASK_CARD` | 工作台原型 |
| 16 | `RELOCATE01_COLD_START_PROJECT_RELINK_TASK_CARD` | 冷启动项目重连 |
| 17 | `BATCH6_REPAIR_TASK_CARDS` + `B6R*`（4 张） | 批量修复与验收 |
| 18 | `AR07_FINAL_ACCEPTANCE` | 终验 |
| 19 | `2026-09-16_INCREMENTAL_DESIGN` / `2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY` | 增量设计 / 运行时可可用性 |
| 20 | `LESSON01_MODEL_ALIGNED_COMMUNICATION_MEMORY_TASK_CARD` | 沟通记忆 |
| 21 | `INT00_PRODUCT_PATH_AUDIT_TASK_CARD` | 产品路径审计（其产物是 Tier 分级依据，需再跑一次） |
| 22 | `T08C_T07C_AGENT_ROUTING_AND_MODEL_POLICY_TASK_CARDS` | 路由与模型策略 |
| 23 | `PRODUCT_INTEGRATION_ROLLOUT` / `README`（索引类） | 核对索引是否与现状一致 |

## 4. Tier 4 —— **只能由用户/平台提供**（遇到即停）

`SUM-01` 人工标注、macOS/Linux 平台证据、GUI/人工体验结论、真实 Provider 凭据与额度、任何产品文案授权。

---

## 5. 每张卡的处理流程（固定，不得简化）

1. **读**该卡"未完成/剩余/限制"段，写出 1–3 条可本地验证的缺口；
2. **反例先行**（真实装配入口，确认红）⇒ 存 `.tmp` 或入库（视红/绿）；
3. 实现/接线（一次改完 ⇒ `typecheck`）；
4. 反例转绿 + **拔线必失败**；
5. `npm run check` ⇒ `verify:mutation-kills` ⇒ `npm pack` + 两个 verify；
6. 更新本 backlog 该卡状态 + `PLAN_STATUS` + 单独提交推送。

**轮次预算**：单卡 ≤6 轮；超出停下说明卡点。
