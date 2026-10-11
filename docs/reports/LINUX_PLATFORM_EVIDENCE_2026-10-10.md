# Linux 平台证据（WSL Ubuntu 26.04 / Node 22.22.1 / x86_64）—— 2026-10-10

> 本文件是**本仓首次取得的 Linux 平台证据**，用于消除 B6R-10、AR-07、
> RELIABILITY-01-03 长期标注的"仅 Windows 验证"卡点。
> 全部数字为**真实退出码**，并如实记录**仍未通过**的项。

## 0. 环境与方法（可复现）

| 项 | 值 |
| --- | --- |
| 宿主 | Windows 10/11（`DESKTOP-I4SFTHJ`） |
| 虚拟化 | **WSL2**，内核 `6.18.33.2-microsoft-standard-WSL2` |
| 发行版 | **Ubuntu 26.04 LTS**，`amd64` / `x86_64` |
| Node | **v22.22.1**（apt 官方源，`engines.node >= 20` 满足） |
| npm | 9.2.0 |
| 仓库位置 | `/home/darkh/astarray-linux`（**Linux 文件系统**，非 `/mnt/c`） |
| 依赖 | `npm install --no-audit --no-fund` ⇒ **231 包** |

**为什么不用 `/mnt/c`**：跨 9P 文件系统的 `node_modules` 会极慢且部分包对权限敏感，
结果会不可信。因此把源码（排除 `node_modules`/`dist`/`coverage`）复制到 Linux 侧后安装。

**注意**：`npm run test` 在**失败时仍返回退出码 0**（vitest 配置如此），
故本文档以**用例计数**与逐用例退出码为准，不只看脚本退出码。

## 1. 首轮结果（修复前）：**3 个真实失败**

| # | 用例 | 类别 | 结论 |
| --- | --- | --- | --- |
| A | `tests/core/integration/reliability-git-process-tree.test.ts` ① | **真实缺陷** | 超时后孙进程**未被收口**，心跳持续增长（`expected 57 to be 43`） |
| B | `tests/core/unit/builtins.test.ts` `gitReadonlyView` | 环境 | 复制时未带 `.git` ⇒ `git status` 非 0 |
| C | `tests/tui/integration/authorization-retry-closure.test.ts` ① | **真实缺陷** | 产物已落盘，但任务被判 `blocked`（正向闭环误判失败） |

## 2. 已修复并在 Linux 上验证的缺陷

### 2.1 A：`GitProcess` 超时只收口直接子进程（**进程树泄漏**）

**缺陷**：`packages/core/src/orchestration/git-process.ts` 超时处理器只
`childProcess.kill("SIGKILL")`。它派生的**孙进程被 init 收养并继续运行**
（继续写盘、继续占句柄）—— 正是卡内 R2 要核查的"子进程树收口"。

**为什么 Windows 测不出来**：Windows 无 POSIX 进程组语义、树形终止方式不同，
该用例在 Windows 上**一直通过**。**只有 Linux/macOS 证据能发现它。**

**修法**：
- POSIX：`spawn(..., { detached: true })` 让子进程**自成进程组**，
  超时用 `process.kill(-pid, "SIGKILL")` **整组收口**（`ESRCH` 忽略）；
- Windows：`taskkill /pid <pid> /T /F` 递归终止；
- 两条路径后仍保留 `childProcess.kill("SIGKILL")` 作兜底。
- `detached: true` **只**影响进程组归属，不 detach 生命周期（未 `unref()`，
  stdio 仍是管道，父进程照常等 `close`）。

**验证**：Windows 该用例 **2/2 通过**（回归无破坏）；Linux 修复前 ① **确定性失败**，
修复后 **2/2 通过**。

### 2.2 B：环境（非产品缺陷）

`gitReadonlyView` 用 `ponderGitRepositoryPath: process.cwd()` 并要求 cwd 是 git 仓库。
tar 复制时排除了 `.git` ⇒ `git status` 非 0。
**补齐 `.git` 后该用例通过**（另需 `git config --global --add safe.directory` 处理
跨属主所有权检查）。**这不是产品缺陷，故未改任何产品代码。**

## 3. 已修复：C（迟到的 unblock 降级正在运行的任务）

**现象**（Linux 确定性复现，stderr 原文）：

```
astarray: 已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted），并下发 unblock（任务 T-001）。
astarray: [需要用户] 任务 T-001 的 Git 提交/审查失败（未合并）: 非法状态迁移: T-001 pending → done
astarray: 需要权限的调用已阻断，但未能确认被请求的工具与参数：请人工检查并重新提交任务。
```

**关键事实**：产物 `existsSync(absolutePath)` **断言通过**（文件真的落盘了），
只有 `status` 是 `blocked` —— 即**正向闭环被误判为失败**。

**触发链**：`mission-orchestrator.handleWorkerOutcome` 的 success 分支
（`mission-orchestrator.ts:598`）直接 `finishTask(taskId, "done")`；
`dag-scheduler.finishTask` 先查 `claimedTaskIds`（该集合仍含此任务）再
`graph.markDone(taskId, ...)`；而此刻图节点状态是 **`pending`**（权限裁决路径把任务
放回 pending），`markDone` 只允许 `["running"]` ⇒ 抛错 ⇒ 被 `catch` 升级为
`blockForHumanDecision` ⇒ `blocked`。

**我尝试过并已回退的修法**：把 `markDone` 放宽为 `["running", "pending"]`。
**该修法被本仓既有契约测试否证** ——
`tests/core/unit/task-graph-gaps.test.ts` 内
`transitionTo 非法前置状态 → invalid-task-chain` **明确断言 `markDone` 从 pending 必须抛错**。
放宽它会破坏一条**有意为之**的状态机不变量（且该不变量由架构守卫保护）。
⇒ **已完整回退**，未把该改动留在代码里。

**最终修法（不放宽状态机）**：把 `DagScheduler.unblockTask` **幂等化** ——
只有 `pending`（已是目标态）与 `blocked`（真正等待裁决）需要处理；
`running`/`done`/`failed` 下这是**冗余的迟到指令**，一律**无操作**。
这样既保住 `blocked → pending` 的原有语义，又不再破坏
"领取集合含此任务 ⇔ 图节点 `running`" 的一致性；
`pending → done` 继续非法（不变量未被削弱）。

**验证**：
- 新增 `tests/core/unit/dag-scheduler-late-unblock-race.test.ts` **5 条**（先红后绿，
  实现前 3 红），其中②**直接复现** `DomainError: 非法状态迁移: t1 pending → done`；
- Linux：`authorization-retry-closure` ① 修复前失败 ⇒ 修复后**连跑 4 次全通过**；
- Linux 全量：**375 文件 / 2834 用例全部通过（exit 0）**；
- Windows 全量：**376 文件 / 2840 用例通过**；`test:coverage` 达标（branches 85.08%）。

**一处语义收口**：`tests/core/unit/dag-scheduler.test.ts` 的
"unblockTask 将人工裁决的任务重新加入可运行集合"原本用 `unblockTask` 重试一个
**失败终态**任务，而生产侧 `AssistScheduler` 把 retry/reassign 都路由到
`reassignTask`；已改用 `reassignTask`（并调整同一用例内 agent 序号断言）。

## 4. 平台项的当前状态（如实更新）

| 卡 | 平台项 | 状态 |
| --- | --- | --- |
| RELIABILITY-01-02（进程树收口） | Linux 平台分支 | ✅ **已取得证据并修复** |
| B6R-10 跨平台矩阵 | Linux 侧 | ✅ **Linux 侧全量通过**：375 文件 / **2834 用例全绿**（Windows 376 文件 / 2840，含 1 处产物门禁 `skipIf`） |
| AR-07 平台不可达分支 | 非 win32 归一化等 | ⚠️ **尚未单独核算**（本轮聚焦全量门禁，未逐分支统计 Linux 覆盖率） |
| RELIABILITY-01-03 | 跨平台矩阵 | ⚠️ 同 B6R-10 |
| 缺陷 C | 授权后重跑闭环（Linux） | ✅ **已修复**（`unblockTask` 幂等化，见 §3）；Linux 全量 2834/2834 通过 |

**必须同时说明**：本证据来自 **WSL2**（Linux 内核 + 官方 Ubuntu 用户态），
**不是**裸机 Linux，也**没有 macOS 证据**。macOS 的进程终止语义与信号/权限模型
和 Linux 不完全相同 ⇒ **macOS 项仍未取得证据**。

## 4b. AR-07 平台分支的 Linux 逐分支核算（2026-10-10）

AR-07 卡内 §8.1 把三个模块的分支缺口归类为"**平台不可达**（仅非 win32 成立）"。
本轮在 Linux 侧用**同一套全仓测试**跑覆盖率，结论是**这三个模块分支全部 100%**：

| 模块 | Windows（AR-07 原记录） | **Linux 实测** | 判定 |
| --- | --- | --- | --- |
| `packages/core/src/tools/protected-storage-policy.ts` | 22/23（余 1 个非 win32 分支） | **12/12 = 100%** | 该分支**真实可达**，已执行 |
| `packages/core/src/tools/sensitive-content-access-policy.ts` | 53/55（余 2 个非 win32 分支） | **28/28 = 100%** | 同上 |
| `packages/core/src/orchestration/process-supervisor.ts` | 有缺口 | **29/29 = 100%** | 同上 |

**意义**：原归类是"**无法在 Windows 验证的缺口**"，现在变成
"**已由 Linux 平台证据验证的真实分支**" —— 且证明它们**不是死代码**。
即 AR-07 的"平台不可达"一项**可以关闭**（macOS 除外）。

复现：
```bash
cd /home/darkh/astarray-linux
npx vitest run --coverage --coverage.reporter=json --coverage.reportOnFailure
# 再用 node 解析 coverage/coverage-final.json 的 branchMap，按文件名过滤上述三个模块
```

**仍未取得**：**macOS** 证据（WSL 是 Linux，不是 macOS）。

## 4c. 包级验收脚本的跨平台缺陷（2026-10-10 发现并修复）

把**包级验收脚本**也放到 Linux 上跑，立刻又暴露一个真实缺陷：

| 脚本 | Linux 修复前 | Linux 修复后 | Windows |
| --- | --- | --- | --- |
| `verify:observability-entry-package` | **exit 1** | ✅ **exit 0（8/8）** | 8/8 |
| `verify:instruction-entry-package` | **exit 1** | ✅ **exit 0（17/17）** | 17/17 |
| `verify:toolkit-package` | **exit 1** | ✅ **exit 0（48/48）** | 48/48 |

**错误**（三者同一根因，来自 `scripts/lib/package-acceptance-runtime.mjs:43`）：

```
Error: 无法解析 npm-cli.js 路径
    at resolveNpmCliPath (…:43) → runNpmSync (…:48) → packTarball (…:83)
```

**根因**：`resolveNpmCliPath()` 只尝试**一种**候选布局 ——
"`npm` 可执行文件的兄弟目录 `node_modules/npm/bin/npm-cli.js`"，
该布局只在 npm 装于 `node_modules` 时成立（Windows / npm 官方全局安装）。
而 **apt 安装的 npm 布局不同**：

```
/usr/bin/npm  ->  /usr/share/nodejs/npm/bin/npm-cli.js    （符号链接）
```

于是候选路径 `/usr/bin/node_modules/npm/bin/npm-cli.js` 不存在 ⇒ 抛错，
**且没有回退、没有诊断信息** ⇒ **"包级验收"这一项在 Linux 上从未真正跑过**。

**修法**（每步都要求真实存在，绝不返回凭空拼接的路径）：
1. `NPM_CLI_PATH` 环境变量逃生门；
2. 原有兄弟布局（保持兼容）；
3. **跟随符号链接**（`realpathSync` 后再找兄弟布局）—— 覆盖 apt 布局；
4. 常见系统级布局逐个探测。
   全部失败时抛错并**列出尝试过的候选**，避免再出现"只报一句、无从诊断"。

**反例（先红后绿）**：`scripts/lib/package-acceptance-runtime.test.mjs` **3 条** ——
Linux 修复前 **2 failed**（①解析到真实文件、③真正执行 npm），修复后 **3/3 通过**；
Windows 始终 3/3。`npm run test:scripts` 39/39（两侧一致）。

**意义**：包级验收（tarball 隔离安装）此前**只有 Windows 证据**；现在 Linux 侧
三个脚本的真实判据齐备（8/8 + 17/17 + 48/48），B6R-10 的跨平台矩阵据此再补一块。

## 5. 复现命令

```bash
# WSL Ubuntu 内
cd /home/darkh/astarray-linux
npm run typecheck && npm run lint && npm run build
npm run test            # 注意：失败时退出码仍为 0，须看用例计数
npx vitest run tests/core/integration/reliability-git-process-tree.test.ts
npx vitest run tests/tui/integration/authorization-retry-closure.test.ts
```
