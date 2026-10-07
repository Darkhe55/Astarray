# PLAN_STATUS — Astarray 实施状态

## 2026-09-13 摘要与运行引导任务布置

用户已确认推荐方案，摘要采用动态长度且无固定总长上限。[四组任务卡](docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md)均为pending，实施未开始，不改变原任务验收结论。

| 任务 | 状态 | 前驱 |
|---|---|---|
| SUM-01 动态摘要索引与展开 | pending | T09A-R1/T07D-R1相关接线 |
| SUM-02 跨模型预算与可靠性 | pending | SUM-01 |
| GUIDE-01 运行中引导 | pending | SUM-02、T07D-R2-02及T12A-R1相关路径 |
| EVENT-01 紧急仲裁与恢复 | pending | GUIDE-01 |

> 更新规则见 `IMPLEMENTATION_PLAN.md` §8.4：开始任务标记 `in_progress`，全部验收通过才标记 `done`。
> 会话中断后从第一个 `in_progress` 或依赖已满足的 `pending` 任务恢复。

## 2026-09-10 产品接线增补任务（均未执行）

共同规则和独立任务卡链接见 [PRODUCT_INTEGRATION_ROLLOUT.md](docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md)。原卡done记录不代表新增接线验证已通过；INT-00核实原验收缺口后纠正相关旧状态，保留历史证据。

| 任务 | 状态 | 前驱/推荐顺序 |
|---|---|---|
| INT-00 产品路径审计 | pending | 首项：INT-00-01 |
| T07D-R1 应用服务与SDK接线 | pending | INT-00 |
| T07D-R2 首个Provider产品接线 | pending | T07D-R1 |
| T09A-R1 上下文运行接线 | pending | T07D-R1；入口联测需T07D-R2-02 |
| T12A-R1 恢复产品接线 | pending | T07D-R1；最终联测需T07D-R2-02、T09A-R1 |
| E2E-01 独立工作助手验收 | pending | 上述四张返修卡通过 |
| BRIDGE-01 外部接入MVP | pending | T07D-R1；交付需E2E-01 |
| GUI-01-R GUI产品接线 | pending | T07D-R1；联测需上下文/恢复返修；交付需E2E-01 |
| WB-00 细节微淘原型 | pending | GUI-01-R；未来探索 |

## Batch OBS/SMART/PROJECT（OBS-01、SMART-01、PROJECT-01 三卡）检查点记录

### 2026-10-02 — 12 个检查点实现完成（用户授权记录核验结构）

验收命令与实际结果（每条均为**当轮实测的真实退出码**，非替代性说明）：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check`（PERF-01-02 轮） | 0 | 269 文件通过 + 1 跳过；2024 用例通过 + 2 跳过 |
| `npm run check`（PERF-01-03 轮） | 0 | 270 文件通过 + 1 跳过；2032 用例通过 + 2 跳过 |
| `npm run check`（USAGE-01-02 轮） | 1 | 抖动：`context-runtime-cache-events` 61s 超时；隔离运行 2 文件全部通过 |
| `npm run check`（USAGE-01-03 轮） | 1 | 抖动：`summary-cli` 61s 超时；隔离运行 2 文件全部通过 |
| `npm run check`（DIAG-01-02 轮） | 0 | 273 文件通过 + 1 跳过；2057 用例通过 + 2 跳过 |
| `npm run check`（DIAG-01-03 轮） | 0 | 274 文件通过 + 1 跳过；2064 用例通过 + 2 跳过 |
| `npm run check`（SMART-01-02 轮） | 0 | 275 文件通过 + 1 跳过；2074 用例通过 + 2 跳过 |
| `npm run check`（SMART-01-03 轮） | 1 | 抖动：`application-sdk-task-events` 5.5s；隔离运行 4 条用例全部通过 |
| `npm run check`（SMART-01-04 轮） | 0 | 277 文件通过 + 1 跳过；2095 用例通过 + 2 跳过 |
| `npm run check`（PROJECT-01-03 轮） | 1 | 抖动：`cli-commands` 68s 超时；隔离运行 22/22 通过 |
| `npm run check`（PROJECT-01-04 轮，**最终**） | 0 | 279 文件通过 + 1 跳过；2117 用例通过 + 2 跳过 |
| `npx vitest run`（本批 11 个反例文件） | 0 | 11 文件 / **102 条反例**全部通过 |

最终基线：`HEAD == origin/main == 73f7dd9`。本批提交**未包含**用户并行编辑的 `IMPLEMENTATION_PLAN.md`、`PLAN_STATUS.md`、`README.md`、`agent-main-architecture.md`、`docs/tasks/README.md`、`tests/core/unit/application-sdk-task-events.test.ts`、`tests/tui/integration/permission-ask-adjudication.test.ts`。

检查点与提交：

| 检查点 | 提交 | 交付要点 |
|---|---|---|
| PERF-01-02 | `08017df` | 追加式样本存储（并发不撕裂行、半行报告丢弃数、溢出计数）、纯函数聚合（无样本 mean=null）、游标分页、五类告警（含 clock-anomaly）；`tool-loop` 真实工具执行后上报耗时 |
| PERF-01-03 | `3e8fa09` | `queryPerfOverview`（范围/时间窗/摘要明细/分页、覆盖范围回显、只读零请求、内存有界）；CLI `perf overview` |
| USAGE-01-02 | `2e43b1b` | 请求级账目按键收敛原子落盘、同键异参拒绝、乱序终值拒绝、重启幂等、按模型分组、估算不入账单、取消缺 usage 记 null 不补 0、预算判定 |
| USAGE-01-03 | `9b817be` | `queryUsageOverview`（可复算、不虚报余额+免责说明、估算来源分列、按具体个体过滤不泄漏他人明细）；CLI `usage overview` |
| DIAG-01-02 | `5bcfb76` | 错误 JSONL 落盘前脱敏、指纹合并计数（文本不进指纹）、故障链根因+包装码顺序、三类分类分列、诊断自身失败报不可测量、明细有界 |
| DIAG-01-03 | `7b64a90` | `queryDiagnosticSummary`（事实/推断/证据不足三列分列、证据引用可追溯）、`buildRedactedDiagnosticBundle`（纯构造不落盘、三项 contains\*=false）；CLI `doctor --errors` / `--bundle` |
| SMART-01-02 | `d5347e5` | 指令窗口持久队列、同步段内原子准入（并发不超容）、同键异参拒绝、超容排队、回执为候选（revision/任务关联不符则不释放槽位）、终态补位、降上限总数守恒 |
| SMART-01-03 | `1d999e5` | 停止分类（硬约束优先：停止/休息不注入）、漏回执仅凭独立权威证据补位、有界追问、澄清答案抽取且混合信封保留剩余任务；带未决问题回执进入 `awaiting-clarification` |
| SMART-01-04 | `d28b6dd` | 三分钟期限判定（超期如实报超时、等待澄清不冒充完成）、门禁不被补位绕过、有界补位（不灌队列、跳过在途、记录来源与原因、不伪造用户消息） |
| PROJECT-01-03 | `74cdb67` | 跨项目授权记录（绑定双方 revision + 完整参数哈希 + 期限 + 任务）、授权来源必须是认证用户、缩权派生、再转交拒绝、只读来源零写入、副本导入幂等回执 |
| PROJECT-01-04 | `73f7dd9` | 有效授权 = 来源可导出 ∩ 目标可接收 ∩ 接收个体权限（deny 优先、思索只读、默认 allow 不建共享关系）、多项目/多同级个体过滤不串数据、副本可分辨；CLI `cross-project list` |

反例过程中**实际发现并修复的缺陷**（非形式化通过）：

- 并发落盘竞态：临时文件名仅含 pid → 并发互相 rename 掉对方临时文件（实测 `ENOENT`）。
- 架构守卫拦截：自写 `writeFile/rename` 被 `tests/architecture/destructive-file-api-guard.test.ts` 正确拒绝 → 改用受控 `infra/atomic-json.writeAtomicJson`。
- 并发导入竞态：5 个并发均通过"查回执→写回执"，产生 5 次副作用 → 改为同步段内原子认领。
- 认领占位被持久化：崩溃重启后重放失效 → 认领后必须用真实回执覆盖并持久化，认领前 `ensureLoaded`。
- 窗口槽位语义瑕疵（自查发现）：入窗与排队均记 `accepted` 会导致补位后槽位仍被占用 → 按契约区分 `dispatched`/`accepted`。
- 三处测试自身错误（`toEqual` 含函数字段、正则无效转义、夹具自相矛盾）→ 按"改测试不改产品口径"修正。

遗留与未主张完成项：

- **SMART-01-04 入口与包验收**：已补做完成，见下节「入口与包级验收补做」。
- **SMART-01-04 持续接收（模拟慢模型/长下级任务）**：已补做**离线部分**，见下节「持续接收补做」；卡内措辞中的"真实运行"整机实测仍未执行，不主张该项完成。
- **负载检查（明确延后）**：满载门禁中 `summary-cli`、`cli-commands`、`context-runtime-cache-events`、`application-sdk-task-events`、`provider-fake-server`、`provider-tool-loop`、`e2e01-vertical-rework` 等偶发超时失败，独立运行均通过。经用户决定，**负载/并发预算检查留到正式上线前进行**，本批不处理。
- 计划外未动项：T07D-R2-04 正向闭环、`auth-scope-replay-rejected`（已收窄至 CLI 接线未修；门禁层正确性由 `tests/core/integration/scope-authorization-regrant.test.ts` 3/3 通过证明）、CLI 结果后进程滞留（`it.skip`）、Anthropic 离线端到端用例（`it.skip`）、BRIDGE-01 / GUI-01-R / WB-00。

本批真实 Provider 额度消耗：**0**（全程离线）。

### 2026-10-02 — 入口与包级验收补做（用户指示补做缺口，负载检查延后）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check`（入口补做轮） | 0 | 282 文件通过 + 1 跳过；2132 用例通过 + 2 跳过 |
| `npm run verify:observability-entry-package` | **0** | **8/8 项通过**（tarball 隔离安装 + 四入口实跑 + 只读性） |
| `npm run check`（包验收轮） | 1 | 抖动：`provider-fake-server` 53s；隔离运行 6/6 通过 |
| `npm run test:scripts` | 0 | tests 5（scripts/lib 单元测试） |

入口补做（提交 `41450b9`）：

- **SDK 入口**：`public-sdk.ts` 显式 re-export 本批七组模块（性能/用量/诊断/指令窗口/停止恢复/期限监督/跨项目），
  消费者仅用公开 exports 即可查询，不依赖内部路径。反例 `tests/core/integration/sdk-entry-surface.test.ts` 4 条。
- **GUI 入口**：`GuiServerOptions.observabilityStateDirectory`（未提供则不暴露，既有行为不变）+
  `GET /observability` 回传 performance/usage/diagnostics/crossProject；仅接受 GET；**严格只读**；
  不可测量时如实回传 `isReportable=false` 与原因。反例 `tests/gui/integration/gui-observability-overview.test.ts` 5 条
  （含"GET 后状态目录文件集合与内容均不变"）。
- **CLI/TUI 入口**：`tests/tui/integration/cli-observability-entry.test.ts` 6 条（真实子进程、cwd 隔离）覆盖
  `perf overview` / `usage overview` / `doctor --errors` / `doctor --bundle` / `cross-project list` 均 exit 0
  且**不创建状态目录**，非法参数仍为退出码 2。

包级验收（提交 `97a7256`）：

- 新增 `scripts/verify-observability-entry-package.mjs` + `npm run verify:observability-entry-package`；
  `npm pack --ignore-scripts`（默认跳过 prepack 以保证哈希可复现，`--run-prepack` 可开启）→ 隔离安装 →
  用**已安装包**的 `node_modules/astarray/dist/cli.js` 实跑五条入口 → 断言只读性 → 落盘 `acceptance-verdict.json`。
- 本次实测：tarball `astarray-0.1.0.tgz`（1088722 字节，`sha256=429fe8fd9753b9cd…`），来源提交 `41450b9`；
  8/8 项通过，其中**只读性一项实测确认概览查询未创建 `.astarray` 状态目录**；真实额度消耗 0。

### 2026-10-02 — 持续接收补做（慢模型/长下级任务）与指令窗口并发守卫

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run tests/core/integration/instruction-continuous-reception.test.ts` | 0 | 6 条反例通过 |
| `npx vitest run`（窗口队列 + 持续接收） | 0 | 16 条通过（无回归） |
| `npm run check` | 1 | 抖动：`provider-tool-loop` 50s、`e2e01-vertical-rework` 181s；隔离运行 **4/4 通过** |

内容（提交 `f7d6337`）：

- 反例①模拟慢模型（真实延迟 120ms：首条在途期间后续指令仍被受理，窗口满则排队不丢弃）；
  ②长下级任务在途不阻断接收；③超期如实报超时且 `isWorkCompleted=false`（UI 不冒充成果完成）；
  ④关闭回收后有界补位且跳过在途；⑤同一实例并发接收 4 条不丢不重；⑥多实例并存必须响亮失败。
- **反例⑥ 证伪的静默丢数据缺陷（已修）**：两个实例并存访问同一状态目录时各自持有内存快照整体
  覆盖落盘，实测丢失指令。修复：`atomic-json.ts` 的 `writeAtomicJson` 新增
  `WriteAtomicJsonOptions.beforeCommit` 守卫钩子（临时文件 fsync 之后、**rename 提交之前**调用；
  抛错则不提交并清理临时文件）；`instruction-window-store.ts` 增加状态指纹与
  `assertForeignWriteBeforeCommit`，检测到外部写入即抛「指令窗口并发冲突…已拒绝覆盖以避免静默丢指令」；
  提交成功后记录**磁盘实际指纹**（而非内存指纹——并发写链下后者会导致误判，已实测修正）。
- **诚实边界**：这是「检测并拒绝」，消除的是**静默**覆盖；**不是**分布式共识，不承诺
  「最后写入者胜」的并发正确性。该限制已写入代码注释，未主张多实例并发安全。
- 本项覆盖「模拟慢模型/长下级任务」的**离线**部分；卡内「真实运行」整机实测未执行。

### 2026-10-02 — u2-flash 真实运行实测（SMART-01-04 缺口，部分通过）

真实额度已消耗。u2-flash（unisound，Anthropic 兼容端点，`https://maas-api.unisound.com/anthropic/v1/messages`）

探针（最小连通验证）：HTTP 200、`stop_reason=end_turn`、**耗时 10302ms**、
`usage: input_tokens=110 / output_tokens=16` —— 确认为**真实慢模型**，无需人工注入延迟。

实测脚本 `scripts/verify-u2-flash-continuous-reception.mjs`（凭据只注入、不打印不落盘；运行前后断言凭据文件字节一致）：

| 判据 | 结果 |
|---|---|
| ① 长只读任务 180 秒内被受理并派发 | ✓ 20ms |
| ② 任务 A 提交后处于在途 | ✓ running |
| ③ **在途期间仍能接收新指令** | **✓ 24ms** |
| ④ 派发状态与成果完成可区分 | ✗ 终态 failed |
| ⑤ 两条指令收敛到终态 | ✓ A=blocked B=blocked |
| ⑥ 真实运行产出成果 | ✗ 未产出 |
| ⑦ 未写入受保护凭据 | ✓ 一致 |

结论（如实）：
- **"慢模型在途仍能接收新指令"核心判据通过**（任务 A 在途时任务 B 在 24ms 内被受理，远低于 180 秒）；
- 但**两条任务均在约 92ms 内失败**（`assignment` 记录于任务创建后 92ms，远早于任何模型调用），
  mission 记录为 `cancelled`/`failed`。**失败点在接线层而非模型层，根因尚未定位**，故
  **不主张 SMART-01-04 已真实验收**。

实测暴露并已修的缺口：
- **SDK 入口缺口**：`public-sdk.ts` 未导出 Anthropic 注册（2026-10-02 加协议时只接 CLI 侧），
  导致 SDK 消费者无法只用公开 exports 装配 `anthropic-messages` 运行时。已补导出。

自查修正：早期版本的检查④仅断言"终态不再是 accepted"，会把 failed/blocked **误判为通过**（本次实测踩到）。
已加严为"终态必须 succeeded"，并新增检查⑥"真实运行确实产出成果"，使失败无法伪装成通过。

### 2026-10-02 — u2-flash 实测根因定位与修复（完成控制协议从未告知模型）

`npm run check`：**真实退出码 0** —— 283 文件通过 + 1 跳过；2138 用例通过 + 2 跳过。

**定位到的真实产品缺陷（已修，提交 `3c6fa65`）**：
`requireCompletionEvent` 此前**只用于本地门禁**（`worker-agent.ts`「缺少 ASTARRAY_TASK_COMPLETION_V1
完成控制事件」），而完成事件的**格式从未注入模型提示词** —— `ASTARRAY_TASK_COMPLETION_V1` 只存在于
解析器与门禁中。后果：真实 Provider 下模型无论答得对不对都会被门禁拦下，任务必然 blocked。
修复：`requireCompletionEvent === true` 时在系统提示词追加【完成控制事件】段（精确末行格式 +
逐字段符合 `taskCompletionEventV1Schema` 的载荷示例 + 未完成时不得输出的约束）。
载荷初版字段名写错（用 `taskIdentifier`，schema 要求 `completedTaskIdentifiers` 等），
模型照做也会被拒；已按 schema 修正并**离线校验**（注入载荷被真实解析器接受为 `completion`，
旧载荷被拒为 `none`）。

**真实实测现状（u2-flash，真实额度已消耗；仍不主张 SMART-01-04 通过）**：

| 判据 | 结果 |
|---|---|
| ① 在 180 秒内被受理并派发 | ✓ 14–22ms |
| ② 提交后处于在途 | ✓ running |
| ③ **在途期间仍能接收新指令** | **✓ 14–57ms** |
| ④ 派发 ≠ 成果完成 | ✗ 终态 blocked/failed |
| ⑤ 收敛到终态（关闭回收） | ✓ |
| ⑥ 真实运行产出成果 | ✗ |
| ⑦ 未写入受保护凭据 | ✓ 字节一致 |

- **端到端成功已被观察到一次**：最小诊断任务达到 `done` 且输出正确（`name` = astarray），
  证明"提示词注入 + 门禁 + 解析器"链路可用。
- 完整实测仍有失败，且**两种原因不同**（本条为重要发现）：
  · 单问任务 → 仍报"缺少完成事件"（**模型遵循性**问题：未按注入格式输出末行）；
  · 三步侦察任务 → "工具 readFile 连续失败达到阈值"（**工具调用正确性**问题：模型反复以错误参数调用）。
- 下一步：提示词强化/续跑以提升遵循性；工具参数错误的重试与纠错。

### 2026-10-02 — u2-flash 实测：真实产出成果已验证（提交 `dba8053`）

**核心结论：卡内两个关键点已在真实 Provider 上得到验证**

| 判据 | 结果 |
|---|---|
| ① 在 180 秒内被受理并派发 | ✓ 18ms |
| ② 提交后处于在途 | ✓ running |
| ③ **在途期间仍能接收新指令** | **✓ 41ms** |
| ⑤ 两条均收敛到终态（关闭回收） | ✓ |
| ⑥ **真实运行产出成果** | **✓ 至少一条 `done`** |
| ⑧ 未写入受保护凭据 | ✓ 字节一致 |
| ④ 派发 ≠ 成果完成 | ✗ 首条终态 blocked |
| ⑦ 两条都产出成果 | ✗ A=blocked B=done |

**任务 B 真实成功**（同会话第二条指令）：输出
`package.json 中 name 字段的值是 astarray`，并携带**完全合规**的完成事件
`ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":…,"completedTaskIdentifiers":["T-001"],"claimedStatus":"complete",…}`
—— 证明"提示词注入 + 解析器 + 门禁"链路在真实 Provider 下端到端可用（此前该链路必然失败，见上一小节）。

**我自己的判据错误（已修，值得记录）**：`PublicTaskStatus` 真实取值是
`accepted|running|blocked|done|failed|cancelled`，**成功是 `done`**，我此前按 `succeeded` 断言，
把真实成功的任务判成失败。已改用真实状态名，并把断言拆分为"收敛 / 至少一条成功 / 全部成功"。

**仍未解决**：第一个提交的任务（A）**稳定复现** `[failure] 工具 readFile 连续失败达到阈值`，
而同一会话中后提交的任务 B 用同样的读法成功。已排除判据因素，属真实行为差异，**根因未定位**，
故**不主张 SMART-01-04 完全通过**。

### 2026-10-02 — u2-flash 实测收敛：核心判据通过，并发第二条必失败（提交 `674aa8c`）

**稳定规律**：连续两轮实测均为**恰好一条成功、另一条 blocked**，且 A/B 可互换
（A 用旧措辞时 A=blocked、B=done；A 对齐措辞后 A=done、B=blocked）
→ 属**会话内并发干扰**，不是某个任务或某个文件的问题。

**已逐一排除的假设**（均经查证）：
- 读抑制账本（ADR-0017 反自指读取）：键含 `agentInstanceId + taskExecutionId`（按 Agent 隔离），
  且**未装配** → 非此因。**同时登记一个缺口：该账本未接线**；
- 本地进展/活锁守卫：键含 `taskExecutionId`，且**未装配** → 非此因；
- 运行时共享状态：`AnthropicMessagesRuntime` **无可变状态**（仅只读 options + `fetchImpl`），
  `workerRuntimeFactory = () => resolved.createRuntime()` 每次新建 → 非此因；
- 工具端口共享：每任务 `new WorkerAgent` 各自构建 → 非此因。

**真实实测判据（u2-flash）**：

| 判据 | 结果 |
|---|---|
| ① 180 秒内被受理并派发 | ✓ 18–22ms |
| ② 提交后处于在途 | ✓ running |
| ③ **在途期间仍能接收新指令** | **✓ 41–46ms** |
| ④ 派发 ≠ 成果完成 | ✓ |
| ⑤ 关闭回收收敛到终态 | ✓ |
| ⑥ **真实运行产出成果（至少一条 done）** | **✓** |
| ⑦ 两条都产出成果 | ✗ 并发第二条必失败 |
| ⑧ 未写入受保护凭据 | ✓ 字节一致 |

**结论**：卡内关键点（在途接收、真实产出成果、如实状态、关闭回收、不冒充完成）**已在真实 Provider 验证**；
剩余唯一未通过项是"并行第二条指令必失败"的真实缺陷，**根因未定位**，
故仍**不主张 SMART-01-04 完全通过**。下一步需捕获并发下模型的工具调用参数以定位。

### 2026-10-02 — u2-flash 实测定位并修复两处跨 Agent 共享状态（提交 `c4ffe06`）

门禁：`npm run check` **真实退出码 0** —— 283 文件通过 + 1 跳过；2138 用例通过 + 2 跳过。

**根因证据（用临时诊断探针捕获，探针已移除、未进入提交）**：

```
[DIAG-REQ] agent=worker:mission-A:T-001:1 tool=readFile args={"filePath":"package.json"}
[DIAG-RES] agent=worker:mission-A:T-001:1 tool=readFile result=success
[DIAG-REQ] agent=worker:mission-B:T-001:1 tool=readFile args={"filePath":"package.json"}
[DIAG-RES] agent=worker:mission-B:T-001:1 tool=readFile result=error errorCode=auth-scope-replay-rejected
```

**缺陷一：只读操作也占用"单次授权/重放保护"**（`scope-authorization-gate.ts`）
预留表键是**逻辑操作指纹**（操作种类 + 目标路径 + 规范化参数），**不含 Agent 身份**，且门禁是
运行时级单例、**跨 mission 共享**。后果：同会话中不同任务以相同参数读同一文件，第一条结算成功后，
第二条命中"已结算"分支 → `auth-scope-replay-rejected`。预留/重放保护本意是防**重复副作用**，
只读操作无副作用 → 改为**只读不建立预留**（范围裁决照常，不弱化授权）。
**这正是此前长期未解的"授权后仍被 replay-rejected"之谜的根因。**

**缺陷二：工具连续失败计数器键只有 `taskId`**（`mission-orchestrator.ts`）
两个并行 mission 各有一条 `T-001` → **共用同一计数器**，A 的失败累加到 B 上，
造成"readFile 连续失败达到阈值"误判。已改为键 `agentInstanceId + "|" + taskId`。

**验证**：修复前后真实实测结果发生可解释的变化（此前第二条 `replay-rejected`；此后不再出现），
且全量门禁 0。

**仍未解决**：真实实测仍为"**恰好一条 done、另一条 blocked**"（本次 A=done、B=blocked），
说明还存在**第三种跨 mission 共享状态**，根因未定位，故仍**不主张 SMART-01-04 完全通过**。

### 2026-10-02 — SMART-01-04 真实运行实测**通过**（u2-flash，8/8，提交 `08de582`）

门禁：`npm run check` **真实退出码 0** —— 283 文件通过 + 1 跳过；2138 用例通过 + 2 跳过。
真实实测：`node scripts/verify-u2-flash-continuous-reception.mjs` → **真实退出码 0，8/8 项通过**
（先带诊断探针跑出 8/8，随后移除探针复跑仍 8/8 —— 两次均通过）。

| 判据 | 结果 |
|---|---|
| ① 180 秒内被受理并派发 | ✓ 18ms |
| ② 提交后处于在途 | ✓ running |
| ③ **在途期间仍能接收新指令** | **✓ 43ms** |
| ④ 派发状态与成果完成可区分（派发 ≠ 完成） | ✓ |
| ⑤ 关闭回收收敛到终态 | ✓ |
| ⑥ 真实运行产出成果 | ✓ done 条数=2 |
| ⑦ 两条指令都产出成果（并行下均成功） | ✓ A=done B=done |
| ⑧ 未写入受保护凭据 | ✓ 字节一致 |

**缺陷三（本次修复）：读取抑制账本的 Agent 身份按 `task.id` 合成**
`buildWorkerToolPort` 此前只接收 `task`，于是 `agentInstanceId = "worker:" + task.id`、
`taskExecutionId = "task-exec:" + task.id`。两个并行 mission 各有一条 `T-001` 时，二者在
**读取抑制账本**（键含 agentInstanceId + taskExecutionId + 资源 + 视图参数）上生成**完全相同的键**，
第二个 Agent 的合法读取被判为"同一调用源重复读取" → `resource-already-read`。
修复：把**具体 Agent 实例身份**贯穿到工具端口（`main-controller` / `application-runtime` /
`OrchestratorWorkerFactories.toolPortFactory` / `mission-orchestrator` 调用处与其两处透传）。

**本轮合计修复三处同源缺陷（均为"键漏掉具体 Agent 身份"）**：
1. 只读操作占用单次授权/重放保护 → `auth-scope-replay-rejected`（`c4ffe06`）；
2. 工具失败计数器键只有 `taskId` → 失败跨 mission 累加误判（`c4ffe06`）；
3. 读取抑制账本的身份按 `task.id` 合成 → `resource-already-read`（`08de582`）。

**结论**：卡内验收（在途接收、180 秒内派发、如实状态、关闭回收、不冒充成果完成）在真实
Provider 上**全部通过**，SMART-01-04 的真实运行实测缺口**已闭合**。
凭据只就地注入，未写入任何文档/日志/提交。

### 2026-10-02 — 凭据状态变更与后续计划（离线工作可继续）

门禁：`npm run check` **真实退出码 0** —— 284 文件通过 + 1 跳过；2142 用例通过 + 2 跳过。

**凭据状态（用户告知）**：`prov-unisound-1`（unisound / u2-flash）的 API key **已由用户作废**；
需要再次进行真实 Provider 验证时，**由用户重新提供切换方式**。因此当前：

| 工作类型 | 状态 |
|---|---|
| 离线实现 / 反例 / 门禁 / 包级验收 | **可继续** |
| 真实 Provider 实测（u2-flash 等） | **暂停**，等待用户提供新凭据方式 |

**已为恢复真实验证做好铺垫**（无需用户再说明跑法）：
- `scripts/verify-u2-flash-continuous-reception.mjs`：真实"在途接收"实测，支持
  `--credential-source state`（读既有受保护凭据文件）或 `env`（读 `ASTARRAY_PROVIDER_API_KEY`）；
- `scripts/verify-observability-entry-package.mjs`：tarball 隔离安装 + 四入口实跑（离线）；
- 端点/模型/协议已固化：`https://maas-api.unisound.com/anthropic/v1/messages`、`u2-flash`、
  `anthropic-messages`。

**下一步待推进（按依赖）**：
1. `E2E-01-03`（真实服务与并行中断）——**需要真实凭据**，是当前唯一因凭据被挡的检查点
   （工作内容：真实 Provider 上执行同场景 + 人工工作树制造并发变化 + 工具调用边界中断恢复）；
2. `T07D-R2-04` 的状态需与既有真实运行证据（stepfun / unisound openai-compatible /
   unisound anthropic-messages）重新对账后更新；
3. 离线可继续项：BRIDGE-01 / GUI-01-R / WB-00 等卡中不依赖真实服务的检查点。

**本目标期间新增的离线回归守卫**（提交 `b123659`）：
`tests/core/integration/cross-mission-isolation-regression.test.ts`（4 条）钉住三处
"共享状态键漏掉具体 Agent 身份"缺陷，确保修复不退化；并保留"修复前缺陷形态"作为对照反例。

### 2026-10-06 — 凭据已更换并通过连通验证；T07D-R2-04 后续步骤交接

> ⚠️ **本小节有三处与脚本实际不符，已由同日的"T07D-R2-04 收口"小节更正**（勿照本节的第 2/3 步直接执行）：
> 1. **命令缺参**：本节第 2 步的 `node scripts/verify-t07d-r2-04-tarball-live.mjs --allow-live-request
>    --vendor-identifier unisound --protocol-label anthropic-messages` **缺少 `--provider-endpoint`**，
>    真实模式会直接 exit 2；
> 2. **TTY 前提**：真实模式当时**要求 TTY**，非交互环境必然 exit 2（该命令实测 exit 2、额度消耗 0）；
> 3. **"脚本默认 `--credential-source state`"不成立**：该选项当时**只存在于**
>    `verify-u2-flash-continuous-reception.mjs`；tarball 脚本没有它（已于同日补上）。
>
> 另有一处更严重的判断错误：本节称该脚本"会真实联网执行一个写入任务并产出
> `acceptance-verdict.json`"——实际当时脚本的 live 路径**从不执行任务**，会写出**零判据的
> "通过"记录**。该缺陷已在同日修复（提交 `1462fa5`）。

**凭据状态（用户告知并已实测确认）**：用户已更换 unisound 的 API key。
`.astarray/providers/provider-credentials.json` 已刷新（写入时间 `2026-10-06 16:49:30`），
`referenceId` 仍为 **`prov-unisound-1`**（未变）→ **所有既有脚本与端点配置可直接复用，零改动**。

**连通验证已通过**（命令 `npm run verify:u2-flash-probe`，单次调用）：

| 项 | 值 |
|---|---|
| endpoint | `https://maas-api.unisound.com/anthropic/v1/messages` |
| model | `u2-flash` |
| http-status | 200 |
| stop-reason | `end_turn` |
| elapsed | **8395ms** |
| usage | `input_tokens=110 / output_tokens=15` |

> ⚠️ **Windows 退出码陷阱（新会话勿误判）**：该探针脚本内部 `process.exit(0)` 表示成功，
> 但 PowerShell 观察到的 `$LASTEXITCODE` 可能为 `-1073740791`（`0xC0000409`）——
> 这是 Node 在 Windows 上的 libuv 退出断言（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`），
> **发生于进程收尾阶段，不影响脚本自身的判定与输出**。判断探针是否成功请看 `http-status: 200`
> 与 `连通验证通过（--probe-only）`，不要只看退出码。

**新增版本化入口**（解决"`.tmp/` 未入库、新会话拿不到探针"的交接隐患）：

| npm 脚本 | 作用 | 代价 |
|---|---|---|
| `npm run verify:u2-flash-probe` | 连通验证（`--probe-only`，单次调用） | ~1 次调用 / ~8 秒 |
| `npm run verify:u2-flash-continuous-reception` | 真实"在途接收"完整实测（8 项判据） | ~2 次调用 / ~2–3 分钟 |
| `npm run verify:observability-entry-package` | tarball 隔离安装 + 四入口实跑（离线） | 无额度 |

**下一步执行顺序（建议；先便宜后昂贵）**：

1. `npm run verify:u2-flash-continuous-reception` → 回归确认三处跨 Agent 修复在新 key 下仍成立（期望 8/8）；
2. **补 T07D-R2-04 缺口（需用户明确授权消耗额度）**：
   `node scripts/verify-t07d-r2-04-tarball-live.mjs --allow-live-request --vendor-identifier unisound --protocol-label anthropic-messages`
   —— 该运行会真实联网执行一个写入任务并产出 `acceptance-verdict.json`，
   **用于补上 `docs/reports/T07D_R2_04_STATUS_RECONCILIATION_2026-10-06.md` §2 指出的
   "4 次 `isDryRun=false` 记录缺少判据文件"与报告时间线落差**；
3. 用第 2 步的真实 usage 数字形成**书面费用范围声明**（对账报告 §2 条款 5 的唯一未满足项）；
4. 更新 `T07D_R2_04_TARBALL_LIVE_CONFIRMATION_2026-10-02.md` 的状态描述；
   对账报告结论从 `in_progress` 推进到可判定。

**未变更事项**：本小节**不修改**任务卡状态（T07D-R2-04 仍由作者决定）；
`InstructionWindowStore` 仍未装配到编排器（既有已登记缺口）。

### 2026-10-06 — T07D-R2-04 收口：修复验收脚本"零判据通过"缺陷 + 真实运行取证

**纪律**：一次只领一个检查点；先写行为反例（红）再实现（绿）；报告真实退出码。

#### 1. 回归确认（第 2 步）：真实退出码 0，8/8 通过

`npm run verify:u2-flash-continuous-reception` → `REAL_EXIT_CODE=0`，8 项判据全过
（派发 23ms / 在途接收 15ms / A、B 均 done / 凭据文件字节一致），判据落盘
`.tmp/live-u2-flash/acceptance-verdict.json`。新 key 下三处跨 Agent 修复仍成立。

#### 2. 第 3 步被阻塞的实情（如实记录）

按交接原文逐字执行，**真实退出码 2，额度消耗 0**（在 TTY 校验处以 fail-closed 退出，未发出任何请求）。
三处不符见上一小节的更正说明。

#### 3. 查证中发现的更严重缺陷：验收脚本 live 路径**从不执行任务**

`scripts/verify-t07d-r2-04-tarball-live.mjs` 的判定段依赖 `rounds`，而 `rounds` **只在
`if (isDryRun) { ... }` 内被填充**；全部 6 个提交的 `runOnce(` 调用数恒为 3（1 处定义 + 2 处干跑），
**从来没有 live 分支**。真实模式的后果是确定性的：`rounds=[]` → `checks=[]` → `failedChecks=[]` →
写出 `verdict: "passed"` 并打印"验收通过：产物正确 + 任务 done ✓"，**而一次 Provider 请求都没发**。

> 这解释了 2026-10-05 四次 `isDryRun=false` 记录为何"只有打包与安装目录"：
> 它们既没做任务，也无判据文件（判据落盘功能 `bde5d9b` 于当日 20:54:19 才引入，
> 而四次运行全部早于它——详见对账报告 §2.1）。
> 若当时直接执行交接命令，产出的将是**零判据的假验收记录**，比"缺判据文件"更糟。

#### 4. 修复（提交 `1462fa5`，已推送 `origin/main`）

- 真实分支**真正执行一次任务**，与干跑复用**同一套**判定；
- 判定逻辑移入 `scripts/lib/t07d-r2-04-acceptance-decision.mjs`，成为可测不变量
  （`tests/core/unit/t07d-r2-04-acceptance-decision.test.ts`，11 例）；
- **fail-closed**：零轮次必定 `failed`；卡内第五项"无其他改动"未提供扫描结果即判失败
  （不允许"漏扫"静默变成"没有其他改动"）；
- 非交互环境新增 `--permission-decision allow-once|deny`（来源写入判据文件，可审计）；
- 凭据新增 `--credential-source state`（读受保护凭据文件引用，密钥不打印/不落盘/不进判据）；
- 判据文件升到 **schema v2**：`executedRoundCount` / `isRealAcceptanceEvidence` /
  `permissionDecisionSource` / `credentialSource` / `usageObservation`。

**先红后绿**（真实退出码）：红 = `npx vitest run <新测试>` → **exit 1，11/11 失败**
（模块不存在）；绿 = 同命令 → **exit 0，11/11 通过**。
**干跑零额度复核**：`--dry-run` → **exit 0，7/7 判据**（含新增第五项）。

**门禁 `npm run check`（danger-full-access 复跑）**：`typecheck` / `lint` / `build` 全过；
测试 `2 failed | 2151 passed | 2 skipped`（2155）。两个失败均为 `tests/gui/integration/`
下的 ~30 秒用例（`gui-settings-recovery.test.ts`、`gui-verification-decision.test.ts`，
后者伴 Windows `rename` EPERM 争用）。**逐个隔离复跑：exit 0，5/5 与 4/4 全过** →
判定为**负载/超时抖动**，与本检查点改动（仅 `scripts/` + 新测试文件）无关。

> 环境说明：本会话沙箱禁止 Node 创建命名管道，`vitest` 默认 forks 池与 Vite 配置打包
> 均会 `spawn EPERM`。门禁与验收脚本因此以 `danger-full-access` 逐条授权后复跑（真实退出码已记录）。

#### 5. 真实运行取证（tarball 隔离安装 + 真实 unisound/`u2-flash`/anthropic-messages）

| 项 | 值 |
|---|---|
| 运行标识 | `2026-10-06T09-53-37.334Z` |
| 来源提交 | `1462fa5`（运行时**工作区干净**） |
| tarball | 1,093,410 字节，sha256 `8533d919…7bab`（与同日干跑**同哈希**，打包可复现） |
| 凭据 / 裁决来源 | `credentialSource = state`（`prov-unisound-1`）/ `permissionDecisionSource = explicit-flag` |
| 判据 | **5/5 通过**（`status=done`、`allowed-once`、产物存在、逐行精确、**无其他改动**） |
| 退出码 | **0** |
| 判据文件 | `.tmp/tarball-live/2026-10-06T09-53-37.334Z/acceptance-verdict.json`（schema v2，`isRealAcceptanceEvidence: true`） |

#### 6. 条款 5「usage/费用范围」：已成文（附限制）

新增 `docs/reports/T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`（书面费用范围声明）：
模型调用次数**下界 ≥2**（证据：2 条 `context-assembly` 事件；精确请求数因未落盘不可复核）、
单次调用真实 usage 下界 **`input 110` / `output 8`**（同日探针复测 `http-status 200`；
早先一次为 110/15）、时间护栏 120s/240s 与**实测 165.43 秒**、货币金额**明确不给出**
（产品侧 `costEstimate.unavailableReason = "价格表未配置…"`）。

#### 7. 本次未闭合（登记，不伪称闭合）

- **Provider usage 捕获未装配到产品运行路径**：`createJsonlProviderUsageCapture`
  （`packages/core/src/measurement/provider-usage-capture.ts`）在仓库内**只**被
  `scripts/verify-measurement-package.mjs` 与其单测引用；本次运行的隔离状态目录内不存在
  `usage/entries.json`。故条款 5 只能给"范围 + 依据"，**不是该次运行的账单级精确值**。
- **`provider-catalog.json` 两个条目的 `supportLevel` 支撑不足**：`live-provider-1` 与
  `unisound-u2-flash` 的 `verifiedAtIso` 等于那些"未做任何 Provider 工作"的运行时间。
  **用户已明确本次不修改该文件**，仅登记；重跑或降级由作者决定。
- 既有限制（未变化）：`InstructionWindowStore`、读抑制账本、`local-progress-and-cycle-guard`
  仍未装配；CLI 给出结果后进程仍滞留（既有 `it.skip`）。

#### 8. 对账结论

`docs/reports/T07D_R2_04_STATUS_RECONCILIATION_2026-10-06.md` 已从 `in_progress` 推进到
**"可判定"**：条款 1/2/3/4/6/7 有证据且本次补齐 **tarball 产品路径**证据；条款 5 已成文（附限制）。
**任务卡状态仍标 blocked，本次未擅自修改**——由作者按对账报告 §4 决定。

### 2026-10-06 — E2E-01-03 开工：查证三项阻塞 + 完成切片 S1（陈旧写入强制接入产品路径）

**授权依据**：用户指示"继续推进"并选定 E2E-01-03；对"人工并发变化"选定"先建 harness、到点由用户现场编辑"。

**只读侦察结论（三项产品路径阻塞，均有 file:line 证据）**：
1. **陈旧写入守卫未接入产品路径**：`StaleWriteGuard.guardWrite` 只被单测调用；唯一非测试引用
   （`tui/src/cli/commands.ts:2435-2450`）只是恒真能力标志位；`AgentEditIntent` **没有产品侧生产者**；
   `replaceFileContent` 原有 TOCTOU 复检的基线取自**备份那一刻**，覆盖不到"已读、未备份"窗口。
   附带：`concurrent status/decide` 两个命令**未注册到 CLI**，其状态视图为硬编码假数据。
2. **恢复检查点在生产路径从未被写入**：读侧（`recover list/show/resume`、租约、对账）已接线，
   但 `RecoveryCheckpointStore.writeCheckpoint` 调用点全在测试 → 真实项目上 `recover resume`
   只会返回 `checkpoint-not-found`。验收②需要产品侧边界检查点写入者（切片 S2）。
3. **人工/Agent 工作树拓扑未接线**：`GitWorktreeAllocator` 由 `mission-orchestrator` 的
   `gitIntegration` 选项门控，而**无任何产品 bootstrap 提供**；无人工工作树注册 API、
   无 `reconcile/` 分支、无绕过防护。
   （验收③已有可断言目标：`<state>/context-runtime/events.jsonl` 的 `context-assembly`
   + `effectiveBudgetTokens`，`context metrics --json` 可汇出；验收④可复用
   `tests/tui/unit/cli-sdk-parity.test.ts` 的比对方式。**无任何既有 E2E-01-03 产物**。）

**切片 S1 完成（本次，提交见下方记录）**：按用户选择 B+A 实现——
- 新增 `packages/core/src/orchestration/agent-edit-intent-guard.ts`：产品侧 `AgentEditIntent`
  持久化（`<state>/agent-edit-intents/<agent>.json`，用 `writeAtomicJson`/`readJsonWithBackupRecovery`，
  无需破坏性 API 白名单）+ 交给既有 `StaleWriteGuard` 比对；规则：基线**首次读取**记录、
  **再读不刷新**、**自身写入后前移**、**盲覆盖返回 baseline-missing 退回既有防护**（残余边界，显式钉住）；
- `tools/builtins.ts`：`readFile` 记录读时基线；`replaceFileContent` 写入前比对，
  不一致抛 `DomainError("stale-human-change")`（待写内容由守卫保全为 patch，人工字节不动）；
- `tools/policy-wrapper.ts` + `application/application-runtime.ts`：按状态目录构造并注入。
- **先红后绿**（真实退出码）：守卫模块 8 例 → 红（模块缺失，exit 1）→ 绿 8/8；
  工具路径 5 例 → **仅 `① 读后人工修改被拒` 失败**（说明拒绝确来自新接线）→ 绿 5/5。
- **门禁 `npm run check` exit 0 且无抖动**：289 文件 / 2176 用例通过、2 skipped。

**未闭合（登记）**：盲覆盖不受人工基线保护；验收①的真实端到端（真实 Provider + 人工现场编辑 +
同步点）属 S3；验收②需 S2；验收③④尚无 E2E-01-03 层证据。

**S1 之后的可行性核查（本轮只读，未改代码）**：
1. **S1 的守卫在安装包 CLI 路径上可达**（harness 的前提已具备，无需改工具子集）：
   `main-controller.ts:885-896` 的 `decomposePromptForScriptedRun` 给单任务
   `toolNames = registry.getFullDescriptors()`（**全部已注册工具**），
   `main-controller.ts:781/:834` 再以 `new Set(task.toolNames)` 构造 worker 端口——
   因此 `readFile` 与 `replaceFileContent` 在验收式单 prompt 运行里都已可用。
2. **S2 的检查点写入者必须在 mission 层装配**（不能在工具层就地拼装）：
   `recoveryCheckpointSchema` 要求 `sessionIdentifier`/`missionIdentifier`/`taskChainIdentifier`、
   `agentIdentities`、`taskNodes`、`toolCalls`、`providerRequests`、`feedbackCursor`、
   `permissionRecovery`、`workingSetFileCountsByAgent`、`taskChainCumulativeSourceCount`、
   `gateStates`，以及 `contentHash` + `previousCheckpointHash` 哈希链——
   工具层没有这些状态。故 S2 应实现"**mission 级检查点记录器**（负责装配与哈希链）+
   工具调用边界作为触发点"，而不是在 `ScopeGatedToolPort` 内直接写检查点。
3. **下一步切片改为 S1b（离线、不需额度、不需用户）**：用**进程内假 Provider**（可确定性地在
   "已读、未写"窗口内插入人工编辑并回放第二次工具调用）经**tarball 隔离安装的 CLI** 复现
   验收①，把 S1 的"工具层已强制"升级为"**安装包产品路径已强制**"；S3 再把同一 harness
   指向真实 Provider 并由用户现场编辑。

**S1b 完成（本轮）**：新增 `scripts/verify-e2e01-03-concurrency-harness.mjs`
（npm 别名 `verify:e2e01-03-harness`）——自带进程内 OpenAI 兼容假 Provider，
**确定性地**把人工编辑插在"Agent 已读、尚未写"窗口（请求 #2 回放 `replaceFileContent` **之前**
先落盘人工内容），经 **tarball 隔离安装的 CLI** 运行并产出 `acceptance-verdict.json`。

**真实退出码 0，6/6 判据通过**（来源提交 `402697c` 的脏工作区，tarball sha256 `dfac7205…c7fd7`）：
① 两步（read→replace）确实执行；② 人工修改落在窗口内；**③ 陈旧写入被拒绝并回填给 Provider**
（证据原文：`错误(stale-human-change): replaceFileContent 拒绝陈旧写入：目标内容指纹变化
（stale-human-change）：基线 sha256:e2345d42… ≠ 当前 sha256:3c9d6a28…`）；
④ 人工修改逐字节保留；⑤ Agent 待写内容未落盘；⑥ 未结案为 done（`status=blocked`）。

> ⚠️ **本轮抓到一个假通过并已修正（值得记住）**：首轮用 `--mode assist` 跑时，判据④"人工修改被保留"
> **表面通过**，但诊断落盘的原始证据显示回填文本是
> `错误(tool-permission-denied): 权限策略拒绝工具调用: replaceFileContent`——
> 即写入在**权限门禁**就被拒了，**根本没走到陈旧写入守卫**，"人工修改被保留"是因为**压根没写**。
> 改用 `--mode devolve`（E2E-01-02 切片 5 也用该模式做写操作）后才真正打到守卫。
> 教训：这类判据必须同时断言"**拒绝来源**"，否则"没写"会被误读成"守卫生效"。
> harness 因此固化了 `provider-requests.jsonl` / `cli-stdout.txt` / `cli-stderr.txt` 原始证据落盘。

**S1b 扩展（本轮）：判据 ⑦⑧ 覆盖验收③④，并登记一处产品状态口径分歧**

- **⑦ 验收③"上下文预算/回访实际执行"→ 已有可复核证据**：断言运行目录内
  `project/.astarray/context-runtime/events.jsonl` 存在 `context-assembly` 事件且
  `effectiveBudgetTokens` 为真实正数、`budgetPolicyRevision ≥ 1`、`estimatedInjectedTokenCount` 存在。
  实测：事件数=1、`effectiveBudgetTokens=4096`、`budgetPolicyRevision=1`。
- **⑧ 验收④"CLI/SDK 最终状态一致"→ 满足**（口径同为一件事）：CLI 持久化视图
  `status <mission> --json` 与 SDK `queryMission(...)` 同值，实测 `status=cancelled` / `sdk=cancelled`。
- **⑨ 登记项（不门控）**：`run --json` 的 `status` 与持久化 mission 状态**不同值**——
  实测 `run=blocked`、持久化 `mission=cancelled`、任务节点 `failed`。
  这是 `run` 命令"等待结果"与"mission 终态"的**语义口径分歧**，属独立问题，
  已写入判据文件 `registeredFindings`，**未**混同为验收④失败；是否修正由作者裁定。
- **真实退出码 0，8/8 判据通过**（判据文件含 `registeredFindings`）。
  说明：⑦⑧ 是**证据断言**而非新实现（二者早已接线），因此**不存在"红"**——
  它们首次运行即通过，这里如实标注，不冒充红→绿。

**剩余**：验收②（工具调用边界中断后恢复无重复副作用）需 S2 的 mission 级检查点记录器；
验收①③④ 的**真实验收**（真实 Provider + 用户现场编辑）属 S3——当前判据文件明确标
`isFakeProvider: true` / `isRealAcceptanceEvidence: false`。

**S2 设计核查（本轮只读，未改代码）——检查点哈希链的真实语义（非显然，写错会直接抛错）**：
1. `RecoveryCheckpointStore.computeCheckpointHash` **是 private**，且对**落盘后的整份 JSON**
   （含 `contentHash` 字段自身）重算：`sha256(canonical(JSON, null, 2) + "\n")`。
   因此 `contentHash` 是**自指字段**——schema 只校验其格式 `^sha256:[a-f0-9]{64}$`，
   **校验侧不会**把它与重算值比对；**链键一律用存储层重算值**。
   写入方只需给出格式合法的 `contentHash`（建议按"去掉 `contentHash` 后的规范 JSON"计算，
   保持确定性且可解释），不要指望它被校验。
2. `writeCheckpoint` 的链校验（:82-93）要求：当 `previousCheckpointHash !== null` 时，它必须等于
   `selectLatestTrustedCheckpoint().checkpointHash`（**存储层重算值**，不是文件里那个字段）。
   故记录器必须用上一次 `writeCheckpoint` **返回值里的 `checkpointHash`** 作为下一次的
   `previousCheckpointHash`；首次写入用 `null`。
3. `isCheckpointChainValid`（:180-194）**刻意宽松**：`previousCheckpointHash !== null` 时，
   若前序文件不存在（被清理）即视为可信起点，其余情况直接 `return true`。
   ⇒ 不能把"链校验通过"当作"历史完整"的证据，恢复结论必须依赖对账分类而非链校验。
4. 写入方**必须在 mission 层**提供 `sessionIdentifier`/`missionIdentifier`/`taskChainIdentifier`、
   `agentIdentities`、`taskNodes`、`providerRequests`、`feedbackCursor`、`permissionRecovery`、
   `workingSetFileCountsByAgent`、`taskChainCumulativeSourceCount`、`gateStates`——
   这些在工具层都拿不到（已在上文第 2 点确认）。
5. **接线位置已确定且不需要改 `buildWorkerToolPort` 的签名**：`main-controller.ts:781` 的
   `toolPortFactory` 闭包内**已经能拿到 `missionId`**（同处 :792/:795 就在用）。
   因此 S2 的做法是在 `MainControllerOptions` 增加一个
   `buildRecoveryCheckpointingToolPort({missionId, task, agentInstanceId, innerToolPort})` 钩子，
   由 `application-runtime`（掌握状态目录与 mission 快照）实现并把装饰器**套在最外层**
   （这样范围门禁的拒绝也能被记录）。

**S2b 尝试与**回退**（本轮，**未提交**，代码已备份）**：
- **做了什么**：在 `MainControllerOptions` 增 `buildRecoveryCheckpointingToolPort` 钩子，
  两处 `toolPortFactory`（assist/devolve）统一改走新私有方法 `buildWorkerToolPortWithRecoveryCheckpointing`，
  并在 `application-runtime` 实现该钩子（`RecoveryCheckpointStore` + 按
  `missionId::agentInstanceId` 复用 `RecoveryCheckpointRecorder` + 保守 `snapshotProvider`）。
- **功能上确实通了**：harness 新增判据⑩ 实测 **检查点数=4**，
  `readFile=confirmed-success`、`replaceFileContent=result-unknown`（`isIdempotent=false`）——
  正是恢复分类服务判为 `blocked-uncertain-side-effect`（禁止自动二次执行）的输入。
- **但它造成真实回归**：`tests/tui/integration/authorization-retry-closure.test.ts`
  「一次 allow-once 之后工具必须真正执行并产出文件，任务 done」——
  **带 S2b：失败（30.7s，`status=blocked`）；stash 掉 S2b 并重建后：通过（689ms，exit 0）**。
  因此**本轮不提交该接线**，已 `git checkout --` 回退三处改动（备份在
  `.tmp/session-r2-04/s2b-reverted/`：`main-controller.ts`、`application-runtime.ts`、`harness.mjs`）。
- **下一轮必须先判定的两个竞争假设**（不得凭猜修改）：
  (a) **每次工具调用的持久化写**（临时文件 + fsync + `.bak` 复制 + rename + journal append）
      带来的延迟把该用例的等待窗口顶爆（30.7s vs 0.689s 的 40 倍差距更支持"等待超时"而非逻辑错误）；
  (b) 首次被权限阻断的尝试会被记成非幂等 `result-unknown`，进而影响完成/恢复路径。
  判定手段：对每次检查点写入打点计时并统计工具调用次数；或先把执行后的状态写入改异步再复跑对照。
- **教训（重要，避免再次误判）**：**经 tarball 安装的 harness 验证的是 `dist/`**，
  改完 `packages/core/src` 后**必须先 `npm run build`** 再跑 harness，否则会拿旧构建得出假结论——
  本轮最初得到的"检查点数=0"就是 `dist` 陈旧造成的**假阴性**（源码其实是对的）。
  凡新增/修改此类 harness 断言，先构建再跑。

**S2a 实施进度（上一轮，已提交 `dcc446b`）**：
- **S2a 完成**：新增 `orchestration/recovery-checkpoint-recorder.ts`——
  `RecoveryCheckpointRecorder`（检查点装配 + 哈希链 + 工具调用状态合并 + 写链串行化）
  与 `RecoveryCheckpointingToolPort`（工具边界装饰器）；
  并在 `RecoveryCheckpointStore` 上新增公开的 `computeContentHashFor`（复用同一套规范化，
  避免第二份哈希实现漂移）。
- 状态规则（与已接线的分类服务对齐，已联测）：成功 → `confirmed-success`；
  错误结果且 `sideEffectStatus !== "none"` → `result-unknown`；错误结果且确定为 `none` → `confirmed-failure`；
  抛异常且该工具有可能改状态 → `result-unknown`（保守）。`started` 在执行**前**落盘，
  且写失败即 **fail-closed**（此时尚无副作用）。
- **先红后绿（真实退出码）**：红 = 移走新模块后 `Cannot find module ... recovery-checkpoint-recorder.js`，exit 1；
  绿 = 9/9 通过、exit 0。含与 `RecoveryClassificationService` 的联测：
  非幂等 `confirmed-success` → `reuse-confirmed-result`（**不重复执行**）；
  非幂等 `result-unknown` → `blocked-uncertain-side-effect` 且 `hasBlockingItems=true`；
  幂等 `started` → 不制造阻塞项。
- 门禁：`typecheck` exit 0、`lint` exit 0、`npm run check` **exit 0 且无抖动**
  （290 文件 / 2185 用例通过、2 skipped）。
- ⚠️ **尚未接线（S2b，下一步）**：装饰器还没接到 `MainController` 的工具端口上——
  即"运行期间真的写检查点"这一环仍未打通（计划见上文第 5 点的
  `buildRecoveryCheckpointingToolPort` 钩子）。**不得据此宣称验收②已达成。**


**授权依据**：用户指示"继续下一步；两条目重跑不降级；完成后才按实际情况推进任务卡，
必须逐项核对且有充分证据才能改任务卡状态"。据此先把 usage 接线做完并重跑取证，
再逐项核对后改卡（未凭说明文字改卡）。

#### 1. Provider 真实 usage 已接入产品运行路径（提交 `b8905a4` / `ae318f4` / `62b0d8e`）

接线前的实况（已查证）：`usage-updated` 规范事件**只有声明、没有生产者与消费者**；
两个产品运行时各自解析 SSE 并**丢弃**厂商 usage；`UsageLedgerStore` 在生产路径上**从未被写入**。

- 新增窄端口 `measurement/provider-request-usage-observation.ts`（含显式 NOOP 与请求哈希）；
- 新增 `orchestration/provider-usage-ledger-observer.ts`（映射为 `UsageLedgerEntry`；
  缺 usage 记 `null` + `missingUsageReason`，**不补 0**；观测失败不阻塞业务）；
- `AnthropicMessagesRuntime` 解析 `message_start.message.usage` 与 `message_delta.usage`；
- `OpenAiCompatibleRuntime` 请求 `stream_options.include_usage` 并解析收尾 chunk 的 `usage`；
- `AstarrayApplicationFacade.create`（CLI/TUI/SDK 共用装配入口）按状态目录构造账目观测者；
- 注册表两侧透传观测端口。

**由真实运行（不是推理）发现并修复的两个缺陷**：
1. 覆盖规则把 input 钉成 0（`message_delta` 是累计终值却未被覆盖）→ `ae318f4`；
2. 厂商显式发 `"usage": null`，只判 `!== undefined` → `Cannot read properties of null
   (reading 'prompt_tokens')`，真实任务 `status=blocked`、无产物、exit 1 → `62b0d8e`。

两者均先补行为反例再修复。新增/修改用例：`tests/core/integration/provider-request-usage-capture.test.ts`（6 例）、
`tests/core/integration/openai-compatible-usage-capture.test.ts`（4 例），**10/10 通过**。

#### 2. 三次最终真实验收（同一提交 `62b0d8e`、同一 tarball、工作区干净）

| 运行标识（UTC） | 厂商 / 模型 / 协议 | 请求数 | input / output | 耗时 | 判据 |
|---|---|---|---|---|---|
| `2026-10-06T17-55-24.904Z` | unisound / `u2-flash` / anthropic-messages | 7 | 13,315 / 3,112 | 146.84s | **5/5，exit 0** |
| `2026-10-06T18-00-35.917Z` | unisound / `u2-flash` / openai-compatible | 4 | 7,977 / 1,512 | 147.51s | **5/5，exit 0** |
| `2026-10-06T18-05-44.693Z` | stepfun / `step-3.7-flash` / openai-compatible | 6 | 11,819 / 1,827 | 132.15s | **5/5，exit 0** |

tarball sha256 `af66e55b…a244`（1,102,785 字节）；逐请求 token 来自运行目录内
`.astarray/usage/entries.json` 并经 `acceptance-verdict.json.usageObservation` 复核。

#### 3. 两个 catalog 条目按"重跑不降级"重新取证

`provider-catalog.json` 的 `verifiedAtIso` 已刷新为上述真实运行时间
（`live-provider-1` → `18:05:44.693Z`；`unisound-u2-flash` → `18:00:35.917Z`）；
`supportLevel` 保持 `product-path-verified`，**未降级**。

#### 4. 卡状态（逐项核对后置 done）

卡内 `验收` 的两半分别有直接证据：**读任务**（`verify:u2-flash-continuous-reception` 本会话
exit 0 / 8/8，真实 `u2-flash` 上两条只读 `readFile` 任务终态均 `done`，经 `AstarrayApplicationFacade`
即与 CLI 同一产品入口）与**小型受控改动**（三次 tarball 隔离安装真实验收各 5/5）。

`docs/tasks/T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md`：`T07D-R2-04` 由 `blocked` 置 **`done`**，
整卡置 `done`，并新增 §「T07D-R2-04 验收记录」逐项列出证据
（读任务/受控改动、模型协议日期版本、usage 费用范围、同一配置、限制）。

#### 5. 仍未闭合（登记，不伪称闭合）

- 账目 `taskIdentifier` 恒为 `null`；`providerProfileId` 取**运行时标识**而非 catalog profile id；
- 仅 `anthropic-messages` 与 `openai-compatible` 接入 usage，其余适配器（responses/gemini/bedrock/azure）未采集；
- `context-runtime-metrics.providerCacheUsage` 仍无生产者；
- 既有限制：`InstructionWindowStore`、读抑制账本、`local-progress-and-cycle-guard` 未装配；
  CLI 给出结果后进程仍滞留。

#### 6. 环境说明（避免新会话误判）

本会话沙箱禁止 Node 创建命名管道（`spawn EPERM`），因此 `npm run check`、验收脚本与 `git push`
均以 `danger-full-access` 逐条授权后执行；每次均记录**真实退出码**。
历次门禁失败文件**逐个隔离复跑全部 exit 0**，判定为负载/超时抖动
（`e2e01-vertical-rework`、`cli-commands`、`provider-tool-loop` 在既有已知抖动清单内）。

## 历史设计与验收记录

> 2026-08-12 设计增补：反馈消息契约新增必填结构化 `source`。用户、Agent、系统来源均可追踪；转发保留原始来源。T00 契约、Schema、测试和架构文档已同步更新。
> 2026-08-12 设计增补：Agent 来源进一步收紧为具体且不可复用的 `agentInstanceId`。新增 T05A：每个次级/三级 Agent 拥有独立工作存档，上级发布任务或重新调用前可选择具体条目附加，默认不注入。
> 2026-08-12 设计增补：新增 T06A 工具内破坏性变更备份层。文件/目录删除、文字删除、替换、截断和覆盖必须先由工具自动保存完整 pre-image；备份数据、路径与恢复能力不经过模型端。
> 2026-08-12 设计增补：T06A 增加 `backupVault` 读取/恢复工具和独立 `deleteBackup` 特权入口。协同模式删除会警告用户并暂停 Agent，逐次授权；放权模式不提醒但保留 HIGH 审计记录；采用 quarantine 两阶段删除防止递归与死锁。模式中文名统一为思索/协同/放权。
> 2026-08-13 设计增补：新增 T05B。涉及 Git 写入的多 Agent 任务由次级 Agent 负责分支/worktree 分流、三级 Agent 提交审查、集成测试和受控合并；三级 Agent 只能提交自己的隔离分支。Git 历史不替代工具内自动备份，破坏性 Git 操作必须先创建受保护恢复点。
> 2026-08-13 设计增补：新增 T05C。每个调度 Agent 在自己的记忆存档域维护独立待办任务偏序集，发布者可指定前驱/后继；用户任务默认优先级层级 0，Agent/system/工具任务只能层级 1 或以下。次级 Agent 可把一条链打包给三级 Agent，并提供无副作用状态查询工具。
> 2026-08-13 设计增补：新增 T06B。Ponder 改为本地只读白名单，可查看普通项目文件、检索文本和查询只读状态；写入、进程、网络、凭据和备份工具由本地策略与 OS 边界硬禁用，敏感操作分类不依赖云端或 AI。
> 2026-08-13 设计增补：新增 T07A。模型完成时必须返回版本化明确完成控制事件；本地验收通过后才结案。缺失/无效标识或输出早停时，从原子检查点最多自动续跑 3 次，并防止并行请求与重复非幂等副作用。
> 2026-08-13 设计增补：新增 T06C。`.env`/`.env.*`、私钥、凭据库、能力令牌及本地 DLP 命中内容在 Ponder/Assist/Devolve 三种模式和全部工具通道中禁止模型读取，无授权例外。
> 2026-08-13 设计增补：新增 T07B。同一具体 Agent/任务短时间重复读取未变化且已覆盖资源时返回读取回执；增加资源/工具环、Agent 回派乒乓、搜索换词和无进展重试的本地有界守卫。
> 2026-08-13 设计增补：新增 T06D。高严谨性任务由本地规则强制调用事实验证工具；证据按“资料搜索 > 本地实验 > 纯推理”组织，只作为用户判断辅助，不自动判定合格。
> 2026-08-13 设计增补：新增 T06E。Assist 的代码库、依赖、运行时、插件、工具链、系统包等任意安装尝试采用两阶段门禁：先询问用户是否已有可用资源；用户确认没有后，只有独立设置开关开启才能提出精确的逐次安装授权，开关和会话授权均不能代替本次用户确认。
> 2026-08-13 设计增补：新增 T06F。Devolve 对全部可配置权限提供逐项 deny/ask/allow 设置并默认 allow；Assist 使用独立默认矩阵，Ponder 不可调整。用户可创建、命名和完全配置不设数量上限的自定义权限模式；底层安全不变量不受模式设置影响。
> 2026-08-13 设计增补：新增 T06G。主 Agent 在所有模式下永久只读；权限组和当前会话临时提升只作用于次级 Agent（临时提升默认覆盖当前会话全部次级 Agent，也可限定具体个体），且构成其向三级 Agent 分发权限的严格上限。会话关闭时可导出当前公开有效权限配置，导出不携带会话授权能力。
> 2026-08-13 设计增补：新增 T08A。默认工作流由主 Agent 持续交流/评估并经本地控制面向次级偏序集插入任务，次级 Agent 持续调度并负责三级生命周期与本地/远端项目集成，三级 Agent 一次激活只执行一条任务链。后台汇报只入主 Agent 报告索引，后续用户交流按需读取。
> 2026-08-13 记忆隔离增补：主、次级、三级每个具体 Agent 均以不可复用 `agentInstanceId` 独占记忆、工作存档、上下文、缓存、读取回执和消息视图；禁止角色级或同级共享。跨 Agent 仅经本地控制器传递带来源和哈希、只对当前任务有效的不可变附件。
> 2026-08-14 设计增补：新增 T08B。次级/三级 Agent 首次接收工具组时获得完整公开用法，同 revision 后续只收标准回访提醒；已分配工具直接按单工具回复，缺失能力逐级上报，三级默认先报所属次级。各层实例无产品数量配额；直属上级经授权可把直属低一级 Agent 的限定沟通句柄转交具体同级 Agent，但不转移任务、记忆、工具、Git 或权限。
> 2026-08-16 设计增补：新增 T08C。主 Agent 保持单会话唯一连续用户对话者；小型明确任务可在主会话中经用户确认直投具体次级 Agent，但结果仍由次级压缩摘要、主 Agent 面向用户解释。次级通过侦察三级 Agent 获取有界项目摘要，分别任命实现/测试/验收个体；三级可把严格子链委派给四级，项目级 Git 集成仍只属于次级。
> 2026-08-16 设计增补：新增 T07C。每个主/次级/三级/四级 Agent 拥有独立模型分配；用户可按用途配置任意长度模型/Provider 允许列表，并创建任意数量的办公、前端、编码、debug、测试、验收、侦察、绘图和自定义任务类型预设。切换只在安全检查点和允许列表内发生。
> 2026-08-17 设计增补：新增 T08D。“工匠”是阶段性显现的三级 Agent预设，只用已有已授权基础工具定制可复用工作流。会话开始时不向次级注入说明；活跃时长、已验收任务、里程碑、记忆索引规模或重复工作指纹达到本地策略后才披露。用户可配置无限阶段模板及给次级自动安排的提示词，自动节点只能位于优先级层级 1 或以下。
> 2026-08-18 设计增补：新增 T07D。T07C 只负责模型/Provider 策略；T07D 单独负责主流 Provider 原生协议、真正增量流、CLI/TUI 产品装配、稳定 Public SDK，以及从 npm tarball 完成项目分析和小型编码/测试/验收的独立工作助手纵向闭环。顺序更新为 T08C → T08D → T07C → T07D → T12。
> 2026-08-19 设计增补：新增 T05D、T07E、T12A。T05D 保护人工与 Agent并行编码并由次级协调冲突合并；T07E 对每个具体 Agent默认执行10个项目内容文件工作集预算并允许受控拆分/扩展；T12A 负责中断后统一检查点、只读外部状态对账和未知副作用阻塞。有效偏序为 T08C 后分别推进 T08D→T07C、T05D、T07E，三路通过后执行 T07D→T12A→T12。
> 2026-09-09 设计增补：新增 T09A。历史上下文拆分为版本化全局决策和每 Agent 独占的局部上下文偏序图；已验收闭包生成关闭胶囊并退出普通提示词，按结构化请求分级回访。Assist 默认阻塞人工验收但可设置为延迟核验，Devolve 默认非阻塞并自动建立层级 1+ 的人工核验任务。任务实现后必须回归 T12A/T12 的恢复与安全路径。
> 2026-09-09 进度：T09A-01 完成（ADR-0031 冻结；全局记录/预算/延后片段/上下文图/关闭胶囊/回访与人工验收策略 schema，12 例红灯反例转绿；`npm run check` exit 0，1212 测试全绿）。T09A-02 完成：局部上下文图存储 `LocalContextGraphStore`（DAG/未知锚点/自环/环拒绝，required 计数与关闭资格、增量重开、expected revision CAS、原子写 + .bak 恢复、跨 Agent fail-closed），12 例图测试与 92 例相关进程内套件全绿；沙箱审批不可用时改用 `--configLoader runner` + 无依赖配置 + `--pool=threads` 完成无审批验证；全量 build/spawn 类门禁待审批补跑。T09A-03 完成：`GlobalDecisionStore`（只追加记录 + 状态事件折叠、同 scope 同哈希幂等去重、冲突标记 pending-human-review、supersedes 不覆盖历史、损坏 fail-closed）与 `selectGlobalDecisionsForTask`/`deferUnselectedGlobalDecisions`（仅显式关系四类分级、只注入 active、预算内完整注入不截断、超限写按 Agent/mission 隔离的延后片段）；10 例新测试 + 70 例相关套件回归全绿。T09A-04 完成：`HumanVerificationPolicyStore`（Assist 默认 block / Devolve 默认 continue 的单调 revision CAS 设置，Ponder 禁止切换，自定义模式须显式默认）与 `HumanVerificationController`（单次等待 3 小时封顶、超时保持等待绝不自动通过、用户签字绑定图 revision、延迟核验任务层级 ≤1 且按 Agent 隔离、事后否决重开节点并把相关全局决策转 disputed、返回层级 1 返修提案、不做破坏性回滚）；9 例新测试全绿。T09A-05 完成：`ContextClosureCapsuleStore`（不可变关闭胶囊 + 内容哈希校验 + 个体隔离）与 `buildPromptActiveFrontier`（已关闭历史只计数不注入）、`ContextRecallController`（固定四级回访 索引→胶囊→证据→有界片段；未变化 revision 冷却回执；任务级回访上限活锁保护；敏感内容 fail-closed 丢弃整个结果；预算不足停在低级别不截断）；9 例新测试 + 52 例 T09A 回归全绿。T09A-06 完成：`ContextTierCache`（全局决策块/活跃前沿/关闭胶囊/回访结果四层键、写与授权与时间敏感与失败与任务结论 bypass、单块与单节点与单 Agent 精确失效、stale-reject 统计）与 `computeContextLifecycleMetrics`（事件集纯函数复算：可复用 token 比率、关闭节省率、重复/有效回访率、过早关闭率、全局提升与预算淘汰率、延后片段命中率、错误注入计数、延迟验收否决率与下游影响；用户新需求/依赖真实变化不计入过早关闭）；7 例新测试 + 59 例 T09A 回归全绿。T09A-07 完成：`buildContextLifecycleStatusView`（已验收/待人工追认分组与明确文案、配置与实际上限及缩减原因、其他 Agent 胶囊过滤、`includesRawHistory=false` 脱敏标记）与 Headless `context status --agent --graph [--json]`（TUI/CLI/GUI 共用 DTO）；5 例新测试全绿。T09A-08 完成：全量 `npm run check` exit 0（134 文件 / 1264 测试，含 build 与 spawn 类套件）；T12A 恢复单元回归 34/34；`npm pack`（171 文件）+ `verify-package` + `smoke-install`（隔离安装/CLI/全局 shim/feedback-entry）全通过；覆盖率实测全局分支 83.23%（3528/4239），距 85% 门禁约 76 分支，移交 AR-07 收尾。T09A 卡状态 done。AR-07 覆盖率冲刺完成：全局分支 **85.06%（3605/4239）**，`npm run test:coverage` **exit 0**（lines 93.00% / funcs 90.02%）；`npm run check` **exit 0（135 文件 / 1301 测试）**。剩余 AR-07 项：关键安全模块单模块 95% 专项、跨平台矩阵、dev 工具链 audit 项、recover CLI 深层接线，移交 T13/T14 最终文档单列。
>
> 2026-08-26 进度更新：T12A-01~07 完成后开始 T12 综合安全加固（新版任务卡 `docs/tasks/T12_SECURITY_HARDENING_TASK_CARD.md`）。T12-01 跨进程 mission 活动租约完成：`MissionLeaseStore`（排他创建 + 心跳续约 + 过期显式接管 + revision CAS + 损坏 fail-closed）；先红灯 11 测试后实现，`npm run check` exit 0（1172 测试全绿）。T12-02 编排会话租约接入完成：运行会话申请/半周期续约/终局释放、同 mission 跨进程 start 拒绝 mission-locked、cancel/resume CLI 跨进程门禁；先红灯 3 测试后实现，`npm run check` exit 0（1176 测试全绿）。T12-03 反馈孤儿收口修复完成：发现并修复监督器从未发送心跳（正常长会话 2× 超时后子进程误判失联自退）——`sendHeartbeat` + 半周期心跳循环；子进程断线自退/心跳看门狗与 TUI SIGINT/SIGTERM → shutdown 收口构成双保险；先红灯 1 测试后实现，`npm run check` exit 0（1177 测试全绿）。T12-04 只读状态与 doctor 一致性完成：`MissionManager.probeMissionDirectory`（损坏容错探针）、status --json 列表新增 `missionViews`（损坏/租约标注，兼容旧 `missions` 契约）、doctor 新增状态目录一致性扫描（损坏计数 + 活动/过期租约计数，损坏即 health failed）；先红灯/直接测试后实现，`npm run check` exit 0（1183 测试全绿）。T12-05 破坏性调用盘点与静态架构门禁完成：新增 `tests/architecture/destructive-file-api-guard.test.ts`（扫描 packages/core|tui/src，21 个带逐项理由的白名单模块 + 每文件最小令牌集，违规即失败；扫描器自带捕获单测）；Git 破坏性操作恢复点由 git-recovery-point/git-coordinator-branches 集成套件动态复核（随 check 全绿）。`npm run check` exit 0（1185 测试全绿）。T12-06 综合终验完成：`npm run check` exit 0（125 文件 / 1185 测试全绿）；`npm pack`（159 文件）+ verify-package + smoke-install（隔离安装/CLI/全局 shim/feedback-entry）全通过；npm audit（--audit-level=high exit 0，4 项 dev 工具链低/中危）；覆盖率实测全局分支 83.07%（<85%）如实记录为 AR-07 收尾必补项。T12 卡状态 `done`，剩余风险见卡 §6 并移交 AR-07/T14。
>
> 2026-09-10 AR-07 收尾：全局分支覆盖率 **85.06%**、`npm run test:coverage` exit 0；`npm run check` exit 0（135 文件 / 1301 测试）；`npm pack`（171 文件）+ verify-package + smoke-install 全通过；T09A 全卡 done。T12A/T12 恢复与安全回归（34/34 恢复单元 + 故障注入）通过，T12/T12A/T13/T14 恢复为 `done`。未竟项如实单列：关键安全模块单模块 95% 专项、Linux/macOS 跨平台矩阵（B6R-12）、dev 工具链 audit 修复、`recover` CLI 深层接线。其余 T00~T11 任务保留 `re-verifying`，待其各自 AR 复验项完成后再恢复。
>
> 2026-09-10 AR-07 关键模块分支覆盖率专项收口 + 完整门禁复跑：新增 10 个 AR-07 测试文件（属性、并发、故障注入、安全反例、TUI 交互；全量 1301 → 1383 测试），AR-07 §1 的 22 个关键安全模块分支覆盖率**全部 ≥95%**（12 个 100%；process-supervisor 以 mock fork/ForkFeedbackClient 达 96.4%、entrypoint 95.4%、backup-vault 96.4%）。真实环境复跑全部通过：`npm run check` exit 0（145 文件 / 1383 测试，typecheck+lint+build+test）、`npm run test:coverage` exit 0（**分支 87.45%**，较 85.06% 提升；语句 94.14% / 函数 91.59% / 行 94.21%）、`npm pack` 171 文件 + verify-package + smoke-install 全部 exit 0；`git push origin main` 成功（4350261..64626ea）。51 项最终安全验收矩阵见 `docs/tasks/AR07_FINAL_ACCEPTANCE.md` §9（逐行复核 **50 ✅ / 1 ⚠**：第 7 项仅剩非 win32 平台归一化分支）；未本地验证项（真实 Provider、Node 20、Linux/macOS 跨平台矩阵）单列 §5。T00~T11 的 `re-verifying` 待各自 AR 复验项确认后恢复 done。
>
> 2026-09-10 INT-00-03 状态与依赖纠偏：按 `docs/reports/INT00_STATUS_RECONCILIATION.md`，历史 `T07D`（`T07D-06/07/08`）、`T09A`、`T12A` 的 `done` 仅代表模块/适配器与“可导入”级证据，产品接线未通过；`T09A`/`T12A` 由 `done` 改为 `re-verifying`，`T07D` 保留 `re-verifying` 并标注缺口。返修映射：`T07D-08 → T07D-R1-01..04`、`T07D-06/07 → T07D-R2-01..04 + E2E-01`、`T09A → T09A-R1-01..04`、`T12A → T12A-R1-01..04`。GUI 旧边 `B6R-10 → GUI-01 → T08B` 作废，改为 `T07D-R1 → GUI-01-R → WB-00`（无环）。历史测试、覆盖率与 tarball 证据全部保留。
>
> 2026-08-12 审计整改：外部验收发现 7 项阻断性问题，全部已修复并回归（详见"审计整改记录"）。修复涉及 S1 doctor 数据丢失、S2 反馈入池校验、S3 备份事务闭环、S4 授权绑定、S5 交互授权通道、S6 存档 provenance、S7 config 备份保护；另完成覆盖率与测试基建改善（S8/S9）。

## 任务总览

> ⚠️ 重新验收中（AR-00 起，依据 `AUDIT_REMEDIATION_TASKS.md`）：以下任务状态不再视为最终通过。
> 基线证据见 `.tmp/ar00-baseline-evidence.md`；每个任务须在对应 AR 主任务完成并动态复验后才恢复为 done。

| 任务 | 内容 | 状态 | 批次 | 备注 |
|---|---|---|---|---|
| T00 | 架构定稿与契约 | re-verifying | 1 | AR-00 重新验收中 |
| T01 | npm 与 TypeScript 工程骨架 | re-verifying | 1 | AR-00 重新验收中 |
| T02 | 模式状态机与权限策略 | re-verifying | 2 | AR-00 重新验收中 |
| T03 | 原子任务链持久化 | re-verifying | 2 | AR-00 重新验收中 |
| T04 | 独立反馈进程 | re-verifying | 3 | AR-00 重新验收中（AR-03 认证） |
| T05 | DAG 调度器 | re-verifying | 4 | AR-00 重新验收中 |
| T05B | 次级 Agent Git 分流、审查与合并 | re-verifying | 4D | 2026-08-13 完成；Batch 4D 检查点（491 测试全绿）；待 AR-04/AR-06 复验 |
| T05C | Agent 待办偏序集、任务包与状态工具 | re-verifying | 4E | 2026-08-13 完成；Batch 4E 检查点（471 测试全绿）；待 AR-04/AR-06I/AR-07 复验 |
| T05D | 人工与 Agent 并行编码、冲突协调及受控合并 | re-verifying | pre-T07D | T05D-01~06 全部完成（1063 测试全绿；dist 可达 + smoke-install 通过） |
| T06 | 工具注册表与最小权限 | re-verifying | 4 | AR-00 重新验收中（AR-01 受保护存储） |
| T06A | 工具内破坏性变更备份层 | re-verifying | 4C | AR-00 重新验收中（AR-01/AR-05/AR-06） |
| T06B | Ponder 本地只读边界与敏感操作分类 | re-verifying | 4F | 2026-08-13 完成；Batch 4F 检查点（510 测试全绿）；待 AR 复验 |
| T06C | 全模式本地敏感内容禁读 | re-verifying | 4G | 2026-08-13 完成；Batch 4G 检查点（524 测试全绿）；待 AR 复验 |
| T06D | 高严谨性事实验证工具 | re-verifying | 4I | 2026-08-13 完成；Batch 4I 检查点（562 测试全绿）；待 AR 复验 |
| T06E | Assist 安装前置询问、独立开关与逐次授权 | re-verifying | 6A | B6R-01/02 已返修完成；待终验（跨平台矩阵） |
| T06F | 可配置权限组与无限命名自定义模式 | re-verifying | 6B | B6R-03/04 已返修完成；待终验（跨平台矩阵） |
| T06G | 主 Agent 永久只读、次级权限上限与会话临时提升 | re-verifying | 6C | B6R-05/06 已返修完成；待终验（跨平台矩阵） |
| T07 | Agent Runtime | re-verifying | 4 | AR-00 重新验收中 |
| T07A | 明确完成协议与早停恢复 | re-verifying | 4J | 2026-08-13 完成；Batch 4J 检查点（583 测试全绿）；待 AR 复验 |
| T07B | 反自指读取与通用活锁守卫 | re-verifying | 4H | 2026-08-13 完成；Batch 4H 检查点（539 测试全绿）；待 AR 复验 |
| T07C | Agent 独立模型/Provider 策略与任务类型预设 | re-verifying | 6H | T07C-01~06 全部完成（957 测试全绿；dist 可达 + smoke-install 通过）；T07D 可开始 |
| T07D | 多 Provider 生产运行时与独立 Agent 工作助手 | re-verifying（INT-00 纠偏：SDK 仅“可导入”、Provider 仍 mock-only，产品接线缺口移交 `T07D-R1`/`T07D-R2`/`E2E-01`） | 6I | T07D-00~08 全部完成（1117 测试全绿；SDK exports 隔离导入验证 + smoke-install 通过） |
| T07E | Agent 工作集与默认10文件读取预算 | re-verifying | pre-T07D | T07E-01~06 全部完成（1106 测试全绿；dist 可达 + smoke-install 通过） |
| T08 | 三级 Agent 编排 | re-verifying | 5 | AR-04 复验：T05B→T08 Git 编排接入完成（Batch 5 增补检查点），待 AR-04 全项复验 |
| T08A | 默认控制流、个体记忆隔离与三级 Agent 生命周期 | re-verifying | 6D | B6R-07/08/09 已返修完成；待终验（跨平台矩阵） |
| T08B | 工具说明回访、无产品数量配额与受权通信转交 | re-verifying | 6E | 2026-08-13 完成；Batch 6E 检查点（665 测试全绿）；待 AR 复验 |
| T08C | 主对话独占、次级直投、项目侦察/验收与四级委派 | re-verifying | 6F | T08C-01~07 全部完成（858 测试全绿；dist 可达 + smoke-install 通过）；T08D 可开始 |
| T08D | 阶段性“工匠”三级 Agent与工作流定制 | re-verifying | 6G | T08D-01~06 全部完成（910 测试全绿；dist 可达 + smoke-install 通过）；T07C 可开始 |
| T09 | 记忆、缓存与指标 | re-verifying | 6 | AR-00 重新验收中 |
| T09A | 全局决策提升、局部上下文节点关闭与分级回访 | re-verifying（模块级证据成立；运行期未装配，见 INT-00-03） | post-T12增补 | T09A-01~08 完成：ADR-0031 + 契约/存储/选择/验收/胶囊/回访/缓存指标/共用视图；全量 `npm run check` exit 0（134 文件 1264 测试）+ 恢复回归 34/34 + npm pack 171 文件 + verify/smoke 全通过；剩余风险：全局分支覆盖率 83.23%<85%、跨平台矩阵待 AR-07 |
| T10 | TUI | re-verifying | 6 | AR-00 重新验收中（AR-02 授权交互） |
| T11 | Headless CLI | re-verifying | 6 | AR-00 重新验收中 |
| T12 | 恢复、安全与异常加固 | done | 7 | T12-01~06 完成；AR-07 复验：`npm run check` 1301 测试全绿、覆盖率 85.06%、tarball 终验通过 |
| T12A | 统一会话恢复、任务续接与外部状态对账 | re-verifying（模块级证据成立；`recover` 未注册且为桩，见 INT-00-03） | pre-T12 | T12A-01~07 完成；AR-07 复验：恢复单元回归 34/34 + 故障注入套件随 `npm run check` 全绿 |
| T13 | npm 打包与隔离安装 | done | 8 | 最终终验（2026-09-10）：`npm pack` 171 文件 + verify-package + smoke-install（隔离安装/CLI/全局 shim/feedback-entry）全通过 |
| T14 | 文档与最终报告 | done | 8 | README（上下文生命周期/并发恢复加固/限制）、DELIVERY_REPORT §10、AR-07 复验记录与遗留清单对齐 |

## 审计整改记录（外部验收后）

### AR-01 隔离备份保管库与审计存储 — 2026-08-12 通过

- 新增 `ProtectedStoragePolicy`：规范化组件判定，普通工具执行前强制检查，列目录过滤受保护条目；不暴露物理布局。
- `listBackups` 返回公开 `BackupSummary` DTO（无哈希/能力标识/物理路径）；`readBackup` 返回显式编码与媒体类型。
- 双层校验（预检 + 紧邻 IO 复检）拦截"预检后目标被替换为链接"的 TOCTOU（junction 反例测试）。
- 安全反例测试先失败后通过；`npm run check` 全绿（33 文件 / 422 测试）；证据见 `.tmp/ar01-evidence.md`。
- 任务状态保持 `re-verifying`，待 AR-07 最终安全清单全部勾选后统一恢复 done。

### AR-01a 别名/链接绕过加固 — 2026-08-13 完成

- 受保护存储策略补 fail-closed 真实路径判定：词法判定之外，`assertGenericToolAccessAllowed` 解析 realpath，真实目标落入保管库/审计文件即拒绝；realpath 无法解析且路径链含符号链接（lstat 检测）时一律拒绝，拦截"工作区内链接/联接指向保管库"的别名绕过。
- Windows 大小写不敏感折叠（normalize + toLowerCase）用于审计文件路径比较与保护区包含判定；realpath 返回值大小写差异不再误放行。
- 目录条目过滤收窄：仅当目录是受保护根所在的状态目录时过滤（不在任意目录隐藏同名普通文件）。
- `backupVault read` 输出携带 `[encoding: ... , media-type: ...]` 头；`replaceFileContent` 紧邻 IO 复检结果用于后续全部操作（预检后换链被拦截）。
- 验证：确定性 mock 单测（fail-closed 链接链分支、大小写变体、词法兜底）+ 集成反例（junction 别名不可读取保护内容，Windows junction lstat 平台局限已注释说明）；`npm run check` 全绿（35 文件 / 435 测试）。

### 2026-08-12 — 阻断性问题全部修复并回归

| 项 | 问题 | 修复 |
|---|---|---|
| S1 | doctor 用固定 `.write-probe` 覆盖再删除，可能销毁用户文件 | 随机唯一文件名 + `wx` 排他创建；回归测试（用户同名文件完好、无残留） |
| S2 | 反馈入池无运行时校验，伪造来源/非法层级可入 journal | `feedbackMessageSchema` 严格校验 + Agent 来源身份注册（setAgentStatus 注册，未注册拒绝），拒绝路径写 stderr + `accepted=false` |
| S3 | 备份事务无闭环（TOCTOU/恢复不可撤销/备份 ID 暴露/purge 虚报/仅 UTF-8 文本） | 写入前 `verifyTargetUnchanged` 指纹复核；恢复前自动备份当前版本；输出不再含备份 ID；purge 物理删除失败抛错保持 quarantined；pre-image 改为 base64 快照（二进制 + 目录递归，跳过符号链接） |
| S4 | 删除授权仅查 revision，未核对请求 ID/Agent/集合/过期/最新 revision | 决策绑定严格校验（请求 ID、发起 Agent、精确备份集合、过期时间）+ 授权后读取最新 revision 比对；工具隔离前再校验一次 |
| S5 | CLI 授权通道固定 null，协同模式只能拒绝 | 新增 `InteractiveBackupDeletionAuthorizationPort`（警告→暂停→等待 yes/deny，非 TTY fail-closed），接入 bootstrap |
| S6 | 存档合并后虚构 owner/revision、Worker ID 复用、路径编码碰撞、自动附加违反"默认不附加" | 按属主分别生成附件（真实 owner+revision）；每次启动唯一实例 ID；`~XXXX` 单射幂等编码；`attachArchiveContextOnRetry` 默认关闭 |
| S7 | config init 无备份覆盖 | 覆盖前走 BackupVault 自动备份 + TOCTOU 校验 |

另（S8/S9）：反馈进程分支覆盖提升（transport 100%、mailbox 90%+，entrypoint 受 v8 源映射偏移影响部分失真）；新增 TUI 启动路径测试；`pretest` 保证 dist 新鲜（消除 skipIf 静默跳过）；ADR 0007-0010 去重重编号（重复 0008/0009 删除）；`npm prune` 清理 extraneous 自副本；git 基线提交 `2ac838a`；Windows rename 瞬时 EPERM 加有界重试。

## Batch 4D（T05B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 42 文件 / 491 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 93.16% / Branch 85.30% / Funcs 90.16% |

T05B（次级 Agent Git 分流、审查与合并，ADR-0012）：

- `GitProcess`：受控 git 子进程执行器（spawn、GIT_TERMINAL_PROMPT=0、超时 SIGKILL 且等待进程退出释放句柄、结构化输出、GitProcessError）。
- `GitRecoveryPointService`：reset/clean/checkout 覆盖/rebase/强制移动引用/删除分支前自动创建恢复点——引用 oid 备份到 `refs/astarray-recovery/` 受保护前缀 + 工作树未提交 pre-image（diff --binary + untracked 快照）；恢复前自动创建前置恢复点（恢复可撤销）；重复恢复拒绝；模型不可删除恢复引用。
- `GitWorktreeAllocator`：固定基线创建集成分支 + 每个三级 Agent 独立 worker 分支/worktree；worktree 作用域 config（启用 `extensions.worktreeConfig`）绑定提交身份；分配记录持久化（mission/任务/Agent/基线/允许路径）。
- `GitContributionVerifier`：合并前验证提交存在、祖先关系、提交作者 = 绑定 agentInstanceId、实际修改未越过允许路径、敏感信息扫描（凭据/私钥/令牌）、测试证据非空且成功；结构性问题 → rejected，仅证据不足 → needs-rework。
- `GitIntegrationReportStore`：结构化分流/审查/拒绝/测试/合并记录，与次级 Agent 工作存档关联。
- `GitIntegrationCoordinator`：startIntegrationSession（固定基线+集成分支）/submitContribution（验证通过 → `merge --no-ff` 保留来源，冲突抛 tool-execution-failed 并提示恢复点，禁止静默选边）/finalizeIntegration（集成测试失败记录 unresolvedRisks 不合并；模式/用户授权门禁通过才合入目标分支，合入前自动恢复点）。
- 实测发现并修复：worktree 共享配置导致身份覆盖（启用 worktreeConfig 扩展）；集成测试命令以 shell 在仓库目录执行（不能透传为 git 参数）；恢复点恢复前先对齐工作树到备份提交再应用补丁。

遗留：`git push`/PR/发布仍无工具（始终需要独立授权，符合 ADR-0012）；TUI/CLI 状态适配器留待后续。

## Batch 4E（T05C 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 38 文件 / 471 测试通过 |
| `npm run test:coverage` | 0 | Stmts 92.97% / Branch 85.08% / Funcs 90.37% |

T05C（Agent 待办偏序集、任务包与状态工具，ADR-0013）：

- `TaskSequencePartialOrder`：插入前驱/后继锚点（无锚点不自动追加队尾）、环检测（插入即回滚）、ready set 按 (priorityTier 升序, sequenceOrdinal 稳定序号) 排序、`explainOrder` 解释阻塞原因与"高优先任务必要前驱可先行"。
- `TaskPriorityPolicy`：用户默认层级 0（可更低）；agent/system/tool 请求层级 0 一律硬拒绝（task-priority-denied）。
- `AgentTaskSequenceStore`：`.astarray/agent-memory/<agentInstanceId>/task-sequences/<sequenceId>.json`，expected revision 原子更新、主文件损坏从备份恢复、写入前自动备份副本。
- `TaskBundlePlanner`：链结构校验（相邻直接前驱）、优先层一致、首节点及包内节点必须 pending、绑定具体三级 `agentInstanceId` 与序列 revision。
- `TaskSequenceManageController`：发布/插入/状态迁移/取消/打包/包状态推进，全部变更记录认证来源审计条目；越权改序拒绝。
- `TaskSequenceStatusController` + `taskSequenceStatus` 只读工具：身份由 harness 注入（owner = 当前 Agent 实例，模型无法填他人 ID），返回一致 revision 快照（ready set/顺序解释/任务包），无副作用。
- 序列文件只含调度信息，不含项目产出内容。

遗留：TUI/CLI 状态适配器（分栏展示）待 Batch 6 后续接入；任务状态保持 `re-verifying` 待 AR-07 最终安全清单。

## Batch 4A/4C（T05A/T06A 增补任务）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 30 文件 / 379 测试通过 |
| `npm run test:coverage` | 0 | Stmts 92.02% / Branch 85.17% / Funcs 89.25% |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + 全局 shim + 反馈入口全通过 |

T05A（Agent 工作存档，ADR-0008）：

- `AgentWorkArchiveStore`：每 Agent 独立存档（版本化 + 单调 revision + 原子写入 + 路径安全编码）。
- Worker 自动记录 assignment/result/failure/handoff；调度器重新调用任务时只附加最近结果类条目（选择器），默认不注入完整存档；附件含 SHA-256 contentHash。

T06A（破坏性变更备份层，ADR-0009）：

- `BackupVault`：破坏性变更前由工具自动保存完整 pre-image（不经过模型）；list/read/restore；quarantine 两阶段删除；manifest revision 单调。
- `BackupDeletionAuthorizationController`：协同模式经专用控制通道逐次授权（allow-once、无会话记忆、revision 校验、fail-closed）；放权模式写 HIGH 审计；哈希链审计日志。
- 新增内置工具：`replaceFileContent`（overwrite + automatic-preimage）、`backupVault`、`deleteBackup`（特权入口）。
- PolicyWrapper/CLI 装配已接入；缺少备份端口时破坏性工具拒绝执行。

实测发现并修复：Agent ID 含冒号导致 Windows 存档路径非法 → 路径段安全编码。

## Batch 8（T13–T14）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 28 文件 / 356 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.81% / Branch 85.27% / Funcs 88.39% |
| `npm pack` | 0 | `.tmp/packages/astarray-0.1.0.tgz`（13 文件 / 105 KB） |
| `node scripts/verify-package.mjs .tmp/packages/astarray-0.1.0.tgz` | 0 | 无 .env/日志/.astarray/测试文件；无 BOM；shebang 正确；反馈入口包含 |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + npx version/help/doctor/run 冒烟 + 全局 .cmd shim + 反馈入口 ESM 加载 |

T13 修复记录：npm 11 全局 `--prefix` 的 shim 位于 prefix 根目录（非 bin/）；Windows 下 execSync 的 rm/mkdir 替换为 Node fs API；`npm pack --json` 输出含 tsup ANSI 噪声需剥离；ESM 入口验证用 file:// URL。

T14 产出：`README.md`（安装/三模式/Provider/状态目录/headless/反馈进程/TUI/跨平台/安全/限制）、`DELIVERY_REPORT.md`（完成情况/实际命令证据/覆盖率/tarball/隔离安装/已知风险）。

## Batch 7（T12）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 27 文件 / 353 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.59% / Branch 85.04% / Funcs 88.09% |

本批加固与实测发现：

- **真实漏洞修复 1**：`writeFileTemporary` 接受 `../` 穿越文件名 → 已加临时目录边界校验（`isPathWithinDirectory`）。
- **真实漏洞修复 2**：Redactor 的 authorization 规则可跨行匹配（`\s+` 吞换行）且与自身占位符自匹配 → 规则改为 `[ \t]+` 并排除跨行；`containsSensitivePattern` 先剔除占位符再断言。
- 无限 tool loop：Worker 达到 maxLoopIterations 后终止并上报失败（不挂死）。
- Ponder 不产生任何状态文件（含任务链/概要）；允许的本地只读工具不得改变此性质。
- 不可写状态目录/缺失文件：TaskStore 与工具返回明确错误而非崩溃。
- 路径穿越变体（`../`、反斜杠、绝对路径、UNC、多层）全部拒绝。
- 工具分类不可绕过：大小写/包装命令/别名精确名称匹配。
- secret 不泄漏：Redactor 断言级校验（日志、JSON 输出）。

遗留风险：`writeFileTemporary` 的 `flag: "wx"`（不覆盖）在 T12 期间加入，属行为加固；跨进程 mission 锁仍为单进程内实现（多 CLI 实例并发写同一 mission 由 revision 校验兜底）。

## Batch 6（T09–T11）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 26 文件 / 339 测试通过 |
| `npm run test:coverage` | 0 | Stmts 91.56% / Branch 84.93% / Funcs 88.06% |

关键交付：

- T09：`DiskCache`（缓存键含 Provider/模型/模式/输入/系统提示词哈希/工具子集哈希/上下文摘要哈希/文件指纹；写操作/时间敏感/失败默认 bypass；stale-reject 语义）、`MetricsRegistry`（hit/miss/bypass/stale-reject、estimated token、峰值并发、消息延迟）、ANSI/OSC 清洗器。
- T10：Ink TUI（Header/会话/DAG/Agent 面板、输入框、权限与帮助弹窗、焦点循环、模式切换、500ms 状态轮询、流式节流 40ms、状态订阅驱动渲染）；组件测试覆盖 80×24/120×40/60×20、CJK/emoji、超长内容、NO_COLOR、ANSI 注入清洗。
- T11：`run/status/resume/cancel/doctor/config init` 全部实现；`--json` 模式 stdout 仅 JSON、日志走 stderr；退出码 0/1/2 稳定；11 项构建产物集成测试 + 17 项命令单元测试；反馈进程入口路径解析修复。

遗留风险：TUI 键盘输入路径未做 PTY 自动化（T13 用 node-pty 补）；指标尚未接入编排循环（v0.1 头栏显示 0）。

## Batch 6E（T08B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 53 文件 / 665 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.3x% / Branch 85.23% |

T08B（工具说明回访、无产品数量配额与受权通信转交，ADR-0024）：

- `ToolDocumentationReceiptStore` + `ToolDocumentationRecallInjector`：个体按 agentInstanceId + toolGroupIdentifier + revision 保存回执（内容哈希）；首次完整注入已分配工具说明；同 revision 连续激活只发固定提醒（ASTARRAY_TOOL_HELP_REQUEST_V1 标准格式）；revision 变化发可验证 delta（无法证明完整则完整重发）；新个体不继承、同级不共享。
- `ToolHelpRequestSchema`/`validateToolHelpRequest`：usage-help 必须带已分配 toolIdentifier 且阻塞原因限 forgot-usage/schema-uncertain/response-uncertain；missing-capability 允许 null 工具并限 not-in-assigned-tool-set/no-known-match；身份/层级/直属上级/mission/revision/来源由 harness 注入。
- `ToolDocumentationRecallController`：已分配工具直接返回单工具完整用法（usage-provided，不重复整组）；未分配/权限不足 → known-but-not-usable（不泄露 schema）+ escalation；无匹配 → missing-tool escalation；request ID 幂等去重、陈旧 revision 返回 stale-request、换词循环预算超限 rejected；isAuthorizationGranted 恒 false（不授予工具/权限/安装）。
- `UnboundedAgentInstanceRegistry`：历史实例总数不产生拒绝（10,000 实例创建/回收验证）；并发槽满 → 排队/暂停（资源限制非数量配额）；回收需允许且已回收实例不可复用。
- `AgentCommunicationDelegationController` + `DelegatedAgentCommunicationGrantStore`：target 必须恰好低一级、recipient 必须与 grantor 同级、target 存活；不透明 communicationHandleIdentifier（无 IPC/凭据暴露）；投递前失效检查全条件（用户撤销/target 回收/父子变化/mission 结束/到期/消息类型/instruction 未授权/在途超限/句柄不存在）；grant 不可转授；Agent 相关撤销批量生效。

## Batch 6D（T08A 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 52 文件 / 654 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.3x% / Branch 85.23% |

T08A（默认控制流、个体记忆隔离与三级 Agent 生命周期，ADR-0022/0023）：

- `AgentIndividualMemoryStore` + `AgentMemoryNamespacePolicy`：个体以不可复用 agentInstanceId 独占记忆域（memory-archive.json）；角色级共享路径（main/secondary/tertiary/all-agents/shared）拒绝；运行时身份/目录/文档 owner 三处一致校验；观察记录保留原始来源与附件哈希。
- `CrossAgentContextAttachmentController`：不可变附件（显式条目选择/脱敏/token 预算/内容哈希/来源校验），空选择与预算超限拒绝；verifyAttachment 防篡改。
- `ConversationTaskInsertionController`：TaskInsertionProposal 来源校验（用户与认证用户一致；主 Agent 派生层级 0 硬拒绝）、锚点/revision/环由偏序集控制器校验；提交后主 Agent 立即回对话循环。
- `TertiaryAgentAssignmentPlanner`：11 项复用条件逐项判定（存活/空闲/所属/兼容/未决/预算/冲突），create-new 带可解释原因。
- `TertiarySingleChainExecutionGuard`：一次激活绑定不可变 taskBundleId 与任务链；链外领取与禁止能力（集成分支/远端项目控制/调度等）本地拒绝。
- `TertiaryAgentLifecycleController`：九阶段受控收口（停止派发→收敛未确认调用→检查点→handoff→反馈→权限→mailbox→Git→进程），阶段失败保留状态可幂等重试，不允许杀进程代替收口。
- `MainAgentReportArchiveIngestor` + `MainAgentReportReader`：终态汇报只写独立报告索引（来源校验/内容哈希防篡改），不唤醒主 Agent 不注入对话；后续轮次按任务引用与 token 预算只读选择。

## Batch 6C（T06G 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 51 文件 / 640 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.3x% / Branch 85.01% |

T06G（主 Agent 永久只读、次级权限上限与会话临时提升，ADR-0021）：

- `MainAgentReadonlyToolProjection`：任意 profile/临时提升下主 Agent 工具投影只含读取类白名单（readFile/listDirectory/searchProjectText/taskSequenceStatus/gitReadonlyView/factVerification）；写入/进程/安装/Agent 管理/权限管理/导出工具一律不可见；空实例 ID 拒绝。
- `SecondaryAgentSessionController`：可信本地控制面创建不可复用次级 agentInstanceId，绑定 session、基础 profile 引用与权限快照；不作为主 Agent 工具。
- `SessionPermissionElevationStore/Controller`：会话级（全部现有及后续次级 Agent）与个体级提升记录，绑定 capability/资源范围/基础 profile revision/目录版本/会话权限 revision/原新决定/到期/用户裁决引用；提升方向必须更宽（deny→ask/allow、ask→allow）；撤销/批量撤销/个体回收撤销。
- `EffectiveSecondaryPermissionResolver`：基础 profile + 会话覆盖 + 个体覆盖计算有效决定；到期、profile 切换（builtin↔custom、custom↔custom）、revision/目录版本变化、Agent 回收使覆盖失效。
- `TertiaryPermissionDelegationGuard`：三态宽度 deny < ask < allow 求交；三级最终权限不得宽于次级有效权限（超出发放拒绝）。
- `CurrentPermissionConfigurationExporter`：导出基础 profile + 会话级覆盖的公开有效配置；剥离 session/Agent 身份、elevation ID、用户裁决引用、到期计时器等内部字段；覆盖导出文件前自动备份；导入无授权效力。
- `SessionShutdownCoordinator`：收敛在途调用 → 可选导出（失败只报告不阻塞）→ 无条件撤销全部提升并关闭会话；导出失败不延长权限租约。

## Batch 6B（T06F 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 50 文件 / 620 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.0x% / Branch 85.08% |

T06F（可配置权限组与无限命名自定义模式，ADR-0020）：

- `PermissionCapabilityCatalog`：44 项逐项权限（project/process/network/browser/connector/database/cloud/clipboard/environment/code-repository/dependency/extension/git/external/financial/system/backup/agent/task/memory），含 Devolve/Assist 默认值与工具映射；未映射工具拒绝注册/执行；多权限最严格裁决（任一 deny→deny，否则任一 ask→ask，全 allow→allow）；replaceFileContent 映射 project.modify + project.destructive-mutate（Assist 默认 deny）。
- `PermissionProfileStore`：内置三组——Devolve 出厂全 allow、Assist 独立矩阵、Ponder 全 deny + 签名冻结（更新入口拒绝）；自定义组单调 revision、目录版本、原子持久化、.bak 自动备份、损坏恢复、stale-revision 拒绝、特殊字符 ID 路径段安全编码。
- `CustomPermissionProfileController`：创建（空白/内置视图/自定义组复制）、重命名（ID 不变）、逐项三态、重置、导入（过滤未知权限与非法决定，不携带内部状态）、导出（仅可配置字段）、删除（当前使用组拒绝、删除前备份）；名称 Unicode 规范化 + 大小写折叠唯一，保留内置中英文名；进程内名称缓存避免 O(n²) 读盘；无产品数量上限（无计数分支）。
- `ConfigurablePermissionPolicyEngine`：schema 暴露/执行前读取 profile 快照裁决；ask 授权绑定 profile revision + 目录版本 + 参数哈希；revision/参数/模式切换（内置↔自定义）/过期后旧授权失效；未映射工具返回稳定最小"操作不可用"（无规则类别泄露）。
- `ToolRegistry` 接入目录校验：未映射工具拒绝注册。
- 内部强制执行层不进入权限目录（目录无内部项）。

## Batch 6A（T06E 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 49 文件 / 598 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.2x% / Branch 85.02% |

T06E（Assist 安装前置询问、独立开关与逐次授权，ADR-0019）：

- `InstallationOperationClassifier`：按效果分类（不依赖可绕过的命令字符串）——npm/pnpm/yarn/pip/uv/poetry/cargo、系统包管理器（apt/brew/dnf 等）、git clone/归档下载（含 -b 版本提取）、插件/技能/模型（code --install-extension、gh extension）、运行时工具链（rustup/nvm 等）、生命周期脚本、lockfile/vendor 改写；包装 shell（sh/bash/cmd -c、powershell -Command）递归解析内嵌脚本不可绕；空命令 fail-closed。
- `AssistInstallationSettingsStore`：独立布尔开关默认 false，单调 revision、写入自动备份、损坏从备份恢复、stale-revision 拒绝。
- `ExistingResourceInquiryController`：安装前结构化询问（所需能力/用途/候选类型，不读敏感配置）；用户答已有 → 只读验证端口校验（版本/完整性/兼容性），验证失败返回差异继续等待用户决定，不得自动假定"没有"并安装；答没有 → 进入开关检查。AgentStatus 新增 `awaiting-existing-resource-answer`。
- `AssistInstallationAuthorizationController`：开关开启才可生成 `assist-installation-request`（绑定 Agent/任务/来源/包/精确版本/完整性/目标/作用域/包管理器/参数/网络/脚本/变更摘要 + 一次性 nonce）；allow-once 不记忆不批量；执行前复检（模式仍 assist、设置 revision 未变、nonce 未消费未过期、参数哈希一致）通过即消费；重放/参数漂移/模式切换/revision 变化/过期全部 fail-closed。
- 反馈协议新增 `existing-resource-inquiry` 与 `assist-installation-request` payload（走 instruction 优先级）。

## Batch 4J（T07A 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 48 文件 / 583 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.47% / Branch 85.38% |

T07A（明确完成协议与早停恢复，ADR-0015）：

- `TaskCompletionEventV1` / `TaskBlockedEventV1` schema 与常量（watchdog 5s / 无进展 90s / 完成宽限 5s / 续跑上限 3）。
- `CompletionControlParser`：结构化控制帧优先；文本兼容格式只接受最终独立末行（可容忍宽限期末尾非标识行）；正文中间/项目文件/普通输出中的同名字符串忽略；非法 JSON/schema 不符返回 none 不抛错。
- `LocalCompletionVerifier`：八项验收条件——尝试 ID 防重放、任务 ID 匹配、revision 非陈旧、声明节点可完成且无未满足前驱、无未决工作项、产物/验收门禁证据、高严谨性证据门禁（接入 EvidenceCompletionGate）、循环守卫无活锁且预算未绕过、无未解决阻塞、Provider 流正常结束；accepted 只发生一次。
- `AgentRunWatchdog`：无进展超时只触发健康探测；Provider 仍活跃 → stalled-activity-unknown（不取消不续跑）；运行中工具调用不算无进展；请求已失活 → stalled-inactive（可安全续跑）。
- `ContinuationCoordinator`：先原子保存检查点再以新 completionAttemptId 续跑（保留幂等键）；旧请求停止状态不确定 → blocked 不并发续跑；达上限 → give-up 不机械重试；尝试 ID 记录防重放。
- 确定性测试（无真实 Provider）：文本末行/伪造标识/结构化帧、验收全条件、看门狗三态、续跑上限/幂等/blocked。

## Batch 4I（T06D 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 47 文件 / 562 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.1x% / Branch 85.11% |

T06D（高严谨性事实验证工具，ADR-0016）：

- `LocalRigorPolicyEngine`：版本化规则（RIGOR_RULES_VERSION）标记法律/医疗/财务/安全边界/破坏性操作/发布/身份权限/时效性/用户严格要求为 high；模型只能上调不能下调（下调拒绝）。
- `EvidenceBundleBuilder`：按 claim 合并 source > local-experiment > reasoning 固定层级排序；矛盾/不可用关系显式保留并生成局限提示；输出只含 supported/contradicted/mixed/insufficient/unavailable，无 qualified/safe/pass 判定；schema 校验（EVIDENCE_BUNDLE_SCHEMA_VERSION）。
- `EvidenceCompletionGate`：高严谨性任务未调用 factVerification、主张不一致、无覆盖或 unavailable → 未满足；仅纯推理（缺来源正文）不得宣称完成；门禁通过只说明验证流程已执行。
- `EvidenceSearchAgentPort` + `EvidenceQueryGuard`：结构化查询（不开放任意 URL）；规范化查询指纹（等价查询一致）+ 结果缓存 + 每主张调用预算（换词活锁阻断）；查询敏感内容检查（凭据/私钥/连接串拒绝上传，不上传工作区正文/.env/提示词）。
- `factVerification` 受控工具：search-sources（无资料 → unavailable，仅标题/摘要不算完整依据）/ record-local-experiment / record-reasoning（标记 insufficient）/ build-evidence-bundle。
- 必测行为：高严谨性任务缺证据拒绝完成、普通任务不强制、Agent 自述不能冒充独立依据、离线/失败形成 unavailable 不虚报、查询泄密反例被本地阻断、指纹缓存与预算防换词。

## Batch 4H（T07B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 46 文件 / 539 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.44% / Branch 85.12% |

T07B（反自指读取与通用活锁守卫，ADR-0017）：

- `ReadSuppressionLedger`：键 = agentInstanceId + taskExecutionId + 规范资源身份 + operationKind + normalizedRange + 参数哈希；单调时钟（可注入 fake clock），默认窗口 30_000ms；保存文件身份（dev:ino + realpath）与内容指纹（sha256）；窗口内同源重复读取未变化内容 → `resource-already-read`（新错误码）+ 读取回执 + firstReadAt + retryAfterMilliseconds；文件真实变化或窗口过期可重读。
- `CanonicalResourceIdentityResolver`：realpath + 符号链接/联接 + 硬链接（dev:ino）+ 平台大小写折叠；账本键基于规范身份派生，相对/绝对别名、大小写变体、无关参数噪声不能改变键。
- 敏感内容禁读优先于时间锁（敏感文件先拒绝且不登记）。
- `LocalProgressAndCycleGuard`：调用图检测直接自环/资源环 A→B→A（报告完整循环链）、深度/图节点数/扇出上限、连续无进展计数（默认 3 次暂停路径，有进展重置）、single-flight 在途调用合并、任务总调用预算持久化（重启不清零，通过注入的读写器）。
- builtins 接入：readFile 读前抑制查询 + 读后登记；未装配账本时行为不变。
- 确定性测试：fake clock、路径别名/大小写、文件变化重读、不同 Agent/任务隔离、敏感优先、环链、无进展暂停、single-flight、预算跨重启、拒绝不返回正文。

## Batch 4G（T06C 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 45 文件 / 524 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.75% / Branch 85.23% |

T06C（全模式本地敏感内容禁读，ADR-0018）：

- `SensitiveContentAccessPolicy`：全模式（Ponder/Assist/Devolve）读通道执行前统一拒绝 `.env`/`.env.*` 及大小写变体、`.npmrc`/`.pypirc`/`.netrc`/`.git-credentials`、云/K8s 凭据、私钥/证书容器（id_rsa、*.key/*.pem/*.p12/*.pfx）、能力令牌与管理员扩展路径/模式；稳定拒绝码 `sensitive-content-read-denied`（新错误码），错误只含规则类别不泄露秘密值。
- `SensitiveResourceIdentityResolver`：规范路径 + realpath + 符号链接/联接（isLinkLike）+ 硬链接身份（dev:ino）+ 平台大小写折叠识别同一敏感资源；`isSameResource` 同一性判定。
- 本地可信 DLP 扫描器：名称正常但内容疑似凭据（api key/AWS AKIA/私钥块/ghp 与 glpat token/连接串，支持 JSON 引号包裹）→ 丢弃整个结果，不返回正文或命中片段；有界扫描（256KB）。
- 接入所有读通道：readFile（读前路径 + 读后内容双检）、listDirectory（过滤敏感条目）、searchProjectText（敏感文件名跳过）、gitReadonlyView（输出 DLP，防御视图扩展）、backupVault read（备份 pre-image 内容 DLP，防 .env 备份旁路）。
- 反例覆盖：大小写变体/相对路径、符号链接与硬链接伪装、DLP 命中、目录过滤不泄露名称、错误不含秘密字节、普通配置不误杀、管理员扩展、Devolve/授权不能放行（策略在权限之前）。
- 已知限制（ADR-0018 文档语义）：内容不含任何凭据模式的凭据库文件经硬链接读取无法由 DLP 识别；名称规则 + DLP 双检覆盖 ADR 必测清单。

## Batch 4F（T06B 增补任务）检查点记录

### 2026-08-13 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 44 文件 / 510 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 92.70% / Branch 85.23% / Funcs 89.x% |

T06B（Ponder 本地只读边界与敏感操作分类，ADR-0014）：

- `LocalSensitiveOperationClassifier`：版本化确定性分类规则（`OPERATION_CLASSIFICATION_RULES_VERSION`），按工具名静态映射 + mutationKind + 名称模式分类文件/Git 变更、进程、网络、发布、凭据、备份与系统操作；纯本地执行，不发起云端分类；大小写不敏感。
- `LocalToolPolicyEngine`：Ponder 白名单（readFile/listDirectory/searchProjectText/taskSequenceStatus/gitReadonlyView）双时点 fail-closed 校验——白名单 + 只读分类 + 声明一致（category/backupPolicy/mutationKind 伪造拒绝）+ 参数安全；敏感路径排除（.env/凭据/密钥/.git 凭证，兼容 Windows 反斜杠）；本地拒绝事件（工具 ID、规则版本、原因，不记录文件秘密）。
- 新只读工具：`searchProjectText`（工作区递归检索，有界 500 文件/100 结果/512KB，跳过敏感与二进制文件）与 `gitReadonlyView`（固定视图 status/diff/log，参数由引擎构造，模型不可注入 git 参数，无 shell）。
- `PermissionPolicy`/`PermissionDecider` 接入：Ponder 分支由本地引擎异步判定；每次裁决实时读取当前模式（降级后立即复检）；Ponder 下不查询会话授权（旧授权不沿用）；未装配引擎时 Ponder 一律 deny（与旧版一致）。
- 反例覆盖：写工具/进程/网络/凭据/备份拒绝、伪造 readonly 声明、路径穿越/绝对逃逸/受保护区/敏感文件名、git 非法视图、未知工具与不可解析参数、降级复检、断网一致性（纯本地规则）。

## Batch 5（T08）检查点记录

### 2026-08-13 — T05B→T08 编排接入增补通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 43 文件 / 495 测试通过（typecheck/lint/build/test 全绿） |
| `npm run test:coverage` | 0 | Stmts 93.04% / Branch 85.70% / Funcs 89.67% |

T05B→T08 接入（AR-04 身份一致性及次级 Git 集成复验项）：

- `MissionOrchestrator` 新增 `gitIntegration` 装配：首次调度前自动 `startIntegrationSession`（固定基线 + 集成分支）；写入型任务（taskType 在 allowedPathsByTaskType）自动分配隔离 worker 分支/worktree，Worker 工具端口指向 worktree。
- Worker 成功后编排层在 worktree 提交（身份已绑定）→ 证据命令实际执行上报真实退出码 → `submitContribution` 审查；审查拒绝/提交异常 → 任务 blocked + escalation（禁止 unhandled rejection）。无改动视为无贡献直接放行。
- Mission 完成时 `finalizeIntegration`：集成测试失败记录 unresolvedRisks 不合并；`isTargetBranchMergeAllowed` 门禁由装配方注入（Assist 需用户授权），通过才合入目标分支；审查结果写入次级 Agent 工作存档（decision 条目 + headCommit 引用）。
- `MainController`/`AssistScheduler`/`DevolveScheduler` 透传 `gitIntegration` 与 `secondaryAgentInstanceIdFactory`（每次 mission 不可复用实例 ID）。
- 实测发现并修复：
  - git ref 名不接受 `:`/`~` → `encodeGitRefSegment`/`decodeGitRefSegment`（合法段原样 + `seg-<hex>` 编码，单射可逆）。
  - 恢复点备份 ref 全名在 Windows 超路径限制（"Filename too long"）→ 备份 ref 改简短名 `refs/astarray-recovery/<mission>/<id>/b<i>`，referenceBackups 增加 `backupReferenceName` 字段。
  - 越界修改必须整体提交后由审查 allowedPaths 拦截（仅暂存允许路径会让越界内容绕过审查）。
- 集成测试（真实 git）：worktree 提交→审查→合并→门禁合入目标分支；越界修改被拒绝（任务 blocked、未合并、escalation）；未装配时行为与旧版一致；分配失败 escalation 且不启动 Worker。

遗留：T05C 序列接入 Assist 调度器（待办偏序集与任务包派发）与 TUI/CLI 状态适配器留待后续批次。

## Batch 5（T08）检查点记录

### 2026-08-12 — 通过（连续 3 次 `npm run check` 全绿）

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` ×3 | 0 | typecheck/lint/build/test 全绿，284 测试，无 unhandled |
| `npm run test:coverage` | 0 | Stmts 94.55% / Branch 87.45% / Funcs 93.37% |

关键验收点与证据：

- 主 Agent 派发后立即回输入循环：`handleUserMessage` 返回后后台 mission 运行（main-controller 测试）。
- 两个任务并发 + 第三个等待依赖：串行/并发行为断言。
- 连续失败阈值后 failed + 人工 retry 成功：retry 流程。
- permission-ask → 任务 blocked → 用户授权 + unblock → 成功。
- ambiguous → blocked + 升级用户。
- 非阻塞通信：Worker 挂起时仍可创建第二个任务与查询。
- 显式 cancel 中断（AbortSignal）+ cancel 等待在途 Worker 收敛。
- Devolve：无权限询问、子集边界仍生效、直接裁决方法。
- 修复记录：ToolLoop 透传 errorCode（permission-ask 判定）；task blocked 等待人工裁决（不自动重跑）；cancel 收敛语义；summary 写入互斥。

本批产出：`packages/core/src/orchestration/{mission-orchestrator,worker-agent,assist-scheduler,devolve-scheduler,main-controller,mission-manager}.ts` + ADR-0011（permission-ask 消息类型）+ 编排/主控制器/mission 管理测试。

遗留风险：真实 LLM 的任务分解（v0.1 用确定性分解，见 main-controller.decomposePromptForScriptedRun 注释）。

## Batch 4（T05–T07）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 19 文件 / 247 测试通过 |
| `npm run test:coverage` | 0 | Stmts 94.29% / Branch 86.41% / Funcs 92.98%（门槛生效，低于 85% 会失败） |
| `npm run check` | 0 | 全绿 |

关键验收点与证据：

- T05：环/缺失依赖/重复 ID 检测；并发上限（2/4 验证）；严格串行依赖；领取锁（同一任务不可双领）；失败传播 → 下游 blocked；retry/reassign/cancel/unblock；每轮调度后 revision 单调递增持久化；失败计数器（阈值 3、成功清零、分工具计数）。
- T06：主 Agent 仅预览（无 schema）；子集按任务类型；Worker 子集外调用 deny；旧基线为 Ponder 全 deny，已被新增 T06B/ADR-0014 的本地只读白名单设计替代；Assist readonly allow / restricted ask（会话授权后 allow，参数哈希变更失效）/forbidden deny；Devolve 注册工具 allow 但路径逃逸拒绝；审计事件；token 估算；shell/删除/安装/发布/付款默认未注册。
- T07：ScriptedRuntime 确定性脚本（含中途取消）；OpenAICompatibleRuntime 流式解析/工具调用累积/finish_reason 分支/超时与取消；API key 不进入错误消息；ToolLoop 工具执行回填、最大迭代保护、取消传播、事件透传。

遗留风险：跨进程 mission 锁与更多安全加固在 T12；OpenAI runtime 的 SSE 实现为整文本解析（生产可换流式，语义不变）。

## Batch 3（T04）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 14 文件 / 177 测试通过 |
| `npm run test:coverage` | 0 | Stmts 94.31% / Branch 85.32% / Funcs 93.79%（门槛 85% 已启用） |
| `npm run build` | 0 | dist/cli.js + dist/feedback-process-entry.js |
| `npm run check` | 0 | 全绿 |

关键验收点与证据：

- 反馈进程 PID ≠ 主进程：集成测试断言（`tests/core/integration/feedback-process.test.ts`）。
- 杀死反馈进程后 supervisor 重启并重放未确认消息：SIGKILL 集成测试 + 重放 ≥1。
- Agent busy 时普通消息不进入其上下文：busy 时 0 投递，转 idle 后投递。
- 同优先级 FIFO、高优先级越过：mailbox-journal 单测（instruction > failure > success；ack 前重放优先）。
- 质数退避 2,3,5,7,11 → 10800 封顶 + 新消息重置：虚拟时钟单测，全程无真实 sleep。
- 投递后 ack 前崩溃可幂等重投：journal 持久化 + 重开重放测试；客户端按 idempotencyKey 去重。

本批产出文件：`packages/core/src/feedback-process/{prime-backoff,ipc-protocol,mailbox-journal,delivery-worker,transport,process-supervisor,entrypoint}.ts` + 单测 4 组 + 真实 fork 集成测试 + `tests/core/fixtures/never-exit.mjs`。

遗留风险：跨进程 mission 锁留待 T12；`npm run test` 单独运行（未 build）时集成测试自动跳过（`describe.skipIf`）。

## Batch 2（T02–T03）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 7 文件 / 113 测试通过 |
| `npm run test:coverage` | 0 | Stmts 97.75% / Branch 90.56% / Funcs 95.12% |
| `npm run build` | 0 | 构建成功 |
| `npm run check` | 0 | 全绿 |

本批产出文件：

- `packages/core/src/core/mode-machine.ts`（迁移规则表 + 非法迁移抛错）
- `packages/core/src/core/permission-policy.ts`（PermissionPolicy 矩阵、SessionAuthorizationManager TTL/参数哈希、PermissionDecider 实时模式裁决）
- `packages/core/src/infra/redaction.ts`（Authorization/API key/JSON 凭据脱敏）
- `packages/core/src/infra/async-mutex.ts`、`packages/core/src/infra/atomic-json.ts`、`packages/core/src/infra/task-store.ts`（临时文件+flush+原子替换+备份恢复+revision 单调+mission 锁）
- 测试：mode-machine / permission-policy / redaction / task-store（113 例，含 8 写者×5 迭代并发更新不丢 revision、Windows 覆盖替换、崩溃恢复）

检查项：命名审查通过；git diff 无敏感信息；错误码新增 invalid-mode-transition / stale-revision / path-escape-attempt。

遗留风险：跨进程 mission 锁（多 CLI 实例写同一 mission）留待 T12；质数退避与反馈协议在 T04。

## Batch 1（T00–T01）检查点记录

### 2026-08-12 — 通过

验收命令与实际结果：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 无错误 |
| `npm run lint` | 0 | 无告警 |
| `npm run test` | 0 | 3 文件 / 32 测试通过 |
| `npm run test:coverage` | 0 | Statements/Branches/Functions/Lines 均 100% |
| `npm run build` | 0 | dist/cli.js 2.96 KB |
| `node dist/cli.js --version` | 0 | 输出 `0.1.0` |
| `node dist/cli.js --help` | 0 | 输出全部子命令 |

检查项：

- git diff 审查：无敏感信息；仅 Batch 1 相关文件。
- 命名审查（§3.2 模式搜索）：无违规变量/函数/时间量（仅领域字符串值与标准 Node 全局命中）。
- shebang：`packages/tui/src/cli.tsx` 首行为 `#!/usr/bin/env node`，构建产物保留。

本批产出文件：

- 工程骨架：`package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`、`eslint.config.mjs`、`.gitignore`、`AGENTS.md`、`README.md`（占位）、`LICENSE`
- 契约：`packages/core/src/core/types.ts`、`packages/core/src/core/events.ts`、`packages/core/src/core/schemas.ts`、`packages/core/src/core/errors.ts`
- CLI 骨架：`packages/tui/src/cli.tsx`（run/resume/status/cancel/config/doctor 为占位 stub，报错退出码 1；真实实现见 T11）
- 测试：`tests/core/unit/schemas.test.ts`、`tests/core/unit/frozen-decisions.test.ts`、`tests/core/unit/errors.test.ts`
- 文档：`docs/architecture.md`、`docs/adr/0001`–`0006`
- 状态：`PLAN_STATUS.md`

已知风险/遗留：

- CLI 子命令为 stub，`--json` 输出约定（stdout 仅结果）尚未实施（T11）。
- 覆盖率门槛 85% 已在 vitest 配置生效；95% 专项门槛（状态机/权限/DAG/反馈协议等）在相关任务完成后追加。
- `cli.tsx` 已从覆盖率统计中排除（入口文件，无领域逻辑）。
