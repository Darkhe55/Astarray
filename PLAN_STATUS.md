# PLAN_STATUS — Astarray 实施状态

> ## ⚠️ 最新交接（2026-11-08，第 81–95 轮，**请先读这一份**）
>
> **`docs/reports/SESSION_HANDOFF_WINDOW_81_95_2026-11-08.md`** —— 本窗口 **16 个提交**的账目、
> **入口地图**（想知道什么该看哪份报告）、**仍缺项（全部在用户/平台侧）**、**未复现抖动清单**、
> 以及**我在本窗口犯的 7 类错与教训**（含两次"筛法太窄导致误判"）。
>
> **上一窗口（81–100）末口径（2026-11-08，**第 101 轮**实测 —— 已进入新窗口 101–140）**：上一窗口共 **20 个提交**（自 `13c3342`）；
> `HEAD` **`c9e8146`**（`== origin/main`、`unpushed: 0`）；`check` **exit 0 — 443 文件 / 3297 用例**；
> `verify:mutation-kills` **exit 0 — 37/37 被拦下**（自第 81–100 轮起把变异体从 **28 扩到 37**）；
> 覆盖率 **92.5 / 85.11 / 93.21 / 92.55**（阈值 85 全过）。
>
> **本窗口主要交付**：① 接通 `PERF` 与 `DIAG` 的**生产采集**（此前两组都是「组件存在但产品不可达」；
> 均带开关且**缺省关**）② `before-dispatch-crash` 注入**从概率改为确定性** ③ 两项**测量**
> （`PERF-01-01` 观测开销、`SUM-01` 触发阈值）④ 补齐**两处守卫缺口**（`instruction-superseded` 分支零覆盖、
> 内部强制层不得进权限目录）⑤ **订正 5 处**过期/自相矛盾的卡片结论。
>
> **与上一窗口交接的关系**：上一窗口（第 60 轮 / 上限 60）的交接是
> `docs/reports/SESSION_HANDOFF_2026-11-08.md`（`ec0dec2`）—— **本文件不覆盖它**，两份请连读。
>

> ## 📌 本窗口收口说明（2026-11-08，第 60–80 轮）
>
> **本窗口不只加新行，还对「当前有效状态」表做了逐条复核**（结论如下，可逐条回溯提交）。
>
> **① 订正 5 行**（原结论已过期，或**已被用户否证**）：
> - `SMART-01`：`--probe-only` 的 Windows libuv 断言**已修并验证**（`07331cb`，含 12 项排除清单；
>   实测默认超时为 5000ms、`duration` **含 `beforeEach` 钩子** ⇒ 仅凭 duration 做批量普查**不成立**）；
> - `PROJECT-01`：GUI `copyReceipts` **真的供数**（`e4822d5`）+ 公开门面暴露**接收方同级个体**维度（`69ed7cf`）；
> - `RELIABILITY-01`：产品侧「`shutdown()` 返回即静默」**已修**（`c48a61c`）与**诚实量化**（叠加后 5 轮仍 **3/5** ⇒
>   **不宣称改进、也不宣称回归**；唯一稳定成立的是 `Test timed out` **0 次**）；
> - `GUI-01-R`：**「屏幕阅读器一项未测」已过期** —— 用户 2026-11-08 实测确认「念了页码」（`0a81e8c`）；
> - `TOOLKIT-01`：删掉**被用户 2026-10-22 否证**的「把 MERGE-01 规则表接成签发者」方向（真实交付是 
>   `tool-upgrade-authorization-grant.ts`，`cee06f1`）。
>
> **② 核对无出入 4 行**：`COMM-01 / WB-00`、`MERGE-01 / NODECTX-01`、`AR-07`、`B6R-10`
> （与各自卡内检查点表/最新小节一致，**未改**）。
>
> **③ 仍未闭合（须用户或平台）**：**macOS 平台证据**；**Linux/macOS 的 GUI 人工体验**
> （Windows 浏览器连不进 WSL loopback、WSL 内无浏览器，**均已实测**）；
> **`A 全局 testTimeout` / `B 逐文件` 决策** —— 本窗口我一度越权选了 A，随后依本文件既有记录
> （「用户未指定时选**更保守的 B** 且**未动全局配置**」）**如实回退**，此后一律按 **B** 执行。
>
> **④ 一次可复用的方法学结论**：给时序竞态做闸门时，**观测必须纯被动、只读** ——
> 会改变被测系统状态的 API（如 `requestReplay`）会让判据**永不成立**，且失败方向**看起来像产品有 bug**。


> ## ⚠️ 最新交接（2026-10-12，请先读这一份）
>
> **`docs/reports/SESSION_HANDOFF_2026-10-12.md`** —— 覆盖 2026-10-11 → 10-12 长会话：
> 已交付（**9 项真实产品缺陷修复** + BRIDGE-01-04 + COMM-01-01 + **GUI-02-01 全 4 片**
> + **GUI-02-02 全 3 片 + 安装专用流程 3 片 + 另 5 项修复** + 覆盖率补强 + 多卡按"单平台可用"口径收口，均含提交号）、
> **未完成项（明确标注勿当已完成）**、需用户/平台提供才能闭合的三项、
> **12 条已知陷阱**、以及建议的下一步排序。
>
> **该文档的基线**：`HEAD == origin/main == c559a9b`；`npm run test` exit 0
> （**395 文件 / 2969 用例**）；`test:coverage` exit 0（分支 **85.02**，**余量极小**）。
>
> **下一步起点（按价值）**：GUI-02-03（历史三视图／分页按需加载／**历史与运行状态分离**／
> 查看不恢复不调模型）→ GUI-02-02 安装专用流程独立入口 → GUI-02-04（重启与隔离 tarball 验收）。
> **注意**：GUI-02-03 属决策 B，用户曾表示"**这个功能先不做**" —— 开工前宜先确认。
>
> 以下为 2026-10-10 的历史收束记录（保留备查）。

> ## ✅ 本轮进展（2026-10-13）——基线 `HEAD == origin/main == ca99608`
>
> **门禁真实退出码**：`test:coverage` **0**（stmts 92.58 / **branch 85.23** / funcs 93.03 / lines 92.6）｜
> `check` **0**（**406 文件 / 3047 用例、skipped 0**）｜`typecheck`/`lint`/`build` 均 **0**。
> （上一轮 3045 用例 → 本轮 3047：新增 2 条反例。）
>
> **① GUI-02 卡片汇总层补齐（`5a0fec8`）**：把"安装专用流程 3 片 + 另 5 项修复"的提交号
> 写进本文件 GUI-02 行与 `docs/tasks/GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD.md`
> （此前如实登记为未做，见 `1b756ca` 提交说明第 5 项）。9 个提交号已用
> `git cat-file -e` 逐个验证存在（missing=0），内容自述按 `git show --stat` 复核。
>
> **①-b 2026-11-08（第 40 轮）复核：提交号全部有效，但"几项修复"的计数前后不一致，已改正。**
> 本轮重新逐条验证上述 **9 个提交号**（3 片 + 5 项修复）：
> `1e48ed1`／`1c986f0`／`e7afc49`／`3d3f6b4`（片1/3 注册表、片2/3 通道+门面、片3/3 路由接线、片3/3 界面卡片+反例）
> 与 `ca6ee0b`／`10cfa46`／`5ebb73a`／`73e6244`／`d332ded`（安装通道 fail-closed、
> `recover abandon` 误报、CRLF 静态 `source`、权限询问误导告警、补交门面 async 修复），
> `git cat-file -e` **missing = 0**，且 `git log -1 --format=%s` 的自述与文档描述**逐条相符**。
> 但**计数写错**：本行上文原写"另 **4** 项修复"，而同一段落的 `5a0fec8` 说明与
> 卡片明细**都列了 5 项**（卡片标签**当时**写着"另 3 片 + 4 项修复"却列出 5 条，
> 该标签本轮已一并改为 5 项）—— 属**文档内部自相矛盾**。已按**实测事实**统一为
> **5 项修复**（目标描述里的"4 项"应视为漏计
> `d332ded` —— 它是"补交遗漏的门面 async 修复"，可能因被当作收尾杂务而未计入）。
> **结论**：本条**文档补齐义务已完成且经复核**（不是"未做"）；本轮只修正计数，不改任何交付事实。
>
> **② 超时型抖动：定位到两层真因（`5f0ef84` + `dbbb4d7`）**
>
> - **反馈进程重复 shutdown 白等 5s（已修）**：`ApplicationRuntime.shutdown()` 既调
>   `feedbackClient.shutdown()`，又调 `supervisor.stop()`（后者内部**再**调一次）。
>   子进程首次应答后即 `exit(0)` ⇒ 第二个请求永无应答，客户端白等
>   `requestTimeoutMilliseconds`（默认 **5_000ms**）并被 `catch {}` 静默吞掉。
>   实测：单次 stop **8ms** vs 重复序列 **5002ms**；修复后 `run-command-gaps`
>   bootstrap 用例 **5181ms → 184ms（≈28×）**，该文件 tests 汇总 **5.70s → 845ms**。
>   **不止影响测试**：`run-command.ts:152` 规定非 mock 运行时走独立反馈进程 ⇒
>   真实 Provider 运行的每次收口都多滞留约 5 秒。
> - **默认 5_000ms 对真子进程用例不足（部分已修）**：连续 9 次全量实测失败 **4/9**，
>   失败原文**全部**是 `Test timed out in 5000ms`（vitest 默认上限）。客观审计：
>   403 个测试文件中 **21 个使用子进程却完全没有 `testTimeout`**（另有 **33 个已显式给预算**
>   ⇒ 显式给预算才是本仓既有约定），其中隔离耗时最长者 **4168ms**（距 5s 仅剩 20%），
>   满载争用系数实测 **1.4–3×**。已修其中**实际翻红过**的 2 个文件
>   （各补 `vi.setConfig({ testTimeout: 60_000 })`，**未改任何断言**），修后连续 **9 次全量实测全绿**。
>
> **③ 第三层：夹具自配 20s provider 超时（已修 `5052feb`）**
>
> 干净环境重跑 `check` 仍失败 1 例，原文是
> `Provider 请求失败或超时（20000ms）` —— 这些用例**自己**传
> `--provider-request-timeout-seconds 20`，而**产品默认是 30s**
> ⇒ 满载下本地假 SSE 服务拖过 20s，**产品按自己的超时**判任务失败。
> 已把 5 个文件的夹具预算改为 **provider 120 / run 180**，并给
> `gui02-01-cli-permission-ask-registration` 补 `testTimeout: 240_000`
> （它此前无框架预算却自配 180s run）。**断言与产品代码一字未动。**
>
> **④ 最终实测（独占环境）**：`npm run check` → **exit 0**（406 文件 / 3047 用例）；
> `dbbb4d7` 后 14 次 + `86485ea` 后 6 次 = **20 次连续全量实测 0 失败**
> （vitest 超时 0、provider 超时 0）；修复前同一脚本 **4/9 失败（≈44%）**。
>
> **⑤ 尚未处置（如实保留，不宣称已修复）**
>
> - 其余 **11 个**"子进程但无 `testTimeout`"文件（隔离均 <1.5s）未纳入；
> - **每次全量运行仍残留约 41 个 `astarray-*` 临时目录**（清理泄漏，未修）；
> - 全局 `testTimeout` 方案**已于 2026-11-08 由用户明确决策：选 B（逐文件）**（全局 `testTimeout` 保持未动；只给**被实测观察到超时**的文件补 `vi.setConfig({ testTimeout: 60_000 })`）（报告 §12：全局一行 vs 逐文件 19 处）；
> - **20 次全绿在真实失败率 3% 时仍有约 54% 概率出现** ⇒ 统计上不能排除残留，
>   故**不写"抖动已彻底修复"**；
> - 故障矩阵 `load-sensitive-full-gate-flake` **仍为 `not-verified`**，已在条目内就地补记
>   本轮定位与已修项（未验证条目按矩阵纪律**不得**带证据引用）。
>   > **2026-10-21 结项（`4601e43`）**：该遗留项**已闭合** —— 复核发现全仓 410 个测试文件中
>   > **23 个真的起子进程**，其**全部 23 个都有显式 `testTimeout`**（无预算真实数量 **0**；
>   > 原先计入的 1 个只因注释里的 `spawnSync` 误命中）。新增**活的规则**
>   > `tests/architecture/subprocess-test-timeout-budget.test.ts`（违规文件当场红）。
>   > 稳定性：连续 4 次全量全绿 + 此前 14 次累计 **18 次连续 `timedOut=0`**。
>   > 条目据此改判 **`fixed`** ⇒ 矩阵审计 **`unverified=[]`、`isAccepted=true`**。
>   > 过程教训：改 `fixed` 后审计**当场拒绝**"已修但未提供证据引用（不得空口宣称）"，
>   > 补上真实引用才通过。边界：只声明配置缺口已闭合且连续实测无超时，**不宣称"永不抖动"**。
>
> **⑥ 一次方法论失误（已更正，留作教训）**：本轮曾把 `npm run check` 与另一个全量
> `npm run test` **并发**跑，叠加 `%TEMP%` 下累积的 **6260 个** `astarray-*` 残留目录，
> 得到过"26 文件失败"的**无效结果**。已中止并发、清零残留、独占重跑后才取信。
> ⇒ **门禁实测必须独占环境；并发跑同一套件的结果不可用于判定。**
>
> 详见 `docs/reports/FEEDBACK_SHUTDOWN_DUPLICATE_5S_2026-10-13.md`（含红→绿反例、
> 隔离实测表、逐次全量实测结果、§10/§12/§14 三层根因与未处置项）。

> ## ✅ 本轮进展（2026-10-13 第 2 轮）——基线 `HEAD == origin/main == f7d88ca`
>
> **门禁真实退出码**：`npm run check` **exit 0**（**406 文件 / 3047 用例、0 失败**）。
>
> **临时目录泄漏：41/次 → 1/次（`f7d88ca`）**
>
> 单次全量运行会在 `%TEMP%` 留 41 个 `astarray-*` 目录；连续 66 次累积 **6260 个**后
> 引发 `EPERM ... rename` 型门禁失败（第 1 轮实际踩到过）。按残留目录名前缀反查，根因两类：
> - **6 个文件的 `afterEach` 只恢复 mock/stdout，根本没有 `fs.rm`**
>   （其中 4 个的 `afterEach` 甚至写在 `beforeEach` 内部）⇒ 已各补一处清理；
> - `protected-storage-policy.test.ts` 在工作区**外**另建两个 `mkdtemp`（TOCTOU 换链目标）
>   却从未收口 ⇒ 已加 `outsideDirectories` 登记数组统一清理。
>
> **未改任何断言、未改产品代码。达到历史故障量级所需运行数由 ~120 次升到 ~5000 次。**
>
> **仍未修（附具体条件）**：剩 **1 个/次**，全部来自
> `tests/core/integration/reliability-git-process-tree.test.ts` —— 其夹具**孙进程**持有
> `heartbeat.txt` 句柄且存活 60s，而用例只等 6s/2.2s ⇒ `afterEach` 删除时句柄仍被占用
> （原 hook 用 `try/catch` 静默吞掉失败）。本轮两次尝试（缩短寿命、加"父死即退"看门狗）
> **均失败并已 `git checkout --` 回退**：第二次还使用例 ⓪ 由 ~6s 恶化到 12.2s。
> 该文件验证的是**产品**的进程树收口能力，动其夹具时序风险高于收益，故主动停止、
> 留作独立检查点（需先弄清孙进程为何未被产品收口杀掉）。
>
> **一条被证伪的方案（避免重走）**：vitest `setupFiles` 启动清扫 —— 其 1 小时年龄阈值
> 对连续运行**从不触发**（残留 41 → 83，反而翻倍），已完整回退。

> ## ✅ 本轮进展（2026-10-13 第 3 轮）——基线 `HEAD == origin/main == b83fc49`
>
> **收口"无预算子进程文件"（方案 B，`b83fc49`）**
>
> §12 原把处置方式列为待用户决策（A 全局 / B 逐文件）。用户未指定，按上一轮汇报中的声明
> 采用**更保守的方案 B（逐文件、每处可附实测理由）**，把剩余 **12 个**
> "使用子进程却完全没有 `testTimeout`"的文件各补一处
> `vi.setConfig({ testTimeout: 60_000 })`。
>
> **本批是纵深防御，不是已证实的抖动源**：隔离实测 12 文件一次跑完 **2.69s / 67 用例全绿**，
> 最慢单例 `toolkit01-operation-control` ④ **1010ms**，其余 742/516/324/305/300ms
> ⇒ 全部远低于默认 5_000ms。理由是同类文件已因"默认 5s + 满载争用 1.4–3×"翻红过。
> 统一取 60_000（沿用本仓既有约定，另有 30+ 文件同样用它），不逐一定制以免过度拟合。
> **未改任何断言、未改产品代码、未动全局配置。**
>
> **门禁**：`typecheck` 0 ｜ `eslint <12 文件>` 0 ｜ `vitest run <12 文件>` **0（67 用例）**
> ｜ **`npm run check` 0（406 文件 / 3047 用例、0 失败）**；`%TEMP` 残留仍 **1 个/次**（未变差）。
>
> ⇒ **"使用子进程却完全没有 `testTimeout`"的文件数现为 0。**
>
> **仍未处置（如实）**：① `reliability-git-process-tree.test.ts` 的 `astarray-git-tree-*`
> 仍 **1 个/次**（孙进程持句柄 60s；两次修法均失败已回退，详见上一轮小节）；
> ② 全局 `testTimeout` 未采纳（采用方案 B），如后续需要可再评估。

> ## ✅ 本轮进展（2026-10-13 第 4 轮）——**越权读取缺口**：发现 → **已修复**
>
> **第 5 轮已修复（`d8f2532`）**；基线 `HEAD == origin/main == 7d4d469`。
> 门禁：`check` **0（406 文件 / 3051 用例，较修复前 3047 增 4 条新反例）**、
> `test:coverage` **0**（branch **85.13**）、`typecheck`/`lint`/`build` 均 0。
>
> **修复要点（5 条，均为实测驱动）**：服务层新增"授权范围绑定真实访问对象"守卫（任何 I/O 前判定、
> 缺根即 fail-closed）；**范围判定先行**（词法、不触盘）——否则声明路径含 `..` 时两边会"同时"
> 指向越界文件而使比较通过，且比对那步会 realpath 到越界文件本身；入口层**先校验再做 I/O**
> （原 SDK 会先用绝对来源路径读文件算哈希，属"先读后判"）；判定放在**幂等认领之后**以免
> 误伤并发复用语义；用"最近存在祖先 realpath + 拼回剩余段"容忍**尚不存在的目标项目根**，
> 并比较**完整规范路径**（只比父目录会漏掉"同目录换文件名"）。
> 反例 4 条（⑨ 范围外绝对路径 / ⑩ `..` 穿越 / ⑪ 缺根 / ⑫ 目标不一致），修复前 ⑨⑩ 实测 `read-allowed`。
>
> **受保护存储（第 6 轮已补，`3d46c2d`）**：原为"尚未补"。**实测确认缺口**：
> 状态目录位于项目根内（如项目里的 `.astarray/`）且被划进授权范围时，
> 跨项目只读能读到 `backup-vault/` 内容（当时 `read-allowed` 并返回了保管库内容）。
> 已修：服务层新增可注入 `isForbiddenAccessTarget`（在"绑定 + 范围"后再校验一道，
> 仍在任何 I/O 之前）；`ProtectedStoragePolicy` 新增公共异步判定
> `isProtectedStorageAccessTarget`（词法 + realpath 别名，解析失败即 fail-closed）；
> **SDK 与 CLI 两个入口均已接线**；副本导入目标不套用来源 scope 前缀。
> 反例 2 条（资源 I/O ⑬、SDK ⑤），修复前均 `read-allowed`。
>
> **仍未完成（如实）**：PROJECT-01-04 的多项目压力验收与"人工能分辨副本与原件"
> （属外部条件/人类体验结论，须由用户或平台提供）。
>
> ### 🧪 第 8 轮新增：`npm run verify:mutation-kills`（把手工变异实验固化为可复用检查，`98240bf`）
>
> **由来（真实教训）**：上一轮 3 条"受保护存储不得访问"反例中，一条（删除审计文件）在
> **临时禁用产品判定器后仍然通过** —— 它先命中 `resource-not-found`，
> **根本没走到受保护存储判定**。⇒ **"测试通过" ≠ "测试有效"**。
>
> **做法**：对每条关键安全断言，用精确字符串替换在产品源码注入一处**反事实**，
> 跑指定用例，要求**点名的那几条必须变红**，随后**必定还原**（还原后 sha256 比对）。
> **实测 2/2 被拦下（exit 0）**：受保护存储判定短路 ⇒ ⑬⑭⑮ + SDK ⑤ 共 4 条变红；
> "完整规范路径比对"放宽成"只比父目录" ⇒ ⑫ 变红。
> **防护**：锚点命中次数 ≠ 1 时直接报脚本错误（绝不在源码改动后静默跳过）；
> 不接入 `check`（与既有 `verify:*` 一致，按需运行）。
> **仍未覆盖**：只登记了跨项目授权这 2 个变异，其余安全关键模块尚可扩展。
>
> ### 🔴 第 9 轮（TOOLKIT-01-04 复核）：查出"新增副作用须重新授权"门禁**自相矛盾**（未修，已收敛）
>
> 卡内把 04 的剩余条件写作"与 MERGE-01 的完整联测"。核实结果：
> **该联测并不存在**（`parameter-authorization` + `tool-package` 双关键字检索测试文件命中 0），
> 且查出该门禁最终只依赖**调用方自述的裸布尔值**：
> `controller:293` 判 `requiresReauthorization && !isReauthorized`，
> 而 `isReauthorized` 来自 `cli.tsx` 的 `--reauthorized` 参数（`commands.ts:5161`）。
> **实测**（v1 无副作用 → v2 含 `file-write`）：传 `false` ⇒ `isApplied=false`（门禁生效）；
> 传 `true` ⇒ **`isApplied=true`（门禁被打开）**；`ParameterAuthorizationSettings` 完全不参与。
>
> **为何是自相矛盾**：同一控制器在 `enableForProject`（`:221-229`）留有明确说明——
> "调用方传 `isReauthorized` …等于给门禁开了**旁路**"，并据此**移除**了该参数、
> 指明版本切换"**只能**走 `upgradeProjectVersion()`"；而该唯一路径恰是这个形态。
>
> **处置**：**不主张 TOOLKIT-01-04 通过**；已收敛为 5 步可开工条件
> （先红例 → 授权依据改为可核验的重新授权记录 → CLI 先展示差异再本地签发 → 补 MERGE-01 联测 → 门禁）。
> **注意**：不得为让门禁变绿而放宽差异判定。
>
> ---
>
> 以下为**第 4 轮发现时**的原始记录（保留供回归参照）。
>
> ### 🔴 2026-10-13 第 4 轮：新发现**越权读取缺口**（当时未修，已入卡）
>
> **基线**：`HEAD == origin/main == 211d026`；`npm run check` **exit 0**
> （**406 文件 / 3047 用例、0 失败**）。
>
> **缺陷（真实、可复现、优先级最高）**：`CrossProjectTransferService` 的**授权范围
> 没有绑定"真正被读取的那个文件"**。
> 实测证据（临时脚本验证后即删、未入库）：授权 `scope=["docs/"]`，声明
> `resourcePath="docs/spec.md"`（范围校验因此通过），但实传 `absoluteResourcePath`
> 指向 `docs/` 之外的 `secrets.md` ⇒
> `OUTCOME=read-allowed didRead=true`、`READ_CONTENT="# 绝不应被读到"`。
> 同源反例 `docs/../sibling.md`（前缀匹配的穿越写法）同样 `read-allowed`。
>
> **根因**：`isWithinScope`（`:516`）只对**声明的相对路径**做字符串前缀比较；
> 真正读取用的是调用方另给的 `absoluteResourcePath`（`:609/616/639`），**二者无绑定**。
> `importCopy` 与 SDK 的 `importCrossProjectResource` 同病（后者还"先读后判"）。
> **影响不止** SDK/GUI —— **CLI 路径共用同一服务，同样受影响**。
> 与 AGENTS.md「权限在工具**实际执行前**检查」冲突；既有反例④只覆盖"授权链不通过"，
> **未覆盖**"授权通过但读的不是被授权的东西"。
>
> **本轮的做法与自我更正**：先写了 2 条红例并提交，随后意识到**主干不该留红** ——
> 该提交已 `git revert`（`4967cef`），实现改动也全部 `git checkout` 回退，
> 并**重新用临时脚本复现**确认缺口仍在（证据如上），最后把发现与 5 步修复顺序写进
> `docs/tasks/PROJECT01_ISOLATION_AND_CROSS_PROJECT_BORROWING_TASK_CARD.md`。
> **`main` 已复验全绿**（`check` exit 0）。
>
> **为什么没在本轮修完（具体条件）**：锚定项目根的守卫本身已实现且 typecheck 通过，
> 但完成它必须同时给 **约 30 处既有测试调用点**与 **SDK/CLI 两个入口**补"项目根"参数
> （SDK 方法签名也要扩展）。预算不足时强行改完风险高于收益，故整体回退、留作**独立一轮**。


> **2026-10-10 第 60 轮收束（本会话最后核对）**：跨卡对账见
> `docs/reports/CROSS_CARD_RECONCILIATION_2026-10-10.md`
> （逐卡归入"本地已证实 / 仍未完成（附卡点）/ 仅用户或平台可提供"三类），
> 逐项核对结论见 `docs/reports/SESSION_HANDOFF_2026-10-10.md`。
>
> **本会话末次核对硬事实**：`HEAD == origin/main == 63d1473`，工作区干净，
> 全仓 `it.skip` = **0**。门禁真实退出码：
> `typecheck` 0 ｜ `lint` 0 ｜ `build` 0 ｜ **`check` 0**
> （**374 文件 / 2829 用例、skipped 0**）｜ `test:scripts` 0 ｜
> **`test:coverage` 0**（stmts 92.6 / **branch 85.06** / funcs 93.45 / lines 92.63）｜
> `verify:toolkit-package` **48/48** ｜ `verify:instruction-entry-package` **17/17** ｜
> `verify-mcp-bridge-loop` **20/20**。
>
> **注意（如实记录）**：同一批门禁在**负载下偶发** 1–3 条**与改动无关**的用例失败，
> **隔离复跑全绿**（本会话多次观测，含本轮 `check` 先失败后通过）。该抖动已登记进
> 可执行故障矩阵（`load-sensitive-full-gate-flake`，verdict `not-verified`），
> **未在产品代码中修复，故不标为已修**。
> > **2026-10-21 更新**：根因已定位为**配置缺口**（一批子进程测试沿用 vitest 默认 5s）
> > 并经批量补齐 —— 现全仓 23 个真子进程文件**全部**有显式预算，矩阵条目改判 **`fixed`**、
> > 审计 **`isAccepted=true`**。上句"未在产品代码中修复/不标已修"**已不再成立**，就地更正；
> > 但仍**不宣称"永不抖动"**（见下条结项说明）。
>
> > **2026-10-10 Linux 平台证据（本会话新增，WSL2 Ubuntu 26.04 / Node 22.22.1）**：
> 详见 `docs/reports/LINUX_PLATFORM_EVIDENCE_2026-10-10.md`。要点：
> ① **发现并修复一个真实的跨平台缺陷** —— `GitProcess` 超时只收口直接子进程，
> **孙进程继续运行**（进程树泄漏）；修法为 POSIX `detached: true` + `process.kill(-pid)`
> 整组收口、Windows `taskkill /T /F`；Linux 该用例修复前**确定性失败**、修复后通过，
> Windows 回归 2829/2829 无破坏。**该缺陷只有 Linux/macOS 证据能发现。**
> ② 另一个 Windows 上一直通过、Linux 上确定性失败的缺陷**当时**已定位但未修：
> 授权后重跑会因 `非法状态迁移: pending → done` 把**已落盘的成果误判为 blocked**；
> 我尝试放宽 `markDone` 的合法前置状态，**被本仓既有契约测试否证**
> （`task-graph-gaps.test.ts` 明确要求该迁移抛错）⇒ **已完整回退**，
> 正确修法在调度侧的一致性，留给后续。
> > **✅ 2026-11-08（第 54 轮）复核：该缺陷已不再复现（Linux）。** 实测（WSL2／Ubuntu 26.04／Node v22.22.1，
> > 与 Windows 同提交）：`authorization-retry-closure.test.ts ①` 在 Linux **连跑 5 次全过**；
> > 且 **Linux 全量 `npm run test` exit 0：431 文件全过、3253 passed ＋ 2 skipped、0 failed**。
> > ⇒ 上句"**定位但未修**"**已不再成立**（当前 `main` 上 Linux 侧不再出现该非法迁移）。
> > **但我没有声称"知道是谁修的"**：本轮只做**复现性判定**、**未**逐提交 bisect 归因；
> > 若日后再现，原触发链分析（`mission-orchestrator` success 分支 → `finishTask` →
> > `markDone` 仅接受 `running`）仍是起点。详见 `docs/reports/LINUX_PLATFORM_EVIDENCE_2026-10-10.md` 的复核块。
> ③ Linux 侧全量：typecheck/lint/build **exit 0**；374 文件 / 2829 用例中
> **2828 通过、1 失败**（即上述未修缺陷）。
> ④ **仍未取得**：macOS 证据（本证据来自 WSL2，非裸机 Linux）、AR-07 各平台分支的
> Linux 覆盖率单独核算。
>
**未满足门禁的项一律未标完成**；剩余项**全部依赖外部条件**
> （Linux/macOS 平台、真实 Provider 额度、用户人工体验、宿主侧持久化）。

## 2026-10-10 当前有效状态（覆盖下方历史快照）

核对基线：`22be8f5`，修改文档前工作树干净。本轮仅静态核查与计划纠偏，未重跑全量测试。历史提交和报告保留，但不能代替当前版本门禁。

| 任务/范围 | 当前状态 | 已证范围与尚缺内容 |
|---|---|---|
| RELOCATE-01 | pending（2026-10-17 新增计划） | [冷启动定位与历史恢复任务卡](docs/tasks/RELOCATE01_COLD_START_PROJECT_RELINK_TASK_CARD.md)已编制；01 身份检测 → 02 确认登记 → 03 解析/恢复 → 04 入口/tarball，全部待实施。工作中迁移不在本卡范围；未进行功能测试或提升原恢复任务验收状态。 |
| INT-00 / T07D-R1 / T09A-R1 / T12A-R1 | done（各卡既定历史验收范围） | 保留接线成果；不表示所有后续可靠性变更已经通过 <br>**✅ 2026-11-08（第 88 轮）逐条独立复核（本窗口 ④ 的延续）**：本行标 done 的四组逐条核对，**三条结论为"实测成立"、一条补记卡头**。① **`BRIDGE-01` 的行内断言逐字复跑成立**：`node scripts/verify-mcp-bridge-loop.mjs` **exit 0**、输出 `checkCount: 20`、20 项判据**全部 `isPassed: true`**（与行内"exit 0、20 项判据全过（0 失败）"一致）；其引用的 `BRIDGE01_LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md` 存在。② **`T12A-R1` 的纠偏项已修且卡表一致**：纠偏报告点名的「`recover` 未注册」**已修**（`packages/tui/src/cli/commands.ts` 有 `purpose: "recover"`），卡头写着 `状态：done（T12A-R1-01..04 全部通过）`，4 份 `T12A_R1_0x` 报告齐备。③ **`T07D-R2` 卡表一致**：卡头 `done` 并自带**范围纠偏**（历史 done 仅覆盖模块/适配器与"SDK 可导入"级），与行内"不推广为全部厂商/入口通过"同向；`T07D_R2_04_STATUS_RECONCILIATION_2026-10-06.md` 存在。④ **`T09A-R1` 发现并订正一处"镜像过期"**：`PLAN_STATUS` 与本行标 done、四份 `T09A_R1_0x` 报告（`T09A_R1_04` 明写"状态：done"）也都说已完成，**但 T09A 卡头只保留了 2026-09-10 的移交口径、从未记录移交结果** ⇒ 读者会误以为仍在移交中。**已补记**（含代码级复核：纠偏点名的"编排零装配"确已修 —— `contextNodeLifecycle` 已接入 `main-controller.ts` 的编排选项，装配层在 `application-runtime.ts` 构造传入），并**保留**该卡"历史 done 仅对应模块级证据"的边界不变。**本条不改任何验收结论**（四组 done 的口径与边界均维持原样）；**未改任何源码或测试**。 <br>**⚠️ 2026-11-08（第 105 轮）新发现的产品路径缺口（属本行"产品路径审计"职责）**：**T08 编排层 Git 集成**（worktree 分流 → 贡献审查 → 集成分支合并 → 门禁合入）**能力已实现、有 T08 编排测试，但在整条产品路径上不可达** —— 只有测试在驱动它。**证据（可复跑）**：① `new GitIntegrationCoordinator` 在 `packages/` 内**零构造点**；② 特征字段 `allowedPathsByTaskType`／`buildGitWorktreeToolPort` **只出现在类型定义**（`mission-orchestrator.ts`）**与测试 harness**；③ 装配层 `application-runtime.ts` **完全不含** `gitIntegration`⇒ 从不传给 `MainController`（其两处转发 L840／L917 因此恒为 `null`）；④ **公开门面也不接受** `gitIntegration` ⇒ **宿主也无法注入**；⑤ `packages/tui`／`packages/gui`／`scripts` 零命中。**为什么算缺口**：`AGENTS.md` 要求「涉及 Git 写入的多 Agent 任务必须由次级 Agent 负责**分支/工作树分流、差异审查、测试验证和受控合并**」—— 该规则依赖的正是这一层，而它在当前产品形态下**无从执行**。**本轮只报告与取证、不改产品**：真正接线需要一次设计决定 + 多片实施，且触及**安全关键行为**（要构造 coordinator/allocator/report store/recovery points、决定 `allowedPathsByTaskType` 策略、注入 `isTargetBranchMergeAllowed` 合并授权面、以及 assist/devolve 差异）⇒ 按纪律**不擅自改变生产默认行为**，等你决定。详见 `docs/reports/T08_GIT_INTEGRATION_PRODUCT_PATH_GAP_2026-11-08.md`。**相关（同轮）**：为"使命级失败在诊断里不可见"补了 `MissionOrchestratorOptions.missionDiagnosticEventPort`并在 `ensureGitIntegrationSession()` 的 catch 上报 `stage: "git"`（该 catch 原本只升级成用户消息就吞掉错误）；反例已先红后绿（含"上报不取代既有升级消息"）——**但如实标注：该端口尚未在装配层接线，且即使接了，因上述缺口 `git` 阶段在生产里也不会发生 ⇒ 目前是"编排器级能力 + 测试证据"，不是生产可见的改进。** <br>**⚠️ 2026-11-08（第 106 轮）产品可达性勘测（本行职责）**：因已接连抓到三处同类缺口（`PERF` 采集、`DIAG` 采集、**T08 Git 集成整层**），本轮做了**机械枚举**并落库可复跑工具 `scripts/audit-product-reachability.mjs`：口径为「生产构造 0 + **按模块路径统计**的生产提及 0 + 测试里构造 ≥1 + 能力型命名」，得 **29 个候选**（报告 `docs/reports/PRODUCT_REACHABILITY_AUDIT_2026-11-08.md`，含清单与分诊办法）。**其中"生产提及 = 0"的最可疑者 8 个**；本轮用**可靠工具（ripgrep）**只验证了 1 个：**`LocalProgressAndCycleGuard`（T07B／ADR-0017 通用活锁与循环守卫）在生产里零使用**（`packages/` 内只有 2 处命中、都在它自己文件；测试里构造 **12 次**），而 `AGENTS.md` 明令「循环调用、无进展重试和 Agent 互相回派**必须有本地检测与有界中止**」；其实现的**自环 A→A／资源环 A→B→A／回派祖先环／跨 Agent 乒乓／扇出上限／任务总调用预算（持久化）**在生产里**没有对应实现**（生产现有的 `agent-run-watchdog` 只管"模型无进展→健康探测"，`read-suppression-ledger` 只管"重复读未变化资源"，**都不是**这几类）。**本轮不改产品**：接它需要设计决定（在哪一层强制、如何"有界中止"、默认阈值是否沿用 3/12/64/16/200），且会改变生产行为 ⇒ 等你决定。**其余 28 个候选尚未逐个核实**，报告里写了"先排假阳性"的分诊顺序（模块路径引用 → 生产子类 → 门面导出 → 是否有等价内联实现 → 才算真不可达），**不得当结论使用**。**另记我自己的三次口径错误**（已修/已标注）：脚本曾把**定义文件自身**排除（把同文件内被构造的内部助手误报）；曾按**类名**统计提及（漏掉"只 import 模块常量"）；另写的 PowerShell import 检查**明显不可靠**（对装配层确有构造的类也报"零 import"）⇒ 已放弃该检查、改人工 ripgrep 抽查。 <br>**⚠️ 2026-11-08（第 107 轮）逐个核实候选（本轮 3 个已定性的 2 个是"规则未实现"）**：① **`LocalRigorPolicyEngine` 未接** ⇒「高严谨性任务由**本地规则标记**，并**强制**调用事实验证工具形成证据包」这条规则的**两半都缺**：`rigorLevel` 在生产里**没有任何产生或传递方**（只在 schema 与该引擎里），`requiredClaimIdentifier` 也只被**同样零使用**的 `completion-verifier.ts` 引用；已接通的是**工具与构建器本身**（`EvidenceBundleBuilder` 已装配、`factVerification` 可用、证据包会被校验）⇒ **模型可以调用，但没有任何东西强制它调用**。② **`ToolDocumentationRecallController`／`ToolDocumentationRecallInjector` 未接** ⇒「第一次接收某工具组给**完整公开用法**、同 revision 后续**只**注入固定提醒」的**首次/回访区分逻辑**在生产里不存在（生产确实把工具描述符交给 Provider，但是**统一**给的）。③ **`AgentCommunicationDelegationController`／`DelegatedAgentCommunicationGrantStore` 未接** ⇒沟通句柄转交能力缺失；但该规则是**许可式**（"**可**转交"）⇒ **属能力缺失，不是规则违反**（如实区分）。**另补审计口径缺口 #4**：后缀白名单漏掉 `Gate`/`Builder`/`Injector`/`Adapter` 等 ⇒规则点名的组件**进不了候选**（少报比误报更危险）⇒ 补齐后候选 **29 → 38**，新增里 `AzureOpenAiAdapter`／`BedrockConverseAdapter` **待核实**（若 Provider 注册表只注册 OpenAI 兼容那条，则属"多 Provider 支持在产品里不可达"）。详见 `docs/reports/PRODUCT_REACHABILITY_AUDIT_2026-11-08.md` §5、§6。 <br>**✅ 2026-11-08（第 108 轮）Provider 协议接线：一处"部分过期"表述 + 一次"我差点重复上报"的自纠**。起因：本轮核实可达性候选时，发现 `AzureOpenAiAdapter`／`BedrockConverseAdapter` 在生产里**只出现在各自文件**（既未注册、**也未从公开门面导出** ⇒ 产品与宿主都无法使用），我一度当作**新**缺口；**查证后确认既有报告早已记录**（`PRODUCT_PATH_ACCEPTANCE_DUAL_VENDOR_2026-10-02.md` L104–105 写着「非 OpenAI 兼容协议…适配器代码存在，但 CLI 的 `run` 只注册 `openai-compatible`」；`T07D_R2_01_PROVIDER_BASELINE.md` L13 写着「产品接线未接」）⇒ **属既定延后项，不是新发现**（这正是"先查是否已记录"这一课）。**但同一批表述里有一句已经过期**：现在 `packages/tui/src/cli/runtime-selection.ts` **两处注册点都是"按协议二选一"**（L124–129 与 L199–204：`anthropic-messages` ⇒ 注册 Anthropic，否则注册 OpenAI 兼容），且**两个注册器都已从公开门面导出** ⇒ 「CLI 的 `run` **只**注册 `openai-compatible`」**对 Anthropic 已不成立**。**精确范围（不夸大）**：`anthropic-messages` **已接**；`gemini`/`bedrock-converse`/`azure-openai` **仍未接**⇒ 既有"产品接线未接"的结论**对其余三个仍然成立**，需要的是**加日期化说明**而非改写历史结论。**处置**：按 `AGENTS.md`「共享文件不能安全修改时创建独立状态补丁、说明待集成、不覆盖他人修改」，新增 `docs/reports/STATUS_UPDATE_T07D_PROVIDER_PROTOCOL_WIRING_DRIFT_2026-11-08.md`（**未改动**任何历史报告，待集成），并订正我自己的可达性报告 §6（把"待核实"改为已核实结论 + 指向该补丁）。 <br>**⚠️ 2026-11-08（第 109 轮）已核实的**新**缺口（此前未被记录为延后项）：早停→"从检查点有界续跑"这条链在生产里断了**。规则原文（`AGENTS.md`）：「输出提前结束、缺失完成事件…时，**由本地看门狗从检查点有界续跑**，禁止无限重试或重复副作用」。**生产里确实有的**：完成事件协议与校验（`core/completion-protocol.ts`）、worker 对"缺少完成控制事件"的**拒绝结案**、DAG 的 `failureThreshold`**有界重试**、以及 mission 级的恢复检查点。**但规则点名的那条执行路径不存在**：① `ContinuationCoordinator` 与 `AgentRunWatchdog` **全仓只在自身文件出现**（从未构造/使用）；② 决策侧 `LongToolCheckpointController` 虽在装配层**构造并放进返回的运行时包**，**但全仓没有任何消费者**（该标识符仅 4 处：import／类型声明／构造／放入返回包；另有一份报告**声称它"暴露"**——暴露 ≠ 被消费）⇒ **"先原子保存检查点、再以新 `completionAttemptId` 续跑"在生产里不存在**；生产只有"拒绝结案 + 任务级有界重试"，而重试是**从头执行** ⇒「禁止重做无法确认的非幂等副作用」也**缺乏对应保障**。**⚠️ 并且这是文档与生产不一致**（可复核事实）：`IMPLEMENTATION_PLAN.md` L1059–1060、`docs/architecture.md` L138、`ADR-0015` L46、`PLAN_STATUS` 历史行 L1855–1856、`GUIDE01_04_PRODUCT_ENTRY.md` L13 **都把它写成已交付行为**且**无未接线标注**。**处置**：本轮**不改产品**（接线＝决定在哪一层执行、幂等键与检查点如何绑定、上限如何配置 ⇒ 行为变更），也**不擅自改那些架构文档**（等同于替它们下"未实现"结论）；建议由对应卡所有者二选一：**接线**，或在文档里**如实标注"当前未接线"**。详见 `docs/reports/PRODUCT_REACHABILITY_AUDIT_2026-11-08.md` §7（含"生产里确实有什么"的清单，避免夸大成"整条都没实现"）。 <br>**⚠️ 2026-11-08（第 110 轮）接线缺口总表 + 一次自我订正**。把本窗口零散发现的"**有实现、有测试、但产品里没跑**"收敛成一张可决策总表：`docs/reports/PRODUCT_WIRING_GAPS_MASTER_2026-11-08.md`（**G1–G8**，每项含**规则依据／可复跑证据／用户可见后果／接线所需决定**），并单列**文档漂移**与**尚有多少未核实**（勘测脚本 38 个候选，本表覆盖 8 项，其余未核实；脚本头已写明三条假阳性来源与分诊顺序）。**G1–G8**：G1 T08 编排层 Git 集成整层；G2 活锁与循环守卫（自环/资源环/回派/乒乓/扇出/总预算）；G3 高严谨性"标记＋强制证据包"；G4 工具说明回执（首次完整用法/同 revision 只给提醒）；G5 早停→从检查点有界续跑；G6 沟通句柄转交（**许可式**规则 ⇒ 能力缺失）；G7 Azure/Bedrock 适配器（**既定延后项**，早已记录）；G8 使命级诊断端口（第 105 轮新增，装配层未接、且因 G1 而不可能触发）。**建议决策顺序（我给出但不擅自执行）**：G3 → G2 → G5（三者都有 `AGENTS.md` 强制条款且本地可做，G3 影响面最窄）；G1 **单独决策**（最大一片，且涉及"谁能自动合并"的授权面）；G4/G6 视产品意图；G7 维持延后。**⚠️ 本轮同时做了自我订正（重要）**：我第 109 轮把 `failureThreshold` 写成"DAG 任务级有界重试"，**实测它是 `ToolFailureCounter`（工具连续失败计数，达阈值 ⇒ 暂停并反馈）**，且 `rg -n "requeue｜reschedule｜retryTask｜retryCount" packages/core/src/orchestration` **零命中** ⇒ **编排层根本不存在任务级重试机制**。该订正**加强**了 G5：早停时任务**既不续跑也不重试**，只能停在"拒绝结案"。两份文档（勘测报告、总表）均已就地订正并各加一条**自我订正说明**（以现文为准）。**另记**：我在写这条记录时被**自己的守卫**拦下过一次（note 含半角竖线会破坏表格结构）⇒ 改用全角竖线；守卫按设计生效。 <br>**⚠️ 2026-11-08（第 111 轮）新增 G9：CLI「能力就绪汇报」恒真（假保证）**。`packages/tui/src/cli/commands.ts` 的 **4 个字段** —— L2544–2546 的 `assignmentController`／`fallbackGuard` 与 L2961–2963 的 `worktreeObserver`／`staleWriteGuard` —— 都是**直接 `await import(...)` 后判 `X !== null`**，而**导入成功必然非 null ⇒ 该检查恒真**，人类可读输出**永远打印「已装配」**；但对应组件（见 G1–G7 同类证据）**实际未被装配/使用** ⇒ 用户与诊断得到**假保证**。**不夸大**：同文件 L2310–2317 的 `actionExecutor`／`workflowLifecycleController` 来自 `loadCraftsmanInfra()`（**可返回 null**）⇒ **那两处是有意义的**（我只报恒真的那 4 个）。**处置**：**本轮未改**（两种修法都改**用户可见输出** ⇒ 按纪律需你决定）：(a) **真正接线**（则检查须改为验"**实际装配**"而非"模块可加载"）；(b) **把人类可读文案改为如实的「模块可加载」**，并（可选）在 JSON 里新增"是否实际装配"的**独立字段**（不动既有键）。**同轮另修一处我自己的口径缺口 #5**：生产里 `(await import("…")).X(…)` 这种**动态导入成员调用**构造我原脚本**命中不了**⇒ 会把 `TaskSequenceManageController` **误判为"零构造"**（实测它在 `application-runtime.ts` L497 是真实构造的）；脚本已新增**「成员调用」提示列**（只提示、**不直接排除** —— `.X(` 也可能是静态方法调用，直接排除会造成**漏报**，比误报更危险）。这是本勘测的**第 5 个口径缺口**（前四个：排除定义文件、按类名统计提及、后缀白名单太窄、PowerShell 版 import 检查不可靠）⇒ **每个候选都必须人工抽查**，脚本只用于缩小范围。详见总表 G9 与勘测报告 §8。 <br>**✅ 2026-11-08（第 112 轮）先例核实与一处"已闭环"确认（含对我自己"发现"的定位）**。核实发现：本窗口的"产品不可达"发现**并不是新类型** —— `docs/reports/SECURITY_WIRING_GAP_SENSITIVE_CONTENT_AND_READ_SUPPRESSION_FINDING_2026-09-21.md`（2026-09-21）就记录过同样模式（「`SensitiveContentAccessPolicy` 与 `ReadSuppressionLedger` 在 `packages/` 内**没有任何生产构造点**」），当时同样写明「已核实、**未修改生产行为**；修复会改变用户可见行为，需显式决定」⇒ 我的总表是它的**通用化**。**✅ 并且本轮核实：那份报告的两个项目现在都已装配**：`SensitiveContentAccessPolicy`（`application-runtime.ts:371` 构造 → `:870` → `policy-wrapper.ts:368` → `builtins` L460/682/719/988 使用）与`ReadSuppressionLedger`（`:375` 构造 → `:871` → `policy-wrapper.ts:370` → `builtins` L1008/1039 使用）⇒ **最高危的那一类接线缺口在本仓库已被修好**，说明 G1–G9 值得按同样方式处置。**另辨析一处历史快照**：`DELIVERY_REPORT.md`（2026-08-12／含 2026-08-14 更正）§6.0 写「现有 tarball 不包含 T06B/T06C/T06D/T07A/T07B…不能按已交付能力使用」——**该文件自称"历史交付快照、不再代表当前状态"**，且其中 **T07B 后来已完成**（`PLAN_STATUS` L1556 与 L1879 起 Batch 4H 记录）⇒ **不要当现状读**，但可作历史依据。详见总表 §0.1／§0.2。 <br>**⚠️ 2026-11-08（第 129 轮）用户分阶段授权 + 状态纠偏**。用户已明确授权按 **G9 与状态纠偏 → G2 → G3 → G5 → G1**顺序分阶段接线，并要求：验收**必须经真实应用装配入口**、必须加「**拔掉接线，测试必须失败**」反例、每阶段末做**隔离包验证**。**❗G1 未完成前，任何文档/汇报都不得宣称"支持完整的多 Agent Git 集成流程"**（当前 T08 Git 集成整层在产品路径不可达）。**进展**：**G9 已按此标准完成**（`packages/tui/src/cli/commands.ts` 两处恒真汇报改为如实的 `modulesLoadable` + `componentsReadySemantics`；新增 `tests/tui/unit/g9-status-report-honesty.test.ts` 四条；**拔掉接线实测 4/4 失败、恢复后 4/4 通过**）。**同轮新发现 G10**：`preset list`／`concurrent status` 两个子命令**在 CLI argv 分发里没有调用点** ⇒ 用户无法从 CLI 调用（也因此 G9 的假保证到不了用户）；已记入总表 §5.2，**是否接线待用户决定**。**其余阶段（G2／G3／G5／G1）状态：未开始**，不得视为已完成。 <br>**✅ 阶段一收尾（隔离包验证，2026-11-08，第 129 轮）**：`npm pack`（`prepack` 再跑一次门禁 ⇒ **444 文件 / 3307 用例**）产出 `.tmp/astarray-0.1.0.tgz`（**273 文件 / 1.6 MB**，留在 gitignored 的 `.tmp/` 内）；`verify-package.mjs` ⇒ **exit 0**（273 文件、shebang/BOM 正确、反馈进程入口已包含）；`verify-sdk-consumer.mjs` ⇒ **exit 0**（隔离安装 41 包后跑场景，`finalStatus: done`，输出「SDK 消费者行为验证通过」）。⇒ **阶段一（G9 + 状态纠偏）三项验收齐备**；**下一阶段 = G2**，按同一标准执行。 <br>**✅ 2026-11-08（第 131 轮）阶段二（G2）完成**：`LocalProgressAndCycleGuard` 接入工具循环（before/after 双相位）并经worker→编排器→控制器→装配层→门面透传（`isProgressGuardEnabled`，**缺省 false**）。**修掉两个实测缺陷**：① 内层 `break` 跳不出外层 `while` ⇒ 加中止标志 + 迭代尾 `break`；② 签名含 `errorMessage` 而该文本带**倒计时** ⇒签名恒变、无进展永不累计 ⇒ 改为**错误只用 `errorCode`**、成功用内容哈希（**已固化为变异体**）。**三项验收齐备**：真实门面入口（`g2-progress-guard.test.ts` 2 条）＋**拔线必失败**（回退到 `8be42cc` ⇒`expected 20 to be less than or equal to 8`；恢复 ⇒ 通过，全程不经补丁文件）＋**隔离包验证**（`npm pack` 273 文件/1.6MB、`verify-package` 与 `verify-sdk-consumer` 均 exit 0）。全量：`check` exit 0（445 文件 / 3309 用例）、变异 **58/58**。**未完成（如实）**：守卫**缺省关**（是否默认启用待你决定）；**任务总调用预算的持久化尚未接线**（进程内默认实现）⇒ 该半项不算完成。 <br>**✅ 2026-11-08（第 133 轮）【已作废：该结论不成立，见同文件第 142 轮更正】**阶段三第一半（G3a）****：**本地规则标记 + 强制调用事实验证工具**。编排器用 `LocalRigorPolicyEngine.classifyRigor(task.description)`（本地版本化规则）判定高严谨性，高严谨 ⇒ 覆盖 `requiredMutatingToolNames` 追加 `factVerification`（复用既有"完成前必须调用"机制）；开关 `isHighRigorEnforcementEnabled` **缺省 false**，经控制器→装配层→门面透传。**三项验收齐备**：真实门面入口（`g3-high-rigor-evidence.test.ts` 3 条：高严谨必拦／低严谨不受影响／开关关=现状）＋**拔线必失败**（回退 `d69d514` ⇒ 第 1 条失败、2/3 仍绿；恢复 ⇒ 3/3 通过）＋**隔离包验证**（273 文件/1.6MB，两个 verify 均 exit 0）。全量：`check` **446 文件 / 3312 用例**、变异 **59/59**。**❗G3 未完成**：`EvidenceCompletionGate` 的**证据包内容门禁仍是零使用**（记为 **G3b 待做**）。同轮修掉变异脚本里一条**永不匹配**的多行 find（源 CRLF／harness LF ⇒ Windows 上多行锚点不可靠），并记入纪律。 <br>**❗ 2026-11-08（第 142 轮）更正**：本行此前写的「【已作废：该结论不成立，见同文件第 142 轮更正】**阶段三第一半（G3a）**」**不成立** ——接线与三条**负向**反例在 `main`，但**正向路径（调事实工具后应放行）至今未证**，且三次接法各有缺陷（非变更工具塞进变更类必需集／跨运行契约误伤／独立通道落地失败）。**正确接法已明确**（独立 `requiredToolNames` + `successfullyExecutedRequiredTools`），**尚未落地**。**⇒ G3a 状态改为「未完成（正向待证）」；G3 整体未完成；G5／G1 未开始；G4 仍在返修清单。**本窗口总账见总表 **§6**（含我本窗口的错误清单）。 <br>**✅ 2026-11-08（第 152–154 轮）新增防线与最终证据**：新增 **接线清单测试** `tests/core/unit/wiring-manifest.test.ts`——**双向**校验（标"已构造"的组件必须在装配/编排源码里出现 `new <类名>(`；标"设计上不可达"的组件不得被构造），清单已登记 8 项（4 已接线 + 4 已知未接线：G1／G4／G5／G3b，各带理由）；**承重已实测**（把 G1 误标为已构造 ⇒ 红；把 G2 守卫误标为不可达 ⇒ 红；复原 ⇒ 3/3 绿）。**窗口末段最终证据（第 153–154 轮实测）**：`check` **447 文件 / 3315 用例 exit 0**；变异 **59/59**；`npm pack` **273 文件 / 1.6 MB**；`verify-package` **exit 0**（打包校验通过）；`verify-sdk-consumer` **exit 0**（隔离安装后 `finalStatus: done`）。**G2 的完成边界（如实）**：守卫**缺省关**（是否默认启用属用户决策）；**任务总调用预算的持久化未接线**（进程内默认实现）⇒ 该项仍算未完成的一半。**未完成清单不变**：G3a（正向待证）／G3b／G5／G1（**未完成前不得宣称完整 Git 集成**）／G4（返修清单）／G10（待用户决定）。 <br>**⏱ 2026-11-08（第 160 轮）用户开闸时序决策**：G2／G3 的开关**在编码与流程闭合前保持关闭**；**流程闭合后、执行全流程测试之前**才打开（规则与闭合判定见总表 **§D.6**）。**当前**：G2 仅差"任务总调用预算持久化"一半；**G3 必须先修 `requiredToolNames` 独立通道**（否则开闸即过度拦截），**否则不得开闸**。 <br>**✅ 2026-11-08（第 166 轮）G2 判为闭合（附边界）**：五项闭合条件全部满足 ——① 接线齐（守卫双相位 + 账本端口 + 开关四层透传 + 清单登记）；② **正向 + 负向反例都绿**（负向 3 条：重复调用中止／预算耗尽／**跨重启不清零**；正向 1 条：守卫开 + 正常任务 ⇒ done；另有"守卫关"对照）；③ **拔线必失败**（回退装配层到 `990b568` ⇒ `expected 17 to be ≤ 2`；恢复 ⇒ 通过）；④ 隔离包（`npm pack` 273 文件，两个 verify exit 0）；⑤ 接线清单 + 变异体（60/60）。**❗边界（与闭合同读）**：开关**缺省关**⇒生产中尚未生效（按用户 §D.6 的开闸时序）；**handoff 与早停续跑路径尚不存在**，落地时须重验账本键；**T07E 的工作集预算/10 文件门禁/防 Agent 分裂/规范资源身份计数未实现，本窗口从未声称实现**。详见总表 **§13**。 <br>**📌 2026-11-08（第 206 轮）窗口 171–206 最终状态同步**（与总表 §17.7 一致）：**闭合三项**：G9+状态纠偏、G2（守卫+任务链预算持久化）、**G10（`preset list`/`concurrent status` 接入 CLI 分发，argv 级 2/2 + 拔线必失败 + 隔离包）**；**G3a**：3/5 步已提交（`bd35cf6`/`2a727ef`/`e229064`），**第 4 步被 §15 阻断**（`factVerification` 在 assist/devolve 均 `tool-permission-denied` 且不在 45 项可配置能力内）⇒ **等用户决策 (a)/(b)**；**G5**：早停回调三段已贯通（`36abd27`/`76e3f04`/`d1da326`，行为中性），**有界续跑未实现**（下一步四个动作见 §16.4.2）；**G1**：有效红反例就绪（§8.5），**未接线**；**G3b** 未开始；**G4** 保留在返修清单。**验证矩阵**：`check` **450 文件 / 3319 用例**（第 202 轮）、变异 **60/60**（第 203 轮）、隔离包三项 exit 0（第 197 轮）。**所有开关缺省关**（§D.6 开闸时序未到）。 <br>**📌 2026-11-08（第 222 轮）G3a／G3b 闭合（**覆盖第 206 轮**"G3a 被阻断"的旧状态）**：**G3a 真因与修复**：`factVerification` 未登记在 `local-sensitive-operation-classifier.ts` 的 `TOOL_NAME_CLASS`⇒ 被判 `unknown` ⇒ 触发安装门禁 ⇒ assist 无头环境 fail-closed 拒绝；**已登记为 `network-access`**（`fbb7794`）。**G3b**：工具循环新增 `onToolSucceeded`（`78a3f42`）；worker 捕获 `factVerification` 输出并把 `EvidenceCompletionGate`接入完成门禁（`a2c84f7`）；高严谨 spread 一并开启 `isHighRigorEvidenceRequired`（`0681aca`）。**验收**：`g3a-positive-path` + `g3b-evidence-content`(2) + `g3-high-rigor-evidence`(3) 全绿；**拔线两次**（回退 `0681aca^` ⇒ G3b ①红②绿；回退登记 ⇒ 安装门禁再现）；**门禁 452 文件／3322 用例**、**变异 60/60**、**隔离包 273 文件三项 exit 0**。**仍未完成**：G5 有界续跑、G1 接线、G4（保留）、G3b 的"合格证据包可产出"路径（`evidenceBundleBuilder` 仍未接线 ⇒ 真高严谨任务目前**无法**结案，这是下一项已知缺口，不得声称支持）。**所有开关缺省关**。 <br>**📌 2026-11-08（第 242 轮）G5 闭合**：有界续跑端到端跑通（`abea537`）。真因：开关被转发进 `workerFactories` 而编排器读顶层 ⇒ 恒 undefined；已移到顶层。反例 2/2 绿（①续跑后 done；②有界失败 ≤3 次尝试）、拔线 2/2 红、`check` **454/3325**、变异 **60/60**、隔离包三项 exit 0。**开关仍缺省关**；**未接线**：续跑前取 `selectLatestTrustedCheckpoint`（后续增强，不在声称范围）。 <br>**📌 2026-11-08（第 249 轮）窗口 241–249 收尾**：**G5 闭合**（有界续跑：反例 2/2、拔线 2/2、`check` 454/3325、变异 60/60、隔离包 exit 0）；**G1 Step 1／2 落地**（门面 `gitIntegration?` + 四件套构造 + `startIntegrationSession` + 真实 `git init` 仓库端到端 2/2，含"目标分支未被改动"实证）；**当前基线 `check` 456/3328、变异 60/60、包 273 文件**。**明确未做**：G1 编排层接线（需选 §20.2 的 A/B/C）、G4 工具说明回执（组件在、接线为零）、Step 3 受控合并（需授权）。**所有开关缺省关**。 |
| T07D-R2 | done（2026-10-06） | 真实 tarball 读写工作流及范围对账见 `docs/reports/T07D_R2_04_STATUS_RECONCILIATION_2026-10-06.md`；不推广为全部厂商/入口通过 |
| SUM-01 / SUM-02 / GUIDE-01 | re-verifying（**SUM-01 本轮补上三类来源适配器**） | 已有实现、入口和包/计量报告，非未开始；逐条核对卡内剩余验收，再收口；见 SUM01_04B、SUM02_04、GUIDE01_04 报告。**SUM-01-04 本轮进展**：卡内要求覆盖"会话历史、工作存档、报告和延后文件"，实测**只有工作存档适配器**（类型写了、能力没实现）⇒ 新增 `buildConversationSummaryEntries`（来源标识 `会话#轮次`）、`buildReportSummaryEntries`（`报告#任务`）、`buildDeferredFileSummaryEntries`（`文件#起始行-结束行`，**同文件不同行区间是不同条目**）；共同保证确定性排序/哈希、**重复不双计**、revision 从 1 单调重排、不改写正文、非法项跳过、空输入不伪造；四类已由 public-sdk 公开导出并从构建产物实测可达；反例先红后绿 9 条（实现前 9 红）。**仍未完成**：三类来源的**真实数据源接线**（尚未从会话事件流/报告存档/延后文件存储真实取数）、旧文件迁移、触发阈值测量、多设备重复测量。**SUM-01-04 二次进展（本轮）**：上一轮补的三个适配器在**公开入口不可达**（`summarizeArchivedMission()` 只处理 work-archive）⇒ 新增 `AstarrayApplicationFacade.publishSummarySource()`，按 `sourceKind` 分派并真实发布；载荷与种类用**可辨识联合**在类型层绑定、未知种类 fail-closed；空来源 ⇒ `entryCount=0`/`manifestRevision=0`（不发布空清单冒充成功）。反例先红后绿 5 条（实现前 5 红）见 `tests/core/integration/sum01-publish-source-kinds.test.ts`。**SUM-01-04 三次进展（本轮）**：补上**报告来源的真实数据源接线** —— 新增 `AstarrayApplicationFacade.publishReportSummarySourceFromArchive()`：读**真实**报告存档（`stateDirectory/main-agent-reports`）的索引与正文，映射为可回溯条目（`报告#任务`）后**复用**既有 `publishSummarySource()` 发布；**空任务** ⇒ `entryCount:0`/`manifestRevision:0`（不发布空清单冒充成功）；索引有而正文不可读 ⇒ **逐条跳过**不让整批失败。反例先红后绿 **4 条**（含**跨重启**证明真的从磁盘取数、以及发布后可从 `listSummarySources()` 查到）。**过程中按实测纠正自身两处错误假设**：存档根是 `stateDirectory/main-agent-reports`；`PublicSummarySourceSummary` **无 `entryCount` 字段**且不存在 `querySummaryIndex()`。**本轮另做全仓核查并提出重要结论（如实记录）**：`conversation` 与 `deferred-file` **虽在 schema 里是合法来源种类，但本仓没有生产它们的本地存储** —— 全仓无会话轮次持久化；`deferred-file` 仅出现在 schema 与适配器中、**没有任何写入方**。故这两类**只能由调用方提供条目**（宿主侧自行持久化）。**不新造假存储去喂它们**（卡内"无真实 usage 标为未测，不杜撰"），并已在 `publishSummarySource()` 文档注释中**就地记录该边界与核查依据**。**SUM-01-02 旧文件迁移判定（本轮交付）**：`summaryManifestSchema` 是 `.strict()` 且要求 `chunkChainHash`/`manifestIntegrityHash` ⇒ **历史清单根本读不出来**（`readManifest()` 抛 `journal-corrupted`），而全仓此前**没有迁移判定入口** ⇒ 卡内点名的"旧文件迁移"没有判定点。新增 `SummaryIndexStore.detectLegacyManifests()`（**只读**）：逐条判定缺字段/schema 不符/非法 JSON/**缺 manifest.json**/种类未知，并给出**可读原因**；无 `summaries` 目录 ⇒ 空报告（**不虚构待迁移项**）；另一 Agent 清单不串数据；**零写文件**由 `fs.writeFile` 监视器断言（卡内"读取不触发全文重摘要"）。反例先红后绿 **10 条**。**只判定不迁移**：真正迁移须走 `publishManifest` 的 CAS 原子发布 + `single-flight`，以免"崩溃留下新摘要指旧正文"。**迁移执行已交付（本轮）**：`migrateLegacyManifests()` —— **先备份并移走**旧清单（否则 `advanceSummaryGeneration()` 第一步 `readManifest()` 就抛 `journal-corrupted`，迁移永远开始不了），再复用既有生成服务（pending 续跑 + single-flight + CAS 原子发布）；迁移后来源可读、`generatorVersion` 为**可区分的迁移版本**；**幂等**（第二次零改动）；**逐条独立**（单条失败不中止整批，失败如实进 `failedEntries`，方法**不抛错**）；缺重建条目记入 skipped 而**不伪造**。**过程中修掉三个真实缺陷**：① **崩溃恢复不可能**（备份名带时间戳 ⇒ 认不出"迁移中断"；改为**确定性备份名** + 把"无清单但有迁移备份"识别为**中断需重试**，重试**不再二次备份**以免覆盖备份卡死恢复）；② `detectLegacyManifests` **排序不确定**（`readdir` 顺序泄漏 ⇒ 两次运行顺序可能不同；补 `sourceKind` 比较键）；③ 移除校验异常里**永远走不到的假分支**（zod 只抛 `Error` 子类）。反例先红后绿 **8 条**。**仍未完成**：会话历史与延后文件的**真实数据源**（需宿主侧持久化）、触发阈值测量、多设备重复测量 ⇒ 不主张 SUM-01 通过。 <br>**✅ 2026-11-08（第 87 轮）卡片一致性核对（本窗口第 4 次抓到过期结论）**：核对 `SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md` 时发现**该卡尾部 L116 写着「实施未开始」**，而**该卡自己的 L3 对账**早就记着「SUM-01/SUM-02/GUIDE-01 为 re-verifying（已有实现与后续入口报告，**非未开始**），EVENT-01 为 pending」⇒ **尾部与头部自相矛盾**，且与实测不符。**本轮核对证据**：**13 份按检查点报告**（SUM01_01/02/03/04A/04B、SUM02_01..04、GUIDE01_01..04）、`packages/core/src/runtime-guidance/` **6 个模块**（含 `guidance-control-queue`／`long-tool-checkpoint`／指导变更意图与提交日志）、`measurement/`（`token-measurement`／`summary-fact-verification`／`measurement-cache`）与 `summarization/`（清单/索引/生成/读取）；**测试 23 文件 / 144 用例全部通过**（`npx vitest run` 指定这 23 个文件，**exit 0**、2.83s）。**已订正 4 处**：尾部「实施未开始」**就地作废**（保留原句并标注否证依据）；SUM-01／SUM-02／GUIDE-01 三处卡头「状态pending」加注**对账口径**（`re-verifying` —— 已有实现与报告，**验收未通过**）以免被读成"未开始"。**未动的部分（如实）**：**验收仍未通过** —— 各报告内有明确未完成项（例如 `GUIDE01_04` 记「升级执行两次均在审批通道等待 600…」）；**EVENT-01 相反：全仓无 incident／仲裁实现、无报告** ⇒ 其 pending **准确，未改**。**本行此前的"仍未完成"四项仍然成立**（会话历史与延后文件的真实数据源需宿主侧持久化、触发阈值测量、多设备重复测量）⇒ **不主张 SUM-01 通过**。本轮**未改任何源码或测试**。 <br>**✅ 2026-11-08（第 90 轮）：`SUM-01` 的「触发阈值测量」已做** —— 本行"仍未完成"四项中**唯一不依赖宿主持久化**的一条。卡内 L29 要求「更新以**新增内容量**和阶段检查点触发，**具体阈值由 01 测量决定**」，且 `SUM01_01` 报告 L54 如实记着"尚未冻结"。**测量方式**（`tests/core/integration/sum01-trigger-threshold-measurement.test.ts`，**exit 0**）：走**真实产品路径** —— 用产品 `MainAgentReportArchiveIngestor` 把 **50 条**报告逐条写入**真实存档**（`stateDirectory/main-agent-reports`），再用**真实发布入口** `publishReportSummarySourceFromArchive()` 按"每新增 K 条触发一次"发布，比较 K ∈ {1,2,5,10,25} 的代价与滞后。**实测（两次运行条目数完全一致 ⇒ 确定性量）**：K=1 ⇒ 发布 50 次、重推导 **1275**、覆盖 50、**冗余率 0.9608**、滞后 0、945ms；K=2 ⇒ 650 / 0.9231 / 滞后 1；**K=5 ⇒ 275 / 0.8182 / 滞后 4 / 200ms**；K=10 ⇒ 150 / 0.6667 / 滞后 9 / 114ms；K=25 ⇒ 75 / 0.3333 / 滞后 24 / 73ms（冗余率 = 1 − 最终覆盖/重推导总量）。**三条硬事实**：① **最终覆盖恒为 50** —— 无论 K 多大**都不丢内容**（阈值只影响代价与新鲜度）；② **K=1 代价极高**（同一份最终覆盖重推导 ≈ **25.5 倍**）；③ 冗余率随 K **单调降**、滞后随 K **单调升**（两条单调性已**钉成断言**，防止将来改动悄悄反转方向）。**建议暂定冻结点 K = 5**（每新增 5 条或每到一个阶段检查点触发）：滞后 ≤4 条（占窗口 8%）、冗余率 0.82（相对 K=1 **省约 4.6 倍**）、200ms。**⛔ 未测（不报零）**：卡内要求的「**任务回访质量**」**须人工标注** —— `SUM-02-04` 的评估器明确要求 `labelSource: "human"`、**拒绝生成模型自评**⇒ 本轮未测，也不以模型输出替代；另如实说明：冗余率是在**当前"每次重建整份清单"的实现**下测得的（改为增量发布须**重测**）、只覆盖**报告**一种来源（另两类在本仓无生产写入方）、滞后以条目数计**未换算为时间**。**⇒ 本条把该项推进到"已测、待质量侧确认"；`SUM-01` 其余未完成项不变，仍不主张通过。** <br>**✅ 2026-11-08（第 91 轮）：`GUIDE-01` 逐检查点核对 + 补齐一处「测试名夸大覆盖面」的真实缺口。****核对结论（按内容盘点，非按文件名）**：全仓**6 个测试文件**按内容引用 `GUIDE-01`（`guidance-change-product-entry`、`guidance-product-entry`、`guidance-safe-point`、**`long-tool-checkpoint`**、`runtime-guidance`、**`tests/tui/integration/guide-cli`**）；连同 `guidance-change-intent`、`guidance-change-poset-insertion`、`reliability-guidance-journal-integrity`，**9 文件 / 52 用例全部通过**（exit 0）。逐条：**01** 伪造/过期/乱序/重放/跨作用域与"Agent 来源不得占层级 0"**均有断言**（如 `it("新建任务：用户可层级 0；Agent/工具来源层级 0 被拒；重复标识被拒")`）；但卡内同条的「**紧急等级不篡改 task priorityTier**」按卡内说明属「**EVENT-01 通过后开放紧急仲裁**」⇒ **待 EVENT-01**，不算本卡缺口（EVENT-01 确无实现）。**02** 「busy 期间即时应用」「**普通报告不唤醒主 Agent**」「同指导幂等」**均有真实用例**（如 `it("普通报告入队不唤醒主 Agent（仅排队待读）")`、`it("跨进程投递：指导走 instruction、报告走 success，均不唤醒主 Agent")`）。**03** 「不假定在途插入」「未知停止结果 blocked」「旧完成声明失效」**均有用例**。**04** 产品/CLI 入口有 `guide-cli` 等覆盖。**⛔ 发现并补齐的真实缺口**：用例 `it("watchdog 不误续跑旧指令/未收敛取消")` 的**名字**写了"旧指令"，但其 `toEqual` 断言**只覆盖** `no-active-cancellation`／`cancellation-active`／`unknown-stop-outcome` 三条分支；而生产代码里真正对应"旧指令"的第四条分支 **`instruction-superseded` 全仓零覆盖**（按内容检索 `instruction-superseded` **无任何命中**；变异探针也印证：把该分支 `shouldResume` 由 false 改成 true，**该用例照旧全绿**）。**处置（先红后绿）**：把该用例**改名为它真正覆盖的内容**（"未收敛取消（cancellation-active / unknown-stop-outcome）"），**新增**一条真正到达该分支的反例 —— 「被新指导取代的旧请求，必须拒绝按旧 instructionRevision 续跑」；写这条时**第一版没到该分支**（实测报 `cancellation-active`），从而查明并记录**分支顺序**：必须先让后继请求进入 `acknowledged-completed`（**不属于**"仍活跃取消"集合）才可能到达 `instruction-superseded`。**变异探针**：把该分支 `shouldResume` 翻成 true ⇒ **新用例当场红（1 failed / 7 passed）**；还原后 sha256 **一致**、`git diff` **为空** ⇒ 该分支**现在有守卫**。**我自己的口径失误也如实记**：第一次按**文件名**筛 guidance 测试，漏掉了 `long-tool-checkpoint.test.ts` 与 `guide-cli.test.ts`（名字里没有 guidance）⇒ 已改为**按内容**盘点。**本轮未改任何生产代码**（只加/改测试）。 <br>**✅ 2026-11-08（第 92 轮）变异体验收**：本组守卫已纳入**永久**变异验证 —— `guide01-watchdog-resumes-superseded-instruction`（把"被新指导取代的旧指令不得续跑"改成照样续跑）被 `verify-mutation-kills` 拦下；全量 **30/30 被拦下**（扩容前 28）。 |
| EVENT-01 | pending | 本轮未取得完成证据，不凭 GUIDE 完成推断 |
| OBS（PERF/USAGE/DIAG） | **re-verifying（2026-10-10 本轮复跑包级入口：`verify:observability-entry-package` exit 0、8/8）** | 存储、查询、部分采集及包级概览成立；**每卡 3 个检查点共 9 项**（PERF/USAGE/DIAG × 3），逐组核对全部生产采集与入口范围仍需完成，**非整体未实施**；审计报告 `docs/reports/OBS_01_01_AUDIT_AND_EVENT_CONTRACT_2026-10-02.md` <br>**2026-11-08 逐检查点对账（本窗口）**：本行原记「每卡 3 个检查点共 9 项，逐组核对全部生产采集与入口范围仍需完成」——**本轮做完了这项对账**。**证据基线（可复跑）**：相关 **16 文件 / 104 用例全部通过**（`npx vitest run` 指定该 16 个文件，**exit 0**、2.47s）；实现为 `perf-event-store.ts`（515 行）／`usage-ledger-store.ts`／`diagnostic-event-store.ts`；入口与包级为 `cli-observability-entry`／`gui-observability-overview` 与 `scripts/verify-observability-entry-package.mjs`（本行已记 2026-10-10 实跑 **8/8**）。**逐项结论：9 项中 8 项有据可核**；三条容易被含糊过去的验收我也逐条查了断言 —— 「休息时不产生模型/业务请求」与「长会话内存有界」在 `perf-overview-command.test.ts`、「不泄漏其他个体明细」在 `usage-overview-query.test.ts`。**唯一未覆盖 = `PERF-01-01` 的「测量」**：其要求「用**同一工作负载**测**开关前后** CPU/内存/延迟，**记录设备与样本**」，而在 `docs/` 全量检索相关关键词（采样预算、CPU 占用、内存峰值、rss、设备与样本、开关前后）**除本卡与一处 ADR 外无命中** ⇒ **没有测量记录**。**为什么不能省**：卡内明写「观察开销预算**先测再定**，不预填性能提升或费用节省百分比」⇒ 不测就**给不出开销预算**。**本轮不做、下一轮做的原因**：测量需要一段稳定工作负载与可比的开关对照，属**独立一片**，按卡内「每轮只做一个检查点」的纪律留作下一轮。**⇒ 仍不主张 OBS 整卡通过**；详见 `docs/reports/OBS01_RECONCILIATION_2026-11-08.md`。 <br>**⚠️ 同日修正（第 82 轮）：上一版漏核了「生产采集」这一半 —— 结论应下调。** `PLAN_STATUS` 原话要求核对「**全部生产采集**与入口范围」，我上一版只核了**入口与测试**。补齐后的实测（逐组给出**生产写入方**）：① **USAGE：已接线** —— `public-sdk.ts:1512` 在生产装配里构造 `providerUsageObserver`；② **PERF：无采集** —— `perfSampleSink` 全仓**只在 `runtime/tool-loop.ts` 声明、只有 1 个测试传入**；`runToolLoop` 的两处**生产**调用（`main-controller.ts:776`、`worker-agent.ts:284`）**都不传**；`PerfEventStore` 在生产里**只**于 `gui-server.ts:2079`／`commands.ts:1894` 被构造，**用于查询**；③ **DIAG：无采集** —— 生产里**没有任何地方构造 `DiagnosticEvent`**，`DiagnosticEventStore` 的生产构造点（`commands.ts:1605`、`gui-server.ts:2085`）同样**只用于查询**，其写入方法 `append` **只被测试调用**。⇒ **修正后的逐项结论：入口与查询面齐全且有测试，但 `PERF` 与 `DIAG` 两组的「生产采集」未接线** （属于本仓反复点名的「**组件存在但产品不可达**」；与我第 74/75 轮在 PROJECT-01 上抓到的是同类）。**因此 `PERF-01-01` 的「开关前后」测量在生产里无法进行**（没有生产开关）。**这不是新发现**：`scripts/verify-u2-flash-token-usage.mjs:14` **早就记着**「`perfSampleSink` 只被 `runtime/tool-loop.ts` 声明、**未接线到应用装配**」——只是**没有反映到本卡的检查点状态里**（我上一版也没核到）。**下一轮的有界做法**：把 `perfSampleSink` 接进生产装配（上面两处 `runToolLoop` 调用），并加一条「**生产路径确实产生样本**」的反例测试 —— 短路修复，且做完 `PERF-01-01` 的测量才成为可能。**⇒ 仍不主张 OBS 整卡通过**（且比上一版结论更严格）。 <br>**✅ 2026-11-08（第 83 轮）：`PERF` 的「生产采集」已接通**（此前 PERF/DIAG 两组的生产采集都断）。**接线（5 处，全部为可选能力，缺省不影响既有行为）**：① `tool-loop.ts` 导出 `ToolLoopPerfSample`／`ToolLoopPerfSampleSink` 类型；② `worker-agent.ts` 新增可选 `perfSampleSink` 并转交工具循环；③ `mission-orchestrator.ts` 的 `OrchestratorWorkerFactories` 新增 `perfSamplePort`，并在构造每个 worker 时就地**补齐身份**（`sourceAgentInstanceId`＝该 worker、`missionIdentifier`＝本 mission、`taskIdentifier`＝该任务）—— **这是不能只用一个全局 sink 的原因**：工具循环的样本载荷不含身份，而这些字段在事件信封里是必填；④ `main-controller.ts` 新增同名端口并转发进两处 `workerFactories`；⑤ `application-runtime.ts` 按开关构造 `PerfEventStore`（状态目录与 CLI/GUI 查询侧**同一目录**）并把样本追加进去；观测失败**不得阻塞业务**（沿用既定纪律）。**开关**：门面新增 `isPerformanceCollectionEnabled`，**缺省 false** —— 因为本卡明写「观察开销预算**先测再定**」，**不在未测量开销时默认打开**每次工具调用追加一行的行为。**反例（先红后绿）**：`tests/core/integration/obs01-perf-production-collection.test.ts` 两条 —— ① 用**脚本文本 Provider** 让模型真的发起一次工具调用（`readFile`，避开写类授权门禁；断言**不依赖 outcome**），然后同时从**原始样本**与**产品查询面**（`queryPerfOverview`）断言"生产确实采集了"、且身份/任务**已补齐**（`sourceAgentInstanceId` 非空、`missionIdentifier` 非空）；**首跑红**：`生产路径必须产生性能样本…expected 0 to be >= 1`；② **缺省必须不采集**（防有人把未测开销默认打开）。**变异探针**：把编排器传给 worker 的 sink 去掉 ⇒ ① **当场红**；还原后 sha256 **一致** ⇒ 接线承重。**门禁**：`build` 0 ｜ `check` **0（440 文件 / 3288 用例、无 FAIL）** —— **既有用例全部未受影响**（开关默认关 ⇒ 行为不变）。**仍未做（如实）**：① **`DIAG` 的生产采集**同样未接线（生产里无人构造 `DiagnosticEvent`，store 只被构造用于查询）⇒ 下一片；② **`PERF-01-01` 的开销测量**（本卡要求"先测再定"）**现在才成为可能** —— 开关已可打开，下一轮做同负载开关前后对照（CPU/RSS/延迟分位 + 设备 + 样本量，**无法测量不报零**）。**⇒ 仍不主张 OBS 整卡通过。** <br>**✅ 2026-11-08（第 84 轮）：`PERF-01-01` 的「测量」已补上** —— 即本行第 81 轮标记的**唯一未覆盖项**。脚本 `scripts/measure-perf-collection-overhead.mjs`（**exit 0**、**测构建产物** `dist/public-sdk.js`）；口径**已冻结**并写进脚本：同一工作负载（单次工具执行后上报一个样本）、关＝空转基线（生产中开关关时**根本不调用 sink**）、开＝`await` 真实 JSONL 落库、**2000 样本/轮 × 3 轮 × 3 次独立整跑**、预热 200、逐轮交替顺序、延迟取中位、CPU 用 `process.cpuUsage()`、内存用轮前/轮后 RSS＋25ms 轮询峰值。**设备**（如实记录，**仅本机**）：win32／Windows 11（内核 10.0.26100）、x64、i7-13700HX（24 逻辑核）、15.7GB、**Node v24.18.0**。**结果（3 次独立整跑）**：每次观测 **+263–275 µs 墙上时间**、**+227–266 µs CPU**、**落库 382.4 B/样本**（三次**完全一致**，确定性量）；轮询 RSS 增量 475–979 KB/2000 样本（受 GC 与内存保留共同影响）；内存保留上限 `DEFAULT_MAXIMUM_PENDING_SAMPLE_COUNT = 1000`（**有界**，超出计入 `droppedSampleCount`，不静默当零）。**⇒ 建议的观察开销预算（提案，待确认）**：单次观测新增延迟 **≤ 2 ms**、落库 **≤ 1 KB/次**、内存保留受 1000 条上限约束 —— 实测 ≈0.27 ms ⇒ 留约 **7 倍余量**，既不至于因机器差异误报，也不允许观测膨胀到用户可感知量级。**⚠️ 未测项（不报零）**：① **跨平台（Linux／macOS）未实测**（本机 Windows；文件 I/O 与文件系统强相关，**不得外推**）；② 精确峰值内存未测得（仅 25ms 轮询值）；③ 真实 Provider 端到端延迟影响未测（本脚本只测观测本身，不假装测了模型往返）；④ 未区分页面缓存命中与真实落盘。**⚠️ 本轮还修掉我自己的一个测量 bug**：第一版只扫 `baseDirectory` **根目录**量落库字节，而 store 写在 **`<目录>/perf/samples.jsonl`（子目录）** ⇒ 第一版输出 **`0 B/样本`**，那正是本卡禁止的「**无法测量不报零**」；已改为量真实路径且**量不到返回 `null`（不返回 0）**，修后三轮均 382.4 B/样本。**不改默认值**：采集**仍缺省关**（本卡"先测再定"⇒ 现在**测完了**，默认是否改为开**属决策事项**，我不擅自改）。**⇒ 仍不主张 OBS 整卡通过**；`DIAG` 的生产采集**仍未接线**（生产里无人构造 `DiagnosticEvent`）⇒ 仍是待办片。详见 `docs/reports/OBS01_PERF01_01_OVERHEAD_MEASUREMENT_2026-11-08.md`。 <br>**✅ 2026-11-08（第 85 轮）：`DIAG` 的「生产采集」也接通了** —— 至此 PERF 与 DIAG 两组的采集都不再是断的。**缺口回顾（第 82 轮查实）**：生产里**没有任何地方构造 `DiagnosticEvent`**，`DiagnosticEventStore` 只在 CLI/GUI 被构造**用于查询**，其写入方法 `append` **只被测试调用** ⇒ `queryDiagnosticSummary` 在生产里恒"不可报告"。**接线（7 处，全部可选、缺省不改行为）**：① `policy-wrapper.ts` **导出既有的 `isExecutionRefusalErrorCode`**（复用而非复制判定）；② `tool-loop.ts` 新增可选 `diagnosticEventSink`，**只在真实执行失败时**上报，并按卡内硬约束**过滤掉取消与执行前拒绝**；③ `worker-agent.ts` 转交；④ `mission-orchestrator.ts` 的 `workerFactories` 新增 `diagnosticEventPort` 并**就地补齐身份**（`sourceAgentInstanceId`／`missionIdentifier`／`taskIdentifier`）与**组件标识**（`tool:<工具名>`）；⑤ `main-controller.ts` 新增同名端口并转发进**两处** `workerFactories`；⑥ `application-runtime.ts` 按开关构造 `DiagnosticEventStore`（与 CLI/GUI 查询侧**同一状态目录**）并 `append`；⑦ 门面新增 `isDiagnosticCollectionEnabled`（**缺省 false**）。观测失败一律**不阻塞业务**。**卡内硬约束（本片守得最紧的一条）**：』正常计划暂停、**用户拒绝、取消**与程序故障**分开，不把等待都记成失败』—— `permission-ask-pending`／`tool-permission-denied`／`tool-not-found`／`sensitive-content-read-denied`／`auth-scope-awaiting-user-authorization`／`auth-scope-denied` 等**执行前拒绝**，以及 `provider-cancelled`（取消），**一律不产生故障事件**。**反例（先红后绿）**：`tests/core/integration/obs01-diag-production-collection.test.ts` 三条 —— ① 真故障（`readFile` 读不存在的文件）**必须**被采集，且**产品查询面** `queryDiagnosticSummary` 必须**可报告**并把它列为**确定事实**；② **执行前拒绝（工具不存在）不得记成故障**；③ **缺省不采集**。首跑：① 红 —— `生产路径必须产生诊断事件（当前为 0 ⇒ 生产里无人构造 DiagnosticEvent）: expected 0 to be >= 1`；②③ 绿。**变异探针两个**：A 去掉拒绝过滤 ⇒ **② 当场红**（证明该过滤**承重**，不是空设）；B 编排器不把 sink 交给 worker ⇒ **① 当场红**；两者还原后 sha256 **一致**。**门禁**：`build` 0 ｜ `check` **0（441 文件 / 3291 用例、无 FAIL）** —— 既有用例全未受影响（开关缺省关）。**仍未做（如实）**：开关**缺省关**，是否默认开启**属决策事项**（我不擅自改）；采样来源目前只覆盖"工具真实执行失败"一条路径，Provider 失败／Git 失败／恢复分类等**其它错误路径尚未接入**（`stage` 类型已为它们预留）；**⇒ 仍不主张 OBS 整卡通过。** <br>**✅ 2026-11-08（第 86 轮）：`DIAG` 采集接入第二条错误路径 —— Provider 失败**（`stage=provider`）。第 85 轮只接了"工具真实执行失败"一条；本轮把**运行时（Provider）失败**也接上，这是诊断里最常被追的一类（模型调用失败／超时／非 2xx）。**做法（最小侵入）**：`runtime.run(...)` 是**异步迭代器**，失败发生在迭代过程中 ⇒ 新增 `reportProviderFailures`**包装迭代器**（只加观测、**不动近百行的循环体**），在 `for await` 处包住它；`errorCode` 取 `DomainError.errorCode`（拿不到则 `provider-request-failed`），`stage: "provider"`，`toolName: null`；**组件标识按阶段给**（工具失败＝`tool:<工具名>`；Provider 失败＝`provider-runtime`）⇒ 同一错误码在不同组件下**指纹不同**（卡内：相同文本不保证同因）。**两条硬纪律**：① **绝不吞错** —— 上报后**原样 rethrow**；② **观测失败不得阻塞业务**。**不上报**：调用方取消时（`cancellationSignal.aborted`）—— 卡内「取消不得记成故障」。**反例（先红后绿）**：新增两条用例 —— ④ 真 Provider 失败（假服务恒回 503）必须产生 `stage=provider` 事件、组件为 `provider-runtime`、带稳定错误码与 mission 身份；⑤ **直接对沙盒**：runtime 抛错时必须**既上报、又让调用方收到异常**。**⚠️ 本轮我自己的一个测试缺陷（值得记）**：④ 里我原先写了一条"失败必须照常向上传播"的断言，但第一次变异探针（把 `throw error` 改成 `return`）**没有让它转红** ⇒ 我实测打印失败任务的返回，发现**公开门面不暴露失败原因**（仅 `{"status":"blocked","summaryPreview":null}`）⇒ 吞错与传播在门面层**观察等价**，**那条断言测不出吞错**。于是补了用例⑤（直接对沙盒），并在 ④ 的注释里**如实写明该边界**。重跑探针后：⑤ **当场红**（报"抛错时不应产出事件：got 1" —— 吞错后循环会继续并产出 `runFinished`，故事件数断言先命中），还原后 sha256 **一致** ⇒ 该纪律**现在有测试兜底**。**门禁**：`build` 0 ｜ `check` **0（441 文件 / 3293 用例、无 FAIL）**。**仍未做（如实）**：开关**仍缺省关**（是否默认开启属决策事项）；Git 失败／恢复分类等**其余错误路径尚未接入**；**⇒ 仍不主张 OBS 整卡通过。** <br>**✅ 2026-11-08（第 92 轮）变异体验收**：`DIAG` 的「执行前拒绝不得记成故障」过滤已纳入**永久**变异验证 —— `diag01-execution-refusal-recorded-as-failure` 被拦下；全量 **30/30 被拦下**。另记一次**负载抖动现场**（非回归）：紧接 30 次 vitest 后跑全量，`gui-verification-decision` 一条用例 30 086 ms 超时并伴 Windows `EPERM rename`；隔离复跑 **3/3 通过（各约 2.1 s）**、安静机器重跑门禁 **exit 0** ⇒ 归因负载，**不宣称已修复**（详见可靠性报告 §15）。 <br>**✅ 2026-11-08（第 113 轮）DIAG 接线推进：`recovery` 阶段接通，且是**生产可达**的一条（目标第 ① 项的实质进展）**。此前 `DiagnosticEvent.stage` 里 `git`/`recovery`/`dispatch`/`config` **没有任何上报方**（只有 `tool`/`provider`）。本轮：① 新增 `MissionDiagnosticEvent` **导出类型**（`mission-orchestrator.ts`），供编排器／`MainController`／装配层**共用一份定义** —— 起因是接线时编排器那处 `stage` 联合含 `"provider"` 而 `MainController` 新写的不含，`tsc` 直接拦下（"两处各写一份"的典型代价）；② 把编排器的上报逻辑抽成私有 `reportMissionDiagnosticEvent()`（**只加观测**：不取代升级消息、观测失败只丢弃、缺省不采集）；③ 在 **租约续约失败**（`renewLeaseTick` 的 catch）上报 `stage: "recovery"`／`component: "mission-lease"`／错误码 `mission-lease-renewal-failed`；④ `MainControllerOptions.missionDiagnosticEventPort` + **两处**调度路径转发；⑤ 装配层在**同一开关**（`isDiagnosticCollectionEnabled`，**缺省关**）下构造端口并落 `DiagnosticEventStore`（`taskIdentifier: null`，不伪造归属）。**为什么选租约失败做反例入口**：本轮核实编排器 6 处 catch 里**5 处都依赖 Git 集成**（而 Git 整层在当前产品路径不可达），**只有租约续约失败不依赖 Git 且生产可达**，并且它在**任务运行循环里被 `await`**（不必等半周期定时器）⇒ **可确定性触发**。**证据（先红后绿 + 承重）**：反例「租约续约失败：必须上报使命级诊断事件（stage=recovery），且仍停止调度」用**可注入的失败租约桩**（`tryAcquire` 正常、`renewLease` 抛错）驱动 ⇒ 绿（~0.5s）；**再移除那行上报 ⇒ 反例当场红** ⇒ 断言**确实承重**，还原后 sha256 一致。**仍未接的阶段（如实）**：`dispatch`／`config` **仍无上报方**；`git` 已在两处 catch 上报，但**因 T08 Git 集成整层不可达而在生产中不会触发**（见 `docs/reports/T08_GIT_INTEGRATION_PRODUCT_PATH_GAP_2026-11-08.md`）⇒ 我**不主张**"生产已覆盖 Git 失败"。 <br>**✅ 2026-11-08（第 114 轮）DIAG 接线推进（2/…）：`dispatch` 阶段接通**。落点：`main-controller.ts` 的 `startSchedulerSafely()` —— 它原本只 `streamOutput` 一行 `[mission-locked] …` 并把 mission 置 `blocked`，**诊断存储学不到发生了什么**；而这条路径（mission 被其他进程活跃租约占住）**生产可达**。现按 `stage: "dispatch"`／`component: "mission-start"` 上报，错误码取 DomainError 的 `mission-locked`（否则回退 `mission-start-failed`）。**无需新增管线**：`MainController` 已有第 113 轮接的 `missionDiagnosticEventPort`；纪律同前（**只加观测**、不取代那行提示、不改状态流转；观测失败只丢弃；缺省不采集）。**证据（先红后绿 + 承重）**：反例「调度启动失败（mission-locked）：必须上报使命级诊断事件（stage=dispatch），且原有提示不变」（`tests/core/unit/main-controller-facades.test.ts`，复用既有 `buildController` harness + `tryAcquire` 返回 `locked-active` 的租约桩）⇒ 绿（~47ms）；**按行精确移除那 16 行上报块 ⇒ 反例当场红且命中我点名的断言文本** ⇒ 承重成立；还原后原文一致。**⚠️ 本轮自我纠正一次操作失误**：第一次做承重验证时，我在 PowerShell here-string 里把模板字符串写成了字符串拼接 ⇒ **变异根本没命中**，而那次"测试通过"是**假的**（什么也没改）；改用 **Node 按行精确删除**后才得到真实结论。**⚠️ 并顺手改掉一个诊断缺陷**：反例原本等待上限 5,000ms 与 vitest 默认超时**相等**，导致"上报缺失"时表现为 `Test timed out` 而**不是**说明问题的断言；已把上限降到 **2,500ms**（正常路径毫秒级返回），失败时能直接给出断言文本。**仍未接的阶段（如实）**：`config` **仍无上报方**；`git` 两处已上报但**因 T08 Git 集成整层不可达而在生产中不会触发**。 <br>**✅ 2026-11-08（第 115 轮）DIAG 接线推进（3）：`config` 阶段接通 —— 目标第 ① 项的 `git`／`recovery`／`dispatch`／`config` 四类**全部**有了上报方**。落点：`main-controller.ts` 的 `switchPermissionProfile()` —— 用户切换权限组失败（自定义组不存在／存储未装配／revision 冲突）原本**只把错误抛回调用方**，事后没人能从诊断里回答"为什么切不过去" ⇒ 现按 `stage: "config"`／`component: "permission-profile"` 上报。纪律：**只加观测**（之后**原样重抛同一个错误** ⇒ 调用方看到的行为逐字不变）、观测自身失败**不得掩盖原错误**（独立 try/catch）、缺省不采集。**⚠️ 类型放宽一处（如实说明）**：`MissionDiagnosticEvent.missionIdentifier` 由 `string` 放宽为**可为空**（`null` 表示"无使命归属"）—— 切换权限组是**会话级**操作、**与任何使命无关**，故如实传 `null`（**不编造身份**；`DiagnosticEventStore` 本就接受可空值）。**证据（先红后绿 + 承重）**：反例「切换权限组失败：必须上报 stage=config 诊断事件（missionIdentifier 为 null），且原错误照旧抛出」（`tests/core/unit/main-controller-facades.test.ts`，`readProfile` 抛 `DomainError("permission-profile-not-found")` 的桩）⇒ 绿（~5ms；**无需轮询**，因为上报在重抛前被 `await`）⇒ **按行精确移除那 6 行上报调用 ⇒ 当场红且命中我点名的断言文本** ⇒ 承重成立。**四类阶段现状（目标第 ① 项收口）**：`tool`／`provider`（第 85 轮）＋ `recovery`（第 113 轮）＋ `dispatch`（第 114 轮）＋ `config`（本轮）**均有上报方**；其中 `recovery`／`dispatch`／`config` **生产可达并有反例**，`git` 两处已上报但**因 T08 Git 集成整层不可达而在生产中不会触发**（不主张已覆盖）。**另记**：本轮写这条记录时又被**自己的守卫**拦下一次（note 里混进半角竖线会破坏表格结构）⇒ 改措辞后通过；守卫按设计生效。 <br>**✅ 2026-11-08（第 129 轮）用户开关决定（生效）**：`PERF` **继续默认关闭**、按需启用；`DIAG` **可考虑未来默认开启"最小错误摘要"**，但**前置条件**是**先验证四项**：**脱敏／重复错误抑制／磁盘保留／故障风暴**；**诊断开关不得控制**必需的**权限审计、任务终态与恢复记录**。**结构核实（已完成）**：`isDiagnosticCollectionEnabled`／`isPerformanceCollectionEnabled` 在生产代码里**只出现于 2 个文件**（`application-runtime.ts` 的 L904／L961／L1023 三处采集构造 + `public-sdk.ts` 的默认值透传），删除审计／`updateMissionStatus`／恢复检查点写入路径**均未引用它们** ⇒ 该约束当前成立；后续若要在这些必需路径上加开关，**属违规**。 |
| SMART-01 | in_progress（**2026-10-10：四入口已接线 + 真实运行持续接收已通过（u2-flash, 8/8, exit 0）**） | 02/03 组件证据保留；04 **SDK**：`acceptUserInstruction`/`queryInstructionWindow`/`evaluateInstructionHandlingDeadline`（反例 `tests/core/integration/smart01-window-deadline-entry.test.ts` 5 条）；**CLI**：`astarray instruction accept/list/deadline`（与 SDK 共享同一落盘窗口；反例 `tests/tui/unit/smart01-instruction-cli-entry.test.ts` 5 条，含真实 `dist/cli.js` 跨进程端到端）；**TUI**：`AppState.setInstructionWindow/getInstructionWindowView` + 只读 `InstructionWindowPanel`（反例 `tests/tui/unit/smart01-instruction-tui-state.test.ts` 5 条，含 Ink 真实渲染按行断言）；**GUI**：`GuiSnapshot.instructions` + `GuiApplicationPort.queryInstructionWindow`，`/state` 与 SSE 快照均携带（反例 `tests/gui/unit/smart01-instruction-gui-read-model.test.ts` 4 条 + `gui-server.test.ts` 新增 2 条）。统一口径：`isWorkCompleted` **只有 `completed` 为真**，已派发/等待澄清/排队一律 false。**包级 tarball 验收已完成**：`npm run verify:instruction-entry-package` **exit 0、7/7 判据通过**（tarball sha256 `e2ecab40f2a5d463…`、来源提交 `bcfc746`；判定为可单测纯函数、先红后绿，见 `scripts/lib/smart01-instruction-package-checks.test.mjs`）。；**2026-11-08（第 62 轮，`07331cb`）：`--probe-only` 的 Windows libuv 断言已修并验证**（该断言原以「走成功路径需要真实凭据、改完无法验证」为由登记未修；用户提供凭据后按卡内 4 步开工：真实凭据**实测复现** `win/async.c:94` 断言 ⇒ 退出码 `-1073740791`（把「连通成功」报成崩溃）；修法为探针请求头加 `connection: "close"` + 硬退出前让套接字收尾，**连跑 3 次退出码 0、无断言**；并指出卡内拟定方案「把硬退改成 `exitCode = 0`」的**落点陷阱**：那个 `process.exit(0)` 同时是探针分支的终止手段，直接改会**落到下面的完整实测**，故未照抄；契约守卫新增 ⑦ 并做两条变异探针验证承重）。**仍未取得**：**macOS 平台证据**（本项仅 Windows）⇒ **SMART-01 仍不判整卡通过**。 |
**MERGE-01 §1.3 第 4 项 设置入口（本轮完成）**：`isParameterAuthorizationEnabled`/`isParameterRulesEnabled` 此前**只存在于权限引擎构造参数**，全仓 TUI/CLI/GUI/设置**零入口** ⇒「参数授权设置入口」在产品层面不成立，且 **TOOLKIT-01-04 依赖它**。新增 `packages/core/src/tools/parameter-authorization-settings-store.ts`：`readSettings()` 无配置文件时返回**默认（两个开关都开启）**且**不创建文件**；`writeSettings()` 先校验后经 `writeAtomicJson` 原子写+备份，**非法一律不落盘**；校验 fail-closed（schemaVersion/开关非布尔/rules 非数组/缺 ruleIdentifier·toolName·action/decision 非三态/**匹配种类未知（不允许正则脚本）**/**规则 ID 重复**）；**额外要求规则的 action 必须是该工具真实存在的 action**（仅靠判定器不够：`action:"not-an-action"` 只是永不匹配，判定器如常返回，该规则会被静默保存而用户以为配了策略）。**顺带修掉两个真实缺陷**：① 补 `PROJECT_FILE_WRITE_FAMILY`（createProjectFile→create 幂等；replaceFileContent→overwrite **必须备份、非幂等**），落实"含写动作不能整体伪装 readonly"并让写工具规则可校验；② **修掉 `resolveToolAction()` 真实 bug** —— 此前"别名 + action"被当成非法并 continue，使 `resolveToolAction({toolNameOrAlias:"createProjectFile",action:"create"})` **恒为 null**，而这正是设置层"用别名校验规则合法性"的查询形态（把合法查询误判为非法）；已改为别名必须命中**它自己所属**的 action。反例先红后绿 6 条（含"设置→引擎→裁决一致"）；六个 MERGE-01 套件合计 41/41。**MERGE-01 执行组映射与合并开关（本轮完成判定层）**：新增 `packages/core/src/toolkit/instruction-merge-mapping.ts`（纯本地确定性判定）—— 原指令**追加保存**并逐项带回来源/ID/revision/优先级/**取消权**/验收条件；执行组**只引用原指令**，原文**逐字**来自原指令，派生物 `isOriginalInstructionTextOverridden` **恒 false**、`sourceKind` **恒为** `group-derivative`（**不得伪装用户指令**）；引用绑定 revision + **内容指纹**，原指令 revision 前进或内容变化即**引用失效**；**SMART 窗口按原始未完成意图计数**（`countUnfinishedOriginalIntentions()`，与组数**无关**），窗口 3 条不能靠合并塞入第 4 条；**合并开关关闭**时**不得建组**，改为记录候选关联供后续复用；**组完成不自动关闭原指令** —— `markGroupCompleted()` **刻意留空**并在注释中写明意图（防后来者"顺手补上"自动关闭），关闭只能经逐项核验且不通过时 fail-closed。反例先红后绿 **10 条**；构建产物实测"2 条合成 1 组后 unfinished=2、groups=1、window exceeded=true"且组完成后原指令仍未完成。**MERGE-01 接到实际 SMART 窗口（本轮完成桥接）**：上一轮的 `createInstructionMergeController` 是**纯判定层**，而 SMART 侧真实使用 `InstructionWindowStore`，两者**各自计数、互不相识** ⇒ "窗口按原始未完成意图计数"在**真实装配路径上并不成立**（窗口不知道某条原指令已被逐项核验关闭）。新增 `countUnfinishedIntentionsInWindow()`：计数对象是**原指令**（**已准入 + 排队**各算一条）；**已逐项核验关闭的不占窗口**（否则永久占满）；**执行组数量完全不参与**计数；**覆盖排队记录**，未准入候选必须真的排队，**不能**因"合并后窗口看起来有空位"被提前准入。反例先红后绿 **3 条**（用**真实** `InstructionWindowStore`）；构建产物实测"3 条合成 1 组 + 1 条排队 ⇒ unfinished=4、capacity=3、exceeded=true（组数 1 不参与）"，逐项核验关闭 1 条后降为 3。**MERGE-01 两个纵向样本可达（本轮完成）**：两个族此前**只存在于注册表**，`executeBuiltinTool` 的 switch 只认旧工具名 ⇒ `{族名, action}` 在**真实派发路径上不可达**。新增描述符字段 `implementationToolName`（action → 具体实现工具名，保持单一数据源）+ `resolveUnifiedEntryInvocation()`；`executeBuiltinTool()` 在**任何 I/O 之前**解析统一入口并**递归复用**整条校验/执行路径 ⇒ 与旧名**逐字节一致**。**本片由回归当场抓住一个我自己引入的真实缺陷**：初版把"**任何带 action 字段的调用**"都当统一入口，于是 `backupVault`（自身合法使用 `action: list/read/restore`）被误判并**拒绝** —— 那是**破坏**既有工具而非统一它们；9 条既有测试立刻变红，已修正为"**只有已登记族的族名或别名**才进入统一入口判定"。反例先红后绿 **5 条**（实现前 3 红）。**NODECTX-01-01 首片（本轮完成盘点与语义冻结）**：本卡此前为 pending（仅设计布置）。新增 `packages/core/src/toolkit/context-lossless-visibility.ts`：① **可见性三态与业务状态分开** —— `active`/`temporarily-closed`/`permanently-closed`，`isBusinessCompleted` **只由业务状态决定**（反例 ① 钉住"**暂不入提示词 ≠ 业务 done**"），永久关闭的 `isContentRetainedOnDisk`/`isExplicitRecallAllowed` 恒为 true（"不代表物理删除、永不查阅"）；② **有损兜底盘点**逐处定位到代码/装配点：`global-budget-eviction`（context-prompt-assembler + context-lifecycle-metrics）与 `provider-input-space-silent-reduction`（budgetReductionReason）→ **rewrite-lossless**，`provider-side-auto-compaction`（Provider 内部**不可观察**）→ **declare-unsupported**；③ **审计 fail-closed**：合法处置仅三种，**`rename-only` 等"只改术语"一律拒绝**（卡内禁止"仅改名后继续做有损截断"），**非本项目可控项不得标为已禁用**，本项目可控项**不得**以"声明不支持"回避，`isReenablable` **恒为 false**（不提供重新开启的开关）。反例先红后绿 **8 条**；构建产物实测 3 条全部通过审计。**仍未完成**：02（其时未接入）、03（长会话多模型假服务与包级验收）。**NODECTX-01-03（本轮完成展示层与包级验收）**：新增 `packages/core/src/toolkit/context-visibility-view.ts`（纯函数展示层）—— 展示四态 active/staged/permanently-closed/**pending-ratification**（**待追认优先**，不被确定标签掩盖），与内部状态一一对应；文案**单点生成**：凡"不在上下文"必含"**原文完整保留在磁盘存档，可显式回访**"且**不含任何删除类字样**（反例 ③ 用禁用词表断言）；`isShownAsDeleted` **恒 false**、`isContentRetainedOnDisk`/`isExplicitRecallAllowed` **恒 true**；**暂存原因**缺失时不留白（显式标"原因未记录（须补记）"）；**待追认**即便业务状态 completed，`isShownAsCompleted` 仍为 **false**；完成与否只由业务状态决定。接入 `GuiSnapshot.contextVisibility`（始终存在，缺省空列表）。**包级验收扩展**：`toolkit01-package-checks.mjs` 新增 **4 条** NODECTX 判据（不以删除措辞展示/磁盘失败状态不变/工具配对原子/待追认不显示为完成），`verify-toolkit-package` 探针同步实测 ⇒ **39/39（原 33 + 新增 6）**。反例先红后绿 **7 条**；`test:scripts` 36/36。**2026-10-10 后续轮补记（本检查点完成）**：另交付 **跨重启恢复**（`persistToDisk`/`restoreFromDisk`，**可见性以索引为权威**、原文从磁盘回读、索引缺失时退回文件推断并报 `isIndexPresent:false`）—— 修掉**幂等键只在内存 ⇒ 重启后重复注入**的真实缺口；**真实两个假 Provider 的多模型端到端**（A → 重启 → B：各自只收到自己的请求、原文**逐字节不变**）；README/架构文档补"无损上下文"支持范围与**保证边界**（Provider 内部不可观察行为**不宣称已禁用**）；包级判据 39 → **41** ⇒ **NODECTX-01 三个检查点全部 done**。**NODECTX-01-02（本轮完成）**：新增 `packages/core/src/toolkit/lossless-context-manager.ts`（本地 I/O 仅限调用方给定暂存目录）—— 紧急/重要/当前执行需要/**用户来源未完成约束**一律**拒绝暂存**；**先写盘成功再改可见性**，登记 revision/hash 不一致即拒；**磁盘失败则可见性完全不变**（不假报成功）；**无任何摘要/改写路径**；配对节点必须 `stageNodePair` **同进同出**；补回按 **node/revision/activation 幂等**；前驱未完成不补回后继、**用户来源优先**排序；`maximumMigrationsPerRound` 生效；同 revision 第 2 次迁移即判**无进展振荡**并**同一轮上报 + 停止后续补回**；永久关闭需**逐项核验通过**、自动补回**不复活**、`recallExplicitly` 可读原文。**由反例逼出三处实现修正**：① 未登记节点应视为 `active`（状态"完全不变"）；② 配对暂存需两侧已登记，补 `registerNode`；③ 振荡须在触发那一轮上报。反例先红后绿 **12 条**；新增 `writeFile` 触发破坏性文件 API 架构守卫（T12-05）**未绕过**，按要求补最小令牌集 + 逐项理由。**仍未完成**：**"模拟慢模型/长下级任务仍能接收新指令"的真实运行证据****仍未完成**：**"模拟慢模型/长下级任务仍能接收新指令"的真实运行证据**（此前只有离线探针；需真实 Provider 凭据与费用授权，属用户/外部依赖）⇒ 不主张 SMART-01-04 通过 |
| PROJECT-01 | in_progress（**2026-10-10：真实资源 I/O + 崩溃时点反例已落地**；01-03 本地可证范围 done） | 授权/回执/查询组件成立；**本轮补上真实 I/O**：`CrossProjectTransferService` 新增可注入 `CrossProjectResourceIoPort`，`readResource` **真实读取**并返回内容/哈希、读取前后各取来源 sha256（相等 ⇒ **来源零写入**可核对证据）、`expectedContentHash` 不符即拒；`importCopy` **真实写出目标**（含写出后复核）、源内容哈希不符即拒；未注入端口时**如实返回失败**（不伪装成功）；新增 `releaseCopyReceiptClaim`（仅释放 `pending-` 占位回执，写入失败不留假完成回执）。反例先红后绿见 `tests/core/integration/cross-project-resource-io.test.ts`（8 条，实现前 7 红），既有 `cross-project-authorization.test.ts` 4 条改为真实文件+注入端口，两套件 20/20。**本轮追加（陈旧覆盖拒绝 + 公开入口）**：新增可注入 `CrossProjectTargetHumanEditGuardPort`——目标已存在时先判人工改动，有人工改动 ⇒ `target-stale-rejected`（不写、不落定回执）；**未注入守卫且目标已存在 ⇒ fail-closed 拒绝覆盖**；守卫抛错同样 fail-closed；目标不存在则不调守卫。公开 **CLI 入口**：`astarray cross-project read`（真实读取，`read-allowed` 才 exit 0，未授权不回显内容）与 `astarray cross-project import-copy`（真实写出目标；声明哈希取自来源实际内容；`--expected-target-content-hash` 用于判定人工改动）。反例先红后绿：`cross-project-stale-overwrite.test.ts`（4 条，实现前 2 红）+ `cross-project-transfer-cli-entry.test.ts`（4 条，实现前 4 红）；PROJECT-01 三套件 24/24。**包级 tarball 验收（本轮扩展）**：`npm run verify:instruction-entry-package` 在隔离安装的 tarball 上用**已安装包**的 CLI 实跑跨项目场景 ⇒ **exit 0、15/15 判据通过**（指令窗口 7 + 跨项目 8），跨项目项含：有效授权只读 `didRead=true`、**来源前后 sha256 相同（零写入）**、未授权 exit 1 且不回显内容、导入 `didWriteTarget=true` 且目标副本真实存在、目标被人工占用且无基线 ⇒ `target-stale-rejected` 且人工字节保留。判定纯函数先红后绿（`npm run test:scripts` 24/24）；tarball sha256 `71b52d0893f9a88b…`、来源提交 `6b1b0be`。**崩溃时点反例（本轮追加）**：补上「**写成功但回执未落盘**」这一此前无任何反例的时点 —— `tests/core/integration/cross-project-crash-after-write.test.ts` **3 条**：无守卫且目标已存在 ⇒ `target-stale-rejected`、`didWriteTarget:false`、`receipt:null`、目标内容**未被改写**、来源零写入；人工改动字节**必须保留**；首次导入则回执与文件**同时成立**。**如实说明**：这三条是**行为表征测试**（实测该 fail-closed 语义此前已正确实现），**不是先红后绿的缺陷修复**，价值在于把此前"无失败边界"的崩溃时点变成**有明确断言**。**SDK 公开入口（本轮追加）**：`AstarrayApplicationFacade` 新增 `readCrossProjectResource`（真实读取，未授权 `didRead=false` 不谎报）、`importCrossProjectResource`（真实写出；**未注入 I/O 端口即抛错**，不产生回执假完成；`expectedTargetContentHash` 判定人工改动）、`grantCrossProjectAuthorizationForAcceptance`（认证控制面入口，非模型工具）、`listCrossProjectAuthorizations`（只读）。反例先红后绿见 `tests/core/integration/cross-project-sdk-entry.test.ts`（4 条，实现前 4 红）。**GUI 只读入口（本轮追加）**：`GuiSnapshot.crossProject`（**始终存在**，未提供时空列表）+ 纯函数 `buildGuiCrossProjectView()`（副本回执恒标 `isCopyOfExternalSource=true` 并给出含"副本"/来源项目/revision 的 `displayLabel` → **人工可分辨副本与原件**）；`GuiApplicationPort.listCrossProjectAuthorizations()` 可选能力，`/state` 与 SSE 快照均携带，能力缺失或抛错 ⇒ 空列表（不伪造、不 500）。反例先红后绿见 `tests/gui/unit/project01-cross-project-gui-view.test.ts`（4 条，实现前 3 红）+ `gui-server.test.ts` 新增 1 条。**如实登记的剩余缺口**：GUI 的 `copyReceipts` 目前恒为空（端口只暴露授权列表，副本回执尚未经该端口提供）。**仍未完成**：多项目/多同级个体压力验收 ⇒ 不主张 PROJECT-01 通过。<br>**2026-11-08（第 74–75 轮）续记：又收口本卡登记过的两处缺口（均含提交号）**。① **GUI `copyReceipts` 真的供数**（`e4822d5`）：卡内原文记「GUI 侧 `copyReceipts` **恒为空列表** —— `GuiApplicationPort` 只暴露了授权列表，副本回执尚未经该端口提供」，而 §04 要求「**人工可分辨副本与原件**」⇒ 该要求此前**无法成立**。根因三处（端口无该能力 + **门面也没有对应方法** ⇒ 生产无供数方 + 服务端硬编码 `[]`），已全部接线：门面新增只读 `listCrossProjectCopyReceipts()`（复用公开 `summarizeCopyReceipts`）、端口新增可选方法、服务端**真的去读**且保持「缺失/抛错 ⇒ 空列表，**不伪造、不 500**，且不得连累授权列表」。反例先红（`expected [] to have a length of 1`）后绿；可达性以**子进程实际执行**判定（构建为分块产物，文本命中不可用）。② **公开门面暴露接收方同级个体维度**（`69ed7cf`）：查实 `receivingAgentInstanceId` 在**存储层一直存在**（记录字段/授权入参/列表过滤），**门面却从未暴露** ⇒ 卡内「多个同级个体**可追溯、不串数据**」在公开 API 上**根本表达不出来**（即本卡反复点名的"能力存在但产品不可达"）；反例**先红为 6 个精确 TS 错误**（`TS2353`×2 / `TS2554`×2 / `TS2339`×2），补齐门面透传与过滤后转绿；新用例的接收方身份来自**编排器真实派发**（各自 mission 的 `agentInstanceId`，非手工字符串）且**走公开门面**；**变异探针**：忽略该过滤 ⇒ 用例当场红（证明它确实在验证"不串数据"）。**仍如实保留的边界**：该用例取得的是**worker 级**同级个体；卡内括注的 "secondary agent instance" 若按**次级层**理解，需走主→次级完整控制流 —— 本轮已做**有界可行性核查**并记录：次级身份由**调用方提供**（`targetSecondaryAgentInstanceId: z.string().min(1)`），**没有**可驱动的自动派发路径 ⇒ **未做**，且「人工可分辨副本与原件的人类体验结论」仍属**外部条件** ⇒ **仍不主张 PROJECT-01-04 完全通过**。 <br>**✅ 2026-11-08（第 96 轮）变异探针：缩权派生守卫确已承重 + 两条我自己的方法学教训**。探针标的：`cross-project-authorization-store.ts` 里「**派生范围必须不宽于父授权**」（`isNarrower` ⇒ `rejected-not-narrower`）。**结论：该守卫有覆盖** —— 把**整段** `isNarrower` 表达式改成恒真后，`cross-project-authorization.test.ts` 的「⑩ 任务内缩权派生：派生授权范围必须**不宽于**来源授权」**当场红**。已**固化为永久变异体** `project01-narrowed-derivation-widening-accepted` ⇒ 全量 **34/34 被拦下**。**⚠️ 但我在这条上连出两次假结论，教训已写进脚本头部**：① **筛样太窄**：我按内容筛出 17 个候选文件、却只把手敲的 10 个喂进命令，漏掉真正守着规则的 `schemas.test.ts`；② **变异太弱**：这次我**只改了 `isNarrower` 表达式里的一项条件**（去掉 `pathPrefixes.length > 0`），其余条件仍在 ⇒ **根本没改变被测行为**，于是**连全量套件都照样全绿**，又被我读成"守卫缺口"。换成整段恒真后立刻变红。**纪律：注入后必须先自问"这真的改变了被测行为吗？"** —— 弱变异会把"守卫有效"**误报成**"守卫缺口"，而假缺口比漏检更浪费。 |

**多项目/多同级个体隔离与可追溯（本轮追加）**：新增 `tests/core/integration/cross-project-isolation-multi-project.test.ts` 5 条（**实现前即全绿，属补证据而非修缺陷，如实说明**）：仅授权 A 时用 B 必被 `project-mismatch` 拒且 `didRead=false`；A/B 授权与副本互不串且回执独立；未授权来源 X 拒绝；**多同级接收个体**按 `receivingAgentInstanceId` **真实落库**且按该维度过滤只看到自己那条；**8 路并发**导入恰好 1 条 `imported-copy` + 7 条 `reused-existing-copy`、回执仅 1 条。包级验收扩展"多项目隔离 + 可追溯"两项 ⇒ `npm run verify:instruction-entry-package` **exit 0、17/17**。**仍未完成**：经编排器真实派发的多同级 Agent 端到端压力场景；GUI `copyReceipts` 供数 ⇒ 不主张 PROJECT-01-04 完全通过 |

**推送状态**：`69e3c85` 与 `2df9a72` 首次推送连续 5 次失败（`fatal: Could not read from remote repository`，
远端瞬时不可达）；**下一阶段首次重试即成功**（`849c479..2df9a72`），`origin/main` 已追平。
**同类再次复现（2026-10-10 晚）**：`9fc79e9` 首次推送连续 5 次失败，随后 `git ls-remote --heads origin`
**恢复应答**（exit 0）⇒ 立即再试**第 2 次即成功**（`455f2a1..fefccb6`）。
**结论**：该类失败确为**远端瞬时不可达**，`git ls-remote` 可作为"是否值得立刻重试"的探针。
**第三次（本轮末）**：`a8611b8`（敏感禁读结算修复）连续 8 次推送失败，探针持续报
`Connection reset by 20.205.243.166 port 22`（SSH 通道不稳）⇒ 记为"本阶段跳过"，
**下一轮优先把 `a8611b8` 与后续提交一并重试**；`origin/main` 此时停在 `88b61c5`。
（该次随后已清偿：`a8611b8`+`7610a96` 于下一轮第 5 次尝试推送成功。）
**第四次（2026-10-10 第 41 轮）**：`76a4459`（NODECTX-01-03 完成）首轮 8 次失败，
探针（`git ls-remote --heads origin`）亦报 `Connection reset ... port 22`；
**累计第 14 次尝试推送成功**（`e8d23b2..76a4459`），`origin/main` 已追平。
**纪律执行**：提交始终先落在本地（推送失败不会丢提交），失败仅记为跳过并在随后优先重试。
**第四次（本轮末）**：`525d0c8`（TOOLKIT-01-02 配方引擎）**连续 11 次推送失败**。
`git push --verbose` 的完整错误为：
`Connection reset by 20.205.243.166 port 22` → `fatal: Could not read from remote repository.`
即 **SSH 握手在 TCP 22 上被对端重置**（非鉴权/仓库错误，非本地问题；
`git ls-remote` 同样被重置）。记为"本阶段跳过"，
**下一轮优先把 `525d0c8` 与后续提交一并重试**；`origin/main` 此时停在 `aa8d028`。
（该次随后已清偿：`525d0c8`+`6a79b7b` 于下一轮第 5 次尝试推送成功。）
**第七次（本轮末）**：`c103c88`（TOOLKIT-01-04 TUI 面板）**连续 12 次推送失败**，
错误恒为 `Connection reset by 20.205.243.166 port 22`；**下一轮优先累积重试**，
`origin/main` 此时停在 `d61aa57`。
**第五次**：`52e3df1`（TOOLKIT-01-03 推广模块）**连续 14 次推送失败**，
错误恒为 `Connection reset by 20.205.243.166 port 22`（SSH 握手被对端重置）。
记为"本阶段跳过"，**下一轮优先把 `52e3df1` 与后续提交一并重试**；
`origin/main` 此时停在 `6a79b7b`。（该次随后已清偿：`52e3df1`+`d9d09cd` 于下一轮第 3 次尝试成功。）
**第六次（本轮末）**：`1815d1f`（MERGE-01-04 设置入口）**连续 12 次推送失败**，
错误恒为 `Connection reset by 20.205.243.166 port 22`（SSH 握手被对端重置）。
记为"本阶段跳过"，**下一轮优先把 `1815d1f` 与后续提交一并重试**；
`origin/main` 此时停在 `d9d09cd`。 |
| RELIABILITY-01 | in_progress（**2026-10-10：故障注入矩阵已可执行化**；R4 幂等账目损坏处理已返修）；**Linux 平台证据已补齐（2026-11-08，WSL2/Ubuntu 26.04/Node v22.22.1）**：进程树收口用例在 Linux 实跑通过、全量 431 文件 0 失败；**macOS 仍缺** | 已有修复保留。**R4 SDK 幂等账目损坏处理（本轮完成）**：此前 `loadTaskIdempotencyLedger`/`parseTaskIdempotencyLedger` 在**文件存在但损坏**时一律返回 `[]`，与"账目不存在"无法区分 ⇒ 重启后表现得像"从未受理过"，同一 `(sessionId, idempotencyKey)` 会被**再执行一次**（重复副作用）。新增 `parseTaskIdempotencyLedgerWithIntegrity` / `loadTaskIdempotencyLedgerWithIntegrity`（暴露 `isCorrupted`/`corruptionReason`/`unusableEntryCount`；非法 JSON、schemaVersion 不符、entries 非数组、**单条结构非法**均计入损坏；合法条目仍保留）；`AstarrayApplicationFacade.create` **默认 fail-closed**（`idempotency-ledger-corrupted`，含原因与条目计数），仅当显式传 `allowCorruptedIdempotencyLedger: true` 才沿用可解析条目；"文件不存在"仍属正常全新安装（不误判损坏）。既有宽容解析 API 行为不变。反例先红后绿见 `tests/core/integration/reliability-r4-ledger-corruption.test.ts`（9 条，实现前 6 红）。**恢复分类器零预算（本轮完成）**：卡内静态疑点点名"核查**零预算**等输入"；既有实现只对 `confirmed-failure` 分支判 `remainingRetryBudget > 0`，而**尾部分支（幂等 planned/started/result-unknown）无条件返回 `bounded-retry`** —— 调用方 `recovery-center-controller` 只读 `category`、不自行判预算，故**零预算下幂等操作仍会被重试（预算失去效力）**。修复：尾部分支补上同一道预算闸门，预算 ≤0 时返回 `blocked-uncertain-side-effect`（需对账/人工裁决）；预算充足时语义不变。反例见 `tests/core/integration/reliability-recovery-classification.test.ts` ⑧⑨（⑧ 实现前红）。**并发落盘（本轮核查：未发现缺陷，如实登记）**：对账列出的"并发落盘需返修"属**静态疑点**，本轮以**证伪**方式核查——新增 `tests/core/integration/reliability-r4-ledger-concurrency.test.ts` 4 条：并发提交 8 个不同会话的 claim 后磁盘账目**完整保留 8 条**（无 last-writer-wins 丢条）；**4 轮 × 6 会话交错并发**每轮读盘条目数**都等于累计提交数（24/24）**；重启后同键同参复用且同键异参拒绝；同一会话同一键并发时只有 1 条 claim、其余按 `idempotency-claim-pending`/`idempotency-key-conflict` 拒绝。**结论：该路径经加固尝试未被证伪 ⇒ 不主张"已修复"（未发现缺陷），测试作为不变量保留**。**提前拒绝结算（本轮完成 · 真缺陷）**：`isExecutionRefusalErrorCode` 只列了 `permission-ask-pending`/`tool-permission-denied`/`auth-scope-awaiting-user-authorization`/`auth-scope-denied`，**漏掉同样"执行之前就被拒、确定无副作用"的 `tool-not-found`**。后果：未注册工具的调用被按 `sideEffectStatus: "unknown"` 结算 ⇒ 范围门禁的预留进入 `requires-reconciliation` ⇒ 该逻辑操作**永久无法重试**（须人工对账），而实际从未发生任何副作用。修复：把 `tool-not-found` 并入"提前拒绝"集合（并补注释说明为何不含 `auth-scope-replay-rejected`）；实测 `tool-not-found` 与"超出 Worker 子集"两条路径均报 `sideEffectStatus: "none"` ⇒ 预留释放、修正后重跑可行，**成功后的重放保护不放宽**。反例见 `tests/core/unit/policy-wrapper-gaps.test.ts`（实现前 1 红）。**变更前中止的副作用声明被丢弃（本轮完成 · 更深一层缺陷）**：`PolicyWrapper.executeWithRetryOnAbort` 的 catch **完全省略 `sideEffectStatus`**，于是工具自己声明的"确定无副作用"（`SideEffectNoneError`）被丢弃 ⇒ 门禁只能按 `unknown` 结算 ⇒ 预留进入 `requires-reconciliation`、逻辑操作永久无法重试，尽管从未写入任何字节。受影响路径含既有 `createProjectFile` 排他创建遇 EEXIST、以及 `replaceFileContent` 备份后 TOCTOU 中止（后者原为普通 `Error`，本轮改为 `SideEffectNoneError`）。修复后：可证无副作用的失败**释放预留**，模型拿到第二次机会；**未收敛的**失败仍被完成门禁拦下。反例见 `tests/core/integration/permission-refusal-side-effect.test.ts` ⑥（实现前红）与 `completion-gate-counterexamples.test.ts` B（未收敛仍须拦）+ B2（新增正向证据：第二轮成功后 `done` 且产物真实落盘）。**敏感禁读结算（本轮完成 · 同族第三处真缺陷）**：`PolicyWrapper` 的**提前拒绝集合**此前还漏了 `sensitive-content-read-denied`（敏感内容禁读由本地路径/内容策略判定，全程**未变更任何数据**），且 `executeWithRetryOnAbort` 的 catch **只认 `SideEffectNoneError`**、不认"前置拒绝错误码" ⇒ 该类拒绝被按 `sideEffectStatus: "unknown"` 结算 ⇒ 范围门禁预留进入 `requires-reconciliation`、**永久无法重试**，而实际只是"该资源不被允许读取"。修复：把 `sensitive-content-read-denied` 并入提前拒绝集合，**并让该 catch 同时按"前置拒绝错误码"判定 none**（此前只认异常类型，等于该集合在这条路径上完全失效）。反例见 `tests/core/integration/reliability-sensitive-refusal-settlement.test.ts`（实现前红）。**矩阵增补（2026-10-10）**：13 → **15 条**（覆盖维度 **10/10** 仍齐备），新增两条**如实标为未验证**：`smart01-continuous-reception-real-run`（SMART-01-04 的"真实运行"整机实测 —— **离线部分已证**（6+5 条含真实 120ms 慢任务延迟与期限自接收起计），但**无真实 Provider 额度**，**不拿离线冒充真实运行**）与 `load-sensitive-full-gate-flake`（全量并发偶发无关失败、隔离复跑全绿、**未在产品代码中修复故不标已修**）。**矩阵增补（本轮完成）**：§6 此前是**散文表格**，无法自动发现"引用了不存在的测试"或"覆盖维度缺失"。新增 `packages/core/src/toolkit/fault-injection-matrix.ts`（矩阵数据 + 审计函数）：每条登记结论（confirmed/fixed/not-verified/gap）；**confirmed/fixed 必须给出真实存在**的证据引用（审计做只读存在性检查）；**not-verified 不得给证据**（不得拿别的测试冒充）；卡内点名 **10 个覆盖维度缺一即不完整**；未验证条目**如实列出**。构建产物实测：**13 条、10 维度齐备、2 条如实标未验证**（`before-dispatch-crash` 派发前崩溃无受控反例、`receipt-written-ack-lost` 反馈 ack 丢失侧尚未注入）⇒ **不主张 RELIABILITY-01 通过**。反例先红后绿 **9 条**。**"回执写入但确认丢失"时点已落实（本轮）**：原假设（提交与派发分离）经**真实跨进程注入证伪** —— 本仓指导的"记录与应用"在**同一同步块**内完成，**该间隙并不存在**。改为该时点真正形态：**回执写入被打断** ⇒ 磁盘留下不完整 JSON；实测缺陷：`GuidanceSubmissionJournal.readDocument()` 对解析失败**静默返回空日志** ⇒ `queryGuidanceStatus()` 报 **0 条**、用户指导**静默消失**（与已返修的幂等账目损坏**同类**）。修复：新增 `readAllWithIntegrity()`（暴露损坏与原因，合法条目保留）与 `readAllStrict()`（损坏即抛），并让产品默认查询路径 **fail-closed**；"文件不存在"仍属正常安装。反例先红后绿 **6 条**；矩阵该条目由 `not-verified` 改为 **fixed** ⇒ **未验证时点由 2 项降为 1 项**（仅剩 `before-dispatch-crash`）。**"派发前崩溃"时点已落实（本轮）⇒ 矩阵未验证项归零**：以**真实跨进程硬杀**注入（子进程 stdin 握手后立即 SIGKILL，**不用计时窗口**），覆盖两个相位：claim **未落盘** ⇒ 重试允许且必须给出明确结果；claim **已落盘未结算** ⇒ **不得重跑**、fail-closed 暴露未结算（`idempotency-claim-pending`）；另以**确定性植入** pending claim 验证**异参同键冲突检查照旧生效**（避免"过窄计时窗口"）。如实记录：既有 `reliability-sdk-idempotency` ② 的"重启"走**优雅 shutdown**（claim 已结算），**并未**覆盖本形态。矩阵 `before-dispatch-crash` 由 `not-verified` 改为 **`confirmed`** ⇒ **未验证项归零**（13 条 = 9 confirmed + 4 fixed，10 维度齐备）。反例 **4 条**。**仍需返修**：无（矩阵层面）；Linux/macOS 平台证据仍待平台提供 <br>**2026-11-08（第 65–72 轮）续记（诚实）**：① **产品侧「`shutdown()` 返回即静默」已修**（`c48a61c`，方向 C）：`MissionOrchestrator.cancel()` 原来**只等待、不中止**在途 worker（2 秒上限）⇒ 在途 Provider 调用跑完后才落盘 ⇒ 落盘发生在 `shutdown()` 返回**之后**；关键发现是**基础设施早已存在**（`WorkerAgent` 一直有 `cancellationController` 与 `cancel()`，运行时收到的 `cancellationSignal` 正来自它），**缺的只是编排器去调用它**。**确定性复现**用受控慢 Provider 取得（**无需并发负载**，推翻既有报告"隔离跑无法复现"的方法性结论）；反例先红后绿 + 变异探针证明承重。② 另修两处**实证超时**文件（逐文件补预算，方案 B，**未改断言**）、`feedback-process` 竞态（改**纯被动闸门**：读邮箱 journal 的 `delivered`）与 `before-dispatch-crash` 注入相位（改**有界重试**）。③ **诚实量化（不可夸大）**：各处修复叠加后 **5 轮全量仍 3/5 干净**；对照修复前 4/5、全局预算方案 3/5 ⇒ **样本量下三者不可统计区分，既不宣称改进也不宣称回归**；唯一稳定成立的是 **`Test timed out` 0 次**。其中**相位重试已被实测反证 5 次不够**（满载全落空）⇒ 已按证据抬到 12，**仍不主张消除**。④ **A 全局 / B 逐文件**：**已于 2026-11-08 由用户明确决策：选 B（逐文件）**（全局 `testTimeout` 保持未动；只给**被实测观察到超时**的文件补 `vi.setConfig({ testTimeout: 60_000 })`）：我曾越权加全局预算并**已如实回退**（`PLAN_STATUS` 早已记明"用户未指定时选更保守的 B 且未动全局配置"）。**仍未取得**：**Linux/macOS 平台证据**（须平台提供）⇒ **整卡仍不判通过**。 <br>**✅ 2026-11-08（第 101 轮）抖动归因 + 处置**：`completion-gate-counterexamples` 用例 A（「工具选错后仍声称完成 → 判失败」）在**紧接 39 次变异验证**后的全量门禁里失败，耗时 **10 261 ms**（同文件其他用例 300–440 ms），报「工作存档里始终没有出现门禁判词；已读到的摘要数=1」。**机制已查清**：该用例本就是**有界等待**（第 52 轮加的 10s 窗口 + 50ms 轮询）等"判词落进工作存档"，而归档是**进程内异步任务**（该用例 `useFeedbackProcess: false`）⇒ **满载下 10s 窗口被耗尽**；隔离 **3/3 通过（各约 1.8 s）**、安静机器全量门禁 exit 0。**处置**：窗口 **10s → 30s**、断言不放宽；**如实标注为概率手段（不主张消除）**，确定性需要产品侧让归档完成**可 await**（独立一片）。详见可靠性报告 **§16**（含我一次"把并行测试日志混进来"的归因错误）。 <br>**⚠️ 2026-11-08（第 125 轮）`provider-tool-loop` 抖动排查：未能复现，只加了自诊断（不改判定）**。现象：第 122 轮全量门禁在**紧接多个变异验证之后**运行时，`tests/core/integration/provider-tool-loop.test.ts` 的「未注册/禁用工具无法旁路，错误回填给 Provider」报 `expect(result.status).toBe("done")` 得到 **`blocked`**。**已查清**：① 该用例的等待助手 `runToTerminal`是**有界轮询**（15 ms × 上限 50 s）且**见到任何终态（含 `blocked`）立即返回** ⇒ 中途 `blocked` 会**早退**；② 全仓只有 `main-controller.ts` 的 `startSchedulerSafely()` 会把 **mission** 置 `blocked`（`scheduler.start()` 拒绝时；它用 `void …catch(…)`，**不抛**，故 `submitTask` 不报错）⇒ 该次 `blocked` **最可能**来自"调度启动失败"，**但本轮无证据**。**复现尝试**：把该文件**并行跑 6 份** ⇒ **6/6 全过**（各约 2.2–2.4 s）⇒ **未能复现** ⇒ 本条继续留在台账，**标注"未复现、未修复"**。**本轮唯一改动（只加诊断）**：在测试装配里捕获 `streamOutput`（"调度启动失败"只走该通道）并在断言**失败信息**里打印；**判定条件与断言数量完全未变**。该诊断**已实测有效**（临时改期望值触发失败 ⇒ 输出「终态应为 done。诊断输出（streamOutput）：（空 —— 说明不是「调度启动失败」那条路径）」）。详见可靠性报告 **§17**。 |
| E2E-01-03 | done（卡内明确验收范围） | 2026-10-09 真实 Provider、隔离包与入库判定；人工并发口径按该卡记录，不扩大为所有并发情形 |
| E2E-01-04 / 整体 E2E-01 | in_progress（**本地可证项已全部通过，且已无本地可修的已知阻塞**；仅剩人工与平台） | **HEAD 最新实测（2026-10-10 本轮）**：`npm run check` exit 0，**308 文件 / 2353 用例通过、skipped 0**；`npm run test:coverage`（仓库配置、默认并发、阈值 85）**exit 0**，行/分支/函数/语句 = **92.66 / 85.05 / 92.62 / 92.7**（分支达标，与上轮持平无回归）；安全关键模块 22/22；fixture 指纹 `6512b2a6…c7c` 一致；`npm pack`+`verify-package` exit 0（239 文件）；**`smoke-install` exit 0（冒烟全部通过）**。~~CLI 退出反例仍 skip~~ → 已于 2026-10-10 修复并转绿（`cli-exit-linger` ② 从">60s 滞留失败"变为"36s 自然退出通过"）；~~最后一个 `it.skip`（`cli-anthropic-protocol` ①）~~ → **已定位根因、修复并转绿，skipped 由 1 降为 0**（31.2s 恒 `blocked` → **0.85s `status=done`**）；超时型抖动（`run-command-gaps`）本轮 13 次运行未复现，已把"无 deadline 轮询"的可证接缝固化为确定性反例。仍缺：**人工体验结论**、**Linux/macOS 平台证据**（只能由用户/平台提供）。证据链见下方「E2E-01-04 证据链」小节 <br>**✅ 2026-11-08（第 89 轮）本地可证项独立复跑（本窗口 ④ 的延续）**：`npm pack`（prepack = 完整 `check`）**exit 0** ⇒ **441 文件 / 3293 用例通过、skipped 0**（本行 2026-10-10 快照为 308/2353，属规模增长；**"skipped 0" 这一条逐字成立**）；`npm run verify:e2e01` **exit 0** ⇒ 指纹 `sha256:6512b2a6…44e94c7c`、`fileCount 11`、`baselineFailedAsFrozen`/`solutionPassedAsFrozen` 均为 true，**与本行记录的指纹逐字节一致**；`npm run verify:security-coverage` **exit 0** ⇒「关键安全模块 **22/22** 达标（阈值 95%）」成立；`node scripts/verify-package.mjs <tarball>` **exit 0** ⇒「打包校验通过：**273 个文件**」（本行 2026-10-10 记 239 ⇒ 包在长大，属预期）；`node scripts/smoke-install.mjs` **exit 0** ⇒ 冒烟全部通过。**本轮未发现缺陷**：本行可复跑断言全部成立，仅"tarball 文件数"是当时快照。**仍缺不变**：人工体验结论与 Linux/macOS 平台证据（只能由用户/平台提供）。**顺带**：本卡卡头原仅有「状态：pending」一句、无口径，已补 2026-11-08 口径（`pending` = **验收未通过**，非"未实施"）。本轮**未改任何源码或测试**。 |
| GUI-01-R | **本地可证 + 单平台（Windows）口径收口**；人工体验第 2 轮已完成（十项定论、6 个真实缺陷均已修） | §1-5 授权呈现缺口与「重启后列表为空」两项已由用户决策转出至 **GUI-02**；屏幕阅读器一项**已于 2026-11-08 实测通过**（经真实用户确认「念了页码」；见下方续记） | 01 范围冻结、02 本地服务（loopback/Host/Origin/CSRF/清洗/SSE 首帧与重连/退出收口）、03a 设置与恢复、03b 待追认与人工裁决、04a UX 静态契约 + 打包、**04b 安装产物级 SSE 契约校验（27 项）与从隔离包启动 GUI 冒烟**均已交付（证据见 `GUI01_R_*_EVIDENCE.md`）。**人工体验（2026-10-10，用户执行，Windows 11 + 火狐，隔离安装产物）**：<br>**2026-11-08（第 76–78 轮续记，人工体验第 3 轮 + 授权闭环）**：① **屏幕阅读器不再是「未测」** —— 用户实测后反馈「翻页后直接读出任务列表、没读页码」，根因是给 5 个**批量列表容器**（`#tasks`/`#recovery`/`#verifications`/`#permission-asks`/`#installation-inquiries`）都加了 `aria-live="polite"` ⇒ 翻页时整批 20 条被替换、**淹没状态播报**；已摘掉这些容器的 `aria-live`（状态文本区全部保留，**18 → 13 个 live 区**），反例 `tests/gui/integration/gui-accessibility-live-regions.test.ts`（**首跑①红**），提交 `0a81e8c`；**用户复测确认「念了页码」⇒ 判定标准达成**。② **授权呈现闭环已打通并端到端验证**（`ed4b5e6` + `743071e`）：修掉两处「半成品」实现 —— `gui` 命令创建应用时**没传** `onPermissionAskWithIdentity` ⇒ **没有任何人登记**待决授权 ⇒ `/permission-asks` 恒空；以及 GUI 的批准**只记录裁决**、没做 CLI 的三步（会话级授权 / 作用域一次性授权 / 下发 `unblock` 唤醒）⇒ 任务停 `blocked`、产物不落盘。**本会话经 GUI 自己的 HTTP 路由端到端验证**：`提交 → 授权请求出现 → 批准 → blocked→running→done（第 117 秒）→ 产物真实落盘`。另修恢复中心**分页 + 可恢复项优先**（`35eb104`；用户实测 103 条里仅 1 条可恢复却找不到）。**仍未完成**：**Linux/macOS 平台的人工体验**（本窗口证据仅 Windows + 火狐；Windows 浏览器连不进 WSL 的 loopback、WSL 内无浏览器，均已实测）⇒ **GUI-02 整卡仍不判通过**。 |
记录见 `docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_RECORD_2026-10-10.md`。
- **已通过 3 项**：键盘（Tab/Shift+Tab/Enter/Space，无需鼠标）、中文（显示正常、内容留存、
  提交显示正确任务标识）、缩放（200%/窄屏无横向滚动、控件不重叠）。
- **人工体验发现并已修 3 个真实缺陷（提交 `7b9b4d9`）**：
  ① 切换权限组 `csrf-required` —— 前端读 `document.cookie` 而 cookie 是 **`HttpOnly`**
  ⇒ token 恒空 ⇒ 所有状态变更 403；改为**页面内嵌 token**（跨源读不到 HTML，故不泄漏），
  **保留 `HttpOnly`**；② 提交显示 `已受理：undefined` —— submit 处理器**不检查 HTTP 状态**，
  把 403 错误体当成功体（把失败呈现成受理）；
  ③ 我自己的断言曾**假绿**（全页正则被其它处理器误匹配），已限定到 submit 片段。
  **既有 72 个 GUI 测试全绿却漏掉 ①②**：它们都用 `csrfTokenFactory` 直接注入 token，
  **从不模拟浏览器从页面取 token** —— 又属"自证"（同 BRIDGE-01-04 协议版本那类）。
- **§1 第 5 项「提交→授权」无法完成 = 能力缺口**：GUI **没有**权限询问的呈现与批准路径，
  且不是接线疏漏 —— `GuiApplicationPort` 无相关方法、无批准路由、
  `PublicAstarrayEvent` 不发布权限询问事件、`PublicTaskResult` 不含 `permissionAsk`；
  CLI 的该能力来自它自己监听升级文本。补它需**先扩公共能力**（安全敏感）⇒ 未擅自实现。
- **仍未测**：可访问性（深色模式+屏幕阅读器）、查看差异、追认/否决、恢复、断线恢复、资源观察。
**仍未完成**：上述未测项 + 授权呈现能力缺口 + **Linux/macOS 平台证据** |
| BRIDGE-01 | **done（2026-10-10：真实第三方客户端消费已完成）**；**Linux 平台验证已补齐（2026-11-08，WSL2）**；**仅缺 macOS 平台验证**（按用户指示先跳过、保留待补） | 01 协议冻结（ADR-0032）、02 最小工具映射、03 边界与断连已交付；**04 脚本化 stdio 闭环已交付**：`node scripts/verify-mcp-bridge-loop.mjs` 本轮实测 **exit 0、20 项判据全过（0 失败）**，含"业务级失败以 isError=true 返回（协议层不抛 JSON-RPC 错误）""不同主体读取 A 的任务一律 task-not-accessible"。**Linux 侧复跑（2026-11-08，WSL2／Ubuntu 26.04／Node v22.22.1，源提交 `5f08ef0`）：exit 0、`checkCount=20`、passed 20／failed 0、`isPassed: true`** ⇒ 与 Windows 结论一致（详见 `docs/reports/BRIDGE01_LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md`）。**macOS 与「真实第三方客户端在 Linux 上的消费」仍未验证**。 |
> **BRIDGE-01-04 第三方客户端消费证据（2026-10-10，用户授权后）**：`pi` 1.1.0（云之声 `u2-flash`）与 `opencode` 1.18.35（`stepfun/step-3.7-flash`）经 **MCP stdio** 真实消费本仓桥接：
> pi 提交 ⇒ `accepted`/`isCompleted=false`/`actorId="external-harness:pi"`；
> opencode 完成 **submit→query→cancel** 全闭环；**跨主体隔离生效**
> （opencode 访问 pi 的任务 ⇒ 业务级 `task-not-accessible`，非协议错误）；
> **协议失败 vs 业务失败可区分**（`-32601`/`-32700` 走 JSON-RPC error，
> 越权走 `result.isError`）；**身份注入防护真实生效**
> （参数带 `sourceKind` ⇒ `bridge-identity-injection-rejected`）。
> **过程中发现并修复一个阻断性缺陷**：协议版本 `2026-07-28` 不被任何真实客户端接受
> ⇒ 两家直接拒连；已改为**按规范协商到客户端请求的版本**。
> 证据 `docs/reports/BRIDGE01_04_REAL_CLIENT_EVIDENCE_2026-10-10.md`。
> **仍未完成**：**macOS/Linux 平台上的真实客户端消费**（本证据仅 Windows）；
> 仅 stdio 传输（Streamable HTTP/A2A 按 ADR-0032 不在本批）；`read_result` 未在已完成任务上取回正文 |
| COMM-01 / WB-00 | **COMM-01-01 done；02 经 2026-10-22 订正后仅"创建来源登记 + 地址完整性"一小片落地，主体全部未做；03 pending** ／ WB-00 pending | **⚠️ 2026-10-22 重大订正（`97cd007`/`f9548bd`）**：2026-10-18～10-20 交付的"唯一上级归属"是**错误模型** —— 依 `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54 与用户澄清：**同项目主层与次级层默认全连接**（不逐边申请通信授权）、跨项目按需且仅主—主/次级—次级建议通道须授权、三级/四级只向唯一直属上级**请示报告**（其他协作由上级**代理转达**）、**反馈走任务发布者的反向通道**、绑定记录是**创建时由创建工具自动登记**的来源事实（**不是通信授权**）。原"只允许直属上级投递"会**阻断同项目主↔次级的默认可达**（功能性破坏）。已订正为"**创建来源登记 + 地址完整性**（**无绑定记录 ⇒ 直接拒绝**）"，删除错误语义与 3 个错误模型测试文件，新建 2 套件 22 条（含 2 条专门**回归**首版错误：任意已登记主体之间必须可投递），变异清单同步订正 7/7 被拦下。**本卡主体仍未做**：跨项目主—主/次级—次级授权通道、经唯一上级**代理转达**、受控路由目录与端到端可达矩阵、旧转交迁移、COMM-01-03 全部 ⇒ **02 不通过**。**2026-10-25/26 进展（`98d80b0`/`2c3eebb`/`381e83d`）**：**反馈默认走任务发布者的反向通道**已落地并**在真实编排路径启用** —— 修掉 `worker-agent.reportOutcome()` 硬编码 `scheduler:<missionId>` 且 `TaskDependencyNode` 无发布者字段的真实缺口（新增 `publishedByRecipientId`；`mission-orchestrator` 构造 Worker 时登记自己为发布者；**已带则尊重原值不覆盖**，否则等于把反馈从真正发布者改投）；反例 11 条（含**真实 worker 路径** 2 条）、**变异 14/14 被拦下**。**未验证（如实）**：编排层那一次调用**无端到端断言**（`workerFactories` 不提供 worker 注入口、全仓无构造 `MissionOrchestrator` 的测试）⇒ 仅由**类型检查 + 纯函数测试**支撑，**不声称已证**。**WB-00**：卡内自述"未来探索"、前驱 GUI-01-R 缺人工/平台证据，4 个检查点未开始 |
| MERGE-01 / NODECTX-01 | MERGE-01：**01/02/03 全部 done**；NODECTX-01：**01/02/03 全部 done**（两卡在本地可证范围内均已交付；整卡层面仅剩平台/人工证据） | 见 `docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md`（检查点表已同步 2026-10-10 实测状态）与 `docs/reports/CROSS_CARD_RECONCILIATION_2026-10-10.md`。**MERGE-01-01 早期进展**：实测 `isParameterAuthorizationEnabled`/`isParameterRulesEnabled` 零命中（完全未实现）⇒ 新增 `packages/core/src/tools/parameter-authorization.ts`（声明式规则 + 纯函数 `evaluateParameterAuthorization`；匹配仅限 path-prefix/allowed-values/fixed-value/numeric-range，**无脚本无正则**；优先级：基线 deny 为总拒绝、开关关闭回退基线、已匹配规则覆盖基线、未匹配/不可解析 fail-closed、多规则冲突 **deny>ask>allow**），并经 `public-sdk` 公开导出；反例先红后绿 9 条。**2026-10-10 第 30–41 轮补记**：MERGE-01-01 另完成执行组到原指令映射、**合并开关**、窗口**按原始未完成意图计数**（接入真实 `InstructionWindowStore`）、两个纵向样本**在派发路径上可达**（初版误拒 `backupVault`，**由既有测试保护网抓住并修正**）；NODECTX-01-01/02 完成有损兜底盘点（**"只改术语"判非法**）与无损暂存/自动补回/永久关闭/显式回访，01-03 完成四态展示（**不把"不在上下文"显示成删除**）、**跨重启恢复**（修掉**幂等键只在内存 ⇒ 重启后重复注入**的真实缺口）与**真实两个假 Provider 的多模型端到端**，并补 README/架构的支持范围与**保证边界**（包级判据 33→**41**）；MERGE-01-02 补上**"关闭细分不得静默扩大权限"**（放宽需认证用户确认、被拒不推进 revision）。**MERGE-01-02 补记（本轮）**：补上**确定性合并资格判定**（`packages/core/src/toolkit/instruction-merge-eligibility.ts`，纯本地、**无模型参与**）—— 只合并**同项目/同任务权威/同权限作用域/相容目标/依赖 ready** 的指令；**语义冲突、目标不明、独立授权、跨项目、在途副作用**一律排除并**逐条给出原因**；明确 `supersedes` 走取代语义（**不按最新文本猜测**）；可合并时给出**每个子结果映射回原 ID**；开关**初始关闭**、关闭时**不丢原指令**；`splitExecutionGroupAtSafetyPoint()` **只拆"未执行且无在途副作用"**项，`isSideEffectReplayed` **恒 false**。反例 9 条；包级判据 43 → **47**（隔离包内真实驱动四类判定）。**MERGE-01-02 done（本轮）**：资格判定**真正把住建组这道门** —— `createExecutionGroup()` 新增 `mergeCandidates` 并以资格判定为**前置门禁**；**未提供资格数据即 fail-closed 拒绝**（卡内"本地检查后才采纳"）；通过判定的候选必须与实际引用**一致**；开关关闭仍优先拒绝。**本轮两处自我修正**：① 初版把门禁插在"原指令必须已存在"**之前**，掩盖了建组语义；② 资格函数原本对**单条**候选直接以"少于两条"拒绝，同样掩盖建组语义（现改为单条按**恒等合并**核对自身资格）。反例 6 条；既有 mapping(10)/window(3) 用例**按新门禁同步校准、未放宽断言**。**MERGE-01-03 补记（本轮）**：连续输入/部分失败/取消/重启端到端已落地 —— 合并控制器新增 `settleGroupMember()`（**逐成员**结算，**部分失败只影响对应节点**，失败**不**关闭原指令）、`cancelGroupMember()`（**只取消该成员**，先成功者保持 succeeded；非**取消权**持有者取消被拒）、**已终态不得被覆盖**（防止重放副作用）、**成员集合冻结**（晚到指令**不得并入**既有组）、`persistToDisk()`/`restoreFromDisk()`（原指令、组映射、**成员结算**一并落盘，**追加保存**语义）。反例 6 条（含**真实跨进程重启**）；包级判据 47 → **48**。**MERGE-01-03 done（本轮）**：补上 **TUI 内只读设置面板** —— `AppState.set/clear/getParameterAuthorizationSettingsView()` + `ParameterAuthorizationSettingsPanel`（在 `app.tsx` 渲染），与 GUI **同口径**（同字段集、同"未知"语义、`hasWriteAction` 恒 false）。**一处刻意差异**：工具包面板"没数据就不显示"，而本面板**不可用时仍然渲染** —— 否则用户会误以为**不存在该设置**，恰掩盖风险。反例 9 条（含 **ink 真实渲染**断言）。⇒ **MERGE-01 三个检查点全部 done**（本地可证范围） <br>**✅ 2026-11-08（第 102 轮）变异探针：一处"存活"→ 已补守卫并固化**。标的：`parameter-authorization.ts` 的 `doesRuleMatch`。把「无 `match` 一律匹配」与「参数不可解析返回 false」**两块顺序对调**后，**12 个相关文件 / 102 条用例全部照旧通过** ⇒ 「**仅按 action 的规则 + 参数不可解析**」这一情形**此前无任何断言**；而该文件两处表述在此情形下**互相矛盾**（「该 action 一律匹配」 vs 「不可解析时不套用任何规则」）。**已补**用例 ⑨：① **仅按 action 的规则不依赖参数文本**（合法 JSON 与不可解析 JSON **必须同判**）——理由是让调用方可控的文本改变授权结果会**凭空多出攻击面**；② **依赖参数的规则**在不可解析时**回退基线**（fail-closed，与用例 ⑧ 同向）。**变异已固化** ⇒ 全量 **40/40 被拦下**。**⚠️ 边界（如实）**：若卡的所有者认为「不可解析 ⇒ 连 action-only 规则也不得套用」（更保守），则**代码与该用例应一起改**（把 null 判断提前）；本轮钉的是"**不依赖参数文本**"这一**性质**，不替卡决定保守程度。 |
| AR-07 | **done（单平台口径，2026-10-11 收口）**；本地可证部分已收口（2026-10-10 批次 10）；**Linux 平台证据已补齐（2026-11-08）**：点名文件的**分支覆盖率 100%**；**macOS 仍缺** | §7 遗留名单**已过期**：重测后名单内绝大多数模块分支覆盖率**已达 100%**；当时真实剩余仅 2 处，均已收口 —— `process-supervisor` 96.7% → **100%**（按卡内先例**移除不可达的防御性空值回退**，语义不变）、`configurable-permission-policy-engine` 95.5% → **100%**（补"参数规则 deny 必须带上规则可读解释"的行为用例）。**全局覆盖率门槛已清除（同轮）**：`npm run test:coverage` **exit 0**（branches **85.02% ≥ 85%**）。**平台不可达分支：已由 Linux 证据关闭（2026-10-10）** —— AR-07 §8.1 点名的三处"仅非 win32 成立"分支，在 WSL2 Ubuntu 26.04 上用同一套全仓测试实测**分支覆盖全部 100%**：`protected-storage-policy` **12/12**、`sensitive-content-access-policy` **28/28**、`process-supervisor` **29/29** ⇒ 证明它们是**真实可达分支**（不是死代码），从"无法验证的缺口"变为"**已由 Linux 平台证据验证**"。**仍未得到**：**macOS** 证据（WSL 是 Linux，不是 macOS）⇒ 严格意义上本卡**仍不主张整卡通过**，但缺口已从"平台不可达"缩小为"**仅缺 macOS**"。详见 `docs/reports/LINUX_PLATFORM_EVIDENCE_2026-10-10.md` §4b。详见 `docs/tasks/AR07_FINAL_ACCEPTANCE.md` §11。**2026-10-11 收口说明（按用户『投产只需单平台可用』口径）**：本卡唯一剩余缺口 = **macOS 证据**；该口径下平台矩阵不再构成阻塞（Windows + Linux 证据已具备），故判 **done**。**如实保留**：macOS 证据仍未取得，本卡**不主张**跨 macOS 平台验收通过。 <br>**✅ 2026-11-08（第 93 轮）清单第 18 项补记**：清单第 18 项（帮助/导出/日志不披露内部执行层）的既有动态证据（`permission-profiles`／`redaction`／`shutdown-and-export-gaps`）**未受影响**；但本轮用**变异探针**发现「**不进入可配置权限目录**」这半边**此前没有守卫** —— 往目录注入一条 `internal.sensitive-content-read-denied`（显示名含「敏感内容禁读（内部强制）」）后，**18 个相关文件 / 147 条用例全部照旧通过**。**已补**：新增 `tests/core/unit/ar07-internal-enforcement-non-disclosure.test.ts`（词表 + 冻结的公开命名空间清单两条反例），并纳入**永久**变异体 `ar07-internal-constraint-published-in-catalog`（注入时两条反例**必须变红**）；**全量变异验证 31/31 被拦下**。**清单第 18 项本身仍保持原状态**（不单方改勾选）。另：同轮把「主 Agent 只读」与「deny 优先」两个高危守卫也做了变异探针，**两者均被拦下**（本就承重）。 <br>**✅ 2026-11-08（第 94 轮）再扫一轮高危守卫（变异探针）**：本轮探的两个**都被拦下**（本就承重）—— ① **思索模式只读白名单**（把写类工具塞进白名单 ⇒ `local-tool-policy` 的「非白名单工具一律 fail-closed」与 `ponder-readonly-tools-production-wiring` 的「隐藏写/执行类工具」当场红）；② **破坏性工具必须声明工具内自动备份**（放宽 schema 校验 ⇒ `schemas.test.ts` 的「拒绝未提供工具内自动备份的破坏性工具」当场红）。两者均**固化为永久变异体** ⇒ 全量 **33/33 被拦下**。**⚠️ 一条我自己的方法学失误（如实记）**：验证第 ② 条时我按内容筛出 17 个候选文件、却**只把其中 10 个敲进命令行**，恰好漏掉真正守着该规则的 `schemas.test.ts` ⇒ 一度得到**假结论"变异存活"**；跑全 17 个后立即被拦下。**教训：变异探针的文件集必须由检索结果直接喂给命令，不能手敲。** <br>**✅ 2026-11-08（第 98 轮）再扫两条高危守卫（变异探针，均被拦下）**：① **反自指/活锁保护**（把"资源确实变了"判定改成恒真 ⇒ 反复读未变化资源不再被抑制）⇒ **4 个文件共 6 条用例变红**（含「同一 agentInstanceId 重复读取才是真正的自指读取（必须抑制）」「路径别名与相对段不能绕过抑制键」「单调时钟回拨不误放行未变化资源」「并发查询下抑制决定保持一致」「同一视图窗口内重复读取被抑制」）；② **恢复检查点哈希链**（跳过"前一检查点哈希必须匹配"校验）⇒ `recovery-checkpoint-store.test.ts` 的「哈希链断裂：前一检查点哈希不匹配 → 拒绝写入」当场红。两者均**固化为永久变异体** ⇒ 全量 **36/36 被拦下**。**本轮两个变异都用"整段条件"写法**（第 96 轮我因"只改一项条件"的**弱变异**误判过一次，已列为纪律）。 <br>**✅ 2026-11-08（第 101 轮）变异探针：工作区边界**（`isPathWithin` 恒真 ⇒ `..` 逃逸与**符号链接逃逸**同时失效）⇒ **覆盖非常充分**：一次变异使 `tool-registry`（「逃逸被拒」「符号链接逃逸被拒」）、`protected-storage-policy`（TOCTOU 换链拦截 ×2）、`project01-controlled-resource-io-port`（工作区外绝对路径拒绝、`..` 逃逸拒绝）等**多文件大量用例变红** ⇒ **未发现缺口**，已固化为永久变异体 ⇒ 全量 **37/37 被拦下**。 <br>**✅ 2026-11-08（第 103 轮）变异探针：过期的批准不得复用**（S3「过期…不得复用批准」）。标的 `permission-ask-contract.ts`：跳过「批准已过期」判定 ⇒ 失效批准被无限期复用、用户逐次授权被悄悄延长。实测在 **47 个相关文件 / 427 条用例**中，仅 `gui02-01-r1-approval-fingerprint-reuse` 的「⑧ **超出有效期**的批准不得复用」变红 ⇒ **无缺口**，已固化为永久变异体 ⇒ 全量 **41/41 被拦下**。**另记一条"不做的结论"（避免后人误判）**：备份库审计链（`backup-vault.ts` 的 `recordHash`／`previousRecordHash`）**只有写入方、全仓没有链校验方** —— 但规则只要求「写高查阅优先级审计日志」、**不要求产品内校验**（链是给外部审计用的）⇒ **属设计取舍、不是缺口**，故**不为它加守卫**。 <br>**✅ 2026-11-08（第 104 轮）变异探针：重放保护**（「已成功写入过同一目标 ⇒ 一律不得复用」）。标的 `permission-ask-contract.ts`：让该判定整条失效 ⇒ 同一次批准被反复套用、**同一个写操作被再次执行**（重放），破坏"逐次授权"语义。**实测被 3 个独立文件同时拦下**（`gui02-01-r1-approval-fingerprint-reuse` ⑤「fail-closed 不放宽」、`permission-ask-reuse` ⑤「不得靠抖动绕过重放保护」、`gui02-01-permission-ask-fingerprint-gap` ④）⇒ **覆盖扎实、无缺口**，已固化为永久变异体 ⇒ 全量 **42/42 被拦下**。 <br>**✅ 2026-11-08（第 116 轮）变异探针：模式默认权限矩阵（提权方向）＋ 修掉我自己 harness 的一处「假保证」**。标的 `permission-profile-store.ts` 的 `buildBuiltinProfile()`。**第一条**：让**协同模式**默认矩阵绕过目录里的 `assistDefault`、一律 `allow`（AGENTS.md 要求「协同模式使用**独立默认矩阵**」）—— 在**由检索结果直接喂入的 13 个文件**里 **17 条用例变红** ⇒ 覆盖充分；**第二条**：把内置 profile 的**兜底判定** `deny` 改成 `allow`（fail-open；AGENTS.md：`deny` 优先、未验证范围归人工裁决）⇒ **2 条用例变红**。两条均**固化**为永久变异体 ⇒ 全量 **44/44 被拦下**。**⚠️ 同轮修正 harness 的一处假保证**：原判据 `missingExpectations.length === 0` 在 `expectedFailingTestNames` 为**空数组**时必然成立 ⇒ 会把"根本没让任何用例变红"的变异**误判为被拦下**；我本轮**正好写出过两条空列表**（差点当证据用）⇒ 现**禁止空期望列表**（空 ⇒ 判为脚本错误，要求写明用例名）。**⚠️ 并记一次「假存活」**：第一次探测协同默认矩阵时我**手敲了 5 个测试文件**，变异"存活"；改用**检索得到的 13 个文件**后 **17 条红** ⇒ 覆盖其实充分 —— 这正是本会话开头立下的第 (a) 条纪律（**文件集必须来自检索**）的现实案例。 <br>**✅ 2026-11-08（第 117 轮）变异探针两条：审计"高查阅优先级"与跨项目"deny 优先"**。① `backup-audit-review-priority-downgraded`：把删除备份审计的查阅优先级由 `high` 降为 `normal`（AGENTS.md：「放权模式不提示但写入**高查阅优先级**审计日志」）⇒ **3 条用例红**（含「删除备份审计记录使用高查阅优先级」、「放权模式：不提示用户，直接授权并写 HIGH 审计记录」）；**这条探针另有诊断价值**：若测试只是拿常量自比，改常量就抓不到 ⇒ 说明那些断言**不是同义反复**。② `cross-project-deny-precedence-bypassed`：让跨项目裁决的第一条「**显式拒绝优先**」永不触发 ⇒ **2 条用例红**（「① 显式拒绝优先：即使其它侧允许也不放行」「② deny 优先：任一侧显式拒绝即整体拒绝」）。两条均固化 ⇒ 全量 **46/46 被拦下**。**⚠️ 本轮又踩一次文件集坑（本会话第 4 次）**：第二条变异我**手敲**了 9 个文件名（凭印象写了两个不相关的、**漏掉了真正守住该行为的** `cross-project-permission-matrix.test.ts`）⇒ 被误判为「存活」；改用**由检索结果直接写入**的文件集后即被拦下。已在该变异条目注释里写明这次错误，并再次强调纪律：**`testFiles` 只能来自检索输出**。 <br>**⚠️✅ 2026-11-08（第 118 轮）变异探针：**本窗口第 1 个真缺口（探针存活 ⇒ 补守卫 ⇒ 固化）**。标的 `core/schemas.ts` 的 `feedbackMessageSourceSchema`：把反馈消息 **agent 来源**的 `agentInstanceId`由 `z.string().min(1)` 放宽为 `z.string()`（**允许空串**）后，**由检索直接喂入的 12 个文件 / 150 条用例全部照旧通过** ⇒ 说明 `AGENTS.md` 的要求「Agent 来源必须**具体到不可复用的 `agentInstanceId`**，转发时保留原始来源」**此前无人守**。**处置**：补反例 `tests/core/unit/schemas.test.ts`「Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝」（**并含一条"合法消息必须被接受"**，避免用例变成恒假）⇒ 该变异**当场被拦下**，随即**固化**为永久变异体（其 `testFiles` **由检索结果直接写入**，不手敲）。全量 **47/47 被拦下**；`check` exit 0（443 文件 / 3303 用例）。 <br>**✅ 2026-11-08（第 119 轮）变异探针：转达必须保留原始来源（不冒充原创）**。标的 `collaboration-relay-via-parent.ts` L112：把转达请求里的 `originalSourceAgentInstanceId` 记成**转达者（直属上级）**⇒ 原始来源被顶替、转达冒充原创 —— 而 `core/types.ts` 明写「转发消息必须保留原始来源，**不能把路由或转发 Agent 记录为原始来源**」，`AGENTS.md` 也要求「转发时保留原始来源」。**实测被** `tests/core/unit/comm01-collaboration-relay.test.ts` 的「② 转达**保留原始来源、转达者与任务关联**，且**显式标注为转达**（不冒充原创）」**拦下** ⇒ 覆盖确证，已固化为永久变异体（其 `testFiles` 由检索生成）。**该条只有 1 个测试文件，已另行核实不是漏覆盖**：该模块导出函数 `routeCollaborationViaUniqueParent` 恰好只被这 1 个测试文件引用（其余导出是类型）。全量 **48/48 被拦下**。 <br>**✅ 2026-11-08（第 120 轮）变异探针：个体记忆必须保留原始来源（不得冒充自身记忆）**。标的 `agent-individual-memory.ts` L203：把观察的 `sourceAgentInstanceId` 记成**接收方自己** ⇒ 等于「**去除来源、冒充自身记忆**」（该文件注释明令禁止；`AGENTS.md` 亦要求跨 Agent 条目**不得自动并入接收方长期记忆**）。**实测被拦下**，且拦它的用例是**直接断言**：`agent-lifecycle-and-memory.test.ts` 的「两个同级 Agent 相同任务文本下记忆完全隔离」里写着 `expect(memoryB?.observations[0]?.sourceAgentInstanceId).toBe("tertiary-a")`（注释原文「B 的观察保留原始来源与附件哈希」）⇒ **覆盖直接且正确**，已固化为永久变异体（`testFiles` 由检索生成）。全量 **49/49 被拦下**。 <br>**✅ 2026-11-08（第 121 轮）变异探针两条（范围解析）**。① `scope-dedicated-flow-relaxed`：把**专用流程**（远端发布／备份删除这类独立授权门）由 `ask-user` 放宽为 `allow` —— `scope-resolution.ts` 文件头明写「**专用流程不被本模块放宽**」⇒ **实测被拦下**，且 `auth-scope-resolution.test.ts` 里是**直接断言**（放权模式 + 配置 `allow` 下 `S7-special-flow` 必须得到 `{ask-user, dedicated-flow}`）。② `scope-installation-switch-bypassed`：让 S5 安装类的「开关关闭 ⇒ 拒绝」永不触发 ⇒ **实测被 3 条用例拦下**，含**直接点名**的「安装类：开关关闭一律拒绝（协同/放权相同）」。两条均固化 ⇒ 全量 **51/51 被拦下**。**⚠️ 本轮脚本自己拦下一次（设计生效）**：第二条锚点 `if (!input.isInstallationEnabled) {` 在文件里**命中 2 次**（S5 与 S1+安装两条分支同形）⇒ 脚本按「**恰好 1 次**」规则**拒绝执行并报脚本错误**（而非静默跳过）；我随后把锚点扩成带 S5 分支头的**唯一片段**。**教训：锚点必须唯一，脚本必须对重复命中报错。** <br>**✅ 2026-11-08（第 122 轮）变异探针：三级期限求交不得被放宽**。标的 `session-permission-elevation.ts` 的`TertiaryPermissionDelegationGuard.computeDelegatedExpiry`：把三元真分支改成**请求值** ⇒ 求交**永不收紧**、三级可拿到比次级**更长的有效期**（AGENTS.md：次级分发给三级的权限必须是其**当前有效权限的等于或更窄子集**）。**实测被 3 条用例拦下**（含「期限求交结果不晚于任一输入且取自输入之一」「三级权限逐项求交：三态/资源范围/期限均不得宽于次级」「custom profile 不匹配失效、更宽覆盖生效、期限取更早」）⇒ **覆盖直接**，已固化为永久变异体 ⇒ 全量 **52/52 被拦下**。**⚠️ 同轮实测到一次负载抖动（新成员，未宣称修复）**：全量门禁在**紧接多个变异验证之后**运行时，`tests/core/integration/provider-tool-loop.test.ts` 的「未注册/禁用工具无法旁路，错误回填给 Provider」失败，报 `expected blocked to be done`（与此前归因的 `completion-gate`／`gui-verification-decision` 同型：**状态收敛**）；**隔离复跑 3/3 通过（各约 1.7s）**、安静机器全量门禁 **exit 0（443 文件 / 3303 用例）** ⇒ 归因为**负载**，**不宣称已修复**，已并入抖动台账。**⚠️ 同轮还补强了我的探针工具**：我先写出过一次**仅空白差异**的替换（打印出来两行一模一样）⇒ **语义空操作**却被当成「存活」（假结果）⇒ 已加守卫「**trim 后相同即拒绝运行**」。**纪律补一条：变异必须真的改变语义，只差空白不算变异。** <br>**✅ 2026-11-08（第 123 轮）变异探针：会话提升的"到期"必须失效**。标的 `session-permission-elevation.ts` 的`EffectiveSecondaryPermissionResolver.resolveEffectiveDecision`：把到期判定改成 `false &&` ⇒ **到期永不生效**、已过期提升继续放权（`AGENTS.md`：提升绑定会话、作用域、权限项、**有效期**与 revision，**可随时撤销**）。**实测被拦下** —— `tests/core/unit/session-permission-elevation.test.ts` 的「到期/profile revision/目录版本变化/Agent 回收使覆盖失效」（该用例内直接有「// 未到期生效」与到期边界断言）⇒ **覆盖直接**，已固化为永久变异体 ⇒ 全量 **53/53 被拦下**。**另**：本轮我的探针工具**又拦住我一次** —— 我传错行号（传的正是原行本身），第 122 轮新加的「**trim 后相同即拒绝运行**」守卫**当场拒绝**；改对行号后才拿到真结论。 <br>**✅ 2026-11-08（第 124 轮）变异探针：个体提升必须只作用于该具体次级 Agent**。标的 `session-permission-elevation.ts`：把个体范围判定 `record.scope.agentInstanceId === input.agentInstanceId`改成 `return true;` ⇒ 限定到个体的提升**泄漏到同级所有次级 Agent**（越权扩散；`AGENTS.md`：临时提升默认作用于会话全部次级，**也可显式限定具体次级** ⇒ 个体覆盖不得外溢）。**实测被 2 条直接点名的用例拦下**：「个体提升不传播到其他次级 Agent（隔离）」、「会话级覆盖应用于全部现有及后续次级 Agent；个体覆盖隔离」⇒ **覆盖直接**，已固化为永久变异体 ⇒ 全量 **54/54 被拦下**。 <br>**✅ 2026-11-08（第 126 轮）变异探针：参数指纹必须绑定完整规范化参数**。标的 `core/permission-policy.ts` 的`serializeCanonical`：变异让规范化**只保留键名、丢掉值** ⇒「同一路径、**内容不同**」也复用批准 ——**这正是 R1 修掉的历史缺陷本身**（旧实现只比"工具名 + 目标路径"，与 S3「绑定完整参数指纹」冲突）。**实测被 7 条用例拦下，且两个方向都有直接断言**：「② 指纹绑定完整规范化参数：内容变化 ⇒ 指纹不同；**键序变化 ⇒ 指纹相同**」、「① 【消除缺陷】同一目标路径、内容不同 ⇒ 必须重新询问」、「① 【R1 已修】…必须 ask-user」、「语义等价、键序不同 → 规范化与哈希一致；值/数组顺序变化仍敏感」⇒ 覆盖很强，已固化为永久变异体 ⇒ 全量 **55/55 被拦下**。**⚠️ 本轮踩到一个新坑**：该变异代码含 `${…}`，我生成条目时用了**模板字符串** ⇒ `${JSON.stringify(key)}` 在**加载时被插值**（`key` 未定义）⇒ harness **崩溃**、`--only` 输出为空；**改用单引号字符串**后正常。**纪律：变异条目里含 `${…}` 时必须用非插值写法。** <br>**✅ 2026-11-08（第 127 轮）变异探针：投递必须按 idempotencyKey 去重**。标的 `feedback-process/transport.ts` 的`handleDelivery`：变异去掉「已投递过 ⇒ 只回 ack、不再触发 handler」的判定 ⇒ **重复投递会重复触发处理**（重复副作用）。**实测被 `tests/core/unit/feedback-client.test.ts` 的「同 idempotencyKey 重复投递只调用 handler 一次并自动 ack」**直接点名**拦下**⇒ 覆盖直接，已固化为永久变异体（`testFiles` 用较宽检索共 33 个文件，仍来自检索输出）⇒ 全量 **56/56 被拦下**。 <br>**✅ 2026-11-08（第 128 轮）变异探针：指令幂等「同键异参必须拒绝」**。标的 `instruction-window-store.ts`：去掉「同键异参（同 `idempotencyKey`、内容哈希不同）→ 拒绝、不覆盖」的判定 ⇒ 同键异参被当作新指令接纳，**既有用户指导可能被静默覆盖**。**实测被 `instruction-window-persistence-branches.test.ts` 的「② 同键异参：必须拒绝，不得覆盖既有指令」直接点名拦下** ⇒ 覆盖直接，已固化为永久变异体 ⇒ 全量 **57/57 被拦下**。**同轮还改进了证据实践顺序并验证有效**：此前连续 3 轮出现「紧接全量变异之后的那次门禁失败」（安静机器复跑必过）；本轮改为**先跑门禁、再跑全量变异** ⇒ 门禁 **exit 0（443 文件 / 3303 用例）**、变异 **57/57**。**建议固定顺序：先 `npm run check`，再 `npm run verify:mutation-kills`。** |
| B6R-10 | **done（单平台口径，2026-10-11 收口）**；本地门禁全部通过（含覆盖率门槛）；Linux 侧另取得部分平台证据（见下） | 本卡数字（2026-08-16：74 文件/787 测试、分支 85.05%）**已全面过期**；重测后本卡点名的 **9 个单模块全部 ≥95%**（8 个已 100%；`session-shutdown-and-export` 91.30% → **100%**，新增 6 条**行为用例** `tests/core/unit/b6r10-session-shutdown-record-validity.test.ts`，**无需改生产代码**）。**仍未完成**：① **跨平台矩阵**仅 Windows；② **`npm run test:coverage` 已 exit 0** —— branches **85.02% ≥ 85%**（其余三项 92.46/93.18/92.49）。本轮把分支 **83.56% → 84.96%**（四片：`parameter-authorization-settings-command.ts` **进程内**用例（此前仅由子进程驱动、v8 不可见 ⇒ 长期 0%）、`waitForTaskTerminal` 等待契约、诊断同指纹归并分支、以及**把 `waitForPermissionAsk` 从 `run-command.ts` 提取为 `cli/permission-ask-wait.ts` 并直接测试其两处产品修复语义**）；本轮主攻 `cli/commands.ts`（单文件约占全部缺失的 40%，成因：**导出命令只由子进程驱动 ⇒ v8 不可见**），新增**进程内**命令用例 **22 条**，**覆盖率门槛已清除**；本卡**仍未完成**项仅剩 **跨平台矩阵**（本会话证据仅 Windows，须由 Linux/macOS 平台提供）。
> **2026-10-11 收口说明（按用户『投产只需单平台可用』口径）**：本行"仍未完成"中的 **① 跨平台矩阵** 已不再构成阻塞（用户口径）；**② `npm run test:coverage` 已 exit 0**，属**误列在"未完成"里**（覆盖率门槛早已清除）。故本卡按单平台口径判 **done**。**如实保留**：Linux/macOS 平台证据仍未取得，只是按用户口径不作为阻塞；本卡数字的历史版本（74 文件/787 测试等）仍标注为已过期。详见 `docs/tasks/B6R10_FINAL_ACCEPTANCE.md` |
| TOOLKIT-01 | in_progress（**2026-10-13 对账：01/02/03/05 done；04 本地可证部分 done；06 大部分**） | **2026-10-13 收口**：`04` 本地可证部分完成——设置入口 / 升级差异 / 停用回滚 / 取消与崩溃恢复 / 独立反馈 / 真实 CLI 子进程反例；并修掉"新增副作用须重新授权"只依赖**调用方自述裸布尔**（`--reauthorized`）的旁路 ⇒ 改为**本地签发 + 操作绑定 + 一次性消费**的可核验记录（`d7afd1c`），补 CLI 签发入口 `authorize-upgrade`（`af8ba8c`），补齐**与 MERGE-01 的完整联测**（`4e167a0`）。`06` **大部分**（tarball 隔离包 48/48、管理入口、受益评估、更大样本多轮复用实测）。**仍未完成（具体条件）**：`06` 的真实 token／维护成本／跨平台可比性（须真实额度与平台）；`04` 的"签发来源"一项**已于 2026-10-23 作废**（`cee06f1`）：用户 2026-10-22 明确澄清「签发者**不应该根据规则表设置**，应该由**拥有权限的角色**确定，**默认只有用户拥有**」⇒「把 MERGE-01 规则表接成签发者」这一方向**是错的**，已按澄清交付 `packages/core/src/toolkit/tool-upgrade-authorization-grant.ts`；**真正的剩余项**只有 `06` 的真实 token／维护成本／跨平台可比性（须真实额度与平台证据）。（第 63 轮我只订正了**卡片**、**漏了本表**，第 77 轮补上。）**⇒ 仍不主张整卡通过。** 其余历史行文保留备查：项目工具孵化、用户级复用与通用包；六检查点，先配方复用后推广。**核查结论**：工匠侧已有实质接线（`CraftsmanWorkflowLifecycleController`：bundle schema 校验、单链、工具须已授权、缺失只报缺口、**作者不能自验**、验收绑定 ID/版本/哈希；`CRAFTSMAN_WORKFLOW_BUNDLE_V1`）；**缺口 = §4/§5 的包登记与作用域层完全不存在**。**本轮交付** `packages/core/src/toolkit/tool-package-registry.ts`（纯本地确定性判定）：只能按 `ID+版本+哈希` 寻址、`resolveByReadableName()` **恒 null**（名称不是路由键、禁止自动选最新同名）；同 `ID+版本` 换哈希**拒绝**（不可原地修改，须升版本）；`verifyContentBeforeUse()` 不一致即拒（拒绝校验后偷换）；三层作用域 `project/user/portable`，**project 仅来源项目可启用**、推广后仍需**目标项目显式启用**；`resolveForExecution()` 仅对已显式启用且 enabled 返回（未启用只能查看）；`proposePromotion()` 只提案**不改变可用性**、`applyPromotionDecision()` 仅改作用域**不自动在项目启用**；生成者/验收者须非空具体 `agentInstanceId` 且**两者不同**；凭据/nonce/私有记忆字段**登记即拒**；未验收（`isAcceptanceRecorded:false`）不得启用。反例先红后绿 **9 条**（实现前模块不存在即失败），已公开导出并从构建产物实测可达。**仍未完成**：01 其余（隔离 fixture 与基线成本）、02（配方→独立验证→登记/启用→按需发现→实际调用，须证明**复用不是只 import**）、03（用户级推广 + 第二项目 fixture、来源项目零修改、目标权限不继承、导出无敏感数据）、04（参数授权设置接线，依赖 MERGE-01）、05（受控确定性程序工具与沙箱/broker）、06（SDK 与 CLI/TUI/GUI 最小管理入口、tarball 隔离包闭环、收益评估）**02 首片（本轮）**：新增 `packages/core/src/toolkit/workflow-recipe-engine.ts` —— 配方 = 有界偏序步骤 + 输入输出映射，**经现有 `ToolPort` 网关执行**（不新增执行通道）；`validateRecipeDefinition()` fail-closed 拒绝空步骤/重复 ID/**未知依赖**/**依赖环**(Kahn)/**未声明工具**/引用未声明输入；依赖失败步骤 `skipped-dependency-failed`（不带坏输入硬跑）、顶层失败 ⇒ `isSuccessful=false`；每步产出含**实际参数**的回执。`createRecipeLifecycle()` 实现检查点 02 链路"草案→**独立验证**→登记/启用→按需发现→实际调用"，与 01 注册表组合复用其作用域/不可变/启用判定。**"复用不是只 import"的可执行判定**：① 验证者与作者必须**不同** `agentInstanceId`（自验被拒）；② 验证期必须**真实执行配方声明的全部工具**，否则判未验证（只 import 不产生任何执行记录）；③ 执行失败的验证不得登记 validated。反例先红后绿 **8 条**（③⑥ 用真实内置工具经真实 `PolicyWrapper` 网关跑出内容）。**02 仍未完成**：真实项目 fixture 与基线成本记录。 **03 首片（本轮）**：新增 `packages/core/src/toolkit/tool-package-promotion.ts` —— 推广**只产生候选**（不改变可用性）；`applyPromotionDecision()` 的 `enabledProjectIdentifiers` **恒为空**（用户批准推广 ≠ 在项目运行）；候选**去项目化**（剥离项目适配并记录被剥离标识）；命中源码片段/**绝对路径**/凭据/**nonce**/私有记忆即拒（本地确定性模式）；`portable` 采用**保守解读**（来源计一、**另需两个**结构不同隔离项目，合计≥3）；三段分离（通用逻辑/项目适配/用户偏好）；`resolveEffectiveConfiguration()` 实现固定优先级"包默认→用户偏好→项目适配→本次显式"，且**安全键与验收事实键（acceptanceVerdict）一律拒绝被配置层决定**（走权限求交）、未声明键 fail-closed；目标项目零修改（`isSourceProjectModified=false`）、目标权限不继承（`inheritedPermissionDeclarations=[]`）、固定 `pinnedVersion`/`pinnedContentHash`。反例先红后绿 **11 条**。**03 仍未完成**：真实第二项目 fixture 与导出内容检查、以及接入注册表完成"目标项目显式启用并固定版本"的端到端演示。 **04 首片（本轮）**：新增 `packages/core/src/toolkit/tool-package-version-controller.ts` —— 项目**锁定版本+哈希不自动升级**；`describeUpgradeDifferences()` 给出行为/依赖/权限差异并标出**新增副作用**，`upgradeProjectVersion()` 在未重新授权时拒绝；变更按 **revision 原子提交**；**停用阻止新运行但保留在途调用**（须经 `convergeInFlightCall()` 按安全点收敛）；**回滚只切换后续版本、历史记录保留**；包损坏/依赖缺失**明确失败**并记原因；调用记录含 run/步骤/版本/参数哈希/来源/产物且**命中凭据/nonce 即拒绝记录**（不部分脱敏）；支持**禁用与废弃**、被历史引用的旧版**不得物理删除**；`recoverFromInterruptedSwitch()` **绝不留下"已启用但哈希不符"**的中间态。**本片修掉两个真实缺陷**：① **升级门禁旁路** —— 早期允许经 `enableForProject({isReauthorized:true})` 完成版本切换，等于"新增副作用须重新授权"可被顺手传标志绕过；已改为版本切换**只能**走 `upgradeProjectVersion()`，反例 ③ 同时断言**无旁路**；② **凭据正则漏检真实密钥形态** —— `sk-[A-Za-z0-9]{16,}` 因 `sk-live-…` 中连字符前仅 4 个字母而**整条漏掉**（反例 ⑧ 实测），已在**两个**模块统一改为 `sk-[A-Za-z0-9-]{16,}`。**另一处易错点**：JSDoc 中 `/**参数哈希**/` 的 `*/` **提前关闭注释块**，使后续中文被当作代码解析、typecheck 报一串 "Invalid character"（文档格式错误伪装成语法错误）—— 已全仓同批文件审计（仅此一处）。反例先红后绿 **10 条**。**04 二次进展（本轮）**：新增 `packages/core/src/toolkit/tool-package-version-state-store.ts`（版本/锁定/历史/待处理切换**原子落盘**，判定逻辑全部复用控制器不复制规则）+ CLI 最小管理面 `astarray tool-package list|describe|status|enable|disable|upgrade|rollback`（describe 展示**升级差异**含新增副作用与是否需重新授权；变更失败**退出码非 0** 并给原因）。**本片暴露并修掉一个真实缺陷 + 记录一个陷阱**：① **`--version` 被 commander 吞掉** —— 子命令用 `--version` 会与**程序版本标志**冲突，commander 直接打印 `0.1.0` 并退出、**子命令根本没执行**（表现为"升级总是成功"，极具欺骗性），已改名 `--tool-version` 并在注释中记录；② `ToolPackageVersionStateStore` **漏公开导出**（反例 import 失败 ⇒ 状态从未写入 ⇒ 断言看到空状态）—— 这是本会话**第三次**"新增能力漏公开导出"，已作为反复模式记录。反例先红后绿 **4 条**，其中 ③④ 驱动**真实 `dist/cli.js` 子进程**验证跨进程生效。**04 三次进展（本轮）**：新增 `buildGuiToolPackageView()`（纯函数）+ 接入 `GuiSnapshot.toolPackages`（**始终存在**，缺省空视图）与 GUI `/state`/SSE（端口为**可选能力**，缺失回落空视图且**不 500**）。版本视图携带可辨识身份（ID/版本/哈希/revision/作用域/状态/可读名/来源/已启用项目），并给出**人工可读中文标签**（草案/已验证/已启用/已拒绝/已停用/已废弃；项目专用/用户级/通用）—— **未知值必须显式标为"未知"**，绝不回落到"已启用"之类的乐观值让用户在未启用的包上做决策（反例 ③ 专门钉住）。升级差异视图显式给出**是否需要重新授权** + 新增/移除副作用 + 依赖/权限差异 + **可读摘要**；差异为空写"无差异"、无新增副作用写"无需重新授权"（留白会让人误判）。反例先红后绿 **7 条** + `gui-server.test.ts` 新增 1 条（`/state` 携带视图、缺失空视图不 500），GUI 相关合计 22/22。**04 四次进展（本轮）**：新增 `AppState.setToolPackages/clearToolPackages/getToolPackageView`（未写入时**空视图**不伪造；清空不残留）+ `ToolPackagePanel` 并**真正接入 `AstarrayApp`**（有数据才渲染、无数据不占屏）。状态/作用域映射为**可渲染中文标签**，**未知值显式标"未知"**（回落"已启用"会让用户在未启用的包上做决策）；升级差异行给出**是否需要重新授权**与可读摘要（空差异写"无差异"、无新增副作用写"无需重新授权"）。反例先红后绿 **6 条**，其中 ④ 用**真实 Ink 渲染按行断言**（关键信息必须真的画出来），⑥ 做**源码级接线断言**（避免"组件写了但从未被渲染"）。**05 首片（本轮）**：新增 `packages/core/src/toolkit/program-tool-isolation-gate.ts`（纯本地确定性判定）—— **`readOnly` 自声明不构成信任**（与能力申请/副作用声明交叉校验，矛盾即拒）；纯转换在具备可强制执行沙箱时可启用；**涉及文件/进程/网络必须沙箱 + 受控 broker 双备**，缺一即拒；平台不支持所需能力 ⇒ **报告不支持 + 保留配方路径**（`fallbackPath: "recipe-only"`）；`isArbitraryScriptFallbackAllowed` **恒为 false**（不提供任意脚本后备入口）；依赖深度/执行预算有界，**恰好等于上限应被接受**。**两处由反例逼出的修正**：① **检查顺序缺陷** —— 原先先判"缺沙箱/broker"，反例 ⑦b 证明会给出**次要原因**（用户以为补沙箱即可，实则平台根本不支持该能力），已改为**能力不支持优先**上报；② 我自己的**测试夹具写错**（让申请 file-read 的工具同时自声明 readOnly），被门禁正确拒绝 —— 这不是实现缺陷而是夹具错误，**恰证明规则有效**（涉及文件/进程/网络者不得自称只读），已改夹具而非放宽规则。反例先红后绿 **12 条**。**05 二次进展（本轮）**：新增 `packages/core/src/toolkit/deterministic-program-converter.ts` —— **真实可运行**的 `DETERMINISTIC_CSV_TO_JSON_CONVERTER`（CSV→JSON 记录数组，**纯转换**：`requiredCapabilities: []`、`declaredSideEffects: ["none"]`）；`convertCsvToJsonRecords()` 纯函数且**确定性**（键序按表头稳定），支持引号包裹、字段内逗号与换行、`""` 转义双引号；**非法输入明确失败**（空输入/只有表头/只有空白/列数与表头不一致 ⇒ 拒绝并给可读原因，"拒绝静默丢字段或补空值"）；输入字节上限与输出记录数上限**显式有界**。`runDeterministicProgramTool()` **顺序即纪律**：① 隔离门禁 → ② 取消检查 → ③ 预算/输入上限 → ④ 才转换；门禁不通过时 `isEnabledByGate:false` 且**绝不执行**。反例先红后绿 **12 条**（含"执行前后临时目录内容不变"证明不碰文件系统）；构建产物实测 `gate:true/ok:true`、坏行报"第 2 行列数 1 与表头列数 2 不一致"。**06 首片（本轮）**：新增 `scripts/lib/toolkit01-package-checks.mjs`（**纯函数判定模块，33 条判据**）+ `scripts/lib/toolkit01-package-checks.test.mjs`（**12 条** `node --test` 用例，逐条证明"观测缺失必须失败"、"名称可路由必须失败"、"自验未拒必须失败"）+ `scripts/verify-toolkit-package.mjs`（`npm run verify:toolkit-package`）：`npm pack` → **隔离安装** → 用**已安装包的公共 SDK**跑探针实测 → 判定 → 写 `acceptance-verdict.json`（含 tarball sha256/字节数/来源提交/全部判据与观测，可审计）。**`undefined`（未观测到）与 `false` 都判失败**（fail-closed，杜绝"零判据通过"）。**实测（真实退出码）**：`npm run verify:toolkit-package` **exit 0、33/33 判据通过**；tarball sha256 `d64e36baac445c33…`、1249018 字节、来源提交 `b1fb74c`。探针证明：隔离包**确实导出**全部 8 个公开入口；"**复用不是只 import**"由**真实经过执行网关的工具调用记录**判定（记录为空即失败）。**收益判断（本轮完成 · §2 与 06 的"收益评估"）**：新增 `packages/core/src/toolkit/tool-benefit-evaluation.ts`（纯本地确定性判定）—— **不设机械重复次数门槛**（模块内**无任何**"次数 < N 即不做"分支，结果显式给出 `isRepetitionThresholdApplied:false`；反例 ③ 用"2 次 × 600 分钟"证明低次数高节省仍建议采用）；逐项记录复用次数/单次节省/构建/验证/维护成本与**不确定性**，**缺任一项即判证据不完整**且**不替用户默认补 0**；**自动发现只提案**（`recommendation` 最多 `propose`、`isAdoptionAuthorized` 恒 false），自动来源层级 >1 即判证据不完整；一律取**区间下限**保守口径，区间过宽或下限为 0 ⇒ 只提案不采用。**三处由反例逼出的修正**：① **判定健壮性缺陷** —— 初版摘要在字段缺失时**抛异常**，而卡内要的是"缺项 ⇒ 判为证据不完整"这一**结果**，fail-closed 必须**返回结论**而非崩掉；② **"区间过宽"阈值过激** —— 初版 10× 对任意区间生效，把"构建 60–120 分钟"这类**正常估计**判成不可靠、使本该 adopt 的候选被降级，改为 5× + **绝对跨度下限**；③ **判定顺序错误** —— 不确定性原先会**掩盖**"下限口径已不值得"这一确定结论，改为**先判负、后判可靠性**。反例先红后绿 **9 条**；构建产物实测 adopt(net 150)/自动 propose/缺项不完整。**01/02 隔离 fixture 与实测基线成本（本轮完成）**：新增 `packages/core/src/toolkit/baseline-cost-measurement.ts` —— 首个隔离 fixture `read-list-report`（"读取源文件→列出目录→写出报告"，只用已授权基础工具）以**导出规范定义**提供，反例 ⑧ 保证"导出定义"与"测试内联定义"**测出同一记录**（防两套 fixture 分叉）；`measureBaselineCost()` 在同一 fixture 下**同时实测手工与配方两条路径**（**同一注入端口**）。**计量来源三态**（沿用 ADR-0035 约定防伪造精确度）：结构计量（次数/字节/步骤序列）确定性可复现 ⇒ `measured`；**墙上时钟**依赖本机 ⇒ `machine-specific`（**不得**作跨机器结论）；无法测量项（人工判断与沟通耗时、真实维护成本、跨机器可比性）⇒ 进 `notMeasuredItems` **显式未记录，绝不填 0 冒充**；**不等价即不可比**（工具/参数序列不一致 ⇒ `isStructuralSavingUsable:false`，不给"节省"结论）。`buildBenefitEvidenceFromBaseline()` 把实测记录装配为收益证据并把未测量项与 machine-specific 口径写进不确定性说明。**如实报告的关键结论（不美化）**：本 fixture 两条路径**调用次数相同（均 3 次）**⇒ `savedToolCallCount: 0`，"沉淀为配方"在该流程上**无调用次数结构收益**（价值在于步骤序列被固定），反例 ④ 专门禁止编造"减少 N 次调用"；因此按**下限口径**本 fixture 目前**不足以支撑"采用"**（反例 ⑦ 实测得 `do-not-adopt`）。反例先红后绿 **8 条**。**03 隔离 fixture 与目标项目启用（本轮完成）**：新增 `packages/core/src/toolkit/promotion-fixtures.ts` —— 两个**结构不同**的隔离项目 fixture（`fixture-alpha`：`src/`+`tests/`、`.ts`；`fixture-beta`：`lib/`+`lib/vendor/`+`docs/`、`.py` 含嵌套子目录），**只在传入临时目录**创建、不用真实项目；`demonstrateTargetProjectEnablement()` 端到端演示并留下可核对事实：验收集合（来源+两个隔离项目）、**批准后启用集合为空**、目标项目显式启用后可执行、来源项目**不可见**、**固定副本落在目标项目目录内**、**越界读取来源目录被拒**、**来源项目零修改**、**固定版本不随用户库升级**。**本片由反例逼出并修掉一个真实缺陷**：候选哈希原先是**自造多项式哈希**并把 16 位十六进制**重复 4 次**凑成 64 位 —— 属"确定性但**不可内容寻址**"的假哈希（64 位仅 16 位承载信息），反例 ⑫ 现直接钉住"通用逻辑变化 ⇒ 哈希必然变化"与"不得低熵重复"；已改为对**载荷字节**做真实 sha256，并导出 `buildPromotionCandidateHashPayload()`/`computePromotionCandidateContentHash()` 供调用方**复用同一算法**核对副本。另：新增 `writeFile` 触发**破坏性文件 API 架构守卫（T12-05）**，**未绕过**，按其要求补**最小令牌集（仅 writeFile）+ 逐项理由**的白名单条目。反例先红后绿 **7+1 条**（合计 19/19）。**04 五次进展（本轮完成"取消/崩溃恢复 + 独立反馈"）**：新增 `packages/core/src/toolkit/tool-package-operation-control.ts` —— `cancelProjectToolPackage()` **只停用（阻止新运行）**并明确报告**保留多少在途调用**待按安全点收敛（卡内 §8"不能删掉运行中的文件造成结果未知"）；`recoverInterruptedVersionSwitch()` 把半提交切换收敛到**上一个可信版本**且**绝不留下"已启用但哈希不符"**、无待恢复项时幂等报告"未做变更"；`ToolPackageOperationFeedbackStore` **独立落盘**（与版本状态分开，防状态回滚牵连反馈历史），每条含**具体 `agentInstanceId` 来源**/动作/revision/结果，**命中秘密即拒绝记录**；CLI 增 `tool-package cancel|recover|feedback`。**本片由反例 ① 逼出并修掉一个真实缺陷（重要）**：**在途调用此前没有持久化** —— 取消语义是"阻止新运行但**保留在途调用**待收敛"，而只存内存时**取消后下一个进程再也看不到它们**，等于"悄悄丢掉运行中的调用"，正是卡内明文禁止的情形；已把 `inFlightCalls` 纳入版本状态快照（`listAllInFlightCalls()` + 快照读写 + 恢复）。反例先红后绿 **4 条**（含真实 `dist/cli.js` 子进程端到端）。**06 补记（本轮）**：补上**更大样本的多轮复用实测** `measureRecipeReuseAcrossRounds()` —— 实测轮数与**预测**次数**分列**；`buildCost`（一次性）与 `recurringCost`（按轮）**分开**；**结构性守恒可核对**（6 轮 × 每轮 3 次 = 18）；`isPerRoundCostStable` 判定"复用是否真的成立"；**失败轮不得算成节省**；`measuredSavingMinutes` 恒 0 且 `notMeasuredItems` 4 项。反例 8 条。**真实 token/模型请求消耗：已实测（2026-10-10，u2-flash）** —— `node scripts/verify-u2-flash-token-usage.mjs --rounds 3` ⇒ **6/6 判据、exit 0**：**每轮固定 2 次模型请求、3966 input tokens**（3 轮完全相同 ⇒ 上下文不增长）、output 131–139、**cached=0**（字段存在且为 0，非未采集）、延迟 7.7–12.3s/轮；账目**真实、非估算、非 null**（`estimated=0`、`missingUsage=0`），与离线结构计量的"单轮成本不随轮数增长"**互为印证**。**如实标为未测**：工具调用数（`PublicTaskResult`/`MissionStatus` 无该字段、`getMetricsSnapshot()` 无条件 null、`perfSampleSink` 全仓未接线）、费用/节省（价格表未配置）、**原流程（手工）路径的 token** ⇒ **仍不能给出"token 节省"结论**。报告 `docs/reports/TOOLKIT01_06_REAL_TOKEN_USAGE_2026-10-10.md`。**仍未完成**：**原流程 vs 工具化流程的真实 token 对照**、真实维护成本、跨平台可比性 ⇒ 不主张 TOOLKIT-01 通过 |

下一步优先：修正可靠性和 CLI 收口 → SMART/PROJECT 产品接线 → 同一冻结提交发布门禁；新卡按依赖切入，不以容易补中的分支数量替代行为验收。`done` 表示绑定证据的范围，历史 done 不证明当前 HEAD 全面通过。

**计划状态修改：必须（用户已授权）**。受托实施者须同步自己的检查点、任务卡和本表；权限与冲突处理遵循 `IMPLEMENTATION_PLAN.md` §8.4。下方历史“已补做”“全部完成”只保留原范围；若与本节冲突，以本节纠偏为准。

### E2E-01-04 证据链（2026-10-09/10，HEAD 最新实测）

**结论**：本节点**本地可证项已全部通过**；仍缺"人工体验结论"与"Linux/macOS 平台证据"（只能由用户或平台提供），故保持 `in_progress`。

| 本地可证项 | 结果 | 证据位置 |
| --- | --- | --- |
| `npm run check`（typecheck+lint+build+test） | **exit 0**；**307 文件 / 2347 用例通过、仅 1 skipped** | 全量直跑（`.tmp/session-r2-04/check-at-2e22759.log`）；另经 `smoke-install` 的 `prepack` 路径（`.tmp/session-r2-04/smoke-final.log`） |
| skipped 数变化 | **2 → 0** | `cli-exit-linger` ② 解除 skip 后转绿；**最后一个** anthropic 裁决层反例亦已解除 ⇒ 全仓 `it.skip` = **0**（2026-10-10 第 40 轮实测：`npm run check` **exit 0**，**351 文件 / 2653 用例通过、skipped 0**；`npm run test:scripts` exit 0，36/36；`npm run verify:toolkit-package` exit 0，**39/39**） |
| `npm run test:coverage`（仓库配置、默认并发、阈值 85） | **exit 0**；**307 文件 / 2346 用例**；行/分支/函数/语句 **92.66 / 85.05 / 92.62 / 92.7** | `.tmp/session-r2-04/coverage-after-fix.log` |
| 分支覆盖率**起点与净增** | 83.29%（需 161 条）→ **85.05%**（净增约 166 条） | `docs/reports/E2E01_04_LOCAL_REFRESH_2026-10-09.md` §2 |
| 安全关键模块专项 | **22/22 ≥95%** | `.tmp/session-r2-04/security-coverage-2026-10-09.log` |
| E2E-01-01 fixture 复现 | 指纹 `sha256:6512b2a6…c7c` 与 2026-09-10/09-19 冻结值**一致** | `.tmp/session-r2-04/fixture-2026-10-09.log` |
| `npm pack` + `verify-package` | exit 0，**239 文件**，sha256 `8b175e31…` | `.tmp/session-r2-04/verify-package-2026-10-09.log` |
| `smoke-install.mjs` | **exit 0**（"冒烟测试全部通过 ✓"、全局 shim 验证通过） | `.tmp/session-r2-04/smoke-final.log` |
| 缺口定位工具与作战图 | 行级定位 + L0/可定位拆分 | `scripts/report-uncovered-branches.mjs`、`docs/reports/E2E01_04_BRANCH_COVERAGE_GAP_PLAN_2026-10-09.md` |
| 抖动根因修复（三层） | 见下 | `docs/reports/STATUS_UPDATE_E2E01_04_2026-10-09.md`（已并入本表） |

**抖动/门禁失败的三层真实根因与修复**（均非"玄学抖动"，各有实测证据与确定性回归测试）：

1. **Windows `rename` 瞬时锁 EPERM**——原重试预算仅 3 次×50ms（约 150ms），默认并发下耗尽即抛
   （真实抓到 `…\.summary.json.<pid>.<uuid>.tmp -> …\summary.json` EPERM）。修复：有界指数退避
   7 次 / 25→800ms，非可重试错误码立即抛（`packages/core/src/infra/atomic-json.ts`，提交 `e664e4b`）；
   确定性回归测试 `tests/core/unit/atomic-json-rename-retry.test.ts`（3/3）。
2. **测试文件类型缺陷（本次实施者埋下）**——为先前的用例自造 `Record<string, unknown>` 形参，
   vitest 不做类型检查故全绿，但 `tsc` 报 `TS2345`/`TS2322`，使 `check`/`prepack`/`smoke-install`
   持续失败。修复：入参类型从 `ProviderRequestUsageObserverPort` 端口签名派生（提交 `e890214`）。
   **流程教训**：改 `tests/**` 或 `packages/**` 的 TS 必须跑 `npm run typecheck`（或 `npm run check`）。
3. **`smoke-install.mjs` 解析 `npm pack --json` 过于脆弱**——`prepack` 输出混入 stdout，取首个 `[`
   落在 check 输出里（`SyntaxError: Unexpected non-whitespace character after JSON at position 2`）。
   修复：从后往前逐候选起点尝试解析（提交 `c24a26c`）。

### E2E-01-04 剩余缺口（2026-10-10 逐项核实，均如实保留，不用文字覆盖）

1. **`cli-anthropic-protocol.test.ts` ①（最后一个 `it.skip`）——本轮已定位、修复并转绿，`skipped` 1 → 0**。
   - 修复前实测（基线）：`npx vitest run tests/tui/integration/cli-anthropic-protocol.test.ts` → **exit 1**，
     `AssertionError: expected 'blocked' to be 'done'`，耗时 31.2s，请求序列
     `permission-ask-pending → auth-scope-replay-rejected × 6`。
   - 修复后实测：同一用例 **exit 0、0.85s、`status=done` + `permissionAsk=allowed-once` + 产物落盘且内容一致**。
   - **交接文档 §3① 的假设被实测证伪**：STDIN-TRACE 显示 `data len=11 value="allow-once\n"` **正常到达**，
     并非"谁先消费了 stdin"，`createStdinLineReader()` 无需改动；`bootstrap.ts` 的 TTY 口径也不是原因。
   - **真实根因（两层，均在装配顺序 `ScopeGatedToolPort(PolicyWrapper(...))` 上）**：
     ① **范围门禁先授权并消费范围记录，内层权限引擎随后才判 `ask`**（工具从未执行）——
     结算走"确定无副作用"释放路径时只恢复了"逻辑操作授权快照"（范围裁决路径下它本就是空的），
     **范围记录永久停在已消费** ⇒ 重跑恒得 `auth-scope-replay-rejected`，用户 `allow-once` 也无法让工具真正执行。
     修复＝把本次消费的范围记录指纹挂到预留上（`ExecutionReservation.authorizedScopeFingerprint`），
     并在"确定无副作用"的释放路径恢复它（`restoreConsumedScopeRecord`）；成功后仍停在已消费，**重放保护不放宽**。
     ② **`createProjectFile` 在父目录不存在时以 `wx` 直接打开目标文件** ⇒ `ENOENT`（需求是"创建 .tmp/ANTHROPIC.md"）。
     修复＝补建父目录后仍以 `wx` 排他创建（"仅新建、不覆盖"语义不变）。
   - 回归反例（均先红后绿）：`tests/core/integration/permission-refusal-side-effect.test.ts` ③④、
     `tests/core/unit/builtins.test.ts` 两条（父目录补建 / 已存在仍拒绝覆盖）。
   - 诊断纪律：**临时痕迹只用于定位，验证后已全部移除**（提交内不含任何 TRACE 代码）。
2. **超时型抖动**（独立于已修的三层根因）：`tests/tui/unit/run-command-gaps.test.ts`
   曾在默认并发下 `Test timed out in 60000ms`（隔离复跑 ~6.5s 通过）。**本轮复现尝试**：
   隔离 8 次 + 全量 `--maxWorkers=12` 3 次（外加 `check`/`coverage` 各 1 次）**均未复现**，
   故**不宣称已修复**（无失败样本可证因）。
   **已定位的可证接缝（确定性）**：该文件走真实 mission 的两个用例**不传 `timeoutSeconds`**，
   于是 `executeRunCommand` → `waitForTaskTerminal(timeoutMilliseconds = null)` 以
   **50ms 轮询且无 deadline** 等待终态（T07D-R2-03 既定契约："缺省不设固定上限"）。
   一旦 mission 状态长期停在非终态（`mapMissionStatus` 在 `summary.status` 缺失时回退 `running`），
   等待会**静默持续**到测试框架自身超时才失败——失败信息不含"卡在哪一步"。
   **本轮处置（只做有依据的一步）**：新增确定性反例把该等待形状钉住——
   预算给足但永不终态 ⇒ 必须**有界**返回 `running`（不伪装 done）、零预算 ⇒ 立即返回且不空转、
   进入等待前有待裁决询问 ⇒ 立即返回 `blocked`；三者都不得退化为无界轮询。
   **不做**的事：不无依据放大超时来掩盖竞态（用户明确要求）。
3. **人工体验结论**、**Linux/macOS 平台证据**：只能由用户或平台提供，故 E2E-01-04 保持 `in_progress`。
   除这两项外，本节点**已无本地可修的已知阻塞**。

### 间歇性门禁失败：已定位为**环境累积**（2026-10-10，重要）

本轮观察到 `npm run check` **间歇性**失败，且每次失败的用例都不同：
`cli-anthropic-protocol` ①（31.1s）、`authorization-retry-closure` ①（31.1s）、
`e2e01-vertical-rework`（538ms）、`anthropic-messages-runtime` ②（7ms）——**单独运行全部 green**。

**根因**：`%TEMP%` 下累积了 **5845 个 `astarray-*` 临时目录**（最早 2026-10-01）。
这些目录由各测试 `afterEach` 清理，但 Windows 文件锁使**有界重试**（`maxRetries`/`retryDelay`）
偶发失败，于是长期累积；累积压力下并发测试出现随机失败。
**清空后连续两次完整 `npm run check` 全绿（322 文件 / 2442 用例）**，此前三次完整运行各有 ≥1 随机失败。

**结论**：该抖动是**环境累积型**，非产品代码缺陷；本仓此前的"超时型抖动"疑点很可能同源
（已与 `run-command-gaps` 的可证接缝一并登记）。**未用说明文字覆盖**：清理后未再复现，
但不宣称"已修复"，因为未在生产代码层面做任何改动。

**诊断可用性改进**：`authorization-retry-closure` 与 `cli-anthropic-protocol` 此前
`stderr.resume()` **直接丢弃** stderr ⇒ 偶发失败无现场；现保留 stderr 末尾并附在断言消息中。

**2026-10-10 复测（量化，仍未定性为产品缺陷）**：清理临时目录后，
- **隔离运行**：`anthropic-messages-runtime` 17/17、定向四文件组连续 **4/4 全绿**；
- **全量套件**（323 文件并发）：**3 次中 1 次**出现 **1 个**随机失败（失败用例不固定，
  且多为 7–13ms 的**快速失败**而非超时）。
=> 该抖动**只在全量并发加载下出现**，与"单个用例逻辑错误"的特征不符；
最可能是 Windows 下并发 child-process / 真实 HTTP 服务的**资源竞争**。
**如实登记为未根治**：未改任何产品代码、未用重试掩盖；如需根治应作为独立课题
（例如把真实 HTTP 用例改为可注入的网络端口或加显式启动握手），不在本检查点范围内。

### E2E-01-04 追加：CLI 滞留缺陷已修并转绿（2026-10-10）

**缺陷**（`tests/tui/integration/cli-exit-linger.test.ts` ②，此前以 `it.skip` 保留为待通过反例）：
provider + 权限询问路径下，CLI 打印结果后**不自然退出**（实测 >60s，只能外部 kill）。
本会话的多轮真实验收 harness 也反复受其拖累（进程不退出 ⇒ **拿不到干净退出码**，只能外部 kill）。

**修复位置与其原因**（文档已指明，我按此执行）：收敛放在 **CLI 引导层** `packages/tui/src/cli.tsx`
（`await program.parseAsync(...)` 之后）——**不能**放进 `executeRunCommand`：后者会被单测**在进程内**
直接调用，在其中 `process.exit()` 会杀死 vitest worker（历史实测连带 10 个既有用例失败，故曾被回退）。
实现：动作完成后等 stdout 排空再 `process.exit(process.exitCode ?? 0)`，并留一个
**不阻止事件循环的 1 秒兜底定时器**；常驻服务（`gui serve` / `mcp serve`）的动作 promise
在服务期间不会 resolve，故该段不可达、不会误杀。

**实测（真实退出码）**：

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `cli-exit-linger.test.ts`（② 已由 `it.skip` 改回 `it`） | **2/2 通过、exit 0**；② 由 ">60s 滞留失败" 变为 **36.177s 自然退出通过**；① 8.4s |
| 回归：`gui-command`、`runtime-selection-diagnostics-report`、`cli-commands`、`run-command-gaps`、`cli-sdk-parity`、`run-provider-entry`、`summary-cli`、`headless-cli` | **8 文件 / 50 用例全通过、exit 0**（含两个常驻服务测试 ⇒ 收敛未误杀服务） |

**踩到的坑（已避免误判）**：该用例 spawn 的是 **`dist/cli.js`**，而我只改了 `src`——首次复跑仍报 `linger`，
误以为修复无效；**重建 `dist` 后**才真实生效。教训：凡由构建产物驱动的测试/harness，
改完 `src` 必须 `npm run build` 再验。

## 2026-09-13 摘要与运行引导任务布置

本节保留 2026-09-13 布置历史；四组的原始 pending 表不是当前领取依据。SUM/GUIDE 已有后续实现证据，当前状态见顶部 2026-10-10 对账。

| 任务 | 状态 | 前驱 |
|---|---|---|
| SUM-01 动态摘要索引与展开 | **本地可证范围大幅推进（2026-10-10）**；**不判通过** | 三类来源适配器 + 公开发布入口 + **报告来源真实存档接线** + **旧清单迁移的只读判定与安全执行**（含崩溃恢复）；**仍未完成**：`conversation`/`deferred-file` 的真实数据源（宿主侧持久化决定待用户）、触发阈值测量、多设备重复测量 |
| SUM-02 跨模型预算与可靠性 | pending | SUM-01 |
| GUIDE-01 运行中引导 | pending | SUM-02、T07D-R2-02及T12A-R1相关路径 |
| EVENT-01 紧急仲裁与恢复 | pending（**2026-10-10 复核：全仓无 `EVENT-01` 独立卡文件，仅在 `SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md` 与 ADR-0038 中被定义**） | 本会话**未取得**任何完成证据；**不凭 GUIDE-01/SUM-01 的进展推断其完成**（卡内纪律）。若要推进，需先把它从"SESSSION 卡组第 4 组"落实为带检查点的可执行卡 |

> 更新规则见 `IMPLEMENTATION_PLAN.md` §8.4：开始任务标记 `in_progress`，全部验收通过才标记 `done`。
> 会话中断后从第一个 `in_progress` 或依赖已满足的 `pending` 任务恢复。

## 2026-09-10 产品接线增补任务（历史布置快照，非当前状态）

共同规则和独立任务卡链接见 [PRODUCT_INTEGRATION_ROLLOUT.md](docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md)。原卡done记录不代表新增接线验证已通过；INT-00核实原验收缺口后纠正相关旧状态，保留历史证据。

| 任务 | 状态 | 前驱/推荐顺序 |
|---|---|---|
| INT-00 产品路径审计 | pending | 首项：INT-00-01 |
| T07D-R1 应用服务与SDK接线 | pending | INT-00 |
| T07D-R2 首个Provider产品接线 | pending | T07D-R1 |
| T09A-R1 上下文运行接线 | pending | T07D-R1；入口联测需T07D-R2-02 |
| T12A-R1 恢复产品接线 | pending | T07D-R1；最终联测需T07D-R2-02、T09A-R1 |
| E2E-01 独立工作助手验收 | pending | 上述四张返修卡通过 |
| BRIDGE-01 外部接入MVP | **done（2026-10-10）**；**Linux 平台验证已补齐（2026-11-08，WSL2）**；仅缺 macOS 平台验证 | 脚本化 stdio 闭环 20/20 + **真实第三方客户端（opencode/pi）消费已完成**；**Linux 侧 2026-11-08 在 WSL2／Ubuntu 26.04／Node v22.22.1 复跑同一脚本：exit 0、`checkCount=20`、20/20、0 失败**；macOS 按用户指示先跳过保留待补。详见 `docs/reports/BRIDGE01_04_REAL_CLIENT_EVIDENCE_2026-10-10.md` 与 `docs/reports/BRIDGE01_LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md` |
| GUI-01-R GUI产品接线 | **本地可证 + 单平台（Windows）口径收口（2026-10-11）** | 01/02/03a/03b/04a/04b 全部交付；**人工体验第 2 轮已完成**（十项定论、6 个真实缺陷均已修）；§1-5 授权与「重启后列表为空」转出至 GUI-02 |
| GUI-02 授权呈现闭环与历史任务视图 | **in_progress（GUI-02-01：核心契约/请求实体/事件/裁决入口/安全预览/R1 返修 **＋ 片①②③ 已交付**）** | 检查点：01 公共授权契约与安全反例 / 02 GUI 授权闭环 / 03 历史列表 / 04 重启与包级验收。**GUI-02-01 片①②③ 已交付（2026-10-11，均有独立提交与门禁）**：① CLI 登记请求实体（身份通路 `a0c59b6`/`d6740fe`/`841e9f4`/`0e7bedd`，反例 `9d498e9`）；② 门面统一"登记+广播事件"、并修正片① 越层 import（`27ed9fa`）；③ CLI 裁决经同一服务 + **登记幂等** + **修掉"登记异步 vs 裁决同步"时序竞态**（`01d472e`）；片②③ 均复跑 **6 套授权回归 36/36** ⇒ 行为不变。**GUI-02-01 剩余**：片④ 基线两项（退出码代码级已定、TTY 逐字输出需真实 TTY ⇒ 未实测）。**GUI-02-02 本地可证部分已交付（2026-10-11，三片三次独立提交+门禁）**：① 核心能力（`7145ce3`：待授权列表**只读且解码身份**、裁决入口**只接受锚点与裁决**、权威事实**默认 fail-closed**；反例 8 条实现前全红并**捕获"身份不能往返"真实缺陷**）；② 传输层（`f6219bf`：`GET /permission-asks` + `POST /commands/permission-ask-decision`，CSRF 复用全局门禁，错误码 400/403/404/409，生产入口**预生成 CSRF 同时交给两边**避免静默失效）；③ 界面呈现（`a7cf9f6`：独立详情卡 + **批准本次/拒绝**，**不默认选中**、**无批量批准入口**、敏感路径提示不盲目批准、409 提示刷新后重新裁决）。**仍未完成**：~~**安装等专用流程的独立入口未实现**（仅钉住"无批量入口"这一必要条件）~~ → **已交付（2026-10-12，见下）**；**真实浏览器人工体验须由用户提供**。**GUI-02-02 安装专用流程已交付（2026-10-12，另 3 片 + 5 项修复，均有独立提交）**：① 待决安装询问注册表（`1e48ed1`，revision 校验／阶段匹配／超时或取消 ⇒ **fail-closed**）；② 界面侧安装通道 + 门面独立入口（`1c986f0`，`InstallationGateInterfacePort`）；③ 两条专用路由 + 生产接线 + 界面卡片 + **「不可被普通授权卡绕过」反例**（`e7afc49`／`3d3f6b4`）；另修 `ca6ee0b`（安装通道内部异常收敛为 **fail-closed**，不穿透工具执行路径）、`10cfa46`（`recover abandon` 误报 `abandoned: true`）、`5ebb73a`（CRLF 下静态 `source` 未省略）、`73e6244`（权限询问误导性告警）、`d332ded`（补交漏交的门面 async 修复，修 `origin/main` 的 typecheck 失败）。**审计结论（纠正最初假设）**：安装**不会**被普通授权卡绕过 —— `InstallationGateGuard` **自己**完成完整判定（询问已有资源 → 独立开关 → `askAllowOnce` → 授权 → **执行前复检**）；**真正的缺口是 GUI 侧 `installationUserPort` 曾为 `null` ⇒ 安装走不通**，本段为 GUI 补上这条独立通道。**本段其余未解决项**（如实）：`cancel()` 的 2 秒上限未修；全量 `test` 约 30% 概率间歇失败——详见 `docs/reports/SESSION_HANDOFF_2026-10-12.md` §0.4。**GUI-02-03 数据层与三条硬不变量已交付（2026-11-08，`4fc53d4`）；三视图 UI／项目字段／路由仍未做**及详情 / 04 重启与包级验收；**每轮一个检查点**。**提取边界已确认**：授权登记·状态迁移·裁决校验提取到**核心应用服务层**，CLI 仅留终端 I/O 适配，GUI 复用同一服务、不复制规则，**核心不得反向依赖 TUI**；"CLI 行为不变"= 公开可观察行为兼容。基线：`docs/reports/GUI02_01_EXISTING_PERMISSION_ASK_BEHAVIOR_BASELINE_2026-10-11.md`。卡：docs/tasks/GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD.md <br>**2026-11-08 续记（`ed4b5e6` + `743071e` + `35eb104` + `0a81e8c` + `96329ca`）：** GUI 授权闭环**已打通并经端到端自动验证**：`提交 → 授权请求出现 → 批准 → blocked→running→done → 产物真实落盘`。修掉两处「半成品」实现 —— ① `gui` 命令创建应用时**没传** `onPermissionAskWithIdentity` ⇒ 没人登记待决授权 ⇒ `/permission-asks` 恒空；② GUI 的批准只记录裁决、**没做** CLI 的三步（会话级授权 / 作用域一次性授权 / 下发 `unblock` 唤醒）。另修掉：恢复中心**分页 + 可恢复项优先**（用户实测 103 条里只有 1 条可恢复、找不到）、`aria-live` 误用（翻页念整批列表、淹没状态播报）。证据：`docs/reports/GUI_AUTHORIZATION_CLOSURE_END_TO_END_2026-11-08.md`、`docs/reports/GUI_MANUAL_EXPERIENCE_ROUND3_2026-11-08.md`。**仍未完成**：Linux/macOS 平台人工体验（Windows 浏览器连不进 WSL，实测过）⇒ 整卡不判通过。 |
| WB-00 细节微淘原型 | pending | GUI-01-R；未来探索 |

## Batch OBS/SMART/PROJECT（OBS-01、SMART-01、PROJECT-01 三卡）检查点记录

### 2026-10-02 — 12 个检查点历史交付记录（完成范围以顶部纠偏为准）

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
- **SMART-01-04 持续接收（模拟慢模型/长下级任务）**：**真实运行已通过（2026-10-10）** —— `node scripts/verify-u2-flash-continuous-reception.mjs`（云之声 u2-flash）**exit 0、判据 8/8**：派发 18ms、接收 13ms、派发≠完成、关闭回收、**凭据零写入**且运行前后 sha256 一致。报告 `docs/reports/SMART01_04_LIVE_U2_FLASH_EVIDENCE_2026-10-10.md`；可移植门禁 `tests/tui/integration/smart01-04-live-u2-flash-verdict.test.ts`。**仍未取得**：macOS 平台证据；另 `--probe-only` 在 Windows+Node24 退出路径有 libuv 断言（已登记未修）。
- **负载检查（明确延后）**：满载门禁中 `summary-cli`、`cli-commands`、`context-runtime-cache-events`、`application-sdk-task-events`、`provider-fake-server`、`provider-tool-loop`、`e2e01-vertical-rework` 等偶发超时失败，独立运行均通过。经用户决定，**负载/并发预算检查留到正式上线前进行**，本批不处理。
- **计划外未动项（2026-10-10 逐项复核后订正 —— 本节原列的两处 `it.skip` 已不成立）**：
  · ~~CLI 结果后进程滞留（`it.skip`）~~ ⇒ **已修**：
    `tests/tui/integration/cli-exit-linger.test.ts` ② 已是 **live `it`**（第 163 行），
    由「>60s 滞留失败」变为 **36.177s 自然退出通过**，2/2 exit 0；
  · ~~Anthropic 离线端到端用例（`it.skip`）~~ ⇒ **全仓 `it.skip` / `describe.skip` = 0**
    （仅余 5 处 `skipIf` 产物门禁，属仓内既有惯例，不构成未完成项）；
  · T07D-R2-04 正向闭环：已由 `verify:u2-flash-continuous-reception` 真实运行
    **exit 0、8/8** 覆盖（见 SMART-01-04 记录）；
  · `auth-scope-replay-rejected`：门禁层正确性由
    `tests/core/integration/scope-authorization-regrant.test.ts` 3/3 通过证明，
    剩余为 CLI 接线未修；
  · BRIDGE-01 / GUI-01-R / WB-00：见各自状态行（BRIDGE-01 脚本化闭环 20/20、
    GUI-01-R 本地子项全交付，两者仅缺人工/平台证据；WB-00 仍 pending）。

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

**E2E-01-04 分支覆盖率冲刺（2026-10-09，进行中）**

- 缺口起点：全局分支 **7848/9422 = 83.29%**，需补 **161 条**（阈值 85%）。
  L0（无位置信息）223 条**无法定向补测**；可定位池 1351 条，缺口只能从这池补。
- 工具与作战图：`scripts/report-uncovered-branches.mjs`（行级定位）、
  `docs/reports/E2E01_04_BRANCH_COVERAGE_GAP_PLAN_2026-10-09.md`。
  拿行级数据必须**复制 vitest 配置加 `json` reporter**（CLI `--coverage.reporter=json` 不生效）。
- **方法（已被三轮验证）**：先取未覆盖行号 → **查该行所属函数的调用点确认可达** → 写用例 →
  前后对照量化（同一测试集，只增测试文件）。已因此避免两类白工：registry 不走自有扫描器、
  C 系路径不走 `buildImportWithInlineCodeMatch`。
- 逐轮实测新增分支（**本文件口径累计 +135**）；**round 18 全量实测：7934/9422 = 84.21%、还需 75 条**；
  round 19/20/21 再 +3/+39/+16 → 全局约 **84.83%、还需约 19 条**（起点 83.29%/需 161 条）。
  **`commands.ts` 的 66 个导出命令现已全部被测试引用**（round 21 用脚本扫描确认零引用从 1 → 0）：
- **round 20 的最大启发（务必沿用）**：`commands.ts` 里有**多个命令函数从未被任何测试引用**
  （已确认 `executeDoctorErrorsCommand`、`executeCrossProjectListCommand` 零引用）。
  单测一个未覆盖命令即可拿到 **+39 条**——远高于在小文件里抠分支。
  **下一步应系统扫描 `commands.ts` 的 66 个导出命令，找出全部"零引用"命令并逐个补边界测试。**
  另注意测量陷阱：基线筛选若用 `*doctor*` 之类模糊匹配，会把我新写的测试文件也算进 baseline，
  导致前后对照恒为 +0（本轮已踩到并修正）。
- **round 16 的定位教训（第 5 次踩到，重要）**：`read-format-frontend-markup.ts` 的
  `countLines`/`identityLineMap` 只在 **L358/L376** 被调用，而那两处在 **`scanSectionedView`** 内——
  我按"文件内 helper 一定被同文件导出用到"的假设调 `scanMarkupView`，结果 6 个用例只 +1 条。
  **结论：同一文件内不同导出可能用不同 helper；写用例前要确认目标行所属的导出函数，并按该导出构造输入。**
  下一轮补该文件应直接调用 `scanSectionedView`。

| 轮 | 目标 | 新增 |
|---|---|---|
| 3 | `read-format-strategies.ts` C 系扩展名/无尾换行 | +11 |
| 4 | `read-format-other-languages.ts` Go 段（经 registry，**未打到**） | +4 |
| 5 | 同上改**直接调用**三个扫描器 | +6 |
| 6 | `read-format-strategies.ts` C#/Java 同行导入 | +6 |
| 7 | `diagnostic-event-store.ts` `aggregateDiagnosticEvents` | +6 |
| 8 | `perf-event-store.ts` `isPerfSampleEvent`/空样本 | +8 |
| 9 | （全量重测：83.79%、需 114 条；无新增用例） | — |
| 10 | `anthropic-messages-runtime.ts` 错误路径/选项透传 | +3 |
| 11 | `instruction-window-store.ts` 持久化容错/并发守卫 | +6 |
| 12 | `cross-project-authorization-store.ts` 决策矩阵（矩阵已被覆盖大半） | +1 |
| 13 | （判断 local-preservation 需伪造 6-8 种 git 调用、成本超预算，未动手） | — |
| 14 | `read-format-latex.ts` 直接调用扫描器（空源/无尾换行/命令尾文本/非连续省略行） | **+14** |
| 15 | `read-format-frontend-styles.ts` 直接调用扫描器（url 前导字符/转义/未闭合/无尾换行/行内代码） | +8 |
| 16 | `read-format-frontend-markup.ts` 调错导出（`scanMarkupView` 而非 `scanSectionedView`） | +1 |
| 17 | 同文件改调 **`scanSectionedView`**（无区段委托/无尾换行/子视图状态合并） | +3 |
| 18 | （全量复核：302 文件/2303 用例全通过；分支 84.21%、还需 75 条） | — |
| 19 | `read-format-frontend-script.ts` 单导出表驱动（注释/导入省略、同行代码保留、动态 import、JSX、畸形串） | +3 |
| 20 | **`commands.ts` 中此前零测试的 `executeDoctorErrorsCommand`**（参数校验/JSON-文本/过滤/诊断包预览，10 例） | **+39** |
| 21 | `commands.ts` 唯一剩余零引用命令 `executeCrossProjectListCommand`（三过滤器两侧分支 + 输出分支，7 例） | +16 |

- **补充教训（第 4 次踩到）**：仅仅"查调用点"还不够。round 10 按未覆盖行号外推分支归属，
  6 个用例只换来 +3 条——**未覆盖行号只能当候选定位，必须读该行代码确认分支归属**才能写有效用例。
  round 11 改为先逐行读实现再写用例，6 个用例即 +6 条。

- 已提交推送：`c6b4903`、`4644392`、`4c4bffb`、`bd962c4`、`dcffadd`（每轮单独提交）。
- **仍未动**：`smoke-install` 内部 `prepack → npm run check` 的负载型抖动（两次 exit 1，
  失败用例隔离复跑 5/5、3/3、6/6 全通过）。
- 下一批目标：`cross-project-authorization-store.ts`(23)、`instruction-window-store.ts`(15)、
  `read-format` 家族余项、`local-preservation-service.ts`(44)、`public-sdk.ts`(51)、`commands.ts`(320，最后)。


**S3 真实验收：①③④ 与 ② 均已取得真实 Provider 证据（2026-10-09）**

两份判定文件，均为 `isFakeProvider=false` / `isRealAcceptanceEvidence=true` / 干净工作区：

1. **①③④ + ⑩**：`.tmp/e2e01-03/2026-10-09T13-08-12.367Z/acceptance-verdict.json`
   （提交 `0b712b1`、`sourceStatus=''`、`failedCheckNames=[]`、9/9 判据、`humanEditDetected=true`）
   —— 这是**修正判定标注后重跑**的干净产物（上一次 `e70d950` 因残留重复键导致该字段错写 false）。
2. **②（崩溃+恢复）**：`.tmp/e2e01-03-interrupt/<最新>/boundary-interrupt-verdict.json`
   （提交 `0b712b1`、7/7 判据、`observedToolCallState=started`、强杀 4351ms）
   —— ⑯ 断言**恢复判定原文**：`resumed=false`、`executed=false`、
   `blockedDecisionItems=[{decision:"blocked-uncertain-side-effect",
   reason:"工具副作用未知，需用户裁决，禁止自动二次执行"}]`。

- **本阶段又修掉 2 处我方缺陷**（均已提交推送）：
  `d1aa8de` 边界中断场景支持真实 Provider（不需要人工编辑窗口，直连+轮询强杀）；
  `0b712b1` **真实模式下 ⑯ 原为空判据**（读的是未使用的假 Provider 计数器，恒为 0）→
  改为断言恢复判定原文；结论行改为按模式标注。
- **额度**：本轮真实调用 ①③④ 重跑 3 次 + ② 两次各约 2–3 次；**全程未打印/未落盘密钥**。


- **运行条件**：提交 `e70d950`、工作区**干净**（`sourceStatus: ''`）、tarball 隔离安装、
  真实端点 `https://api.stepfun.com/v1/chat/completions`、凭据引用 `prov-live-1`
  （密钥只经环境变量注入 CLI，**全程未打印、未落盘**）；**用户在"已读未写"窗口亲手编辑**。
- **全部 9 条判据通过**（`verdict: passed`、`failedCheckNames: []`）：
  ① 两步执行（请求数=3）；② 编辑落在读→写窗口（扣留 `12:29:36` → 编辑 `12:34:10`）；
  ③ **陈旧写入被拒**（`stale-human-change` 回填 Provider）；④ **人工字节逐字节保留**（`…\n修改`）；
  ⑤ Agent 内容未落盘；⑥ 未结案 `done`（`status=blocked`）；
  ⑦ 上下文预算实际执行（`effectiveBudgetTokens=4096`、`budgetPolicyRevision=1`）；
  ⑧ CLI 持久化视图与 SDK 一致（`cancelled / cancelled`）；
  ⑩ 工具边界写出恢复检查点（4 个，`replaceFileContent=result-unknown`、非幂等）。
- 原始证据在运行目录：`provider-requests.jsonl`、`upstream-responses.jsonl`（新增：上游原始响应
  与实际发起的工具名）、`cli-stdout/stderr.txt`、`cli-status-command.json`、`sdk-query-mission.json`、
  `acceptance-verdict.json`。代理日志逐次记录"发起工具=[...]、扣留=?"。
- **诚实标注的两点**：
  1. `acceptance-verdict.json` 里的 `isRealAcceptanceEvidence` 仍写着 `false`——
     根因是 verdict 对象**残留一行重复键**覆盖了条件判定（已在 `667ae1f` 修掉，离线复验仍为 `False`
     未误报）。**该文件中的判据、`isFakeProvider:false`、`humanEditDetected:true` 都是真实的**，
     只有这一个字段因代码缺陷而错。
  2. 该次 harness 进程因**子进程句柄未释放**而没退出（已知残留问题），
     因此**没有干净的进程退出码**；结论以判定文件与日志的结论行为准。
- **验收②的真实 Provider 覆盖度**：⑩（边界写检查点）已在真实运行中取证；
  但**崩溃+恢复**那一段（⑪–⑰：强杀、`requiresDecisionMissions`、`recover resume`
  返回 `resumed:false`/`blocked-uncertain-side-effect`、无新请求无文件变化）目前**仍是离线（假 Provider）证据**。
- **额度**：本轮真实调用共 3 次（读 + 被扣留的写入 + 被拒后的收尾）。


目标组合：`unisound / u2-flash / anthropic-messages`（凭据引用 `prov-unisound-1`）。
机制：本地**透传代理**（`scripts/lib/human-edit-window-proxy.mjs`）扣住含 `replaceFileContent`
的响应，直到检测到目标文件被人工编辑；窗口由本地控制，与模型手速无关。

| 尝试 | 现象 | 根因（我方） | 已修 |
|---|---|---|---|
| 1（10-08） | 窗口开启 600s，但 60s 后任务以 `Provider 请求失败或超时（60000ms）` 失败 | `--provider-request-timeout-seconds` 硬编码 60s **短于窗口** | 提交 `2a37bf3`：真实模式 = 窗口 + 180s |
| 1（同日） | 判据①③ 报 `请求数=0` | 判据读的是**假 Provider** 的请求日志（真实模式下恒为空），未取代理采集 | 同上：真实模式并入代理的请求体与计数 |
| 2（10-09） | 窗口正常开启（900s），CLI **exit 124**、`Provider 请求数=2`、②③④⑩ 失败 | **harness 自身看门狗硬编码 300s** 且 **CLI `--timeout-seconds` 硬编码 240s**，双双短于窗口 | 提交 `e4fd079`：看门狗 = 窗口 + 300s；CLI 超时 = 窗口 + 180s |

- **额度如实登记**：两次尝试共约 **4 次真实请求**（每次 = 一次 `readFile` + 一次被扣留的写入请求），
  **尚未产出验收①的真实证据**。两次都不是 Provider 或用户的问题，是 harness 参数错。
- **非显然点（下次可直接给足余量）**：代理是在**上游已返回之后**才扣留响应，
  因此窗口开多久都不会导致 Provider 侧超时；瓶颈只在本侧三个超时参数。
- **下一步（待用户确认在场）**：用户回"我在"后启动，窗口设 **30 分钟**；
  窗口一开立即把目标文件路径贴给用户。预计消耗约 3–5 次真实调用。
- 修复已推送（`e4fd079`），**离线路径复验通过**（9/9 判据，exit 0），未影响既有离线证据。

**S2d：真正驱动恢复路径（验收②闭环）**
- 扩展 `scripts/verify-e2e01-03-boundary-interrupt.mjs`：崩溃后**在假 Provider 仍监听的前提下**
  运行安装包 CLI 的 `recover resume <mission> [--execute] --json`。
  （Provider 必须保持监听——否则"没有重放"可能只是"Provider 不在、重放必然失败"的假象。）
- **真实退出码 0，7/7 判据**（新增 ⑯⑰）：
  ⑯ 恢复尝试**未产生新的 Provider 请求**（1 → 1）；⑰ 目标文件**未被改变**（无重复副作用）。
- **产品面判定原文（可复核）**：
  `{"resumed":false,"executed":false,"requiresUserDecision":true,
    "blockedDecisionItems":[{"item":"tc-interrupt-1","decision":"blocked-uncertain-side-effect",
      "reason":"工具副作用未知，需用户裁决，禁止自动二次执行"}]}`
  即该 mission 的非幂等边界调用被判为**禁止自动二次执行**，恢复未执行任何节点。
- 另观察到**第二道独立防线**：`recover resume --execute` 返回
  `mission-locked: mission 正在其他进程运行（属主 …），拒绝续接以避免双跑`——
  被强杀的进程仍持有 mission 租约，未过期前拒绝接管。**如实区分**：这次 `--execute` 的拒绝
  来自**租约门禁**，而"禁止自动重放"的判定依据在 `resume`（只读）输出的 `blockedDecisionItems`。
- 结论：验收②在**产品路径**上已闭环（边界落检查点 → 崩溃后仍可信 → 标为需要裁决 →
  恢复 `resumed:false` 且无新请求/无文件变化）。仍未做的是**真实 Provider**版本（S3）。

- 新增 `scripts/verify-e2e01-03-boundary-interrupt.mjs`：假 Provider 回放一次写类工具调用后
  **不再响应**，harness 轮询检查点目录，一旦看到该工具调用的记录就**立即强杀 CLI**，
  再用**安装包自己的公开 SDK** `queryRecoveryOverview()` 查恢复视图。断言不依赖竞态：
  无论杀掉时状态是 `started` 还是 `confirmed-success`，都要求"不得重复副作用"。
- **真实退出码 0，5/5 判据**（两次运行）：
  ⑪ 边界确实落下检查点（观察状态 `started`，强杀时机 371/379 ms）；
  ⑫ 状态语义正确；**⑬ 崩溃后产品仍能看到 `hasTrustedCheckpoint=true`**
  （本会话之前产品路径从不写检查点，这一步根本不可能）；
  ⑭ 目标文件无重复副作用；**⑮ 产品把该 mission 列入 `requiresDecisionMissions`**
  （即"非幂等、结果未知 → 禁止自动二次执行"的**产品面**表达，而不是只靠单测）。
- 定位说明：这是 `isFakeProvider: true` / `isRealAcceptanceEvidence: false` 的离线证据。
  验收②目前已有三层证据：① 记录器+分类服务联测（`result-unknown`/`started` 非幂等 →
  `blocked-uncertain-side-effect`、`confirmed-success` → `reuse-confirmed-result`）；
  ② 产品接线（harness 判据⑩：真实运行写出检查点）；③ 崩溃边界（本脚本 ⑪–⑮）。

- **根因确认**：`RecoveryCheckpointRecorder` 的链状态是**每实例私有**（缓存 `lastCheckpointHash` +
  标识自增序号各自从 `0001` 起），而**同一 store 被多个记录器共用**（键 `missionId::agentInstanceId`）。
  第二个记录器于是复用相同 `checkpointIdentifier`（互相覆盖）并/或提出与
  `selectLatestTrustedCheckpoint()` 不符的 `previousCheckpointHash`
  → `writeCheckpoint` 抛**"检查点哈希链断裂"** → 装饰器在 `started` 阶段 **fail-closed**
  → 工具不执行、任务重试到 `blocked`。这与该用例"最终文件存在但 `status=blocked`、耗时 30.7 s"完全吻合。
- **修复**：① 链状态**不缓存**，每次写入以 store 的最新可信检查点为唯一依据（无状态链）；
  ② `checkpointIdentifier` 改为**全局唯一且按时间单调**（13 位毫秒 + 进程 + 任务链 + 序号）；
  ③ 新增可选 `RecoveryCheckpointWriteQueue` **跨记录器共享写队列**。
- **验证（真实退出码）**：`authorization-retry-closure` 由 **30.7 s 失败 → 713 ms 通过**；
  记录器用例 **10/10**（新增反例④：两个记录器共用同一 store、交错+并发写入，
  断言各自状态互不覆盖、链仍可信、检查点文件数=3）；
  harness 判据⑩ **通过**（检查点数=4，`readFile=confirmed-success`、
  `replaceFileContent=result-unknown`，`isIdempotent=false`）；
  `npm run check` **exit 0**（290 文件 / 2186 用例通过、2 skipped）。
- **如实说明（不夸大）**：把共享写队列**停用**后反例④**仍然通过**——即本次真正修掉回归的是
  "无状态链 + 唯一时间单调标识"，**共享写队列只是纵深防御**，本用例未能证明其必要性；
  不要宣称"队列修好了回归"。

- **度量排除"写盘延迟"假设**：真实 `RecoveryCheckpointStore.writeCheckpoint` 实测
  **3–9 ms**（连续 5 次共 24 ms），`selectLatestTrustedCheckpoint` **1 ms**。
  即使 50 次写入也只有约 0.25 秒，**不可能**把 0.689 秒的用例拖成 30.7 秒 ⇒ 假设 (a) 排除。
- **二分实验定位到"写入"而非"包装"**：把 S2b 接线恢复，但把
  `RecoveryCheckpointingToolPort.execute` 改成**纯透传（不写任何检查点）** →
  `authorization-retry-closure` **通过（830 ms，exit 0）**；带真实写入 → 失败（30.7 s，`status=blocked`）。
  ⇒ **装饰器的包装位置无辜**，问题出在**检查点写入本身**（逻辑性，不是性能）。
- **最强候选根因（待下轮取直接证据确认，不得凭猜修改）**：
  `RecoveryCheckpointRecorder` 的**链状态是每实例私有**（`lastCheckpointHash` + 自增
  `checkpointSequence`），而**同一个 store 会被多个记录器共用**（键为 `missionId::agentInstanceId`）。
  第二个记录器可能：① 复用相同 `checkpointIdentifier`（各自都从 0001 起）；
  ② 提出与 `selectLatestTrustedCheckpoint()` 不符的 `previousCheckpointHash`
  → `writeCheckpoint` 抛"检查点哈希链断裂" → 装饰器在 `started` 阶段 **fail-closed**
  → 工具不执行、任务重试直到 `blocked`（与该用例"文件最终存在但 status=blocked、耗时 30.7 s"吻合）。
  旁证：我的 harness 只涉及**单个** agent（单记录器），链始终正常（4 个检查点、判据⑩ 通过）——
  正好解释"harness 过、该用例挂"的分裂。
- **下轮修法（顺序不可颠倒）**：先给 `application-runtime` 传 `onCheckpointWriteError` 把写失败落到文件
  （该用例会丢弃 stderr），复现一次拿到"哈希链断裂"原文作为直接证据；再改为**无状态链**
  （每次写入以 store 的最新可信检查点为唯一依据）+ **全局唯一且按时间单调的 `checkpointIdentifier`**
  + **同进程跨记录器共享写队列**（串行化）。
- 回滚状态：S2b 代码仍在 `.tmp/session-r2-04/s2b-reverted/`；工作区干净，`dist` 已重建为已提交状态。

**S2b 尝试与回退（上一轮，未提交，代码已备份）**：
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
| T06E | Assist 安装前置询问、独立开关与逐次授权 | **done（单平台口径）** | 6A | B6R-01/02 已返修完成
| T06F | 可配置权限组与无限命名自定义模式 | **done（单平台口径）** | 6B | B6R-03/04 已返修完成
| T06G | 主 Agent 永久只读、次级权限上限与会话临时提升 | **done（单平台口径）** | 6C | B6R-05/06 已返修完成
| T07 | Agent Runtime | re-verifying | 4 | AR-00 重新验收中 |
| T07A | 明确完成协议与早停恢复 | re-verifying | 4J | 2026-08-13 完成；Batch 4J 检查点（583 测试全绿）；待 AR 复验 |
| T07B | 反自指读取与通用活锁守卫 | re-verifying | 4H | 2026-08-13 完成；Batch 4H 检查点（539 测试全绿）；待 AR 复验 |
| T07C | Agent 独立模型/Provider 策略与任务类型预设 | re-verifying | 6H | T07C-01~06 全部完成（957 测试全绿；dist 可达 + smoke-install 通过）；T07D 可开始 |
| T07D | 多 Provider 生产运行时与独立 Agent 工作助手 | re-verifying（INT-00 纠偏：SDK 仅“可导入”、Provider 仍 mock-only，产品接线缺口移交 `T07D-R1`/`T07D-R2`/`E2E-01`） | 6I | T07D-00~08 全部完成（1117 测试全绿；SDK exports 隔离导入验证 + smoke-install 通过） |
| T07E | Agent 工作集与默认10文件读取预算 | re-verifying | pre-T07D | T07E-01~06 全部完成（1106 测试全绿；dist 可达 + smoke-install 通过） |
| T08 | 三级 Agent 编排 | re-verifying | 5 | AR-04 复验：T05B→T08 Git 编排接入完成（Batch 5 增补检查点），待 AR-04 全项复验 |
| T08A | 默认控制流、个体记忆隔离与三级 Agent 生命周期 | **done（单平台口径）** | 6D | B6R-07/08/09 已返修完成
| T08B | 工具说明回访、无产品数量配额与受权通信转交 | re-verifying | 6E | 2026-08-13 完成；Batch 6E 检查点（665 测试全绿）；待 AR 复验 <br>**⚠️ 2026-11-08（第 129 轮）G4 状态纠偏**：本行对应的「工具说明首次下发／同 revision 后续只给固定提醒」**仍是未接线缺口**（`ToolDocumentationRecallController` / `ToolDocumentationRecallInjector` 在生产里零使用，见总表 G4）。用户已明确：**G4 保留在返修清单，不因阶段决策表未列出而视为完成**。**当前状态仍未完成**（本行既有的 `re-verifying` 口径不变）。 |
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
