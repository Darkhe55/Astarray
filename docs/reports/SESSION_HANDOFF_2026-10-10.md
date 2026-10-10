# 会话交接（2026-10-10）— 主线：E2E-01-04 收口 + CLI 可靠性

> 读者：**接手的下一个会话/实施者**。请与 `PLAN_STATUS.md` 顶部「2026-10-10 当前有效状态」表
> 及其中「E2E-01-04 证据链」小节**一起读**；本文件只补"从哪起步、怎么起步、别踩什么"。

## 1. 交接时的状态（基线）

| 项 | 值 |
| --- | --- |
| 分支/远端 | `main`，`HEAD == origin/main == 64f217f`（接手时请再确认一次） |
| 工作区 | **干净**（无未提交、无未跟踪文件） |
| 目标（goal） | **`paused`**；模型无权 resume，需**用户本人**恢复后才自动连轮 |
| 最近门禁 | `npm run check` **exit 0**（307 文件 / 2347 用例、1 skipped）；`npm run test:coverage` **exit 0**，分支 **85.05%** |

## 2. 已完成的（本条线，均有实测证据）

1. **E2E-01-04 本地可证项全部 exit 0**：`check`、`test:coverage`（分支 83.29%→**85.05%**，净增约 166 条）、
   安全关键模块 22/22、fixture 指纹一致、`npm pack`+`verify-package`（239 文件）、**`smoke-install` exit 0**。
   逐项证据见 `PLAN_STATUS.md`「E2E-01-04 证据链」表（每行都指向 `.tmp/session-r2-04/` 下的日志）。
2. **三个真实根因被定位并修掉**（都不是"玄学抖动"）：
   - Windows `rename` 瞬时锁 EPERM（重试预算仅 150ms）→ 有界指数退避 `e664e4b`；
   - 测试文件的**类型缺陷**（自造 `Record<string, unknown>` 形参，vitest 不做类型检查故全绿、
     `tsc` 报 TS2345/TS2322）→ 从端口签名派生 `e890214`；
   - `smoke-install.mjs` 解析 `npm pack --json` 过脆 → 从后往前逐候选起点解析 `c24a26c`。
3. **CLI 滞留缺陷修复**：provider + 权限询问路径下 CLI 打印结果后不退出（实测 >60s，只能外部 kill）。
   收敛放在**引导层** `packages/tui/src/cli.tsx`（`await program.parseAsync(...)` 之后）；
   `cli-exit-linger` ② 由 `it.skip` 改回 `it` 并**转绿**（36.2s 自然退出）→ skipped 数 **2 → 1**（`4334deb`）。
4. **性能/覆盖率冲刺的方法与工具**（可复用）：`scripts/report-uncovered-branches.mjs`（行级定位 + L0/可定位拆分）、
   `docs/reports/E2E01_04_BRANCH_COVERAGE_GAP_PLAN_2026-10-09.md`（作战图）。

## 3. 未完成的（按优先级）

### ① 最后一个 `it.skip`：`cli-anthropic-protocol.test.ts` ①（**首选**）

- 现状（本日复核）：**仍红** —— `npx vitest run tests/tui/integration/cli-anthropic-protocol.test.ts` → **exit 1**，
  `AssertionError: expected 'blocked' to be 'done'`，约 31s。
- 已排除（**别再查这些**）：协议层（请求确实走 Anthropic 运行时、顶层 `system`、`input_schema`、
  `assistant.tool_use` + `user.tool_result` 回填）；`bootstrap.ts` 的 TTY-only `isInteractive` 口径
  （`run-command.ts:268` 实际用的是 `decisionPort.isInteractive()`，端口内部已 OR 输入通道）；
  行读取器 `createStdinLineReader()` 的健壮性（实现稳，跨 chunk 半行缓存 + end flush + 队列配对）。
- 收敛后的判断：`run-command.ts:240-276` 的裁决循环里 **`if (decision !== "allowed-once") break;`** ——
  只要 `decisionPort.readDecision()` 返回 `null`/`deny`，就**只走 1 轮**并停在 `blocked`，
  与实测"无 grant 痕迹、只走 1 轮"吻合。
- **接手第一步（唯一实验，一次只验一个假设）**：在 `createStdinLineReader()` 创建处与每次 `data`/`end`
  打**临时 stderr 痕迹**（`[STDIN-TRACE] created` / `data len=…` / `end`）→ `npm run build` →
  单跑该用例一次 → 依据 31s 的退出码与痕迹二分：
  - **从未出现 `data`** ⇒ stdin 被别处读走或本路径未创建读取器。候选消费者：
    `install-decision-port.ts` L39-44（`process.stdin.once("data")`）、
    `commands.ts` L2080-2113（凭据负载读取）、反馈子进程的 stdin 处理；
  - **出现 `data` 但 `readDecision` 返回 `null`/`deny`** ⇒ 时序或判定问题（`isEnded`/trim 比较）。
  - 痕迹**只用于定位**：验证完立即移除，**不得留进提交**。

### ② 超时型抖动（独立于已修的三层根因）

- `tests/tui/unit/run-command-gaps.test.ts` 曾在默认并发下 `Test timed out in 60000ms`（隔离复跑 5.4s 通过）。
- 下一步：评估其超时预算是否合理（**不要用无依据地放大超时来掩盖竞态**），或定位真实竞态。

### ③ 只能由用户/平台提供（不得用文字覆盖）

- **人工体验结论**、**Linux/macOS 平台证据** → 因此 `E2E-01-04` 与整体 `E2E-01` **保持 `in_progress`**。
- 这两项齐了才可能转 `done`；卡内明文"未决必选项不得done"。

## 4. 工作纪律（用户明确要求，务必遵守）

1. **一次只领一个检查点**；先写**行为反例（红）**再实现（绿）；完成后**单独提交并推送**。
2. **只暂存本检查点文件，绝不 `git add -A`**（本会话确有用户并行编辑，`-A` 会卷入他人未完成改动）。
3. **每次报告真实退出码**；判断成功看输出里的关键证据（如 `http-status: 200`），不要只看退出码
   （Windows 下探测脚本 `process.exit(0)` 可能表现为 `$LASTEXITCODE=-1073740791`）。
4. **绝不打印密钥、绝不把密钥写进任何文档或提交**；提交前抽查 diff（本会话用"词内子串"法确认过
   `sk-` 命中全是 `task-sequences` 之类普通词）。凭据在 `.astarray/providers/provider-credentials.json`（已 gitignore）。
5. 共享文件（如 `PLAN_STATUS.md`）若正被用户编辑：**不要覆盖**，改出
   `docs/reports/STATUS_UPDATE_<任务ID>_<日期>.md` 并注明待合并（`AGENTS.md` 并行冲突规则）。
   现已获授权：检查点可同步更新任务卡与 `PLAN_STATUS.md` 当前有效表。
6. **改 `src` 后必须 `npm run build` 再跑由 `dist/` 驱动的测试/harness**——本会话两次因此误判
   （先得"检查点数=0"的假阴性；后又以为 CLI 修复无效）。
7. **测量陷阱**：做前后对照时，基线筛选若用模糊匹配（如 `*doctor*`）会把**新写的测试文件**也算进
   baseline，导致恒为 `+0`；必须显式排除新文件。
8. **未覆盖行号只是候选定位**：必须先确认该行属于**哪个导出函数**（同一文件内不同导出可能用不同 helper），
   读该行实现后再写用例——本会话有 3 次因跳过这步而白补一轮。

## 5. 常用命令与环境（本机）

```powershell
npm run check                 # typecheck + lint + build + test（提交前必跑）
npm run test:coverage         # 仓库阈值配置（分支 85）——现已 exit 0
npm run test:scripts          # scripts/lib 自测（注意：不在 check 门禁内）
npm run lint / typecheck
npm run build                 # 改 src 后必须重建，供 dist 驱动的测试使用
npm pack                      # 触发 prepack→check
node scripts/smoke-install.mjs
```

- 覆盖率行级定位需**临时配置**（仓库配置的 reporter 不含 `json`，CLI 覆盖不生效）：
  见 `.tmp/session-r2-04/vitest.covjson.config.ts` 的做法（`.tmp/` 不入库）。
- 本会话运行在**完全访问**权限下（早期受限沙箱会让 vitest/esbuild/npm/git push 报 `spawn EPERM`）。
- `git push` 偶发 `Connection reset ... port 22`（GitHub SSH）：**单阶段最多重试 5 次**，
  失败则记录原因、下一阶段累积再推。
- 远端真实验收脚本（E2E-01-03）与判定文件：`docs/reports/evidence/E2E01_03_VERDICTS_2026-10-09/`
  （含 MANIFEST 与 sha256；密钥泄漏检查已做）。

## 6. 接手提示词（可直接粘贴给新会话）

> 接手 astarray 仓库工作。先读 `docs/reports/SESSION_HANDOFF_2026-10-10.md`、
> `PLAN_STATUS.md` 顶部「2026-10-10 当前有效状态」及其「E2E-01-04 证据链」小节。
> 然后按交接文档 §3① 的唯一实验（STDIN-TRACE）起步，一次只验一个假设。
> 纪律：一次只领一个检查点；先写行为反例再实现；跑 `npm run check`（覆盖率改动跑 `test:coverage`）；
> 只暂存本检查点文件、绝不 `git add -A`；每次报告真实退出码；不打印/写入密钥；
> 改 `src` 后先 `npm run build` 再跑由 `dist/` 驱动的测试。
