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
| ~~1~~ | ~~`GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD`~~ | **第 1 轮结论（2026-10-17）：剩余项均非本地可证** —— ①GUI-02-01④ 退出码需 CLI 级真实 Provider 接线、**TTY 逐字输出需真实 TTY**（外部）；②GUI-02-03/04 的 UI/路由与"重启真实操作证据"需 GUI 人工体验（外部）。已有回归 `b6r10-permission-ask-wait`（8 条）只覆盖等待语义，**未**断言退出码/TTY。⇒ 移入 Tier 4 |
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

---

## 6. 逐卡判定记录（阶段 B 实况）

| 轮 | 卡 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | `GUI02` | **移入 Tier 4** | 剩余项：退出码需 CLI 级真实 Provider（重）、**TTY 需真实 TTY**（外部）、UI/路由与"重启真实操作"（GUI 人工体验）。既有回归 `b6r10-permission-ask-wait` 只覆盖等待语义 8 条，未断言退出码/TTY |
| 2 | `PROJECT01` | **重，需专门窗口** | `PROJECT-01-03` 已 done（本地可证范围）；剩余＝**`PROJECT-01-04`：A/B/C 三项目 + 多同级个体**的可追溯/不串数据/压力验收 ⇒ 需多项目端到端编排 |
| 2 | （附带加固）| **已完成** | 发现新模块（G1 五门禁、G4 渲染器）**无变异体覆盖** ⇒ 补 2 条，`62/62` 全拦下（`0da8313`） |
| 3 | `src` TODO 扫描 | **无缺口** | 全仓 `src` 仅 4 处"故意未支持"的明确报错（`view` 参数无取值），非 TODO |

## 7. 已知工具缺陷（本轮发现，未修）

**变异 harness 把"变异后语法错误"误判为"变异存活"**：
- 现象：`find` 只截取了三元表达式**第一行** ⇒ 变异后语法错误 ⇒ vitest 无法收集用例 ⇒ 命名用例"没变红" ⇒ 判为 **存活** ✗；
- 正确行为：应判为 **脚本错误**（"变异体自身不合法"）；
- 修法（下次）：在 `parseJsonReport` 之后检查"是否有测试文件**收集失败**"⇒ 有则报脚本错误并指出该变异体；
- 我已踩过 2 次（`rationale` 半角引号嵌套、`find` 非完整表达式），**harness 自身也应校验**。

## 8. 策略调整（第 3 轮结论）

42 张卡里**多数剩余项是外部/重型**（GUI、TTY、多项目压力、真实凭据）。逐卡空转效率低。
**改为双轨**：
- **轨 A（卡）**：只挑卡内**可本地轻量验证**的项（每卡先判，判定理由入 §6）；
- **轨 B（代码）**：从「已知未接线/未验证」清单与**测试覆盖盲区**（如本轮发现的"新模块无变异体"）里找**便宜且明确**的缺口，按同一纪律闭合。

**轨 B 的候选来源（优先级）**：① 新代码的变异体覆盖；② 既有报告里"未接线/未验证/未复现"条目；③ `PLAN_STATUS` 中非 done 的行；④ 隔离包/门禁里被跳过的断言。

> **2026-10-17（第 4 轮）补记 —— 我尝试修它，但把 harness 改坏了，已回退**：
> 用 PowerShell 数组 `-join` 拼多行块时**丢了换行**，导致守卫被压成一行、并把
> `failedTestNames = collectFailedTestNames(report)` 那行吞进注释 ⇒ harness **半坏**（却仍打印 62/62）。
> **已 `git checkout 0da8313 -- scripts/verify-mutation-kills.mjs` 回退**，复验：`node --check` 0、`collectFailures` 0 处、变异 **62/62** ✓。
> **教训**：改这个文件必须用 **Node 脚本 + 显式 '\n'.join**（已验证可靠），**不要用 PowerShell 数组拼多行**。
> 守卫本身**仍未加**（下次按此方式重做，并用一个故意写坏的 `find` 验证"语法错⇒脚本错误"）。
