# AR-07 Linux 平台证据（WSL2）：平台不可达分支在 Linux 上**已走通**

- **来源提交**：`9d894fe97441b8e102fe3faf0f0fdf7cdd2a03f4`（`9d894fe`）
- **取得方式**：用户指示「Linux 部分使用 WSL 做，macOS 部分先跳过，保留记录以后再补」
- **报告性质**：补齐 `AR-07` 长期记为「**须由 Linux/macOS 平台提供证据**」中**属于 Linux 的那部分**
- **边界**：**macOS 仍未验证**；本报告**不主张 AR-07 整卡通过**

---

## 1. 卡内原文（要解决的问题）

`docs/tasks/AR07_FINAL_ACCEPTANCE.md` §"仍未完成"：

> - **仍未完成**：平台不可达分支（Windows-only 的非 win32 归一化路径、
>   `sensitive-content-access-policy` L78/L156、`protected-storage-policy` L40）
>   ⇒ **须由 Linux/macOS 平台提供证据**，本会话不得以文字覆盖。

即：这些分支在 **Windows 上物理不可达**（走的是 win32 分支），
必须换平台才能证明它们**真的能被执行到**，而不能靠"读代码觉得没问题"来交差。

## 2. 环境与方法（可复核）

| 项 | 值 |
| --- | --- |
| 平台 | **WSL2**（`6.18.33.2-microsoft-standard-WSL2`）／ **Ubuntu 26.04 LTS** ／ x86_64 |
| 运行时 | **Node v22.22.1** |
| 检出 | `$HOME/astarray-linux-evidence`（WSL 原生文件系统），已同步到 **`9d894fe`**（与 Windows 同提交） |
| 依赖 | `npm ci`（**exit 0**；不复用 Windows 的 `node_modules` —— 其为 `@esbuild/win32-x64` 等平台二进制） |
| 构建 | `npm run build`（**exit 0**） |
| 覆盖率 | `npx vitest run --coverage --coverage.reporter=json --coverage.include=<三个文件>`（**exit 0**） |

**为什么用 `--coverage.include` 收敛到这三个文件**：本探针只关心"这三处的平台不可达分支在 Linux 上是否被走到"，
故定向测量，避免全量覆盖率报告带来的无关噪声。（注意：子集运行**不能**用来评判全局覆盖率门槛，
这里也不用于此目的。）

## 3. 结果（真实退出码，**决定性**）

三个文件在 **Linux** 上的分支覆盖率：

| 文件 | 语句 | **分支** | 函数 |
| --- | --- | --- | --- |
| `tools/cross-platform-path-canonicalization.ts` | 98.3%（59/60） | **100.0%（23/23）** | 100.0%（17/17） |
| `tools/protected-storage-policy.ts` | 95.8%（68/71） | **100.0%（13/13）** | 100.0%（13/13） |
| `tools/sensitive-content-access-policy.ts` | 98.6%（73/74） | **100.0%（28/28）** | 100.0%（15/15） |

⇒ **三个文件的分支覆盖率在 Linux 上均为 100%** ⇒
卡内点名的那批"**Windows-only／非 win32 归一化**"分支，在 Linux 上**确实被执行到了**。
这正是卡内要求的"平台证据"，而不是文字说明。

**全量测试（同一次 WSL 运行）**：`Test Files 431 passed (431)`、
`Tests 3253 passed | 2 skipped (3255)`、**exit 0**。
（2 skipped 的成因已在 `LINUX_PLATFORM_EVIDENCE_WSL2_2026-11-08.md` 中定位于
`smart01-04-live-u2-flash-verdict.test.ts` 的 `hasLiveVerdict` 守卫 —— 真实运行产物不在版本控制内。）

## 4. 一处**未能对齐**的细节（如实说明，不掩饰）

卡内用**行号**（`sensitive-content-access-policy` L78/L156、`protected-storage-policy` L40）指认分支；
但按**当前提交**去读这些行号，内容已与卡内描述不符
（例如 `protected-storage-policy.ts:40` 现在是一行注释），说明**自卡内记录以来这些文件有过改动、行号已漂移**。

**我没有据此声称"卡内的三处就是这三处"**，而是改用一个**更强、且不依赖行号**的判据：

> **这三个文件的「分支覆盖率在 Linux 上达到 100%」** ——
> 只要成立，就**不存在**任何"只在非 win32 平台可达、却从未被走到"的分支，
> 无论卡内当年的行号指向哪里。

⇒ 这个判据同时覆盖了卡内点名的三处**以及**可能被遗漏的同类分支。

## 5. 仍未取得（如实保留，**不因本次改变**）

- **macOS 平台证据**：**未取得**（按用户指示先跳过、保留待补）；
- ⇒ **AR-07 仍不得因本报告改判通过**；
- 卡内其余"未完成"项（若有）本报告未覆盖，仍按其原状态处理。

## 6. 日志位置

- 本机：`.tmp/wsl-ar07-coverage.log`（Windows 侧完整回显）
- WSL 内：`~/astarray-linux-evidence/coverage-ar07/coverage-final.json`（覆盖率原始数据）
