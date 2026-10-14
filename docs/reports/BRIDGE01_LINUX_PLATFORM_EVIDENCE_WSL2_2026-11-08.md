# BRIDGE-01 Linux 平台证据（WSL2 / Ubuntu 26.04 LTS）— 2026-11-08

- **来源提交**：`5f08ef0c73a7b4ea40afee0560594ac4007ee0ca`（`5f08ef0`）
- **取得方式**：用户指示「**Linux 部分使用 WSL 做，macOS 部分先跳过，保留记录以后再补**」。
- **报告性质**：**平台证据**（补齐 `BRIDGE-01` 长期记为"仅缺 macOS/Linux 平台验证"中的 **Linux 一格**）。
- **边界**：本文件**只**证明"该脚本化闭环在 Linux 上通过"；**macOS 仍未验证** ⇒ **本卡不因此改判 done**。

---

## 1. 为什么本次不需要外部第三方客户端

`BRIDGE-01-04` 之前的"真实第三方客户端消费"（`opencode`/`pi`）需要用户在 Windows 上授权与 Provider 凭据；
但**脚本化闭环** `scripts/verify-mcp-bridge-loop.mjs` 是**自足**的：

- 它只 `spawn(process.execPath, [cliEntryPath, "mcp", "serve"], ...)`
  （即 **`node dist/cli.js mcp serve`**），**不依赖任何外部 MCP 客户端**；
- 因此它**可以在 Linux 上直接复跑**，且**不触网、不使用任何凭据**。

---

## 2. 环境（可复核）

| 项 | 值 |
| --- | --- |
| 平台 | **WSL2**（`6.18.33.2-microsoft-standard-WSL2`）／ **Ubuntu 26.04 LTS** |
| 运行时 | **Node v22.22.1** |
| 源提交 | `5f08ef0`（WSL 原生文件系统内独立检出，`node_modules` 由 `npm ci` 在 Linux 上重装） |

---

## 3. 结果（真实退出码）

```
node scripts/verify-mcp-bridge-loop.mjs
```

| 项 | 值 |
| --- | --- |
| **退出码** | **0** |
| `checkCount`（脚本自报） | **20** |
| **判据通过 / 失败** | **passed = 20 ／ failed = 0** |
| 顶层判定 | `"isPassed": true` |
| 脚本自述 | `MCP 桥接闭环校验通过 ✓` |
| 覆盖场景 | **① 最小工具面与闭环**、**② 主体隔离与断连收口** |

**与 Windows 记录完全一致**：`BRIDGE-01-04` 在 Windows 上记为
"**exit 0、20 项判据全过（0 失败）**"；Linux 实测同为 **20/20、0 失败**
⇒ **该脚本化闭环在两平台上结论一致**。

> **⚠️ 一处我自己的计数错误（已纠正，记录以免再次误读）**：我最初用
> `grep -c '"isPassed": true'` 得到 **21**，并一度以为"Linux 比 Windows 多 1 条判据"。
> 核对后发现：输出的 JSON **顶层判定对象本身也含一个 `"isPassed": true`**
> ⇒ 21 = **20 条判据 ＋ 1 个顶层判定**。
> 改为解析 JSON（读取脚本自报的 `checkCount` 与 `checks` 数组）后确认是 **20/20**。
> **教训**：统计要基于**结构化字段**，不要对文本做模式计数 —— 否则会凭空造出一个"差异"。
> （本报告早前那一版曾写下"我未复核这 1 条差在哪里"，现按实测更正为该差异**并不存在**。）


**Linux 上逐条确认通过的关键判据（节选）**：

- 最小工具面与闭环（含"业务级失败以 `isError=true` 返回、与协议级失败可区分"、禁用工具名不得出现）；
- **主体隔离**：不同主体读取他人任务 ⇒ 一律 `task-not-accessible`（**业务级失败**，非协议错误）；
  且**不误伤**：另一主体可正常提交并读取**自己**的任务；
- **断连收口**：A 的 `stdin` 结束后进程**自行退出**（`exitedOnItsOwn: true`、`exitCode: 0`），**未走 `SIGKILL`**；
- **stdout 纯净性**：只含合法 MCP 消息（多主体同时连接时仍成立）。

---

## 4. 仍未取得（如实保留，**不因本次改变**）

- **macOS 平台证据**：**未取得**（本次按用户指示**先跳过、保留待补**）。
- **真实第三方客户端（`opencode`/`pi`）在 Linux 上的消费**：**未验证** —— 本次跑的是
  **脚本化 stdio 闭环**；WSL 内是否有该两个客户端**未探测**，也不臆断。
- ⇒ **`BRIDGE-01` 不得因本文件改判通过**；本文件只补齐"Linux 一格"中**脚本化闭环**这部分的证据。

---

## 5. 日志位置

- 本机（WSL 内，完整未截断）：`~/astarray-linux-evidence-bridge-loop-full.log`
- Windows 侧（完整回显）：`.tmp/wsl-bridge-loop-full.log`
- Linux 全量门禁证据（另见）：`docs/reports/LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md`
