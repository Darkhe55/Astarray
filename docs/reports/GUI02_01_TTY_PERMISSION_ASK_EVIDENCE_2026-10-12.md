# GUI-02-01 片④：真实 TTY 权限询问闭环证据（2026-10-12，用户提供）

> 证据来源：**用户本人**在 Windows 11 真实终端（有 TTY）中运行，
> 使用 `scripts/manual/fake-permission-ask-provider.mjs`（最小假 Provider，
> **不读取/不打印任何密钥**）。**原样转录，未改写**。

## 1. 命令

```powershell
# 终端 1
node scripts/manual/fake-permission-ask-provider.mjs

# 终端 2（--mode assist 必须准确；run 在非 TTY 下需 --json）
node dist/cli.js run "创建 .tmp/tty-check.md，内容写 # TTY 检查" --mode assist --runtime openai-compatible --provider-endpoint http://127.0.0.1:48771/v1/chat/completions --provider-model fake-model --json
```

## 2. 用户实际看到的输出（原样）

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

（用户输入行 `allow-once` 为人工键入。）

## 3. 逐项核对（本条证据闭合了什么）

| # | 事实 | 证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 升级文本到达用户（ADR-0011 载荷形态） | 首行 `[需要用户] 任务 T-001 需要权限调用 createProjectFile（…），参数: {...}` | ✅ |
| 2 | **独立裁决提示**渲染 | `[权限裁决] 任务 T-001 请求调用受限工具 createProjectFile` | ✅ |
| 3 | **逐字提示文案**（此前**仅有测试注入端口证据**，无真实 TTY 证据） | `说明: …` ／ `参数: …` ／ `allow-once = 仅本次按上述精确参数授权；参数变化将失效需要重新裁决。` ／ `输入 allow-once 授权 / 其他任意输入拒绝：` | ✅ **本项自 2026-10-11 起首次取得真实 TTY 证据** |
| 4 | 参数**逐字展示**供用户判断（不脱敏也不改写） | `参数: {"filePath":".tmp/tty-check.md","content":"# TTY 检查\n"}` | ✅ |
| 5 | 用户输入被正确解析为 `allow-once` | 键入行 + 后续授权行 | ✅ |
| 6 | 授权**绑定精确参数**（非泛化授权） | `已按精确参数 allow-once 授权 createProjectFile` | ✅ |
| 7 | 作用域一次性授权**已重新登记** | `（作用域授权: granted）` | ✅ |
| 8 | **unblock 已下发**，任务继续 | `并下发 unblock（任务 T-001）` | ✅ |
| 9 | **完成门禁拒绝不合法完成** | `失败：缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）` | ✅ **正确行为**（假 Provider 只声明"已完成"却不发版本化事件；门禁按契约拒绝结案） |
| 10 | 输出中**无任何密钥/token** | 全文检查 | ✅ 符合纪律 |

## 4. 结论

- GUI-02-01 片④ 中"**TTY 权限询问逐字输出**"一项：**已取得真实 TTY 证据**（上表 1–9），
  其"运行时未实测"的标注**可以撤下**。
- **仍未实测**：① **非 TTY（管道）路径的逐字输出**；② **拒绝路径**（输入非 `allow-once`）
  的逐字输出与"不产出文件 + 任务保持阻塞"效果；③ **真实引导模型的等待/超时行为**
  （本次为立即输入，未观察超时分支）。
- **本实验的退出码为 1**，属**预期**：假 Provider 不可能产生合法完成事件 ⇒ 无法 `done`。
  该实验的目的是观察**权限询问与裁决**，不是让任务完成。

## 5. 我的失误（本轮，如实记录）

我在此前两条消息中给出的人工验收命令**有错**，用户实际撞到两次：

1. **漏 `--json`** ⇒ `astarray: headless run 必须使用 --json（或 TTY 下使用 TUI）`。
2. **`--mode assistant`**（正确为 `assist`）⇒
   `配置非法: … Invalid option: expected one of "ponder"|"assist"|"devolve"`。

两次都是**我给错命令**，不是产品缺陷。第三条命令（`--mode assist`）经我**自行实测**后才交付。
