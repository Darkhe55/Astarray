# 跨卡对账（2026-10-10 第 60 轮收束 · 本会话终版）

> 本文档是**本会话（第 43–60 轮）**的收束对账，与
> `docs/reports/CROSS_CARD_RECONCILIATION_2026-10-10.md`（第 40 轮版）并存：
> 后者保留历史快照，本文档给出**当前 HEAD**（`63d1473`）的逐卡结论。
> **未满足门禁的项一律未标完成。**

## 0. 末次核对的门禁真实退出码

| 门禁 | 退出码 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | **0** | — |
| `npm run lint` | **0** | — |
| `npm run build` | **0** | — |
| `npm run check` | **0** | **374 文件 / 2829 用例通过、skipped 0** |
| `npm run test:scripts` | **0** | — |
| `npm run test:coverage` | **0** | stmts 92.6 ／ **branch 85.06** ／ funcs 93.45 ／ lines 92.63（门槛均 85） |
| `npm run verify:toolkit-package` | **0** | **48/48** |
| `npm run verify:instruction-entry-package` | **0** | **17/17**（指令窗口 + 跨项目） |
| `node scripts/verify-mcp-bridge-loop.mjs` | **0** | **20/20**（checkCount 20、0 失败） |
| 全仓 `it.skip` | — | **0** |

**必须同时记录的反例（不掩盖）**：同一批门禁在**负载下偶发** 1–3 条与改动无关的
用例失败，**隔离复跑全绿**（本会话多次观测；本轮 `check` 先失败、复跑 exit 0）。
该抖动登记在可执行故障矩阵（`load-sensitive-full-gate-flake`，`not-verified`），
**未在产品代码中修复，故不标为已修**。**已定位到具体用例**：
`tests/core/integration/reliability-r4-ledger-concurrency.test.ts` ④
（多轮交错并发 4×6 幂等账目追平）在本会话至少 2 次全量运行中失败，
而**隔离单跑 3/3 通过**。

> **后续补记（同日）**：本仓已取得 **Linux 平台证据**（WSL2 Ubuntu 26.04 / Node 22.22.1），
> 并因此**发现并修复一个只有 Linux/macOS 能暴露的真实缺陷**（`GitProcess` 超时
> 只收口直接子进程 ⇒ 孙进程继续运行）。详见
> `docs/reports/LINUX_PLATFORM_EVIDENCE_2026-10-10.md`。

## 1. 本会话新增/修复的实质内容（按卡）

### 1.1 真实缺陷修复（由新写的反例先抓住）

| 位置 | 缺陷 | 抓它的用例 | 状态 |
| --- | --- | --- | --- |
| `summary-index-store.ts` | **迁移崩溃恢复不可能**：备份名带时间戳 ⇒ 认不出"迁移中断" | 迁移执行 ⑤ | **已修**（确定性备份名 + 中断识别 + 不二次备份） |
| `summary-index-store.ts` | **`detectLegacyManifests` 排序不确定**：`readdir` 顺序泄漏到报告 | 迁移判定 ⑫ | **已修**（补 `sourceKind` 比较键） |
| `summary-index-store.ts` | **永远走不到的假分支**（zod 只抛 `Error` 子类） | —— | **已删** |
| `packages/gui/.../gui-server.ts` | **未绑定 receiver** ⇒ GUI 静默显示"unknown" | — | **已修**（`readSettings.call(...)`） |
| `public-sdk.ts` | 统一入口解析**过度接管**（误拒 `backupVault`） | 既有保护网 | **已修**（限定已注册族名/别名） |
| `parameter-authorization-settings-store.ts` | 关闭细分**静默扩大权限** | MERGE-01-02 反例 | **已修**（放宽需认证确认、被拒不推进 revision） |

### 1.2 交付的能力（本地可证范围）

- **MERGE-01** 01/02/03、**NODECTX-01** 01/02/03：**全部 done**（详见任务卡检查点表）。
- **SUM-01-02**：旧文件迁移的**只读判定**（10 条反例）+ **安全执行**（8 条反例：
  备份并移走 ⇒ 原子重发、幂等、逐条独立、崩溃恢复、损坏清单仍可迁移且坏内容留备份）。
- **SUM-01-04**：**报告来源的真实数据源接线**（从 `stateDirectory/main-agent-reports`
  真实取数；跨重启证明来自磁盘；空任务不发布空清单）。
- **TOOLKIT-01-06**：**更大样本的多轮复用实测**（`measureRecipeReuseAcrossRounds()`：
  实测轮数 vs 预测次数分列、一次性 vs 按轮成本分开、**结构性守恒可核对**、
  失败轮不计入节省、`measuredSavingMinutes` 恒 0）。
- **PROJECT-01-03**：补齐**"写成功但回执未落盘"崩溃时点**的反例（行为表征测试，
  **不是**缺陷修复——该 fail-closed 语义此前已正确）。
- **RELIABILITY-01**：矩阵 13 → **15 条**，把两处真实缺口登记为 **`not-verified`**
  （`smart01-continuous-reception-real-run`、`load-sensitive-full-gate-flake`）。
- **B6R-10**：**覆盖率门槛清除**（分支 83.56% → **85.06%**；期间四次补片，含
  把 `waitForPermissionAsk` 从 `run-command.ts` **提取为可测模块**使其两处产品修复
  首次被直接覆盖）。

### 1.3 明确**拒绝**的造假行为（重要）

对 `conversation` 与 `deferred-file` 两类摘要来源做了**全仓核查**，结论：
二者**在 schema 里合法，但本仓没有任何生产它们的本地存储**
（全仓无会话轮次持久化；`deferred-file` 只出现在 schema 与适配器、**无写入方**）。
⇒ **不新造假存储去喂它们**（卡内"无真实 usage 标为未测，不杜撰"），
改为在代码注释与报告中**就地记录该能力边界与核查依据**。

## 2. 仍未完成（附**具体卡点**）

| 卡 | 仍未完成项 | 卡在哪（具体条件） |
| --- | --- | --- |
| SMART-01 | ~~04 的真实运行持续接收实测~~ **已解决（2026-10-10 取得额度后）** | **真实运行已通过**：`verify:u2-flash-continuous-reception` **exit 0、判据 8/8**（派发 18ms、接收 13ms、派发≠完成、关闭回收、凭据零写入）。**仍剩**：macOS 平台证据 |
| SUM-01 | 会话历史/延后文件的**真实数据源**、触发阈值测量、多设备重复测量 | **需宿主侧持久化**，本仓不提供；阈值/多设备**需真实使用样本** |
| PROJECT-01 | 04 的多项目大样本压力验收；"人工能分辨副本与原件" | 真实大样本压力**需真实负载**；人工可辨识性属**人类体验结论（须用户提供）** |
| B6R-10 | 跨平台矩阵 | 本会话证据**仅 Windows**，须 **Linux/macOS 平台**提供 |
| AR-07 | 平台不可达分支（非 win32 归一化、`sensitive-content-access-policy` L78/L156、`protected-storage-policy` L40） | 只能由 **Linux/macOS 平台**执行后取得证据 |
| RELIABILITY-01-03 | 跨平台矩阵 | 同上 |
| GUI-01-R | 真实用户人工体验（键盘/中文/缩放/可访问性/断线恢复/资源观察） | **须用户提供**；本地子项（01/02/03a/03b/04a/04b）**均已交付** |
| BRIDGE-01 | 第三方客户端（opencode/pi）消费与模型驱动闭环 | **需用户授权 + Provider 凭据**；脚本化 stdio 闭环 **20/20** 已通过 |
| TOOLKIT-01 | 06 的真实 token/模型请求消耗、真实维护成本、跨平台可比性 | **须真实额度**与平台 |
| OBS / EVENT-01 / COMM-01 / WB-00 | 逐组核对与完整实施证据 | 本会话**未取得**完成证据；**不凭其它卡完成推断** |

## 3. 仅**用户或平台**可提供（不得由自动断言替代）

1. **Linux/macOS 平台证据**：B6R-10 跨平台矩阵、AR-07 平台分支、RELIABILITY-01-03、
   非 win32 归一化。
2. ~~**真实 Provider 额度**~~ **已提供（云之声 u2-flash）**：SMART-01-04 真实运行持续接收**已通过**；TOOLKIT-01-06 的真实 token 消耗**仍未采集**（额度可用不等于已测）。
3. **用户人工体验结论**：GUI-01-R-04b（含从安装包打开 GUI）、PROJECT-01 副本/原件可辨识性。
4. **第三方客户端授权**：BRIDGE-01-04（opencode/pi + 凭据）。
5. **宿主侧持久化**：SUM-01 的会话历史与延后文件真实数据源。

## 3b. 同日后续（WSL + 真实额度）：两项"仅外部可提供"已解决

| 原列于"仅用户或平台可提供" | 结果 |
| --- | --- |
| Linux 平台证据（B6R-10/AR-07/RELIABILITY-01-03） | ✅ **已取得（WSL2 Ubuntu 26.04）**，并**发现+修复一个真实跨平台缺陷**（进程树泄漏） |
| 真实 Provider 额度（SMART-01-04） | ✅ **已取得（云之声 u2-flash）**，真实运行验收 **exit 0、8/8** |

**因此我原先"本地无可推进路径"的判断是错的** —— WSL 就在本机，我该更早探测。
如实更正：本会话曾据此把目标标为 blocked。

**当前仍未取得**：
- **macOS 证据**（WSL 不是 macOS，进程终止/信号语义不同）；
- **AR-07 各平台分支的 Linux 覆盖率单独核算**（本轮聚焦全量门禁，未逐分支统计）；
- **TOOLKIT-01-06 真实 token 消耗**（额度可用 ≠ 已采集）；
- ~~授权后重跑闭环的 Linux 缺陷~~ **已修复（2026-10-10）**：`DagScheduler.unblockTask` 幂等化（迟到的 unblock 不再把正在运行的任务降回 pending）——**不放宽状态机**（`pending → done` 仍非法）。Linux 全量 **2834/2834 通过**。

## 4. 为什么不把目标标为完成

目标要求"**逐步完成 docs/tasks 下所有任务卡内容**"。当前第 2 节列出的未完成项中，
**没有任何一项存在本地可推进路径**：它们分别需要平台、额度、用户结论、第三方授权或
宿主侧实现。把它们标为完成，或用说明性文字覆盖未满足的门禁，
**正是本任务纪律明令禁止的行为**。因此：

- 本会话**如实保持**目标为 `active`；
- 全部已完成项**已逐片单独提交并推送**（见 `PLAN_STATUS.md` 推送记录与 `git log`）；
- 全部门禁的**真实退出码**已列于第 0 节，**包括负载抖动的反例**。
