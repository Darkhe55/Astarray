# GUI-01-R：GUI 任务卡更新与产品接线

> 状态：in_progress（GUI-01-R-01~03 done；GUI-01-R-04a done；04b 仅剩真实用户人工体验结论与 Linux/macOS 证据——从安装包打开 GUI 的自动部分已补齐）
> 创建日期：2026-09-10
> 类型：后续扩展；高风险工作按检查点执行
> 来源：用户授权布置；本文件为Agent派生实施方案，运行态节点默认层级1或以下，不冒充用户层级0
> 前驱：T07D-R1；功能联测需T09A-R1、T12A-R1；交付需E2E-01

## 执行契约

必须先读取 [本批实施顺序与共同验收规则](./PRODUCT_INTEGRATION_ROLLOUT.md) 及 AGENTS.md 指定的四份治理文档。该共同文件是本卡的一部分，包含批次、测试、证据、安装、Git及停止条件。原任务卡的未满足验收要求继续有效。

## 目标与范围

作为旧 GUI-01 的增补执行卡，沿用其功能和安全验收范围，替代旧 GUI-01→T08B 的实施顺序；界面统一消费公共应用服务。

## 检查点

### GUI-01-R-01：旧卡依赖与UI范围

- 状态：done（2026-09-13；证据 docs/reports/GUI01_R_01_SCOPE_FREEZE.md；旧卡顶部已更新依赖/范围）。
- 工作：核对现有GUI文件和旧卡，冻结会话、任务图、Agent身份、权限、上下文、恢复的首期视图；读取项目适用界面技能。
- 验收：更新旧卡顶部依赖/范围，记录真实可用与占位功能；无重复核心状态机，公共事件采用revision。
- 前驱：本卡前驱。先通过前驱，再执行本节点。

### GUI-01-R-02：本地服务和基础工作流

- 状态：done（2026-09-13；证据 docs/reports/GUI01_R_02_LOCAL_SERVER_EVIDENCE.md；GUI 源码 + `astarray gui` 入口 + 23 个 GUI 用例；打包产物冒烟通过）。
- 工作：建立或接通本地GUI宿主、脱敏状态接口及事件订阅，复用核心会话/提交/取消。
- 验收：旧卡要求的loopback、Host/Origin/CSRF、SSE重连、输入清洗和退出收口均通过；按钮触发真实任务。
- 前驱：GUI-01-R-01。先通过前驱，再执行本节点。

### GUI-01-R-03：设置与恢复交互

- 状态：done（2026-09-13；03a + 03b）。
- 工作：接入预算配置/实际值、已验收/待追认、人工裁决、权限组、恢复差异及状态。
- 验收：界面修改后下一模型请求实际变化；敏感信息不进入前端；多界面状态一致而各Agent上下文隔离。
- 前驱：GUI-01-R-02。先通过前驱，再执行本节点。
- 按可构建边界拆分：
  - **GUI-01-R-03a（done，2026-09-13）**：预算配置/实际值（界面写入 → 下一真实请求按新 revision 装配）、权限组读/切换的跨界面一致、恢复差异与状态只读视图；证据 docs/reports/GUI01_R_03_SETTINGS_RECOVERY_EVIDENCE.md。
  - **GUI-01-R-03b（done，2026-09-13）**：待追认（延迟核验任务）按 Agent 隔离列表、人工裁决（签收/否决）经真实核验与上下文图存储写入；陈旧签字 409、跨 Agent 裁决 404；证据 docs/reports/GUI01_R_03B_VERIFICATION_DECISION_EVIDENCE.md。

### GUI-01-R-04：用户体验及打包

- 状态：in_progress（04a done；04b pending/blocked）。
- 工作：进行键盘、中文、缩放、可访问性、断线恢复与资源观察；从安装包打开GUI。
- 验收：真实用户完成一次提交、授权、查看差异、验收和恢复；自动截图或DOM断言不能替代人工体验结论。
- 前驱：GUI-01-R-03（done）。先通过前驱，再执行本节点。
- 按可构建/可验证边界拆分：
  - **GUI-01-R-04a（done，2026-09-13）**：自动可验证部分——页面可访问性静态契约（语言/视口/配色方案/label 关联/aria-live/按钮类型）、离线自足（无外部资源、无未净化 HTML）、关闭时资源回收（取消订阅、结束 SSE、端口重用）；人工验收清单与打包命令清单落盘。证据 docs/reports/GUI01_R_04A_UX_STATIC_EVIDENCE.md、docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md。
  - **GUI-01-R-04b（pending/blocked）**：真实用户人工体验结论（键盘/中文/缩放/可访问性/断线恢复/资源观察）、从 tarball 隔离安装打开 GUI、Linux/macOS 平台证据；前者需人工，后者与门禁同需完整访问。

## 注意事项

多人编辑和媒体工作台留给WB系列；本卡先保证操作可用和状态准确。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

- 当前提交/工作树基线：`5519193`（BRIDGE-01-03 收口）。用户并行改动（IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、agent-main-architecture.md、docs/tasks/README.md、既有未提交的 application-sdk-task-events.test.ts 及新增 steering 文档）保持未暂存。
- 本检查点实现与入口证据：docs/reports/GUI01_R_01_SCOPE_FREEZE.md（现状核对、六类首期视图冻结与真实可用/占位、revision 事件要求与当前缺口、范围外项、依赖与风险）；旧卡 docs/tasks/GUI_MVP_CODING_TASK_CARD.md 顶部依赖/范围已更新。
- 测试命令、退出码和产物哈希：本检查点为范围/依赖冻结（无产品代码变更，未跑覆盖率）；最近一次全量门禁 180 文件/1531 用例、全局 branch 86.52%、关键安全模块 22/22 ≥95%。
- 人工/外部依赖及剩余风险：浏览器自动化/驱动属待确认依赖（按协同安装门禁先询问用户，不隐式下载）；无 DOM 库前提下 GUI 测试只能做服务端 HTML/协议断言，真实浏览器验收属 GUI-01-R-04 人工项；Linux/macOS 未验证。
- 本地提交、推送尝试与结果：GUI-01-R-01 `1184c74`；`git push` 第 1 次成功（`5519193..1184c74`，`origin/main`）。
- GUI-01-R-02 实现与入口证据：docs/reports/GUI01_R_02_LOCAL_SERVER_EVIDENCE.md（loopback/Host/Origin/CSRF/清洗/SSE 首帧与重连/监听失败/退出收口的红→绿反例；公共门面真实提交到 `done`；`astarray gui [--port <n>] [--no-open]`；打包 CLI 冒烟 URL/状态/端口释放）。
- GUI-01-R-02 测试命令、退出码和产物哈希：`npx tsc --noEmit` 0；`npx eslint .` 0；`npx vitest run tests/gui` 0（23 passed）；`npm run check` 构建通过、1553/1554 用例通过（唯一失败为既有计时波动 `provider-runtime-registry`，隔离复跑 6/6 通过）；`npm run test:coverage` 0（184 文件/1554 用例全通过，statements 93.52% / branch 86.44% / functions 91.68% / lines 93.55%）。受限沙箱下 tsup/forks 池会 `spawn EPERM`，门禁在获准完整访问下执行。
- GUI-01-R-02 人工/外部依赖及剩余风险：真实浏览器人工体验（键盘/中文/缩放/可访问性）留给 GUI-01-R-04，本检查点不做结论；SSE 客户端退避使用浏览器原生重连（约 3s，落在 1–30s 区间）+ 服务端首帧快照，端到端体验校验留给 -04；Linux/macOS 未验证。
- GUI-01-R-02 本地提交、推送尝试与结果：实现提交 `b5e3be1`（11 文件；用户并行改动未暂存）。`git push` 4 次：第 1 次受限沙箱失败（`couldn't create signal pipe, Win32 error 5`，exit 128）；第 2–4 次升级重试均因审批通道 600s 超时未执行 → 本轮跳过上传，累积到下一阶段一并再试。
- GUI-01-R-03a 实现与入口证据：docs/reports/GUI01_R_03_SETTINGS_RECOVERY_EVIDENCE.md（预算写入→下一真实装配按新 revision、过期 revision 409、权限组跨界面一致、恢复只读视图与字段过滤、能力缺失 501 的红→绿反例）。
- GUI-01-R-03a 测试命令、退出码：`npx tsc --noEmit` 0；`npx eslint .` 0；`npx vitest run tests/gui` 0（28 passed）；关联回归 20 passed（public-sdk/application-sdk-*/cli-sdk-parity/context-*）。
- GUI-01-R-03a 门禁缺口（已补齐，2026-09-13）：`npm run check` exit 0（187 文件/1566 用例）；`npm run test:coverage` exit 0（statements 93.61% / branch 86.40% / functions 91.98% / lines 93.64%）；`verify:security-coverage` 22/22；`npm pack`+`verify-package`（207 文件）+`smoke-install` exit 0（tarball sha256 `e709427a…7e7f7e`）。首跑覆盖率仅两个已知超时波动用例失败，复跑即绿。
- GUI-01-R-03a 本地提交、推送尝试与结果：实现提交 `12e80eb`（6 文件）；`git push` 于 2026-09-13 成功（`0946530..28705b2`，含 `b5e3be1`、`2dd9fdd`、`12e80eb`）。
- GUI-01-R-03a 人工/外部依赖及剩余风险：已验收/待追认与人工裁决属 03b（已完成）；真实浏览器人工体验属 04；Linux/macOS 未验证。
- GUI-01-R-03b 实现与入口证据：docs/reports/GUI01_R_03B_VERIFICATION_DECISION_EVIDENCE.md（真实 Devolve 链路生成延迟核验任务 → GUI 列表/追认落盘/否决重开节点；跨 Agent 404 与陈旧签字 409 反例）。
- GUI-01-R-03b 测试命令与退出码：`npx tsc --noEmit` 0；`npx eslint .` 0；`npx vitest run tests/gui` 0（32 passed）；关联回归 27 passed。
- GUI-01-R-03b 门禁缺口（已补齐，2026-09-13）：同 03a，`npm run check`/`npm run test:coverage`/`verify:security-coverage` 与打包三项均 exit 0。
- GUI-01-R-03b 本地提交、推送尝试与结果：实现提交 `4ed4c14`（6 文件）；已随 `0946530..28705b2` 推送。
- GUI-01-R-04a 实现与入口证据：docs/reports/GUI01_R_04A_UX_STATIC_EVIDENCE.md（3 个新用例：可访问性静态契约、离线自足、关闭时资源回收）；人工验收步骤与打包命令清单见 docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md（未执行）。
- GUI-01-R-04a 测试命令与退出码：`npx tsc --noEmit` 0；`npx eslint .` 0；`npx vitest run tests/gui` 0（35 passed，7 文件）。
- GUI-01-R-04a 门禁缺口（已补齐，2026-09-13）：`npm run check`/`npm run test:coverage`/`verify:security-coverage` 与打包验收（`npm pack`、`verify-package` 207 文件、`smoke-install`）全部 exit 0；另从隔离安装包启动 GUI 冒烟通过（`GET /` 200、`/state` 脱敏、终止后端口释放）。04b 的人类体验与平台证据仍未做。
- GUI-01-R-04a 人工/外部依赖及剩余风险：真实用户人工体验结论、从安装包打开 GUI、Linux/macOS 平台证据属 04b，当前为 pending/blocked，不以自动断言替代。
- GUI-01-R-04a 本地提交、推送尝试与结果：实现提交 `b35cc9f`（4 文件）；已随 `0946530..28705b2` 推送。
- GUI-01-R-04b 打包自动部分重跑（2026-09-19）：在 LINUX-PORT-01 提交 `04ddce7` 上 `npm pack`（prepack 全量门禁 228 文件/1854 用例）/`verify-package.mjs`（215 文件）/`smoke-install.mjs` 全部 exit 0；新 tarball sha256 `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f`、mtime `2026-09-19T23:18:48Z`。此前 Linux 侧校验沿用的 2026-09-15 旧产物（207/209 文件）已过期，不得再作证据。证据 docs/reports/GUI01_R_04B_WINDOWS_PACKAGING_EVIDENCE_2026-09-19.md。
- T11 CLI 计时脆弱修复（2026-09-19）：`tests/tui/unit/cli-commands.test.ts` 内 5 处单测级 `20_000` 超时与其文件级 `testTimeout: 60_000` 声明自相矛盾，重负载下 `run：mock 运行时…` 用例 20s 超时导致 `npm pack` prepack 失败；统一为 `60_000`（断言不变），隔离复跑 22/22 通过（8.86s）。
- GUI-01-R-04b 从隔离安装包启动 GUI 自动冒烟（2026-09-19）：在返修提交、新 tarball（sha256 `a45ae4da…d1f`、215 文件）的隔离安装目录内 `node dist/cli.js gui --port 0 --no-open` → `GET /` 200（12415 字节、含 DOCTYPE）、`GET /state` 200 且脱敏（无绝对路径/仓库路径/密钥字样）、终止后端口释放、无孤儿 node；该冒烟在 workspace-write 下即可完成（状态目录落在安装目录内，不触发受限沙箱限制）。证据 docs/reports/GUI01_R_04B_TARBALL_GUI_SMOKE_EVIDENCE_2026-09-19.md。
- GUI-01-R-04b 安装产物级提交与 SSE 契约校验（2026-09-19）：新增 `scripts/verify-gui-sse-reconnect.mjs`，对隔离安装产物执行 20 项断言全部通过（另含：取消后 /state 与重连快照均收敛为 cancelled；上下文预算写入 revision 递增且重新读取一致，陈旧 revision 409、非法参数 400、无 CSRF 403、被拒写入不改变已持久化值）——`GET /` 下发 HttpOnly+SameSite=Strict 的 CSRF cookie；无 token 的 `POST /commands/submit` 返回 `403 csrf-required`；带 token 两次提交返回 `202` 受理回执；`GET /state` 反映 `tasks=2/missions=2`；`GET /events` 首帧为完整快照（`isReconnect=false`）、带 `last-event-id` 重连首帧仍为完整快照（`isReconnect=true`）且任务/任务链标识不重复；终止后端口释放。证据 docs/reports/GUI01_R_04B_TARBALL_GUI_SSE_EVIDENCE_2026-09-19.md。
- GUI-01-R-04b 权限组切换校验与缺陷发现（2026-09-19）：同一脚本扩到 27 项——内置组切换成功且重读一致、非法内置组 400、无 CSRF 403、校验后恢复原状；**发现缺陷**：`POST /commands/switch-permission-profile` 接受不存在的自定义权限组并返回 200（持久化悬空引用，解析侧 fail-closed 但报错码误用 `task-sequence-not-found`），已记录反例与待授权修复方案 docs/reports/GUI01_R_04B_DANGLING_PROFILE_SELECTION_FINDING_2026-09-19.md。
- GUI-01-R-04b 人工/外部依赖及剩余风险：真实用户人工体验结论（键盘/中文/缩放/可访问性/断线恢复/资源观察）与 Linux/macOS 平台证据仍未做；本卡保持 in_progress，平台表待 Linux 同提交实测后再更新。

## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮执行 GUI-01-R-04b（人工体验与 tarball 实跑）并补跑累积门禁/推送；人工体验结论缺失时保持 pending/blocked，不用说明文字覆盖未满足门禁。

