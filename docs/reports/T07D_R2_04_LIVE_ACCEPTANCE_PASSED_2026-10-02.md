# T07D-R2-04 真实 Provider 单次验收通过记录（2026-10-02）

> **结论：五项判据在同一次真实运行内全部通过。**
> 支撑等级**暂不升级**（理由见 §5：`product-path-verified` 的定义要求"从 npm tarball"，
> 本次运行使用的是 dev checkout 的 `dist/cli.js`）。因此当前**不声称**产品路径已验证。

## 1. 运行命令（用户在其交互终端执行）

```powershell
npm run verify:t07d-r2-04-live -- --reference prov-live-1 --model step-3.7-flash --provider-request-timeout-seconds 120 --allow-live-request
```

交互：出现一次权限询问时输入 `allow-once`。

## 2. 脚本判定结果（原样）

```
目标产物不存在（符合仅新建工具的前置条件）: .tmp/t07d-r2-04-live/LIVE-PROOF.md
=== T07D-R2-04 单次真实验收（TTY 裁决）===
引用: prov-live-1 | 模型: step-3.7-flash | 单次请求超时: 120s
期望内容 sha256: 3ebded05629dd6f2b3c3a00954de71d6ea532c8f7c9d864f9a0ce98d0345d8ee
  ✓ 任务终态 status=done — done
  ✓ 权限裁决结果为 allowed-once — allowed-once
  ✓ 产物文件存在 — .tmp/t07d-r2-04-live/LIVE-PROOF.md
  ✓ 产物内容与期望一致（逐行精确，结尾换行不敏感） — 实际 sha256=6a7d86e8…cd55 / 期望 sha256=3ebded05…d8ee
  ✓ 仓库其他文件未被改动 — 仅 .tmp/ 下产物
子进程退出码: 0
T07D-R2-04 真实收口通过：同一次运行内产物正确 + 任务 done ✓
```

## 3. 产物证据（本次复核）

| 项 | 值 |
| --- | --- |
| 路径 | `.tmp/t07d-r2-04-live/LIVE-PROOF.md` |
| 字节数 | 99 |
| 字节级 sha256 | `6a7d86e8b8b59d69633fc138580ab4814d737ecb135b9732ae6620a71435cd55` |
| 期望内容 sha256 | `3ebded05629dd6f2b3c3a00954de71d6ea532c8f7c9d864f9a0ce98d0345d8ee` |
| 含 CR | 否 |
| 结尾换行 | 无（判据对结尾换行不敏感，且逐行内容精确一致） |
| `git status -- .tmp/t07d-r2-04-live/LIVE-PROOF.md` | 无输出（该路径未被跟踪/未改动） |

> 两个 sha256 不同是**预期**的：期望值对应"三行 + 末尾换行"，实际产物为"三行、无末尾换行"；
> 判据按行比较，故判定一致。

实际产物逐字节内容：

```
# 真实 Provider 受控改动（T07D-R2-04）
- 端点：api.stepfun.com
- 模型：step-3.7-flash
```

## 4. 同一次运行中观察到的产品行为（正面证据）

1. **模型正确调用受限工具一次**：参数与提示词要求逐字一致（含末尾换行）。
2. **权限询问 → 单次授权链路生效**：`已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted）`。
3. **第二次询问被自动复用批准**：
   `同一逻辑操作（createProjectFile → …）已在本次授权内批准且尚无副作用：自动复用该批准，不再重复询问。`
   —— 这正是本次会话中修复的"授权绑定完整规范化参数 + 无副作用可复用"语义在**真实 Provider**下生效。
4. **完成门禁如实结案**：`status=done`，且此前一次失败运行时门禁**拒绝**谎报完成
   （见"首次运行"记录），说明门禁不是无条件放行。

## 5. 为什么暂不升级支撑等级（诚实边界）

`docs/tasks/T07D_PROVIDER_RUNTIME_AND_STANDALONE_AGENT_TASK_CARD.md` 的定义：

| 等级 | 定义 | 本次是否满足 |
| --- | --- | --- |
| `live-smoke-verified` | 用户显式提供凭据并完成可选真实 API 冒烟 | ✅ 满足（且已超出"冒烟"：完成了一个真实工具工作流） |
| `product-path-verified` | **从 npm tarball** 经 CLI/TUI/SDK 完成真实工作流 | ⚠️ **未满足**：本次使用 dev checkout 的 `dist/cli.js` |

因此本次记录的准确表述是：
> **真实 Provider 单次受控工作流验收通过（dev checkout 路径）；`product-path-verified` 仍待 tarball 隔离安装下的真实运行。**

`provider-catalog.json` 中的 `supportLevel` 保持 `live-smoke-verified` **未修改**
（改动它需要 tarball 证据支撑，否则属于虚报等级）。

## 6. 本次真实额度消耗

| 次数 | 结果 | 说明 |
| --- | --- | --- |
| 第 1 次真实运行 | 失败（工具报"目标已存在"） | **验收脚本产物残留问题**，模型本身正确；已修复脚本 |
| 第 2 次真实运行 | **通过（本记录）** | 五项判据全过 |

即：真实运行共 **2 次**；每次对应 1 个任务，Provider 请求次数未逐条计数。

## 7. 仍未验证 / 待办

- **tarball 隔离安装下的真实运行**（升级 `product-path-verified` 的前置条件；需另一次真实运行）。
- Linux/macOS 未验证。
- CLI 在给出结果后进程仍会滞留（脚本已规避；产品侧仍为已知残留项）。
