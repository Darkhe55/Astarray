# 测试环境差异与负载敏感抖动（2026-10-12）

> 起因：本会话反复出现"同一代码不同运行结果不同"，且我发现**两类测量被混在一起比较**。
> 本文件把已确证的差异与抖动固化成可核对的事实，供后续会话避免误判。

## 1. 已确证的差异：`skipIf` 判据依赖构建产物

`tests/` 中有 **5 处 `describe.skipIf`**，判据为"构建产物是否存在"：

| 文件 | 判据 |
| --- | --- |
| `tests/core/integration/feedback-process.test.ts` | `hasBuiltEntry`（`dist/feedback-process-entry.js`）|
| `tests/core/unit/feedback-supervisor.test.ts` | 同上 |
| `tests/tui/integration/headless-cli.test.ts` | `hasBuiltCli`（`dist/cli.js`）|
| `tests/tui/integration/recovery-process-handoff.test.ts` | 同上 |
| `tests/tui/integration/smart01-04-live-u2-flash-verdict.test.ts` | `hasLiveVerdict`（`.tmp/` 下的真实运行判据）|

**实测对比**：

| 环境 | `Test Files` | `Tests` |
| --- | --- | --- |
| **工作区**（已 `npm run build`） | 401 | **3018 passed（0 skipped）** |
| **HEAD 级 worktree**（未 build） | 401 | 3017 passed **\| 2 skipped** |

⇒ **"2 skipped" 不是基线退化，而是"未构建"环境的预期行为**。
（我上一轮把这两种环境的数字放在同一张对比表里，**是我的记录错误**；本文件予以更正。）

**推论**：比较测试计数时**必须说明是否已构建**，否则会得出"skipped 从 0 变 2"的错误结论。

## 2. 已确证的抖动：负载敏感测试

同一提交、同一工作区，**连续两次全量运行的差异**：

| 运行 | 结果 |
| --- | --- |
| A | **1 failed \| 3018 passed** |
| B | **3019 passed（全绿）** |

⇒ 存在**负载敏感抖动**（本会话已多次遇到；与
`COVERAGE_FLAKE_COUPLING_CORRECTION_2026-10-11.md`、`COVERAGE_MARGIN_QUANTIFICATION_2026-10-12.md`
记录的是**同一现象**）。

**已知的耦合后果**：抖动失败时，该测试覆盖的分支不计入 ⇒ `test:coverage` 的
**分支**指标瞬时下探（约 −0.2 点）并**跟着翻红**。故"测试抖动"与"覆盖率不足"
必须**分开归因**：若 `npm run test` 同时出现 `1 failed`，则应先按抖动处理（复跑），
而不是去补覆盖率。

## 3. 判别流程（建议固化为习惯）

1. 全量 `npm run test`：
   - **全绿** ⇒ 若覆盖率仍不足，属**真实缺口**，须补测试；
   - **1 failed 且复跑转绿** ⇒ 属**抖动**，**不要**改门槛或补覆盖率；
2. 比较计数前先确认**是否已构建**（影响 `skipIf`）；
3. 关键结论应在 **HEAD 级**（`git worktree` 检出）复验，避免工作区掩盖问题
   （见 `HEAD_LEVEL_VERIFICATION_2026-10-12.md`）。

## 4. 未完成（如实）

- **未定位**抖动的**具体测试名**：两次捕获尝试分别得到"1 failed"与"0 failed"，
  而 verbose 输出未保留失败那一轮的用例名 ⇒ **尚无证据指向具体文件**。
  若要根治，需在失败轮保留完整输出（例如写日志后比对），建议**单独一轮**专门做。
- 未统计抖动的**出现频率**（本轮仅 1/2 次）。
