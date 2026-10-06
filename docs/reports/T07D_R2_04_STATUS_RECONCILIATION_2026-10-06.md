# T07D-R2-04 状态对账（2026-10-06）

> 目的：卡内该检查点自 2026-09-10 起记为 **blocked**，理由是"用户尚未提供首个真实 Provider 的
> 凭据引用方式与费用授权"。此后已发生多次真实运行。本文把**卡内验收条款**与**现有证据**逐条比对，
> 给出可解除范围与仍需补齐项。
>
> 纪律：只登记本会话可直接确证的内容；无法确证的明确标注为"未确证"，不用说明文字覆盖门禁。

## 1. 卡内 blocked 原因与解除条件

| 项 | 卡内原文 |
|---|---|
| blocked 原因 | 用户尚未提供首个真实 Provider 的凭据引用方式与费用授权 |
| 解除条件 | 提供 Provider/模型、受保护凭据引用与费用范围后执行受控在线小样本 |
| 验收 | 至少一个真实服务成功完成读任务和小型受控改动；若缺凭据或费用授权，本检查点 blocked，01~03 可保留通过但整卡不 done |

## 2. 验收条款逐条对账

| # | 条款 | 证据 | 判定 |
|---|---|---|---|
| 1 | 至少一个真实服务成功完成**读任务** | `docs/reports/T07D_R2_04_LIVE_ACCEPTANCE_PASSED_2026-10-02.md` §「五项判据在同一次真实运行内全部通过」；`docs/reports/T07D_R2_04_LIVE_PROVIDER_EVIDENCE_2026-10-01.md` | **已满足** |
| 2 | 至少一个真实服务成功完成**小型受控改动** | 同上：真实运行产出 `.tmp/t07d-r2-04-live/LIVE-PROOF.md`，逐行精确 + `status=done`（同一次运行五项判据全过） | **已满足** |
| 3 | 记录**模型、协议、日期** | stepfun `step-3.7-flash` / OpenAI 兼容；unisound `u2-flash` / OpenAI 兼容与 Anthropic Messages；端点与运行时间见 `.tmp/tarball-live/*/tarball-record.json` 与凭据目录 `verifiedAtIso` | **已满足** |
| 4 | 记录**版本** | 各记录含 `sourceCommit`；tarball 记录含 `tarballSha256`/字节数 | **已满足** |
| 5 | 记录 **usage/费用范围** | 本会话内仅记到单次调用级 usage（探针：`input_tokens=110 / output_tokens=16`）；**未形成"费用范围"声明** | **未满足** |
| 6 | **CLI/TUI/SDK 用同一配置** | 已确证：SDK 与 CLI 同经 `runtime-selection` 选 Provider 并注册同一 `anthropic-messages` 注册项（本会话修复了 SDK 侧漏导出的缺口）；TUI 即 CLI 命令面；GUI 服务自身不选 Provider，由启动方配置注入 | **已满足（GUI 为宿主注入，非独立路径）** |
| 7 | 受控在线小样本 | 已执行多次（含本次 u2-flash 连续接收实测 8/8） | **已满足** |

**未确证项（不得据此宣称通过）**：

- `.tmp/tarball-live/2026-10-05T09-11-19.227Z`、`09-11-40.972Z`、`09-12-27.737Z`、
  `12-12-41.497Z` 四次记录的 `isDryRun=false`（即真实联网运行），但**这四个运行目录内没有
  `acceptance-verdict.json`**（仅剩 `install/`、tarball、`tarball-record.json`）。
  因此本会话**无法据文件确证这四次 tarball 真实运行的判据结果**。
- 与之相对，`T07D_R2_04_TARBALL_LIVE_CONFIRMATION_2026-10-02.md` 自述状态为
  "**脚本已就绪，干跑通过；真实运行尚未执行**"——该报告早于上述四次记录，
  故报告与记录之间存在**时间线落差**，应以实际记录为准并由作者更新报告。

## 3. blocked 原因是否已消除

| 解除条件 | 现状 |
|---|---|
| 提供 Provider/模型 | ✅ 已提供（stepfun `step-3.7-flash`；unisound `u2-flash`） |
| 受保护凭据引用 | ✅ 已有 `prov-live-1`、`prov-unisound-1`（写入 `.astarray/providers/provider-credentials.json`） |
| 费用范围授权 | ⚠️ 用户在会话中**口头授权过**并实际执行了多次真实调用；但**未形成书面"费用范围"记录** |

**结论**：原 `blocked` 的**直接原因（缺凭据与授权）已消除**——凭据已存在、真实调用已多次发生。
但"费用范围"未形成记录，属条款 5 的缺口。

## 4. 对账结论与建议

**建议：把状态从 `blocked` 改为 `in_progress`，并明确剩余两项缺口。**

理由：
- 支持情形：条款 1/2/3/4/6/7 均有证据；blocked 的直接原因已消失；
- 不支持直接置 `done` 的情形：
  1. 条款 5「usage/费用范围」未形成声明（仅有单次调用级 usage）；
  2. 上述四次 tarball 真实运行**缺少判据文件**，无法确证
     （若作者能补出判据或重跑，此缺口即可关闭）；
  3. `T07D_R2_04_TARBALL_LIVE_CONFIRMATION_2026-10-02.md` 的状态描述与记录不符，需作者更新。

**风险提示（不得扩大声明）**：
- 本对账**不修改**任务卡状态；卡状态由作者按本文件决定。
- 真实 Provider 凭据当前**已由用户作废**，因此短期内无法补跑上述 tarball 真实运行；
  恢复需用户提供新的凭据切换方式（方式见 `PLAN_STATUS.md` 对应小节）。
- 已知限制（沿用既有报告，未变化）：CLI 在给出结果后进程仍会滞留（脚本已规避，产品侧未修）。

## 5. 本对账的证据来源

- `docs/reports/T07D_R2_04_LIVE_ACCEPTANCE_PASSED_2026-10-02.md`
- `docs/reports/T07D_R2_04_LIVE_PROVIDER_EVIDENCE_2026-10-01.md`
- `docs/reports/T07D_R2_04_TARBALL_LIVE_CONFIRMATION_2026-10-02.md`
- `.tmp/tarball-live/*/tarball-record.json`（含 4 次 `isDryRun=false` 记录）
- 凭据目录 `.astarray/providers/provider-catalog.json`（`verifiedAtIso` 与上述运行时间对应）
- 本会话 u2-flash 连续接收实测（`scripts/verify-u2-flash-continuous-reception.mjs`，8/8）
