# Linux 平台门禁失败分类与证据有效性判定（2026-09-19）

> 被测树：用户 Linux 机，HEAD `3191064`（比当前 main `d21742a` 少一个纯文档提交，代码一致）
> 执行：用户在 Linux 机执行，主 Agent 会话判读（DSH Windows 工作区）
> 结论：Linux 门禁**未通过**（227 文件中 6 个失败）。其中 **10 个失败**源于 Windows 专用路径语义未在 POSIX 生效，**1 个**为计时型脆弱测试；另发现两条证据失效问题（旧 tarball、smoke 失败为 prepack 连带）。
> 平台状态：Linux 仍为**未验证**。

## 1. 回传结果

| 项 | 结果 |
| --- | --- |
| `npm run check` | Test Files **6 failed \| 221 passed (227)**，exit 1，Duration 162.70s |
| coverage | Test Files 5 failed \| 222 passed；Tests **10 failed \| 1811 passed (1821)**，exit 1；**无覆盖率表** |
| `npm pack` | 取得 `astarray-0.1.0.tgz`，sha256 `c0c383ac3f575a761c56a6e719c692e27540ef886193823f037691c2a25de206` |
| `verify-package.mjs` | exit 0 |
| `smoke-install.mjs` | exit 1 |
| env | `HEAD=3191064`、`DIRTY=105`、esbuild 正常（`node_modules/@esbuild/linux-x64`，0.27.7 可解析） |
| npm 配置 | 未设 omit/optional/proxy；registry 为腾讯云镜像 |

先前 `tsc: Permission denied` 已按 §5 修复：`node_modules` 重装后 typecheck/lint/build 均可运行，失败点前移到测试阶段。

## 2. 证据有效性问题（须先修正）

### 2.1 本次 tarball 疑为 Windows 旧产物

- 回传 sha256 `c0c383ac…de206` 与**本机 Windows 工作区**的 `astarray-0.1.0.tgz` 逐字节一致（该文件 mtime `2026-09-15T21:26:35Z`）。
- `scripts/smoke-install.mjs:52` 内部执行 `npm pack`，其 `prepack` 会先跑 `npm run check`；本次 `pack.log` 显示 prepack 阶段测试失败即退出，因此**失败状态下不会产出新包**；取包命令 `TGZ=$(ls -t astarray-*.tgz | head -1)` 很可能选中了从 Windows 树拷来的旧包。
- **已确认（2026-09-19 回传）**：`ls -l --time-style=full-iso` 显示 mtime `2026-09-15 21:26:35 +0800`，非本次运行产生。故本次 sha256 与 `verify-package.mjs` exit 0 **不构成 Linux 打包证据**，须在 check 变绿后重做。

### 2.2 `smoke-install` exit 1 是 prepack 连带失败

- `smoke-install.mjs` 第一步即 `npm pack`，prepack 运行 `npm run check`；check exit 1 → `execSync` 抛错 → 脚本 exit 1。
- 日志尾部被 inspect 的大对象正是该 `execSync` 错误（内含 vitest 失败文本）。
- 结论：这不是独立缺陷；check 变绿后需重跑。

### 2.3 coverage 无覆盖率表

Vitest 默认测试失败时不输出覆盖率报告（`coverage.reportOnFailure` 默认 false），因此 exit 1 时拿不到 global 四数。需在测试通过后重跑。

### 2.4 脏树性质（已确认，排除污染）

| 命令 | 结果 |
| --- | --- |
| `git diff --stat` | 99 files changed, 27590 insertions(+), 27534 deletions(-) |
| `git diff --ignore-cr-at-eol --stat` | **5 files changed, 58 insertions(+), 2 deletions(-)** |

结论：99 个"已修改"里 **94 个是纯 CRLF 行尾噪声**（Windows 树拷贝所致），真实内容改动只有 5 个文件，与本仓 Windows 工作区保留的用户并行改动一致；untracked 为用户文档 5 项与证据目录 `.linux-evidence/`。

因此 **A 类失败不是本地改动污染**：`tests/core/unit/security-hardening.test.ts`、`tests/core/unit/read-suppression-and-guard.test.ts` 等失败文件的真实差异为 0，断言即提交版本，失败属 POSIX 平台语义差异。

## 3. 失败分类（11 个失败用例 / 6 个文件）

### A 类：Windows 专用路径语义未在 POSIX 生效（10 个，需返修）

| 测试文件 | 失败用例 | 机制 |
| --- | --- | --- |
| `tests/core/unit/security-hardening.test.ts` | `C:/Windows/system.ini`、`\\\\server\\share\\file` 期望 `path-escape-attempt` | `path.resolve/path.relative` 在 POSIX 把盘符与 UNC 当普通相对名 → 判定在工作区内（`packages/core/src/tools/workspace-boundary.ts:26-58`） |
| `tests/core/unit/protected-storage-policy.test.ts` | `isProtectedPath("C:\\data\\app\\backup-vault\\data\\x")` 期望 true；Windows 大小写变体 | `normalizeForComparison` 仅 win32 折叠大小写、`path.normalize` 在 POSIX 不把 `\` 当分隔符（`packages/core/src/tools/protected-storage-policy.ts:33-44, 123-132`） |
| `tests/core/unit/protected-storage-failclosed.test.ts` | 4 个 mock 用例 | 测试以 `C:\\data\\app` 作 state dir 与 realpath 返回值；POSIX 下解析为单一相对分量 → 保护区不匹配；其中一例 mock 返回 undefined，触发 `path.normalize(undefined)` 的 `ERR_INVALID_ARG_TYPE` |
| `tests/core/unit/builtins.test.ts` | `writeFileTemporary 拒绝绝对路径文件名` | `path.isAbsolute("C:/Windows/system.ini")` 在 POSIX 为 false → 落到 ENOENT（`packages/core/src/tools/builtins.ts:359`） |
| `tests/core/unit/read-suppression-and-guard.test.ts` | 相对/绝对别名、大小写变体不能绕过时间锁 | 时间锁键的大小写折叠依赖大小写不敏感文件系统（`packages/core/src/tools/read-suppression-ledger.ts`） |

`security-hardening` 2 例、`protected-storage-policy` 2 例、`protected-storage-failclosed` 4 例、`builtins` 1 例、`read-suppression` 1 例 = 10 例。

### B 类：计时型脆弱测试（1 个）

| 测试文件 | 失败用例 | 机制 |
| --- | --- | --- |
| `tests/core/integration/git-coordinator-branches.test.ts` | `gitCommandTimeoutSeconds: 0.000_001` 期望 `/超时/` | Linux 上 `git --version` 3ms 内成功返回（收到 `exitCode: 0`）；coverage 轮次在更高负载下该文件通过 → 计时脆弱，非平台功能差异 |

> 返修结果：A/B 两类均已由检查点 **LINUX-PORT-01** 修复并推送（提交 `04ddce7`），证据见
> `docs/reports/LINUX_PORT_01_CROSS_PLATFORM_PATH_AND_TIMEOUT_FIXTURE.md`；Linux 侧仍需在同一提交上独立重跑。

## 4. 返修方向（已授权并实现，见 LINUX-PORT-01）

统一"跨平台路径规范化"到安全判定层：

1. 盘符（`^[A-Za-z]:[\\/]`）与 UNC（`^\\\\`）前缀在**所有平台**判定为绝对路径，工作区边界按逃逸拒绝；
2. 受保护存储与读取时间锁的分隔符统一（同时接受 `/` 与 `\`），比较时保守折叠大小写；
3. `writeFileTemporary` 的"仅接受相对文件名"同样识别盘符/UNC；
4. `git-coordinator` 超时用例改为可控慢命令或放宽阈值，消除计时脆弱。

上述改动涉及给定行为反例、公共入口验证与覆盖率，按 `docs/tasks/PRODUCT_INTEGRATION_ROLLOUT.md` §4 应作为独立检查点执行；本记录不构成授权。

## 5. 待补数据

1. （已确认）tarball mtime 为 2026-09-15，属旧产物；
2. （已确认）脏树为 94/99 CRLF 噪声，真实改动 5 个文件，未触及 A 类失败模块；
3. **仍待补**：check 变绿后 coverage global 四数、重新 pack 的 sha256、`verify-package.mjs` 与 `smoke-install.mjs` 退出码。
