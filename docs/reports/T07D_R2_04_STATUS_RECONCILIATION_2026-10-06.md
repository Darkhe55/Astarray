# T07D-R2-04 状态对账（2026-10-06）

> 目的：卡内该检查点自 2026-09-10 起记为 **blocked**，理由是"用户尚未提供首个真实 Provider 的
> 凭据引用方式与费用授权"。此后已发生多次真实运行。本文把**卡内验收条款**与**现有证据**逐条比对，
> 给出可解除范围与仍需补齐项。
>
> 纪律：只登记本会话可直接确证的内容；无法确证的明确标注为"未确证"，不用说明文字覆盖门禁。

> **2026-10-06 更新（本次）**：在原对账之上补入两项查证结果——
> ① 原 §2"四次运行缺 `acceptance-verdict.json`"的**成因已查明**（§2.1 更正）；
> ② 发现并修复了验收脚本 live 路径的**"零判据通过"缺陷**（§6），并据此产出一次
> **真实的 tarball 产品路径验收**（§2 条款 1/2/5 证据已更新）。

## 1. 卡内 blocked 原因与解除条件

| 项 | 卡内原文 |
|---|---|
| blocked 原因 | 用户尚未提供首个真实 Provider 的凭据引用方式与费用授权 |
| 解除条件 | 提供 Provider/模型、受保护凭据引用与费用范围后执行受控在线小样本 |
| 验收 | 至少一个真实服务成功完成读任务和小型受控改动；若缺凭据或费用授权，本检查点 blocked，01~03 可保留通过但整卡不 done |

## 2. 验收条款逐条对账（2026-10-06 更新）

| # | 条款 | 证据 | 判定 |
|---|---|---|---|
| 1 | 至少一个真实服务成功完成**读任务** | `docs/reports/T07D_R2_04_LIVE_ACCEPTANCE_PASSED_2026-10-02.md` §「五项判据在同一次真实运行内全部通过」；`docs/reports/T07D_R2_04_LIVE_PROVIDER_EVIDENCE_2026-10-01.md`；**新增**：`.tmp/tarball-live/2026-10-06T09-53-37.334Z/acceptance-verdict.json`（tarball 隔离安装 + 真实 unisound/`u2-flash`/anthropic-messages，5/5 且 `isRealAcceptanceEvidence: true`） | **已满足**（且本次补齐了 **tarball 产品路径**证据，见 §6） |
| 2 | 至少一个真实服务成功完成**小型受控改动** | 同上：真实运行产出 `.tmp/t07d-r2-04-live/LIVE-PROOF.md`，逐行精确 + `status=done`；本次运行同时通过新增的第五项判据"无其他改动" | **已满足** |
| 3 | 记录**模型、协议、日期** | stepfun `step-3.7-flash` / OpenAI 兼容；unisound `u2-flash` / OpenAI 兼容与 Anthropic Messages；端点与运行时间见 `.tmp/tarball-live/*/tarball-record.json` 与凭据目录 `verifiedAtIso`；本次新增运行记录 `2026-10-06T09-53-37.334Z` | **已满足** |
| 4 | 记录**版本** | 各记录含 `sourceCommit`；tarball 记录含 `tarballSha256`/字节数；本次运行 `sourceCommit=1462fa5`（工作区干净）、sha256 `8533d919…7bab`、1,093,410 字节 | **已满足** |
| 5 | 记录 **usage/费用范围** | **新增**：`docs/reports/T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`（书面费用范围声明：模型调用次数**下界 ≥2**、单次真实 usage 下界 `input 110`/`output 8`、时间护栏 120s/240s 与实测 165.43 秒、货币金额明确不给出） | **已满足（书面声明；精确性受限，见 §7a）** |
| 6 | **CLI/TUI/SDK 用同一配置** | 已确证：SDK 与 CLI 同经 `runtime-selection` 选 Provider 并注册同一 `anthropic-messages` 注册项（本会话修复了 SDK 侧漏导出的缺口）；TUI 即 CLI 命令面；GUI 服务自身不选 Provider，由启动方配置注入 | **已满足（GUI 为宿主注入，非独立路径）** |
| 7 | 受控在线小样本 | 已执行多次（含 u2-flash 连续接收实测 8/8；**本次新增** tarball 隔离安装下的真实受控任务，5/5 判据通过、exit 0） | **已满足** |

### 2.1 原述"四次运行缺判据文件"——成因已查明（更正）

原文把该现象记为"无法据文件确证这四次 tarball 真实运行的判据结果"。本次查明其**成因是能力时序**，
不是失败：

| 运行目录（UTC） | 目录最后写入（本地 +0800） |
|---|---|
| `2026-10-05T09-11-19.227Z` | 2026-10-05 17:11:32 |
| `2026-10-05T09-11-40.972Z` | 2026-10-05 17:11:47 |
| `2026-10-05T09-12-27.737Z` | 2026-10-05 17:12:33 |
| `2026-10-05T12-12-41.497Z` | 2026-10-05 20:12:58 |

而写入 `acceptance-verdict.json` 的能力由提交 `bde5d9b` 引入，时间为 **2026-10-05 20:54:19（+0800）**。
四次运行**全部早于**该提交，因此在结构上不可能产出该文件。
旁证：`2026-10-05T12-45-02.537Z` 的**干跑**确实带有 `acceptance-verdict.json`，
其 `tarball-record.json` 的 `sourceStatus` 显示脚本处于"已修改未提交"状态——与"判据落盘代码当时正在开发、
20:54 才提交"完全吻合。

**结论**：缺文件 = 当时**还没有这个功能**，不是运行失败。

### 2.2 但这四次运行仍不能作为"产品路径"证据（本次新发现）

成因查明并不改变一个更关键的事实：**当时脚本的 live 路径从不执行任务**。

- 这四次记录的 `sourceStatus` **均为空**（工作区干净），`sourceCommit` 为 `2ce4472` / `4b62d67`；
  两者的脚本版本都没有 live 分支（证据：`runOnce(` 调用数恒为 3 = 1 处定义 + 2 处干跑，
  详见 §6）。
- 因此这四次运行只做了"打包 + 隔离安装"，**没有发出任何 Provider 请求**，也就没有产品路径证据。
- 受影响的是 `provider-catalog.json` 中 `verifiedAtIso` 正好等于这些运行时间的两个条目
  （`live-provider-1` → `09:11:40.972Z`、`unisound-u2-flash` → `09:12:27.737Z`）。
  **本对账不修改该文件**（用户已明确本次不动），仅将其登记为缺口（§7b）。

## 3. blocked 原因是否已消除

| 解除条件 | 现状 |
|---|---|
| 提供 Provider/模型 | ✅ 已提供（stepfun `step-3.7-flash`；unisound `u2-flash`） |
| 受保护凭据引用 | ✅ 已有 `prov-live-1`、`prov-unisound-1`（写入 `.astarray/providers/provider-credentials.json`） |
| 费用范围授权 | ✅ **已形成书面声明**（`T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`），并已在用户授权下完成一次真实运行 |

**结论**：原 `blocked` 的**直接原因（缺凭据与授权）已消除**——凭据已存在、真实调用已多次发生、
费用范围已书面化。

## 4. 对账结论与建议

**结论：本检查点已从 `in_progress` 推进到"可判定"。**

理由：
- 条款 1/2/3/4/6/7 均有证据，且本次补齐了此前缺失的 **tarball 产品路径**证据；
- 条款 5 已形成书面声明（但精确性受限，见 §7a）；
- `blocked` 的直接原因已消失。

**建议（由作者决定，本对账不修改任务卡状态）**：
- 可把卡状态由 `blocked` 推进；`T07D-R2-04` 的任务卡状态**仍标 blocked 是滞后信息**；
- 若作者要求"逐请求 usage 精确记录"作为条款 5 的完整闭环，则应先完成 §7a 的装配，再重跑一次验收；
  否则应把 §7a 作为已知限制随卡登记。

**风险提示（不得扩大声明）**：
- 本对账**不修改**任务卡状态；卡状态由作者按本文件决定。
- 本次真实运行只覆盖 **unisound / `u2-flash` / anthropic-messages / Windows / CLI 入口**，
  不得外推到其它模型、Provider、协议、平台或入口。
- 已知限制（沿用既有报告，未变化）：CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

## 5. 本对账的证据来源（更新）

- `docs/reports/T07D_R2_04_LIVE_ACCEPTANCE_PASSED_2026-10-02.md`
- `docs/reports/T07D_R2_04_LIVE_PROVIDER_EVIDENCE_2026-10-01.md`
- `docs/reports/T07D_R2_04_TARBALL_LIVE_CONFIRMATION_2026-10-02.md`（状态描述已更新）
- **`docs/reports/T07D_R2_04_USAGE_COST_RANGE_STATEMENT_2026-10-06.md`（本次新增，条款 5）**
- `.tmp/tarball-live/*/tarball-record.json`（含 4 次 `isDryRun=false` 记录）
- **`.tmp/tarball-live/2026-10-06T09-53-37.334Z/acceptance-verdict.json`（本次真实运行判据，schema v2）**
- 凭据目录 `.astarray/providers/provider-catalog.json`（`verifiedAtIso`，见 §7b）
- 本会话 u2-flash 连续接收实测（`scripts/verify-u2-flash-continuous-reception.mjs`，8/8）
- 本会话真实探针复测（`npm run verify:u2-flash-probe`）：http-status 200、`input_tokens=110`/`output_tokens=8`

## 6. 本次发现并修复的缺陷：验收脚本 live 路径"零判据通过"（2026-10-06）

**缺陷（静态可证，非推测）**：`scripts/verify-t07d-r2-04-tarball-live.mjs` 的判定段依赖 `rounds`，
而 `rounds` **只在 `if (isDryRun) { ... }` 内被填充**。该文件全部 6 个提交
（`f5b3957` → `883a385`）中 `runOnce(` 调用数恒为 3（1 处定义 + 2 处干跑），**从来没有 live 分支**。

因此真实模式下：`rounds=[]` → `checks=[]` → `failedChecks=[]` → 写出 `verdict: "passed"`，
并打印"验收通过：产物正确 + 任务 done ✓"，**而实际一次 Provider 请求都没有发出**。
若当时直接执行交接命令（在满足 TTY 的前提下），产出的将是一条**零判据的假验收记录**，
比"缺判据文件"更糟。

**修复（提交 `1462fa5`，已推送）**：
1. 真实分支**真正执行一次任务**，并与干跑复用**同一套**判定；
2. 判定逻辑移入 `scripts/lib/t07d-r2-04-acceptance-decision.mjs`，成为可测不变量；
3. **fail-closed**：零轮次必定 `failed`；卡内第五项"无其他改动"若未提供扫描结果即判失败
   （不允许"漏扫"静默变成"没有其他改动"）；
4. 非交互环境新增 `--permission-decision allow-once|deny`（此前只有 TTY 一条路，
   本会话该类环境必然 exit 2），裁决来源写入判据文件；
5. 凭据新增 `--credential-source state`（读受保护凭据文件的指定引用并注入子进程，
   密钥不打印、不落盘、不进判据文件）；
6. 判据文件升到 **schema v2**：新增 `executedRoundCount`、`isRealAcceptanceEvidence`、
   `permissionDecisionSource`、`credentialSource`、`usageObservation`。

**验证**：先红后绿（`tests/core/unit/t07d-r2-04-acceptance-decision.test.ts`，11 例：
红 = 11/11 失败于模块不存在 → 绿 = 11/11 通过）；干跑零额度复核 **7/7**；
真实运行 **5/5**、exit 0。

## 7. 未闭合缺口（登记，不伪称闭合）

**(a) Provider usage 未装配到产品运行路径** —— 本次真实运行的**逐请求 token 未落盘**。
证据：`packages/core/src/measurement/provider-usage-capture.ts` 的
`createJsonlProviderUsageCapture` 在仓库内只被 `scripts/verify-measurement-package.mjs`
与其单测引用，**未装配到产品运行路径**；本次运行的隔离状态目录内不存在 `usage/entries.json`。
影响：条款 5 只能给"范围 + 依据"，无法给该次运行的账单级精确值。
（与既有的 `InstructionWindowStore` 未装配属同一类"模块已实现但产品路径未接线"缺口。）

**(b) `provider-catalog.json` 两条目的 `supportLevel` 支撑不足** —— `live-provider-1` 与
`unisound-u2-flash` 的 `verifiedAtIso` 等于 §2.2 所述"未做任何 Provider 工作"的运行时间。
**用户已明确本次不修改该文件**，故仅登记为缺口：需重跑或降级，由作者决定。

**(c) 既有未闭合项（沿用，未变化）** —— `InstructionWindowStore` 未装配到
mission-orchestrator/main-controller；读抑制账本与 local-progress-and-cycle-guard 同样未装配；
CLI 在给出结果后进程仍会滞留（既有 `it.skip`，产品侧未修）。
