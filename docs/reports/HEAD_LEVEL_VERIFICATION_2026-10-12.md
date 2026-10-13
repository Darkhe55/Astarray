# HEAD 级验证记录（2026-10-12）

> 目的：补上本会话**长期缺失**的验证方式 —— 用独立 `git worktree` 检出 `HEAD` 后跑门禁，
> 而不是只跑工作区。触发原因见 `KNOWN_ISSUE_LINE_ENDING_SENSITIVE_TEST_2026-10-12.md`：
> **「工作区绿」不等于「HEAD 绿」**。

## 1. 验证方式

```powershell
git worktree add --detach .tmp/verify HEAD
cd .tmp/verify
npm run typecheck ; npm run lint ; npm run test
```

**为什么需要它**：本会话已出现**两种**"工作区掩盖 HEAD"的情况：
1. 漏提交一个文件 ⇒ `HEAD` 的 `typecheck` 失败而工作区通过（已在 `d332ded` 修复）；
2. 测试对**工作区行尾**敏感 ⇒ 工作区通过而干净检出失败（已在 `fe22f05` 修复）。

## 2. 实测记录（`HEAD` 级）

| 提交 | `typecheck` | `lint` | `test` | 备注 |
| --- | --- | --- | --- | --- |
| `e88ed15` | **2** | — | — | `typecheck` 失败（漏提交 async 修复）|
| `e88ed15` | 0 | — | **1** | 行尾敏感测试失败（`read-format-other-languages`）|
| `d332ded` | **0** | **0** | 1 | `typecheck` 已修；仍有行尾失败 |
| `fe22f05` | **0** | **0** | **1**（3 failed） | 行尾问题**未修**（worktree 夹具仍 CRLF）；另 2 个疑似抖动 |
| `fe22f05`（复跑） | — | — | **0** | **全部通过**，无失败 |

## 3. 对 `fe22f05` 结果的诚实解读（证据不足以断言"已修好"）

- **确证的**：`.gitattributes` 在**模拟新克隆**（重新检出夹具）下确实生效 ——
  夹具转为 LF，`read-format-other-languages.test.ts` **11/11 通过**（见 `fe22f05` 提交信息）。
- **未确证的**：`fe22f05` 的 worktree 里该测试**仍然失败** ——
  因为该 worktree 的夹具是**既有检出**（CRLF），`.gitattributes` **对已检出文件不追溯生效**；
  我用 `git rm --cached` + 重新检出来"模拟新克隆"，但那**只修了夹具目录**，
  后续的全量 `test` 仍跑在含 CRLF 的其它文件上。
- **结论**：`fe22f05` 的 `test` 结果**不能**用来判定行尾问题已解决；
  该判断只能由**真正的新克隆**（或重新检出全部文件）给出。
- **抖动**：同一提交两次跑，`test` 一次 3 failed、一次 **0 failed** ⇒ 存在**负载敏感抖动**，
  与本会话已记录的 `COVERAGE_FLAKE_COUPLING_CORRECTION_2026-10-11.md` 同类。

## 4. 建议的后续动作（未执行）

1. **用真实新克隆验证**（而非 worktree 复用既有检出）：
   `git clone <repo> fresh && cd fresh && npm ci && npm run test`
   —— 这是唯一能判定行尾问题是否解决的干净方式；**须由用户或 CI 环境提供**。
2. 若要**彻底**消除行尾敏感，除 `.gitattributes` 外还应考虑让该测试
   **在断言前归一化行尾**（`\r\n` → `\n`）—— 两者并不互斥；
   但后者触及产品判定语义附近的测试，需先读清语义。
3. **把 HEAD 级验证纳入收尾流程**（本文件即为此目的）。

## 5. 未完成（如实）

- 未在**真实新克隆**中验证；
- 未跑 `test:coverage` 的 HEAD 级验证；
- `fe22f05` 的 3 个失败中，**仅 1 个**已定位为行尾问题，另 2 个**未定位**
  （复跑即消失，判为抖动，但未取证到具体测试名）。
