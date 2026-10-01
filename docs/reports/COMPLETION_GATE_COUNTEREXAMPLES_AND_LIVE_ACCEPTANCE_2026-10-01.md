# 完成门禁离线反例 + 卡死解释 + 单次真实验收脚本（2026-10-01）

> 用户指令（2026-10-01）：**维持 T07D-R2-04 未完成**；先补「管道 EOF/第二次裁决、工具选错、未解决失败」
> 三类离线反例并解释卡死；第三条语义改为「**未解决的必需操作失败或验收缺失不得结案**」，
> **不禁止**失败后已解决时的正常完成；离线通过后提交固定版本与单次真实验收脚本、额度需求，
> 由用户确认后用 **TTY** 复跑；必须**同一次运行**同时证明产物正确与任务 `done`。

## 1. 卡死原因（已定位并修复，`fe9684c`）

| 现象 | 根因 |
| --- | --- |
| `node dist/cli.js run …` 在第二次权限询问处**永久挂起**（实测 16 分钟，被迫人工终止，单次真实额度被浪费） | `InteractivePermissionAskDecisionPort.readLine()` 读取 stdin **没有任何上限**：管道 `echo allow-once` 只有一行，第二次询问时管道已 EOF，Promise 永不结算 → 进程既不前进也不退出 |

修复与证据：

- 有界等待（默认 `120_000ms`，可注入 `readTimeoutMilliseconds`），超时 fail-closed 返回 `null`；
- 调用方（`runPermissionAskAdjudication`）在 `null` 时**不授权、不 unblock**，如实输出
  「未在等待上限内收到裁决输入…保持等待人工裁决」并返回 `requires-human-resubmission`；
- 反例：`tests/tui/integration/permission-ask-timeout.test.ts` —— 含"管道 EOF / 第二次裁决"用例：
  首轮读到 `allow-once`，次轮无输入 → 60ms 内返回 `null`，**不挂起**（5/5 通过）。

## 2. 三类离线反例（全部通过）

文件：`tests/core/integration/completion-gate-counterexamples.test.ts`（7 用例）+ 上述超时套件（5 用例）。

| 反例 | 断言 |
| --- | --- |
| **A0 授权确实生效** | 授权后写工具**真的执行**并以失败结案（判词落档），且**没有**出现「需要权限调用」升级 |
| **A. 工具选错** | `writeFileTemporary` 参数含目录分隔符（该工具只接受相对文件名）→ 失败；模型仍输出完成事件 → 终态**非 `done`**、产物**不存在**、判词「writeFileTemporary 未成功（不得以文本声明结案）」落档 |
| **B. 未解决的写失败** | `createProjectFile` 因目标已存在失败后声称完成 → 终态**非 `done`**、判词「createProjectFile 未成功」落档 |
| **C1 验收缺失** | `LocalCompletionVerifier`：声明了验收门禁但 `passed=false` → 拒绝，原因含该门禁名 |
| **C2 组合拒绝** | 未决工作项 + 验收缺失 + 未解决失败 → **一次性**给出全部拒绝原因 |
| **C3 正常完成不被误拦** | 全部条件满足（验收通过）→ `{ accepted: true }` |
| **C4 失败已解决** | 无未决项、验收通过、无未解决阻塞（即失败已被后续成功覆盖）→ **必须接受**（对应你的第三条语义） |

### 2.1 顺带查清的一条真实链路行为（写进交接）

反例 B 的实测过程暴露：**写工具失败后，worker 不会再给模型第二轮修正机会**，
直接以「完成声明与本地工具结果不一致」结案并升级（实测该 mission 只有 **1 次**模型调用）。
即"失败→同轮重试成功"在真实链路上**走不到**；这与"未解决失败不得结案"并不矛盾，
但意味着：**模型一旦选错工具/参数，本轮即终止**，需要重新派发才能修正。
已记录为候选（是否允许写失败后一次有界重试），本检查点不改变该行为。

## 3. 语义澄清（按用户措辞落地）

- **拦**：未解决的必需操作失败、验收门禁未通过/缺失、未决工作项、未解决 blocked/failed/取消 → 不得结案；
- **不拦**：失败已被解决（未决计数为 0、验收通过、无未解决阻塞）→ **必须允许正常 `done`**（C3/C4 固化）。

## 4. 单次真实验收脚本（已就绪，等待用户确认额度）

脚本：`scripts/verify-t07d-r2-04-live-write.mjs`（`npm run verify:t07d-r2-04-live`）。

| 特性 | 说明 |
| --- | --- |
| 显式授权 | 无 `--allow-live-request` 直接 **exit 2**，不发起任何请求 |
| **必须 TTY** | stdin 非 TTY（管道）直接 **exit 2** —— 避免"管道只能喂一次裁决"的误判（上一轮真实失败即此因） |
| 单次运行 | 一次任务；不做重试，不重复消耗额度 |
| 同一次运行双判据 | ① `status=done`；② 产物 `.tmp/t07d-r2-04-live/LIVE-PROOF.md` 存在且 sha256 与期望一致；③ `permissionAsk=allowed-once`；④ 仓库其他文件未被改动。**任一不满足即失败** |
| 隔离产物 | 只写 `.tmp/t07d-r2-04-live/`（gitignore 覆盖），不触碰仓库其他文件 |

调用方式（**由用户在本机交互终端执行**，脚本会转发权限询问，用户键入 `allow-once`）：

```powershell
npm run verify:t07d-r2-04-live -- --reference prov-live-1 --model step-3.7-flash `
  --provider-request-timeout-seconds 120 --allow-live-request
```

## 5. 额度需求（需用户确认）

| 项 | 值 |
| --- | --- |
| 真实请求预算 | **建议 3 次**（单次运行通常 2–4 次模型调用：工具调用 + 工具后完成事件；预留 1 次余量） |
| 若第一次未通过 | 需用户再次确认后才能再跑（脚本本身不重试） |
| 当前状态 | 新 3 次额度已用完；**T07D-R2-04 维持未完成** |

## 6. 门禁

- `npm run check` exit 0 —— 全量 **249 文件 / 1938 用例**；
- 覆盖率 **92.91 / 85.32 / 93.11 / 92.93**（阈值 85）；
- `permission-ask-timeout.test.ts` 5/5；`completion-gate-counterexamples.test.ts` 7/7。
