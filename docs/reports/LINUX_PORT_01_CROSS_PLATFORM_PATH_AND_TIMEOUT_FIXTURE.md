# LINUX-PORT-01 跨平台路径判定与超时夹具返修证据（2026-09-19）

> 检查点：LINUX-PORT-01，由 `docs/reports/LINUX_PLATFORM_FAILURE_TRIAGE_2026-09-19.md` 的 A/B 类失败判定触发。
> 授权：用户 2026-09-19 指示"按这个做，四项一起返修"，并追加四条约束（统一路径解析与实际访问一致性、禁止 POSIX 全局大小写折叠、大小写测试检测实际文件系统能力、超时用例使用可握手可回收的 Node 子进程夹具），并要求先红后绿、仅提交本检查点改动。
> 基准提交：`2a383b9`。
> 结果：Windows 侧 **228 文件 / 1854 用例全绿**；覆盖率 **93.09 / 85.24 / 93.13 / 93.11**；安全关键模块 **22/22 达标**。
> 平台状态：Linux 仍为**未验证**，待 §8 在同一提交上独立重跑。

## 1. 触发原因（回顾）

Linux 机器在同一代码版本上出现 6 个测试文件失败，其中 10 个用例源于安全判定层使用平台相关路径语义（`path.resolve`/`path.isAbsolute`/`path.normalize` + 仅 win32 大小写折叠），在 POSIX 上盘符、UNC、反斜杠分隔与大小写语义全部失效；另 1 个为 `git --version` 过快导致的计时脆弱用例。

## 2. 用户追加约束的落实

| 约束 | 落实 | 证据 |
| --- | --- | --- |
| 四项一起返修 | §4 变更清单覆盖四项（跨平台绝对路径、分隔符统一、大小写能力、超时夹具） | 全量用例 |
| 统一路径解析与实际文件访问一致性 | 受保护存储策略不再对调用方传入的规范路径做宿主 `path.resolve`（原实现会把 POSIX 上的 Windows 风格路径改写为当前目录相对路径）；新增一致性反例：公共入口必须用边界返回的同一个规范路径做策略判定与实际读取 | `tests/core/unit/cross-platform-path-canonicalization.test.ts` › 策略判定与实际访问路径一致性 |
| 禁止 POSIX 全局大小写折叠 | 规范比较只在注入的能力为 `case-insensitive` 时折叠；POSIX 缺省为 `case-sensitive`；探测失败回退平台默认且绝不假定不敏感 | `canonicalizePathForPolicyComparison`、`platformDefaultCaseSensitivity` |
| 大小写测试检测实际文件系统能力 | 新增 `detectFileSystemCaseSensitivity`：在目标目录创建混大小写临时目录，stat 大小写交换后的路径，最后用 `rmdir` 清理；装配层在状态目录上真实探测后注入策略 | §5.2；探测分支与"真实探测不留残留"用例 |
| 超时用例使用可握手、可回收的 Node 子进程夹具 | `GitProcess` 增加受控执行文件注入；夹具启动即写 pid 到握手文件后常驻；用例先确认握手，再断言超时拒绝，最后断言子进程已被回收 | `tests/fixtures/git-process-timeout-handshake-fixture.mjs`；`git-coordinator-branches.test.ts` |
| 先红后绿 | 先写反例并观察到失败，再实现 | §3 |
| 仅提交本检查点改动 | 仅暂存本检查点的生产/测试/夹具/证据文件，用户并行改动保持未暂存 | §7 |

## 3. 行为反例（先红后绿）

**红（返修前）**：`npx vitest run` 目标 4 个文件 → `Test Files 4 failed`；3 个文件因 `Cannot find module cross-platform-path-canonicalization.js` 无法收集；`protected-storage-failclosed` 2 个用例失败：

- `realpath 返回非字符串` 用例：`TypeError: The "path" argument must be of type string. Received undefined`（判定被类型错误中断，而非 fail-safe 兜底）；
- `大小写敏感文件系统` 用例：`DomainError: 受保护存储不可由普通工具访问（read）: C:\data\app\Backup-Vault\Data\x`（能力被忽略，按平台默认折叠）。

日志：`.tmp/linux-port-01/red-unit.log`（`.tmp/` 已 gitignore）。

**绿（返修后）**：目标 5 个文件 77 用例通过；全量 228 文件 / 1854 用例通过。

| 反例行为 | 返修前 | 返修后 |
| --- | --- | --- |
| POSIX 上 `resolveWithinWorkspace("C:/Windows/system.ini")` | 解析为 `<workspace>/C:/Windows/system.ini`，**不报错** | `DomainError(path-escape-attempt)` |
| POSIX 上 `resolveWithinWorkspace("\\\\server\\share\\file")` | 解析为工作区内相对名，**不报错** | `DomainError(path-escape-attempt)` |
| 盘符相对形式 `C:relative-notes.txt`（Windows 亦不算绝对路径） | 交给 `path.resolve`，结果随平台/当前盘符变化 | 任何平台一律 `path-escape-attempt` |
| POSIX 上 `writeFileTemporary("C:/Windows/system.ini")` | 落到 `ENOENT`（校验被绕过，错误类型错误） | `writeFileTemporary 仅接受相对文件名` |
| POSIX 上 `isProtectedPath("C:\\data\\app\\backup-vault\\data\\x")` | `false`（反斜杠被当普通字符） | `true`（分隔符统一 + `..` 词法解析） |
| 大小写变体（`Backup-Vault`） | 仅 Windows 命中，POSIX 结论随平台隐式改变 | 由探测/注入的能力决定；大小写敏感文件系统上不命中（是不同资源），敏感文件系统上命中 |
| `realpath` 返回非字符串 | `ERR_INVALID_ARG_TYPE` 中断判定 | 退回词法路径继续判定（fail-safe） |
| `git --version` 超时用例 | 依赖 git 启动耗时（Linux 3ms 即成功 → 断言失败；负载高时又通过） | 断言/握手/回收全部确定 |

## 4. 变更清单

生产代码：

- 新增 `packages/core/src/tools/cross-platform-path-canonicalization.ts`；
- `packages/core/src/tools/workspace-boundary.ts`（跨平台绝对路径拒绝）；
- `packages/core/src/tools/protected-storage-policy.ts`（规范比较 + 能力注入 + fail-safe realpath）；
- `packages/core/src/tools/sensitive-content-access-policy.ts`（身份键分隔符统一）；
- `packages/core/src/tools/builtins.ts`（`writeFileTemporary` 跨平台绝对路径判定）；
- `packages/core/src/orchestration/git-process.ts`（受控执行文件注入）；
- `packages/core/src/application/application-runtime.ts`（装配时探测大小写能力）。

测试与夹具：

- 新增 `tests/core/unit/cross-platform-path-canonicalization.test.ts`（30 用例：前缀判定、规范形式、包含关系、能力探测分支、真实探测一致性、边界拒绝、一致性反例、Windows 风格保护区命中）；
- 新增 `tests/fixtures/git-process-timeout-handshake-fixture.mjs`；
- `tests/core/unit/protected-storage-failclosed.test.ts`（平台中立夹具 + 能力注入分支）；
- `tests/core/unit/protected-storage-policy.test.ts`（大小写用例改为按实际能力断言）；
- `tests/core/unit/read-suppression-and-guard.test.ts`（拆分别名用例与大小写能力用例）；
- `tests/core/integration/git-coordinator-branches.test.ts`（超时用例改为握手夹具）。

## 5. 设计与关键决策

### 5.1 规范形式规则

`canonicalizePathForPolicyComparison`：分隔符统一（`\` → `/`）、`.`/`..` 词法解析、尾部分隔符移除、保留盘符/UNC/根前缀，**不调用宿主 `path.resolve`**。包含关系用 `isCanonicalPathWithin`（按段边界，避免 `/a/b` 误判 `/a/bc`）。

### 5.2 大小写能力探测（非破坏性）

`detectFileSystemCaseSensitivity` 创建 `astarray-CaseProbe-*` 临时目录，stat 大小写交换后的同名路径，再用 `rmdir` 删除空目录。**不使用 `writeFile`/`rm`**，因此无需扩张 `tests/architecture/destructive-file-api-guard.test.ts` 的白名单（首版实现曾因此守卫失败，已改为非破坏性探测）。探测失败（目录不可创建/不可读）一律回退平台默认值。

### 5.3 判定路径与实际访问路径一致

受保护存储策略的输入是边界返回的宿主原生绝对路径，策略只做比较用规范化，不再用 `path.resolve` 改写；一致性反例用"边界返回 A、请求 B"的方式证明实际读取拿到的是边界返回路径的内容，且策略收到的路径与之一致（预检 + 复检两次）。

### 5.4 超时夹具

`GitProcess` 新增 `executablePath`/`executableArgumentsPrefix`（仅装配与测试注入，不接受模型输入）。用例以 `process.execPath` + 夹具启动常驻进程，夹具把 pid 写入握手文件；用例确认握手→断言 `/超时/`→轮询 `process.kill(pid, 0)` 确认无残留。

## 6. 门禁与覆盖率（Windows 侧）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 |
| `eslint .` | 0 |
| `npm run build`（tsup） | Build success |
| 目标用例 | 5 文件 / 77 用例通过（新增文件单独复跑 30 用例通过） |
| 全量 `vitest run --maxWorkers=6` | **228 文件 / 1854 用例通过** |
| `vitest run --coverage` global | **93.09 / 85.24 / 93.13 / 93.11** |
| `verify:security-coverage` | **22/22 达标（阈值 95%）** |

重点模块覆盖率（lines/branches）：新增规范化模块 98.27/90.47；`protected-storage-policy.ts` 100/100；`sensitive-content-access-policy.ts` 98.64/98.11；`read-suppression-ledger.ts` 95.34/100；`workspace-boundary.ts` 92.3/86.66；`git-process.ts` 97.56/92.3。

说明：本机沙箱下 vite 的 `exec` 与 tsup/esbuild 会 `EPERM`，上述用例、构建与覆盖率均需一次性完整访问（`danger-full-access`）；`tsc`/`eslint` 已改为直接 `node` 调用，不受影响。

## 7. 提交与推送

- 仅暂存本检查点文件（生产 7 个、测试 5 个、夹具 1 个、本证据文档 1 个）；用户并行改动（`IMPLEMENTATION_PLAN.md`、`PLAN_STATUS.md`、`agent-main-architecture.md`、`docs/tasks/README.md`、`tests/core/unit/application-sdk-task-events.test.ts` 及 5 个未跟踪用户文档）保持未暂存。
- 提交：`04ddce7`（`fix(path): 跨平台路径判定统一与超时夹具，修复 Linux 安全语义缺口`），14 文件、+899/−83。
- 推送：`git push` 第 1 次即在完整访问下成功，`2a383b9..04ddce7 main -> main`；推送后 HEAD == `origin/main` == `04ddce7`。

## 8. Linux 同提交独立重跑清单

在 Linux 机器上，取**本检查点提交**（不要用其他提交或脏树）执行：

```bash
git fetch && git checkout <本检查点提交>      # 干净检出，避免 DIRTY 噪声
rm -rf node_modules dist coverage
npm ci
npm run check                                # typecheck + lint + build + test
npx vitest run --coverage --maxWorkers=6
npm run verify:security-coverage
npm pack
node scripts/verify-package.mjs "$(ls -t astarray-*.tgz | head -1)"
node scripts/smoke-install.mjs
```

验收标准：`npm run check` 与 coverage 全绿（预期 228 文件；用例数应与本机一致）、覆盖率四数不低于 85、安全关键模块 22/22、`npm pack` 产出新 tarball（记录 SHA256 与 mtime，避免再次沿用旧包）、`verify-package.mjs` 与 `smoke-install.mjs` 退出码 0。

## 9. 未决与残留

- `workspace-boundary.ts` 的 `findNearestExistingAncestor` 返回 `null` 分支（第 54/85 行）仍未被覆盖；返修前亦如此，不在本检查点范围。
- `sensitive-content-access-policy.ts` 与 `read-suppression-ledger.ts` 的大小写折叠仍按平台（Windows 折叠 / POSIX 不折叠），未接入能力探测；macOS 默认大小写不敏感的场景可能出现误判，已记录为残留。
- `GitProcess` 的 `executablePath`/`executableArgumentsPrefix` 是受控装配/测试缝隙，只接受显式调用方传参，不接收模型输入。
- Linux 平台状态仍为「未验证」：本文件不构成 Linux 平台验收证据，须待 §8 在同提交上的实测结果。
