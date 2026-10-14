# 平台证据汇总（Linux / WSL2）— 2026-11-08

- **用途**：把本会话为各任务卡取得的 **Linux 平台证据**汇总成**一份可复核索引**，
  避免散落在多份报告里逐份翻查。
- **依据的用户指示**：「**Linux 部分使用 WSL 做，macOS 部分先跳过，保留记录以后再补**」。
- **⚠️ 本文件不改变任何卡片结论**：它只是**索引**；每项结论以对应卡片与报告的原文为准。
- **⚠️ macOS 仍全部缺失** ⇒ 凡门槛含 macOS 的卡**一律不判通过**（如实保留 pending）。

---

## 1. 环境（三次运行共用同一环境）

| 项 | 值 |
| --- | --- |
| 平台 | **WSL2**（内核 `6.18.33.2-microsoft-standard-WSL2`）／ **Ubuntu 26.04 LTS** ／ x86_64 |
| 运行时 | **Node v22.22.1** ／ npm 9.2.0 |
| 检出 | `~/astarray-linux-evidence`（WSL **原生**文件系统） |
| 依赖安装 | `npm ci`（**不复用** Windows 的 `node_modules` —— 实测其为 `@esbuild/win32-x64` 等平台二进制，Linux 不可用） |

**纪律**：全程 **不联网取凭据、不打印任何密钥**；只用本地 loopback。

---

## 2. 各次运行与结论（真实退出码）

### 2.1 全量门禁与覆盖率（源提交 `5f08ef0`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm ci` | **0** | added 231 packages |
| `npm run build` | **0** | Build success（测试由 `dist/` 驱动，故先构建） |
| `npm run typecheck` | **0** | 无输出 |
| `npm run lint` | **0** | 无输出 |
| `npm run test` | **0** | **422 文件；3177 passed ＋ 2 skipped（共 3179）** |
| `npm run test:coverage` | **0** | 语句 92.59 ／ **分支 85.23** ／ 函数 93.22 ／ 行 92.61（阈值 85 全通过） |

**与 Windows 的差异（如实）**：Windows 当时为 **3179 passed ／ 0 skipped**；Linux 为 **3177 ＋ 2 skipped**。
差的 2 条是**条件跳过**，已定位：`tests/tui/integration/smart01-04-live-u2-flash-verdict.test.ts`
的守卫 `hasLiveVerdict = existsSync(<repo>/.tmp/live-u2-flash/acceptance-verdict.json)` ——
该文件是**真实 Provider 运行产物、不在版本控制内**，全新 clone 自然没有 ⇒ 跳过；
同文件**其余 4 条「脚本存在性/契约」断言在 Linux 上照常执行并通过**。
其余三处 `skipIf` 守卫在 Linux **均未跳过**。

### 2.2 后续复跑（源提交 `9d894fe`，与 Windows 同提交）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test`（全量） | **0** | **431 文件全过；3253 passed ＋ 2 skipped；0 failed** |
| `npm run test`（再跑一次，用于 2.4 复核） | **0** | 同上 |

⇒ 两次全量 Linux 运行**均 0 失败**。

### 2.2b 最新提交复核（源提交 `5741d79`，2026-11-08 第 57 轮）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm ci` | **0** | — |
| `npm run build` | **0** | Build success |
| `npm run test`（全量） | **0** | **431 文件全过；3253 passed ＋ 2 skipped；0 failed** |
| `npm run test:coverage` | **0** | 语句 92.59 ／ **分支 85.21** ／ 函数 93.22 ／ 行 92.63 |

**同步方式（一处踩坑，记以备用）**：WSL 的检出是**独立 clone**，
新提交的对象**不会自动存在** ⇒ 必须 `git fetch <Windows 仓库路径> <sha>` **先取对象**再 checkout。
前一版脚本直接 `checkout <sha>` 报了 `Could not parse object`（对象尚未取到），于是**静默停在旧提交**上 ——
那会让"最新提交复核"名不副实。**已修正并确认 `linux HEAD == windows HEAD == 5741d79`。**

### 2.2c 稳定性复跑（2026-11-08 第 59 轮，源提交 `f186686`）

**Windows**：`npm run check` **连跑 6 次** ⇒ **6/6 exit 0、`Errors 0`、3255 用例全过、无 FAIL**。

**Linux（同提交）**：`npm run test` 全量 **6 次** ⇒ **5/6 全绿（431 文件、exit 0）**，
**第 1 次出现 `1 failed | 430 passed`（TEST1_EXIT=1）**。

> **⚠️ 如实说明该次失败：我没有拿到它的用例名。**
> 我当时只把 `grep -E "Test Files|Tests"` 的输出截取进日志，**没有保留完整输出**，
> 之后再用不同方式复跑 **4 次 + 1 次**（共 5 次）**全部为 0 失败**，
> **因此这次失败无法归因**，只能记为"**Linux 侧存在低频、不确定用例的失败**"。
> **教训（对我自己）**：**任何一次红都要当场落盘完整输出**，否则事后无法归因
> —— 这与本会话此前多次"没落盘就没有现场"的问题同源。
> **我不把它算作"Linux 无抖动"，也不把它算作已知缺陷**；它是一条**未归因的观测**。

### 2.3 MCP 桥接闭环（源提交 `5f08ef0`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node scripts/verify-mcp-bridge-loop.mjs` | **0** | `checkCount = 20`、**passed 20 ／ failed 0**、`isPassed: true` |

**该脚本自足**：只 `spawn(process.execPath, [cliEntryPath, "mcp", "serve"])`，
**不依赖外部 MCP 客户端、不触网、不用凭据**，故可直接在 Linux 复跑。

**⚠️ 我在这里犯过一次计数错误并纠正**：最初用 `grep -c '"isPassed": true'` 得到 **21**，
一度以为"Linux 比 Windows 多 1 条判据"；核对后发现**顶层判定对象本身也含一个 `"isPassed": true`**
⇒ 21 = **20 条判据 ＋ 1 个顶层判定**，**实际就是 20/20**，与 Windows 记录一致。
**教训：统计要走结构化字段，不要对文本做模式计数。**

### 2.4 AR-07「平台不可达分支」（源提交 `9d894fe`）

卡内点名：这些分支在 **Windows 上物理不可达**（走 win32 分支）⇒ 须由平台提供证据。
定向测量三个文件：

| 文件 | 语句 | **分支** | 函数 |
| --- | --- | --- | --- |
| `tools/cross-platform-path-canonicalization.ts` | 98.3% | **100.0%（23/23）** | 100.0% |
| `tools/protected-storage-policy.ts` | 95.8% | **100.0%（13/13）** | 100.0% |
| `tools/sensitive-content-access-policy.ts` | 98.6% | **100.0%（28/28）** | 100.0% |

⇒ 那批"**Windows-only／非 win32 归一化**"分支在 Linux 上**确实被执行到了**。

**⚠️ 一处未能对齐（如实）**：卡内用**行号**指认分支，但按当前提交读这些行号内容已不符
（如 `protected-storage-policy.ts:40` 现为一行注释）⇒ **行号已漂移**。
故改用**更强且不依赖行号**的判据：**这三个文件分支覆盖率在 Linux 上达 100%**
⇒ 只要成立，就**不存在**任何"只在非 win32 可达却从未被走到"的分支。

### 2.5 RELIABILITY-01「POSIX 进程树收口」（源提交 `5f08ef0`）

`tests/core/integration/reliability-git-process-tree.test.ts` **Linux 实跑通过**：

```
✓ ⓪ 夹具活性：孙进程确实启动并在写心跳       8239ms
✓ ① 超时后孙进程必须被收口（心跳停止增长）   3216ms
```

且 Linux 全量两轮跑完后 `/tmp` 下 `astarray-*` 计数 **= 0**
⇒ 2026-11-07 在 Windows 修掉的"每次运行永久泄漏临时目录"**在 Linux 上同样有效**。

---

## 3. 顺带取得的两个**缺陷级**发现

1. **GUI 根本不在发布包里**（第 47 轮，`44ad8b8`）：`tsup.config.ts` 的 entry 只有
   `cli`／`feedback-process-entry`／`public-sdk` ⇒ `packages/gui` **既无公开入口、也不在 `exports` 里**
   ⇒ 消费者装上隔离 tarball **拿不到 GUI**，卡内那句"隔离 tarball 打开 GUI 复验"**此前根本无法执行**。
   已补 `packages/gui/src/public-gui.ts` ＋ `tsup` entry ＋ `exports["./gui"]`，
   并新增包级验收脚本 `npm run verify:gui-package`（**exit 0、6/6**）。
2. **一处"定位但未修"的 Linux-only 缺陷已不再复现**（第 54 轮，`9c56427`）：
   2026-10-10 报告记的 `authorization-retry-closure` ①（`非法状态迁移: T-001 pending → done`
   把已落盘成果误判 `blocked`）在**当前 `main`** 上：Linux **连跑 5 次全过**、全量 **0 失败**。
   **我没有声称"知道是谁修的"** —— 只做**复现性判定**，未逐提交 bisect。

---

## 4. 仍未取得（如实保留，**不因本汇总改变**）

| 项 | 状态 | 影响 |
| --- | --- | --- |
| **macOS 平台证据** | **未取得**（按指示先跳过、保留待补） | RELIABILITY-01-03 ／ B6R-10 跨平台矩阵 ／ BRIDGE-01 ／ AR-07 的整卡结论 |
| **人工体验结论** | **未取得**（须由用户提供） | GUI-01-R-04b ／ PROJECT-01-04（副本可辨识性）／ GUI-02-01 片④、03、04 |
| **真实 Provider 凭据** | **未提供** | SMART-01 的 `--probe-only` libuv 断言修复（**改完无法验证**，故未改） |
| **真实额度** | **未提供** | TOOLKIT-01-06（真实 token 消耗／维护成本／跨平台可比性） |

> **纪律说明**：本汇总只记录**实测到的事实**（退出码、用例数、覆盖率、耗时、跳过原因）。
> **不把"Linux 通过"外推为"macOS 通过"**，也不把"平台证据"当作"人工体验结论"的替代。

---

## 5. 相关报告与提交（逐项可追）

| 报告 | 内容 | 提交 |
| --- | --- | --- |
| `LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md` | 全量门禁＋覆盖率＋进程树收口 | `124be53` |
| `BRIDGE01_LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md` | MCP 桥接闭环 20/20 | `cac14eb` |
| `AR07_LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md` | 平台不可达分支分支覆盖率 100% | `7cfc32a` |
| `LINUX_PLATFORM_EVIDENCE_2026-10-10.md` | 早期 Linux 证据（含一个已修缺陷 + 一处当时未修） | 本轮加**复核块**（`9c56427`） |
| `GUI02_04_RESUME_PATH_2026-11-08.md` | GUI-02-04 恢复入口（包级验收／闸门／成功路径） | `44ad8b8`…`0d54d5b` |
| `docs/tasks/AR07_FINAL_ACCEPTANCE.md` | 卡内就地补 Linux 证据（保留"macOS 仍缺"） | `7cfc32a` |
| `PLAN_STATUS.md` 当前有效表 | `RELIABILITY-01`／`AR-07` **状态列**补 Linux 证据 | `932a064` |
