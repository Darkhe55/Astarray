#!/usr/bin/env node
/**
 * 变异验证（mutation verification）：确认**关键安全断言真的在拦事**（2026-10-13）。
 *
 * 由来（真实教训）：本轮为跨项目授权补了 3 条"受保护存储不得访问"的反例，
 * 其中一条（删除审计文件）在**临时禁用产品判定器**后**仍然通过** ——
 * 因为它先命中了 `resource-not-found`，**根本没走到受保护存储判定**。
 * ⇒ "测试通过"不等于"测试有效"；空洞反例会让防线看起来存在而实际不存在。
 *
 * 本脚本把那次手工实验固化为**可复用检查**：对每条关键安全断言，
 * 用精确字符串替换在产品代码里**注入一处反事实**，跑指定用例，
 * 要求**点名的那几条用例必须变红**；最后**必定还原**（sha256 校验）。
 *
 * 判定：任一变异"存活"（期望红却没红）⇒ 该变异**没被测住** ⇒ 退出码 1。
 *
 * **2026-11-08（第 92 轮）扩容：28 → 30 个变异体**（全量复跑 **30/30 被拦下**）。新增两个：
 *  - `guide01-watchdog-resumes-superseded-instruction`：把「被新指导取代的旧指令不得续跑」改成照样续跑
 *    （第 91 轮发现该分支**全仓零覆盖**，当时只靠一次性探针发现 ⇒ 固化防回归）；
 *  - `diag01-execution-refusal-recorded-as-failure`：去掉「执行前拒绝」过滤
 *    （拒绝/取消不得记成故障，卡内 DIAG-01 硬约束）。
 *
 * 扩张原则：**只固化"已经有真实反例、且反例真能变红"的守卫** ——
 * 不为了凑数加会产生误报的变异体（与仓库"不为凑数加守卫"同一纪律）。
 * **2026-11-08（第 94 轮）再扩容：31 → 33**（全量复跑 **33/33 被拦下**）。新增两个：
 *  - `ponder01-write-tool-added-to-readonly-allowlist`：把**写类工具**塞进思索模式只读白名单
 *    （思索模式必须由本地 harness **直接禁用**写入，不能仅靠提示词约束）；
 *  - `ar07-destructive-tool-without-auto-backup-accepted`：放宽 schema，使破坏性工具
 *    **不声明**工具内自动备份也能注册（违反"变更前必须自动备份"）。
 *
 * **⚠️ 本轮一条方法学教训（我自己的失误）**：验证 `ar07-destructive-tool-without-auto-backup-accepted` 时，
 * 我按"文件内容含 `mutationKind|backupPolicy`"筛出 17 个文件，却**只把其中 10 个敲进命令行**，
 * 恰好漏掉了真正守着这条规则的 `tests/core/unit/schemas.test.ts` ⇒ 得到**假结论"变异存活"**。
 * 跑全 17 个后立刻被拦下。**教训：变异探针的文件集必须由检索结果直接喂给命令，不能手敲。**
 *
 * **2026-11-08（第 96 轮）再扩容：33 → 34**（全量复跑 **34/34 被拦下**）。新增
 * `project01-narrowed-derivation-widening-accepted`（整段 `isNarrower` 恒真 ⇒ 派生可扩大范围）。
 *
 * **⚠️ 第 96 轮的第二条方法学教训 —— 变异必须够"强"**：验证这条时，我第一次只改
 * `isNarrower` 表达式里的**一项**条件（去掉 `pathPrefixes.length > 0`），其余条件仍在
 * ⇒ **变异太弱、根本没改变被测行为** ⇒ 又得到一次**假结论"存活"**（这次连全量套件都跑过、照样全绿）。
 * 换成**整段表达式恒真**后，用例立刻变红。
 * ⇒ **纪律：注入后必须先自问"这真的改变了被测行为吗？"** ——
 * 弱变异会把"守卫有效"**误报成**"守卫缺口"，而假缺口比漏检更浪费（会让人去补一个本来就有守卫的地方）。
 *
 * **2026-11-08（第 98 轮）再扩容：34 → 36**（全量复跑 **36/36 被拦下**）。新增两个，**都刻意用"整段条件"的强变异**（吸取第 96 轮"弱变异造成假缺口"的教训）：
 *  - `ar07-repeat-read-suppression-removed`：把"资源确实变了"判定改成恒真
 *    ⇒ **反自指/活锁保护**失效（同一来源可反复读未变化的资源）；
 *  - `ar07-recovery-checkpoint-chain-break-accepted`：跳过检查点哈希链校验
 *    ⇒ 被篡改/错序的检查点会被当成可信状态接受（**审计完整性**失守）。
 *
 * 两者本轮实测**均被拦下**（本就承重）：前者 4 个文件共 6 条用例变红，后者 1 条变红。
 * **2026-11-08（第 101 轮）扩容：36 → 37**（全量复跑 **37/37 被拦下**）。新增
 * `workspace-boundary-escape-accepted`（`isPathWithin` 恒真 ⇒ 包含性判定与**符号链接逃逸**判定同时失效）。
 * **本条是"验证型"结果**：实测该守卫覆盖**非常充分** —— 一次变异使多个文件大量用例变红
 * （`..` 逃逸、符号链接逃逸、工作区外绝对路径、TOCTOU 换链拦截…）⇒ **未发现缺口**，固化以防回归。
 * **2026-11-08（第 101 轮）两条新增：37 → 39**（全量复跑 **39/39 被拦下**）。标的：
 * `quaternary-permission-intersection-bypassed` 与 `quaternary-permission-excess-delegation-accepted`
 * —— **四级委派权限不得宽于三级**（AGENTS.md／ADR-0025 §5）。
 * 「**求交**（四级决定 = 三级 ⊓ 请求）」与「**超出即拒绝分发**」是**两种不同行为**，故各锁一条。
 * 本轮实测两条**均被拦下**（`quaternary-lifecycle.test.ts` 对应用例变红）⇒ **无缺口**。
 * **2026-11-08（第 102 轮）扩容：39 → 40**（全量复跑 **40/40 被拦下**）。
 * **本轮探针先"存活"、补完反例后才被拦下** —— 这是本文件的价值所在：
 * 把 `parameter-authorization.ts` 的 `doesRuleMatch` 里「无 `match` 一律匹配」与
 * 「参数不可解析返回 false」**两块顺序对调**后，**12 个相关文件 / 102 条用例全部照旧通过**
 * ⇒ 「**仅按 action 的规则 + 参数不可解析**」此前**没有任何断言**（且文件里两处表述互相矛盾）。
 * 已补反例 ⑨（钉住"仅按 action 的规则**不依赖参数文本**" + 依赖参数的规则**不可解析即回退基线**），
 * 并把该变异固化 ⇒ 现在 40/40 全被拦下。
 * **2026-11-08（第 103 轮）扩容：40 → 41**（全量复跑 **41/41 被拦下**）。新增
 * `permission-ask-expired-approval-reused`：跳过「批准已过期」判定 ⇒ 失效批准被无限期复用。
 * 实测在 **47 个相关文件 / 427 条用例**中，仅点名那条（`gui02-01-r1-approval-fingerprint-reuse`
 * 「⑧ **超出有效期**的批准不得复用」）变红 ⇒ **无缺口**，固化防回归。
 *
 * **本轮另记一条"不做的结论"**：备份库审计链（`backup-vault.ts` 的 `recordHash`／`previousRecordHash`）
 * 只有**写入方**、**全仓没有链校验方** —— 但仓库规则只要求「写高查阅优先级审计日志」，
 * **不要求产品内校验**（链是给外部审计的）⇒ 这是**设计取舍、不是缺口**，故**不为它加守卫**
 * （与"不为凑数加会产生误报的守卫"同一纪律）。
 * **2026-11-08（第 104 轮）扩容：41 → 42**（全量复跑 **42/42 被拦下**）。新增
 * `permission-ask-succeeded-target-replay-allowed`：让「已成功写入过同一目标 ⇒ 一律不得复用」整条失效
 * ⇒ 同一次批准被反复套用、**同一个写操作被再次执行**（重放）。
 * 实测被 **3 个独立文件**同时拦下（`gui02-01-r1-approval-fingerprint-reuse` ⑤、
 * `permission-ask-reuse` ⑤、`gui02-01-permission-ask-fingerprint-gap` ④）⇒ **覆盖扎实**，固化防回归。
 * **2026-11-08（第 116 轮）扩容：42 → 44**（全量复跑 **44/44 被拦下**）。新增两条**提权方向**的变异：
 * `permission-profile-assist-default-allowed`（协同模式默认矩阵绕过 `assistDefault` 一律 `allow`）与
 * `permission-profile-fallback-allow`（兜底判定 `deny` → `allow`，fail-open）。两条均被拦下。
 *
 * **⚠️ 同轮修正本脚本一处「假保证」**：原判据 `missingExpectations.length === 0` 在
 * `expectedFailingTestNames` 为**空数组**时**必然成立** ⇒ 会把"根本没让任何用例变红"的变异
 * **误判为「被拦下」**（本轮我自己写出过两条空列表，差点当证据用）。现**禁止空期望列表**：
 * 空列表一律记为脚本错误，要求写明被测用例名。
 *
 * **⚠️ 并记一次「假存活」教训**：该轮第一次探测协同默认矩阵时，我**手敲了 5 个测试文件**，
 * 结果变异"存活"；改用**由检索结果直接喂入的 13 个文件**后 ⇒ **17 条用例变红**（其实覆盖充分）。
 * 这正是本文件开头第 (a) 条纪律（文件集必须来自检索，不得手敲）的现实案例。
 * **2026-11-08（第 117 轮）扩容：44 → 46**（全量复跑 **46/46 被拦下**）。新增：
 * `backup-audit-review-priority-downgraded`（删除备份审计的**高查阅优先级**被降为 normal ——
 * 实测被 **3 条用例**拦下，含「删除备份审计记录使用高查阅优先级」「放权模式…写 HIGH 审计记录」；
 * **该探针另有诊断价值**：若测试只是拿常量自比，改常量就抓不到 ⇒ 说明那些断言**不是同义反复**）；
 * `cross-project-deny-precedence-bypassed`（跨项目裁决的「**显式拒绝优先**」永不触发 ——
 * 实测被「① 显式拒绝优先：即使其它侧允许也不放行」「② deny 优先：任一侧显式拒绝即整体拒绝」拦下）。
 *
 * **⚠️ 第 117 轮又踩一次文件集坑（本会话第 4 次）**：我给第二条变异**手敲**了 9 个文件名，
 * 里面凭印象写了两个不相关的文件、却**漏掉了真正守住该行为的**
 * `tests/core/unit/cross-project-permission-matrix.test.ts` ⇒ 该变异被误判为**「存活」**。
 * 现该条目的 `testFiles` 已改为**由检索结果直接写入**（并在条目注释里写明这次错误）。
 * ⇒ **纪律再强调：`testFiles` 只能来自检索输出，不得凭印象书写。**
 * **2026-11-08（第 118 轮）扩容：46 → 47，并且这是本窗口第 1 个"探针存活 ⇒ 补守卫"的真缺口**。
 * 新增 `feedback-agent-source-identity-emptied`：把反馈消息 agent 来源的 `agentInstanceId`
 * 由 `z.string().min(1)` 放宽为 `z.string()`（**允许空串**）。
 *
 * **原状：无人守** —— 该变异在**由检索直接喂入的 12 个文件 / 150 条用例**里**全部通过**，
 * 而 `AGENTS.md` 明写「Agent 来源必须**具体到不可复用的 `agentInstanceId`**，转发时保留原始来源」
 * ⇒ 该要求此前**没有任何断言**。
 *
 * **处置**：补反例（`tests/core/unit/schemas.test.ts`
 * 「Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝」，**并含一条合法消息必须被接受**，
 * 以免用例变成恒假）⇒ 该变异**当场被拦下**，随即固化为永久变异体。
 * **2026-11-08（第 119 轮）扩容：47 → 48**（全量复跑 **48/48 被拦下**）。新增
 * `relay-records-relayer-as-original-source`：把转达请求里的 `originalSourceAgentInstanceId`
 * 记成**转达者（直属上级）** ⇒ 原始来源被顶替、转达**冒充原创**
 * （`core/types.ts` 明写「转发消息必须保留原始来源，**不能把路由或转发 Agent 记录为原始来源**」）。
 * 实测被 `tests/core/unit/comm01-collaboration-relay.test.ts` 的
 * 「② 转达**保留原始来源、转达者与任务关联**，且**显式标注为转达**（不冒充原创）」拦下 ⇒ 覆盖确证。
 * 该条目只有 **1 个**测试文件 —— 已另行核实**不是漏覆盖**：该模块的导出函数
 * `routeCollaborationViaUniqueParent` 恰好只被这 **1 个**测试文件引用（其余两个导出是类型）。
 * **2026-11-08（第 120 轮）扩容：48 → 49**（全量复跑 **49/49 被拦下**）。新增
 * `memory-observation-source-replaced-by-owner`：把个体记忆观察的 `sourceAgentInstanceId`
 * 记成**接收方自己** ⇒ 等于「**去除来源、冒充自身记忆**」（该文件注释明令禁止）。
 * 实测被 `tests/core/unit/agent-lifecycle-and-memory.test.ts` 的
 * 「两个同级 Agent 相同任务文本下记忆完全隔离」拦下，且该用例是**直接断言**：
 * `expect(memoryB?.observations[0]?.sourceAgentInstanceId).toBe("tertiary-a")`
 * （注释原文「B 的观察保留原始来源与附件哈希」）⇒ 覆盖**直接且正确**。
 * 另注：该条目的 `testFiles` **由检索结果直接写入**（不手敲）。
 * **2026-11-08（第 121 轮）扩容：49 → 51**（全量复跑 **51/51 被拦下**）。新增两条都在
 * `scope-resolution.ts`（范围解析）：
 *  - `scope-dedicated-flow-relaxed`：专用流程（远端发布／备份删除）由 `ask-user` 放宽为 `allow`
 *    ⇒ 本模块替专用授权门放行（文件头明写「专用流程**不被本模块放宽**」）。
 *    实测被 `auth-scope-resolution.test.ts` 拦下 —— 该文件里是**直接断言**
 *    （放权 + 配置 allow 下 `S7-special-flow` 必须得到 `{ask-user, dedicated-flow}`）。
 *  - `scope-installation-switch-bypassed`：S5 安装类的「开关关闭 ⇒ 拒绝」永不触发。
 *    实测被 3 条用例拦下，含**直接点名**的「安装类：开关关闭一律拒绝（协同/放权相同）」。
 *
 * **⚠️ 本轮又被本脚本自己拦下一次（这次是"设计生效"）**：第二条的锚点
 * `if (!input.isInstallationEnabled) {` 在文件里**命中 2 次**（S5 与 S1+安装两条分支同形），
 * 脚本按"**恰好 1 次**"的规则**拒绝执行并报脚本错误**，而不是静默跳过 ⇒ 我随后把锚点
 * 扩成带 S5 分支头的**唯一片段**。**教训：锚点必须唯一，且脚本必须对重复命中报错。**
 * **2026-11-08（第 122 轮）扩容：51 → 52**（全量复跑 **52/52 被拦下**）。新增
 * `tertiary-delegated-expiry-never-narrowed`：把三级期限求交的三元真分支改成**请求值**
 * ⇒ 求交永不收紧，三级可拿到比次级**更长的有效期**（AGENTS.md：次级分发给三级的权限
 * 必须是其**当前有效权限的等于或更窄子集**）。实测被 **3 条用例**拦下，含
 * 「期限求交结果不晚于任一输入且取自输入之一」「三级权限逐项求交：三态/资源范围/期限均不得宽于次级」
 * ⇒ 覆盖直接，固化防回归。
 *
 * **⚠️ 同轮补强了我的探针工具（一次性工具，不入库）**：本轮我先写出过一次**仅空白差异**的替换
 *（原行与新行打印出来一模一样），语义上是**空操作**，却被当成"存活"（**假结果**）。
 * 已加守卫：**trim 后相同 ⇒ 拒绝运行**。
 * ⇒ **纪律再补一条：变异必须"真的改变语义"，只差空白不算变异。**
 * **2026-11-08（第 123 轮）扩容：52 → 53**（全量复跑 **53/53 被拦下**）。新增
 * `elevation-expiry-invalidation-disabled`：把会话提升的到期判定改成 `false &&`
 * ⇒ **到期永不生效**，已过期的提升继续放权（`AGENTS.md`：提升绑定**有效期**、可随时撤销）。
 * 实测被 `tests/core/unit/session-permission-elevation.test.ts` 的
 * 「到期/profile revision/目录版本变化/Agent 回收使覆盖失效」拦下 ⇒ 覆盖直接。
 *
 * **⚠️ 本轮探针工具又拦住我一次**：我先传错了行号（传的是原行本身）⇒ 新加的
 * 「**trim 后相同即拒绝运行**」守卫**当场拒绝**，我改对行号后才拿到真结论。
 * （也就是说：第 122 轮补的那条守卫，本轮立刻派上用场。）
 * **2026-11-08（第 124 轮）扩容：53 → 54**（全量复跑 **54/54 被拦下**）。新增
 * `elevation-individual-scope-always-applies`：把限定到**具体个体**的提升范围判定改成 `return true;`
 * ⇒ 该提升**泄漏到同级所有次级 Agent**（`AGENTS.md`：临时提升"默认作用于会话全部次级，
 * **也可显式限定具体次级**" ⇒ 个体覆盖不得外溢）。
 * 实测被 2 条**直接点名**的用例拦下：「个体提升不传播到其他次级 Agent（隔离）」、
 * 「会话级覆盖应用于全部现有及后续次级 Agent；个体覆盖隔离」⇒ 覆盖直接，固化防回归。
 * **2026-11-08（第 126 轮）扩容：54 → 55**（全量复跑 **55/55 被拦下**）。新增
 * `argument-fingerprint-ignores-values`：让参数规范化**只保留键名、丢掉值**
 * ⇒ 「同一路径、**内容不同**」也复用批准 —— **这正是 R1 修掉的历史缺陷本身**。
 * 实测被 **7 条用例**拦下，**两个方向都有直接断言**（内容变化 ⇒ 指纹不同；**键序变化 ⇒ 指纹相同**）。
 *
 * **⚠️ 本轮踩到一个新坑（写进纪律）**：该变异代码里含 `${…}`，我生成条目时用了**模板字符串**
 * ⇒ `${JSON.stringify(key)}` 在**加载时被当插值求值**（`key` 未定义）⇒ harness **崩溃**、`--only` 输出为空。
 * **改用单引号字符串**（不插值）后正常。
 * ⇒ **纪律：变异条目里若含 `${…}`，`find`/`replace` 必须用非插值写法（单引号串）。**
 * **2026-11-08（第 127 轮）扩容：55 → 56**（全量复跑 **56/56 被拦下**）。新增
 * `feedback-delivery-dedup-disabled`：去掉 `feedback-process/transport.ts` 里
 * 「该 `idempotencyKey` 已投递过 ⇒ 只回 ack、不再触发 handler」的判定
 * ⇒ 重复投递会**重复触发处理**（重复副作用）。
 * 实测被 `tests/core/unit/feedback-client.test.ts` 的
 * 「同 idempotencyKey 重复投递只调用 handler 一次并自动 ack」**直接点名**拦下。
 * 该条目 `testFiles` 用**较宽检索**（FeedbackClient 家族 + idempotencyKey，共 33 个文件），仍来自检索输出。
 * **2026-11-08（第 128 轮）扩容：56 → 57**（全量复跑 **57/57 被拦下**）。新增
 * `instruction-idempotency-conflict-overwrites`：去掉 `instruction-window-store.ts` 里
 * 「同键异参（同 `idempotencyKey`、内容哈希不同）→ **拒绝**、不覆盖」的判定
 * ⇒ 同键异参被当作新指令接纳，**既有用户指导可能被静默覆盖**。
 * 实测被 `tests/core/integration/instruction-window-persistence-branches.test.ts` 的
 * 「② 同键异参：必须拒绝，不得覆盖既有指令」**直接点名**拦下。
 *
 * **⚠️ 本轮改了一个"证据实践"顺序，并验证有效**：此前连续 3 轮出现
 * 「**紧接全量变异之后的那次门禁**失败」（安静机器复跑必过）。本轮改为
 * **先跑门禁、再跑全量变异** ⇒ 门禁 **exit 0（443 文件 / 3303 用例）**、变异 **57/57**。
 * ⇒ **建议固定顺序：先 `npm run check`，再 `npm run verify:mutation-kills`。**
 * **2026-11-08（第 133 轮）修复一条**永不匹配**的 find，并记下 Windows 教训**。
 * `comm01-orchestrator-skips-publisher-stamp` 原来是**跨文件多行** find；
 * 而 `mission-orchestrator.ts`（源）与 harness 的**行尾不同**（源 CRLF、harness LF）
 * ⇒ 多行 find **永不匹配**（全量跑报「锚点命中 0 次」，被 59/59 → 58/59 抓到）。
 * 我一度误判为"转义反引号写坏"，改成双引号 `\n` 拼接 —— **同样因行尾不匹配失败**。
 * ⇒ **纪律：跨文件多行锚点在 Windows 上必须避开（行尾不可控）；优先用唯一单行做 find/replace。**
 * 用法：
 *   node scripts/verify-mutation-kills.mjs            # 全部变异
 *   node scripts/verify-mutation-kills.mjs --json     # 机器可读
 *   node scripts/verify-mutation-kills.mjs --only <mutationIdentifier>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * 每个变异：
 *  - targetFile：被注入反事实的产品源文件（仓库相对路径）
 *  - find / replace：**精确**字符串替换（必须唯一命中，否则脚本报错而不是猜）
 *  - testFiles：要跑的用例文件
 *  - expectedFailingTestNames：**必须**出现在失败列表里的用例名片段
 *  - rationale：这条断言在拦什么（失败信息里会打印，便于人读懂）
 */
export const MUTATIONS = [
  {
    mutationIdentifier: "cross-project-forbidden-access-target-disabled",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (
      isForbiddenAccessTarget !== undefined &&
      (await isForbiddenAccessTarget(binding.resolvedAbsolutePath))
    ) {`,
    replace: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (false && isForbiddenAccessTarget !== undefined) {`,
    testFiles: [
      "tests/core/integration/cross-project-resource-io.test.ts",
      "tests/core/integration/cross-project-sdk-entry.test.ts",
    ],
    expectedFailingTestNames: [
      "受保护存储（backup-vault / 删除审计）不得经跨项目通道访问",
      "副本导入：**来源**是受保护存储时不得被拷出去",
      "受保护存储之删除审计文件同样不得经跨项目通道读取",
      "SDK 入口：受保护存储（backup-vault）不得经跨项目通道读取",
    ],
    rationale: "受保护存储判定被禁用时，保管库/审计文件必须仍被拒绝（fail-closed 防线）",
  },
  {
    mutationIdentifier: "cross-project-target-filename-binding-relaxed",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `      if (canonicalizedActualPath !== expectedCanonicalTargetPath) {`,
    replace: `      if (path.dirname(canonicalizedActualPath) !== path.dirname(expectedCanonicalTargetPath)) {`,
    testFiles: ["tests/core/integration/cross-project-resource-io.test.ts"],
    expectedFailingTestNames: [
      "副本导入：目标绝对路径与「目标项目根 + 声明路径」不一致时必须拒绝",
    ],
    rationale:
      "把'完整规范路径比对'放宽成'只比父目录'后，'同目录换个文件名'必须仍被拒绝（否则目标可被调包）",
  },
  {
    mutationIdentifier: "tool-package-reauthorization-gate-removed",
    targetFile: "packages/core/src/toolkit/tool-package-version-state-store.ts",
    find: `    if (differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;`,
    replace: `    if (false && differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;`,
    testFiles: ["tests/core/integration/toolkit01-reauthorization-gate.test.ts"],
    expectedFailingTestNames: [
      "无重新授权记录 ⇒ 必须拒绝",
      "给了不存在的记录标识 ⇒ 必须拒绝",
      "记录与本次操作绑定不匹配 ⇒ 必须拒绝",
      "记录已被消费 ⇒ 必须拒绝",
    ],
    rationale:
      "把'以本地签发的重新授权记录为依据'的门禁整段短路后，无记录/记录不存在/绑定不匹配/已消费四种情形必须全部变红" +
      "（否则等于门禁形同虚设，调用方又能凭自述放行）",
  },
  {
    mutationIdentifier: "tool-package-reauthorization-single-use-removed",
    targetFile: "packages/core/src/toolkit/tool-package-reauthorization-record-store.ts",
    find: `    if (record.consumedAtIso !== null) {`,
    replace: `    if (false && record.consumedAtIso !== null) {`,
    testFiles: [
      "tests/core/unit/toolkit01-reauthorization-record-store.test.ts",
      "tests/core/integration/toolkit01-reauthorization-gate.test.ts",
    ],
    expectedFailingTestNames: [
      "一次性：同一条记录不得二次放行",
      "记录已被消费 ⇒ 必须拒绝",
    ],
    rationale:
      "去掉'一次性消费'后，同一条批准不得能反复升级（否则一次批准可被无限复用）",
  },
  {
    /**
     * 2026-10-22 订正：原两条变异（`comm01-single-parent-uniqueness-removed`、
     * `comm01-direct-parent-check-relaxed`）针对的是**错误模型**
     * （"唯一上级 = 通信授权"），已随实现一并删除。
     * 依 `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54 与用户澄清，
     * 正确语义是"创建来源登记 + 地址完整性"（无绑定记录 ⇒ 直接拒绝）。
     */
    mutationIdentifier: "comm01-unknown-recipient-accepted",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: `    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (record === null) {
      return false;
    }
    return record.recycledAtIso === null;`,
    replace: `    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (false && record === null) {
      return false;
    }
    return record === null || record.recycledAtIso === null;`,
    testFiles: ["tests/core/integration/comm01-agent-creation-registry.test.ts"],
    expectedFailingTestNames: ["**无绑定记录**的收件人 ⇒ 直接拒绝"],
    rationale:
      "放宽'无绑定记录即拒收'后，未知地址会被当作可投递主体" +
      "（用户澄清的硬规则：投递到无绑定记录的对象**直接拒绝**）",
  },
  {
    mutationIdentifier: "comm01-creation-provenance-not-persisted",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: `      if (parsed.schemaVersion !== 1) {
        return;
      }`,
    replace: `      if (false && parsed.schemaVersion !== 1) {
        return;
      }`,
    testFiles: ["tests/core/integration/comm01-agent-creation-registry.test.ts"],
    expectedFailingTestNames: ["`schemaVersion` 不符 ⇒ 按空继续"],
    rationale:
      "不再按 schemaVersion 拒收后，异版本文档里的记录会被当作**存在的主体**" +
      "⇒ 未知地址变成可投递（伪造存在性）",
  },
  {
    mutationIdentifier: "comm01-delivery-address-check-skipped",
    targetFile: "packages/core/src/feedback-process/delivery-worker.ts",
    find: `    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {`,
    replace: `    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (false && isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {`,
    testFiles: ["tests/core/integration/comm01-delivery-address-integrity.test.ts"],
    expectedFailingTestNames: [
      "收件人**无绑定记录** ⇒ 不投递、不标记已投递",
      "真实 AgentCreationRegistry 端到端",
    ],
    rationale:
      "把投递步骤的地址完整性整段短路后，'无绑定记录 / 已回收的收件人不得投递'必须变红" +
      "（否则该检查只写在模块里、在真实投递路径上并不生效）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-authority-check-skipped",
    targetFile: "packages/core/src/toolkit/tool-package-operation-control.ts",
    find: `  if (input.authorizationController !== undefined) {
    const authority = await input.authorizationController.resolveIssuingAuthority({`,
    replace: `  if (false && input.authorizationController !== undefined) {
    const authority = await input.authorizationController.resolveIssuingAuthority({`,
    testFiles: ["tests/core/integration/toolkit01-reauthorization-gate.test.ts"],
    expectedFailingTestNames: ["**无资格的 Agent** 不得签发"],
    rationale:
      "短路'签发资格'判定后，未获授予的 Agent 又能在**真实签发入口**上凭空签发" +
      "（用户澄清：默认只有用户持有该权限，Agent 须经显式授予）",
  },
  {
    mutationIdentifier: "toolkit01-delegation-amplification-allowed",
    targetFile: "packages/core/src/toolkit/tool-upgrade-authorization-grant.ts",
    find: `      if (ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {`,
    replace: `      if (false && ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-authorization.test.ts"],
    expectedFailingTestNames: [
      "**逐层分发不得放大**：自身有期限时不得授出无期限能力",
      "**逐层分发不得放大**：授出期限不得晚于自身期限",
    ],
    rationale:
      "放开'不得放大'后，下级可授出无期限/更长期限的能力 ⇒ 逐层分发变成权限膨胀" +
      "（用户要求'向下级逐层分发'但**不得放大**）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-declaration-modes-not-required",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `  if (missingModes.length > 0) {`,
    replace: `  if (false && missingModes.length > 0) {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["**缺少任一模式** ⇒ 拒绝"],
    rationale:
      "不再要求三模式齐全后，升级包可以只声明一部分模式就落地" +
      "（用户明确要求'必须显式声明三种模式的默认权限规则和理由'）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-declaration-reason-not-required",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `      if (rule.reason.trim() === "") {`,
    replace: `      if (false && rule.reason.trim() === "") {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["但**规则没有理由** ⇒ 拒绝"],
    rationale:
      "不再要求理由后，升级包可加开关却不说为什么" +
      "（用户明确要求'显式声明三种模式的默认权限规则**和理由**'）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-removed-feature-rules-kept",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return !removedFeatureIdentifiers.has(key);
  });`,
    replace: `  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return true || !removedFeatureIdentifiers.has(key);
  });`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["**消失的功能** ⇒ 移除其旧规则"],
    rationale:
      "不再移除消失功能的旧规则后，'消失的功能也要对应移除旧的权限管理开关'这条就不成立" +
      "（会留下指向已不存在功能的僵尸开关）",
  },
  {
    mutationIdentifier: "comm01-feedback-ignores-task-publisher",
    targetFile: "packages/core/src/orchestration/worker-agent.ts",
    find: `      recipientId: route.recipientId,`,
    replace: `      recipientId: \`scheduler:\${this.options.missionId}\`,`,
    testFiles: [
      "tests/core/unit/worker-agent.test.ts",
      "tests/core/unit/comm01-task-publisher-feedback-route.test.ts",
    ],
    expectedFailingTestNames: [
      "任务记录了发布者 ⇒ 反馈**投给发布者**而非默认 scheduler",
    ],
    rationale:
      "把反馈去向改回硬编码 scheduler 后，'反馈走任务发布者反向通道'必须变红" +
      "（用户澄清：反馈**不是**根据上下级关系，而是默认走任务发布者的反向通道）",
  },
  {
    mutationIdentifier: "comm01-publisher-stamp-overwrites-existing",
    targetFile: "packages/core/src/orchestration/task-publisher-feedback-route.ts",
    find: `  const existing = input.task.publishedByRecipientId;
  if (typeof existing === "string" && existing.trim() !== "") {
    return existing;
  }`,
    replace: `  const existing = input.task.publishedByRecipientId;
  if (false && typeof existing === "string" && existing.trim() !== "") {
    return existing;
  }`,
    testFiles: ["tests/core/unit/comm01-task-publisher-feedback-route.test.ts"],
    expectedFailingTestNames: ["任务**已带**发布者 ⇒ 尊重原值"],
    rationale:
      "强行覆盖既有发布者 ⇒ 会把反馈从真正的发布者改投到本编排器（另一种'错投'）" +
      "（'尊重原值'这条必须变红）",
  },
  {
    mutationIdentifier: "comm01-orchestrator-skips-publisher-stamp",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    /**
     * ⚠️ **2026-11-08（第 133 轮）修正（两次踩坑，记录）**：
     *
     * 1. 原 `find` 是**多行**模板串，而 `mission-orchestrator.ts` 与 harness 的**行尾不同**
     *    （工作区源文件 CRLF、harness LF）⇒ 多行 find **永不匹配**（全量跑报「锚点命中 0 次」）；
     * 2. 我一度以为是"转义反引号"写坏，改成双引号 `\n` 拼接 —— 同样因行尾不匹配而失败。
     *
     * **结论：跨文件多行锚点在 Windows 上必须避开**（行尾不可控）。现改为**单行**变异，
     * 语义不变：把发布者信箱登记改成 `undefined` 即"编排器不再登记发布者"。
     */
    find: "          publisherRecipientId: `scheduler:${options.missionId}`,",
    replace: "          publisherRecipientId: undefined as never,",
    testFiles: ["tests/core/unit/comm01-task-publisher-feedback-route.test.ts"],
    expectedFailingTestNames: ["编排器产出的 Worker 配置里，任务带着"],
    rationale:
      "编排器不再登记发布者 ⇒ '编排器产出的 Worker 配置里带着编排器自己的信箱'必须变红" +
      "（否则这次'启用'等于没启用，反向通道又变回死代码）",
  },
  {
    mutationIdentifier: "comm01-relay-recipient-bypassed",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `    request: {
      relayRecipientAgentInstanceId: directParentAgentInstanceId,`,
    replace: `    request: {
      relayRecipientAgentInstanceId: input.targetAgentInstanceId,`,
    testFiles: ["tests/core/unit/comm01-collaboration-relay.test.ts"],
    expectedFailingTestNames: [
      "收件人**由本地按归属算出** = 目标的唯一直属上级",
      "**不允许第二上级直接下令**",
    ],
    rationale:
      "把收件人改成目标自己（绕过其唯一直属上级）后，'经唯一上级转达'必须变红" +
      "（卡内 §2.2：涉及三级/四级目标的跨上级句柄须向**其直属上级的协作收件箱**递交）",
  },
  {
    mutationIdentifier: "comm01-relay-marks-original-instruction",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `      isRelayedRequest: true,`,
    replace: `      isRelayedRequest: false as never,`,
    testFiles: ["tests/core/unit/comm01-collaboration-relay.test.ts"],
    expectedFailingTestNames: ["**显式标注为转达**（不冒充原创）"],
    rationale:
      "不再标注为转达 ⇒ 接收方会把转达请求当成直属上级的**原创指令**" +
      "（卡内 §2.2 明确：转达保留来源、转达者与任务关联，**不冒充直属上级原创**）",
  },
  {
    mutationIdentifier: "comm01-relay-parent-unavailable-not-paused",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `    return {
      isRoutable: false,
      isPausedForRecovery: true,
      reason:
        "协作目标的直属上级 \`" + directParentAgentInstanceId +`,
    replace: `    return {
      isRoutable: false,
      isPausedForRecovery: false as never,
      reason:
        "协作目标的直属上级 \`" + directParentAgentInstanceId +`,
    testFiles: ["tests/core/unit/comm01-collaboration-relay.test.ts"],
    expectedFailingTestNames: ["**原上级已不可用** ⇒ **暂停并存档**"],
    rationale:
      "原上级不可用却不再要求暂停存档 ⇒ 执行者可能被诱导自行另找上级" +
      "（卡内 §2.2：原上级不可用时暂停并存档，不让执行者自行找新上级）",
  },
  {
    mutationIdentifier: "project01-controlled-port-skips-protected-storage",
    targetFile: "packages/core/src/tools/controlled-cross-project-resource-io.ts",
    find: `    await this.protectedStoragePolicy.assertGenericToolAccessAllowed({
      canonicalTargetPath: resolvedWithinWorkspace,
      operation,
    });`,
    replace: `    if (false) {
      await this.protectedStoragePolicy.assertGenericToolAccessAllowed({
        canonicalTargetPath: resolvedWithinWorkspace,
        operation,
      });
    }`,
    testFiles: [
      "tests/core/integration/project01-controlled-resource-io-port.test.ts",
    ],
    expectedFailingTestNames: [
      "读取**保管库**内文件 ⇒ 拒绝",
      "写入**保管库** ⇒ 拒绝",
      "删除审计文件同样不得经该端口读取",
      "`fileExists` 对受保护路径也必须先判定",
    ],
    rationale:
      "受控端口不再过受保护存储判定 ⇒ '保管库/审计文件必须被拒'四条必须变红" +
      "（否则该端口就退化成 CLI 那种'拿到绝对路径就能读写'，正是卡内禁止的）",
  },
  {
    mutationIdentifier: "project01-controlled-port-skips-workspace-boundary",
    targetFile: "packages/core/src/tools/controlled-cross-project-resource-io.ts",
    find: `    const resolvedWithinWorkspace =
      await this.workspaceBoundary.resolveWithinWorkspace(absolutePath);`,
    replace: `    const resolvedWithinWorkspace = absolutePath;`,
    testFiles: [
      "tests/core/integration/project01-controlled-resource-io-port.test.ts",
    ],
    expectedFailingTestNames: [
      "读取**工作区外**的绝对路径 ⇒ 拒绝",
      "**写入**工作区外 ⇒ 拒绝",
      "`ensureDirectory` 越界 ⇒ 拒绝",
    ],
    rationale:
      "跳过工作区边界 ⇒ 工作区外路径可被读写（'拿到绝对路径就能读写'）⇒ 三条越界反例必须变红",
  },
  {
    mutationIdentifier: "project01-human-edit-guard-fails-open",
    targetFile: "packages/core/src/tools/cross-project-human-edit-guard.ts",
    find: `        return {
          hasHumanChange: true,
          reason: "目标已存在但不是普通文件（可能是目录/链接）⇒ 拒绝覆盖（fail-closed）",
        };`,
    replace: `        return {
          hasHumanChange: false,
          reason: "目标已存在但不是普通文件（可能是目录/链接）⇒ 拒绝覆盖（fail-closed）",
        };`,
    testFiles: ["tests/core/integration/project01-human-edit-guard.test.ts"],
    expectedFailingTestNames: ["目标是**目录**而非普通文件 ⇒ 判为有人工改动"],
    rationale:
      "把'非普通文件'判为无人工改动（fail-open）⇒ 可能对目录/链接路径放行覆盖 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "project01-import-guard-missing-without-baseline",
    targetFile: "packages/core/src/public-sdk.ts",
    /**
     * 注意：`public-sdk.ts` 是 **CRLF** 文件（实测 4527 个 CRLF、0 个裸 LF），
     * 多行 `find` 锚点会因换行符不同而**命中 0 次**（验证器会当场报错，不会静默跳过）。
     * 故这里用**单行锚点**。
     */
    find: `        const baselineContentHash = input.expectedTargetContentHash;`,
    replace: `        const baselineContentHash = input.expectedTargetContentHash;
        // 变异：不再回退默认守卫（用于验证"端到端可见"）
        if (true) { return undefined; }`,
    testFiles: [
      "tests/core/integration/project01-default-resource-io-assembly.test.ts",
    ],
    expectedFailingTestNames: ["目标已存在且内容**与预期一致** ⇒ 允许"],
    rationale:
      "未给基线时又不回退默认守卫 ⇒ 目标已存在恒 target-stale-rejected（'能读不能导'）" +
      "⇒ 该端到端用例必须变红",
  },
  {
    mutationIdentifier: "gui0203-history-reads-all-missions",
    targetFile: "packages/core/src/gui/mission-history-reader.ts",
    find: `  const pageDirectories = missionDirectories.slice(
    startOffset,
    startOffset + effectivePageSize,
  );`,
    replace: `  const pageDirectories = missionDirectories;`,
    testFiles: ["tests/gui/integration/gui02-03-mission-history.test.ts"],
    expectedFailingTestNames: [
      "有 97 个 mission 时，取一页**只读该页**的 summary.json",
      "翻页不重不漏",
    ],
    rationale:
      "分页按需的要害：若一页就把全部 mission 目录都读进来，97 个 mission 会读 97 个文件" +
      "（卡内明令'不得全量读 97 mission'）⇒ '只读本页 10 条'的反例必须变红",
  },
  {
    mutationIdentifier: "gui0203-history-terminal-may-run",
    targetFile: "packages/core/src/gui/mission-history-reader.ts",
    find: `  const isActivelyRunning =
    recordedStatus === "running" && (await input.isMissionActivelyRunning(input.missionIdentifier));`,
    replace: `  const isActivelyRunning = await input.isMissionActivelyRunning(input.missionIdentifier);`,
    testFiles: ["tests/gui/integration/gui02-03-mission-history.test.ts"],
    expectedFailingTestNames: ["已终态（done/blocked/cancelled）不受运行态影响"],
    rationale:
      "去掉'recordedStatus===running'这一前置条件 ⇒ 已终态任务会被运行态查询翻回'运行中'" +
      "⇒ 该反例必须变红（卡内要求：历史状态与运行状态分离，终态不得自称在跑）",
  },
  {
    mutationIdentifier: "gui0203-history-corruption-dropped",
    targetFile: "packages/core/src/gui/mission-history-reader.ts",
    find: `  const totalMissionCount = missionDirectories.length;`,
    replace: `  const totalMissionCount = missionDirectories.length;
  // 变异：把损坏记录静默丢弃（用 0 长度占位再过滤）
  missionDirectories.length = 0;`,
    testFiles: ["tests/gui/integration/gui02-03-mission-history.test.ts"],
    expectedFailingTestNames: ["有 97 个 mission 时"],
    rationale:
      "把枚举结果清空 ⇒ 列表为空，'损坏记录必须保留在列表中'与分页反例都会变红" +
      "（证明'不静默丢弃'这条真的有断言在守）",
  },
  {
    mutationIdentifier: "gui0203-history-blank-project-faked",
    targetFile: "packages/core/src/gui/mission-history-reader.ts",
    find: `    typeof rawProjectIdentifier === "string" && rawProjectIdentifier.trim().length > 0
      ? rawProjectIdentifier.trim()
      : null;`,
    replace: `    typeof rawProjectIdentifier === "string"
      ? rawProjectIdentifier
      : null;`,
    testFiles: ["tests/gui/integration/gui02-03-mission-history.test.ts"],
    expectedFailingTestNames: ["空字符串项目名不得被当成有效项目"],
    rationale:
      "去掉'非空白'校验 ⇒ 空白项目名会被原样返回，界面显示一个'看着有值其实是空'的项目" +
      "⇒ 该反例必须变红（不得伪装项目名）",
  },
  {
    mutationIdentifier: "gui0203-views-runtime-state-collapsed",
    targetFile: "packages/gui/src/application/gui-read-model.ts",
    find: `    case "interrupted-needs-reconciliation":
      return "已中断，待对账";`,
    replace: `    case "interrupted-needs-reconciliation":
      return "运行中";`,
    testFiles: ["tests/gui/unit/gui02-03-mission-history-views.test.ts"],
    expectedFailingTestNames: [
      "**历史状态与运行状态分列**：重启前 running 不得显示成运行中",
    ],
    rationale:
      "把'已中断待对账'的运行态标签改成'运行中' ⇒ 重启前的 mission 会在界面上显示成正在运行" +
      "（正是卡内明令禁止的）⇒ 该反例必须变红" +
      "（注意：详情视图那条用的是**已终态**记录，不经过 interrupted 分支，故**不**列入点名 —— " +
      "把它列进来会让验证器判定'变异存活'，那是我的期望写错、不是断言空）",
  },
  {
    mutationIdentifier: "gui0203-views-missing-field-blank",
    targetFile: "packages/gui/src/application/gui-read-model.ts",
    find: `const GUI_MISSION_UNKNOWN_TEXT = "（未知）";`,
    replace: `const GUI_MISSION_UNKNOWN_TEXT = "";`,
    testFiles: ["tests/gui/unit/gui02-03-mission-history-views.test.ts"],
    expectedFailingTestNames: [
      "损坏条目在列表里**明确标注**且不消失",
      "详情对损坏条目**明确**说明，且缺失字段为",
    ],
    rationale:
      "把缺失字段文案改成空串 ⇒ 界面看起来像'有值但为空'，用户无法区分'没有这个信息'" +
      "⇒ 这两条反例必须变红",
  },
  /**
   * 2026-11-08（第 92 轮）新增：把上一轮**手工**做的两个探针固化为**永久**变异体。
   *
   * 由来：第 91 轮发现 `it("watchdog 不误续跑旧指令/未收敛取消")` 的**名字**承诺了
   * "旧指令"，但其断言只覆盖取消类三条分支；生产代码里真正对应"旧指令"的
   * `instruction-superseded` 分支**全仓零覆盖** ⇒ 该验收**有实现、无守卫**。
   * 当时靠**一次性**变异探针发现，这类探针不会自动复跑 ⇒ 一并固化，防回归。
   */
  {
    mutationIdentifier: "guide01-watchdog-resumes-superseded-instruction",
    targetFile: "packages/core/src/runtime-guidance/long-tool-checkpoint.ts",
    find: `      return { shouldResume: false, reason: "instruction-superseded" };`,
    replace: `      return { shouldResume: true, reason: "instruction-superseded" };`,
    testFiles: ["tests/core/integration/long-tool-checkpoint.test.ts"],
    expectedFailingTestNames: ["watchdog 不误续跑**旧指令**"],
    rationale:
      "把'被新指导取代的旧指令不得续跑'改成'照样续跑' ⇒ watchdog 会按**已失效的** " +
      "instructionRevision 续跑旧指令（卡内 GUIDE-01-03 明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "diag01-execution-refusal-recorded-as-failure",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: `        !isExecutionRefusalErrorCode(toolResult.errorCode)`,
    replace: `        true`,
    testFiles: ["tests/core/integration/obs01-diag-production-collection.test.ts"],
    expectedFailingTestNames: ["执行前拒绝（工具不存在）不得记成故障"],
    rationale:
      "去掉'执行前拒绝'过滤 ⇒ 权限拒绝/工具不存在/敏感内容禁读等**确定无副作用**的拒绝" +
      "会被记成程序故障（卡内 DIAG-01 明令：拒绝与取消不得记成失败）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 93 轮）新增。由来：`AGENTS.md` 明令「底层强制约束**不进入可配置权限目录**，
   * 也不得由 TUI/CLI、帮助、导出配置、普通错误详情或模型提示**向用户披露**」，
   * 目录自己的 docstring 也写着同一句 —— 但**此前只有文档、没有守卫**：
   * 注入下面这条"内部强制层能力"后，**18 个相关测试文件 / 147 条用例全部照旧通过**。
   */
  {
    mutationIdentifier: "ar07-internal-constraint-published-in-catalog",
    targetFile: "packages/core/src/tools/permission-capability-catalog.ts",
    find: `  { capabilityId: "project.read", displayName: "项目读取",`,
    replace:
      `  { capabilityId: "internal.sensitive-content-read-denied", displayName: "敏感内容禁读（内部强制）", ` +
      `description: "内部强制执行层：不属于可配置权限", devolveDefault: "deny", assistDefault: "deny", ` +
      `applicableResources: [], riskSummary: "内部" },\n` +
      `  { capabilityId: "project.read", displayName: "项目读取",`,
    testFiles: ["tests/core/unit/ar07-internal-enforcement-non-disclosure.test.ts"],
    expectedFailingTestNames: [
      "目录文案里不得出现内部强制层的措辞",
      "每条能力的命名空间必须属于**冻结的公开清单**",
    ],
    rationale:
      "把内部强制执行层（敏感内容禁读）当成一条**可配置权限**写进目录 ⇒ 它就会出现在设置界面、" +
      "帮助与导出配置里，用户得以知晓并试图调整本应不可配置的底层约束" +
      "（AGENTS.md 强制规范与 ADR-0020 均禁止）⇒ 这两条反例必须变红",
  },
  /**
   * 2026-11-08（第 94 轮）新增两个：**思索模式白名单**与**破坏性工具自动备份**。
   * 两者本轮都被拦下（本就承重）⇒ 固化防回归。
   */
  {
    mutationIdentifier: "ponder01-write-tool-added-to-readonly-allowlist",
    targetFile: "packages/core/src/tools/local-tool-policy-engine.ts",
    find: `  "readFile",
  "listDirectory",`,
    replace: `  "readFile",
  "writeFileTemporary",
  "listDirectory",`,
    testFiles: [
      "tests/core/unit/local-tool-policy.test.ts",
      "tests/core/integration/ponder-readonly-tools-production-wiring.test.ts",
    ],
    expectedFailingTestNames: [
      "非白名单工具一律 fail-closed 并产生拒绝事件",
      "思索模式暴露只读白名单工具，隐藏写/执行类工具",
    ],
    rationale:
      "把**写类工具**塞进思索模式只读白名单 ⇒ 思索模式（AGENTS.md：编辑、进程执行、网络访问" +
      "必须由本地 harness **直接禁用**，不能仅靠提示词约束）就会向模型暴露并允许写操作" +
      "⇒ 这两条反例必须变红",
  },
  {
    mutationIdentifier: "ar07-destructive-tool-without-auto-backup-accepted",
    targetFile: "packages/core/src/core/schemas.ts",
    find: `      destructiveToolMutationKinds.has(descriptor.mutationKind) &&
      descriptor.backupPolicy !== "automatic-preimage"`,
    replace: `      false &&
      descriptor.backupPolicy !== "automatic-preimage"`,
    testFiles: ["tests/core/unit/schemas.test.ts"],
    expectedFailingTestNames: ["拒绝未提供工具内自动备份的破坏性工具"],
    rationale:
      "放宽 schema 校验 ⇒ 破坏性工具（删除/覆盖/截断…）可以**不声明**工具内自动备份即注册，" +
      "直接违反 AGENTS.md「任何删除、文本删减、替换、截断或覆盖必须由执行工具在变更前自动备份」" +
      "⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 96 轮）新增。**注意这条的 `find` 是整段表达式**：
   * 我第一次只改其中一项条件（去掉 `pathPrefixes.length > 0`），
   * 其余条件仍生效 ⇒ **变异太弱、根本没改变行为**，于是得到假结论"存活"。
   * 换成整段恒真后，该用例立刻变红。
   * ⇒ **教训：注入后必须先自问"这真的改变了被测行为吗"**（见文件头部的第 3 条纪律）。
   */
  {
    mutationIdentifier: "project01-narrowed-derivation-widening-accepted",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `    const isNarrower =
      input.resourceScope.pathPrefixes.length > 0 &&
      input.resourceScope.pathPrefixes.every((candidatePrefix) =>
        parent.resourceScope.pathPrefixes.some(
          (parentPrefix) =>
            candidatePrefix === parentPrefix || candidatePrefix.startsWith(parentPrefix),
        ),
      ) &&
      input.resourceScope.realPaths.every((candidatePath) =>
        parent.resourceScope.realPaths.includes(candidatePath),
      ) &&
      (!input.resourceScope.isDynamicSharedDirectory ||
        parent.resourceScope.isDynamicSharedDirectory);`,
    replace: `    const isNarrower = true;`,
    testFiles: ["tests/core/integration/cross-project-authorization.test.ts"],
    expectedFailingTestNames: ["任务内缩权派生：派生授权范围必须**不宽于**来源授权"],
    rationale:
      "让'派生范围必须不宽于父授权'恒真 ⇒ 任何任务都能凭父授权**扩大**自己的资源范围" +
      "（跨项目只读授权可被放大成写/越界范围，属提权）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 98 轮）新增两个（**均用"整段条件"的强变异**，吸取"弱变异"教训）：
   * 反自指/活锁保护，以及恢复检查点哈希链。
   */
  {
    mutationIdentifier: "ar07-repeat-read-suppression-removed",
    targetFile: "packages/core/src/tools/read-suppression-ledger.ts",
    find: `      currentFingerprint === null ||
      currentFingerprint.deviceInode !== entry.resourceIdentity.deviceInode ||
      (entry.contentFingerprint !== null &&
        currentFingerprint.contentFingerprint !== entry.contentFingerprint)
    ) {`,
    replace: `      true
    ) {`,
    testFiles: [
      "tests/core/integration/cross-mission-isolation-regression.test.ts",
      "tests/core/integration/read-file-view.test.ts",
      "tests/core/unit/ar07-fault-and-counterexample-gaps.test.ts",
    ],
    expectedFailingTestNames: [
      "同一 agentInstanceId 重复读取才是真正的自指读取（必须抑制）",
      "同一视图窗口内重复读取被抑制（resource-already-read）",
      "路径别名与相对段不能绕过抑制键",
    ],
    rationale:
      "把'资源确实变了'判定改成**恒真** ⇒ 同一来源短时间内重复读取**未变化**的资源不再被抑制，" +
      "模型可被诱导反复读同一文件（AGENTS.md 明令必须有本地**反自指/活锁**保护）⇒ 上述反例必须变红",
  },
  {
    mutationIdentifier: "ar07-recovery-checkpoint-chain-break-accepted",
    targetFile: "packages/core/src/orchestration/recovery-checkpoint-store.ts",
    find: `      if (
        previousTrusted !== null &&
        checkpoint.previousCheckpointHash !== previousTrusted.checkpointHash
      ) {`,
    replace: `      if (false) {`,
    testFiles: ["tests/core/unit/recovery-checkpoint-store.test.ts"],
    expectedFailingTestNames: ["哈希链断裂：前一检查点哈希不匹配 → 拒绝写入"],
    rationale:
      "跳过'前一检查点哈希必须匹配'校验 ⇒ 被篡改/错序的检查点会被当成可信状态接受，" +
      "恢复时会按**伪造的信任链**继续（审计完整性失守）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 101 轮）新增：**工作区边界**（`isPathWithin` 恒真 ⇒ 包含性判定与
   * 符号链接逃逸判定**同时**失效）。本轮实测该守卫覆盖**非常充分**（多个文件大量用例变红），
   * 固化以防回归 —— 它失守意味着可读写工作区**之外**的文件。
   */
  {
    mutationIdentifier: "workspace-boundary-escape-accepted",
    targetFile: "packages/core/src/tools/workspace-boundary.ts",
    find: `  const relativePath = path.relative(workspaceRootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );`,
    replace: `  return true;`,
    testFiles: [
      "tests/core/unit/tool-registry.test.ts",
      "tests/core/unit/protected-storage-policy.test.ts",
      "tests/core/integration/project01-controlled-resource-io-port.test.ts",
    ],
    expectedFailingTestNames: [
      "工作区内文件读取成功、逃逸被拒（WorkspaceBoundary）",
      "符号链接逃逸被拒（WorkspaceBoundary）",
      "读取**工作区外**的绝对路径 ⇒ 拒绝，且**没有读到内容**",
    ],
    rationale:
      "让'路径是否在工作区内'恒真 ⇒ `..` 逃逸与**符号链接逃逸**同时不再被拦，工具可读写工作区之外的任意路径" +
      "（AGENTS.md：真实路径/工作区/OS 边界必须由**本地确定性**策略执行）⇒ 上述反例必须变红",
  },
  /**
   * 2026-11-08（第 101 轮）新增两条：**四级委派权限不得宽于三级**（`quaternary-boundary-guards.ts`）。
   * 「求交」与「超出即拒绝分发」是**两种不同行为**，故各锁一条。本轮实测两条均被拦下 ⇒ 无缺口。
   */
  {
    mutationIdentifier: "quaternary-permission-intersection-bypassed",
    targetFile: "packages/core/src/orchestration/quaternary-boundary-guards.ts",
    find: `    return this.tertiaryGuard.computeDelegatedDecision({
      secondaryEffectiveDecision: this.options.tertiaryEffectiveDecision,
      requestedDelegatedDecision: requestedDecision,
    });`,
    replace: `    return requestedDecision;`,
    testFiles: ["tests/core/unit/quaternary-lifecycle.test.ts"],
    expectedFailingTestNames: ["四级决定 = 三级 ⊓ 请求（不宽于三级）"],
    rationale:
      "让四级权限**直接等于请求值**（不做与三级有效权限的求交）⇒ 三级可把**自己都没有的**权限授予四级，" +
      "越权沿层级向下放大（AGENTS.md：四级权限/工具/范围/期限不得宽于三级）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "quaternary-permission-excess-delegation-accepted",
    targetFile: "packages/core/src/orchestration/quaternary-boundary-guards.ts",
    find: `    this.tertiaryGuard.assertDelegationAllowed({
      secondaryEffectiveDecision: this.options.tertiaryEffectiveDecision,
      requestedDelegatedDecision: requestedDecision,
    });`,
    replace: `    return;`,
    testFiles: ["tests/core/unit/quaternary-lifecycle.test.ts"],
    expectedFailingTestNames: ["请求宽于三级 → 拒绝分发"],
    rationale:
      "把'超出三级上限即拒绝分发'变成**空操作** ⇒ 越权请求不再被拒（只是被静默夹紧或放行），" +
      "调用方无从得知自己越界 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 102 轮）新增。由来：**本轮探针一次存活** ——
   * 把 `doesRuleMatch` 里「无 `match` 一律匹配」与「参数不可解析返回 false」两块**顺序对调**后，
   * **12 个相关文件 / 102 条用例全部照旧通过** ⇒ 该情形**此前无任何断言**；
   * 而文件自身两处表述在此情形下互相矛盾（L86-88「一律匹配」 vs L120「不套用任何规则」）。
   * 已补反例 ⑨（钉住"**仅按 action 的规则不依赖参数文本**"），并把本变异固化。
   */
  {
    mutationIdentifier: "merge01-unparseable-parameters-change-action-only-decision",
    targetFile: "packages/core/src/tools/parameter-authorization.ts",
    find: `  if (rule.match === undefined) {
    // 无 match：该 action 一律匹配（仍是显式的 action 绑定，不是通配）。
    return true;
  }
  if (parsedArguments === null) {
    return false;
  }`,
    replace: `  if (parsedArguments === null) {
    return false;
  }
  if (rule.match === undefined) {
    // 无 match：该 action 一律匹配（仍是显式的 action 绑定，不是通配）。
    return true;
  }`,
    testFiles: ["tests/core/unit/merge01-parameter-authorization.test.ts"],
    expectedFailingTestNames: ["仅按 action 的规则**不依赖参数文本**"],
    rationale:
      "对调两块后，**仅按 action 的规则**（不读参数）的判定会被'参数是否可解析'改变 ⇒ " +
      "**调用方可控的文本**（把 JSON 弄坏）就能翻转授权结果，凭空多出一个攻击面；" +
      "同时与文件自身「不可解析时不套用任何规则」的契约冲突 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 103 轮）新增：**过期的批准不得复用**（S3「过期…不得复用批准」）。
   * 本轮实测被拦下（在 **47 个相关文件 / 427 条用例**中，仅点名那条变红）⇒ 无缺口，固化防回归。
   */
  {
    mutationIdentifier: "permission-ask-expired-approval-reused",
    targetFile: "packages/core/src/orchestration/permission-ask-contract.ts",
    find: `  if (expiresAtIso !== null && Date.parse(expiresAtIso) <= Date.now()) {`,
    replace: `  if (false) {`,
    testFiles: ["tests/core/unit/gui02-01-r1-approval-fingerprint-reuse.test.ts"],
    expectedFailingTestNames: ["**超出有效期**的批准不得复用"],
    rationale:
      "跳过'批准已过期'判定 ⇒ 一份**早已失效**的批准会被无限期复用，" +
      "用户当初的逐次授权被悄悄延长（S3 明令过期不得复用）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 104 轮）新增：**重放保护**（已成功写入过同一目标 ⇒ 一律不得复用）。
   * 本轮实测被 **3 个独立文件**同时拦下 ⇒ 覆盖扎实，固化防回归。
   */
  {
    mutationIdentifier: "permission-ask-succeeded-target-replay-allowed",
    targetFile: "packages/core/src/orchestration/permission-ask-contract.ts",
    find: `  if (previousApproval.hasSucceededWithSameTarget) {
    return "already-executed";
  }`,
    replace: `  if (false) {
    return "already-executed";
  }`,
    testFiles: [
      "tests/core/unit/gui02-01-r1-approval-fingerprint-reuse.test.ts",
      "tests/tui/unit/permission-ask-reuse.test.ts",
      "tests/core/unit/gui02-01-permission-ask-fingerprint-gap.test.ts",
    ],
    expectedFailingTestNames: [
      "已成功写入过同一目标 ⇒ 一律不得复用（fail-closed 不放宽）",
      "该目标路径已成功写入过 → fail-closed（不得靠抖动绕过重放保护）",
      "已成功写入过同一目标 ⇒ 不得复用（fail-closed，现有行为已正确）",
    ],
    rationale:
      "让'已成功写入过同一目标'整条失效 ⇒ 同一次批准会被**反复套用**、" +
      "同一个写操作被**再次执行**（重放），破坏'逐次授权'语义 ⇒ 上述反例必须变红",
  },
  /**
   * 2026-11-08（第 116 轮）新增两条：**模式默认权限矩阵**（`permission-profile-store.ts`）。
   * 两条都是**提权方向**的变异；本轮实测均被拦下（覆盖充分）⇒ 固化防回归。
   */
  {
    mutationIdentifier: "permission-profile-assist-default-allowed",
    targetFile: "packages/core/src/tools/permission-profile-store.ts",
    find: `        capabilityDecisions[capability.capabilityId] = capability.assistDefault;`,
    replace: `        capabilityDecisions[capability.capabilityId] = "allow";`,
    /** 检索得到的完整文件集（13 个）—— 不手敲子集（本会话曾因此得到「假存活」）。 */
    testFiles: [
      "tests/core/unit/ar07-fault-and-counterexample-gaps.test.ts",
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/b6r10-session-shutdown-record-validity.test.ts",
      "tests/core/unit/craftsman-stage-controller.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/main-controller-facades.test.ts",
      "tests/core/unit/permission-profiles.test.ts",
      "tests/core/unit/profile-cli-contract.test.ts",
      "tests/core/unit/session-control-surface.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/shutdown-and-export-gaps.test.ts",
    ],
    expectedFailingTestNames: ["会话权限 revision 变化后旧提升仍生效（应失效）"],
    rationale:
      "让**协同模式**默认矩阵绕过目录里的 `assistDefault`、一律 `allow` ⇒ AGENTS.md 要求的" +
      "「协同模式使用**独立默认矩阵**」被抹平，危险能力在协同模式下静默放权（提权）" +
      "⇒ 本轮实测：**13 个检索命中文件**（**由检索结果直接喂入**）里 **17 条用例变红**",
  },
  {
    mutationIdentifier: "permission-profile-fallback-allow",
    targetFile: "packages/core/src/tools/permission-profile-store.ts",
    find: `      fallbackDecision: "deny",`,
    replace: `      fallbackDecision: "allow",`,
    testFiles: ["tests/core/unit/elevation-persistence.test.ts"],
    expectedFailingTestNames: ["baseProfileRevision/catalogVersion 不匹配 → 覆盖失效（305）"],
    rationale:
      "把内置 profile 的**兜底判定**由 `deny` 改成 `allow` ⇒ 目录里**未出现/未验证**的能力不再默认拒绝" +
      "（fail-open；AGENTS.md：`deny` 优先、未验证范围归人工裁决）⇒ 本轮实测 **2 条用例变红**",
  },
  /**
   * 2026-11-08（第 117 轮）新增：**删除备份审计的"高查阅优先级"不得被降级**
   * （AGENTS.md：放权模式不提示但写入**高查阅优先级**审计日志）。
   *
   * 本条探针另有**诊断价值**：若测试只是拿常量自比（`reviewPriority === BACKUP_DELETION_AUDIT_PRIORITY`），
   * 改常量就**抓不到** ⇒ 本条会"存活"。实测**被 3 条用例拦下** ⇒ 那些断言**不是同义反复**。
   */
  {
    mutationIdentifier: "backup-audit-review-priority-downgraded",
    targetFile: "packages/core/src/core/types.ts",
    find: `export const BACKUP_DELETION_AUDIT_PRIORITY = "high" as const;`,
    replace: `export const BACKUP_DELETION_AUDIT_PRIORITY = "normal" as const;`,
    /** 检索得到的完整文件集（4 个）—— 不手敲子集。 */
    testFiles: [
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/backup-vault.test.ts",
      "tests/core/unit/builtins.test.ts",
      "tests/core/unit/frozen-decisions.test.ts",
    ],
    expectedFailingTestNames: ["删除备份审计记录使用高查阅优先级"],
    rationale:
      "把删除备份审计记录的查阅优先级由 `high` 降为 `normal` ⇒ 规则要求的「**高查阅优先级**审计日志」被静默降级，" +
      "高优先级审计的意义（先被人看到）丢失 ⇒ 本反例必须变红",
  },
  /**
   * 2026-11-08（第 117 轮）新增：**跨项目授权裁决的第一条 —— `deny` 优先**。
   * `AGENTS.md`：`deny` 优先；任何"显式拒绝"都必须整体拒绝，不能被其它侧允许或模式放宽覆盖。
   */
  {
    mutationIdentifier: "cross-project-deny-precedence-bypassed",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `  if (input.requestedResourceIsDenied === true) {`,
    replace: `  if (false && input.requestedResourceIsDenied === true) {`,
    /**
     * 检索得到的完整文件集（9 个）—— **由检索结果直接写入**。
     *
     * ⚠️ 我第一版**手敲**了这份清单（凭印象写了两个不相关的文件、漏掉了
     * `cross-project-permission-matrix.test.ts`）⇒ 该变异被误判为"存活"（第 117 轮，本会话第 4 次同类错误）。
     */
    testFiles: [
      "tests/core/integration/cross-project-authorization.test.ts",
      "tests/core/integration/cross-project-crash-after-write.test.ts",
      "tests/core/integration/cross-project-isolation-multi-project.test.ts",
      "tests/core/integration/cross-project-public-entry.test.ts",
      "tests/core/integration/cross-project-resource-io.test.ts",
      "tests/core/integration/cross-project-sdk-entry.test.ts",
      "tests/core/integration/cross-project-stale-overwrite.test.ts",
      "tests/core/unit/cross-project-permission-matrix.test.ts",
      "tests/tui/unit/cross-project-transfer-cli-entry.test.ts",
    ],
    expectedFailingTestNames: ["显式拒绝优先：即使其它侧允许也不放行"],
    rationale:
      "让跨项目裁决里「**显式拒绝优先**」这条永不触发 ⇒ 显式 deny 会被其它侧的允许或模式放宽盖过，" +
      "`deny` 优先这条底线失守 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 118 轮）新增：**反馈消息的来源必须具体到某个个体**
   * （`AGENTS.md`：每条反馈消息必须携带经过 schema 校验的信息来源；**Agent 来源必须具体到
   * 不可复用的 `agentInstanceId`**，转发时保留原始来源）。
   *
   * **本条是"探针存活 ⇒ 补守卫 ⇒ 固化"的产物**：把 agent 分支的 `agentInstanceId`
   * 由 `z.string().min(1)` 放宽为 `z.string()`（允许空串）后，原本 **12 个检索命中文件 / 150 条用例
   * 全部照旧通过** ⇒ 规则无人守。已补反例（`tests/core/unit/schemas.test.ts`
   * 「Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝」）并把本变异固化。
   *
   * ⚠️ 该条目的 `testFiles` **由检索结果直接写入**（本会话已因手敲清单出现过两次假结论）。
   */
  {
    mutationIdentifier: "feedback-agent-source-identity-emptied",
    targetFile: "packages/core/src/core/schemas.ts",
    find: `      agentInstanceId: z.string().min(1),`,
    replace: `      agentInstanceId: z.string(),`,
    testFiles: [
      "tests/core/integration/comm01-delivery-address-integrity.test.ts",
      "tests/core/integration/feedback-process.test.ts",
      "tests/core/integration/guidance-safe-point.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/delivery-worker.test.ts",
      "tests/core/unit/feedback-client.test.ts",
      "tests/core/unit/feedback-entrypoint.test.ts",
      "tests/core/unit/mailbox-journal.test.ts",
      "tests/core/unit/main-controller.test.ts",
      "tests/core/unit/mission-orchestrator-lease.test.ts",
      "tests/core/unit/orchestration.test.ts",
      "tests/core/unit/schemas.test.ts",
    ],
    expectedFailingTestNames: ["Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝"],
    rationale:
      "让反馈消息 agent 来源的 `agentInstanceId` 接受**空串** ⇒ 来源不再\"具体到某个个体\"，" +
      "身份归属在执行层丢失（转发时也无法保留原始来源）⇒ 本反例必须变红",
  },
  /**
   * 2026-11-08（第 119 轮）新增：**转达必须保留原始来源**（不得冒充原创）。
   *
   * `AGENTS.md`：每条反馈消息必须携带经过 schema 校验的信息来源；**转发时保留原始来源**；
   * 且仓库里 `core/types.ts` 明写「转发消息必须保留原始来源，**不能把路由或转发 Agent 记录为原始来源**」。
   *
   * 本轮实测被 `tests/core/unit/comm01-collaboration-relay.test.ts` 的
   * 「② 转达**保留原始来源、转达者与任务关联**，且**显式标注为转达**（不冒充原创）」拦下 ⇒ 覆盖确证，固化防回归。
   *
   * ⚠️ 该条目的 `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "relay-records-relayer-as-original-source",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `      originalSourceAgentInstanceId: input.originalSourceAgentInstanceId,`,
    replace: `      originalSourceAgentInstanceId: directParentAgentInstanceId,`,
    testFiles: [
      "tests/core/unit/comm01-collaboration-relay.test.ts",
    ],
    expectedFailingTestNames: ["转达**保留原始来源、转达者与任务关联**"],
    rationale:
      "把转达请求里的 `originalSourceAgentInstanceId` 记成**转达者（直属上级）**⇒ " +
      "原始来源被顶替、转达冒充原创（`core/types.ts` 明令禁止）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 120 轮）新增：**个体记忆追加观察必须保留原始来源**
   * （`agent-individual-memory.ts`：「接收方保留原始来源与附件哈希；**不得去除来源冒充自身记忆**」；
   * `AGENTS.md`：跨 Agent 仅可经本地控制器显式选择条目，附件只用于当前任务且**不得自动并入接收方长期记忆**）。
   *
   * 变异把观察的 `sourceAgentInstanceId` 记成**接收方自己**（等于"去除来源冒充自身记忆"）。
   * 本轮实测被 `tests/core/unit/agent-lifecycle-and-memory.test.ts` 的
   * 「两个同级 Agent 相同任务文本下记忆完全隔离」拦下 —— 且该用例是**直接断言**：
   * `expect(memoryB?.observations[0]?.sourceAgentInstanceId).toBe("tertiary-a")`
   * （注释原文「B 的观察保留原始来源与附件哈希」）⇒ 覆盖**直接且正确**，固化防回归。
   *
   * ⚠️ 该条目的 `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "memory-observation-source-replaced-by-owner",
    targetFile: "packages/core/src/orchestration/agent-individual-memory.ts",
    find: `            sourceAgentInstanceId: input.sourceAgentInstanceId,`,
    replace: `            sourceAgentInstanceId: input.runtimeAgentInstanceId,`,
    testFiles: [
      "tests/architecture/destructive-file-api-guard.test.ts",
      "tests/core/integration/anthropic-messages-runtime.test.ts",
      "tests/core/integration/diagnostic-persistent-summary.test.ts",
      "tests/core/integration/diagnostic-readonly-query.test.ts",
      "tests/core/integration/obs01-diag-production-collection.test.ts",
      "tests/core/integration/obs01-perf-production-collection.test.ts",
      "tests/core/integration/orchestration-wiring.test.ts",
      "tests/core/integration/orchestrator-git-integration.test.ts",
      "tests/core/integration/perf-overview-command.test.ts",
      "tests/core/integration/perf-persistent-aggregation.test.ts",
      "tests/core/integration/provider-request-usage-capture.test.ts",
      "tests/core/integration/usage-ledger-persistence.test.ts",
      "tests/core/integration/usage-overview-query.test.ts",
      "tests/core/unit/agent-lifecycle-and-memory.test.ts",
      "tests/core/unit/b6r10-diagnostic-merge-branches.test.ts",
      "tests/core/unit/craftsman-schemas.test.ts",
      "tests/core/unit/craftsman-workflow-lifecycle.test.ts",
      "tests/core/unit/diagnostic-aggregate-branches.test.ts",
      "tests/core/unit/main-controller-facades.test.ts",
      "tests/core/unit/memory-and-report-security.test.ts",
      "tests/core/unit/memory-read-gaps.test.ts",
      "tests/gui/integration/gui-observability-overview.test.ts",
      "tests/tui/unit/doctor-errors-command-branches.test.ts",
      "tests/tui/unit/usage-overview-command-branches.test.ts",
    ],
    expectedFailingTestNames: ["两个同级 Agent 相同任务文本下记忆完全隔离"],
    rationale:
      "把观察的来源记成**接收方自己** ⇒ 去除来源、**冒充自身记忆**（比「记错来源」更严重：" +
      "接受方会把他人条目当成自己的经验，跨 Agent 归属与附件哈希都失去意义）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 121 轮）新增：**专用流程不得被范围解析放宽**。
   *
   * `scope-resolution.ts` 文件头明写「deny 一律优先；安装类必须有独立开关；
   * **专用流程（远端发布/备份删除）不被本模块放宽**」——`S7-special-flow` 必须恒为 `ask-user`。
   *
   * 本轮实测被 `tests/core/integration/auth-scope-resolution.test.ts` 拦下，且该文件里是**直接断言**：
   * 放权模式 + `configuredDecision: "allow"` 下 `S7-special-flow` 必须得到
   * `{decision: "ask-user", adjudicator: "dedicated-flow"}`（位于「矩阵」用例内）。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "scope-dedicated-flow-relaxed",
    targetFile: "packages/core/src/tools/scope-resolution.ts",
    find: `      decision: "ask-user",\n      adjudicator: "dedicated-flow",`,
    replace: `      decision: "allow",\n      adjudicator: "dedicated-flow",`,
    testFiles: [
      "tests/core/integration/auth-scope-install-routing.test.ts",
      "tests/core/integration/auth-scope-resolution.test.ts",
      "tests/core/integration/scope-tool-mapping.test.ts",
      "tests/core/unit/gui02-02-installation-gate-guard-branches.test.ts",
      "tests/core/unit/gui02-02-installation-gate-interface-port.test.ts",
      "tests/core/unit/gui02-02-installation-inquiry-registry.test.ts",
      "tests/gui/integration/gui02-02-installation-not-bypassable.test.ts",
      "tests/gui/integration/gui02-02-permission-ask-ui-constraints.test.ts",
    ],
    expectedFailingTestNames: ["矩阵：协同项目内上级批准、项目外/未知人工、放权未知上级、思索只读"],
    rationale:
      "把专用流程（远端发布／备份删除这类独立授权门）的裁决由 `ask-user` 放宽为 `allow` ⇒ " +
      "本模块**替专用流程放行**、绕开那套逐次授权 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 121 轮）新增：**安装类操作必须受独立开关约束**（开关关闭一律拒绝）。
   *
   * `AGENTS.md`：安装/外部软件操作必须先由本地控制面判定实际作用范围；
   * 「**开关不得代替授权**，不得使用会话记忆、Agent 推断或批量许可放行」。
   *
   * 本轮实测被 3 条用例拦下，其中 `tests/core/integration/auth-scope-resolution.test.ts` 的
   * 「安装类：开关关闭一律拒绝（协同/放权相同）」是**直接点名**该行为的用例。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "scope-installation-switch-bypassed",
    targetFile: "packages/core/src/tools/scope-resolution.ts",
    /** ⚠️ 锚点必须**唯一**：`if (!input.isInstallationEnabled)` 在文件里出现**两次**
     *（S5 安装类与 S1+安装操作两条分支同形）⇒ 带上 S5 分支头一起匹配。 */
    find: `  if (input.scopeClass === "S5-installation") {\n    if (!input.isInstallationEnabled) {`,
    replace: `  if (input.scopeClass === "S5-installation") {\n    if (false && !input.isInstallationEnabled) {`,
    testFiles: [
      "tests/core/integration/auth-scope-gate.test.ts",
      "tests/core/integration/auth-scope-install-routing.test.ts",
      "tests/core/integration/auth-scope-resolution.test.ts",
      "tests/core/integration/permission-refusal-side-effect.test.ts",
      "tests/core/integration/reliability-fault-injection-reservation.test.ts",
      "tests/core/integration/scope-authorization-regrant.test.ts",
      "tests/core/integration/scope-consumption-semantics.test.ts",
      "tests/core/integration/scope-reservation-settlement.test.ts",
      "tests/core/integration/scope-tool-mapping.test.ts",
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/assist-installation-gate.test.ts",
      "tests/core/unit/gui02-02-installation-gate-guard-branches.test.ts",
      "tests/core/unit/gui02-02-installation-gate-interface-port.test.ts",
      "tests/core/unit/installation-gate-execution.test.ts",
      "tests/gui/integration/gui02-02-installation-not-bypassable.test.ts",
    ],
    expectedFailingTestNames: ["安装类：开关关闭一律拒绝（协同/放权相同）"],
    rationale:
      "让 S5 安装类的「独立安装开关关闭 ⇒ 拒绝」永不触发 ⇒ 安装开关形同虚设、" +
      "**开关之外再无门禁**（`AGENTS.md` 明令开关不得被替代、不得被绕过）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 122 轮）新增：**三级期限求交必须"取更早"**（不得晚于次级有效期限）。
   *
   * `session-permission-elevation.ts` 的 `TertiaryPermissionDelegationGuard.computeDelegatedExpiry`：
   * 「三级请求期限**不得晚于**次级有效期限（取更早）」。变异把三元真分支改成请求值
   * ⇒ 求交**永不收紧**，三级可拿到比次级更长的有效期。
   *
   * 本轮实测被 3 条用例拦下（含「期限求交结果不晚于任一输入且取自输入之一」、
   * 「三级权限逐项求交：三态/资源范围/期限均不得宽于次级」）⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "tertiary-delegated-expiry-never-narrowed",
    targetFile: "packages/core/src/tools/session-permission-elevation.ts",
    find: `      ? input.secondaryExpiresAtIso`,
    replace: `      ? input.requestedExpiresAtIso`,
    testFiles: [
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-property-invariants.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/toolkit01-upgrade-authorization.test.ts",
    ],
    expectedFailingTestNames: ["期限求交结果不晚于任一输入且取自输入之一"],
    rationale:
      "把三级期限求交的真分支改成**请求值** ⇒ 求交永不收紧，三级拿到比次级**更长的有效期**" +
      "（AGENTS.md：次级分发给三级的权限必须是其**当前有效权限的等于或更窄子集**）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 123 轮）新增：**会话提升的"到期"必须使其失效**。
   *
   * `AGENTS.md`：当前会话允许认证用户临时提升次级 Agent 的公开权限；提升绑定会话、作用域、
   * 权限项、**有效期**和 revision，**可随时撤销**，关闭会话即失效。
   *
   * 变异把 `record.expiresAtIso !== null &&` 改成 `false &&` ⇒ **到期判定永不生效**，
   * 已过期的提升会继续生效（权限被无限期延长）。
   *
   * 本轮实测被 `tests/core/unit/session-permission-elevation.test.ts` 的
   * 「到期/profile revision/目录版本变化/Agent 回收使覆盖失效」拦下（该用例内直接有
   * 「// 未到期生效」与到期边界断言）⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "elevation-expiry-invalidation-disabled",
    targetFile: "packages/core/src/tools/session-permission-elevation.ts",
    find: `          record.expiresAtIso !== null &&`,
    replace: `          false &&`,
    testFiles: [
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/b6r10-session-shutdown-record-validity.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/session-control-surface.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/shutdown-and-export-gaps.test.ts",
    ],
    expectedFailingTestNames: ["到期/profile revision/目录版本变化/Agent 回收使覆盖失效"],
    rationale:
      "让提升的**到期判定永不生效** ⇒ 过期提升继续放权，用户当初的临时提升被无限期延长" +
      "（`AGENTS.md`：提升绑定**有效期**、可随时撤销）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 124 轮）新增：**个体提升必须只作用于该具体次级 Agent**。
   *
   * `AGENTS.md`：临时提升「默认作用于该会话全部现有及后续次级 Agent，**也可显式限定具体次级**」
   * ⇒ 限定到个体的覆盖**不得外溢**到同级其他个体。
   *
   * 变异把个体范围判定改成 `return true;` ⇒ 个体提升**泄漏到所有次级 Agent**（越权）。
   *
   * 本轮实测被 2 条用例拦下，且两条**直接点名**该性质：
   * 「个体提升不传播到其他次级 Agent（隔离）」「会话级覆盖应用于全部现有及后续次级 Agent；个体覆盖隔离」
   * ⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "elevation-individual-scope-always-applies",
    targetFile: "packages/core/src/tools/session-permission-elevation.ts",
    find: `          return record.scope.agentInstanceId === input.agentInstanceId;`,
    replace: `          return true;`,
    testFiles: [
      "tests/core/unit/b6r10-session-shutdown-record-validity.test.ts",
      "tests/core/unit/craftsman-disclosure.test.ts",
      "tests/core/unit/craftsman-schemas.test.ts",
      "tests/core/unit/craftsman-stage-controller.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/main-controller-facades.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/shutdown-and-export-gaps.test.ts",
    ],
    expectedFailingTestNames: ["个体提升不传播到其他次级 Agent（隔离）"],
    rationale:
      "让限定到**具体个体**的会话提升恒成立 ⇒ 该提升被应用到同级**所有**次级 Agent，" +
      "个体隔离失守、越权扩散（AGENTS.md：个体覆盖只作用于该具体次级）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 126 轮）新增：**参数指纹必须绑定完整规范化参数**（内容变化 ⇒ 指纹变化）。
   *
   * 这条就是 **R1 修掉的历史缺陷本身**：旧实现只比"工具名 + 目标路径"，
   * 导致「同一路径、**内容不同**」也复用批准（与 S3"绑定完整参数指纹"冲突）。
   * `permission-policy.ts` 的 `serializeCanonical` 负责**递归键序规范化**后再 sha256。
   *
   * 变异让规范化**只保留键名、丢掉值** ⇒ 内容变化不再改变指纹 ⇒ 批准可跨内容复用。
   *
   * 本轮实测被 **7 条用例**拦下，**两个方向都有直接断言**：
   * 「② 指纹绑定**完整规范化参数**：内容变化 ⇒ 指纹不同；键序变化 ⇒ 指纹相同」、
   * 「① 【消除缺陷】同一目标路径、**内容不同** ⇒ 必须重新询问」、「① 【R1 已修】…必须 ask-user」、
   * 「语义等价、键序不同 → 规范化与哈希一致；值/数组顺序变化仍敏感」等。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "argument-fingerprint-ignores-values",
    targetFile: "packages/core/src/core/permission-policy.ts",
    /** ⚠️ 必须用**单引号字符串**：内容含 `${…}`，写成模板串会被当插值求值（本轮实测崩溃）。 */
    find: '    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`)',
    replace: '    .map((key) => `${JSON.stringify(key)}`)',
    testFiles: [
      "tests/core/integration/auth-scope-gate.test.ts",
      "tests/core/integration/auth-scope-resolution.test.ts",
      "tests/core/integration/cross-mission-isolation-regression.test.ts",
      "tests/core/integration/diagnostic-persistent-summary.test.ts",
      "tests/core/integration/e2e01-fixture-contract.test.ts",
      "tests/core/integration/gui02-02-permission-ask-adjudication-safety.test.ts",
      "tests/core/integration/instruction-window-persistence-branches.test.ts",
      "tests/core/integration/local-preservation.test.ts",
      "tests/core/integration/permission-authorization-hit.test.ts",
      "tests/core/integration/read-file-view.test.ts",
      "tests/core/integration/scope-authorization-regrant.test.ts",
      "tests/core/integration/scope-reservation-settlement.test.ts",
      "tests/core/integration/sum01-legacy-manifest-migration.test.ts",
      "tests/core/integration/summary-index-publish.test.ts",
      "tests/core/integration/task-accuracy-verifier.test.ts",
      "tests/core/unit/agent-routing-schemas.test.ts",
      "tests/core/unit/ar07-module-gaps-3.test.ts",
      "tests/core/unit/b6r10-diagnostic-merge-branches.test.ts",
      "tests/core/unit/builtins.test.ts",
      "tests/core/unit/cache-metrics.test.ts",
      "tests/core/unit/context-closure-schemas.test.ts",
      "tests/core/unit/craftsman-stage-controller.test.ts",
      "tests/core/unit/diagnostic-aggregate-branches.test.ts",
      "tests/core/unit/evidence-verification.test.ts",
      "tests/core/unit/gui02-01-permission-ask-decision-entry.test.ts",
      "tests/core/unit/gui02-01-permission-ask-event.test.ts",
      "tests/core/unit/gui02-01-permission-ask-fingerprint-gap.test.ts",
      "tests/core/unit/gui02-01-permission-ask-request-entity.test.ts",
      "tests/core/unit/gui02-01-r1-approval-fingerprint-reuse.test.ts",
      "tests/core/unit/human-agent-concurrent-change.test.ts",
      "tests/core/unit/human-worktree-observer.test.ts",
      "tests/core/unit/merge01-instruction-merge-mapping.test.ts",
      "tests/core/unit/permission-policy.test.ts",
      "tests/core/unit/project-reconnaissance.test.ts",
      "tests/core/unit/read-suppression-and-guard.test.ts",
      "tests/core/unit/stale-write-guard.test.ts",
      "tests/core/unit/tool-registry.test.ts",
      "tests/core/unit/toolkit01-reauthorization-record-store.test.ts",
      "tests/core/unit/working-set-schemas.test.ts",
      "tests/gui/integration/gui02-02-permission-ask-registration-wiring.test.ts",
      "tests/gui/integration/gui02-02-permission-ask-routes.test.ts",
      "tests/tui/integration/cli-anthropic-protocol.test.ts",
      "tests/tui/unit/permission-ask-reuse.test.ts",
    ],
    expectedFailingTestNames: ["指纹绑定**完整规范化参数**"],
    rationale:
      "让规范化后的指纹**只取决于键名、不取决于值** ⇒ 「同一路径、内容不同」也复用批准" +
      "（**这正是 R1 修掉的历史缺陷**：与 S3「绑定完整参数指纹」冲突，用户批准被跨内容沿用）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 127 轮）新增：**投递按 idempotencyKey 去重**（同一客户端生命周期内）。
   *
   * `feedback-process/transport.ts` 的 `handleDelivery`：若该 `idempotencyKey` 已投递过，
   * **只回 ack、不再触发 handler**。变异去掉该判定 ⇒ 重复投递会**重复触发处理**
   *（重复副作用；`AGENTS.md`：反馈消息必须携带经 schema 校验的来源，且同一消息不得重复处理）。
   *
   * 本轮实测被 `tests/core/unit/feedback-client.test.ts` 的
   * 「同 idempotencyKey 重复投递只调用 handler 一次并自动 ack」**直接点名**拦下 ⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（此处用较宽检索，覆盖 FeedbackClient 家族）。
   */
  {
    mutationIdentifier: "feedback-delivery-dedup-disabled",
    targetFile: "packages/core/src/feedback-process/transport.ts",
    find: `    if (this.deliveredIdempotencyKeys.has(message.idempotencyKey)) {`,
    replace: `    if (false && this.deliveredIdempotencyKeys.has(message.idempotencyKey)) {`,
    testFiles: [
      "tests/core/integration/comm01-delivery-address-integrity.test.ts",
      "tests/core/integration/feedback-process.test.ts",
      "tests/core/integration/guidance-safe-point.test.ts",
      "tests/core/integration/instruction-continuous-reception.test.ts",
      "tests/core/integration/instruction-stop-recovery.test.ts",
      "tests/core/integration/instruction-window-persistence-branches.test.ts",
      "tests/core/integration/instruction-window-queue.test.ts",
      "tests/core/integration/mcp-stdio-session.test.ts",
      "tests/core/integration/mcp-tool-bridge.test.ts",
      "tests/core/integration/merge01-window-intention-counting.test.ts",
      "tests/core/integration/reliability-before-dispatch-crash.test.ts",
      "tests/core/integration/reliability-r4-ledger-concurrency.test.ts",
      "tests/core/integration/reliability-r4-ledger-corruption.test.ts",
      "tests/core/integration/reliability-sdk-idempotency.test.ts",
      "tests/core/integration/smart01-window-deadline-entry.test.ts",
      "tests/core/unit/application-sdk-task-events.test.ts",
      "tests/core/unit/ar07-module-gaps-6.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/craftsman-disclosure-action.test.ts",
      "tests/core/unit/craftsman-disclosure.test.ts",
      "tests/core/unit/craftsman-schemas.test.ts",
      "tests/core/unit/delivery-worker.test.ts",
      "tests/core/unit/feedback-client.test.ts",
      "tests/core/unit/feedback-entrypoint.test.ts",
      "tests/core/unit/feedback-supervisor.test.ts",
      "tests/core/unit/mailbox-journal.test.ts",
      "tests/core/unit/schemas.test.ts",
      "tests/gui/integration/gui-csrf-browser-simulation.test.ts",
      "tests/gui/integration/gui-server.test.ts",
      "tests/tui/unit/cli-commands.test.ts",
      "tests/tui/unit/run-command-gaps.test.ts",
      "tests/tui/unit/smart01-instruction-cli-entry.test.ts",
      "tests/tui/unit/tui-launch.test.ts",
    ],
    expectedFailingTestNames: ["同 idempotencyKey 重复投递只调用 handler 一次并自动 ack"],
    rationale:
      "去掉投递去重判定 ⇒ 同一条消息被投递两次时会**重复触发 handler**（重复副作用），" +
      "破坏\"同一消息只处理一次\"的契约 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 128 轮）新增：**指令幂等：同键异参必须拒绝、不得覆盖**。
   *
   * `instruction-window-store.ts` 文件头：「② 同键异参（`idempotencyKey` 相同但内容哈希不同）
   * → **拒绝**，不覆盖」。变异去掉该判定 ⇒ 同键异参被**当作新指令接纳/覆盖**，
   * 既有用户指导可能被静默替换。
   *
   * 本轮实测被 `tests/core/integration/instruction-window-persistence-branches.test.ts` 的
   * 「② 同键异参：必须拒绝，不得覆盖既有指令」**直接点名**拦下 ⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "instruction-idempotency-conflict-overwrites",
    targetFile: "packages/core/src/orchestration/instruction-window-store.ts",
    find: `        if (existing.contentHash !== contentHash) {`,
    replace: `        if (false && existing.contentHash !== contentHash) {`,
    testFiles: [
      "tests/core/integration/instruction-continuous-reception.test.ts",
      "tests/core/integration/instruction-stop-recovery.test.ts",
      "tests/core/integration/instruction-window-persistence-branches.test.ts",
      "tests/core/integration/instruction-window-queue.test.ts",
      "tests/core/integration/merge01-window-intention-counting.test.ts",
      "tests/core/integration/usage-ledger-persistence.test.ts",
      "tests/tui/unit/smart01-instruction-cli-entry.test.ts",
    ],
    expectedFailingTestNames: ["同键异参：必须拒绝，不得覆盖既有指令"],
    rationale:
      "让「同键异参」不再被拒绝 ⇒ 内容不同的同键指令被当作新指令接纳，" +
      "**既有指令可能被静默覆盖**（同键异参必须拒绝这一契约失守）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 131 轮）新增：**无进展签名不得包含自由文本**（否则守卫形同虚设）。
   *
   * 这条正是第 130 轮**实测踩到的真 bug**：签名写成
   * `"error:" + errorCode + ":" + errorMessage` 时，`resource-already-read` 的错误文本里带
   * **倒计时字段**（`remainingWaitMilliseconds`）⇒ 签名每次都不同 ⇒ `isNewProgress` 恒真 ⇒
   * 无进展永不累计 ⇒ 守卫永不触发（请求数跑满 `maximumLoopIterations`）。
   *
   * 实测被 `tests/core/integration/g2-progress-guard.test.ts` 的
   * 「启用守卫后必须显著早于上限中止」拦下（守卫开了也照样跑满上限）⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "progress-guard-signature-includes-volatile-text",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: `            : "error:" + toolResult.errorCode;`,
    replace: `            : "error:" + toolResult.errorCode + ":" + toolResult.errorMessage;`,
    testFiles: [
      "tests/core/integration/g2-progress-guard.test.ts",
    ],
    expectedFailingTestNames: ["启用守卫后必须显著早于上限中止"],
    rationale:
      "把无进展签名退回为**含自由文本** ⇒ 带倒计时/时间戳的错误文本使签名每次都变、" +
      "`isNewProgress` 恒真、守卫永不触发（**这正是第 130 轮实测的 bug**）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 133 轮）新增：**高严谨性必须被本地规则真正标记出来**。
   *
   * 变异把判定条件从 `=== "high"` 改成 `=== "standard"`（即**永远不为真**）⇒
   * 高严谨任务不再被标记 ⇒ 不再强制 `factVerification` ⇒ 「证据包缺失也不得结案」形同虚设。
   *
   * 实测被 `tests/core/integration/g3-high-rigor-evidence.test.ts` 的
   * 「高严谨 + 开关开 + 只发完成事件（未调 factVerification）⇒ 不得 done」拦下。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**。
   */
  {
    mutationIdentifier: "high-rigor-marking-never-matches",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: `      new LocalRigorPolicyEngine().classifyRigor(task.description).rigorLevel === "high"`,
    replace: `      new LocalRigorPolicyEngine().classifyRigor(task.description).rigorLevel === "standard"`,
    testFiles: [
      "tests/core/integration/completion-gate-counterexamples.test.ts",
      "tests/core/integration/evidence-and-identifiers-production-wiring.test.ts",
      "tests/core/integration/g3-high-rigor-evidence.test.ts",
      "tests/core/integration/scope-tool-mapping.test.ts",
      "tests/core/unit/completion-protocol.test.ts",
      "tests/core/unit/evidence-verification.test.ts",
      "tests/core/unit/permission-profiles.test.ts",
      "tests/core/unit/session-control-surface.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
    ],
    expectedFailingTestNames: ["高严谨 + 开关开 + 只发完成事件（未调 factVerification）⇒ 不得 done"],
    rationale:
      "让高严谨标记恒不命中 ⇒ 本地规则形同虚设、证据包永不强制" +
      "（AGENTS.md：高严谨任务必须被本地规则标记并强制形成证据包）⇒ 该反例必须变红",
  },
];

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseJsonReport(reportPath) {
  const rawText = readFileSync(reportPath, "utf8");
  const trimmed = rawText.trim();
  // vitest --reporter=json 可能带前导日志行，取第一个 '{' 起解析。
  const startIndex = trimmed.indexOf("{");
  if (startIndex === -1) {
    throw new Error("未找到 JSON 报告内容");
  }
  return JSON.parse(trimmed.slice(startIndex));
}

function collectFailedTestNames(report) {
  const failedNames = new Set();
  for (const testResult of report.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failedNames.add(String(assertion.fullName ?? assertion.title ?? ""));
      }
    }
  }
  return failedNames;
}

function runMutation(mutation, options) {
  const targetPath = path.join(repositoryRootDirectory, mutation.targetFile);
  const originalContent = readFileSync(targetPath, "utf8");
  const originalDigest = sha256OfFile(targetPath);

  const occurrenceCount = originalContent.split(mutation.find).length - 1;
  if (occurrenceCount !== 1) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage:
        `锚点在 ${mutation.targetFile} 中命中 ${occurrenceCount} 次（要求恰好 1 次）——` +
        "说明源码已改动，请同步更新脚本里的 find 片段（不要让它静默跳过）",
      failedTestNames: [],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const mutatedContent = originalContent.replace(mutation.find, mutation.replace);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "astarray-mutation-"));
  const reportPath = path.join(temporaryDirectory, "vitest-report.json");

  let failedTestNames = new Set();
  let runError = null;
  try {
    writeFileSync(targetPath, mutatedContent, "utf8");
    try {
      execFileSync(
        process.execPath,
        [
          path.join(repositoryRootDirectory, "node_modules", "vitest", "vitest.mjs"),
          "run",
          ...mutation.testFiles,
          "--reporter=json",
          `--outputFile=${reportPath}`,
        ],
        { cwd: repositoryRootDirectory, stdio: "inherit" },
      );
      // 注入了反事实 ⇒ 期望 vitest 失败；若这里正常返回说明"用例没红"。
      runError = "vitest 在注入反事实后仍然通过（该变异存活）";
    } catch {
      // 期望路径：存在失败用例。
    }
    try {
      failedTestNames = collectFailedTestNames(parseJsonReport(reportPath));
    } catch (error) {
      if (runError === null) {
        runError = `无法解析 vitest JSON 报告：${String(error)}`;
      }
    }
  } finally {
    writeFileSync(targetPath, originalContent, "utf8");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const restoredDigest = sha256OfFile(targetPath);
  if (restoredDigest !== originalDigest) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage: `还原失败：${mutation.targetFile} 的 sha256 与注入前不一致`,
      failedTestNames: [...failedTestNames],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const missingExpectations = mutation.expectedFailingTestNames.filter(
    (expectedNameFragment) =>
      ![...failedTestNames].some((failedName) => failedName.includes(expectedNameFragment)),
  );

  /**
   * **2026-11-08（第 116 轮）修正一处"假保证"**：原判据是 `missingExpectations.length === 0`，
   * 于是 **`expectedFailingTestNames` 为空数组时**（`filter` 结果必然为空）**无条件判为"被拦下"**
   * —— 哪怕这个变异**根本没有让任何用例变红**。本轮我自己就写出过两条空列表的变异，
   * 差点把它们当成"覆盖充分"的证据。
   *
   * 现要求：**必须点名至少一条用例**，且该用例确实变红。
   * （若某个变异确实只能用"整体失败"判定，请**写明被测用例名**，不要留空。）
   */
  if (mutation.expectedFailingTestNames.length === 0) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage:
        "变异未点名任何期望失败的用例 ⇒ 无法判定被拦下（禁止空期望列表；请写明用例名）",
      failedTestNames: [...failedTestNames],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  return {
    mutationIdentifier: mutation.mutationIdentifier,
    isKilled: missingExpectations.length === 0,
    isScriptError: false,
    errorMessage: runError,
    failedTestNames: [...failedTestNames],
    expectedFailingTestNames: mutation.expectedFailingTestNames,
    missingExpectations,
    rationale: mutation.rationale,
  };
}

function main() {
  const argumentsList = process.argv.slice(2);
  const isJsonOutput = argumentsList.includes("--json");
  const onlyIndex = argumentsList.indexOf("--only");
  const onlyIdentifier = onlyIndex === -1 ? null : argumentsList[onlyIndex + 1];

  const selectedMutations =
    onlyIdentifier === null
      ? MUTATIONS
      : MUTATIONS.filter((mutation) => mutation.mutationIdentifier === onlyIdentifier);

  if (selectedMutations.length === 0) {
    process.stderr.write(`未找到匹配的变异：${String(onlyIdentifier)}\n`);
    process.exitCode = 1;
    return;
  }

  const outcomes = [];
  for (const mutation of selectedMutations) {
    if (!isJsonOutput) {
      process.stdout.write(`\n── 变异 ${mutation.mutationIdentifier} ──\n`);
      process.stdout.write(`   ${mutation.rationale}\n`);
    }
    const outcome = runMutation(mutation, { isJsonOutput });
    outcomes.push(outcome);
    if (!isJsonOutput) {
      if (outcome.isScriptError) {
        process.stdout.write(`   ❌ 脚本错误：${String(outcome.errorMessage)}\n`);
      } else if (outcome.isKilled) {
        process.stdout.write(
          `   ✅ 被拦下（${outcome.expectedFailingTestNames.length} 条点名的用例均变红）\n`,
        );
      } else {
        process.stdout.write(`   ❌ **变异存活**：以下期望变红的用例没有红\n`);
        for (const missing of outcome.missingExpectations ?? []) {
          process.stdout.write(`        - ${missing}\n`);
        }
        if (outcome.errorMessage !== null) {
          process.stdout.write(`        备注：${String(outcome.errorMessage)}\n`);
        }
      }
    }
  }

  const killedCount = outcomes.filter((outcome) => outcome.isKilled).length;
  const allKilled = killedCount === outcomes.length;

  if (isJsonOutput) {
    process.stdout.write(
      JSON.stringify({ killedCount, totalCount: outcomes.length, outcomes }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(
      `\n变异验证：${killedCount}/${outcomes.length} 被拦下` +
        (allKilled ? "（全部通过）\n" : "（存在存活变异 ⇒ 有断言是空的）\n"),
    );
  }

  process.exitCode = allKilled ? 0 : 1;
}

main();
