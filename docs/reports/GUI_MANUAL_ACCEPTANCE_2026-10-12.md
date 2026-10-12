# GUI 人工验收记录（2026-10-12，用户提供）

> 验收人：用户本人（Windows 11 + 火狐）。本文件只记录**用户实际给出的结论**，
> 不由我推断或替代。我（Agent）的失误也如实记录在 §3。

## 1. 本轮结论（用户口述原文要点）

| # | 项目 | 用户结论 | 判定 |
| --- | --- | --- | --- |
| 1 | 键盘：可 Tab 到任意位置并 Enter 确认 | "可以 tab 到任意位置并 enter 确认" | ✅ 通过 |
| 2 | 中文输入 | "中文输入正常" | ✅ 通过 |
| 3 | 缩放后内容/按钮 | "缩放后无内容裁剪，按钮可用" | ✅ 通过 |
| 4 | 深色模式 | "深色模式正常" | ✅ 通过 |
| 5 | 权限询问闭环（提交→批准→任务继续） | "权限循环后面再测" | ⏸ **待测** |
| 6 | 拒绝路径（任务保持阻塞、无产物） | "权限循环和拒绝本身应该无法测试" | ⏸ **待测** |

**覆盖范围说明**：本轮**未**覆盖屏幕阅读器（GUI-01-R §4 的另一半），
该子项**仍为未测**。

## 2. 关于"权限询问无法测试"的澄清（含我的纠正）

用户判断："**现在没有接入真实大模型，没有任何模型会去执行权限询问等环节**"。

**部分成立**：
- ✅ 成立部分：`mock` 运行时**不会请求受限工具**，故 mock 下**永远不会**触发权限询问
  （我本会话实测结论）。这也意味着**纯 mock 的产品路径**看不到该环节。
- ❌ 不成立部分：**并非"无法测试"** —— 缺的不是真实大模型，而是一个**会返回受限工具调用的
  Provider**。本会话已用**假 Provider**证明整条链路可用：
  `tests/tui/integration/gui02-01-cli-permission-ask-registration.test.ts`（**2/2 通过**）——
  本地 HTTP 服务器返回 `createProjectFile` ⇒ 真实 `dist/cli.js` 触发询问 ⇒ 落盘请求实体
  ⇒ 用户 `deny` ⇒ **无产物、任务不报 `done`**。

## 3. 我的失误（如实记录）

我（Agent）在提供人工验收命令时**给错了命令**：

1. **漏了 `--json`** ⇒ 用户实测报错：
   `astarray: headless run 必须使用 --json（或 TTY 下使用 TUI）`。
2. **忘了自己已证明的结论**（mock 不触发受限工具）⇒ 让用户用一个**不可能触发**权限询问的
   模式去测权限询问。**这是我的错误，不是产品问题。**

## 4. 可执行的权限询问手动验收（已由我预先验证）

为弥补上述失误，我新增并**自行跑通**了一个最小假 Provider
（`scripts/manual/fake-permission-ask-provider.mjs`，**不读取/不打印任何密钥**）：

**终端 1**
```powershell
cd C:\Users\MerchRev\Documents\astarray
node scripts/manual/fake-permission-ask-provider.mjs
```

**终端 2**（**必须真实终端**，且 `run` 在非 TTY 下需 `--json`）
```powershell
cd C:\Users\MerchRev\Documents\astarray
node dist/cli.js run "创建 .tmp/tty-check.md，内容写 # TTY 检查" --mode assist --runtime openai-compatible --provider-endpoint http://127.0.0.1:48771/v1/chat/completions --provider-model fake-model --json
```

**我会预先验证到的现象（供你对照）**：
- 终端 2 出现 `astarray: [需要用户] 任务 T-001 需要权限调用 createProjectFile（…），参数: {...}`；
- 状态目录下出现请求实体 `agent-memory/<owner>/permission-ask-requests/ask-*.json`；
- 在**真实 TTY** 下应出现交互提示并等待你输入（`allow-once` 批准 / 其他拒绝）。

**要请用户回报的原始信息**：
- 交互提示的**逐字文案**；
- 是否在**输入前**就已打印参数内容；
- 输入后任务**是否继续**、是否产出 `.tmp/tty-check.md`；
- 任何报错/红字的原文。

## 5. Linux 证据（用户确认，无需重跑）

用户问："linux 之前在 wsl 上测试过相同内容吧？" —— **是的，已测过**（2026-10-10）：

| 项 | 值 |
| --- | --- |
| 环境 | WSL2 Ubuntu 26.04，`wsl -u root`，Node v22.22.1 |
| 全量测试 | 377 文件 / **2844 用例**全绿 |
| 三个包级验收器 | **全部 exit 0**（8/8、17/17、48/48）—— 修复 `npm-cli.js` 解析**之前**全部 exit 1 |
| 模块覆盖 | 3 个模块 100% 分支 |

⇒ **无需重跑**；且用户已把投产口径收敛为"**单平台可用**"，Linux 平台证据**不再阻塞门禁**。
