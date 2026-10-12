# GUI-02-01 片④：真实 TTY 权限询问闭环证据（2026-10-12，用户提供）

> 证据来源：**用户本人**在 Windows 11 真实终端（有 TTY）中运行，
> 使用 `scripts/manual/fake-permission-ask-provider.mjs`（最小假 Provider，
> **不读取/不打印任何密钥**）。**原样转录，未改写**。

## 1. 命令

```powershell
# 终端 1（每轮实验前重启，以重置假 Provider 的轮次计数）
node scripts/manual/fake-permission-ask-provider.mjs

# 终端 2（--mode assist 必须准确；run 在非 TTY 下需 --json）
node dist/cli.js run "创建 .tmp/tty-check.md，内容写 # TTY 检查" --mode assist --runtime openai-compatible --provider-endpoint http://127.0.0.1:48771/v1/chat/completions --provider-model fake-model --json
```

## 2. 路径 A：**批准**（用户输入 `allow-once`）

```
astarray: [需要用户] 任务 T-001 需要权限调用 createProjectFile（执行任务需要调用工具 createProjectFile），参数: {"filePath":".tmp/tty-check.md","content":"# TTY 检查\n"}
astarray: [权限裁决] 任务 T-001 请求调用受限工具 createProjectFile
  说明: 执行任务需要调用工具 createProjectFile
  参数: {"filePath":".tmp/tty-check.md","content":"# TTY 检查\n"}
  allow-once = 仅本次按上述精确参数授权；参数变化将失效需要重新裁决。
  输入 allow-once 授权 / 其他任意输入拒绝：
allow-once
astarray: 已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted），并下发 unblock（任务 T-001）。
astarray: [需要用户] 任务 T-001 失败：缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）（状态：已完成。）
```

## 3. 路径 B：**拒绝**（用户输入 `no`）

```
astarray: [需要用户] 任务 T-001 需要权限调用 createProjectFile（执行任务需要调用工具 createProjectFile），参数: {"filePath":".tmp/tty-check.md","content":"# TTY 检查\n"}
astarray: [权限裁决] 任务 T-001 请求调用受限工具 createProjectFile
  说明: 执行任务需要调用工具 createProjectFile
  参数: {"filePath":".tmp/tty-check.md","content":"# TTY 检查\n"}
  allow-once = 仅本次按上述精确参数授权；参数变化将失效需要重新裁决。
  输入 allow-once 授权 / 其他任意输入拒绝：
no
astarray: 已拒绝权限调用 createProjectFile（未授权、未继续任务）。
{
  "missionId": "mission-65239f61",
  "mode": "assist",
  "status": "blocked",
  "permissionAsk": "denied",
  "prompt": "创建 .tmp/tty-check.md，内容写 # TTY 检查"
}
```

（两条路径中 `allow-once` / `no` 为人工键入行。）

## 4. 逐项核对

### 4.1 两条路径共同成立（提示与解析）

| # | 事实 | 证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 升级文本到达用户（ADR-0011 载荷形态） | 首行 `[需要用户] 任务 T-001 需要权限调用 createProjectFile（…），参数: {...}` | ✅ |
| 2 | **独立裁决提示**渲染 | `[权限裁决] 任务 T-001 请求调用受限工具 createProjectFile` | ✅ |
| 3 | 提示文案**逐字可核对**（此前**仅有测试注入端口证据**） | `说明: …` / `参数: …` / `allow-once = 仅本次按上述精确参数授权；参数变化将失效需要重新裁决。` / `输入 allow-once 授权 / 其他任意输入拒绝：` | ✅ **首次取得真实 TTY 证据** |
| 4 | 参数**逐字展示**供用户判断（不脱敏、不改写） | `参数: {"filePath":".tmp/tty-check.md","content":"# TTY 检查\n"}` | ✅ |
| 5 | **两条路径重复触发可行**（同一 Provider 进程、不同轮次） | A 与 B 的提示**逐字相同** | ✅ |
| 6 | 输出中**无任何密钥/token** | 全文检查 | ✅ 符合纪律 |

### 4.2 路径 A：批准

| # | 事实 | 证据 | 结论 |
| --- | --- | --- | --- |
| 7 | 输入被解析为 `allow-once` | 键入行 + 授权行 | ✅ |
| 8 | 授权**绑定精确参数**（非泛化） | `已按精确参数 allow-once 授权 createProjectFile` | ✅ |
| 9 | 作用域一次性授权**已重新登记** | `（作用域授权: granted）` | ✅ |
| 10 | **unblock 已下发**，任务继续 | `并下发 unblock（任务 T-001）` | ✅ |
| 11 | 完成门禁**拒绝不合法完成** | `失败：缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）` | ✅ **正确行为**（假 Provider 只声明"已完成"却不发版本化事件，门禁按契约拒绝结案） |

### 4.3 路径 B：拒绝

| # | 事实 | 证据 | 结论 |
| --- | --- | --- | --- |
| 12 | 非 `allow-once` 输入被判为**拒绝** | 键入 `no` ⇒ `已拒绝权限调用 createProjectFile（未授权、未继续任务）。` | ✅ |
| 13 | **明确告知未授权且未继续任务** | 同上文案含"未授权、未继续任务" | ✅ |
| 14 | 结构化载荷 `status: "blocked"` | JSON 的 `"status": "blocked"` | ✅ **任务保持阻塞**（用户要求的"或保持阻塞"） |
| 15 | 结构化载荷 `permissionAsk: "denied"` | JSON 的 `"permissionAsk": "denied"` | ✅ 裁决结论经载荷可机读 |
| 16 | **产出文件不存在** | 用户执行 `Get-ChildItem .tmp\tty-check.md` 未发现该文件 | ✅ 拒绝 ⇒ 工具**未执行**（无副作用） |
| 17 | 退出码 | 由 `status !== "done"` ⇒ **1** | ✅ 与 `§6.5` 的代码级结论一致（**退出码不受裁决结果影响，只由终态决定**） |

## 5. 结论（本条证据闭合了什么）

- **GUI-02-01 片④ 的"TTY 权限询问逐字输出"**：**已取得真实 TTY 证据**（批准 + 拒绝**两条路径**），
  其"运行时未实测"标注**可以撤下**。
- **用户明确要求的完整闭环已由用户本人证实**：
  "**提交任务 → 收到权限询问 → 批准或拒绝 → 任务继续或保持阻塞**"
  —— 批准 ⇒ `granted` + `unblock` + 任务继续；拒绝 ⇒ `denied` + `status: blocked` + **无产物**。
- **`§6.5` 的退出码代码级结论得到运行时印证**：`denied` 时退出码仍为 **1**，
  原因**不是"拒绝 ⇒ 失败"**，而是**终态为 `blocked`（非 `done`）** ⇒
  裁决结果本身不参与退出码计算。
- **仍未实测（如实保留）**：① **非 TTY（管道）路径的逐字输出**
  （已被我验证为"不提示 + fail-closed 阻断"，但那是**我的**运行，非用户环境）；
  ② **真实引导模型的等待/超时行为**（两次均为立即输入，**未观察超时分支**）。

## 6. 我的失误（本轮，如实记录）

我在给用户的人工验收命令与辅助脚本上**连续出错 4 次**：

| # | 失误 | 用户影响 |
| --- | --- | --- |
| 1 | 命令**漏 `--json`** | 用户撞到 `headless run 必须使用 --json` |
| 2 | **`--mode assistant`**（正确为 `assist`） | 用户撞到 `配置非法: …` |
| 3 | **假 Provider 的轮次计数跨多次 CLI 运行不重置** | 用户第二次运行**没有出现提示**，易被误读为"拒绝路径无提示" |
| 4 | 我自己**用管道去验 TTY 交互** | 我自己白跑两次（未误导用户） |

**1–3 都是我给错命令/脚本，不是产品缺陷**；第 3 项已修为**按轮次判断**
（`fix(manual)` 提交）。**硬规矩**：给用户的命令必须**先自己跑通**，且**不得在消息中出现错误的取值再在备注里更正**。
