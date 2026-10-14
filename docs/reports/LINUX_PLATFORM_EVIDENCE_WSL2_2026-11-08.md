# Linux 平台证据（WSL2 / Ubuntu 26.04 LTS）— 2026-11-08

- **来源提交**：`5f08ef0c73a7b4ea40afee0560594ac4007ee0ca`（`5f08ef0`）
- **取得方式**：**用户在 2026-11-08 指示「Linux 部分使用 WSL 做，macOS 部分先跳过、保留记录以后再补」**
  ⇒ 本文件即该指示下的 **Linux 侧真实平台证据**；**macOS 侧仍为未取得**（见文末"仍未取得"）。
- **报告性质**：**平台证据**，不是新的检查点。目的是把 `RELIABILITY-01-03`／`B6R-10`／
  `BRIDGE-01` 等卡中长期记为"**只能由平台提供**"的 Linux 侧证据**补上真实记录**。

---

## 1. 环境（可复核）

| 项 | 值 |
| --- | --- |
| 发行版 | `Ubuntu 26.04 LTS`（`PRETTY_NAME`） |
| 内核 | `6.18.33.2-microsoft-standard-WSL2` |
| 架构 | `x86_64` |
| 运行时 | **Node `v22.22.1`** ／ npm `9.2.0` |
| 平台 | **WSL2**（Windows Subsystem for Linux, 版本 2） |

**方法（可复现，且不污染 Windows 仓库）**：

1. 在 WSL 内**原生文件系统**（`$HOME/astarray-linux-evidence`）从 Windows 仓库 `git clone` 一份**独立检出**；
2. **不复用** Windows 的 `node_modules` —— 实测其包含 **`@esbuild/win32-x64`** 等平台二进制，
   在 Linux 上不可用；改用 `npm ci`（**按 lockfile 可复现安装**）；
3. `npm run build`（**测试由 `dist/` 驱动，必须先构建**）；
4. 依次跑 `typecheck`／`lint`／`test`／`test:coverage`，**完整日志原样落盘**（不筛选）。

---

## 2. 门禁结果（真实退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm ci` | **0** | added 231 packages |
| `npm run build` | **0** | Build success |
| `npm run typecheck` | **0** | `tsc --noEmit` 无输出 |
| `npm run lint` | **0** | `eslint .` 无输出 |
| `npm run test` | **0** | **422 文件通过；3177 passed ＋ 2 skipped（共 3179）** |
| `npm run test:coverage` | **0** | 语句 **92.59**／**分支 85.23**／函数 **93.22**／行 **92.61**（阈值 85 全部通过） |

> 覆盖率 4 项阈值均 ≥85；日志中**无** `Thresholds`/`does not meet` 这类未达标输出。

---

## 3. 与 Windows 的**差异**（如实列出，不掩饰）

Windows 侧最近一次全量为 **3179 passed / 0 skipped**；Linux 为 **3177 passed / 2 skipped**。
**差 2 条不是失败，是条件跳过**，已定位到确切位置：

- **跳过者**：`tests/tui/integration/smart01-04-live-u2-flash-verdict.test.ts`（`6 tests | 2 skipped`）
- **守卫条件**：`describe.skipIf(!hasLiveVerdict)`，而
  `hasLiveVerdict = existsSync(verdictPath)`，`verdictPath` 指向仓库 `.tmp/` 下的
  **真实运行判据产物**（由真实 Provider 运行生成）。
- **原因**：Linux 检出是**全新 clone**，仓库 `.tmp/` 下的该产物**不在版本控制内** ⇒ 自然不存在
  ⇒ 该 `describe` 被条件跳过；Windows 工作区里存在该产物 ⇒ 那 2 条会真的跑。
- **为什么这是合理的**：这 2 条本就要求"**有真实运行产物时才核对**"，无产物即无判定对象，
  跳过是设计意图；**其余 4 条**（脚本存在性/契约等"可移植"断言）在 Linux 上**照常执行并通过**。

**其余三处 `skipIf` 守卫在 Linux 上均未跳过**（说明构建产物齐备）：

| 文件 | Linux 结果 | 守卫 |
| --- | --- | --- |
| `tests/core/integration/feedback-process.test.ts` | **11 tests 通过** | `hasBuiltEntry` |
| `tests/core/unit/feedback-supervisor.test.ts` | **7 tests 通过** | `hasBuiltEntry` |
| `tests/tui/integration/headless-cli.test.ts` | **11 tests 通过** | `hasBuiltCli` |
| `tests/tui/integration/recovery-process-handoff.test.ts` | **2 tests 通过** | `hasBuiltCli` |

> 注：我最初用一个**猜的文件名**（`dist/feedback-process.js`）去探，结果"不存在"，
> 容易误判为"该组被跳过"。核对源码后确认 `hasBuiltEntry` 实际判定的是
> **`dist/feedback-process-entry.js`**（`path.join(process.cwd(), "dist", "feedback-process-entry.js")`），
> 该产物**存在** ⇒ 两组才会真的执行。此处按**源码事实**更正，避免把探测脚本的猜测当作结论。

---

## 4. 对具体卡片的证据价值

### 4.1 `RELIABILITY-01-03`：**POSIX 进程树收口**（本卡长期的跨平台风险项）

Linux 上**实跑通过** `tests/core/integration/reliability-git-process-tree.test.ts`
（**2 tests 通过**，本文件在被测环境下耗时 **11458ms**）：

```
✓ ⓪ 夹具活性：孙进程确实启动并在写心跳（否则本文件无判定力）   8239ms
✓ ① 超时后孙进程必须被收口（心跳停止增长）                     3216ms
```

⇒ 卡内记为"**POSIX 进程树收口仍为已知跨平台风险项**"的这一项，在 **Linux 上取得真实证据**：
超时后孙进程**确实被收口**（心跳停止增长）。

**并且本文件在 Linux 上不再泄漏临时目录**：Linux 全量测试 ＋ 覆盖率两轮跑完后，
`/tmp` 下 `astarray-*` 目录计数为 **0**（实测 `count=0`）—— 这与 2026-11-07 在 Windows
修掉的那个"每次运行永久泄漏一个 `astarray-git-tree-*`"是同一个文件，
说明该修复**在 Linux 上同样有效**。

### 4.2 真实子进程类用例在 Linux 上的稳定性

下列**真的起子进程 / 起服务**的用例在 Linux 全量运行中**全部通过**（耗时一并列出，便于对照"预算是否够"）：

| 文件 | Linux 结果 |
| --- | --- |
| `tests/core/unit/feedback-supervisor.test.ts` | 7 tests ✓（含"不响应的子进程在宽限期后被强制终止" 5614ms） |
| `tests/tui/integration/headless-cli.test.ts` | 11 tests ✓（7186ms） |
| `tests/tui/integration/permission-ask-timing.test.ts` | 2 tests ✓（33037ms） |
| `tests/tui/integration/artifact-presence-cli.test.ts` | 3 tests ✓（92537ms） |
| `tests/core/integration/reliability-git-process-tree.test.ts` | 2 tests ✓（11458ms） |

### 4.3 覆盖率门禁在 Linux 上同样成立

分支覆盖率 **85.23**（Windows 最近一次 85.27）⇒ **两平台均通过**同一 85 阈值，
说明该门槛**不是只在 Windows 才能满足**。

---

## 5. 仍未取得（如实保留，**不因本次 Linux 证据而改变**）

- **macOS 平台证据**：**未取得**（本次按用户指示**先跳过**，保留待补）。
  受影响：`RELIABILITY-01-03`、`B6R-10`（macOS Node 20／更新版本矩阵）、`BRIDGE-01`（macOS/Linux）。
  ⇒ **B6R-10 的 macOS 行、RELIABILITY-01-03 的整卡结论仍不得判通过**。
- **人工体验结论**：只能由用户提供，本次**未提供** ⇒
  `PROJECT-01-04`（人工能分辨副本与原件）、`GUI-01-R-04b` 仍 pending。
- **真实 Provider 额度**：`TOOLKIT-01-06`（真实 token 消耗／维护成本／跨平台可比性）需要真实额度。

> **纪律说明**：本文件只记录**本次实测到的事实**（退出码、用例数、覆盖率、耗时、跳过原因）。
> 不把"Linux 通过"外推为"macOS 通过"，也不把"平台证据"当作"人工体验结论"的替代。

---

## 6. 日志位置（本机，便于复核）

- 安装/构建/类型/静态检查：`.tmp/wsl-linux-install.log`
- 全量测试（**完整、未截断**，WSL 内 `$HOME/astarray-linux-evidence-test-full.log`）：`.tmp/wsl-linux-test-full.log`
- 覆盖率（WSL 内 `$HOME/astarray-linux-evidence-coverage-full.log`）：`.tmp/wsl-linux-coverage.log`
